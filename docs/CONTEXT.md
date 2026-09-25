# Context and live monitoring

## Problem and grounding

The public MCP listener authenticates each request in `daemon.ts`, then the SDK
Server in `session.ts` checks tool grants and dispatches once through the shared
SDK Client in `upstream.ts`. Tool results currently pass through unchanged.
The pinned Desktop Commander emits large text in `content`; its line limit does
not bound a single long line. A synthetic live probe returned 122,981 JSON bytes
from `read_file` and 115,057 from `start_process`. Neither duplicated the text in
`structuredContent`. UI HTML is delivered by `resources/read`, separately.
The existing dashboard generates a local HTML snapshot from audit logs.

ChatGPT owns its conversation limit. Visible conversation length, tool counts,
and JSON byte counts cannot establish its internal token usage. The affected
chat contains numerous collapsed work/tool groups and the operator observes work
continuing. No historical tool bodies were logged, so their sizes cannot be
reconstructed reliably.

## Usage (caller's view)

Normal tool calls keep their existing argument schemas. A large plain-text result
returns a short preview plus a result ID. `read_relay_result` retrieves pages of
that exact output using byte offsets; it never re-executes the original tool.
A new session belonging to the same principal can retrieve a retained result.
The source tool must still be granted. Expired or evicted results fail explicitly.

`bin/dc-relayctl dashboard` opens a live, authenticated loopback page. The page
polls the local dashboard server for usage and daemon status. `--no-open` keeps
producing a standalone snapshot. No dashboard route is added to the public MCP
listener, and the dashboard credential is separate from remote MCP credentials.

## Shape (sketch before implementation)

```ts
class ResultStore {
  compact(principalId: string, tool: string, result: CallToolResult): CallToolResult; // not implemented
  read(principalId: string, grants: Set<string>, resultId: string,
       contentIndex: number, offset: number): CallToolResult; // not implemented
  revoke(principalId: string): void; // not implemented
}
function startDashboard(config: DashboardConfig,
  status: () => RuntimeStatus): http.Server; // not implemented
```

The result store owns byte pagination, UTF-8 boundaries, authorization, TTL, and
memory eviction. Small results remain intact. Structured, media, and widget-origin
results retain their native contracts; their bytes are measured separately.
Cache limits must be explicit; unsupported/oversized cache entries retain their
original result rather than pretending a full response was delivered.
The dashboard server owns local authentication and rendering; the daemon owns its
lifecycle and supplies live status. Existing rendering remains shared with export.

## Alternatives and synthesis

A. Lower line defaults plus byte metrics. Small interface, but it cannot contain
long lines, process output, or explicit large reads. Rejected as the primary fix;
keep the byte measurements.

B. Bounded previews plus authorized retained-result retrieval. One extra tool
hides storage, pagination, and access checks and preserves original execution.
Selected. Sequential local design passes; independent review was blocked by the
orchestration guard, including after a marker embedded in a longer user message.

C. Generic command/device dispatcher. Hides discovery details but exposes every
underlying tool schema to callers as untyped arguments. It does not bound output.
Rejected.

Dashboard alternatives: a separate Hono/portless service would add a runtime and
process lifecycle; a dashboard on the public MCP listener would widen exposure.
Choose a separate loopback HTTP listener owned by the existing daemon, using
Node's existing HTTP API, with its own credential and strict Host/Origin checks.

## Accepted tradeoffs and verification plan

- Retained output is temporary and memory-bounded; IDs expire after an hour and
  may be evicted sooner under pressure. Daemon restart clears them.
- Ordinary text previews are bounded; media, structured outputs, and oversized
  cache entries retain native results and are measurable exceptions.
- The live dashboard polls every ten seconds and adds no external dependencies.
- Test byte-perfect recovery, UTF-8 page boundaries, permission isolation,
  revocation, expiry/eviction, small/error/media preservation, and no replay.
- Run a deterministic public probe against synthetic fixtures and a command
  that increments a private scratch counter once; recover output without rerun.
- Check live dashboard authentication, Host/Origin rejection, fresh counts and
  actual browser rendering. Keep model-token claims separate from measured bytes.

## Verification observed

- Five behavioral tests passed, covering UTF-8 recovery, authorization, expiry,
  eviction, native-result preservation, and the live HTTP auth boundary.
- Isolated daemon acceptance: 17/17 passed. The shared-child check now reads the
  first client's process output from a second session; it does not assume an
  unbounded process-list response.
- Deterministic isolated probe: 48,065 recovered file bytes from a 4,855-byte
  preview; 48,325 recovered command bytes from a 4,607-byte preview; four pages
  each. File recovery equals the upstream UI-origin text exactly. A private
  counter confirms the command ran once. Cross-principal access and revoked
  credentials were rejected.
- Chrome live dashboard showed Connected, then changed requests from 111 to 116
  after real MCP requests, without reopening or manual refresh.
- After stopping only the isolated daemon, Chrome changed to Disconnected and
  retained the last observed count rather than presenting stale data as live.
- The original app remains running until the operator approves restarting its
  active terminal session. These checks used isolated ports 8899/8898.

The first file-fixture assertion assumed a terminal newline that the upstream
reader removes. Verification now compares the recovered text directly with the
upstream response. A first large probe also hit the existing 30-request burst
limit; the fixture was reduced to fit the gate, preserving the production rate
policy. The dashboard Host test uses Node HTTP because fetch normalizes Host;
with the actual forged header, the listener returns 403.
