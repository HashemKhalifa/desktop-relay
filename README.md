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
is closed source. This repo rebuilds exactly that middle layer:

```
AI client (ChatGPT / Claude / Codex / any MCP client)
  -> https://<your-edge>/mcp              TLS at the edge
  -> tunnel agent on your Mac             cloudflared | ngrok | ssh -R
  -> 127.0.0.1:8788 src/daemon.ts         auth + limits + audit, one process
       |-- per-client principals, Host/Origin checks, token bucket
       |-- JSON-RPC bridge (id namespacing, at-most-once forwarding)
       |-- one long-lived desktop-commander child via MCP stdio transport
  -> desktop-commander (stdio child)      the OSS MCP server
```

One loopback listener, one tunnel, one desktop-commander child owned by the daemon.
No unauthenticated HTTP hop anywhere: the only listener is the authenticated one.
Node 24 runs the TypeScript directly; the single runtime dependency
(`@modelcontextprotocol/sdk`) is exact-pinned.

## Cost

$0/month. The edge is a free Cloudflare Tunnel, a free ngrok static domain (note:
ngrok free publishes ~20k HTTP requests/month and 1GB transfer limits — a real but
generous ceiling), or an SSH reverse tunnel to a VPS you already own. Tool calls are
unmetered because you own the relay.

## Status

Design synthesized from a 4-candidate arena plus independent Codex review. See
[DESIGN.md](DESIGN.md) for the full package and [SYNTHESIS.md](SYNTHESIS.md) for the
pick/graft record. Implementation starts with `scripts/spike.ts` to prove the one
load-bearing SDK assumption.

## Links

- Desktop Commander MCP (the OSS server this wraps): https://github.com/wonderwhy-er/desktopcommandermcp
- The hosted relay this replaces: https://mcp.desktopcommander.app
- supergateway (stdio -> Streamable HTTP bridge): https://github.com/supercorp-ai/supergateway
- npm packages: `@wonderwhy-er/desktop-commander`, `supergateway`

## License

MIT
