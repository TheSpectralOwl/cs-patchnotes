import type { Database as DatabaseType } from "better-sqlite3";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import { openDb } from "../src/db/client.js";
import {
  CANONICAL_SCHEMA_VERSION,
  initializeCanonicalSchema,
  inspectSchemaVersion,
} from "../src/db/migrations.js";

const openDatabases: DatabaseType[] = [];

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

function track<T extends DatabaseType>(db: T): T {
  openDatabases.push(db);
  return db;
}

function seedCanonicalDocument(
  db: DatabaseType,
  gid: string,
  rawBody: string,
): { documentId: string; sourceRecordId: string } {
  const documentId = "doc-seed";
  const sourceRecordId = "source-seed";
  db.prepare(
    `INSERT INTO documents
       (id, content_kind, title, posted_at, game, channel, parse_status)
     VALUES (?, 'patch_notes', 'Seed Update', 1, 'csgo', 'mainline', 'unparsed')`,
  ).run(documentId);
  db.prepare(
    `INSERT INTO source_records
       (id, document_id, source_adapter, body_format, pristine_body, body_sha256, fetched_at)
     VALUES (?, ?, 'steam_news', 'bbcode', ?, ?, 2)`,
  ).run(sourceRecordId, documentId, rawBody, sha256(rawBody));
  db.prepare(
    `INSERT INTO document_source_heads
       (document_id, source_adapter, source_record_id, updated_at)
     VALUES (?, 'steam_news', ?, 2)`,
  ).run(documentId, sourceRecordId);
  db.prepare(
    `INSERT INTO external_identifiers (namespace, value, document_id, created_at)
     VALUES ('steam_news_gid', ?, ?, 2)`,
  ).run(gid, documentId);
  return { documentId, sourceRecordId };
}

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe("canonical schema initialization", () => {
  test("initializes a fresh database at the single canonical version and is idempotent", () => {
    const db = track(openDb(":memory:"));

    const first = inspectSchemaVersion(db);
    expect(first.state).toBe("canonical");
    expect(first.userVersion).toBe(CANONICAL_SCHEMA_VERSION);
    expect(db.pragma("user_version", { simple: true })).toBe(CANONICAL_SCHEMA_VERSION);

    // Calling initialize again on the same DB is a no-op that leaves the schema intact.
    const reinitialized = initializeCanonicalSchema(db);
    expect(reinitialized.state).toBe("canonical");
    expect(reinitialized.userVersion).toBe(CANONICAL_SCHEMA_VERSION);

    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('updates','sections','lines','line_tags') ORDER BY name",
        )
        .pluck()
        .all(),
    ).toEqual([]);
    expect(
      db.prepare("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='documents'").pluck().get(),
    ).toBe(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  test("keeps pristine revisions append-only and selects changed bytes through one explicit head", () => {
    const db = track(openDb(":memory:"));
    const gid = "1010228711585010877";
    const rawBody = "[ GAMEPLAY ]\r\n– Preserved emoji: 🧪\r\n[img]literal bytes[/img]";
    const { documentId, sourceRecordId } = seedCanonicalDocument(db, gid, rawBody);

    const first = db
      .prepare(
        `SELECT s.*
           FROM source_records s
           JOIN external_identifiers e ON e.document_id = s.document_id
          WHERE e.namespace = 'steam_news_gid' AND e.value = ?`,
      )
      .get(gid) as Record<string, string | number | null>;
    expect(first.id).toBe(sourceRecordId);

    const changedBody = `${rawBody}\n– A later correction.`;
    db.prepare(
      `INSERT INTO source_records
         (id, document_id, source_adapter, body_format, pristine_body, body_sha256,
          fetched_at, supersedes_source_record_id)
       VALUES ('source-revision-2', ?, 'steam_news', ?, ?, ?, 3, ?)`,
    ).run(documentId, first.body_format, changedBody, sha256(changedBody), first.id);
    db.prepare(
      `UPDATE document_source_heads
          SET source_record_id = 'source-revision-2', updated_at = 3
        WHERE document_id = ? AND source_adapter = 'steam_news'`,
    ).run(documentId);

    const revisions = db
      .prepare(
        `SELECT id, pristine_body, body_sha256, supersedes_source_record_id
           FROM source_records
          WHERE document_id = ?
          ORDER BY fetched_at`,
      )
      .all(documentId) as Array<{
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
        .get(documentId),
    ).toBe(changedBody);
  });

  test("rejects every direct mutation of an immutable source revision", () => {
    const db = track(openDb(":memory:"));
    const gid = "1010228711585010877";
    const rawBody = "[ GAMEPLAY ]\r\n– Preserved emoji: 🧪\r\n[img]literal bytes[/img]";
    seedCanonicalDocument(db, gid, rawBody);
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
