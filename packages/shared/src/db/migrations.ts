import type { Database as DatabaseType } from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";

/**
 * The single canonical schema version. A fresh database is initialized directly
 * at this version; there is no migration path from any earlier shape.
 */
export const CANONICAL_SCHEMA_VERSION = 1;

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
  "blocks",
  "media_items",
  "search_fragments",
  "fragment_ancestors",
  "fragment_tags",
] as const;

export type SchemaState = "empty" | "canonical" | "unsupported";

export interface SchemaInspection {
  userVersion: number;
  state: SchemaState;
  tables: string[];
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
  const hasMetadata = tableSet.has("meta");
  const hasCanonical = containsEvery(tableSet, CANONICAL_TABLES);

  let state: SchemaState = "unsupported";
  if (tables.length === 0 && userVersion === 0) {
    state = "empty";
  } else if (userVersion === CANONICAL_SCHEMA_VERSION && hasMetadata && hasCanonical) {
    state = "canonical";
  }

  return { userVersion, state, tables };
}

/** Initialize a genuinely new database directly at the canonical schema. */
export function initializeCanonicalSchema(db: DatabaseType): SchemaInspection {
  const before = inspectSchemaVersion(db);
  if (before.state === "canonical") return before;
  if (before.state !== "empty") {
    throw new Error("Fresh canonical initialization requires an empty database");
  }
  db.transaction(() => {
    db.exec(SCHEMA_SQL);
    db.pragma(`user_version = ${CANONICAL_SCHEMA_VERSION}`);
  })();
  const after = inspectSchemaVersion(db);
  if (after.state !== "canonical") throw new Error("Canonical initialization failed");
  return after;
}
