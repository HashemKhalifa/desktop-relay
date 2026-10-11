# Relay startup and dashboard session fixes

Implemented on `fix/startup-and-dashboard-session`, based on `main` at `b8b64c8`.
The live daemon is running the changed source. Exactly one live restart was used.
Two acceptance limitations remain: the strict one-second timing from kickstart
invocation was missed, and the existing file-viewer integration test times out.

## Changes

| Files | Behavior |
| --- | --- |
| `src/daemon.ts` | Bind the HTTP listener before dashboard/MCP module loading and upstream startup. Authenticated MCP requests return JSON `503`, `Retry-After: 1`, and the current upstream state until running. Authenticated health stays `200` with the state. Host, origin, and credential checks still precede readiness responses. |
| `src/upstream.ts` | Load the SDK client and stdio transport when starting the helper, so importing the upstream class cannot delay binding. Check the generation after loading to avoid starting a child after shutdown. |
| `src/dashboard-sessions.ts` | Persist random session-token SHA-256 hashes and absolute 24-hour expiries with atomic replacement and `0600` permissions. Reject invalid/expired sessions on the server. Import pre-existing key-cookies once, with a fixed 24-hour migration deadline that restarts do not extend. |
| `src/dashboard-server.ts` | Use the session store, issue separate HttpOnly/SameSite=Strict session cookies, and keep local launch-key authentication. Snapshot polling does not extend session expiry. Local-only binding and host/origin checks remain enforced. |
| `scripts/watchdog.sh` | Give an already running process 30 seconds to bind after launch. In the documented listener-only mode, recognize the relay's unauthenticated `404`. Fix empty auth-array expansion under macOS Bash 3 `set -u`. |
| `test/daemon-startup.test.ts`, `test/fixtures/delayed-upstream.ts` | Run the real daemon and a gated MCP helper. Verify health before readiness, JSON `503` and Retry-After for MCP methods, auth/host/origin rejection, then initialization and tool listing after release. |
| `test/dashboard-server.test.ts` | Verify the same cookie after server recreation; reject invalid and expired cookies, including after another restart; check the migration deadline, private file permissions, and absence of plaintext secrets in the session file. |
| `test/watchdog.test.ts` | Execute the shell script against isolated command fixtures for nine startup, missing-process, age-boundary, authenticated-health, and unauthenticated-listener scenarios. |

The existing `src/dashboard.ts`, `src/dashboard-live.js`, and `bin/dc-relayctl`
flow uses these server changes without client-side secret storage. No secrets
were added to application logs or this report.

## Test output

The final focused startup check after moving dashboard initialization behind
binding passed:

```text
$ node --test test/daemon-startup.test.ts
PASS daemon listens before upstream readiness, preserves auth, then serves MCP
Authenticated health responded after 584ms with upstream blocked.
Tests: 1; pass: 1; fail: 0
```

The required full suite was run with `pnpm check`. A serial run and a later
`pnpm check` retry also retained the same single failure:

```text
Tests: 15
Pass: 14
Fail: 1
file viewer reads exact bounded ranges through the shared upstream with component-only content
AssertionError at test/file-viewer.test.ts:36
'down' !== 'running'
```

That test timed out after approximately 60 seconds during actual Desktop
Commander startup, before exercising its viewer assertions. It also failed in
isolation. An isolated comparison using the unchanged upstream source from
`main` passed in 43.45 seconds. A handshake trace using the changed upstream
successfully initialized and listed 26 tools in 27.91 seconds. These results do
not establish the timeout's cause or prove it is pre-existing. No test was
skipped, weakened, or given a longer SDK timeout to conceal this failure.

The new dashboard and watchdog tests passed in the full-suite runs.
`pnpm run check:shell` passed separately, including syntax validation for all
existing shell entry points. `git diff --check` passed.

## Live check, 2026-10-11

Executed once:

```sh
launchctl kickstart -k gui/$(id -u)/app.desktop-relay.daemon
```

The observation script polled TCP separately from authenticated HTTP responses,
kept credentials in memory, and recorded only sanitized results.

| Check | Result |
| --- | --- |
| Before restart | Authenticated health `200`, upstream running, dashboard snapshot `200`. A browser tab showed Usage overview / Connected. |
| TCP listener | First observed closed at 1,029.8ms; reopened at 1,861.9ms after command invocation. Observed outage was 832.1ms. **The strict <=1 second from invocation criterion was not met.** |
| Early health | New daemon returned authenticated `200`, upstream starting, before helper readiness. First successful authenticated new-process response was observed at 3,893.9ms. |
| Early MCP | `503`, `Retry-After: 1`, `{"error":"upstream_not_ready","upstream":"starting"}`. |
| Ready MCP | Initialization `200` at 32,394.1ms; tool listing `200`, 26 tools. |
| Dashboard HTTP session | The exact cookie obtained before restart returned snapshot `200` from the new daemon, without signing in again. |
| Browser session | The same open tab showed Upstream starting during initialization, then Usage overview / Connected. Browser snapshot fetch returned `200` from the new daemon. No second login was performed. |
| Auth boundaries | Unauthenticated MCP `404`; foreign Host `403`; foreign Origin `403`. |
| Public tunnel | `https://dc.khalifah.uk/` returned the expected unauthenticated `404`, not `502`. Authenticated public MCP initialization returned `200`, and a read-only `list_directory` call through the tunnel succeeded with `200`. |
| Persistence | New session store mode `0600`. Hash comparison confirmed the existing relay config, principals, token artifact, dashboard key, and Cloudflare config were unchanged by the live check. |
| Final runtime | Authenticated health `200`, upstream running, same new daemon PID. |

The watchdog's startup/recovery behavior is covered by isolated execution tests.
The live daemon also remained at the same PID across the installed watchdog's
normal 60-second interval. No additional live restart was used to tune timing.

## Remaining limitations

- The listener was available within one second of the observed socket closing,
  but not within one second of kickstart invocation. This report does not claim
  the stricter acceptance target passed.
- The file-viewer integration timeout remains unresolved. The full suite is not
  green despite successful live MCP and public tool calls.
- Restart persistence and expiry of newly issued session cookies were verified
  by simulated server restarts. The single production restart verified migration
  of the previously signed-in browser's existing cookie.

No `.github`, Cloudflare configuration, principal, or existing token file was
edited. No remote push was requested or performed.

Skills used: pstack prove-it-works, TypeScript best practices, type-system
discipline, and unslop; semantic-code-investigation; TraceDecay using-tracedecay,
exploring-code, using-the-cli, editing-safely, assessing-impact, and
reviewing-changes; completion-status-communication. Initial TraceDecay discovery
failed, so focused reads were used. Later semantic queries succeeded; discovery
reported 16,462 to 1,168 tokens and affected-test lookup 1,846 to 143 tokens.
