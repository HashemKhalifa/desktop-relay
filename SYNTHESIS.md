# Arena synthesis record

Four candidates at `/tmp/arena-desktop-relay/candidate-{1..4}/DESIGN.md`, all completed,
no dropouts. Planned cross-judge subagent was killed by user interrupt; an independent
Codex review arrived at the same moment and served that role. It converged with the
arena on both load-bearing findings and prescribed the same revised shape, so the
judge dropout carried no cost.

## Base: candidate 3 (single-daemon consolidation)

Rubric scoring (my read, all four read end to end):

| Criterion | C1 | C2 | C3 | C4 |
|---|---|---|---|---|
| Usage-first completeness | 5 | 5 | 5 | 5 |
| Auth boundary soundness | 4 | 5 | 4 | 5 |
| Process/dependency economy | 3 | 3 | 5 | 3 |
| Failure-mode coverage | 5 | 5 | 4 | 4 |
| Client-compat realism | 4 | 4 | 4 | 5 |
| Forward-once discipline | 5 | 5 | 5 | 5 |

C3 wins on the criterion that matters most here: it deletes the component that carried
two verified defects (stateless child-per-POST semantics; `0.0.0.0` bind bypassing the
auth proxy) and the two monkey-patches C1 needed to keep it alive. Codex independently
reached the same revised structure (one authenticated listener + in-process SDK
adapter + one long-lived MCP client owning the DC child).

## Verified findings (independent agreement = high signal)

- supergateway 4.0.0 stateless = child per POST; stateful = child per session. No
  shared-upstream mode. (C1 dist-source read; Codex review)
- supergateway `app.listen(port)` binds all interfaces; no `--host` flag. (C1, Codex
  reproduced omitted-host bind)
- Bare `express.json()` = 100KB body limit; `write_file` exceeds it. (C1)
- Floating `npx @latest` = boot-time registry dependency + silent version drift. (C1,
  C3, C4)
