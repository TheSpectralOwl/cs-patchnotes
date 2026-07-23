# Archive VPS Deployment

The archive API runs independently from the legacy stack. It reads a read-only
checkout of `cs-patchnotes-content` and has no SQLite or Meilisearch volume.

## One-time VPS setup

1. Keep the current `~/cs-patchnotes` deployment and its compose stack intact.
   The new stack uses `~/cs-patchnotes-archive`, so rollback remains possible.
2. Create `~/cs-patchnotes-archive/.env` with the existing `TUNNEL_TOKEN` and a
   new, high-entropy `RELOAD_TOKEN`.
3. In the Cloudflare Tunnel's remote ingress configuration, point the archive API
   hostname at `http://archive-api:3001`. Stop the legacy `cloudflared` service
   before starting the new one; a tunnel has only one active connector target.
4. Set the TanStack Start Worker's runtime `API_URL` variable to that public API
   hostname.
5. Trigger the `Deploy Archive API` GitHub workflow from `markdown-notes-rebuild`.

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
