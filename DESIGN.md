# Desktop Relay — synthesized design

Status: **revision 2 — protocol ownership** (supersedes the transport-bridge revision).
The first revision's core mechanism — forwarding raw JSON-RPC between per-request HTTP
transports and one upstream stdio connection — was rejected by second review: several
clients sharing one child cannot negotiate end-to-end. `initialize` carries client
identity, protocol version, and capabilities; Desktop Commander keeps a single
process-wide `currentClient`; cancellation addresses `params.requestId` and progress
addresses `progressToken` — all of which need protocol ownership, not byte relaying.

This revision adopts the corrected shape: **the relay terminates the downstream MCP
connection and is the sole MCP client of the child.**

Arena output and both review packages: `/tmp/arena-desktop-relay/` (ephemeral);
synthesis record: `SYNTHESIS.md`; acceptance contract: `ACCEPTANCE.md`.

## Goal (restated)

The vendor's hosted relay is the metered layer (`mcp.desktopcommander.app`, 10k calls/mo
free tier). This repo replaces that middle hop with a self-hosted equivalent:

- One shared long-lived `desktop-commander` process — the device.
- One public HTTPS endpoint with per-client credential authentication.
- One daemon that stays alive across sleep/network changes on macOS.
- Zero new language runtimes; Node 24 already on the box.
- Structured deny rules for operations that should never be remote-callable.
- Escape-hatch scope: single operator, single device — not a multi-tenant platform.

## Hard requirements (revalidated)

| Requirement | Source |
|---|---|
| ChatGPT as MCP client, no custom code | user's stated client |
| Long-lived sessions across calls (process start → later read) | DC tools, central requirement |
| No vendor relay quota | motivation |
| Cheap: existing `dedicated` VPS or free tunnel tier | user constraint |
| Survive sleep/hibernate + network changes | field requirement |
| Auth: at minimum one secret over HTTPS | security baseline |
| Deny remote access to dangerous tools | second review graft |
| Audit trail per client | second review graft |
| Abuse brakes | second review graft |

## Selected architecture — `desktop-relay` daemon

```
remote MCP client
  -> HTTPS edge (ngrok | cloudflare | vps-ssh)
  -> outbound tunnel on the Mac (ngrok | cloudflared | ssh -R)
  -> ONE authenticated listener on 127.0.0.1:8788        [daemon.ts]
  -> policy + session routing                            [daemon.ts]
  -> one SDK Server + StreamableHTTP transport per session [session.ts]
  -> policy-checked tools/list & tools/call handlers     [session.ts]
  -> ONE SDK Client owned by the relay                   [upstream.ts]
  -> ONE Desktop Commander stdio child                   [upstream.ts]
```

Two OS processes on the Mac: the daemon, and the tunnel agent (unless `vps-ssh`, which
is the same shape with `ssh -R`).

### Why protocol ownership, not a wire bridge

Verified against the installed SDK (`@modelcontextprotocol/sdk@1.30.0`) and the pinned
desktop-commander build:

- Desktop Commander stores one process-wide `currentClient`; forwarding N clients'
  `initialize` into one connection corrupts capability negotiation. Each downstream
  `Server` instance negotiates independently; the relay's single `Client` initializes
  the child once, as the relay (`clientInfo: desktop-relay`).
- Cancellation (`notifications/cancelled` → `params.requestId`) and progress
  (`progressToken`) now route correctly **by construction**: the SDK Server aborts the
  request handler's `AbortSignal`, which we pass to `client.request`; upstream
  `onprogress` is forwarded to the requesting session's transport only. No bespoke id
  namespacing.
- A session record owns negotiated capabilities, credential binding, and response
  delivery — real protocol state, not fake terminal persistence. Closing a session
  never kills the shared child; replacing the child invalidates sessions of its
  generation.

### Shared child + upstream generation

One `SdkClient` + one `StdioClientTransport` + one DC child for the whole process.
`upstream.ts` owns it:

