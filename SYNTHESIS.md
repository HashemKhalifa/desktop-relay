# Architecture decision history

This record explains the initial choice of one shared Desktop Commander child and
per-session MCP protocol ownership. The README and source describe current features;
[DESIGN.md](DESIGN.md) preserves the initial design contract.

## Alternatives

The initial designs considered a generic stdio-to-HTTP wrapper, separate proxy and
edge services, one authenticated relay daemon, and a container-based installation.
The single daemon was selected to keep authentication, policy, session ownership,
and upstream lifecycle in one process. Cloudflare, ngrok, and SSH remain edge choices;
they forward traffic to the authenticated loopback listener.

A generic wrapper did not satisfy the shared-device requirement. Starting a child
for each POST loses process state; starting a child for each session prevents client B
from reading a process started by client A. An unqualified network bind also risks
exposing a listener outside the authentication boundary.

Container isolation was left outside the default macOS installation. Host mode
serves trusted clients of one operator. Tool allowlists do not isolate clients from
that account's files or shell privileges.

## Protocol ownership

The first relay design proposed forwarding raw JSON-RPC while rewriting request IDs.
That model was rejected before implementation: initialization negotiates identity,
protocol version, and capabilities for one connection. Desktop Commander maintains
one upstream client identity. Forwarding several clients' initialization messages
into the same child would make their protocol state conflict.

Cancellation and progress also require connection ownership. Rewriting request IDs
alone cannot safely route overlapping progress tokens or cancellation requests.

The adopted design uses one SDK Server and Streamable HTTP transport per downstream
session, connected through policy-checked handlers to one SDK Client and one child.
The SDK handles session negotiation, cancellation, and response delivery. Child
replacement advances its generation and invalidates old sessions. An interrupted
call may already have executed; the relay reports uncertainty and never replays it.

## Authentication and operations

Principals carry tool grants; credentials bind authentication to principals; sessions
bind a protocol connection to its credential and upstream generation. The daemon
owns credential-store writes through a local control socket. Revocation disables a
principal and closes its sessions; rotation creates a replacement credential with a
bounded grace period for the old one.

Host and Origin checks, request limits, rate limits, and metadata-only auditing sit
at the authenticated listener. Edge services provide HTTPS and forwarding, while
the Mac daemon enforces credentials. Forwarded headers do not establish authority.
The dashboard stays on loopback and requires its own authentication.

LaunchAgents supervise the daemon and tunnel. A periodic watchdog checks readiness;
optional power management keeps the Mac awake at an explicit energy cost.

## Verification boundary

The central runtime check is two clients sharing one child: client A starts a
harmless process and client B reads its output. Authentication, policy, revocation,
exact retained-output recovery, and one-time command execution require additional
checks. Local protocol verification, public-edge verification, and client UI
acceptance are separate results. See [ACCEPTANCE.md](ACCEPTANCE.md) for the contract
and [CONTRIBUTING.md](CONTRIBUTING.md) for isolated runtime checks.
