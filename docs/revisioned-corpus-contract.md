# Revisioned Corpus Contract

This is the layout consumed by the archive API and the corpus pipeline.

## Identity And Evidence

- A Steam announcement is identified by its decimal `gid`.
- Each captured raw JSON byte sequence is immutable evidence. Its revision ID is
  the lowercase SHA-256 of those exact file bytes, not of parsed or reformatted
  JSON.
- Raw evidence is stored at `raw/steam/<gid>/<revision>.json`. Its `index.json`
  lists every revision and names exactly one `latest_revision`.
- The public note ID is the legacy Markdown filename, stored as
  `content/notes/<gid>/index.json#note_id`. It is stable after migration and is
  never recomputed from later source metadata.

## Presentation Selection

- Markdown associated with a source revision is stored at
  `content/notes/<gid>/<revision>.md`; the revision is the raw evidence
  revision, not a Markdown hash.
- The selected source is the raw manifest's `latest_revision`.
- An explicit override takes precedence over generated Markdown for its GID,
  even when later source revisions are captured. The note manifest records the
  immutable source evidence it cites in `override_revision`.
- Removing the override deliberately returns presentation to the selected
  source revision's generated Markdown.
- During legacy migration, an eligible override remains byte-for-byte at
  `overrides/<gid>.md`; its note manifest records the matching raw revision in
  `override_revision`. The migration refuses an override whose provenance is
  incomplete or points at another source revision.
- Historical revisions are evidence only. They remain available for inspection,
  but neither conversion nor verification may regenerate, normalize, or replace
  their Markdown.
- A migrated legacy Markdown file is copied byte-for-byte and marked by
  `legacy_migration_revisions`; that marker is the sole compatibility exception
  for its missing `source_revision` frontmatter.

## Layout And Activation

Each `index.json` is a deterministic manifest. A raw manifest contains `gid`,
`revisions`, and `latest_revision`. A note manifest additionally contains
`note_id`, `legacy_filename`, and optionally `override_revision` and
`legacy_migration_revisions`. Revision filenames and all manifest references
must use lowercase 64-character SHA-256 values.

Activation selects a candidate content checkout by one exact, full 40-character
lowercase Git commit SHA. This activation SHA is distinct from a 64-character
raw-evidence revision ID. It must verify that exact checkout before atomically
publishing the selection marker. Short SHAs, branch names, tags, and a SHA
resolved after verification are invalid. A failed verification or publish leaves
the previous selection active.

The revision root contains a regular `active` file with that SHA and a detached
checkout at `worktrees/<sha>`. The marker is published by an atomic rename; the
container mounts the revision root read-only. API reload requests must carry the
same full SHA and health reports the SHA of the in-memory corpus as
`content_sha`.

Activation serializes marker publication with a local `.activation-lock` owner
record. Locks are not reclaimed while fresh or while their same-host owner PID
is alive. A dead owner may be recovered after the fixed 30-minute stale interval;
missing, malformed, and foreign-host records require manual inspection.
