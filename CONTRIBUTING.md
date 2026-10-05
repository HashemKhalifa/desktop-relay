# Contributing

Open an issue to discuss a change or submit a focused pull request describing the
problem, resulting behavior, and validation. Report vulnerabilities privately as
described in [SECURITY.md](SECURITY.md). Review your diff for tokens, complete
path-token URLs, private files, and machine-specific configuration before pushing.

## Local setup

Use Node.js 24 or newer and the pnpm version pinned in `package.json`.
`.node-version` selects Node 24 for version managers that support it.

```bash
pnpm install --frozen-lockfile
pnpm check
```

The TypeScript runs directly in Node; there is no compilation step. `pnpm check`
runs behavioral tests and shell syntax checks. CI runs these on macOS and Linux
with Node 24 and 26. The installer and LaunchAgents require macOS.

The file viewer's browser bundle is checked in. After editing
`src/file-viewer-client.js`, run `pnpm build:viewer` and include the updated bundle.
CI rebuilds it and rejects a stale bundle.
The daemon itself still needs no build step. See [the viewer guide](docs/FILE_VIEWER.md)
for browser and MCP acceptance checks, including the repeatable authenticated
ChatGPT smoke check in `scripts/verify-chatgpt.mjs`.

## Project layout

| Location | Responsibility |
| --- | --- |
| `src/` | Daemon, MCP sessions, upstream process, credentials, policy, result paging, file viewer, and dashboard |
| `assets/` | Desktop Relay icon and bundled-library licenses |
| `bin/` | Operator CLI |
| `test/` | Automated behavioral tests |
| `scripts/` | Runtime verification and operational helpers |
| `launchd/` | macOS service templates |
| `docs/` | Recovery guide, design evidence, and screenshots |
| `vps/` | Alternative SSH edge configuration |
| `.github/` | CI and dependency-update configuration |

## Runtime verification

For changes to authentication, sessions, transport, or upstream behavior, also test
against an isolated relay before activating the change on an installation:

```bash
pnpm verify http://127.0.0.1:8899
pnpm verify:context http://127.0.0.1:8899
```

These commands need a running daemon. Set `DESKTOP_RELAY_CONFIG` to its isolated
configuration so temporary credentials are created in the matching store. Use
separate MCP/dashboard ports and a separate configuration directory. Explicitly set
`controlSockPath`, `secretsPath`, and `auditPath` inside that directory so the CLI
and daemon use the same isolated store. Verification
creates temporary credentials and scratch processes/files; it is not a read-only
health check. CI runs the automated tests without production credentials or tunnels.

Keep the MCP listener on loopback. Preserve tool grants and deny policy. Never
retry a failed tool call automatically; it may already have executed.

## Dependencies

Use pnpm exclusively for project installs and commit `pnpm-lock.yaml` with manifest
changes. Keep runtime dependencies exact-pinned. `package-lock.json` is no longer
used; npm is only an optional way to bootstrap pnpm itself.

Dependabot checks packages and GitHub Actions weekly and proposes pull requests.
Its ecosystem name is `npm` even for pnpm lockfiles. Updates are reviewed manually;
there is no auto-merge. Action revisions are pinned by commit SHA.

For MCP SDK or Desktop Commander updates, review schema/annotation changes and the
compact tool descriptions, then run runtime verification. A green unit-test run
alone does not establish compatibility with ChatGPT. `pnpm-workspace.yaml` allows
`puppeteer`, `sharp`, and `esbuild` to run their installation scripts. Desktop
Commander's telemetry hook and the MCP Apps SDK's development-environment setup
hook are skipped. Review additional build-script allowances before enabling them.

## Installation and releases

`install.sh` installs from the frozen lockfile, writes local configuration, and
loads LaunchAgents. It defaults to a Cloudflare named tunnel; `--edge none` supports
local setup. Do not run it just to test code or update an existing installation.
Follow the README's update and recovery instructions instead.

Version tags identify release source. Keep published tags unchanged; use a new
version for subsequent releases. Never commit local credentials, keys, audit logs,
or machine-specific runtime configuration.

Follow [Preparing a release](docs/RELEASING.md) for versioning, verification,
draft notes, and the checks required before making the repository public.
