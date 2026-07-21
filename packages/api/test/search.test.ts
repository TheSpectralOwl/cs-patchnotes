import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { MAX_HYDRATE_IDS, openDb } from "@cs-patchnotes/shared";

// Mock the server-side Meili factory so the route never needs a live Meili.
// The spy is hoisted so the mock factory (also hoisted) can close over it.
const searchMock = vi.hoisted(() => vi.fn());

vi.mock("../src/meili.js", () => ({
  buildMeili: () => ({
    index: () => ({ search: searchMock }),
  }),
}));

import { buildServer } from "../src/server.js";

const ORIGIN = "https://cs-patchnotes.pages.dev";
const dir = mkdtempSync(join(tmpdir(), "cs-search-hydration-"));
const dbPath = join(dir, "canonical.sqlite");

beforeAll(() => {
  process.env.SQLITE_PATH = dbPath;
  const db = openDb(dbPath);
  db.prepare(
    `INSERT INTO documents
       (id, content_kind, title, posted_at, game, channel, parse_status)
     VALUES
       ('doc-a', 'patch_notes', 'SQLite Alpha', 200, 'cs2', 'mainline', 'parsed'),
       ('doc-b', 'patch_notes', 'SQLite Beta', 200, 'csgo', 'mainline', 'parsed'),
       ('doc-c', 'patch_notes', 'SQLite Newest', 300, 'cs2', 'mainline', 'parsed')`,
  ).run();
  for (const [id, documentId, text] of [
    ["block-a", "doc-a", "SQLite authoritative alpha"],
    ["block-b", "doc-b", "SQLite authoritative beta"],
    ["block-c", "doc-c", "SQLite authoritative newest"],
  ]) {
    db.prepare(
      `INSERT INTO blocks
         (id, document_id, parent_block_id, kind, preorder, sibling_order, text)
       VALUES (?, ?, NULL, 'patch_change', 0, 0, ?)`,
    ).run(id, documentId, text);
    db.prepare(
      `INSERT INTO search_fragments
         (id, document_id, block_id, media_item_id, fragment_order, fragment_kind,
          text, text_sha256, group_anchor_block_id)
       VALUES (?, ?, ?, NULL, 0, 'block_text', ?, ?, NULL)`,
    ).run(
      `frag-${documentId.slice(-1)}`,
      documentId,
      id,
      text,
      "0".repeat(64),
    );
  }
  // Hydration only returns display data for documents whose current source head
  // is selected + complete, so the fixtures must carry that state.
  for (const [documentId, sourceRecordId, bodySha] of [
    ["doc-a", "src-a", "a".repeat(64)],
    ["doc-b", "src-b", "b".repeat(64)],
    ["doc-c", "src-c", "c".repeat(64)],
  ]) {
    db.prepare(
      `INSERT INTO source_records
         (id, document_id, source_adapter, body_format, pristine_body, body_sha256, fetched_at)
       VALUES (?, ?, 'steam_news', 'bbcode', '[b]body[/b]', ?, 100)`,
    ).run(sourceRecordId, documentId, bodySha);
    db.prepare(
      `INSERT INTO document_source_heads (document_id, source_adapter, source_record_id, updated_at)
       VALUES (?, 'steam_news', ?, 100)`,
    ).run(documentId, sourceRecordId);
    db.prepare(
      `INSERT INTO document_parse_state
         (document_id, source_adapter, source_record_id, selection_state,
          parser_key, parser_version, materialization_status, updated_at)
       VALUES (?, 'steam_news', ?, 'selected', 'steam-news-bbcode', '1', 'complete', 100)`,
    ).run(documentId, sourceRecordId);
  }
  db.close();
});

afterAll(() => {
  delete process.env.SQLITE_PATH;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  searchMock.mockReset();
  searchMock.mockResolvedValue({
    hits: [
      {
        id: "frag-a",
        fragment_id: "frag-a",
        block_id: "block-a",
        document_id: "doc-a",
        primary_release_id: null,
        group_anchor_block_id: null,
        fragment_kind: "block_text",
        content_kind: "patch_notes",
        posted_at: 200,
        game: "cs2",
        text: "STALE MEILI TEXT",
        title: "STALE MEILI TITLE",
        _matchesPosition: { text: [{ start: 0, length: 5 }] },
      },
    ],
    query: "",
  });
  process.env.WEB_ORIGIN = ORIGIN;
});

test("GET /search?q=grenade hydrates ranked identifiers from SQLite", async () => {
  const app = buildServer();
  const res = await app.inject({ method: "GET", url: "/search?q=grenade" });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.hits).toHaveLength(1);
  expect(body.hits[0]).toMatchObject({
    kind: "direct",
    rank: 0,
    document_id: "doc-a",
    fragment_id: "frag-a",
    representative_text: "SQLite authoritative alpha",
    context: { document: { title: "SQLite Alpha" } },
  });
  expect(searchMock).toHaveBeenCalledWith(
    "grenade",
    expect.objectContaining({
      limit: 20,
      filter: "content_kind = patch_notes",
      showMatchesPosition: true,
    }),
  );
  expect(searchMock).toHaveBeenCalledTimes(1);
  expect(searchMock.mock.calls[0]?.[1]?.attributesToRetrieve).toEqual(
    expect.arrayContaining(["text", "title", "ancestor_labels"]),
  );
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain("STALE MEILI TEXT");
  expect(serialized).not.toContain("STALE MEILI TITLE");
  expect(serialized).not.toContain("_matchesPosition");
  expect(serialized).not.toContain("pristine_body");
  expect(serialized).not.toContain("source_locator");
  expect(serialized).not.toContain("diagnostic");
  expect(serialized).not.toContain("MEILI_MASTER_KEY");
  await app.close();
});

