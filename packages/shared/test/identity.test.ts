import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import {
  getCurrentSourceRecord,
  getDocumentByExternalIdentifier,
  openDb,
  resolveDocumentReference,
  upsertSteamSourceRecord,
  type SteamSourceRecordInput,
} from "../src/index.js";

const openDatabases: Database[] = [];

afterEach(() => {
  for (const db of openDatabases.splice(0)) db.close();
});

function database(): Database {
  const db = openDb(":memory:");
  openDatabases.push(db);
  return db;
}

function input(overrides: Partial<SteamSourceRecordInput> = {}): SteamSourceRecordInput {
  return {
    gid: "steam-gid-1",
    url: "https://store.steampowered.com/news/app/730/view/steam-gid-1",
    title: "Counter-Strike 2 Update",
    posted_at: 1_720_000_000,
    game: "cs2",
    channel: "mainline",
    content_kind: "patch_notes",
    source_adapter: "steam_news",
    body_format: "bbcode",
    pristine_body: "[h2]MISC[/h2]\nFixed café smoke 💨",
    fetched_at: 1_720_000_010,
    ...overrides,
  };
}

function count(db: Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function sha256(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

describe("opaque document identity", () => {
  test("resolves a canonical document through its id, Steam GID, and publisher locator", () => {
    const db = database();
    const inserted = upsertSteamSourceRecord(db, input());

    expect(inserted.created_document).toBe(true);
    expect(getDocumentByExternalIdentifier(db, "steam_news_gid", "steam-gid-1")?.id).toBe(
      inserted.document.id,
    );
    expect(resolveDocumentReference(db, { id: inserted.document.id })?.id).toBe(
      inserted.document.id,
    );
    expect(
      resolveDocumentReference(db, {
        namespace: "steam_news_gid",
        value: "steam-gid-1",
      })?.id,
    ).toBe(inserted.document.id);
    expect(
      resolveDocumentReference(db, {
        namespace: "steam_news_url",
        value: input().url!,
      })?.id,
    ).toBe(inserted.document.id);
  });

  test("never merges distinct GIDs because title, date, and body are identical", () => {
    const db = database();
    const first = upsertSteamSourceRecord(db, input());
    const second = upsertSteamSourceRecord(
      db,
      input({
        gid: "steam-gid-2",
        url: "https://store.steampowered.com/news/app/730/view/steam-gid-2",
      }),
    );

    expect(second.document.id).not.toBe(first.document.id);
    expect(count(db, "documents")).toBe(2);
    expect(count(db, "source_records")).toBe(2);
  });

  test("rolls back the whole ingest when a publisher locator belongs to another document", () => {
    const db = database();
    const sharedUrl = "https://store.steampowered.com/news/app/730/view/shared";
    upsertSteamSourceRecord(db, input({ url: sharedUrl }));

    expect(() =>
      upsertSteamSourceRecord(
        db,
        input({
          gid: "steam-gid-2",
          url: sharedUrl,
          pristine_body: "different body",
        }),
      ),
    ).toThrow();

    expect(count(db, "documents")).toBe(1);
    expect(count(db, "source_records")).toBe(1);
    expect(getDocumentByExternalIdentifier(db, "steam_news_gid", "steam-gid-2")).toBeUndefined();
  });
});

describe("immutable source revision history", () => {
  test("an identical retry reuses the document and source revision without moving the head", () => {
    const db = database();
    const first = upsertSteamSourceRecord(db, input());
    const retry = upsertSteamSourceRecord(db, input({ fetched_at: 1_720_000_999 }));

    expect(retry.created_document).toBe(false);
    expect(retry.created_source_record).toBe(false);
    expect(retry.document.id).toBe(first.document.id);
    expect(retry.source_record.id).toBe(first.source_record.id);
    expect(count(db, "source_records")).toBe(1);
    expect(count(db, "document_source_heads")).toBe(1);
    expect(getCurrentSourceRecord(db, first.document.id, "steam_news")?.id).toBe(
      first.source_record.id,
    );
  });

  test("changed bytes append a linked revision and select it only through the explicit head", () => {
    const db = database();
    const originalBody = input().pristine_body;
    const changedBody = `${originalBody}\n[ b ]byte-level correction[/b]`;
    const first = upsertSteamSourceRecord(db, input());
    const changed = upsertSteamSourceRecord(
      db,
      input({ pristine_body: changedBody, fetched_at: 1_720_000_020 }),
    );

    expect(changed.document.id).toBe(first.document.id);
    expect(changed.created_source_record).toBe(true);
    expect(changed.source_record.id).not.toBe(first.source_record.id);
    expect(changed.source_record.supersedes_source_record_id).toBe(first.source_record.id);
    expect(count(db, "source_records")).toBe(2);

    const storedOriginal = db
      .prepare("SELECT pristine_body, body_sha256 FROM source_records WHERE id = ?")
      .get(first.source_record.id) as { pristine_body: string; body_sha256: string };
    expect(Buffer.from(storedOriginal.pristine_body, "utf8")).toEqual(
      Buffer.from(originalBody, "utf8"),
    );
    expect(storedOriginal.body_sha256).toBe(sha256(originalBody));
    expect(changed.source_record.pristine_body).toBe(changedBody);
    expect(changed.source_record.body_sha256).toBe(sha256(changedBody));
    expect(getCurrentSourceRecord(db, first.document.id, "steam_news")?.id).toBe(
      changed.source_record.id,
    );

    expect(() =>
      db.prepare("UPDATE source_records SET pristine_body = ? WHERE id = ?").run(
        "tampered",
        first.source_record.id,
      ),
    ).toThrow(/immutable/);
    expect(() =>
      db.prepare("UPDATE source_records SET body_sha256 = ? WHERE id = ?").run(
        "0".repeat(64),
        first.source_record.id,
      ),
    ).toThrow(/immutable/);
  });

  test("a second changed body extends the predecessor chain in current-head order", () => {
    const db = database();
    const first = upsertSteamSourceRecord(db, input({ pristine_body: "revision one" }));
    const second = upsertSteamSourceRecord(
      db,
      input({ pristine_body: "revision two", fetched_at: 1_720_000_020 }),
    );
    const third = upsertSteamSourceRecord(
      db,
      input({ pristine_body: "revision three", fetched_at: 1_720_000_030 }),
    );

    expect(second.source_record.supersedes_source_record_id).toBe(first.source_record.id);
    expect(third.source_record.supersedes_source_record_id).toBe(second.source_record.id);
    expect(getCurrentSourceRecord(db, first.document.id, "steam_news")?.id).toBe(
      third.source_record.id,
    );
    expect(
      db
        .prepare(
          "SELECT pristine_body FROM source_records WHERE document_id = ? ORDER BY fetched_at, id",
        )
        .all(first.document.id)
        .map((row) => (row as { pristine_body: string }).pristine_body),
    ).toEqual(["revision one", "revision two", "revision three"]);
  });

  test("ingestion leaves parser-derived state empty on first, identical, and changed writes", () => {
    const db = database();
    upsertSteamSourceRecord(db, input());
    upsertSteamSourceRecord(db, input());
    upsertSteamSourceRecord(db, input({ pristine_body: "corrected source" }));

    for (const table of [
      "document_parse_state",
      "parse_runs",
      "parse_diagnostics",
      "blocks",
      "media_items",
      "search_fragments",
      "fragment_ancestors",
      "fragment_tags",
    ]) {
      expect(count(db, table), table).toBe(0);
    }
  });
});
