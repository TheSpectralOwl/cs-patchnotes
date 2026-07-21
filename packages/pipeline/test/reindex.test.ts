import { expect, test } from "vitest";
import {
  openDb,
  type FragmentMatchPresence,
  type MeiliFragmentDocument,
  type RankedFragmentHit,
} from "@cs-patchnotes/shared";
import type { Meilisearch } from "meilisearch";
import {
  ensureIndexAndSettings,
  reindexFromSqlite,
  rebuild,
  buildFragmentDocs,
} from "../src/reindex.js";
import { COMMANDS } from "../src/cli.js";

interface StubState {
  indexUids: string[];
  deletedUids: string[];
  searchable: string[];
  displayed: string[];
  sortable: string[];
  filterable: string[];
  primaryKeys: Array<string | undefined>;
  batches: MeiliFragmentDocument[][];
  order: Array<"delete" | "settings" | "load" | "clear">;
  /**
   * Ids the disposable index currently holds. Models Meili's document set so a
   * test can seed a stale id and assert an exact-mirror reindex removes it.
   */
  documentIds: Set<string>;
}

type FailingOperation =
  | "delete"
  | "searchable"
  | "displayed"
  | "sortable"
  | "filterable"
  | "load"
  | "clear";

function makeStubClient(failing?: FailingOperation): { client: Meilisearch; state: StubState } {
  const state: StubState = {
    indexUids: [],
    deletedUids: [],
    searchable: [],
    displayed: [],
    sortable: [],
    filterable: [],
    primaryKeys: [],
    batches: [],
    order: [],
    documentIds: new Set<string>(),
  };

  const task = (
    operation: FailingOperation,
    label: "delete" | "settings" | "load" | "clear",
  ) => ({
    waitTask: async () => {
      state.order.push(label);
      return operation === failing
        ? { uid: 41, status: "failed", error: { message: `${operation} rejected` } }
        : { uid: 40, status: "succeeded" };
    },
  });

  const index = {
    updateSearchableAttributes: (attributes: string[]) => {
      state.searchable = attributes;
      return task("searchable", "settings");
    },
    updateDisplayedAttributes: (attributes: string[]) => {
      state.displayed = attributes;
      return task("displayed", "settings");
    },
    updateSortableAttributes: (attributes: string[]) => {
      state.sortable = attributes;
      return task("sortable", "settings");
    },
    updateFilterableAttributes: (attributes: string[]) => {
      state.filterable = attributes;
      return task("filterable", "settings");
    },
    deleteAllDocuments: () => {
      state.documentIds.clear();
      return task("clear", "clear");
    },
    addDocuments: (documents: MeiliFragmentDocument[], options?: { primaryKey?: string }) => {
      state.batches.push(documents);
      state.primaryKeys.push(options?.primaryKey);
      for (const document of documents) state.documentIds.add(document.id);
      return task("load", "load");
    },
  };

  const client = {
    index: (uid: string) => {
      state.indexUids.push(uid);
      return index;
    },
    deleteIndex: (uid: string) => {
      state.deletedUids.push(uid);
      return task("delete", "delete");
    },
  };

  return { client: client as unknown as Meilisearch, state };
}

/**
 * Bind a document to a current source head whose parse state is selected +
 * complete. The projection guard only emits fragments for a head in this state,
 * so the canonical fixtures must carry it to stay projectable.
 */
function seedSelectedCompleteHead(
  db: ReturnType<typeof openDb>,
  documentId: string,
  sourceRecordId: string,
  bodySha: string,
  fetchedAt: number,
): void {
  db.prepare(
    `INSERT INTO source_records
       (id, document_id, source_adapter, body_format, pristine_body, body_sha256, fetched_at)
     VALUES (?, ?, 'steam_news', 'bbcode', '[b]body[/b]', ?, ?)`,
  ).run(sourceRecordId, documentId, bodySha, fetchedAt);
  db.prepare(
    `INSERT INTO document_source_heads (document_id, source_adapter, source_record_id, updated_at)
     VALUES (?, 'steam_news', ?, ?)`,
  ).run(documentId, sourceRecordId, fetchedAt);
  db.prepare(
    `INSERT INTO document_parse_state
       (document_id, source_adapter, source_record_id, selection_state,
        parser_key, parser_version, materialization_status, updated_at)
     VALUES (?, 'steam_news', ?, 'selected', 'steam-news-bbcode', '1', 'complete', ?)`,
  ).run(documentId, sourceRecordId, fetchedAt);
}