test("title-restricted evidence produces one earliest-rank SQLite document representative", async () => {
  const titleHit = {
    id: "frag-a",
    fragment_id: "frag-a",
    block_id: "block-a",
    document_id: "doc-a",
    primary_release_id: null,
    group_anchor_block_id: null,
    fragment_kind: "block_text",
    content_kind: "patch_notes",
    posted_at: 200,
    _matchesPosition: { title: [{ start: 0, length: 12 }] },
  };
  searchMock.mockResolvedValueOnce({ hits: [titleHit, { ...titleHit }], query: "SQLite Alpha" });

  const app = buildServer();
  const res = await app.inject({
    method: "GET",
    url: "/search?q=SQLite%20Alpha&limit=20",
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().hits).toHaveLength(1);
  expect(res.json().hits[0]).toMatchObject({
    kind: "document",
    rank: 0,
    document_id: "doc-a",
    representative_text: "SQLite Alpha",
  });
  expect(searchMock.mock.calls[0]?.[1]).toEqual(
    expect.objectContaining({
      attributesToRetrieve: expect.arrayContaining(["title"]),
      showMatchesPosition: true,
    }),
  );
  await app.close();
});

test("empty search ignores match metadata, deduplicates documents, and uses stable newest-first order", async () => {
  searchMock.mockResolvedValueOnce({
    hits: [
      {
        id: "frag-b",
        fragment_id: "frag-b",
        block_id: "block-b",
        document_id: "doc-b",
        primary_release_id: null,
        group_anchor_block_id: null,
        fragment_kind: "block_text",
        content_kind: "patch_notes",
        posted_at: 200,
      },
      {
        id: "frag-c",
        fragment_id: "frag-c",
        block_id: "block-c",
        document_id: "doc-c",
        primary_release_id: null,
        group_anchor_block_id: null,
        fragment_kind: "block_text",
        content_kind: "patch_notes",
        posted_at: 300,
        _matchesPosition: {},
      },
      {
        id: "frag-a",
        fragment_id: "frag-a",
        block_id: "block-a",
        document_id: "doc-a",
        primary_release_id: null,
        group_anchor_block_id: null,
        fragment_kind: "block_text",
        content_kind: "patch_notes",
        posted_at: 200,
        _matchesPosition: {},
      },
      {
        id: "frag-c-repeat",
        fragment_id: "frag-c",
        block_id: "block-c",
        document_id: "doc-c",
        primary_release_id: null,
        group_anchor_block_id: null,
        fragment_kind: "block_text",
        content_kind: "patch_notes",
        posted_at: 300,
      },
    ],
  });
  const app = buildServer();
  const res = await app.inject({ method: "GET", url: "/search" });
  expect(res.statusCode).toBe(200);
  expect(searchMock).toHaveBeenCalledWith(
    "",
    expect.objectContaining({
      filter: "content_kind = patch_notes",
      sort: ["posted_at:desc"],
    }),
  );
  expect(res.json().hits.map((match: { document_id: string }) => match.document_id)).toEqual([
    "doc-c",
    "doc-a",
    "doc-b",
  ]);
  expect(res.json().hits.map((match: { kind: string }) => match.kind)).toEqual([
    "document",
    "document",
    "document",
  ]);
  await app.close();
});

test("GET /search clamps an over-limit `limit` to <= 50", async () => {
  const app = buildServer();
  const res = await app.inject({ method: "GET", url: "/search?q=x&limit=999" });
  expect(res.statusCode).toBe(200);
  const opts = searchMock.mock.calls[0]?.[1] as { limit: number };
  expect(opts.limit).toBeLessThanOrEqual(50);
  expect(opts.limit).toBe(50);
  await app.close();
});

test("a maximally amplified 50-hit window stays bounded and reports truncation", async () => {
  // Every hit matches title (-> document), own non-heading text (-> direct), and
  // ancestor_labels (-> subgroup): three independent requests per hit. 50 hits
  // therefore collapse to 150 requests, above the hydration cap.
  const hits = Array.from({ length: 50 }, (_, i) => ({
    id: `frag-${i}`,
    fragment_id: `frag-${i}`,
    block_id: `block-${i}`,
    document_id: `doc-${i}`,
    primary_release_id: null,
    group_anchor_block_id: `anchor-${i}`,
    fragment_kind: "block_text",
    content_kind: "patch_notes",
    posted_at: 200,
    _matchesPosition: {
      title: [{ start: 0, length: 3 }],
      text: [{ start: 0, length: 3 }],
      ancestor_labels: [{ start: 0, length: 3 }],
    },
  }));
  searchMock.mockResolvedValueOnce({ hits, query: "amplify" });

  const app = buildServer();
  const res = await app.inject({ method: "GET", url: "/search?q=amplify&limit=50" });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.hits.length).toBeLessThanOrEqual(MAX_HYDRATE_IDS);
  expect(body.truncation).toMatchObject({
    truncated: true,
    request_count: 150,
    hydrated_count: MAX_HYDRATE_IDS,
    dropped_count: 150 - MAX_HYDRATE_IDS,
  });
  await app.close();
});

test("a window that fits within the hydration budget reports no truncation", async () => {
  const app = buildServer();
  const res = await app.inject({ method: "GET", url: "/search?q=grenade" });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.truncation).toMatchObject({
    truncated: false,
    dropped_count: 0,
  });
  expect(body.truncation.hydrated_count).toBe(body.truncation.request_count);
  await app.close();
});

test("GET /search carries an Access-Control-Allow-Origin header for the SPA origin", async () => {
  const app = buildServer();
  const res = await app.inject({
    method: "GET",
    url: "/search?q=grenade",
    headers: { origin: ORIGIN },
  });
  expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
  await app.close();
});
