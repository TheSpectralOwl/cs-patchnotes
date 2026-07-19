import { test, expect } from "vitest";
import { openDb } from "../src/db/client.js";

const TABLES = ["updates", "sections", "lines", "line_tags", "meta"];

function tableNames(db: ReturnType<typeof openDb>): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => (r as { name: string }).name);
}

test("openDb applies WAL journal mode", () => {
  const db = openDb(":memory:");
  // :memory: databases report 'memory'; a file-backed DB reports 'wal'.
  const mode = (db.pragma("journal_mode", { simple: true }) as string).toLowerCase();
  expect(["wal", "memory"]).toContain(mode);
  db.close();
});

test("openDb creates all five tables immediately", () => {
  const db = openDb(":memory:");
  const names = tableNames(db);
  for (const t of TABLES) {
    expect(names).toContain(t);
  }
  db.close();
});

test("openDb applies WAL on a file-backed database", () => {
  const path = `/tmp/patchnotes-test-${process.pid}-${Date.now()}.db`;
  const db = openDb(path);
  const mode = (db.pragma("journal_mode", { simple: true }) as string).toLowerCase();
  expect(mode).toBe("wal");
  db.close();
});

test("re-opening the same file path is idempotent", () => {
  const path = `/tmp/patchnotes-idem-${process.pid}-${Date.now()}.db`;
  const first = openDb(path);
  first.close();
  // Second open must not throw and the schema must still be present.
  const second = openDb(path);
  const names = tableNames(second);
  for (const t of TABLES) {
    expect(names).toContain(t);
  }
  second.close();
});
