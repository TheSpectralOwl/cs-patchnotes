import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  blockId,
  fragmentId,
  openDb,
  upsertSteamSourceRecord,
  type Game,
} from "@cs-patchnotes/shared";
import type {
  CanonicalBlockData,
  CanonicalMediaItemData,
  CanonicalParseOutput,
  DetectionEvidence,
  RegisteredParser,
} from "../src/parse/contract.js";
import { buildSearchFragments, GROUPING_POLICY_VERSION } from "../src/parse/fragments.js";
import { ParserRegistry } from "../src/parse/registry.js";
import { parseStoredDocuments } from "../src/parse.js";

function block(
  kind: CanonicalBlockData["kind"],
  parentIndex: number | null,
  text: string | null,
  label: string | null,
  start: number,
): CanonicalBlockData {
  return {
    kind,
    parentIndex,
    text,
    label,
    sourceSpan: { start, end: start + 1 },
    sourceNodeType: kind,
    diagnosticCode: kind === "unsupported" ? "UNSUPPORTED_CONSTRUCT" : null,
  };
}

const POLICY_BLOCKS: CanonicalBlockData[] = [
  block("heading", null, "MAPS", "MAPS", 0),
  block("heading", 0, "Mirage", "Mirage", 1),
  block("list", 1, null, null, 2),
  block("patch_change", 2, "Widened connector", null, 3),
  block("unsupported", 1, null, null, 4),
  block("media_group", 1, null, null, 5),
  block("paragraph", null, "Standalone prose", null, 6),
];

const POLICY_MEDIA: CanonicalMediaItemData[] = [
  {
    groupBlockIndex: 5,
    mediaKind: "image",
    originalLocator: "https://cdn.example.test/private-file.png",
    archiveLocator: null,
    caption: "Visible overview",
    altText: "secret-alt-text",
    sourceSpan: { start: 5, end: 6 },
  },
  {
    groupBlockIndex: 5,
    mediaKind: "image",
    originalLocator: "https://cdn.example.test/uncaptioned.png",
    archiveLocator: null,
    caption: null,
    altText: "also-secret",
    sourceSpan: { start: 5, end: 6 },
  },
];

function parser(
  key: string,
  version: string,
  marker: string,
  output: () => CanonicalParseOutput,
): RegisteredParser {
  return {
    key,
    version,
    detect: (source): DetectionEvidence => ({
      matched: source.pristineBody.includes(marker),
      codes: [source.pristineBody.includes(marker) ? "MATCH" : "MISS"],
      spans: [],
      details: {},
    }),
    parse: output,
  };
}

function seed(db: ReturnType<typeof openDb>, gid: string, body: string, game: Game = "cs2"): string {
  return upsertSteamSourceRecord(db, {
    gid,
    url: `https://example.test/${gid}`,
    title: `Update ${gid}`,
    posted_at: 1_700_000_000,
    game,
    channel: "mainline",
    content_kind: "patch_notes",
    source_adapter: "steam_news",
    body_format: "plain_text",
    pristine_body: body,
    fetched_at: 1_700_000_000,
  }).document.id;
}

function output(text: string): CanonicalParseOutput {
  return {
    status: "complete",
    blocks: [block("heading", null, "MISC", "MISC", 0), block("patch_change", 0, text, null, 1)],
    diagnostics: [],
  };
}

function rows(db: ReturnType<typeof openDb>, documentId: string) {
  return {
    blocks: db.prepare("SELECT * FROM blocks WHERE document_id = ? ORDER BY preorder").all(documentId),
    fragments: db.prepare("SELECT * FROM search_fragments WHERE document_id = ? ORDER BY fragment_order").all(documentId),
    ancestors: db.prepare("SELECT a.* FROM fragment_ancestors a JOIN search_fragments f ON f.id = a.fragment_id WHERE f.document_id = ? ORDER BY f.fragment_order, a.depth").all(documentId),
  };
}