- `set_config_value` remotely callable = guardrail escape. (C4)
- `allowedDirectories` is not a sandbox; does not bind `execute_command`. (C4, Codex)
- Token rotation must close connections authenticated under the old credential. (Codex)
- Host/Origin validation is an MCP HTTP spec requirement. (Codex; overrides C3's cut)
- ngrok free tier: ~20k HTTP requests/month + 1GB transfer, one static domain,
  interstitial page for browser UAs. (Codex corrected the "unlimited" framing; C1
  covered interstitial/one-tunnel)

## Grafts into the synthesized DESIGN.md

From **C1**: launchd mechanics (separate `power`/caffeinate agent, `ThrottleInterval`,
login-PATH baking, `bootstrap`/`bootout`/`kickstart`, numeric `127.0.0.1`), housekeep
log rotation, `/healthz` + `doctor`, edge discriminated union + selection rule,
`token.prev` rotation grace (reconciled with Codex into `rotate` vs `revoke`),
uninstall path, SSE keepalive as a verify item.

From **C2**: the complete `vps-ssh` edge (plain `ssh -N -R` under launchd not autossh,
watchdog probing the real HTTPS path, server-side `ClientAliveInterval` for stale
listener rebind, dedicated `dcrelay` user + Match stanza + `PermitListen`, Caddy
expression gate as secondary enforcement with the Mac daemon authoritative, rotate
syncs both enforcement points, idempotent `vps-bootstrap.sh`).

From **C4**: `Principal` records (`path+bearer` primary, `path-only` documented weaker
tier, hashed bearer storage, print-once minting), `DENY_REMOTE`, `LOG_POLICY` audit
table, per-principal token bucket, alert triggers with `osascript` sink, `sandbox`
enum kept as documented postures (docker/seatbelt/host) with `host` default.

From **Codex**: Host/Origin validation restored, connection-closing revocation,
bounded request limits (reconciled: 16 MiB body not 1 MiB, no response deadline for
long tool calls, 10s upload deadline, 16 concurrent), provider-limits honesty,
keep-paid-connector-until-acceptance rollout guidance, OpenAI Secure MCP Tunnel as a
listed alternative for the ChatGPT-only path.

## Rejected

- C1 as base (supergateway dependency now carries two verified defects + two required
  monkey-patches). Preserved as fallback if the SDK spike fails.
- C2 as base (edge variant grafted; full sovereignty not worth base-case ops surface).
- C4's docker-default posture (too heavy for escape-hatch scope; documented variant).
- C3's own cuts of Host/Origin validation (Codex: spec-required).
- Per-principal upstream children, edge-layer OIDC/mTLS, vendor-protocol reimplementation,
  HMAC request signing, dedicated macOS user / microVM confinement.

## Verification

Doc-level only at this stage (design package). `scripts/spike.ts` is the first
implementation step and resolves the load-bearing SDK transport assumption before any
real file is written.

---

# Revision 2 — protocol ownership (Codex review 2)

The synthesized bridge (raw JSON-RPC forwarding + id namespacing between per-request
transports and one upstream connection) was overturned by a second Codex review before
implementation landed. This record preserves why.

## The overturned assumption

Revision 1 treated the daemon as a transport-level multiplexer: rewrite client request
ids into one upstream id space, restore on the way out. Two reviews and the SDK source
now establish that does not work for N clients sharing one child:

- `initialize` is per-connection state: clientInfo, protocolVersion, capabilities.
  Desktop Commander stores one process-wide `currentClient` (observed live in the
  spike's `get_config` output). Forwarding multiple clients' init into one upstream
  connection gives them one shared — and last-writer-wins — protocol identity.
- Cancellation refers to `params.requestId`; progress refers to `progressToken`. Both
  need per-session ownership, which flat id rewriting cannot express (duplicate
  progress tokens across sessions would cross-deliver; a cancel from client B could
  hit client A's call).
- The SDK already owns this boundary: a `Server` instance per downstream session
  handles init/cancel/progress per connection; the relay's single `Client` owns the
  upstream side. Adopting protocol ownership deletes the custom bridging code rather
  than patching it.

## Adopted shape

    authenticated listener → session router → SDK Server per session →
    policy-checked handlers → one SDK Client → one DC child

Session records are real protocol state (capabilities, credential binding, generation)
— not fake terminal persistence. Child replacement invalidates old-generation
sessions; in-flight calls become outcome-unknown, never replayed. Dispatch guarantee
reworded to "at most one upstream dispatch per admitted request."

## Additional corrections folded in (Codex review 2)

- HTTP semantics: invalid Origin → 403; oversize → 413; rate-limited → 429; upstream
  down → 503; 404 only for auth/unknown path. Node `requestTimeout` is an upload
  deadline, not a response deadline; SDK RPC default is 60s — set deliberately to
  15min configurable. SSE heartbeats via transport `keepAliveMs`, no byte injection.
- Data model: Principal / Credential / Session as separate records; rotation = new
  credential + expiry on old (enforced on live streams, rechecked before dispatch);
  revoke = disable principal, close sessions, never mint replacement.
- Control channel: daemon is sole writer of principals.json via unix socket with
  acknowledged ops; file replacement alone does not prove live enforcement.
- Audit: metadata-only default — no arg previews ("redact then truncate" is not a
  complete rule for unknown secrets).
- Tool names: real DC inventory (`start_process`, `read_process_output`,
  `start_search`…) validated against pinned `tools/list`; `get_recent_tool_calls`
  gated behind `allowSharedHistory` (it leaks cross-client args/outputs).
- Watchdog: local check 60s, ngrok public probe 15min (60s public = 43.2k req/mo >
  20k free quota); `StartInterval` not unconditional `KeepAlive`; classified failure
  responses, no restart loops on quota.
- Trust statement corrected: host mode = trusted clients of one operator, not
  isolation. `PermitListen` (OpenSSH 7.8+) for `-R`; `PermitOpen` is not a fallback.
  OAuth connector flows acknowledged as a deployment choice, not a constraint.

## Acceptance contract

Rewritten around the central requirement — two clients, one child (A starts a
process, B reads its output, same child PID/generation) — plus cancellation
ownership, revocation-closes-streams, crash-after-dispatch no-replay, and the
HTTP/credential cases. Full contract in `ACCEPTANCE.md`.
