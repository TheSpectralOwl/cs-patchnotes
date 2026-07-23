# Archive Read API

The API reads `CONTENT_DIR/content/notes/*.md` directly and builds a disposable
in-memory index. It has no database or search-engine dependency.

## Runtime

```sh
CONTENT_DIR=/srv/cs-patchnotes-content \
RELOAD_TOKEN="${RELOAD_TOKEN:?set a random RELOAD_TOKEN}" \
PORT=3001 \
npm run start -w @cs-patchnotes/archive-api
```

The containerized equivalent mounts the content checkout read-only at `/content`
and sets `CONTENT_DIR=/content`.

Endpoints:

- `GET /health`
- `GET /api/search?q=&game=&from=&to=`
- `GET /api/notes/:id`
- `POST /internal/reload` with `Authorization: Bearer <RELOAD_TOKEN>`

`/internal/reload` loads and validates a complete replacement index before it
becomes visible to readers. If validation fails, the current index remains live.

## Content refresh

Keep a normal clone of `cs-patchnotes-content` at `CONTENT_DIR`. A host-side
refresh job or authenticated webhook handler must pull a reviewed content commit,
run `npm run verify:corpus` with that checkout, then call `/internal/reload`.
The content repository contains no deployment code.

`tools/refresh-archive-api.cjs` implements that host-side sequence with a
fast-forward-only pull. Run it where the content checkout is writable and the
API is reachable:

```sh
CONTENT_DIR=/srv/cs-patchnotes-content \
ARCHIVE_API_URL=http://127.0.0.1:3001 \
RELOAD_TOKEN="${RELOAD_TOKEN:?set RELOAD_TOKEN}" \
node tools/refresh-archive-api.cjs
```
