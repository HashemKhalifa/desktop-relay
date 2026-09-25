# desktop-relay

Self-hosted replacement for the paid [Desktop Commander Remote MCP](https://mcp.desktopcommander.app)
relay. Run [Desktop Commander MCP](https://github.com/wonderwhy-er/desktopcommandermcp)
on your own machine behind your own authenticated HTTPS endpoint, with no monthly
tool-call quota.

## Why this exists

The [DesktopCommanderMCP](https://github.com/wonderwhy-er/desktopcommandermcp) server is
open source and unlimited. The metered part is the hosted relay at
`mcp.desktopcommander.app`, which brokers calls between web AI clients (ChatGPT, Claude,
any remote MCP client) and your machine. Free tier: 10,000 tool calls/month, then
$20/month Pro.

The OSS repo already ships the device-side client (`src/remote-device/`,
`desktop-commander remote`), but it only speaks to the vendor's relay. The relay itself
is closed source. This repo rebuilds exactly that middle layer.

## Architecture

```
remote MCP client
  -> https://<your-edge>/mcp               TLS at the edge
  -> tunnel agent on your Mac              ngrok | cloudflared | ssh -R
  -> 127.0.0.1:8788  src/daemon.ts         auth + limits + audit
       |-- one SDK Server + transport per client session   (session.ts)
       |-- policy-checked tools/list + tools/call handlers
       |-- one SDK Client + one desktop-commander child    (upstream.ts)
  -> desktop-commander (stdio child)       the OSS MCP server
```

The relay **terminates** each downstream MCP connection: every remote client gets its
own protocol session (capabilities, cancellation, progress ownership), while all
sessions share one long-lived desktop-commander child — the "one device" semantic the
vendor relay provides. Only the relay's own SDK Client ever initializes the child.

Node 24 runs the TypeScript directly (native type stripping). Runtime deps:
`@modelcontextprotocol/sdk@1.30.0` + `@wonderwhy-er/desktop-commander@0.2.51`, both
exact-pinned.

## Install

```bash
git clone <this repo> && cd desktop-relay
npm ci
./install.sh --edge none                     # local only
bin/dc-relayctl mint --name me --kind bearer --tools all
scripts/verify.sh                            # acceptance: 15 checks
```

Public edge (only after `verify.sh` passes):

```bash
./install.sh --edge ngrok --domain <you>.ngrok-free.app
# or: --edge cloudflare --domain mcp.example.com   (needs a named tunnel)
# or: --edge vps-ssh --vps shivo@dedicated --domain mcp.example.com
```

## Using it

Bearer clients (Codex, Claude connectors — header-capable):

```
url:     https://<edge>/mcp
header:  Authorization: Bearer <secret from mint>
```

Header-less clients get a `path-only` credential — the URL path itself is the secret:

```bash
bin/dc-relayctl mint --name phone --kind path-only --tools all
# -> https://<edge>/<pathToken>/mcp
```

Lifecycle:

```bash
bin/dc-relayctl list                          # principals + credential metadata
bin/dc-relayctl rotate --principal-id prin_…  # 24h grace on the old credential
bin/dc-relayctl revoke --principal-id prin_…  # kills credentials AND live sessions
bin/dc-relayctl status | url | logs | audit | doctor
```

## Security model

- Single authenticated listener on `127.0.0.1`; the tunnel forwards to it — auth is
  never terminated by the edge. Failures: `404` (auth), `403` (Host/Origin),
  `413`/`408` (body limits), `429` (rate), `503` (upstream down/overloaded).
- Per-principal grants validated against the pinned binary's `tools/list`.
  `set_config_value` and `give_feedback_to_desktop_commander` are denied for everyone
  (they can loosen guardrails remotely). `get_recent_tool_calls` needs
  `--allow-shared-history` — it exposes other sessions' arguments.
- Audit is **metadata-only** (principal, session, tool, outcome) — never arguments or
  output bodies. `~/.config/desktop-relay/audit.jsonl`.
- **Honest scope**: host mode means the bearer grants the privileges of the OS account
  running the daemon. Trusted clients of one operator — not isolation. Rotate/revoke
  via the daemon's control socket (`~/.config/desktop-relay/control.sock`, mode 0600);
  revoking closes live sessions.

## Provider honesty

The relay itself is unmetered, but the edge isn't magic: ngrok free ≈ 20k HTTP req/mo +
1GB (the watchdog probes publicly every 15 min to stay well inside it). A VPS you
already own has no such quota. Keep the vendor connector installed until acceptance
passes — this replaces it, nothing forces you to uninstall it.

## Docs

- [DESIGN.md](DESIGN.md) — architecture, threat model, why protocol ownership
- [SYNTHESIS.md](SYNTHESIS.md) — 4-candidate arena + both Codex reviews, pick/graft record
- [ACCEPTANCE.md](ACCEPTANCE.md) — the full verification contract
- [vps/README.md](vps/README.md) — self-sovereign SSH edge

## Links

- Desktop Commander MCP: https://github.com/wonderwhy-er/desktopcommandermcp
- Hosted relay this replaces: https://mcp.desktopcommander.app
- MCP SDK: https://github.com/modelcontextprotocol/typescript-sdk

## License

MIT
