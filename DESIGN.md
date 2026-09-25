# Design: self-hosted Desktop Commander relay

Replaces the paid `desktopcommander.app` Remote MCP relay (10k tool calls/month free tier,
$20/month Pro) with a self-hosted chain on the Mac. The MCP server itself
(`@wonderwhy-er/desktop-commander`, stdio) is already open source and unlimited. What the
paid service adds is the middle: OAuth device pairing, a device registry, a public HTTPS
endpoint, and metering. This project rebuilds only the middle.

## Problem

Remote AI clients (ChatGPT Codex cloud tasks, Claude web, MCP clients on other machines)
need to reach this Mac over public HTTPS to run desktop-commander tools. The OSS repo
ships the device-side client (`src/remote-device/`, `desktop-commander remote`), but that
client hard-wires to the vendor's hosted relay at `mcp.desktopcommander.app`; the relay
itself is not open source. So the real job is not "write an MCP server". It is: put a
local stdio MCP behind an authenticated public HTTPS endpoint with persistence, using
components that cost nothing.

## Usage (caller's view)

After `./install.sh` runs once:

```bash
./install.sh            # generates token, installs launchd agents, prints URL
# -> prints: https://<edge-host>/mcp  plus a bearer token
```

Client configs:

```jsonc
// any local MCP client that prefers stdio (Claude Desktop, Cursor, Codex CLI on this Mac)
{ "mcpServers": { "desktop": { "command": "npx", "args": ["-y", "@wonderwhy-er/desktop-commander@latest"] } } }
```

```toml
# ~/.codex/config.toml — Codex CLI reaching the remote endpoint
[mcp_servers.desktop]
url = "https://<edge-host>/mcp"
http_headers = { "Authorization" = "Bearer <token>" }
```

```
ChatGPT (Developer Mode connector) or Claude web custom connector:
  server URL = https://<edge-host>/<token>/mcp   (path-token form works even for
                                                clients that cannot set headers)
```

Everyday ops:

```bash
bin/dc-relayctl status    # launchd health, tunnel URL, last heartbeat
bin/dc-relayctl logs      # tail gateway + tunnel logs
bin/dc-relayctl rotate    # new token, restarts agents, prints new URL
```

## Shape

Three process boxes on the Mac, all bound to loopback; one edge process.

```
remote AI client
  -> https://<edge>/mcp                      TLS terminated at edge
  -> edge tunnel agent on Mac                cloudflared | ngrok | ssh -R (config knob)
  -> 127.0.0.1:8788 src/auth-proxy.mjs       token check, then forward
  -> 127.0.0.1:8787 supergateway             stdio -> Streamable HTTP, one upstream child
  -> desktop-commander (stdio child)         the OSS MCP server, all tool state in-process
```

Data shapes: one config file `config.json` (`{ edge, portProxy, portGateway, upstreamCmd,
tokenPath, publicBaseUrl }`), one token file at `~/.config/desktop-relay/token`
(mode 0600). The edge choice is a single enum consumed by `install.sh` and the plist
templates, so switching edge later is a config edit plus reinstall, not a code change.

Stack: plain TypeScript on Node >= 24, run via native type stripping
(`node src/auth-proxy.ts`, no transpiler, zero runtime dependencies). Node is a
mandatory runtime on the box anyway since `desktop-commander` and `supergateway`
are Node; adding Python buys nothing and adds a second runtime. Effect TS rejected
for escape-hatch scope: framework weight under ~150 lines of glue, and its retry
machinery is the wrong instinct here since `tools/call` is not idempotent. If the
repo ever grows toward the vendor's full feature set (multi-device registry, OAuth
pairing, dashboard), revisit Effect as the base.

Repository layout:

```
README.md
DESIGN.md                 this file
config.example.json
install.sh                generates token, renders plists, loads launchd agents
src/auth-proxy.ts         zero-dependency node:http proxy, token gate -> supergateway
bin/dc-relayctl           status / logs / rotate
launchd/                  plist templates for gateway and tunnel agents
scripts/verify.sh         end-to-end check: initialize -> tools/list -> tools/call -> 404
```

Load-bearing decisions:

- **One upstream desktop-commander child for all remote requests** (supergateway stateless
  Streamable HTTP). This matches "one device" semantics: terminal sessions and config state
  live in that process exactly as they do under the paid relay. `--stateful` per-session
  children stay available as a config flag if a client misbehaves.
