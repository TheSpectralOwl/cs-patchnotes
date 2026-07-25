# Archive VPS Deployment

The archive API reads a read-only checkout of `cs-patchnotes-content` and has no
database or search-index volume.

## One-time VPS setup

1. Create `~/cs-patchnotes-archive/.env` with the existing `TUNNEL_TOKEN` and a
   new, high-entropy `RELOAD_TOKEN`.
2. In the Cloudflare Tunnel's remote ingress configuration, point the archive API
   hostname at `http://archive-api:3001`.
3. Set the TanStack Start Worker's runtime `API_URL` variable to that public API
   hostname.
4. Trigger the `Deploy Archive API` GitHub workflow from `main`.

The workflow creates or updates two separate checkouts:

```text
~/cs-patchnotes-archive          # code and archive compose stack
~/cs-patchnotes-content          # source corpus
```

## Content refresh

After a reviewed content commit reaches `main`, run this on the VPS or invoke it
from an authenticated external webhook bridge:

```sh
cd ~/cs-patchnotes-archive
CONTENT_DIR="$HOME/cs-patchnotes-content" \
ARCHIVE_API_URL="http://127.0.0.1:3001" \
RELOAD_TOKEN="$(grep '^RELOAD_TOKEN=' .env | cut -d= -f2-)" \
node tools/refresh-archive-api.cjs
```

The command fast-forward pulls the content checkout, verifies the complete
corpus, and asks the API to atomically reload. It does not rebuild or deploy the
Cloudflare Worker.

## Release and refresh acceptance

Run these checks from an authorized environment after a Worker upload or a VPS
content refresh. Supply the real public origins only in the current shell; do
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
  | jq -e '.ok == true and (.notes | type == "number") and (.visible_notes | type == "number")'

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

On the VPS, retain `RELOAD_TOKEN` in its ignored `.env` file and run the refresh
command without printing the token or a reload response:

```sh
cd ~/cs-patchnotes-archive
CONTENT_DIR="$HOME/cs-patchnotes-content" \
ARCHIVE_API_URL="http://127.0.0.1:3001" \
RELOAD_TOKEN="$(grep '^RELOAD_TOKEN=' .env | cut -d= -f2-)" \
node tools/refresh-archive-api.cjs

curl --fail-with-body --silent --show-error "http://127.0.0.1:3001/health" \
  | jq -e '.ok == true and (.notes | type == "number") and (.visible_notes | type == "number")'
```

The refresh command stops at each boundary in this order: preflight, Git
fast-forward, verification, baseline health, reload, and health confirmation.
A confirmed terminal summary includes the checked-out revision, successful
verification, and before/after `notes` and `visible_notes` counts. Count
changes are evidence, not a new release gate. Keep routine evidence in terminal
output or the deployment record; this procedure creates no persistent log,
monitoring surface, dashboard, automatic retry, reset, or rollback.

If the command exits nonzero, use its named stage and safe output to choose the
manual next action:

| Stage | Manual next action |
| --- | --- |
| `preflight` | Configure the required VPS values in ignored configuration, or resolve the dirty content checkout before rerunning manually. |
| `Git fast-forward` | Reconcile the content checkout history manually; do not reset it automatically. |
| `verification` | Inspect the candidate checkout at its current revision, correct or review the failure, then rerun manually. Verification failure leaves that candidate checkout available for inspection and does not reload the API. |
| `reload` | Check private API connectivity and reload authorization manually. A rejected or unreachable reload leaves the prior in-memory index active; do not retry automatically. |
| `health confirmation` | Run the API health check manually before further operation. A failed confirmation leaves the refresh unconfirmed; do not claim success or attempt another index swap automatically. |
