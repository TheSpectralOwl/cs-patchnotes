# CS Patch Notes Archive

The pipeline reads and writes the sibling `cs-patchnotes-content` repository.
That repository is the source of truth: `raw/steam/` contains immutable Steam
captures and `content/notes/` contains hand-editable Markdown. 

Set `CONTENT_DIR` to use another checkout; by default commands use
`../cs-patchnotes-content`.

## Corpus commands

```sh
# Fetch authoritative Steam patch notes into raw/steam/.
node tools/seed-raw-from-steam.cjs

# Convert raw captures to regen-safe Markdown.
node pipeline/convert.cjs

# Build the production archive app in packages/archive/dist/.
npm run build:archive

# Build and run checks for the file-backed archive API.
npm run build -w @cs-patchnotes/archive-api
npm test -w @cs-patchnotes/archive-api

# Verify corpus provenance, coverage, and conversion residue.
node pipeline/audit.cjs

# Verify a content checkout in an isolated copy without changing it.
node pipeline/verify.cjs

# Fetch current Steam records, add only unseen raw captures, then convert.
node pipeline/update-steam.cjs
```

The audit report is written under `.cache/` and is never committed. The audit
intentionally reports duplicate raw captures and same-day title collisions
without modifying them: raw records preserve source evidence, while the archive
API applies any presentation deduplication.

`update:steam` never commits or pushes either repository. Review and commit any
new raw captures and converted notes in the content repository after a successful
run.

## Revision activation

The VPS does not serve a mutable content checkout. `CONTENT_REVISION_ROOT` holds
an `active` marker containing exactly one lowercase, full 40-character content
Git SHA. The API loads only `worktrees/<sha>` under that root and includes the
loaded SHA as `content_sha` in `/health`.

Use `npm run activate:content -- <full-sha>` only from the VPS activation
environment. It fetches and verifies a detached candidate worktree before
atomically replacing `active`, then invokes the SHA-bound private reload and
confirms that health reports that SHA. An explicit reload rejection restores the
old marker. A network or health-confirmation uncertainty deliberately leaves the
verified candidate selected and reports an unconfirmed outcome.

Activation uses a local owner-record lock. A concurrent activation is refused.
After 30 minutes, a stale lock is reclaimed only when its same-host owner PID is
confirmed dead; live, malformed, or foreign-host locks are left intact for
manual inspection.

The `Activate Content Revision` workflow accepts `repository_dispatch` event
type `activate-content` with `client_payload.sha`. It validates that exact SHA
and serializes activations. Configure `SSH_HOST`, `SSH_USER`, and `SSH_KEY` in
the application repository for the VPS account that owns the revision root.

## Continuous integration

`corpus.yml` checks the pipeline tests and archive application type-check on every
push and pull request. It also provides a manual corpus-build workflow. After the
content repository has a remote, run that workflow with its `owner/repository`
and ref inputs. A private content repository requires `CONTENT_REPO_TOKEN` with
read access to that repository.

The root Worker configuration provides a Worker-native SPA fallback for direct
`/notes/<filename>` links. Any other static host must provide an equivalent
fallback before publishing the app.

## Cloudflare Worker deployment

The root `wrangler.jsonc` identifies the existing `cs-patchnotes-web` Worker.
Configure the Git-connected Worker build with the repository root as its root
directory, `npm run build:cloudflare` as its build command, and `npm run
deploy:cloudflare` as its deploy command. TanStack Start writes the deployable
Worker bundle and client assets to `packages/archive/dist/server` and
`packages/archive/dist/client` respectively.

Use `npm run version:cloudflare` as the Worker Builds version command. Both
upload scripts deploy the generated Start bundle/config instead of rebundling
the source entry, while `--keep-vars` retains dashboard-managed runtime
variables. For VPS and production acceptance after an upload or refresh, follow
[the archive deployment guide](docs/archive-vps-deploy.md).

Set the Worker runtime variable `API_URL` to the public origin of the archive
read API. The Worker proxies browser `/api/*` requests to that API; no content
checkout or generated corpus index is needed in the Cloudflare build.
