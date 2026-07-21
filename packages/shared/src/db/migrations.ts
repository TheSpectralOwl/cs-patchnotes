import type { Database as DatabaseType } from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { CANONICAL_SCHEMA_SQL, SCHEMA_SQL } from "./schema.js";

export const LATEST_SCHEMA_VERSION = 1;

const PROTOTYPE_TABLES = ["updates", "sections", "lines", "line_tags", "meta"] as const;
const CANONICAL_TABLES = [
  "documents",
  "source_records",
  "document_source_heads",
  "external_identifiers",
  "source_locators",
  "parser_overrides",
  "document_parse_state",
  "parse_runs",
  "parse_diagnostics",
  "canonical_cutover_audits",
  "blocks",
  "media_items",
  "search_fragments",
  "fragment_ancestors",
  "fragment_tags",
] as const;

export type SchemaState = "empty" | "legacy" | "transitional" | "unsupported";

export interface SchemaInspection {
  userVersion: number;
  state: SchemaState;
  tables: string[];
}

interface LegacyUpdate {
  id: string;
  posted_at: number;
  title: string;
  url: string | null;
  game: "csgo" | "cs2";
  raw_body: string;
  fetched_at: number;
  channel: "mainline" | "beta" | "workshop" | "prerelease" | "store";
}

function tableNames(db: DatabaseType): string[] {
  return db
    .prepare(
      `SELECT name
         FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    )
    .all()
    .map((row) => (row as { name: string }).name);
}

function containsEvery(tables: ReadonlySet<string>, required: readonly string[]): boolean {
  return required.every((name) => tables.has(name));
}

export function inspectSchemaVersion(db: DatabaseType): SchemaInspection {
  const tables = tableNames(db);
  const tableSet = new Set(tables);
  const userVersion = db.pragma("user_version", { simple: true }) as number;

  let state: SchemaState = "unsupported";
  if (tables.length === 0 && userVersion === 0) {
    state = "empty";
  } else if (
    userVersion === 0 &&
    containsEvery(tableSet, PROTOTYPE_TABLES) &&
    !CANONICAL_TABLES.some((name) => tableSet.has(name))
  ) {
    state = "legacy";
  } else if (
    userVersion === LATEST_SCHEMA_VERSION &&
    containsEvery(tableSet, PROTOTYPE_TABLES) &&
    containsEvery(tableSet, CANONICAL_TABLES)
  ) {
    state = "transitional";
  }

  return { userVersion, state, tables };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function detectLegacyBodyFormat(body: string): "bbcode" | "plain_text" {
  return /\[\/?(?:p|list|\*|h[1-6]|img|url|b|i|u)\b|\{STEAM_CLAN_IMAGE\}/i.test(body)
    ? "bbcode"
    : "plain_text";
}

function migrateLegacyUpdates(db: DatabaseType): void {
  const updates = db.prepare("SELECT * FROM updates ORDER BY id").all() as LegacyUpdate[];
  const insertDocument = db.prepare(
    `INSERT INTO documents
       (id, content_kind, title, posted_at, game, channel, parse_status)
     VALUES (@id, 'patch_notes', @title, @posted_at, @game, @channel, 'unparsed')`,
  );
  const insertSource = db.prepare(
    `INSERT INTO source_records
       (id, document_id, source_adapter, body_format, pristine_body, body_sha256, fetched_at)
     VALUES (@id, @document_id, 'steam_news', @body_format, @pristine_body, @body_sha256, @fetched_at)`,
  );
  const insertHead = db.prepare(
    `INSERT INTO document_source_heads
       (document_id, source_adapter, source_record_id, updated_at)
     VALUES (?, 'steam_news', ?, ?)`,
  );
  const insertIdentifier = db.prepare(
    `INSERT INTO external_identifiers (namespace, value, document_id, created_at)
     VALUES ('steam_news_gid', ?, ?, ?)`,
  );
  const insertLocator = db.prepare(
    `INSERT INTO source_locators
       (id, document_id, source_record_id, namespace, locator, locator_kind, created_at)
     VALUES (?, ?, ?, 'steam_news_url', ?, 'publisher', ?)`,
  );

  for (const update of updates) {
    const documentId = randomUUID();
    const sourceRecordId = randomUUID();
    insertDocument.run({
      id: documentId,
      title: update.title,
      posted_at: update.posted_at,
      game: update.game,
      channel: update.channel,
    });
    insertSource.run({
      id: sourceRecordId,
      document_id: documentId,
      body_format: detectLegacyBodyFormat(update.raw_body),
      pristine_body: update.raw_body,
      body_sha256: sha256(update.raw_body),
      fetched_at: update.fetched_at,
    });
    insertHead.run(documentId, sourceRecordId, update.fetched_at);
    insertIdentifier.run(update.id, documentId, update.fetched_at);
    if (update.url !== null && update.url.length > 0) {
      insertLocator.run(randomUUID(), documentId, sourceRecordId, update.url, update.fetched_at);
    }
  }
}

/**
 * Advance an empty or prototype database to the additive transitional schema.
 * The version is written last inside the same synchronous transaction.
 */
export function runMigrations(db: DatabaseType): SchemaInspection {
  const before = inspectSchemaVersion(db);
  if (before.state === "transitional") return before;
  if (before.state === "unsupported") {
    throw new Error(`Unsupported SQLite schema version ${before.userVersion}`);
  }

  const migrate = db.transaction(() => {
    if (before.state === "empty") {
      db.exec(SCHEMA_SQL);
    } else {
      db.exec(CANONICAL_SCHEMA_SQL);
      migrateLegacyUpdates(db);
    }
    db.pragma(`user_version = ${LATEST_SCHEMA_VERSION}`);
  });
  migrate();

  const after = inspectSchemaVersion(db);
  if (after.state !== "transitional") {
    throw new Error("SQLite migration did not produce the transitional schema");
  }
  return after;
}
