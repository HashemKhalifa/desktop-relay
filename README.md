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
  -> 127.0.0.1:8788 auth proxy            token check (path or Bearer)
  -> 127.0.0.1:8787 supergateway          stdio <-> Streamable HTTP
  -> desktop-commander (stdio)            the OSS MCP server
```

Everything above the edge runs on loopback. The only egress is the tunnel agent's
outbound connection. No open ports, no firewall changes.

## Cost

$0/month. The tunnel edge is a free Cloudflare Tunnel, a free ngrok static domain, or
an SSH reverse tunnel to a VPS you already own. Tool calls are unlimited because you
own the relay.

## Status

Design phase. See [DESIGN.md](DESIGN.md) for the full design package, alternatives
considered, threat model, and open questions. Implementation is gated on design
validation.

## Links

- Desktop Commander MCP (the OSS server this wraps): https://github.com/wonderwhy-er/desktopcommandermcp
- The hosted relay this replaces: https://mcp.desktopcommander.app
- supergateway (stdio -> Streamable HTTP bridge): https://github.com/supercorp-ai/supergateway
- npm packages: `@wonderwhy-er/desktop-commander`, `supergateway`

## License

MIT
