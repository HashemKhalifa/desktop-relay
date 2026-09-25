# Design: self-hosted Desktop Commander relay

Replaces the paid `mcp.desktopcommander.app` Remote MCP relay (10k tool calls/month free
tier, $20/month Pro) with a self-hosted chain on the Mac. The MCP server itself
(`@wonderwhy-er/desktop-commander`, stdio) is open source and unlimited. The paid service
adds the middle: OAuth device pairing, a device registry, a public HTTPS endpoint, and
metering. This project rebuilds only the middle.

This document is the arena synthesis of four candidate designs plus an independent Codex
review. `SYNTHESIS.md` records the pick, grafts, and rejections.

## Problem

Remote AI clients (ChatGPT Codex cloud tasks, Claude web, MCP clients on other machines)
need to reach this Mac over public HTTPS to run desktop-commander tools. The OSS repo
ships the device-side client (`src/remote-device/`, `desktop-commander remote`), but it
only speaks the vendor's closed relay. The job is a local stdio MCP behind an
authenticated public HTTPS endpoint with persistence, at $0/month.

Two facts verified independently by candidate 1 (against `supergateway@4.0.0` dist
source) and the Codex review kill the naive supergateway design:

- **No "one shared upstream" mode exists.** Stateless mode spawns a fresh stdio child
  per HTTP POST; `--stateful` spawns one child per `Mcp-Session-Id`. Neither is the
  single device-owned process the product semantics need: a `start_process` under one
  client must be readable by another, and per-request children pay full spawn+init
  latency every call.
- **supergateway binds `0.0.0.0` with no `--host` flag.** `app.listen(port)` with no host
  means the *unauthenticated* MCP endpoint sits on the LAN, bypassing any auth proxy in
  front of it. Codex reproduced the omitted-host bind behavior in a socket test.

Additional verified constraints:

- supergateway parses bodies with bare `express.json()` (100KB default) — `write_file`
  payloads routinely exceed that and would need a checksum-guarded `sed` patch upstream.
- `tools/call` is not idempotent. No layer may retry or replay a forwarded request.
- Target clients cannot complete OAuth or (some of them) set arbitrary headers, so a
  static credential is the only auth all of them share.
- desktop-commander's own guardrails (`allowedDirectories`, command blocklist) are NOT a
  sandbox: `execute_command` reaches anywhere the operator's account can. The credential
  must be treated as "shell as this user" unless a real OS confinement wraps the child.
- `set_config_value` is remotely callable and can mutate the blocklist and
  `allowedDirectories`. It must be denied at the relay or the guardrails are escapable.

## Usage (caller's view)

One install, then per-client credentials:

```bash
./install.sh --edge ngrok --domain myname.ngrok-free.app
# or: ./install.sh --edge cloudflared --hostname mcp.example.com
# or: ./install.sh --edge vps-ssh --vps dedicated --domain dc.example.com
# -> npm ci, generates first principal, installs launchd agents, prints URL
```

```bash
bin/dc-relayctl mint chatgpt                # -> https://<edge>/<pathId>/mcp + Bearer
bin/dc-relayctl mint claude-web --path-only # header-less tier; pathId is the credential
bin/dc-relayctl mint codex --tools execute_command,read_file,write_file,list_directory

bin/dc-relayctl status     # agent health, public /healthz probe, principals, posture
bin/dc-relayctl url        # reprints both URL forms
bin/dc-relayctl logs       # ~/Library/Logs/desktop-relay/*
bin/dc-relayctl audit <name>   # attributed request log for one client
bin/dc-relayctl rotate <name>  # new credential; old stays valid 24h grace
bin/dc-relayctl revoke <name>  # immediate: drops its open connections too
bin/dc-relayctl doctor     # health assertions: loopback-only, upstream up, logs pruned
bin/dc-relayctl restart    # launchctl kickstart -k all agents
./uninstall.sh [--purge]
```

Client wiring:

```toml
# ~/.codex/config.toml
[mcp_servers.desktop]
url = "https://<edge>/<pathId>/mcp"
http_headers = { "Authorization" = "Bearer <token>" }
```

```
ChatGPT Developer Mode / Claude web connector:
  server URL = https://<edge>/<pathId>/mcp        (+ Bearer if the client allows headers)
```

```jsonc
// local clients on this Mac bypass the relay entirely
{ "mcpServers": { "desktop": { "command": "<repo>/node_modules/.bin/desktop-commander" } } }
```

