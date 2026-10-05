# Security

## Reporting a vulnerability

Report suspected vulnerabilities through [GitHub's private vulnerability reporting](https://github.com/HashemKhalifa/desktop-relay/security/advisories/new).
Include the affected revision, reproduction steps, and expected versus observed behavior.
Use synthetic files and credentials in reproductions. Keep live tokens, complete
path-token URLs, logs, and personal files out of public issues and pull requests.

The maintained version is the latest commit on `main`. Historical releases may
not receive backports. There is no guaranteed response time.

## Trust boundary

Desktop Relay runs Desktop Commander with the macOS account's privileges.
Shell-capable clients share that account's access to files, processes, configuration,
and credentials. Tool permissions and separate credentials provide attribution and
revocation; they do not sandbox a client. Grant access only to trusted clients.

Keep the MCP listener and dashboard on loopback. Expose only the authenticated MCP
endpoint through an HTTPS edge. A path-token URL is a complete credential; treat it
like a password. Store runtime configuration, credential stores, keys, and audit
logs outside the repository, with access restricted to the operator.

Use `bin/dc-relayctl revoke --principal-id <id>` to disable a compromised principal
and close its sessions. If the host account or tunnel credentials are compromised,
revoking a relay principal alone is insufficient; recover the host and replace the
affected credentials before restoring access.

Install from the pinned lockfile. Review upstream tool changes before updating
Desktop Commander, particularly when a principal has `--tools all`. Run the local
and isolated runtime checks described in [CONTRIBUTING.md](CONTRIBUTING.md) before
activating an update.
