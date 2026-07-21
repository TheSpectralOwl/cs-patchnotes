import { afterEach, describe, expect, test } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { openDb } from "../src/db/client.js";

const openDatabases: DatabaseType[] = [];

function freshDb(): DatabaseType {
  const db = openDb(":memory:");
  openDatabases.push(db);
  return db;
}

function insertDocument(db: DatabaseType, id: string, parseStatus = "unparsed"): void {
  db.prepare(
    `INSERT INTO documents
       (id, content_kind, title, posted_at, game, channel, parse_status)
     VALUES (?, 'patch_notes', ?, 1, 'csgo', 'mainline', ?)`,
  ).run(id, `Document ${id}`, parseStatus);
}

function insertBlock(
  db: DatabaseType,
  values: {
    id: string;
    documentId: string;
    kind: string;
    preorder: number;
    siblingOrder: number;
    parentBlockId?: string | null;
    text?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO blocks
       (id, document_id, parent_block_id, kind, preorder, sibling_order, text)
     VALUES (@id, @documentId, @parentBlockId, @kind, @preorder, @siblingOrder, @text)`,
  ).run({ parentBlockId: null, text: null, ...values });
}

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe("canonical schema", () => {
  test("creates canonical relations at the single canonical schema version", () => {
    const db = freshDb();
    const names = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => (row as { name: string }).name),
    );

    expect(db.pragma("user_version", { simple: true })).toBe(1);
    expect([...names]).toEqual(
      expect.arrayContaining([
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
        "meta",
      ]),
    );
    for (const legacy of ["updates", "sections", "lines", "line_tags", "canonical_cutover_audits"]) {
      expect(names.has(legacy)).toBe(false);
    }
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  test("accepts exactly the closed content kinds and rejects unknown parse states", () => {
    const db = freshDb();
    const insert = db.prepare(
      `INSERT INTO documents
         (id, content_kind, title, posted_at, game, channel, parse_status)
       VALUES (?, ?, 'Title', 1, 'csgo', 'mainline', ?)`,
    );

    for (const [index, kind] of ["patch_notes", "release_article", "announcement"].entries()) {
      expect(() => insert.run(`doc-${index}`, kind, "unparsed")).not.toThrow();
    }
    expect(() => insert.run("doc-invalid-kind", "marketing", "unparsed")).toThrow();
    expect(() => insert.run("doc-invalid-state", "patch_notes", "silently_guessed")).toThrow();
  });

  test("accepts exactly the approved block kinds", () => {
    const db = freshDb();
    insertDocument(db, "doc-block-kinds");

    const kinds = [
      "heading",
      "paragraph",
      "list",
      "list_item",
      "patch_change",
      "media_group",
      "unsupported",
    ];
    kinds.forEach((kind, index) => {
      expect(() =>
        insertBlock(db, {
          id: `block-${index}`,
          documentId: "doc-block-kinds",
          kind,
          preorder: index,
          siblingOrder: kind === "list_item" ? 0 : index,
          parentBlockId: kind === "list_item" ? "block-2" : null,
        }),
      ).not.toThrow();
    });

    expect(() =>
      insertBlock(db, {
        id: "block-source-markup",
        documentId: "doc-block-kinds",
        kind: "bbcode_tag",
        preorder: 99,
        siblingOrder: 99,
      }),
    ).toThrow();
  });

  test("enforces document preorder, sibling order, and same-document parents", () => {
    const db = freshDb();
    insertDocument(db, "doc-a");
    insertDocument(db, "doc-b");
    insertBlock(db, {
      id: "a-parent",
      documentId: "doc-a",
      kind: "heading",
      preorder: 0,
      siblingOrder: 0,
    });
    insertBlock(db, {
      id: "b-parent",
      documentId: "doc-b",
      kind: "heading",
      preorder: 0,
      siblingOrder: 0,
    });

    expect(() =>
      insertBlock(db, {
        id: "a-duplicate-preorder",
        documentId: "doc-a",
        kind: "paragraph",
        preorder: 0,
        siblingOrder: 1,
      }),
    ).toThrow();
    expect(() =>
      insertBlock(db, {
        id: "a-duplicate-root-sibling",
        documentId: "doc-a",
        kind: "paragraph",
        preorder: 1,
        siblingOrder: 0,
      }),
    ).toThrow();
    expect(() =>
      insertBlock(db, {
        id: "a-cross-document-child",
        documentId: "doc-a",
        parentBlockId: "b-parent",
        kind: "patch_change",
        preorder: 2,
        siblingOrder: 0,
      }),
    ).toThrow();
  });

  test("permits fragments only for approved semantic text and visible captions", () => {
    const db = freshDb();
    insertDocument(db, "doc-fragments");
    insertBlock(db, {
      id: "heading",
      documentId: "doc-fragments",
      kind: "heading",
      preorder: 0,
      siblingOrder: 0,
      text: "Gameplay",
    });
    insertBlock(db, {
      id: "list",
      documentId: "doc-fragments",
      kind: "list",
      preorder: 1,
      siblingOrder: 1,
    });
    insertBlock(db, {
      id: "unsupported",
      documentId: "doc-fragments",
      kind: "unsupported",
      preorder: 2,
      siblingOrder: 2,
    });
    insertBlock(db, {
      id: "media",
      documentId: "doc-fragments",
      kind: "media_group",
      preorder: 3,
      siblingOrder: 3,
    });
    db.prepare(
      `INSERT INTO media_items
         (id, document_id, group_block_id, item_order, media_kind, original_locator, caption, alt_text)
       VALUES ('media-item', 'doc-fragments', 'media', 0, 'image', 'https://example.invalid/source.png',
               'Visible caption', 'non-searchable alt text')`,
    ).run();

    expect(() =>
      db.prepare(
        `INSERT INTO search_fragments
           (id, document_id, block_id, fragment_order, fragment_kind, text, text_sha256)
         VALUES ('heading-fragment', 'doc-fragments', 'heading', 0, 'block_text', 'Gameplay', ?)`,
      ).run("a".repeat(64)),
    ).not.toThrow();
    for (const blockId of ["list", "unsupported", "media"]) {
      expect(() =>
        db.prepare(
          `INSERT INTO search_fragments
             (id, document_id, block_id, fragment_order, fragment_kind, text, text_sha256)
           VALUES (?, 'doc-fragments', ?, 1, 'block_text', 'not eligible', ?)`,
        ).run(`${blockId}-fragment`, blockId, "b".repeat(64)),
      ).toThrow();
    }
    expect(() =>
      db.prepare(
        `INSERT INTO search_fragments
           (id, document_id, block_id, media_item_id, fragment_order, fragment_kind, text, text_sha256)
         VALUES ('caption-fragment', 'doc-fragments', 'media', 'media-item', 1, 'media_caption',
                 'Visible caption', ?)`,
      ).run("c".repeat(64)),
    ).not.toThrow();

    const texts = db
      .prepare("SELECT text FROM search_fragments ORDER BY fragment_order")
      .all()
      .map((row) => (row as { text: string }).text);
    expect(texts).toEqual(["Gameplay", "Visible caption"]);
    expect(texts.join(" ")).not.toContain("source.png");
    expect(texts.join(" ")).not.toContain("non-searchable alt text");
  });
});
