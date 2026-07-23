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