## Shape

One custom daemon on the Mac, one edge tunnel, two stock support agents.

```
remote AI client
  -> https://<edge>/<pathId>/mcp         TLS at edge (ngrok | cloudflared | VPS caddy)
  -> tunnel agent on Mac                 outbound-only connection
  -> 127.0.0.1:8788  src/daemon.ts       auth + limits + audit in ONE process:
       |-- auth pipeline (principals, Host/Origin, bucket, 404-on-fail)
       |-- bridge: id namespacing, in-flight map, generation counter
       |-- upstream: ONE long-lived DC child via StdioClientTransport
  -> desktop-commander (stdio child)     all tool/session state in-process
```

The single listener enforces auth before any transport object exists, so there is no
unauthenticated HTTP hop anywhere (the loopback port IS the authenticated listener).
The daemon consumes `@modelcontextprotocol/sdk` at the **transport layer only**
(`StdioClientTransport`, `StreamableHTTPServerTransport`); it never instantiates
`Client`/`Server` protocol classes, so protocol negotiation stays end-to-end between
the remote client and the real MCP server.

### Files

```
README.md
DESIGN.md / SYNTHESIS.md
config.example.json
package.json + package-lock.json    pinned SDK + desktop-commander; npm ci at install
src/daemon.ts                       HTTP listener + auth pipeline + wiring (~150 lines)
src/bridge.ts                       id namespacing, in-flight map, notification fan-out (~140)
src/upstream.ts                     child lifecycle: spawn, respawn, init replay (~120)
src/policy.ts                       DENY_REMOTE + LOG_POLICY tables (~40)
install.sh / uninstall.sh           token+principal mint, plist render, launchctl bootstrap
bin/dc-relayctl                     status | url | logs | audit | mint | rotate | revoke | doctor | restart
launchd/*.plist.tmpl                daemon, tunnel, power, watchdog agents
scripts/spike.ts                    SDK transport-without-Server proof (~30 lines)
scripts/verify.sh                   end-to-end acceptance incl. negative auth cases
vps/Caddyfile.tmpl + sshd-dcrelay.conf + scripts/vps-bootstrap.sh   (vps-ssh edge only)
```

Stack: TypeScript on Node >= 24 native type-stripping. One runtime dependency,
`@modelcontextprotocol/sdk`, exact-pinned; desktop-commander exact-pinned and spawned
from `node_modules` (no `npx -y @latest` anywhere — no registry resolution at boot, no
silent drift under a KeepAlive loop, no network dependency on restart).

### Data structures first

```ts
// principals.json (0600) — per-client credentials; bearer stored as SHA-256 only
type Principal =
  | { name: string; auth: 'path+bearer'; pathId: string; bearerSha256: string;
      tools: 'all' | string[]; ratePerMinute: number }
  | { name: string; auth: 'path-only';  pathId: string;
      tools: 'all' | string[]; ratePerMinute: number };

// upstream.ts — illegal states unrepresentable
type UpstreamState =
  | { kind: 'down' }
  | { kind: 'starting'; ready: Promise<RunningChild> }
  | { kind: 'running'; child: RunningChild }
  | { kind: 'dead'; reason: string };

interface RunningChild {
  transport: StdioClientTransport;
  generation: number;                       // ++ per respawn; stale replies dropped
  lastInit: JSONRPCRequest | null;          // cached initialize for replay
}

// bridge.ts — N HTTP sessions share ONE child, so every client id is rewritten
// into a single upstream id space; original ids restored on the way out
type UpstreamId = number & { readonly __brand: 'UpstreamId' };
interface InFlightEntry { originalId: string | number; respond: ...; generation: number }

// config.json — edge is a discriminated union, switched on once
type Config = {
  edge: { type: 'ngrok'; domain: string }
      | { type: 'cloudflared'; tunnel: string; hostname: string }
      | { type: 'ssh'; host: string; remotePort: number; domain: string };
  port: number;                             // 8788, the only listener
  upstreamCmd: string;                      // node node_modules/@wonderwhy-er/.../index.js
  secretsPath: string; auditPath: string; alertsPath: string;
  maxBodyBytes: number;                     // default 16 MiB (write_file payloads)
  maxConcurrent: number;                    // default 16
  uploadDeadlineMs: number;                 // default 10_000
  logDir: string; logMaxBytes: number;
};
```

