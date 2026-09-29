# Changelog

## 0.2.0 — draft

Changes since [v0.1.0](https://github.com/HashemKhalifa/desktop-relay/releases/tag/v0.1.0):

- Add an on-demand file viewer with syntax highlighting, line navigation,
  range search, wrapping, copy, download, and refresh. Preview text travels in
  component metadata; ordinary model-facing file reads keep their existing behavior.
- Add the Desktop Relay icon to the viewer, local dashboard, and MCP server metadata.
  Display of the connector icon in client menus depends on the host.
- Separate model dispatches and preview reads in the dashboard. Missing dashboard
  authentication shows unavailable data instead of misleading zero counts; active
  refreshes renew its cookie.
- Use frozen pnpm installs, a checked-in browser bundle, automated dependency-update
  pull requests, and a macOS/Linux CI matrix. Dependency updates are not auto-merged.
- Document setup, recovery, release verification, and session-count interpretation.

Existing credentials and tunnel configuration remain valid. Restart to load the
update, refresh the client's tool definitions, and make a new file read. Restarting
clears protocol sessions, process-output tracking, and retained results.

## 0.1.0 — 2026-09-27

Initial release: authenticated Cloudflare/SSH relay, one shared Desktop Commander
child, per-principal grants, credential rotation and revocation, idle-session
cleanup, configurable rate limits, retained-result paging, local usage dashboard,
and macOS LaunchAgents.

[Release notes and source](https://github.com/HashemKhalifa/desktop-relay/releases/tag/v0.1.0).
