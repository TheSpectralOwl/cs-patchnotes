# CS Patch Notes Archive

## Active Architecture

The Markdown rebuild is the authoritative implementation. Do not restore the
retired SQLite, Meilisearch, canonical-document, parser-registry, or polling
architecture.

- `../cs-patchnotes-content` is the source of truth. It contains immutable Steam
  captures in `raw/steam/` and hand-editable Markdown in `content/notes/`.
- Root `pipeline/` converts, audits, verifies, and updates that content. It must
  remain deterministic and preserve provenance/regen safety.
- `packages/archive/` is the TanStack Start Cloudflare Worker frontend.
- `packages/archive-api/` reads Markdown from `CONTENT_DIR`, builds the in-memory
  search index, and reloads it atomically through its private endpoint.
- `docker-compose.archive.yml` is the production VPS stack. It has no database
  or external search service.

The corpus deliberately preserves duplicate raw captures as source evidence.
The archive API suppresses exact duplicate bodies only in presentation/search
results. Unsupported data such as categories, entities, media, release articles,
and relationships must not be invented from the current Markdown corpus.

## Working Rules

- Keep `main` merge-via-PR only. Work happens on feature branches.
- Keep `.planning/` untracked. Do not reference planning-cycle identifiers in
  committed code, configuration, documentation, commits, PRs, or issues.
- Describe technical rationale directly rather than referring to planning
  artifacts. Planning is ephemeral; repository behavior is not.
- Keep secrets only in git-ignored environment files or GitHub secrets. The
  committed `.env.example` documents names with empty values only.
- Before committing, verify staged files do not contain planning references:

  ```sh
  git diff --cached --name-only | grep -v '^\.planning/' | xargs -r grep -inE '\bphase [0-9]|\bD-[0-9]{2}\b|\b(OPS|REQ)-[0-9]{2}\b|\bPitfall [0-9]+\b'
  ```

## Validation

Run the checks relevant to an archive change:

```sh
npm run check:infra
npm run test:pipeline
npm run check -w @cs-patchnotes/archive
npm run build -w @cs-patchnotes/archive-api
npm test -w @cs-patchnotes/archive-api
npm run build:cloudflare
```