### Request flow

Ingress per POST: authenticate (pathId selects principal, `timingSafeEqual` on the
hashed bearer; `path-only` principals skip bearer by their own recorded policy) →
Host/Origin validation (MCP HTTP spec requirement; absent `Origin` is fine for
server-side clients, mismatched Host is not) → path check → body bound →
`authorize` (tool allowlist + `DENY_REMOTE`) → `admit` (per-principal token bucket,
default 120/min burst 30) → forward exactly once. Every failure returns a uniform bare
404; the internal reason goes to the log, never the wire. No `requestTimeout` — tool
calls legitimately run for minutes; SSE responses get boundary-aware keepalive
comments if the SDK does not heartbeat (verify).

Upstream failure: child `onclose` moves state to `down`, fails every in-flight request
with a JSON-RPC error saying `upstream restarted; call may have executed` (honest
unknown, never replayed), backs off, respawns, replays `lastInit`, unblocks senders.
Senders during respawn await `ready` with a 10s timeout then fail fast.

### What the system does not do

- No HTTP session map, no resumability. Stateless Streamable HTTP: no `mcp-session-id`,
  `GET /mcp` is 405, `DELETE` inapplicable. Session continuity would be fake anyway —
  a respawned child erases real state regardless of what HTTP claims. A
  `sessions: 'mapped'` flag (~40 lines) stays available if a client misbehaves.
- Server-initiated notifications ride open POST streams only (or drop, logged). Fine
  for DC: its terminal output is pulled via `read_output` calls, not pushed.
- No retries, no request queue persistence, no response-body inspection.
- No Docker confinement by default — documented variant below; `sandbox: "host"` plus
  `allowedDirectories` hygiene plus `DENY_REMOTE` is the honest posture at this scope.

### Edge selection

One rule: **a domain on Cloudflare nameservers implies cloudflared; otherwise ngrok;
`vps-ssh` when you want zero third-party trust.**

- `cloudflared` named tunnel: no interstitial, no request ceiling worth naming,
  `--no-autoupdate` under launchd. One-time `tunnel login/create/route dns` + 4-line
  ingress config pointing hostname at `http://127.0.0.1:8788`.
- `ngrok` free static domain: zero prerequisites but NOT unlimited — published free
  limits are ~20k HTTP requests/month and 1GB transfer (a request is not a tool call;
  MCP traffic is POST-heavy so this ceiling is real, not theoretical). Free-tier
  browser interstitial does not hit non-browser MCP clients; use v3 spelling
  `ngrok http --url=<domain> 127.0.0.1:8788`. One tunnel per account.
- `vps-ssh`: `ssh -N -R 127.0.0.1:8788:127.0.0.1:8788 dcrelay@<vps>` under launchd
  (`KeepAlive={NetworkState:true}`, `ServerAliveInterval=30`, `ExitOnForwardFailure`);
  Caddy on the VPS terminates TLS and 404-gates the token before traffic spends tunnel
  bandwidth; the Mac daemon stays the authoritative guard (VPS-local processes can hit
  the forwarded loopback port without crossing Caddy). Dedicated forward-only `dcrelay`
  user, `restrict,port-forwarding` key, `PermitListen 127.0.0.1:8788` (or `PermitOpen`
  pre-OpenSSH-10), server-side `ClientAliveInterval=30` so a hard Mac drop frees the
  port in ~60s. A watchdog agent probes the real public `/healthz` every 60s and
  `kickstart -k`s the tunnel on two consecutive failures — this is the dead-pipe
  detector launchd cannot provide. `rotate` re-renders the Caddyfile over ssh; there
  are two enforcement points but one logical secret. Bootstrap is idempotent
  (`scripts/vps-bootstrap.sh`, `sudo -n` only, refuses to touch a pre-existing
  firewall ruleset).

All targets use numeric `127.0.0.1`, never `localhost` (can resolve `::1` and refuse
against the IPv4-bound listener).

### launchd mechanics

One agent per process so signal semantics stay exact:

| Agent | Program | Why separate |
|---|---|---|
| `app.desktop-relay.daemon` | `<node> src/daemon.ts` | the whole relay |
| `app.desktop-relay.tunnel` | ngrok / cloudflared / ssh -N -R | edge lifecycle |
| `app.desktop-relay.power` | `/usr/bin/caffeinate -dims` | sleep assertion; wrapping it around the daemon would make SIGTERM land on caffeinate and orphan the node process holding :8788 |
| `app.desktop-relay.watchdog` | `dc-relayctl doctor`-probe | `StartInterval`, end-to-end public health check |

