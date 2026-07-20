/**
 * The full SQLite schema for the patch-notes source of truth.
 *
 * SQLite is the single source of truth; the Meilisearch index is a disposable
 * cache rebuildable from these tables. Every statement is idempotent
 * (`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`) so `openDb()`
 * can apply this on every start without error and re-runs never duplicate state.
 *
 * The DDL is inlined as a template-literal constant rather than a separate
 * `.sql` asset: `tsc` does not copy `.sql` files into `dist/`, so shipping the
 * schema as a string sidesteps the dist-copy / `import.meta.url` resolution
 * trap entirely.
 *
 * Structural contract (never derive an ID from text):
 *   update.id  = Steam gid
 *   section.id = `${update_id}_${section_index}`
 *   line.id    = `${section_id}_${line_index}`
 *
 * `raw_body` holds the pristine Steam `contents` verbatim so the corpus can be
 * re-parsed without re-fetching. Classification/tagging is a separate,
 * re-runnable pass — tags live in `line_tags`, never baked into ingestion.
 */
export const SCHEMA_SQL = `
-- One row per Steam post that is a real patch note.
CREATE TABLE IF NOT EXISTS updates (
  id          TEXT PRIMARY KEY,   -- Steam gid (stable, Valve-assigned)
  posted_at   INTEGER NOT NULL,   -- unix epoch (from Steam \`date\`)
  title       TEXT NOT NULL,
  url         TEXT,               -- Steam permalink
  feedname    TEXT,               -- for filter/audit
  game        TEXT NOT NULL,      -- 'csgo' | 'cs2' derived from posted_at
  raw_body    TEXT NOT NULL,      -- ORIGINAL body, untouched (enables re-parse)
  fetched_at  INTEGER NOT NULL,
  channel     TEXT NOT NULL DEFAULT 'mainline'  -- mainline|beta|workshop|prerelease|store
);

-- Sections = the [ HEADER ] splits within an update.
CREATE TABLE IF NOT EXISTS sections (
  id            TEXT PRIMARY KEY,   -- '{update_id}_{section_index}'
  update_id     TEXT NOT NULL REFERENCES updates(id) ON DELETE CASCADE,
  section_index INTEGER NOT NULL,
  header        TEXT,               -- e.g. 'MAPS' (null = pre-header/untitled)
  UNIQUE(update_id, section_index)
);

-- Lines = individual note lines within a section. PRISTINE — no tags here.
CREATE TABLE IF NOT EXISTS lines (
  id          TEXT PRIMARY KEY,   -- '{section_id}_{line_index}'
  section_id  TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  update_id   TEXT NOT NULL REFERENCES updates(id) ON DELETE CASCADE,  -- denorm for query speed
  line_index  INTEGER NOT NULL,
  text        TEXT NOT NULL,      -- cleaned note text
  game        TEXT NOT NULL,      -- denorm from update for filtering
  UNIQUE(section_id, line_index)
);

-- Tags = SEPARATE re-runnable classification output. Keyed by line.
-- Stays empty this phase (separation of passes); populated by a later pass.
CREATE TABLE IF NOT EXISTS line_tags (
  line_id    TEXT NOT NULL REFERENCES lines(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,        -- 'category' | 'entity'
  category   TEXT,                 -- fixed taxonomy value (when kind='category')
  entity     TEXT,                 -- weapon/map name (when kind='entity')
  source     TEXT NOT NULL,        -- 'rules' | 'haiku' (provenance/audit)
  confidence REAL,                 -- optional, from model
  PRIMARY KEY (line_id, kind, category, entity)
);

-- Pipeline bookkeeping (cursors, last-run, index version).
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS idx_lines_update ON lines(update_id);
CREATE INDEX IF NOT EXISTS idx_lines_game   ON lines(game);
CREATE INDEX IF NOT EXISTS idx_tags_line    ON line_tags(line_id);
`;