function seedCanonicalProjection(db: ReturnType<typeof openDb>): MeiliFragmentDocument[] {
  db.prepare(
    `INSERT INTO documents (id, content_kind, title, posted_at, game, channel, parse_status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("doc_alpha", "patch_notes", "Counter-Strike 2 Update", 1_700_000_000, "cs2", "mainline", "parsed");
  seedSelectedCompleteHead(db, "doc_alpha", "src_alpha", "c".repeat(64), 1_700_000_000);

  const insertBlock = db.prepare(
    `INSERT INTO blocks
       (id, document_id, parent_block_id, kind, preorder, sibling_order, text, label)
     VALUES (?, 'doc_alpha', ?, ?, ?, ?, ?, ?)`,
  );
  insertBlock.run("block_maps", null, "heading", 0, 0, "MAPS", "MAPS");
  insertBlock.run("block_mirage", "block_maps", "heading", 1, 0, "Mirage", "Mirage");
  insertBlock.run("block_change", "block_mirage", "patch_change", 2, 0, "Widened connector", null);
  insertBlock.run("block_gallery", "block_maps", "media_group", 3, 1, null, null);
  insertBlock.run("block_silent_media", "block_maps", "media_group", 4, 2, null, null);
  insertBlock.run("block_unsupported", "block_maps", "unsupported", 5, 3, null, null);
  insertBlock.run("block_list", "block_maps", "list", 6, 4, null, null);

  const insertMedia = db.prepare(
    `INSERT INTO media_items
       (id, document_id, group_block_id, item_order, media_kind, original_locator, caption, alt_text, provenance_json)
     VALUES (?, 'doc_alpha', ?, 0, 'image', ?, ?, ?, ?)`,
  );
  insertMedia.run(
    "media_captioned",
    "block_gallery",
    "https://cdn.example.test/smoke.png",
    "New smoke preview",
    "locator-only alt text",
    '{"raw":"diagnostic must stay in SQLite"}',
  );
  insertMedia.run(
    "media_silent",
    "block_silent_media",
    "https://cdn.example.test/filename-secret.png",
    null,
    "not searchable",
    null,
  );

  const insertFragment = db.prepare(
    `INSERT INTO search_fragments
       (id, document_id, block_id, media_item_id, fragment_order, fragment_kind, text, text_sha256, group_anchor_block_id)
     VALUES (?, 'doc_alpha', ?, ?, ?, ?, ?, ?, ?)`,
  );
  const digest = "a".repeat(64);
  insertFragment.run("fragment_maps", "block_maps", null, 0, "block_text", "MAPS", digest, "block_maps");
  insertFragment.run("fragment_mirage", "block_mirage", null, 1, "block_text", "Mirage", digest, "block_mirage");
  insertFragment.run(
    "fragment_change",
    "block_change",
    null,
    2,
    "block_text",
    "Widened connector",
    digest,
    "block_mirage",
  );
  insertFragment.run(
    "fragment_caption",
    "block_gallery",
    "media_captioned",
    3,
    "media_caption",
    "New smoke preview",
    digest,
    "block_maps",
  );

  const insertAncestor = db.prepare(
    `INSERT INTO fragment_ancestors
       (fragment_id, document_id, depth, ancestor_block_id, label)
     VALUES (?, 'doc_alpha', ?, ?, ?)`,
  );
  insertAncestor.run("fragment_mirage", 0, "block_maps", "MAPS");
  insertAncestor.run("fragment_change", 0, "block_maps", "MAPS");
  insertAncestor.run("fragment_change", 1, "block_mirage", "Mirage");
  insertAncestor.run("fragment_caption", 0, "block_maps", "MAPS");

  const insertTag = db.prepare(
    `INSERT INTO fragment_tags (fragment_id, kind, value, source, confidence)
     VALUES ('fragment_change', ?, ?, 'rules', 1)`,
  );
  insertTag.run("category", "maps");
  insertTag.run("category", "gameplay");
  insertTag.run("entity", "Mirage");

  return [
    {
      id: "fragment_maps",
      fragment_id: "fragment_maps",
      block_id: "block_maps",
      document_id: "doc_alpha",
      primary_release_id: null,
      group_anchor_block_id: "block_maps",
      text: "MAPS",
      fragment_kind: "block_text",
      content_kind: "patch_notes",
      title: "Counter-Strike 2 Update",
      game: "cs2",
      posted_at: 1_700_000_000,
      ancestor_ids: [],
      ancestor_labels: [],
      categories: [],
      entities: [],
    },
    {
      id: "fragment_mirage",
      fragment_id: "fragment_mirage",
      block_id: "block_mirage",
      document_id: "doc_alpha",
      primary_release_id: null,
      group_anchor_block_id: "block_mirage",
      text: "Mirage",
      fragment_kind: "block_text",
      content_kind: "patch_notes",
      title: "Counter-Strike 2 Update",
      game: "cs2",
      posted_at: 1_700_000_000,
      ancestor_ids: ["block_maps"],
      ancestor_labels: ["MAPS"],
      categories: [],
      entities: [],
    },
    {
      id: "fragment_change",
      fragment_id: "fragment_change",
      block_id: "block_change",
      document_id: "doc_alpha",
      primary_release_id: null,
      group_anchor_block_id: "block_mirage",
      text: "Widened connector",
      fragment_kind: "block_text",
      content_kind: "patch_notes",
      title: "Counter-Strike 2 Update",
      game: "cs2",
      posted_at: 1_700_000_000,
      ancestor_ids: ["block_maps", "block_mirage"],
      ancestor_labels: ["MAPS", "Mirage"],
      categories: ["gameplay", "maps"],
      entities: ["Mirage"],
    },
    {
      id: "fragment_caption",
      fragment_id: "fragment_caption",
      block_id: "block_gallery",
      document_id: "doc_alpha",
      primary_release_id: null,
      group_anchor_block_id: "block_maps",
      text: "New smoke preview",
      fragment_kind: "media_caption",
      content_kind: "patch_notes",
      title: "Counter-Strike 2 Update",
      game: "cs2",
      posted_at: 1_700_000_000,
      ancestor_ids: ["block_maps"],
      ancestor_labels: ["MAPS"],
      categories: [],
      entities: [],
    },
  ];
}

function seedManyFragments(db: ReturnType<typeof openDb>, count: number): void {
  db.prepare(
    `INSERT INTO documents (id, content_kind, title, posted_at, game, channel, parse_status)
     VALUES ('doc_many', 'patch_notes', 'Large Update', 1700000001, 'cs2', 'mainline', 'parsed')`,
  ).run();
  seedSelectedCompleteHead(db, "doc_many", "src_many", "d".repeat(64), 1_700_000_001);
  db.prepare(
    `INSERT INTO blocks (id, document_id, kind, preorder, sibling_order, text, label)
     VALUES ('block_many_root', 'doc_many', 'heading', 0, 0, 'ROOT', 'ROOT')`,
  ).run();

  const insertBlock = db.prepare(
    `INSERT INTO blocks
       (id, document_id, parent_block_id, kind, preorder, sibling_order, text)
     VALUES (?, 'doc_many', 'block_many_root', 'patch_change', ?, ?, ?)`,
  );
  const insertFragment = db.prepare(
    `INSERT INTO search_fragments
       (id, document_id, block_id, fragment_order, fragment_kind, text, text_sha256, group_anchor_block_id)
     VALUES (?, 'doc_many', ?, ?, 'block_text', ?, ?, 'block_many_root')`,
  );
  const insert = db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const blockId = `block_many_${index}`;
      const fragmentId = `fragment_many_${index}`;
      const text = `Change ${index}`;
      insertBlock.run(blockId, index + 1, index, text);
      insertFragment.run(fragmentId, blockId, index, text, "b".repeat(64));
    }
  });
  insert();
}

/**
 * A document whose blocks/fragments were materialized by a prior parse but whose
 * CURRENT source head is now quarantined (zero-match). SQLite keeps the obsolete
 * rows as private history; the projection must not expose them.
 */
function seedQuarantinedDocument(db: ReturnType<typeof openDb>): void {
  db.prepare(
    `INSERT INTO documents (id, content_kind, title, posted_at, game, channel, parse_status)
     VALUES ('doc_quar', 'patch_notes', 'Superseded Update', 1700000002, 'cs2', 'mainline', 'quarantined')`,
  ).run();
  db.prepare(
    `INSERT INTO source_records
       (id, document_id, source_adapter, body_format, pristine_body, body_sha256, fetched_at)
     VALUES ('src_quar', 'doc_quar', 'steam_news', 'bbcode', '[b]no longer parses[/b]', ?, 1700000002)`,
  ).run("e".repeat(64));
  db.prepare(
    `INSERT INTO document_source_heads (document_id, source_adapter, source_record_id, updated_at)
     VALUES ('doc_quar', 'steam_news', 'src_quar', 1700000002)`,
  ).run();
  // Current head parse state is quarantined: not selected, not complete.
  db.prepare(
    `INSERT INTO document_parse_state
       (document_id, source_adapter, source_record_id, selection_state,
        materialization_status, updated_at)
     VALUES ('doc_quar', 'steam_news', 'src_quar', 'quarantined_zero_match', 'unparsed', 1700000002)`,
  ).run();
  // Retained obsolete materialization from the prior selected+complete parse.
  db.prepare(
    `INSERT INTO blocks (id, document_id, parent_block_id, kind, preorder, sibling_order, text, label)
     VALUES ('block_quar', 'doc_quar', NULL, 'heading', 0, 0, 'OLD CONTENT', 'OLD CONTENT')`,
  ).run();
  db.prepare(
    `INSERT INTO search_fragments
       (id, document_id, block_id, media_item_id, fragment_order, fragment_kind, text, text_sha256, group_anchor_block_id)
     VALUES ('fragment_quar', 'doc_quar', 'block_quar', NULL, 0, 'block_text', 'OLD CONTENT', ?, 'block_quar')`,
  ).run("f".repeat(64));
}

test("a full reindex deletes stale ids so the index exactly mirrors sqlite fragments", async () => {
  const db = openDb(":memory:");
  seedCanonicalProjection(db);
  const projected = buildFragmentDocs(db);
  const { client, state } = makeStubClient();
  // A document the current SQLite projection does not produce, left over from an
  // earlier index generation.
  state.documentIds.add("fragment_ghost_stale");

  await reindexFromSqlite(client, db);

  expect(state.documentIds.has("fragment_ghost_stale")).toBe(false);
  expect(state.documentIds.size).toBe(projected.length);
  db.close();
});

test("excludes fragments whose current source head is quarantined", async () => {
  const db = openDb(":memory:");
  seedCanonicalProjection(db);
  seedQuarantinedDocument(db);
  const { client, state } = makeStubClient();

  const docs = buildFragmentDocs(db);
  expect(docs.some((document) => document.id === "fragment_quar")).toBe(false);
  expect(docs.some((document) => document.document_id === "doc_quar")).toBe(false);

  await reindexFromSqlite(client, db);
  expect(state.documentIds.has("fragment_quar")).toBe(false);
  db.close();
});

test("projects exactly one allowed document per canonical search fragment", async () => {
  const db = openDb(":memory:");
  const expected = seedCanonicalProjection(db);
  const { client, state } = makeStubClient();

  const result = await reindexFromSqlite(client, db);
  const documents = state.batches.flat();

  expect(result.documents).toBe(expected.length);
  expect(documents).toEqual(expected);
  expect(new Set(documents.map((document) => document.title))).toEqual(
    new Set(["Counter-Strike 2 Update"]),
  );
  expect(documents[2]).toMatchObject({
    text: "Widened connector",
    title: "Counter-Strike 2 Update",
    ancestor_labels: ["MAPS", "Mirage"],
  });
  expect(documents[2].text).not.toContain(documents[2].title);
  expect(documents[2].text).not.toContain(documents[2].ancestor_labels.join(" "));

  for (const document of documents as Array<Record<string, unknown>>) {
    expect(document).not.toHaveProperty("url");
    expect(document).not.toHaveProperty("source_locator");
    expect(document).not.toHaveProperty("filename");
    expect(document).not.toHaveProperty("alt_text");
    expect(document).not.toHaveProperty("pristine_body");
    expect(document).not.toHaveProperty("diagnostic_code");
    expect(document).not.toHaveProperty("matched_fields");
  }

  db.close();
});

test("uses canonical fragment index settings with an explicit disclosure allowlist", async () => {
  const { client, state } = makeStubClient();

  await ensureIndexAndSettings(client);

  expect(state.indexUids).toEqual(["canonical_fragments"]);
  expect(state.searchable).toEqual(["text", "title", "ancestor_labels"]);
  expect(state.displayed).toEqual([
    "id",
    "fragment_id",
    "block_id",
    "document_id",
    "primary_release_id",
    "group_anchor_block_id",
    "fragment_kind",
    "content_kind",
    "posted_at",
    "text",
    "title",
    "ancestor_labels",
  ]);
  expect(state.filterable).toEqual(["game", "content_kind", "posted_at", "categories", "entities"]);
  expect(state.sortable).toEqual(["posted_at"]);
});

test("ranked-hit typing represents title-only and mixed match-field combinations", () => {
  const combinations: FragmentMatchPresence[] = [
    { text: false, title: true, ancestor_labels: false },
    { text: false, title: true, ancestor_labels: true },
    { text: true, title: true, ancestor_labels: false },
    { text: true, title: true, ancestor_labels: true },
  ];
  const hits: RankedFragmentHit[] = combinations.map((matched_fields) => ({
    id: "fragment_change",
    fragment_id: "fragment_change",
    block_id: "block_change",
    document_id: "doc_alpha",
    primary_release_id: null,
    group_anchor_block_id: "block_mirage",
    fragment_kind: "block_text",
    content_kind: "patch_notes",
    posted_at: 1_700_000_000,
    matched_fields,
  }));

  expect(hits.map((hit) => hit.matched_fields)).toEqual(combinations);
});

test("loads deterministic batches with id as the explicit primary key", async () => {
  const db = openDb(":memory:");
  seedManyFragments(db, 1_001);
  const { client, state } = makeStubClient();

  await reindexFromSqlite(client, db);

  expect(state.batches.map((batch) => batch.length)).toEqual([1_000, 1]);
  expect(state.primaryKeys).toEqual(["id", "id"]);
  expect(state.batches.flat().map((document) => document.fragment_id)).toEqual(
    Array.from({ length: 1_001 }, (_, index) => `fragment_many_${index}`),
  );
  db.close();
});

test("clears the index for an empty projection without issuing a load task", async () => {
  const db = openDb(":memory:");
  const { client, state } = makeStubClient();

  await expect(reindexFromSqlite(client, db)).resolves.toEqual({ documents: 0 });
  expect(state.batches).toEqual([]);
  // Exact mirror: an empty projection still clears any prior index generation.
  expect(state.order).toEqual(["clear"]);
  db.close();
});

test("aborts a reindex when the clear task fails", async () => {
  const db = openDb(":memory:");
  seedCanonicalProjection(db);
  const { client } = makeStubClient("clear");

  await expect(reindexFromSqlite(client, db)).rejects.toThrow(/clear rejected/);
  db.close();
});

test("rebuild deletes, configures, and deterministically reloads canonical fragments", async () => {
  const db = openDb(":memory:");
  seedCanonicalProjection(db);
  const first = makeStubClient();
  const second = makeStubClient();

  await rebuild(first.client, db);
  await rebuild(second.client, db);

  expect(first.state.deletedUids).toEqual(["canonical_fragments"]);
  expect(first.state.order[0]).toBe("delete");
  expect(first.state.order.indexOf("settings")).toBeGreaterThan(0);
  expect(first.state.order.indexOf("load")).toBeGreaterThan(first.state.order.lastIndexOf("settings"));
  expect(second.state.batches).toEqual(first.state.batches);
  db.close();
});

for (const operation of ["delete", "searchable", "displayed", "sortable", "filterable", "load"] as const) {
  test(`aborts when the ${operation} Meilisearch task fails`, async () => {
    const db = openDb(":memory:");
    seedCanonicalProjection(db);
    const { client } = makeStubClient(operation);

    await expect(rebuild(client, db)).rejects.toThrow(new RegExp(`${operation} rejected`));
    db.close();
  });
}

test("allows a first rebuild when only the target index is absent", async () => {
  const db = openDb(":memory:");
  seedCanonicalProjection(db);
  const { client, state } = makeStubClient();
  const baseDelete = client.deleteIndex.bind(client);
  client.deleteIndex = ((uid: string) => {
    const enqueued = baseDelete(uid);
    enqueued.waitTask = async () => {
      state.order.push("delete");
      throw { cause: { code: "index_not_found" } };
    };
    return enqueued;
  }) as typeof client.deleteIndex;

  await expect(rebuild(client, db)).resolves.toEqual({ documents: 4 });
  expect(state.order).toContain("load");
  db.close();
});

test("allows a first rebuild when deletion completes as an index-not-found failed task", async () => {
  const db = openDb(":memory:");
  seedCanonicalProjection(db);
  const { client, state } = makeStubClient();
  const baseDelete = client.deleteIndex.bind(client);
  client.deleteIndex = ((uid: string) => {
    const enqueued = baseDelete(uid);
    enqueued.waitTask = async () => {
      state.order.push("delete");
      return {
        uid: 42,
        status: "failed",
        error: {
          message: "Index `canonical_fragments` not found.",
          code: "index_not_found",
          type: "invalid_request",
          link: "https://docs.meilisearch.com/errors#index_not_found",
        },
      };
    };
    return enqueued;
  }) as typeof client.deleteIndex;

  await expect(rebuild(client, db)).resolves.toEqual({ documents: 4 });
  expect(state.order).toContain("load");
  db.close();
});

test("cli wires every pipeline subcommand", () => {
  expect(Object.keys(COMMANDS).sort()).toEqual([
    "backfill",
    "parse",
    "poll",
    "rebuild",
    "reindex",
  ]);
  expect(COMMANDS.backfill).toEqual({ module: "./poll.js", runner: "runBackfill" });
  expect(COMMANDS.reindex).toEqual({ module: "./reindex.js", runner: "runReindex" });
  expect(COMMANDS.rebuild).toEqual({ module: "./reindex.js", runner: "runRebuild" });
});
