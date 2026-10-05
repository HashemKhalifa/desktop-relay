# Preparing a release

Desktop Relay ships as a source checkout with a checked-in file-viewer bundle.
`package.json` stays private to prevent accidental npm publication. That setting
does not control GitHub repository visibility.

## Prepare the source

1. Choose a new version, update `package.json`, and add its changes to `CHANGELOG.md`.
   Keep published tags and notes attached to their original source.
2. Review the diff and run:

   ```bash
   pnpm install --frozen-lockfile
   pnpm build:viewer
   git diff --exit-code -- src/file-viewer.bundle.js
   pnpm check
   ```

   A bundle difference must be reviewed and committed before release. Include
   dependency license changes in `assets/THIRD_PARTY_NOTICES.txt` when applicable.
3. Run isolated runtime checks as described in [Contributing](../CONTRIBUTING.md).
   Do not point scratch verification at a production store by accident.
4. Activate the candidate on an authorized installation after active jobs finish.
   Wait for `bin/dc-relayctl status` to report `upstream: running`, then run
   `bin/dc-relayctl doctor` and the public checks:

   ```bash
   scripts/verify.sh https://<your-hostname>
   pnpm verify:context https://<your-hostname>
   ```

   These create temporary credentials and scratch files/processes, then revoke
   the credentials. Check authentication, localhost-only binding, shared-child
   behavior, exact output recovery, and one-time command execution.
5. Refresh the existing ChatGPT app and run the
   [repeatable ChatGPT smoke check](FILE_VIEWER.md#repeatable-chatgpt-smoke-check).
   Confirm an ordinary read stays visible after reload and only an explicit
   preview creates a card. For viewer changes, also page and refresh the displayed
   range. A protocol test or local host-bridge test alone does not prove client UI
   compatibility.

## Save a draft

Commit and push the verified source. Create a draft GitHub release for the new tag
targeting that exact commit. Include:

- Changes since the previous published tag and a comparison link.
- Installation and update links tied to the candidate source.
- Verification commands, results, platform/runtime versions, and source commit.
- Client limitations and any incomplete checks, including hosted CI that did not run.

Review the draft and the checks before publishing. A draft is not a published
release, and passing local checks does not establish that the hosted CI matrix
passed. Keep account billing changes separate from release preparation.

## Before making the repository public

Changing visibility is a separate operator decision. Complete this review first:

- Replace installation-specific domains, user paths, and machine details in docs
  and examples. Review screenshot pixels and image metadata too.
- Review the complete Git history, tags, release notes, issues, pull requests,
  and attachments for credentials or private data. `.gitignore` does not remove
  previously committed content. Rotate exposed secrets before any publication.
- Keep certificates, tunnel credentials, path-token URLs, dashboard keys, audit
  files, and raw edge logs outside the repository and release assets.
- Verify the generic setup on a clean installation and recheck ChatGPT setup steps.
- Review the MIT license and bundled dependency notices, enable an appropriate
  private vulnerability-reporting channel, and confirm maintainer ownership.
- Resolve hosted CI availability and review dependency-update pull requests.
- Publish only reviewed release assets and source; never attach a runtime config
  or a live-machine support bundle.

Repeat this review for future releases. Record results against the exact source
commit; do not reuse an older release's verification as acceptance of a new one.