Common keys: `RunAtLoad`, `KeepAlive`, `ThrottleInterval=10`, `ExitTimeOut=15`,
`ProcessType=Standard` (not `Background`, avoids App Nap), log paths into
`~/Library/Logs/desktop-relay/`, and `EnvironmentVariables.PATH` captured from the
operator's login shell at install so DC's spawned tools resolve (launchd's default
PATH lacks homebrew). Load via `launchctl bootstrap gui/$UID`; unload `bootout`;
restart `kickstart -k`. Boot ordering is deliberately unmanaged — convergence beats
sequencing.

### Credentials, audit, alerts

- `principals.json` stores `pathId` + `bearerSha256` only; the bearer prints once at
  mint and is never recoverable (re-mint instead). `pathId` is 128-bit, semi-public
  (appears in URLs/logs), and insufficient alone under `path+bearer` — a leaked URL
  leaks identity, not access.
- `rotate` writes a new credential and keeps the old one valid for `rotateGraceSec`
  (24h) so you don't lock yourself out remotely. `revoke` is the hard cut: swaps the
  credential AND closes every connection authenticated under it, because a file change
  alone does not invalidate streams that already passed auth.
- `DENY_REMOTE = ['set_config_value', 'give_feedback_to_desktop_commander']` — remote
  mutation of DC's own guardrails is a privilege-escalation path; config changes
  require a local file edit, even for `tools: 'all'` principals.
- `LOG_POLICY`: `execute_command`/`search_code` log a redact-then-truncate preview;
  file-mutating tools log the path only; everything else logs tool name +
  `sha256(args)` only. Never logged: raw bearer (a hash prefix on failures), file
  contents, response bodies, `Authorization` headers. Audit JSONL has exactly one
  writer (the daemon); `dc-relayctl audit` only reads.
- Alerts append to `alerts.jsonl` + `osascript` notification on: auth-failure bursts,
  valid-pathId-with-wrong-bearer (highest signal — the URL leaked while the bearer
  held), denied-tool pokes, sustained bucket exhaustion. Off-box push (e.g. ntfy.sh)
  is an open question, ~15 lines.

### Sandboxed upstream variants (documented, not default)

`sandbox` config enum. `docker` renders `upstreamCmd` as the official
`mcp/desktop-commander` image with `--read-only --cap-drop ALL --no-new-privileges`
and same-path bind mounts (`/Volumes/Elements`, workspace roots) so a leaked
credential buys a container, not the host — at the cost of Docker Desktop as an
always-on dependency and losing macOS-only tools (`osascript`, `open`, `xcodebuild`)
inside. `seatbelt` renders `sandbox-exec` (confines `execute_command` too, but SBPL is
deprecated and fails open when over-broad). `host` is the default: no confinement,
`allowedDirectories` scoped at install, and the honest statement that a leaked token
is a shell as the operator's account.

## Synthesis decision

Base: **candidate 3** (single-daemon consolidation). Codex's independent review
prescribed the same shape, and candidate 1's verification of supergateway internals
showed the base assumption (one shared upstream, loopback bind) was doubly wrong.
Grafted: candidate 1's launchd/ops mechanics and edge-selection rule; candidate 2's
complete ssh-R edge (watchdog probe, stale-listener fix, dual enforcement); candidate
4's principals, `DENY_REMOTE`, audit policy, token bucket, and alerting (demoting its
docker-default posture to a documented variant). Full record in `SYNTHESIS.md`.

## Tradeoffs accepted

- We accept ~450 lines of owned code (daemon + bridge + upstream + policy) in exchange
  for deleting supergateway, its `0.0.0.0` bypass hole, its per-POST children, and two
  upstream monkey-patches (loopback preload + body-limit sed). Owned code is also where
  auth, audit, and rate limiting can live at all — no shim in front of a third-party
  gateway can see principal + tool + args together.
- We accept one real dependency (`@modelcontextprotocol/sdk`, exact-pinned) in exchange
  for a maintained SSE/session/negotiation implementation. We do NOT hand-roll the wire.
- We accept one crash domain (auth + transport + upstream in one process) in exchange
  for two fewer processes, one fewer port, and restart-free credential rotation.
