# Connection recovery

Run commands from your `desktop-relay` checkout on the Mac. The Mac must be awake,
online, and logged in for its LaunchAgents to serve the connection.

## Check the connection

```bash
bin/dc-relayctl status
bin/dc-relayctl doctor
scripts/verify.sh https://mcp.example.com
```

Replace the hostname for another installation. `status` should report
`upstream: running`; `doctor` should show the MCP listener on `127.0.0.1:8788`.
The verification script creates and revokes a temporary credential, runs a harmless
shell command, and checks access from two MCP sessions. A 17/17 result confirms the
public relay works with the test client; it does not verify ChatGPT's saved app URL.

An unauthenticated request to `/mcp` or `/healthz` returns **404 by design**.
Opening those URLs in a browser is not an authenticated health check.

## ChatGPT cannot use Desktop Relay

If public verification passes:

1. Start a new chat and select **Desktop Relay** in the composer.
2. Open **Plugins → Desktop Relay → More actions → Manage → Refresh tools** after
   relay updates. Reload the app details page if it still shows old definitions.
   The current catalogue includes `read_relay_result` for saved output,
   `preview_relay_file` for explicit preview cards, and the app-only
   `browse_relay_file` helper. An ordinary `read_file` should leave the answer
   visible without a viewer, including after reload. Ask explicitly to preview
   a file when you want its card. Old upstream cards may report that automatic
   previews are disabled; their background reads are stopped.
3. Verify the app uses your original full `https://<hostname>/<pathToken>/mcp` URL
   with authentication set to **No authentication**. The path supplies authentication.
4. If the credential was revoked, mint a replacement using the README's ChatGPT
   setup instructions and update the app URL. An expired MCP session does not
   require a new credential.

Sessions idle for 15 minutes expire. At capacity, sessions idle for at least one
minute can be reclaimed. The client must initialize again after a session expires.
The shared Desktop Commander process remains running.

If an error persists, record the time, visible error, and tool name. Do not rerun a
failed command blindly: a disconnected call may already have executed.

## Daemon is stopped or upstream is unavailable

After saving any needed terminal output and waiting for active jobs:

```bash
bin/dc-relayctl restart
bin/dc-relayctl status
```

Wait until status reports `upstream: running` before running public verification.
The control socket can respond while Desktop Commander is still starting and the
MCP listener is not ready yet. Restarting clears MCP sessions and retained output.

If launchctl reports that the service is not loaded, load its existing plist:

```bash
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/app.desktop-relay.daemon.plist"
```

Use this only for an unloaded service. If the plist is missing, follow the README's
installation steps instead. Do not rerun the installer as the first recovery step;
it writes configuration.

## File access fails after a Homebrew Node update

A relay process can remain alive after Homebrew removes the Node executable it
started with. macOS may then be unable to identify that process for protected-folder
access. An `EPERM` error alone does not establish this cause.

Check `command -v node`, `node --version`, and the executable in the daemon's
LaunchAgent plist. After saving needed output and waiting for active jobs, restart
the relay with `bin/dc-relayctl restart`. If the plist names a removed versioned
executable, update its executable path to the installed Node before restarting.
Confirm `upstream: running`, then repeat the original file read.

If access still fails with the installed executable, inspect **System Settings →
Privacy & Security → Files & Folders** for the program running the relay. A
launchd service is separate from a terminal or editor. Enable only the folder access
needed for your installation; changing file modes does not repair macOS privacy
permissions.

## Daemon works locally but the public endpoint fails

```bash
cloudflared tunnel info desktop-relay
launchctl print "gui/$(id -u)/app.desktop-relay.tunnel"
```

If the tunnel agent is loaded but disconnected, restart that agent:

```bash
launchctl kickstart -k "gui/$(id -u)/app.desktop-relay.tunnel"
```

For an unloaded agent with an existing plist:

```bash
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/app.desktop-relay.tunnel.plist"
```

Then repeat public verification. Tunnel restart can interrupt requests, so check
command outcomes before issuing replacements. Keep the origin bound to loopback;
opening port 8788 to the LAN is not a recovery step.

## Dashboard does not open or says disconnected

```bash
bin/dc-relayctl dashboard
```

This checks the live dashboard server and opens an authenticated page at
`http://127.0.0.1:8789`. The dashboard renews its one-day cookie after each authenticated refresh. Use the
command again after more than a day away, if browser cookies were cleared, or if you
changed browser profiles. Opening the bare URL does not establish authentication. Missing authentication or
a failed initial connection shows usage as unavailable, rather than zero counts.
Zero MCP sessions with a running upstream means the relay is idle; it does not
mean the server is disconnected.

If the command cannot reach the server, check daemon status and restart only if
needed. `dashboard --no-open` exports a static report; it does not start the live
server. The dashboard is local to the Mac and is not exposed through Cloudflare.

## Interpreting errors

| Response | Meaning and next step |
| --- | --- |
| 400 | Invalid MCP request; inspect the client's error and request format. |
| 404 | Missing/invalid credential or expired MCP session; check setup and reinitialize. |
| 405 on MCP GET | Expected: this relay accepts POST and DELETE, not a standalone GET stream. |
| 429 | Request allowance exhausted; observe `Retry-After`. One tool call can require several HTTP requests. |
| 503 | Upstream unavailable, concurrent-request limit, or session capacity without an idle session eligible for reclamation; inspect status. |
| 502 from the edge | Tunnel/origin connection failed; check local readiness and tunnel status. |

For a trusted ChatGPT credential, inspect its principal ID with
`bin/dc-relayctl list`, then adjust its allowance without changing the app URL:

```bash
bin/dc-relayctl set-rate --principal-id prin_… --rate 300
```

## ChatGPT says "Too many requests"

Check which hostname returned the 429. A response from
`chatgpt.com/backend-api/...` is ChatGPT's request limit, separate from the relay's
MCP allowance. Changing `dc-relayctl set-rate` cannot change that limit.

Preserve a question before refreshing a stalled chat. Pause repeated refreshes
and resubmissions, observe `Retry-After` when provided, and check OpenAI's status
page. A failed conversation load cannot establish whether the last message was
saved. If the problem persists, retain the timestamp, conversation URL, failing
endpoint, HTTP status, and sanitized error response for OpenAI Support.

Normal relay tools no longer mount automatic upstream widgets. Old widgets'
`origin: "ui"` calls receive a terminal error before reaching Desktop Commander.
Explicit file previews remain available through `preview_relay_file`. This reduces
duplicate widget work; it is not a guarantee that ChatGPT will stop returning 429.

## Logs

`bin/dc-relayctl audit` tails metadata-only request and tool events.
`bin/dc-relayctl logs` tails service logs. Stop either with Ctrl-C.
Cloudflare error logs can contain full path-token URLs: redact those URLs before
sharing logs or screenshots. Never commit credentials, dashboard keys, or raw logs.
