import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { openDb } from "@cs-patchnotes/shared";

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
