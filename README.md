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

# Build the disposable Markdown-derived search index.
node pipeline/search.cjs build

# Build the static reader site in .cache/reader/.
node pipeline/build-reader.cjs

# Build the production archive app in packages/archive/dist/.
npm run build:archive

# Query the local index.
node pipeline/search.cjs query "smoke" --game cs2 --from 2024-01-01

# Verify corpus provenance, coverage, and conversion residue.
node pipeline/audit.cjs

# Verify a content checkout in an isolated copy without changing it.
node pipeline/verify.cjs

# Fetch current Steam records, add only unseen raw captures, then convert and rebuild indexes.
node pipeline/update-steam.cjs
```

The index and audit report are written under `.cache/` and are never committed.
The audit intentionally reports duplicate raw captures and same-day title
collisions without modifying them: raw records preserve source evidence, while
any deduplication is a reader/search presentation decision.

`update:steam` never commits or pushes either repository. Review and commit any
new raw captures and converted notes in the content repository after a successful
run.

## Continuous integration

`corpus.yml` checks the pipeline tests and archive application type-check on every
push and pull request. It also provides a manual corpus-build workflow. After the
content repository has a remote, run that workflow with its `owner/repository`
and ref inputs. A private content repository requires `CONTENT_REPO_TOKEN` with
read access to that repository.

The archive app includes a Cloudflare Pages `_redirects` fallback for direct
`/notes/<filename>` links. Any other static host must provide the equivalent
SPA fallback before publishing the app.
