import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { inspectSchemaVersion, initializeCanonicalSchema } from "./migrations.js";

/**
 * Open (or create) the source-of-truth SQLite database and return a live,
 * configured handle.
 *
 * Mirrors the `buildServer()` factory shape: it constructs, configures, and
 * returns a resource with no top-level side effects, so each call yields an
 * independent handle and tests can drive an in-memory or temp-file database.
 *
 * Configuration applied on every open:
 *  - `journal_mode = WAL` for concurrent read-during-write (the pipeline writes
 *    while the API reads the same file on a shared volume).
 *  - `foreign_keys = ON` so the schema's cascading references are enforced.
 *  - Empty databases are initialized directly to the canonical schema.
 *  - Databases at any other shape are rejected as unsupported (never mutated).
 *
 * The path resolves from the argument, then `SQLITE_PATH`, then a local default.
 */
export function openDb(path = process.env.SQLITE_PATH ?? "./patchnotes.db"): DatabaseType {
  const db = new Database(path);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    const inspection = inspectSchemaVersion(db);
    if (inspection.state === "empty") initializeCanonicalSchema(db);
    if (inspection.state === "unsupported") {
      throw new Error(`Unsupported SQLite schema version ${inspection.userVersion}`);
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
