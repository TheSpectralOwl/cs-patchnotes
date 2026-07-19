import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";

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
 *  - `SCHEMA_SQL` executed idempotently (`CREATE TABLE IF NOT EXISTS`), making
 *    re-opening an existing database a safe no-op.
 *
 * The path resolves from the argument, then `SQLITE_PATH`, then a local default.
 */
export function openDb(path = process.env.SQLITE_PATH ?? "./patchnotes.db"): DatabaseType {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}