describe("parser-independent fragment policy", () => {
  test("emits own visible text, one shared heading anchor, full ancestors, and caption-only media text", () => {
    const fragments = buildSearchFragments(POLICY_BLOCKS, POLICY_MEDIA);

    expect(GROUPING_POLICY_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(fragments.map((fragment) => ({
      block: fragment.blockIndex,
      media: fragment.mediaItemIndex,
      kind: fragment.fragmentKind,
      text: fragment.text,
      anchor: fragment.groupAnchorBlockIndex,
      ancestors: fragment.ancestors,
    }))).toEqual([
      { block: 0, media: null, kind: "block_text", text: "MAPS", anchor: 0, ancestors: [] },
      { block: 1, media: null, kind: "block_text", text: "Mirage", anchor: 1, ancestors: [{ blockIndex: 0, label: "MAPS" }] },
      { block: 3, media: null, kind: "block_text", text: "Widened connector", anchor: 1, ancestors: [{ blockIndex: 0, label: "MAPS" }, { blockIndex: 1, label: "Mirage" }, { blockIndex: 2, label: "" }] },
      { block: 5, media: 0, kind: "media_caption", text: "Visible overview", anchor: 1, ancestors: [{ blockIndex: 0, label: "MAPS" }, { blockIndex: 1, label: "Mirage" }] },
      { block: 6, media: null, kind: "block_text", text: "Standalone prose", anchor: null, ancestors: [] },
    ]);
    const allText = fragments.map((fragment) => fragment.text).join("\n");
    expect(allText).not.toMatch(/private-file|uncaptioned|secret-alt|https?:\/\//);
    expect(fragments.some((fragment) => fragment.blockIndex === 4)).toBe(false);
  });
});

describe("transactional canonical materialization", () => {
  test("persists deterministic IDs, group anchors, and ordered ancestor IDs without breadcrumb mutation", () => {
    const db = openDb(":memory:");
    const documentId = seed(db, "policy", "POLICY");
    const canonical = parser("policy", "1.0.0", "POLICY", () => ({ status: "complete", blocks: POLICY_BLOCKS, mediaItems: POLICY_MEDIA, diagnostics: [] }));

    const summary = parseStoredDocuments(db, new ParserRegistry([canonical]), { runId: "materialize-policy", now: () => 10 });
    expect(summary).toMatchObject({ materialized: 1, gateFailed: false });
    const persisted = rows(db, documentId) as {
      blocks: Array<{ id: string }>;
      fragments: Array<{ id: string; block_id: string; text: string; group_anchor_block_id: string | null }>;
      ancestors: Array<{ fragment_id: string; depth: number; ancestor_block_id: string; label: string }>;
    };

    expect(persisted.blocks.map((row) => row.id)).toEqual(POLICY_BLOCKS.map((_, index) => blockId(documentId, index)));
    expect(persisted.fragments.map((row) => row.id)).toEqual(persisted.fragments.map((_, index) => fragmentId(documentId, index)));
    expect(persisted.fragments.find((row) => row.text === "Widened connector")).toMatchObject({
      block_id: blockId(documentId, 3),
      group_anchor_block_id: blockId(documentId, 1),
    });
    expect(persisted.fragments.find((row) => row.text === "Widened connector")?.text).toBe("Widened connector");
    const detailId = persisted.fragments.find((row) => row.text === "Widened connector")!.id;
    expect(persisted.ancestors.filter((row) => row.fragment_id === detailId)).toEqual([
      { fragment_id: detailId, depth: 0, ancestor_block_id: blockId(documentId, 0), label: "MAPS" },
      { fragment_id: detailId, depth: 1, ancestor_block_id: blockId(documentId, 1), label: "Mirage" },
      { fragment_id: detailId, depth: 2, ancestor_block_id: blockId(documentId, 2), label: "" },
    ]);
    db.close();
  });

  test("exact tuple replay performs no derived writes and preserves IDs plus a sentinel tag", () => {
    const db = openDb(":memory:");
    const documentId = seed(db, "noop", "MATCH");
    const stable = parser("stable", "1.2.3", "MATCH", () => output("Stable detail"));
    parseStoredDocuments(db, new ParserRegistry([stable]), { runId: "noop-first", now: () => 20 });
    const before = rows(db, documentId);
    const taggedFragment = fragmentId(documentId, 1);
    db.prepare("INSERT INTO fragment_tags (fragment_id, kind, value, source, confidence) VALUES (?, 'category', 'sentinel', 'test', 1)").run(taggedFragment);

    db.exec(`
      CREATE TEMP TABLE derived_writes (operation TEXT NOT NULL);
      CREATE TEMP TRIGGER count_block_insert AFTER INSERT ON blocks BEGIN INSERT INTO derived_writes VALUES ('block-insert'); END;
      CREATE TEMP TRIGGER count_block_delete AFTER DELETE ON blocks BEGIN INSERT INTO derived_writes VALUES ('block-delete'); END;
      CREATE TEMP TRIGGER count_fragment_insert AFTER INSERT ON search_fragments BEGIN INSERT INTO derived_writes VALUES ('fragment-insert'); END;
      CREATE TEMP TRIGGER count_fragment_delete AFTER DELETE ON search_fragments BEGIN INSERT INTO derived_writes VALUES ('fragment-delete'); END;
    `);

    const summary = parseStoredDocuments(db, new ParserRegistry([stable]), { runId: "noop-second", now: () => 21 });
    expect(summary).toMatchObject({ attempted: 1, selected: 1, unchanged: 1, materialized: 0 });
    expect(db.prepare("SELECT * FROM derived_writes").all()).toEqual([]);
    expect(rows(db, documentId)).toEqual(before);
    expect(db.prepare("SELECT value FROM fragment_tags WHERE fragment_id = ?").get(taggedFragment)).toEqual({ value: "sentinel" });
    const state = db.prepare("SELECT grouping_policy_version FROM document_parse_state WHERE document_id = ?").get(documentId);
    expect(state).toEqual({ grouping_policy_version: GROUPING_POLICY_VERSION });
    db.close();
  });

  test("a changed source replaces only its document and leaves another document byte-stable", () => {
    const db = openDb(":memory:");
    const firstId = seed(db, "first", "FIRST");
    const secondId = seed(db, "second", "SECOND");
    const version = new ParserRegistry([
      parser("first", "1", "FIRST", () => output("First old")),
      parser("second", "1", "SECOND", () => output("Second stable")),
    ]);
    parseStoredDocuments(db, version, { runId: "replace-first", now: () => 30 });
    const secondBefore = rows(db, secondId);

    seed(db, "first", "FIRST changed");
    const changed = new ParserRegistry([
      parser("first", "1", "FIRST", () => output("First new")),
      parser("second", "1", "SECOND", () => output("Second stable")),
    ]);
    const summary = parseStoredDocuments(db, changed, { runId: "replace-second", now: () => 31 });

    expect(summary).toMatchObject({ attempted: 2, unchanged: 1, materialized: 1 });
    expect(rows(db, secondId)).toEqual(secondBefore);
    expect((rows(db, firstId).fragments as Array<{ text: string }>).map((row) => row.text)).toContain("First new");
    db.close();
  });

  test("validates before writes and rolls a failed replacement back while continuing the pass", () => {
    const db = openDb(":memory:");
    const goodId = seed(db, "good", "GOOD");
    const badId = seed(db, "bad", "BAD");
    const initial = new ParserRegistry([
      parser("good", "1", "GOOD", () => output("Good old")),
      parser("bad", "1", "BAD", () => output("Bad old")),
    ]);
    parseStoredDocuments(db, initial, { runId: "rollback-initial", now: () => 40 });
    const badBefore = rows(db, badId);

    db.exec(`CREATE TEMP TRIGGER reject_bad_fragment BEFORE INSERT ON search_fragments
      WHEN NEW.document_id = '${badId}' AND NEW.text = 'Bad new'
      BEGIN SELECT RAISE(ABORT, 'deliberate fragment write failure'); END;`);
    const changed = new ParserRegistry([
      parser("good", "2", "GOOD", () => output("Good new")),
      parser("bad", "2", "BAD", () => output("Bad new")),
    ]);
    const summary = parseStoredDocuments(db, changed, { runId: "rollback-changed", now: () => 41 });

    expect(summary).toMatchObject({ attempted: 2, selected: 2, materialized: 1, errors: 1, gateFailed: true });
    expect((rows(db, goodId).fragments as Array<{ text: string }>).map((row) => row.text)).toContain("Good new");
    expect(rows(db, badId)).toEqual(badBefore);

    db.exec("DROP TRIGGER reject_bad_fragment");
    const invalid = parser("bad", "3", "BAD", () => ({
      status: "complete",
      blocks: [block("patch_change", 99, "Invalid parent", null, 0)],
      diagnostics: [],
    }));
    const validation = parseStoredDocuments(db, new ParserRegistry([invalid]), { runId: "rollback-validation", now: () => 42 });
    expect(validation).toMatchObject({ attempted: 2, errors: 1, quarantined: 1, materialized: 0, gateFailed: true });
    expect(rows(db, badId)).toEqual(badBefore);
    db.close();
  });
});
