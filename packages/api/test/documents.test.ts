import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, STEAM_GID_NAMESPACE } from "@cs-patchnotes/shared";

const dir = mkdtempSync(join(tmpdir(), "cs-documents-"));
const dbPath = join(dir, "patchnotes.db");
const DOCUMENT_ID = "5a9afc25-7d9c-4da4-a9a4-488607624873";
const SOURCE_ID = "1e06dbef-166c-4c3d-bb1a-2842d42ea953";
const STEAM_GID = "1818118366178075";

const expectedDetail = {
  document: {
    id: DOCUMENT_ID,
    content_kind: "patch_notes",
    title: "Counter-Strike 2 Update",
    posted_at: 1_765_000_000,
    game: "cs2",
    channel: "mainline",
    parse_status: "partial",
  },
  blocks: [
    {
      id: `${DOCUMENT_ID}_b0`,
      parent_block_id: null,
      kind: "heading",
      preorder: 0,
      sibling_order: 0,
      text: null,
      label: "GAMEPLAY",
    },
    {
      id: `${DOCUMENT_ID}_b1`,
      parent_block_id: `${DOCUMENT_ID}_b0`,
      kind: "list",
      preorder: 1,
      sibling_order: 0,
      text: null,
      label: null,
    },
    {
      id: `${DOCUMENT_ID}_b2`,
      parent_block_id: `${DOCUMENT_ID}_b1`,
      kind: "patch_change",
      preorder: 2,
      sibling_order: 0,
      text: "Adjusted grenade behavior",
      label: null,
    },
    {
      id: `${DOCUMENT_ID}_b3`,
      parent_block_id: `${DOCUMENT_ID}_b0`,
      kind: "media_group",
      preorder: 3,
      sibling_order: 1,
      text: null,
      label: null,
    },
    {
      id: `${DOCUMENT_ID}_b4`,
      parent_block_id: `${DOCUMENT_ID}_b0`,
      kind: "unsupported",
      preorder: 4,
      sibling_order: 2,
      unsupported: {
        source_node_type: "mystery-widget",
        source_span: { start: 120, end: 156 },
        diagnostic_code: "unsupported_construct",
      },
    },
  ],
  media_items: [
    {
      id: `${DOCUMENT_ID}_m0`,
      group_block_id: `${DOCUMENT_ID}_b3`,
      item_order: 0,
      media_kind: "image",
      caption: "First view",
      alt_text: "First image",
    },
    {
      id: `${DOCUMENT_ID}_m1`,
      group_block_id: `${DOCUMENT_ID}_b3`,
      item_order: 1,
      media_kind: "image",
      caption: "Second view",
      alt_text: "Second image",
    },
  ],
};

function allObjectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allObjectKeys);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...allObjectKeys(child)]);
}

