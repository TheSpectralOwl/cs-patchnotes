# Archive Read API

The API reads the detached content worktree named by the revision root's active
marker and builds a disposable in-memory index. It has no database or
search-engine dependency.

## Runtime

```sh
CONTENT_REVISION_ROOT=/srv/cs-patchnotes-content-revisions \
RELOAD_TOKEN="${RELOAD_TOKEN:?set a random RELOAD_TOKEN}" \
PORT=3001 \
npm run start -w @cs-patchnotes/archive-api
```

The containerized equivalent mounts the revision root read-only at
`/content-revisions` and sets `CONTENT_REVISION_ROOT=/content-revisions`. Its
`active` file contains exactly one lowercase, 40-character Git SHA and selects
`worktrees/<sha>`.

Endpoints:

- `GET /health` (includes the loaded `content_sha`)
- `GET /api/search?q=&game=&from=&to=`
- `GET /api/notes/:id`
- `POST /internal/reload` with `Authorization: Bearer <RELOAD_TOKEN>` and JSON
  body `{ "sha": "<full-content-git-sha>" }`

`/internal/reload` accepts only the full SHA currently named by `active`. It
loads and validates a complete replacement index before it becomes visible to
readers. If validation fails, the current index remains live.

## Content activation

Keep a normal content Git repository separate from the revision root. The
host-side activation command fetches one reviewed commit, creates or reuses its
detached candidate, verifies it, atomically publishes the marker, and calls the
SHA-bound reload. The content repository contains no deployment code.

`tools/activate-content.cjs` implements that sequence. Run it where the content
Git repository and revision root are writable and the loopback API is reachable:

```sh
CONTENT_SHA=<full-40-character-content-commit-sha> \
CONTENT_REVISION_ROOT=/srv/cs-patchnotes-content-revisions \
CONTENT_REPOSITORY_DIR=/srv/cs-patchnotes-content-repo \
ARCHIVE_API_URL=http://127.0.0.1:3001 \
RELOAD_TOKEN="${RELOAD_TOKEN:?set RELOAD_TOKEN}" \
node tools/activate-content.cjs
```

Activation serializes itself with a local owner-record lock. It refuses another
active process and only recovers a lock older than 30 minutes after confirming
that its same-host owner PID is no longer alive. Other stale records require
manual inspection rather than automatic removal.