- `generation` increments per child spawn; captured per dispatched call and per
  session at creation.
- Child death → in-flight calls are **outcome-unknown** (error `-32603`: "upstream
  restarted; call may have executed"), never replayed. Sessions bound to the old
  generation are invalidated; downstream clients re-initialize.
- Respawn with exponential backoff (250ms → 5s cap). Requests arriving during restart
  fail fast (`503`-equivalent MCP error) — **no hidden queue of side-effecting calls**.
- New child gets a fresh `Client` performing its own handshake; no replayed init.
- Upstream launch is `StdioClientTransport` with an absolute command path, args array,
  explicit `cwd`, minimal env — no shell parsing.

### Dispatch guarantee

**At most one upstream dispatch per admitted request.** Never "exactly once." A write
to stdio that fails ambiguously is treated as possibly-executed and surfaced as
outcome-unknown — never resent. Client retries are new admissions.

## Credentials, principals, sessions

Three records (replaces the earlier single-credential union):

```ts
Principal { id, name, enabled, tools: string[]|'all', allowSharedHistory, ratePerMinute }
Credential { id, principalId, kind: 'bearer'|'path-only', secretSha256, createdAt, expiresAt? }
Session   { id, transport, server, principalId, credentialId, generation, createdAt }
```

- `bearer`: `Authorization: Bearer <32 random bytes, base64url>` — sent over TLS on any
  path. Route identity alone is not an access credential.
- `path-only`: `https://host/<pathToken>/mcp` where pathToken is a 128-bit secret —
  the **complete** access secret for header-less clients. Never logged, never in
  status output, never in alerts.
- **Rotate**: mint a new `Credential`, set the old one's `expiresAt = now + 24h`.
  Expiry affects live streams as well as new requests — validity is rechecked
  immediately before every dispatch.
- **Revoke**: set `enabled=false` on the principal → all its credentials stop working,
  waiting calls are refused, existing sessions/streams close. Revoke never mints a
  replacement.
- Session binding: a session belongs to `(principalId, credentialId)`; another
  principal's credential cannot reuse it.
- All auth failures → bare `404`. Post-auth failures keep honest statuses (below).

### Control channel

The daemon is the **only writer** of `~/.config/desktop-relay/principals.json`
(0600). `dc-relayctl` talks to a unix socket (`control.sock`, dir mode 0700):
`mint | rotate | revoke | list | status`. The daemon validates, durably replaces the
file (tmp+rename), publishes the in-memory revision, closes affected sessions, **then
acknowledges**. If durable state and live state can't be reconciled, admission stops
and the op reports failure. This socket is a convenience boundary, not isolation from
the operator's own shell.

## HTTP semantics (corrected)

| Condition | Status |
|---|---|
| Auth failure / unknown path | `404` (uniform, silent) |
| Invalid Origin or Host | `403` (per MCP spec) |
| Body > 16 MiB | `413` |
| Upload deadline exceeded (10s) | `408` |
| Rate limit exhausted | `429` |
| Upstream unavailable before dispatch | `503` |
| Accepted notification | `202` |
| Denied tool / tool error | JSON-RPC error in 200 body |
| `GET /mcp` (standalone SSE) | `405` — no server-initiated streams in v1 |
| `DELETE /mcp` | session close, per spec |

Host allowlist: `127.0.0.1:8788`, `localhost:8788`, `[::1]:8788`, plus the configured
`publicBaseUrl` host. Origin, if present, must resolve to an allowed host.
Forwarded headers (`X-Forwarded-*`) never determine authority.

Limits: 16 MiB body counted during upload (reserve an upload slot **before** reading);
10s upload deadline; `maxConcurrentPosts: 32` global + per-principal bucket
(`ratePerMinute`, burst 30); bounded open-session count. Node `requestTimeout` is not
used as a response deadline — upstream RPC deadline is **15 minutes, configurable**
(the SDK default is 60s; must be set deliberately). SSE heartbeats use the
transport's own `keepAliveMs` — no injected bytes.

## Method and tool policy

v1 exposes only the tools protocol + ping + lifecycle. Sampling, roots, elicitation,
subscriptions are unadvertised; server→client requests receive `-32601`.

```ts
DENY_REMOTE = { 'set_config_value', 'give_feedback_to_desktop_commander' }
```

Tool names are validated against `tools/list` from the **pinned** binary at upstream
connect; unknown configured names fail the principal. `tools: 'all'` resolves against
that inventory minus `DENY_REMOTE` — no automatic privilege growth on dependency
update (new tools require review).

`get_recent_tool_calls` returns shared cross-client history with arguments and
outputs: granted only when `allowSharedHistory: true` on the principal.

## Audit and alerts

**Metadata-only by default**: `ts, event, principalId, credentialId, sessionId,
generation, tool?, status, ms` → `audit.jsonl`. No command previews, arguments,
headers, secrets, or tool output — "redact then truncate" is not a complete rule for
unknown secrets. Attribute events from authenticated context, never client-supplied
metadata. Audit is **not** tamper-proof against a shell running as the file owner.

Alerts (`osascript` + `alerts.jsonl`): auth-failure bursts, path-only/bearer
mismatches, denied-tool probes, sustained rate-limit hits, upstream respawn loop.

## Edge configuration (same enum as before)

`edge.kind ∈ ngrok | cloudflare | vps-ssh`. The tunnel forwards 127.0.0.1:8788 and
never terminates auth.

- **ngrok**: `ngrok http --url <your-static>.ngrok-free.app 8788`. **Real limits:
  ~20,000 HTTP req/mo + ~1GB transfer on free** — probe cadence must respect this.
- **cloudflare**: named tunnel via `cloudflared tunnel` (login + DNS route; needs an
  account domain).
- **vps-ssh**: `ssh -R` to the existing `dedicated` VPS; `PermitListen` pins the
  remote bind to loopback (OpenSSH 7.8+; `PermitOpen` is not a substitute). Caddy on
  the VPS owns TLS + routing only — credential enforcement stays in the Mac daemon;
  no secret sync. Full file set in `vps/`.

OAuth connector flows (ChatGPT/Claude) are documented alternatives; static
credentials are a deployment choice for this escape hatch, not a claim that clients
can't do OAuth.

## Daemon resilience (corrected)

- `daemon` and `tunnel` launchd jobs: `KeepAlive` (long-running services).
- `power` job: `caffeinate -s`, optional — plain `pmset sleep` still reaches it on
  power; document the energy cost.
- `watchdog`: `StartInterval=60` **without** unconditional `KeepAlive`; local check
  every minute. Public probe every **15 min** on ngrok (60s public probes alone =
  43,200 req/mo > the 20k quota), with a bounded recovery budget and classified
  failures — local child failure, tunnel failure, credential failure, quota, DNS —
  quota exhaustion must not cause restart loops.
- `SIGHUP`/`SIGTERM` → drain; verify child **and descendants** actually die — closed
  stdio isn't proof.

## Trust statement (corrected)

> Host mode runs tools with the operator account's privileges. All shell-capable
> principals belong to one trust domain. Relay deny rules reduce accidental misuse;
> they are not an isolation boundary — a shell running as the same account can write
> DC config, relay code, principal files, and audit logs. Separate credentials give
> attribution and independent revocation, not separate data access. For real
> isolation, run desktop-commander under a dedicated account or the Docker variant.

## Verification (see ACCEPTANCE.md for the full contract)

First meaningful proof is **two clients, one child**: client A starts a harmless
process, client B reads its output, same child PID and generation. Local first, public
edge is a separate gate. The old paid connector stays until the real-client checks
pass — replacement does not imply automatic uninstall.

## Non-goals

No OAuth flows, multi-device routing, dashboards, hosted deployment, billing; no
sandbox claims; no modification of the upstream desktop-commander checkout; no
public activation before local acceptance.