beforeAll(() => {
  process.env.SQLITE_PATH = dbPath;
  const db = openDb(dbPath);

  db.prepare(
    `INSERT INTO documents
       (id, content_kind, title, posted_at, game, channel, parse_status)
     VALUES (?, 'patch_notes', ?, ?, 'cs2', 'mainline', 'partial')`,
  ).run(DOCUMENT_ID, "Counter-Strike 2 Update", 1_765_000_000);

  db.prepare(
    `INSERT INTO external_identifiers (namespace, value, document_id, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(STEAM_GID_NAMESPACE, STEAM_GID, DOCUMENT_ID, 1_765_000_001);

  db.prepare(
    `INSERT INTO source_records
       (id, document_id, source_adapter, body_format, pristine_body, body_sha256, fetched_at)
     VALUES (?, ?, 'steam-news', 'bbcode', ?, ?, ?)`,
  ).run(
    SOURCE_ID,
    DOCUMENT_ID,
    "[p]<script>raw-source-secret</script>[/p]",
    "a".repeat(64),
    1_765_000_001,
  );
  db.prepare(
    `INSERT INTO document_source_heads
       (document_id, source_adapter, source_record_id, updated_at)
     VALUES (?, 'steam-news', ?, ?)`,
  ).run(DOCUMENT_ID, SOURCE_ID, 1_765_000_001);
  db.prepare(
    `INSERT INTO source_locators
       (id, document_id, source_record_id, namespace, locator, locator_kind, created_at)
     VALUES (?, ?, ?, 'steam_news_url', ?, 'publisher', ?)`,
  ).run(
    "9da22521-623e-4360-9b02-935542332366",
    DOCUMENT_ID,
    SOURCE_ID,
    "https://example.invalid/full-source-locator-secret",
    1_765_000_001,
  );

  const insertBlock = db.prepare(
    `INSERT INTO blocks
       (id, document_id, parent_block_id, kind, preorder, sibling_order, text, label,
        source_start, source_end, source_node_type, diagnostic_code)
     VALUES
       (@id, @document_id, @parent_block_id, @kind, @preorder, @sibling_order, @text, @label,
        @source_start, @source_end, @source_node_type, @diagnostic_code)`,
  );
  insertBlock.run({
    id: `${DOCUMENT_ID}_b0`, document_id: DOCUMENT_ID, parent_block_id: null,
    kind: "heading", preorder: 0, sibling_order: 0, text: null, label: "GAMEPLAY",
    source_start: 0, source_end: 10, source_node_type: "h2", diagnostic_code: null,
  });
  insertBlock.run({
    id: `${DOCUMENT_ID}_b1`, document_id: DOCUMENT_ID, parent_block_id: `${DOCUMENT_ID}_b0`,
    kind: "list", preorder: 1, sibling_order: 0, text: null, label: null,
    source_start: 11, source_end: 80, source_node_type: "list", diagnostic_code: null,
  });
  insertBlock.run({
    id: `${DOCUMENT_ID}_b2`, document_id: DOCUMENT_ID, parent_block_id: `${DOCUMENT_ID}_b1`,
    kind: "patch_change", preorder: 2, sibling_order: 0,
    text: "Adjusted grenade behavior", label: null,
    source_start: 20, source_end: 48, source_node_type: "list_item", diagnostic_code: null,
  });
  insertBlock.run({
    id: `${DOCUMENT_ID}_b3`, document_id: DOCUMENT_ID, parent_block_id: `${DOCUMENT_ID}_b0`,
    kind: "media_group", preorder: 3, sibling_order: 1, text: null, label: null,
    source_start: 81, source_end: 119, source_node_type: "carousel", diagnostic_code: null,
  });
  insertBlock.run({
    id: `${DOCUMENT_ID}_b4`, document_id: DOCUMENT_ID, parent_block_id: `${DOCUMENT_ID}_b0`,
    kind: "unsupported", preorder: 4, sibling_order: 2, text: null, label: null,
    source_start: 120, source_end: 156, source_node_type: "mystery-widget",
    diagnostic_code: "unsupported_construct",
  });

  const insertMedia = db.prepare(
    `INSERT INTO media_items
       (id, document_id, group_block_id, item_order, media_kind, original_locator,
        archive_locator, caption, alt_text, provenance_json)
     VALUES (?, ?, ?, ?, 'image', ?, ?, ?, ?, ?)`,
  );
  insertMedia.run(
    `${DOCUMENT_ID}_m0`, DOCUMENT_ID, `${DOCUMENT_ID}_b3`, 0,
    "https://example.invalid/original-locator-one", "https://example.invalid/archive-one",
    "First view", "First image", '{"raw":"media-provenance-secret"}',
  );
  insertMedia.run(
    `${DOCUMENT_ID}_m1`, DOCUMENT_ID, `${DOCUMENT_ID}_b3`, 1,
    "https://example.invalid/original-locator-two", null,
    "Second view", "Second image", null,
  );

  db.prepare(
    `INSERT INTO parse_runs
       (id, started_at, completed_at, status, attempted_count, partial_count)
     VALUES (?, ?, ?, 'succeeded', 1, 1)`,
  ).run("route-test-run", 1_765_000_001, 1_765_000_002);
  db.prepare(
    `INSERT INTO parse_diagnostics
       (id, parse_run_id, document_id, source_record_id, severity, code,
        source_start, source_end, details_json, created_at)
     VALUES (?, 'route-test-run', ?, ?, 'warning', 'unsupported_construct',
             120, 156, ?, ?)`,
  ).run(
    "9c2cc79f-accc-4f85-9411-f95ac3d58764",
    DOCUMENT_ID,
    SOURCE_ID,
    '{"raw_excerpt":"diagnostic-excerpt-secret"}',
    1_765_000_002,
  );

  db.close();
});

afterAll(() => {
  delete process.env.SQLITE_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe("canonical document detail", () => {
  test("canonical ID and Steam reference resolve the same source-neutral ordered detail", async () => {
    const { buildServer } = await import("../src/server.js");
    const app = buildServer();

    const canonical = await app.inject({ method: "GET", url: `/documents/${DOCUMENT_ID}` });
    const byReference = await app.inject({
      method: "GET",
      url: `/documents/by-ref/${STEAM_GID_NAMESPACE}/${STEAM_GID}`,
    });

    expect(canonical.statusCode).toBe(200);
    expect(byReference.statusCode).toBe(200);
    expect(canonical.json()).toEqual(expectedDetail);
    expect(byReference.json()).toEqual(expectedDetail);

    await app.close();
  });

  test("returns stable 400 and 404 responses for malformed or unknown references", async () => {
    const { buildServer } = await import("../src/server.js");
    const app = buildServer();

    const cases = [
      ["/documents/not-a-uuid", 400, { error: "invalid document reference" }],
      [`/documents/by-ref/not_a_public_namespace/${STEAM_GID}`, 400, { error: "invalid document reference" }],
      [`/documents/by-ref/${STEAM_GID_NAMESPACE}/not-a-gid`, 400, { error: "invalid document reference" }],
      [`/documents/by-ref/${STEAM_GID_NAMESPACE}/9999999999999999`, 404, { error: "document not found" }],
      ["/documents/4e18c7db-aa74-4f0e-9978-dded25ea6c35", 404, { error: "document not found" }],
    ] as const;

    for (const [url, statusCode, body] of cases) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(statusCode);
      expect(response.json(), url).toEqual(body);
    }

    await app.close();
  });

  test("exposes only typed plain canonical content and bounded unsupported metadata", async () => {
    const { buildServer } = await import("../src/server.js");
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: `/documents/${DOCUMENT_ID}` });
    const body = response.json();
    const keys = allObjectKeys(body);
    const serialized = JSON.stringify(body);

    expect(response.headers["content-type"]).toMatch(/^application\/json/);
    expect(keys).not.toEqual(expect.arrayContaining([
      "pristine_body",
      "raw_body",
      "original_locator",
      "archive_locator",
      "provenance_json",
      "details_json",
      "raw_excerpt",
      "html",
    ]));
    expect(serialized).not.toContain("raw-source-secret");
    expect(serialized).not.toContain("full-source-locator-secret");
    expect(serialized).not.toContain("media-provenance-secret");
    expect(serialized).not.toContain("diagnostic-excerpt-secret");

    const unsupported = body.blocks.find((block: { kind: string }) => block.kind === "unsupported");
    expect(unsupported).toEqual(expectedDetail.blocks[4]);
    expect(unsupported.unsupported.source_node_type.length).toBeLessThanOrEqual(64);
    expect(unsupported.unsupported.diagnostic_code.length).toBeLessThanOrEqual(64);

    await app.close();
  });
});
