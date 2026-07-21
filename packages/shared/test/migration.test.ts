import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { openDb } from "../src/db/client.js";
import {
  LATEST_SCHEMA_VERSION,
  inspectSchemaVersion,
  runMigrations,
} from "../src/db/migrations.js";

const temporaryDirectories: string[] = [];
const openDatabases: DatabaseType[] = [];

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "canonical-schema-"));
  temporaryDirectories.push(directory);
  return join(directory, "legacy.sqlite");
}

function seedLegacyDatabase(path: string): { gid: string; rawBody: string } {
  const db = new Database(path);
  const gid = "1010228711585010877";
  const rawBody = "[ GAMEPLAY ]\r\n– Preserved emoji: 🧪\r\n[img]literal bytes[/img]";
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE updates (
      id TEXT PRIMARY KEY,
      posted_at INTEGER NOT NULL,
      title TEXT NOT NULL,
      url TEXT,
      feedname TEXT,
      game TEXT NOT NULL,
      raw_body TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      channel TEXT NOT NULL DEFAULT 'mainline'
    );
    CREATE TABLE sections (
      id TEXT PRIMARY KEY,
      update_id TEXT NOT NULL REFERENCES updates(id) ON DELETE CASCADE,
      section_index INTEGER NOT NULL,
      header TEXT,
      UNIQUE(update_id, section_index)
    );
    CREATE TABLE lines (
      id TEXT PRIMARY KEY,
      section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
      update_id TEXT NOT NULL REFERENCES updates(id) ON DELETE CASCADE,
      line_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      game TEXT NOT NULL,
      subheader TEXT,
      parent_line_index INTEGER,
      UNIQUE(section_id, line_index)
    );
    CREATE TABLE line_tags (
      line_id TEXT NOT NULL REFERENCES lines(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      category TEXT,
      entity TEXT,
      source TEXT NOT NULL,
      confidence REAL,
      PRIMARY KEY (line_id, kind, category, entity)
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  db.prepare(
    `INSERT INTO updates
       (id, posted_at, title, url, feedname, game, raw_body, fetched_at, channel)
     VALUES (?, 1, 'Legacy Update', 'https://steamcommunity.com/games/CSGO/announcements/detail/1',
             'steam_community_announcements', 'csgo', ?, 2, 'mainline')`,
  ).run(gid, rawBody);
  db.prepare("INSERT INTO sections (id, update_id, section_index, header) VALUES (?, ?, 0, 'GAMEPLAY')").run(
    `${gid}_0`,
    gid,
  );
  db.prepare(
    `INSERT INTO lines
       (id, section_id, update_id, line_index, text, game, subheader, parent_line_index)
     VALUES (?, ?, ?, 0, 'Preserved emoji: 🧪', 'csgo', NULL, NULL)`,
  ).run(`${gid}_0_0`, `${gid}_0`, gid);
  db.close();
  return { gid, rawBody };
}

function track<T extends DatabaseType>(db: T): T {
  openDatabases.push(db);
  return db;
}

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("versioned additive migration", () => {
  test("detects a legacy database repeatedly without migrating it on open", () => {
    const path = temporaryDatabasePath();
    const { rawBody } = seedLegacyDatabase(path);

    const first = track(openDb(path));
    const firstInspection = inspectSchemaVersion(first);
    const secondInspection = inspectSchemaVersion(first);
    expect(firstInspection).toEqual(secondInspection);
    expect(firstInspection.state).toBe("legacy");
    expect(firstInspection.userVersion).toBe(0);
    expect(
      first.prepare("SELECT raw_body FROM updates").pluck().get(),
    ).toBe(rawBody);
    expect(
      first.prepare("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'documents'").pluck().get(),
    ).toBe(0);
  });

  test("expands legacy storage additively with byte parity and stable IDs on retry", () => {
    const path = temporaryDatabasePath();
    const { gid, rawBody } = seedLegacyDatabase(path);
    const db = track(new Database(path));
    db.pragma("foreign_keys = ON");

    runMigrations(db);
    expect(inspectSchemaVersion(db).state).toBe("transitional");
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);

    const first = db
      .prepare(
        `SELECT d.id AS document_id, s.id AS source_record_id, s.pristine_body, s.body_sha256,
                h.source_record_id AS current_source_record_id
           FROM documents d
           JOIN external_identifiers e ON e.document_id = d.id
           JOIN source_records s ON s.document_id = d.id
           JOIN document_source_heads h
             ON h.document_id = d.id AND h.source_adapter = s.source_adapter
          WHERE e.namespace = 'steam_news_gid' AND e.value = ?`,
      )
      .get(gid) as {
      document_id: string;
      source_record_id: string;
      pristine_body: string;
      body_sha256: string;
      current_source_record_id: string;
    };
    expect(first.pristine_body).toBe(rawBody);
    expect(Buffer.from(first.pristine_body, "utf8")).toEqual(Buffer.from(rawBody, "utf8"));
    expect(first.body_sha256).toBe(sha256(rawBody));
    expect(first.current_source_record_id).toBe(first.source_record_id);
    expect(db.prepare("SELECT count(*) FROM updates").pluck().get()).toBe(1);
    expect(db.prepare("SELECT count(*) FROM sections").pluck().get()).toBe(1);
    expect(db.prepare("SELECT count(*) FROM lines").pluck().get()).toBe(1);

    runMigrations(db);
    const retried = db
      .prepare(
        `SELECT d.id AS document_id, s.id AS source_record_id
           FROM documents d
           JOIN external_identifiers e ON e.document_id = d.id
           JOIN source_records s ON s.document_id = d.id
          WHERE e.namespace = 'steam_news_gid' AND e.value = ?`,
      )
      .get(gid) as { document_id: string; source_record_id: string };
    expect(retried).toEqual({
      document_id: first.document_id,
      source_record_id: first.source_record_id,
    });
    expect(db.prepare("SELECT count(*) FROM documents").pluck().get()).toBe(1);
    expect(db.prepare("SELECT count(*) FROM source_records").pluck().get()).toBe(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  test("keeps pristine revisions append-only and selects changed bytes through one explicit head", () => {
    const path = temporaryDatabasePath();
    const { gid, rawBody } = seedLegacyDatabase(path);
    const db = track(new Database(path));
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    const first = db
      .prepare(
        `SELECT s.*
           FROM source_records s
           JOIN external_identifiers e ON e.document_id = s.document_id
          WHERE e.namespace = 'steam_news_gid' AND e.value = ?`,
      )
      .get(gid) as Record<string, string | number | null>;
    const changedBody = `${rawBody}\n– A later correction.`;
    db.prepare(
      `INSERT INTO source_records
         (id, document_id, source_adapter, body_format, pristine_body, body_sha256,
          fetched_at, supersedes_source_record_id)
       VALUES ('source-revision-2', ?, 'steam_news', ?, ?, ?, 3, ?)`,
    ).run(first.document_id, first.body_format, changedBody, sha256(changedBody), first.id);
    db.prepare(
      `UPDATE document_source_heads
          SET source_record_id = 'source-revision-2', updated_at = 3
        WHERE document_id = ? AND source_adapter = 'steam_news'`,
    ).run(first.document_id);

    const revisions = db
      .prepare(
        `SELECT id, pristine_body, body_sha256, supersedes_source_record_id
           FROM source_records
          WHERE document_id = ?
          ORDER BY fetched_at`,
      )
      .all(first.document_id) as Array<{
      id: string;
      pristine_body: string;
      body_sha256: string;
      supersedes_source_record_id: string | null;
    }>;
    expect(revisions).toEqual([
      {
        id: first.id,
        pristine_body: rawBody,
        body_sha256: sha256(rawBody),
        supersedes_source_record_id: null,
      },
      {
        id: "source-revision-2",
        pristine_body: changedBody,
        body_sha256: sha256(changedBody),
        supersedes_source_record_id: first.id,
      },
    ]);
    expect(
      db
        .prepare(
          `SELECT s.pristine_body
             FROM document_source_heads h
             JOIN source_records s ON s.id = h.source_record_id
            WHERE h.document_id = ? AND h.source_adapter = 'steam_news'`,
        )
        .pluck()
        .get(first.document_id),
    ).toBe(changedBody);
  });

  test("rejects every direct mutation of an immutable source revision", () => {
    const path = temporaryDatabasePath();
    const { gid } = seedLegacyDatabase(path);
    const db = track(new Database(path));
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    const source = db
      .prepare(
        `SELECT s.* FROM source_records s
          JOIN external_identifiers e ON e.document_id = s.document_id
         WHERE e.namespace = 'steam_news_gid' AND e.value = ?`,
      )
      .get(gid) as Record<string, unknown>;

    const replacements: Record<string, unknown> = {
      pristine_body: "changed",
      body_sha256: "f".repeat(64),
      body_format: "plain_text",
      source_adapter: "other_adapter",
      supersedes_source_record_id: "other-revision",
      fetched_at: 999,
    };
    for (const [column, value] of Object.entries(replacements)) {
      expect(() => db.prepare(`UPDATE source_records SET ${column} = ? WHERE id = ?`).run(value, source.id)).toThrow(
        /immutable/i,
      );
    }
  });

  test("rejects current pointers for another document or adapter", () => {
    const db = track(openDb(":memory:"));
    const insertDocument = db.prepare(
      `INSERT INTO documents
         (id, content_kind, title, posted_at, game, channel, parse_status)
       VALUES (?, 'patch_notes', ?, 1, 'csgo', 'mainline', 'unparsed')`,
    );
    insertDocument.run("doc-a", "A");
    insertDocument.run("doc-b", "B");
    const insertSource = db.prepare(
      `INSERT INTO source_records
         (id, document_id, source_adapter, body_format, pristine_body, body_sha256, fetched_at)
       VALUES (?, ?, ?, 'plain_text', 'body', ?, 1)`,
    );
    insertSource.run("source-a", "doc-a", "steam_news", sha256("body"));
    insertSource.run("source-b", "doc-b", "steam_news", sha256("body"));
    insertSource.run("source-a-archive", "doc-a", "wayback", sha256("body"));
    const insertHead = db.prepare(
      `INSERT INTO document_source_heads
         (document_id, source_adapter, source_record_id, updated_at)
       VALUES (?, ?, ?, 1)`,
    );

    expect(() => insertHead.run("doc-a", "steam_news", "source-b")).toThrow();
    expect(() => insertHead.run("doc-a", "steam_news", "source-a-archive")).toThrow();
    expect(() => insertHead.run("doc-a", "steam_news", "source-a")).not.toThrow();
  });
});
