# Archive VPS Deployment

The archive API reads a selected, read-only content worktree and has no database
or search-index volume. Docker publishes its private reload port only to VPS
loopback; Cloudflare reaches it over the compose internal network.

## One-time VPS setup

1. Create `~/cs-patchnotes-archive/.env` with the existing `TUNNEL_TOKEN` and a
   new, high-entropy `RELOAD_TOKEN`.
2. In the Cloudflare Tunnel's remote ingress configuration, point the archive API
   hostname at `http://archive-api:3001`.
3. Set the TanStack Start Worker's runtime `API_URL` variable to that public API
   hostname.
4. Trigger the `Deploy Archive API` GitHub workflow from `main`.

The workflow creates or updates the application checkout, a content Git
repository, and a revision root:

```text
~/cs-patchnotes-archive          # code and archive compose stack
~/cs-patchnotes-content-repo     # Git repository used to create worktrees
~/cs-patchnotes-content-revisions # active marker and immutable candidates
```

## Content activation

After a reviewed content commit reaches `main`, activate its exact full SHA on
the VPS or dispatch it from the content workflow:

```sh
cd ~/cs-patchnotes-archive
CONTENT_SHA="<full-40-character-content-commit-sha>"
export CONTENT_SHA

CONTENT_REVISION_ROOT="$HOME/cs-patchnotes-content-revisions" \
CONTENT_REPOSITORY_DIR="$HOME/cs-patchnotes-content-repo" \
ARCHIVE_API_URL="http://127.0.0.1:3001" \
RELOAD_TOKEN="$(grep '^RELOAD_TOKEN=' .env | cut -d= -f2-)" \
node tools/activate-content.cjs
```

The command fetches one requested SHA, creates or reuses its detached worktree,
verifies the complete corpus, atomically publishes the active marker, and asks
the API to reload that exact SHA. It does not rebuild or deploy the Cloudflare
Worker. The VPS account needs Git, Node 22, and the application checkout's
installed dependencies in addition to access to the content repository and
revision root.

## Release and activation acceptance

Run these checks from an authorized environment after a Worker upload or a VPS
content activation. Supply the real public origins only in the current shell; do
not commit, paste into tickets, or echo deployment values, authorization
headers, or reload credentials.

```sh
: "${API_ORIGIN:?Set API_ORIGIN to the real public archive API origin}"
: "${WORKER_ORIGIN:?Set WORKER_ORIGIN to the real public Worker origin}"
```

For an authenticated Worker release, build first, then use the production
upload command (or the version-upload command when that is the intended release
mode):

```sh
npm run build:cloudflare
npm run deploy:cloudflare
# Or: npm run version:cloudflare
```

Both upload commands use the generated Start configuration and preserve
dashboard-managed variables. The following Worker proxy search is therefore a
runtime check that the dashboard-managed `API_URL` survived the upload; it does
not change a direct-note route, browser behavior, or either runtime origin.

```sh
curl --fail-with-body --silent --show-error "$API_ORIGIN/health" \
  | jq -e '.ok == true and (.notes | type == "number") and (.visible_notes | type == "number") and (.content_sha | test("^[a-f0-9]{40}$"))'

SEARCH_JSON="$(curl --fail-with-body --silent --show-error "$WORKER_ORIGIN/api/search?q=smoke")"
NOTE_ID="$(jq -er '.hits[0].id' <<<"$SEARCH_JSON")"
curl --fail-with-body --silent --show-error --output /dev/null \
  "$WORKER_ORIGIN/notes/$NOTE_ID"
```

The health command must validate `ok`, `notes`, and `visible_notes`. The search
response stays in the current shell only, and `NOTE_ID` is derived from its
first live hit rather than being a hard-coded corpus ID. A successful final
request proves the current direct-note route responds through the released
Worker without adding a browser operations surface.

On the VPS, retain `RELOAD_TOKEN` in its ignored `.env` file and run the
activation command without printing the token or a reload response:

```sh
cd ~/cs-patchnotes-archive
CONTENT_SHA="<full-40-character-content-commit-sha>"
export CONTENT_SHA

CONTENT_REVISION_ROOT="$HOME/cs-patchnotes-content-revisions" \
CONTENT_REPOSITORY_DIR="$HOME/cs-patchnotes-content-repo" \
ARCHIVE_API_URL="http://127.0.0.1:3001" \
RELOAD_TOKEN="$(grep '^RELOAD_TOKEN=' .env | cut -d= -f2-)" \
node tools/activate-content.cjs

curl --fail-with-body --silent --show-error "http://127.0.0.1:3001/health" \
  | jq -e '.ok == true and (.notes | type == "number") and (.visible_notes | type == "number") and (.content_sha == env.CONTENT_SHA)'
```

The activation command stops at each boundary in this order: preflight,
candidate preparation, verification, marker publication, reload, and health
confirmation. A confirmed summary includes the requested SHA and corpus counts.
An HTTP reload rejection restores the previous marker. A network error or failed
health confirmation leaves the verified candidate selected but unconfirmed; do
not automatically retry or replace it.

Activation creates `.activation-lock/owner.json` under the revision root. A
second activation refuses a fresh lock. After 30 minutes it may recover a stale
lock only when the recorded PID is confirmed dead on the same host. A live,
missing, malformed, or foreign-host owner record is never removed automatically;
inspect and resolve that lock manually.

If the command exits nonzero, use its named stage and safe output to choose the
manual next action:

| Stage | Manual next action |
| --- | --- |
| `preflight` | Configure the required ignored VPS values, provide a full lowercase SHA, or wait for an existing activation to finish. |
| `candidate` | Inspect the requested commit and its detached candidate. Do not change the active marker. |
| `verification` | Correct or review the candidate. Verification failure leaves the prior marker active. |
| `publication` | Repair revision-root permissions or its current marker before retrying. |
| `reload` | A rejected reload restores the prior marker. An unreachable reload leaves the selected candidate unconfirmed; inspect loopback connectivity and health manually. |
| `health confirmation` | Run the API health check manually. The candidate remains selected but must not be claimed confirmed until `content_sha` matches. |