- **Auth = token-in-path primary, `Authorization: Bearer` accepted.** supergateway's
  `--oauth2Bearer` is outbound-only; inbound enforcement does not exist there, so one
  ~80-line zero-dependency `node:http` proxy checks the credential at the boundary and
  returns bare 404 on failure. Token-in-path is chosen because it works with every client
  that accepts a URL, including ChatGPT connectors that cannot set custom headers.
- **Nothing else listens on a real interface.** supergateway and the proxy bind 127.0.0.1;
  the only egress is the tunnel agent's outbound connection. No firewall holes, no ports on
  the LAN.
- **Persistence via two LaunchAgents** (`desktop-relay-gateway`, `desktop-relay-tunnel`) with
  `KeepAlive`, wrapped in `caffeinate -dims` so idle sleep does not kill remote access
  (the vendor client does the same via `--disable-no-sleep`).
- **desktop-commander's own guardrails stay on**: command blocklist, symlink protection,
  local audit log (`get_recent_tool_calls`). `install.sh` additionally offers to scope
  `allowedDirectories` to workspace roots.

## Synthesis decision

Inline sketch. Candidate A taken as base. Candidate B kept as a documented edge variant:
the Mac-side stack is identical, only the tunnel agent and edge host differ.

## Tradeoffs accepted

- We accept a single static bearer/path token as the whole auth model in exchange for
  zero-dependency simplicity; this is strictly weaker than OAuth device flow, mitigated by
  192-bit entropy, 0600 storage, rotation script, and DC's own blocklist.
- We accept losing per-call metering (the thing being escaped) and any abuse brake; the
  token is the only gate.
- We accept the tunnel provider seeing plaintext between edge and Mac loopback in exchange
  for free stable TLS; the ssh -R edge variant removes that.
- We accept secret-path URLs being logged in client dashboards in exchange for
  header-less client compatibility.
- We accept plain TypeScript without a framework in exchange for zero dependencies;
  the proxy forwards each request exactly once and never retries, because
  `tools/call` is not idempotent.

## Alternatives considered

- **Candidate B — VPS edge** (`ssh -N -R` under launchd, nginx on the VPS terminates TLS and
  enforces the token). Removes all third-party relay trust and uses infra already owned,
  but adds tunnel liveness, nginx config, and cert management. Kept as a config-edge
  variant rather than the base because it buys sovereignty that may not be needed and costs
  the most ops surface.
- **Candidate C — no remote at all**, local clients spawn stdio directly. Free and unlimited
  but cannot serve ChatGPT Codex cloud / Claude web. Still shipped as a client-config
  snippet since local stdio is strictly better than a loopback HTTP hop for on-machine
  clients.
- **Reimplementing the vendor relay protocol** (`src/remote-device/remote-channel.ts` is
  OSS, so the wire protocol is readable). Rejected: rebuilds their exact coupling for no
  gain over a generic HTTP tunnel, and keeps us tracking their protocol changes.
- **Cloudflare Access in front of the tunnel.** Rejected as primary: MCP clients cannot
  complete Access's OIDC flow; a static token is the only auth all target clients share.

## Open questions and risks

1. **Stable hostname**: named Cloudflare tunnel needs a domain in a Cloudflare account.
   ngrok free tier grants one static `*.ngrok-free.app` domain; ngrok is already installed.
   Default proposal: ngrok static domain now, cloudflared named tunnel if a domain lands
   on Cloudflare later.
2. **ChatGPT connector auth UX**: does the Developer-Mode MCP connector accept a plain URL
   with no OAuth? Secret-path URL covers it regardless; needs a live click-through to
   confirm.
3. **Codex cloud egress**: can a Codex cloud task environment reach an arbitrary public MCP
   URL, or only the vendor's registered connector? Test: add the URL to the Codex env's MCP
   config and call `list_directory`. If cloud egress blocks it, local Codex CLI via
   `~/.codex/config.toml` still works over the same endpoint.
4. **Sleep**: `caffeinate -dims` prevents idle sleep while running; lid-closed sleep on
   battery still kills it, same as the vendor client.

## Next implementation step

`src/auth-proxy.mjs` plus `install.sh` happy path: generate token, launch supergateway +
proxy on loopback, point `ngrok http --url=<static>.ngrok-free.app 8788` at the proxy,
then run `scripts/verify.sh` (`initialize` -> `tools/list` -> harmless `tools/call` ->
404 without token).
