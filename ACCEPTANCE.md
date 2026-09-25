# Acceptance contract

Status: required checks, not completed tests. Gate order: **local adapter → local
fault injection → public edge → real clients**. The paid connector stays until the
real-client cases pass.

## First executable milestone

Two real MCP clients against one real pinned Desktop Commander child, on a disposable
workspace — not the operator's normal one. Same-child proof is the central
requirement; `get_config` alone does not demonstrate it.

| Case | Required evidence |
|---|---|
| Initialization | One relay-owned upstream handshake per child; downstream clients cannot replace that identity |
| Shared child | Client A `start_process`; client B `read_process_output` — same child PID + generation |
| Correlation | Concurrent identical client-visible ids (numeric `7` vs string `"7"`) resolve to the right sessions |
| Same credential | Two chats on one credential remain distinguishable for cancel/progress |
| Cancellation | B's cancel cannot hit A's call; A's cancel targets only A's call; no rollback claim |
| Progress | Duplicate `progressToken`s across sessions do not cross-deliver |
| Tool grants | Denied tools absent from `tools/list`, rejected by `tools/call`; unknown configured names fail validation |
| Metadata forgery | Forged principal/client fields in JSON do not affect authz or audit attribution |
| Shared history | Restricted principals cannot reach `get_recent_tool_calls` |
| Crash before dispatch | Unavailable response; no queued call appears after respawn |
| Crash after dispatch | Outcome-unknown error; respawn never resends (fixture counter proves no replay) |
| Old generation | Late result/`onclose` from dead child cannot affect new calls or the replacement child |
| Rotate | Old + new credentials work during grace; only the old expires |
| Grace expiry | Expired credential rejected for new requests and live streams |
| Revoke | All principal credentials stop; waiting calls refused; streams close; nothing minted |
| Credential reuse | A different principal cannot reuse another session's ID |
| Request limits | 16 MiB and 16 MiB+1; fixed and chunked; incomplete uploads; concurrent large uploads |
| Long operations | Call > 60s survives configured SDK + edge settings |
| HTTP contract | Invalid Origin (403)/Host, oversize (413), overload (429/503), notification (202), wrong creds (404), GET/DELETE handling |
| Header integrity | Duplicate/malformed auth headers don't bypass; forwarded headers never grant authority |
| Socket ownership | Every listener belongs to a known process; MCP listener authenticated on numeric loopback |
| Secret hygiene | Relay/child/tunnel/installer/watchdog logs contain no test credentials or arg canaries |
| macOS lifecycle | bootstrap, bootout, crash restart, logout/login, sleep, network change, child+descendant cleanup |
| Watchdog quota | Scheduled + recovery probes counted against provider allowance; exhaustion causes no restart loop |
| SSH boundary (if `vps-ssh`) | Permitted `-R` works; other remote listeners, `-L`, shell, PTY, agent forwarding fail |
| Real clients | Actual ChatGPT + Claude connector flows incl. authorized harmless writes + recovery |
| Cutover | Old connector retained until above passes |

## Evidence to retain

Relay commit, lockfile hash, dependency versions, Node + macOS versions, selected
edge, test commands, sanitized outputs, observed child PID/generation. Source review,
a lone `get_config`, or tests against fake handlers are not completion evidence.
