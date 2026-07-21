/**
 * Prototype relations retained while readers and writers move to the canonical
 * model. They are removed only by the separately guarded finalization step.
 */
export const PROTOTYPE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS updates (
  id          TEXT PRIMARY KEY,
  posted_at   INTEGER NOT NULL,
  title       TEXT NOT NULL,
  url         TEXT,
  feedname    TEXT,
  game        TEXT NOT NULL,
  raw_body    TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL,
  channel     TEXT NOT NULL DEFAULT 'mainline'
);

CREATE TABLE IF NOT EXISTS sections (
  id            TEXT PRIMARY KEY,
  update_id     TEXT NOT NULL REFERENCES updates(id) ON DELETE CASCADE,
  section_index INTEGER NOT NULL,
  header        TEXT,
  UNIQUE(update_id, section_index)
);

CREATE TABLE IF NOT EXISTS lines (
  id                TEXT PRIMARY KEY,
  section_id        TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  update_id         TEXT NOT NULL REFERENCES updates(id) ON DELETE CASCADE,
  line_index        INTEGER NOT NULL,
  text              TEXT NOT NULL,
  game              TEXT NOT NULL,
  subheader         TEXT,
  parent_line_index INTEGER,
  UNIQUE(section_id, line_index)
);

CREATE TABLE IF NOT EXISTS line_tags (
  line_id    TEXT NOT NULL REFERENCES lines(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  category   TEXT,
  entity     TEXT,
  source     TEXT NOT NULL,
  confidence REAL,
  PRIMARY KEY (line_id, kind, category, entity)
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS idx_lines_update ON lines(update_id);
CREATE INDEX IF NOT EXISTS idx_lines_game   ON lines(game);
CREATE INDEX IF NOT EXISTS idx_tags_line    ON line_tags(line_id);
`;

/**
 * Source-neutral canonical relations. Source bodies are immutable revisions;
 * parser selection and derived output have separate ownership and lifecycles.
 */
export const CANONICAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS documents (
  id           TEXT PRIMARY KEY,
  content_kind TEXT NOT NULL CHECK (content_kind IN ('patch_notes', 'release_article', 'announcement')),
  title        TEXT NOT NULL,
  posted_at    INTEGER NOT NULL,
  game         TEXT NOT NULL CHECK (game IN ('csgo', 'cs2')),
  channel      TEXT NOT NULL CHECK (channel IN ('mainline', 'beta', 'workshop', 'prerelease', 'store')),
  parse_status TEXT NOT NULL DEFAULT 'unparsed'
    CHECK (parse_status IN ('unparsed', 'selected', 'parsed', 'partial', 'quarantined', 'failed'))
);

CREATE TABLE IF NOT EXISTS source_records (
  id                           TEXT PRIMARY KEY,
  document_id                  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  source_adapter               TEXT NOT NULL CHECK (length(source_adapter) > 0),
  body_format                  TEXT NOT NULL CHECK (body_format IN ('bbcode', 'plain_text', 'html')),
  pristine_body                TEXT NOT NULL,
  body_sha256                  TEXT NOT NULL CHECK (length(body_sha256) = 64 AND body_sha256 NOT GLOB '*[^0-9a-f]*'),
  fetched_at                   INTEGER NOT NULL,
  supersedes_source_record_id  TEXT,
  UNIQUE(document_id, source_adapter, body_sha256),
  UNIQUE(document_id, source_adapter, id),
  UNIQUE(document_id, id),
  CHECK (supersedes_source_record_id IS NULL OR supersedes_source_record_id <> id),
  FOREIGN KEY (document_id, source_adapter, supersedes_source_record_id)
    REFERENCES source_records(document_id, source_adapter, id)
);

CREATE TRIGGER IF NOT EXISTS source_records_immutable_update
BEFORE UPDATE ON source_records
BEGIN
  SELECT RAISE(ABORT, 'source_records are immutable');
END;

CREATE TRIGGER IF NOT EXISTS source_records_immutable_delete
BEFORE DELETE ON source_records
BEGIN
  SELECT RAISE(ABORT, 'source_records are immutable');
END;

CREATE TABLE IF NOT EXISTS document_source_heads (
  document_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  source_adapter  TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (document_id, source_adapter),
  FOREIGN KEY (document_id, source_adapter, source_record_id)
    REFERENCES source_records(document_id, source_adapter, id)
);

CREATE TABLE IF NOT EXISTS external_identifiers (
  namespace   TEXT NOT NULL CHECK (length(namespace) > 0),
  value       TEXT NOT NULL CHECK (length(value) > 0),
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (namespace, value)
);

CREATE TABLE IF NOT EXISTS source_locators (
  id               TEXT PRIMARY KEY,
  document_id      TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  source_record_id TEXT,
  namespace        TEXT NOT NULL CHECK (length(namespace) > 0),
  locator          TEXT NOT NULL CHECK (length(locator) > 0),
  locator_kind     TEXT NOT NULL CHECK (locator_kind IN ('publisher', 'archive', 'capture')),
  created_at       INTEGER NOT NULL,
  UNIQUE(namespace, locator),
  FOREIGN KEY (document_id, source_record_id) REFERENCES source_records(document_id, id)
);

CREATE TABLE IF NOT EXISTS parser_overrides (
  document_id    TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  source_adapter TEXT NOT NULL,
  parser_key     TEXT NOT NULL CHECK (length(parser_key) > 0),
  reason         TEXT NOT NULL CHECK (length(reason) > 0),
  reviewed_by    TEXT NOT NULL CHECK (length(reviewed_by) > 0),
  reviewed_at    INTEGER NOT NULL,
  PRIMARY KEY (document_id, source_adapter),
  FOREIGN KEY (document_id, source_adapter)
    REFERENCES document_source_heads(document_id, source_adapter)
);

CREATE TABLE IF NOT EXISTS parse_runs (
  id             TEXT PRIMARY KEY,
  started_at     INTEGER NOT NULL,
  completed_at   INTEGER,
  status         TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  attempted_count INTEGER NOT NULL DEFAULT 0 CHECK (attempted_count >= 0),
  selected_count  INTEGER NOT NULL DEFAULT 0 CHECK (selected_count >= 0),
  unchanged_count INTEGER NOT NULL DEFAULT 0 CHECK (unchanged_count >= 0),
  partial_count   INTEGER NOT NULL DEFAULT 0 CHECK (partial_count >= 0),
  quarantined_count INTEGER NOT NULL DEFAULT 0 CHECK (quarantined_count >= 0),
  error_count     INTEGER NOT NULL DEFAULT 0 CHECK (error_count >= 0)
);

CREATE TABLE IF NOT EXISTS document_parse_state (
  document_id             TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  source_adapter          TEXT NOT NULL,
  source_record_id        TEXT NOT NULL,
  selection_state         TEXT NOT NULL
    CHECK (selection_state IN ('unselected', 'selected', 'quarantined_zero_match', 'quarantined_multiple_match')),
  parser_key              TEXT,
  parser_version          TEXT,
  detector_evidence_json  TEXT,
  grouping_policy_version TEXT,
  materialization_status  TEXT NOT NULL DEFAULT 'unparsed'
    CHECK (materialization_status IN ('unparsed', 'complete', 'partial', 'failed')),
  output_sha256           TEXT CHECK (output_sha256 IS NULL OR length(output_sha256) = 64),
  last_parse_run_id       TEXT REFERENCES parse_runs(id),
  updated_at              INTEGER NOT NULL,
  PRIMARY KEY (document_id, source_adapter),
  FOREIGN KEY (document_id, source_adapter, source_record_id)
    REFERENCES source_records(document_id, source_adapter, id),
  CHECK (
    (selection_state = 'selected' AND parser_key IS NOT NULL AND parser_version IS NOT NULL)
    OR (selection_state <> 'selected' AND parser_key IS NULL AND parser_version IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS parse_diagnostics (
  id               TEXT PRIMARY KEY,
  parse_run_id     TEXT NOT NULL REFERENCES parse_runs(id) ON DELETE CASCADE,
  document_id      TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  source_record_id TEXT NOT NULL,
  severity         TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  code             TEXT NOT NULL CHECK (length(code) > 0),
  source_start     INTEGER CHECK (source_start IS NULL OR source_start >= 0),
  source_end       INTEGER CHECK (source_end IS NULL OR source_end >= source_start),
  details_json     TEXT,
  created_at       INTEGER NOT NULL,
  FOREIGN KEY (document_id, source_record_id) REFERENCES source_records(document_id, id)
);

CREATE TABLE IF NOT EXISTS canonical_cutover_audits (
  id                       TEXT PRIMARY KEY,
  manifest_digest          TEXT NOT NULL CHECK (length(manifest_digest) = 64),
  source_head_digest       TEXT NOT NULL CHECK (length(source_head_digest) = 64),
  successful_parse_run_id  TEXT NOT NULL REFERENCES parse_runs(id),
  noop_parse_run_id        TEXT NOT NULL REFERENCES parse_runs(id),
  backup_path              TEXT NOT NULL CHECK (length(backup_path) > 0),
  backup_sha256            TEXT NOT NULL CHECK (length(backup_sha256) = 64),
  recorded_at              INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS blocks (
  id               TEXT PRIMARY KEY,
  document_id      TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  parent_block_id  TEXT,
  kind             TEXT NOT NULL
    CHECK (kind IN ('heading', 'paragraph', 'list', 'list_item', 'patch_change', 'media_group', 'unsupported')),
  preorder         INTEGER NOT NULL CHECK (preorder >= 0),
  sibling_order    INTEGER NOT NULL CHECK (sibling_order >= 0),
  text             TEXT,
  label            TEXT,
  source_start     INTEGER CHECK (source_start IS NULL OR source_start >= 0),
  source_end       INTEGER CHECK (source_end IS NULL OR source_end >= source_start),
  source_node_type TEXT,
  diagnostic_code  TEXT,
  UNIQUE(document_id, preorder),
  UNIQUE(document_id, id),
  FOREIGN KEY (document_id, parent_block_id) REFERENCES blocks(document_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_root_sibling_order
  ON blocks(document_id, sibling_order) WHERE parent_block_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_child_sibling_order
  ON blocks(document_id, parent_block_id, sibling_order) WHERE parent_block_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS blocks_validate_hierarchy
BEFORE INSERT ON blocks
BEGIN
  SELECT CASE
    WHEN NEW.parent_block_id IS NULL AND NEW.kind = 'list_item'
      THEN RAISE(ABORT, 'list_item requires a list parent')
    WHEN NEW.parent_block_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM blocks parent
      WHERE parent.id = NEW.parent_block_id
        AND parent.document_id = NEW.document_id
        AND (
          (parent.kind = 'heading' AND NEW.kind IN ('heading', 'paragraph', 'list', 'patch_change', 'media_group', 'unsupported'))
          OR (parent.kind = 'list' AND NEW.kind IN ('list_item', 'patch_change'))
          OR (parent.kind IN ('list_item', 'patch_change') AND NEW.kind = 'list')
        )
    ) THEN RAISE(ABORT, 'invalid canonical block hierarchy')
  END;
END;

CREATE TRIGGER IF NOT EXISTS blocks_validate_hierarchy_update
BEFORE UPDATE OF document_id, parent_block_id, kind ON blocks
BEGIN
  SELECT CASE
    WHEN NEW.parent_block_id IS NULL AND NEW.kind = 'list_item'
      THEN RAISE(ABORT, 'list_item requires a list parent')
    WHEN NEW.parent_block_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM blocks parent
      WHERE parent.id = NEW.parent_block_id
        AND parent.document_id = NEW.document_id
        AND (
          (parent.kind = 'heading' AND NEW.kind IN ('heading', 'paragraph', 'list', 'patch_change', 'media_group', 'unsupported'))
          OR (parent.kind = 'list' AND NEW.kind IN ('list_item', 'patch_change'))
          OR (parent.kind IN ('list_item', 'patch_change') AND NEW.kind = 'list')
        )
    ) THEN RAISE(ABORT, 'invalid canonical block hierarchy')
    WHEN EXISTS (
      SELECT 1 FROM blocks child
      WHERE child.parent_block_id = OLD.id
        AND child.document_id = OLD.document_id
        AND NOT (
          (NEW.kind = 'heading' AND child.kind IN ('heading', 'paragraph', 'list', 'patch_change', 'media_group', 'unsupported'))
          OR (NEW.kind = 'list' AND child.kind IN ('list_item', 'patch_change'))
          OR (NEW.kind IN ('list_item', 'patch_change') AND child.kind = 'list')
        )
    ) THEN RAISE(ABORT, 'canonical parent kind cannot own existing children')
  END;
END;

CREATE TABLE IF NOT EXISTS media_items (
  id                TEXT PRIMARY KEY,
  document_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  group_block_id    TEXT NOT NULL,
  item_order        INTEGER NOT NULL CHECK (item_order >= 0),
  media_kind        TEXT NOT NULL CHECK (media_kind IN ('image', 'video', 'audio', 'embed')),
  original_locator  TEXT NOT NULL CHECK (length(original_locator) > 0),
  archive_locator   TEXT,
  caption           TEXT,
  alt_text          TEXT,
  provenance_json   TEXT,
  UNIQUE(group_block_id, item_order),
  UNIQUE(document_id, group_block_id, id),
  FOREIGN KEY (document_id, group_block_id) REFERENCES blocks(document_id, id)
);

CREATE TRIGGER IF NOT EXISTS media_items_require_group
BEFORE INSERT ON media_items
WHEN NOT EXISTS (
  SELECT 1 FROM blocks
   WHERE id = NEW.group_block_id
     AND document_id = NEW.document_id
     AND kind = 'media_group'
)
BEGIN
  SELECT RAISE(ABORT, 'media item owner must be a media_group');
END;

CREATE TRIGGER IF NOT EXISTS media_items_require_group_update
BEFORE UPDATE OF document_id, group_block_id ON media_items
WHEN NOT EXISTS (
  SELECT 1 FROM blocks
   WHERE id = NEW.group_block_id
     AND document_id = NEW.document_id
     AND kind = 'media_group'
)
BEGIN
  SELECT RAISE(ABORT, 'media item owner must be a media_group');
END;

CREATE TABLE IF NOT EXISTS search_fragments (
  id                    TEXT PRIMARY KEY,
  document_id           TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  block_id               TEXT NOT NULL,
  media_item_id          TEXT,
  fragment_order         INTEGER NOT NULL CHECK (fragment_order >= 0),
  fragment_kind          TEXT NOT NULL CHECK (fragment_kind IN ('block_text', 'media_caption')),
  text                   TEXT NOT NULL CHECK (length(text) > 0),
  text_sha256            TEXT NOT NULL CHECK (length(text_sha256) = 64 AND text_sha256 NOT GLOB '*[^0-9a-f]*'),
  group_anchor_block_id  TEXT,
  UNIQUE(document_id, fragment_order),
  UNIQUE(document_id, id),
  FOREIGN KEY (document_id, block_id) REFERENCES blocks(document_id, id),
  FOREIGN KEY (document_id, group_anchor_block_id) REFERENCES blocks(document_id, id),
  FOREIGN KEY (document_id, block_id, media_item_id)
    REFERENCES media_items(document_id, group_block_id, id),
  CHECK (
    (fragment_kind = 'block_text' AND media_item_id IS NULL)
    OR (fragment_kind = 'media_caption' AND media_item_id IS NOT NULL)
  )
);

CREATE TRIGGER IF NOT EXISTS search_fragments_validate_eligibility
BEFORE INSERT ON search_fragments
BEGIN
  SELECT CASE
    WHEN NEW.fragment_kind = 'block_text' AND NOT EXISTS (
      SELECT 1 FROM blocks
       WHERE id = NEW.block_id
         AND document_id = NEW.document_id
         AND kind IN ('heading', 'paragraph', 'list_item', 'patch_change')
    ) THEN RAISE(ABORT, 'block kind is not searchable')
    WHEN NEW.fragment_kind = 'media_caption' AND NOT EXISTS (
      SELECT 1 FROM media_items
       WHERE id = NEW.media_item_id
         AND document_id = NEW.document_id
         AND group_block_id = NEW.block_id
         AND caption IS NOT NULL
         AND caption = NEW.text
    ) THEN RAISE(ABORT, 'media fragment must use its visible caption')
  END;
END;

CREATE TRIGGER IF NOT EXISTS search_fragments_validate_eligibility_update
BEFORE UPDATE OF document_id, block_id, media_item_id, fragment_kind, text ON search_fragments
BEGIN
  SELECT CASE
    WHEN NEW.fragment_kind = 'block_text' AND NOT EXISTS (
      SELECT 1 FROM blocks
       WHERE id = NEW.block_id
         AND document_id = NEW.document_id
         AND kind IN ('heading', 'paragraph', 'list_item', 'patch_change')
    ) THEN RAISE(ABORT, 'block kind is not searchable')
    WHEN NEW.fragment_kind = 'media_caption' AND NOT EXISTS (
      SELECT 1 FROM media_items
       WHERE id = NEW.media_item_id
         AND document_id = NEW.document_id
         AND group_block_id = NEW.block_id
         AND caption IS NOT NULL
         AND caption = NEW.text
    ) THEN RAISE(ABORT, 'media fragment must use its visible caption')
  END;
END;

CREATE TABLE IF NOT EXISTS fragment_ancestors (
  fragment_id       TEXT NOT NULL,
  document_id       TEXT NOT NULL,
  depth             INTEGER NOT NULL CHECK (depth >= 0),
  ancestor_block_id TEXT NOT NULL,
  label             TEXT NOT NULL,
  PRIMARY KEY (fragment_id, depth),
  FOREIGN KEY (document_id, fragment_id) REFERENCES search_fragments(document_id, id) ON DELETE CASCADE,
  FOREIGN KEY (document_id, ancestor_block_id) REFERENCES blocks(document_id, id)
);

CREATE TABLE IF NOT EXISTS fragment_tags (
  fragment_id TEXT NOT NULL REFERENCES search_fragments(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('category', 'entity')),
  value       TEXT NOT NULL CHECK (length(value) > 0),
  source      TEXT NOT NULL CHECK (length(source) > 0),
  confidence  REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  PRIMARY KEY (fragment_id, kind, value)
);

CREATE INDEX IF NOT EXISTS idx_source_records_document ON source_records(document_id, source_adapter);
CREATE INDEX IF NOT EXISTS idx_external_identifiers_document ON external_identifiers(document_id);
CREATE INDEX IF NOT EXISTS idx_source_locators_document ON source_locators(document_id);
CREATE INDEX IF NOT EXISTS idx_blocks_document_preorder ON blocks(document_id, preorder);
CREATE INDEX IF NOT EXISTS idx_media_group_order ON media_items(group_block_id, item_order);
CREATE INDEX IF NOT EXISTS idx_fragments_document_order ON search_fragments(document_id, fragment_order);
CREATE INDEX IF NOT EXISTS idx_fragment_ancestors_block ON fragment_ancestors(ancestor_block_id);
`;

/** Fresh databases deliberately contain both models during the transition. */
export const SCHEMA_SQL = `${PROTOTYPE_SCHEMA_SQL}\n${CANONICAL_SCHEMA_SQL}`;
