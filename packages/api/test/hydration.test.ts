import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openDb, type RankedFragmentHit } from "@cs-patchnotes/shared";
import {
  MAX_HYDRATE_IDS,
  collapseRankedGroupHits,
  hydrateRankedFragments,
  type RankedHydrationRequest,
} from "@cs-patchnotes/shared";

const SHA = "0".repeat(64);

function insertDocument(
  db: Database,
  id: string,
  title: string,
  postedAt: number,
): void {
  db.prepare(
    `INSERT INTO documents
       (id, content_kind, title, posted_at, game, channel, parse_status)
     VALUES (?, 'patch_notes', ?, ?, 'cs2', 'mainline', 'parsed')`,
  ).run(id, title, postedAt);
}

function insertBlock(
  db: Database,
  input: {
    id: string;
    documentId: string;
    parentId?: string;
    kind: "heading" | "paragraph" | "patch_change" | "media_group" | "unsupported";
    preorder: number;
    siblingOrder: number;
    text?: string;
    label?: string;
  },
): void {
  db.prepare(
    `INSERT INTO blocks
       (id, document_id, parent_block_id, kind, preorder, sibling_order, text, label,
        source_start, source_end, source_node_type, diagnostic_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.documentId,
    input.parentId ?? null,
    input.kind,
    input.preorder,
    input.siblingOrder,
    input.text ?? null,
    input.label ?? null,
    input.kind === "unsupported" ? 10 : null,
    input.kind === "unsupported" ? 30 : null,
    input.kind === "unsupported" ? "mystery-tag-with-private-payload" : null,
    input.kind === "unsupported" ? "raw-parser-diagnostic" : null,
  );
}

function insertFragment(
  db: Database,
  input: {
    id: string;
    documentId: string;
    blockId: string;
    order: number;
    text: string;
    anchorId?: string;
  },
): void {
  db.prepare(
    `INSERT INTO search_fragments
       (id, document_id, block_id, media_item_id, fragment_order, fragment_kind,
        text, text_sha256, group_anchor_block_id)
     VALUES (?, ?, ?, NULL, ?, 'block_text', ?, ?, ?)`,
  ).run(
    input.id,
    input.documentId,
    input.blockId,
    input.order,
    input.text,
    SHA,
    input.anchorId ?? null,
  );
}

function seedCanonicalDb(): Database {
  const db = openDb(":memory:");
  insertDocument(db, "doc-a", "Authoritative Alpha", 200);
  insertDocument(db, "doc-b", "Authoritative Beta", 200);

  insertBlock(db, {
    id: "a-heading",
    documentId: "doc-a",
    kind: "heading",
    preorder: 0,
    siblingOrder: 0,
    text: "Maps",
    label: "Maps",
  });
  insertBlock(db, {
    id: "a-change-1",
    documentId: "doc-a",
    parentId: "a-heading",
    kind: "patch_change",
    preorder: 1,
    siblingOrder: 0,
    text: "Authoritative connector adjustment",
  });
  insertBlock(db, {
    id: "a-change-2",
    documentId: "doc-a",
    parentId: "a-heading",
    kind: "patch_change",
    preorder: 2,
    siblingOrder: 1,
    text: "Authoritative visibility adjustment",
  });
  insertBlock(db, {
    id: "a-media",
    documentId: "doc-a",
    parentId: "a-heading",
    kind: "media_group",
    preorder: 3,
    siblingOrder: 2,
  });
  db.prepare(
    `INSERT INTO media_items
       (id, document_id, group_block_id, item_order, media_kind, original_locator,
        archive_locator, caption, alt_text, provenance_json)
     VALUES ('a-image', 'doc-a', 'a-media', 0, 'image', 'https://private.invalid/raw.png',
             NULL, 'Visible overview', 'secret alternate text', '{"private":true}')`,
  ).run();
  insertBlock(db, {
    id: "a-unsupported",
    documentId: "doc-a",
    parentId: "a-heading",
    kind: "unsupported",
    preorder: 4,
    siblingOrder: 3,
  });

  insertBlock(db, {
    id: "b-change",
    documentId: "doc-b",
    kind: "patch_change",
    preorder: 0,
    siblingOrder: 0,
    text: "Authoritative beta change",
  });

  insertFragment(db, {
    id: "frag-heading",
    documentId: "doc-a",
    blockId: "a-heading",
    order: 0,
    text: "Maps",
    anchorId: "a-heading",
  });
  insertFragment(db, {
    id: "frag-a1",
    documentId: "doc-a",
    blockId: "a-change-1",
    order: 1,
    text: "Authoritative connector adjustment",
    anchorId: "a-heading",
  });
  insertFragment(db, {
    id: "frag-a2",
    documentId: "doc-a",
    blockId: "a-change-2",
    order: 2,
    text: "Authoritative visibility adjustment",
    anchorId: "a-heading",
  });
  insertFragment(db, {
    id: "frag-b",
    documentId: "doc-b",
    blockId: "b-change",
    order: 0,
    text: "Authoritative beta change",
  });
  return db;
}

function hit(
  overrides: Partial<RankedFragmentHit> & Pick<RankedFragmentHit, "fragment_id">,
): RankedFragmentHit {
  const fragmentId = overrides.fragment_id;
  const isHeading = fragmentId === "frag-heading";
  return {
    id: fragmentId,
    fragment_id: fragmentId,
    block_id: isHeading ? "a-heading" : "a-change-1",
    document_id: "doc-a",
    primary_release_id: null,
    group_anchor_block_id: "a-heading",
    fragment_kind: "block_text",
    content_kind: "patch_notes",
    posted_at: 200,
    matched_fields: { text: false, title: false, ancestor_labels: false },
    ...overrides,
  };
}

function instrumentPrepare(db: Database): {
  database: Database;
  preparedSql: string[];
  boundValues: unknown[];
} {
  const preparedSql: string[] = [];
  const boundValues: unknown[] = [];
  const database = new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        preparedSql.push(sql);
        const statement = target.prepare(sql);
        return new Proxy(statement, {
          get(statementTarget, statementProperty, statementReceiver) {
            const value = Reflect.get(
              statementTarget,
              statementProperty,
              statementReceiver,
            ) as unknown;
            if (statementProperty === "all" && typeof value === "function") {
              return (...args: unknown[]) => {
                boundValues.push(...args.flat());
                return value.apply(statementTarget, args);
              };
            }
            return typeof value === "function" ? value.bind(statementTarget) : value;
          },
        });
      };
    },
  }) as Database;
  return { database, preparedSql, boundValues };
}

describe("ranked hit collapse", () => {
  test("accepts empty, singleton, and maximum-sized raw hit windows", () => {
    expect(collapseRankedGroupHits([])).toEqual([]);
    expect(
      collapseRankedGroupHits([
        hit({
          fragment_id: "frag-a1",
          matched_fields: { text: true, title: false, ancestor_labels: false },
        }),
      ]),
    ).toEqual([{ kind: "direct", fragment_id: "frag-a1", rank: 0 }]);
    expect(
      collapseRankedGroupHits(
        Array.from({ length: MAX_HYDRATE_IDS }, (_, rank) =>
          hit({
            fragment_id: `fragment-${rank}`,
            document_id: `document-${rank}`,
            group_anchor_block_id: null,
            matched_fields: { text: true, title: false, ancestor_labels: false },
          }),
        ),
      ),
    ).toHaveLength(MAX_HYDRATE_IDS);
  });

  test("rejects raw hit windows above the pre-collapse maximum", () => {
    const hits = Array.from({ length: MAX_HYDRATE_IDS + 1 }, (_, rank) =>
      hit({ fragment_id: `fragment-${rank}` }),
    );
    expect(() => collapseRankedGroupHits(hits)).toThrow(/100/);
  });

  test("creates one anchor subgroup without a heading hit and retains a direct child", () => {
    const requests = collapseRankedGroupHits([
      hit({ fragment_id: "context-1", matched_fields: { text: false, title: false, ancestor_labels: true } }),
      hit({ fragment_id: "context-2", block_id: "a-change-2", matched_fields: { text: false, title: false, ancestor_labels: true } }),
      hit({ fragment_id: "context-3", matched_fields: { text: false, title: false, ancestor_labels: true } }),
      hit({ fragment_id: "frag-a1", matched_fields: { text: true, title: false, ancestor_labels: false } }),
    ]);

    expect(requests).toEqual([
      { kind: "subgroup", group_anchor_block_id: "a-heading", rank: 0 },
      { kind: "direct", fragment_id: "frag-a1", rank: 3 },
    ]);
  });

  test("folds a directly matched heading into its anchor subgroup", () => {
    expect(
      collapseRankedGroupHits([
        hit({
          fragment_id: "frag-heading",
          block_id: "a-heading",
          matched_fields: { text: true, title: false, ancestor_labels: false },
        }),
      ]),
    ).toEqual([{ kind: "subgroup", group_anchor_block_id: "a-heading", rank: 0 }]);
  });

  test.each([
    {
      name: "repeated title hits",
      hits: [
        hit({ fragment_id: "frag-a1", matched_fields: { text: false, title: true, ancestor_labels: false } }),
        hit({ fragment_id: "frag-a2", matched_fields: { text: false, title: true, ancestor_labels: false } }),
      ],
      expected: [{ kind: "document", document_id: "doc-a", rank: 0 }],
    },
    {
      name: "title plus ancestor context",
      hits: [
        hit({ fragment_id: "frag-a1", matched_fields: { text: false, title: true, ancestor_labels: true } }),
      ],
      expected: [
        { kind: "subgroup", group_anchor_block_id: "a-heading", rank: 0 },
        { kind: "document", document_id: "doc-a", rank: 0 },
      ],
    },
    {
      name: "title plus direct own text",
      hits: [
        hit({ fragment_id: "frag-a1", matched_fields: { text: true, title: true, ancestor_labels: false } }),
      ],
      expected: [
        { kind: "direct", fragment_id: "frag-a1", rank: 0 },
        { kind: "document", document_id: "doc-a", rank: 0 },
      ],
    },
  ])("retains independent request classes for $name", ({ hits, expected }) => {
    expect(collapseRankedGroupHits(hits)).toEqual(expected);
  });

  test("orders retained ranks, kind precedence, and canonical identifiers without renumbering", () => {
    const requests = collapseRankedGroupHits([
      hit({
        fragment_id: "z-direct",
        document_id: "doc-b",
        block_id: "b-change",
        group_anchor_block_id: null,
        matched_fields: { text: true, title: true, ancestor_labels: false },
      }),
      hit({
        fragment_id: "a-direct",
        matched_fields: { text: true, title: false, ancestor_labels: true },
      }),
    ]);
    expect(requests).toEqual([
      { kind: "direct", fragment_id: "z-direct", rank: 0 },
      { kind: "document", document_id: "doc-b", rank: 0 },
      { kind: "direct", fragment_id: "a-direct", rank: 1 },
      { kind: "subgroup", group_anchor_block_id: "a-heading", rank: 1 },
    ]);
  });
});

describe("bounded SQLite hydration", () => {
  let db: Database;

  beforeEach(() => {
    db = seedCanonicalDb();
  });

  afterEach(() => {
    if (db.open) db.close();
  });

  test.each([1, MAX_HYDRATE_IDS])(
    "uses the same two prepared reads for %i requests and binds every caller ID",
    (count) => {
      const requests: RankedHydrationRequest[] = Array.from({ length: count }, (_, rank) => ({
        kind: "direct" as const,
        fragment_id: rank === 0 ? "frag-a1" : `missing-'${rank}`,
        rank,
      }));
      const instrumented = instrumentPrepare(db);
      hydrateRankedFragments(instrumented.database, requests);
      expect(instrumented.preparedSql).toHaveLength(2);
      for (const request of requests) {
        expect(instrumented.boundValues).toContain(request.fragment_id);
      }
    },
  );

  test("rejects 101 requests before preparing SQL", () => {
    const instrumented = instrumentPrepare(db);
    const requests: RankedHydrationRequest[] = Array.from(
      { length: MAX_HYDRATE_IDS + 1 },
      (_, rank) => ({ kind: "direct", fragment_id: `frag-${rank}`, rank }),
    );
    expect(() => hydrateRankedFragments(instrumented.database, requests)).toThrow(/100/);
    expect(instrumented.preparedSql).toHaveLength(0);
  });

  test("binds injection-shaped document, subgroup, and direct identifiers", () => {
    const instrumented = instrumentPrepare(db);
    const requests: RankedHydrationRequest[] = [
      { kind: "document", document_id: "doc-a' OR 1=1 --", rank: 0 },
      { kind: "subgroup", group_anchor_block_id: "a-heading'); DROP TABLE blocks; --", rank: 1 },
      { kind: "direct", fragment_id: "frag-a1' UNION SELECT pristine_body --", rank: 2 },
    ];
    hydrateRankedFragments(instrumented.database, requests);
    expect(instrumented.preparedSql).toHaveLength(2);
    expect(instrumented.preparedSql.every((sql) => !sql.includes("DROP TABLE"))).toBe(true);
    for (const request of requests) {
      const id =
        request.kind === "document"
          ? request.document_id
          : request.kind === "subgroup"
            ? request.group_anchor_block_id
            : request.fragment_id;
      expect(instrumented.boundValues).toContain(id);
    }
  });

  test("hydrates rank-ordered representatives and canonical-order context from SQLite only", () => {
    const result = hydrateRankedFragments(db, [
      { kind: "direct", fragment_id: "frag-a1", rank: 4 },
      { kind: "subgroup", group_anchor_block_id: "a-heading", rank: 1 },
      { kind: "document", document_id: "doc-b", rank: 2 },
      { kind: "document", document_id: "missing-doc", rank: 3 },
    ]);

    expect(result.matches.map((match) => [match.kind, match.rank])).toEqual([
      ["subgroup", 1],
      ["document", 2],
      ["direct", 4],
    ]);
    expect(result.matches[0]?.representative_text).toBe("Maps");
    expect(result.matches[1]?.representative_text).toBe("Authoritative Beta");
    expect(result.matches[2]?.representative_text).toBe(
      "Authoritative connector adjustment",
    );
    expect(result.matches[0]?.context.blocks.map((block) => block.id)).toEqual([
      "a-heading",
      "a-change-1",
      "a-change-2",
      "a-media",
      "a-unsupported",
    ]);
    expect(result.matches[0]?.context.media_items).toEqual([
      {
        id: "a-image",
        group_block_id: "a-media",
        item_order: 0,
        media_kind: "image",
        caption: "Visible overview",
      },
    ]);
    expect(result.missing).toEqual([
      { kind: "document", document_id: "missing-doc", rank: 3 },
    ]);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("private.invalid");
    expect(serialized).not.toContain("secret alternate text");
    expect(serialized).not.toContain("raw-parser-diagnostic");
    expect(serialized).not.toContain("mystery-tag-with-private-payload");
    expect(serialized).not.toContain("pristine_body");
  });

  test("deduplicates each request key at its independently retained first rank", () => {
    const result = hydrateRankedFragments(db, [
      { kind: "document", document_id: "doc-a", rank: 6 },
      { kind: "document", document_id: "doc-a", rank: 1 },
      { kind: "subgroup", group_anchor_block_id: "a-heading", rank: 5 },
      { kind: "subgroup", group_anchor_block_id: "a-heading", rank: 2 },
      { kind: "direct", fragment_id: "frag-a1", rank: 7 },
      { kind: "direct", fragment_id: "frag-a1", rank: 3 },
    ]);
    expect(result.matches.map((match) => [match.kind, match.rank])).toEqual([
      ["document", 1],
      ["subgroup", 2],
      ["direct", 3],
    ]);
  });
});