- We accept a static-credential auth model (bearer + path tier) in exchange for working
  with every target client; mitigated by per-client principals, hashed storage,
  per-client revoke, audit, and abuse brakes. Strictly weaker than OAuth, knowingly.
- We accept a generous response lifetime (no timeout) and a 16 MiB body bound in
  exchange for real DC semantics (long tool calls, large `write_file` payloads).
- We accept that rotation-with-grace and revocation are different operations, in
  exchange for not locking the operator out while remote.
- We accept ngrok's free-tier limits as a real ceiling when that edge is chosen, in
  exchange for zero-prerequisite setup; the limits are documented, not laundered as
  "unlimited".

## Alternatives considered

- **supergateway + auth shim (original base).** Rejected on verified mechanics:
  child-per-POST / child-per-session both break one-device semantics; `0.0.0.0` bind is
  an auth bypass; the body limit and missing `--host` flag require two fragile upstream
  patches. Preserved as the fallback shape if the SDK spike fails.
- **VPS edge as the base.** Demoted to the third edge variant: more ops surface (sshd
  stanza, Caddy, certs, watchdog, two-place token sync) for sovereignty most operators
  don't need. Fully specified in the edge section.
- **Reimplementing the vendor relay protocol** (`src/remote-device/remote-channel.ts` is
  OSS). Rejected: rebuilds their coupling, no gain over generic HTTPS.
- **Cloudflare Access / mTLS at the edge.** Rejected: target clients cannot complete
  OIDC or present client certs.
- **OpenAI Secure MCP Tunnel** (per Codex review): OpenAI documents tunnel support for
  local stdio MCP servers, which could remove the custom public bridge for ChatGPT/Codex
  paths only. OpenAI-hosted, account/billing limits unverified, and it does not serve
  Claude or generic MCP clients. Worth a live check before implementation lands.
- **Effect TS / Python for the daemon.** Rejected: Node is already mandatory, and the
  proxy must never retry `tools/call`, so Effect's retry machinery is the wrong instinct.
- **Per-principal upstream children.** Rejected at escape-hatch scope: needs a
  multiplexer and breaks the one-device shared-state semantics.

## Open questions and risks

1. **Load-bearing SDK assumption** (candidate 3, unresolved): can
   `StreamableHTTPServerTransport` be driven without a `Protocol`/`Server` instance via
   manual `onmessage`/`send`/`onclose`? `scripts/spike.ts` answers it first (~30 lines);
   fallback is a stub `Server` that registers no handlers.
2. **Client acceptance, unverified**: does ChatGPT's dev-mode connector accept the
   URL/token forms, and does Codex *cloud* egress allow arbitrary MCP URLs? Secret-path
   URL covers header-less clients but product access is gated separately — the paid
   connector stays installed until `scripts/verify.sh` passes through the real clients.
   OpenAI's Secure MCP Tunnel is the alternative for the ChatGPT-only path.
3. **SSE keepalive**: does the SDK heartbeat POST streams? If not, inject `: ka`
   comments at frame boundaries to survive ~100s edge idle timeouts. Resolved by the
   same spike.
4. **Hostname**: ngrok static domain (zero prereq, capped) vs a Cloudflare-managed
   domain (uncapped) vs VPS+own DNS. Operator picks at install.
5. **Session reap UX**: after idle timeout (if `sessions: 'mapped'` ever ships),
   clients 404 and must re-initialize — verify each client recovers cleanly.
6. **Codex delivered an independent zero-dep auth-boundary implementation** (loopback
   listener, bearer, route/Host/Origin checks, bounded requests, connection-closing
   rotation; 42 socket tests passing on Linux/Node 22.16) in its session artifacts.
   Not on this machine/repo — worth extracting as a reference during implementation,
   though its limits (1 MiB body, 120s response deadline) conflict with DC's
   long-call/large-write semantics and would need the reconciled values above.

## Next implementation step

`scripts/spike.ts` first — spawn DC via `StdioClientTransport`, drive a stateless
`StreamableHTTPServerTransport` per POST with manual `onmessage`, prove
`initialize` → `tools/list` → `tools/call(get_config)` over curl. That resolves the
one load-bearing assumption before the real files exist. Then `daemon.ts` +
`bridge.ts` + `upstream.ts` + `policy.ts`, `install.sh`, `scripts/verify.sh` end to
end through the public edge.
