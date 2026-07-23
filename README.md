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

# Query the local index.
node pipeline/search.cjs query "smoke" --game cs2 --from 2024-01-01

# Verify corpus provenance, coverage, and conversion residue.
node pipeline/audit.cjs
```

The index and audit report are written under `.cache/` and are never committed.
The audit intentionally reports duplicate raw captures and same-day title
collisions without modifying them: raw records preserve source evidence, while
any deduplication is a reader/search presentation decision.
