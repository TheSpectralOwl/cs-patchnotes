import { test, expect } from "vitest";
import { openDb, type MeiliLineDoc } from "@cs-patchnotes/shared";
import type { Meilisearch } from "meilisearch";
import { ensureIndexAndSettings, reindexFromSqlite, rebuild } from "../src/reindex.js";
import { COMMANDS } from "../src/cli.js";

/**
 * A structural stand-in for the Meilisearch client that records every settings
 * call, every addDocuments batch, and the ordering of destructive vs. load
 * operations. The pipeline only ever calls `.index()`, `.deleteIndex()`, and
 * `.waitTask()` on enqueued tasks, so recording those is enough to prove the
 * projection shape and the disposable-rebuild discipline without a live Meili.
 */
interface StubState {
  searchable: string[];
  sortable: string[];
  filterable: string[];
  batches: MeiliLineDoc[][];
  /** Sequence of operation labels: "delete" | "settings" | "load". */
  order: string[];
}

function makeStubClient(): { client: Meilisearch; state: StubState } {
  const state: StubState = {
    searchable: [],
    sortable: [],
    filterable: [],
    batches: [],
    order: [],
  };
  const task = (label: string) => ({
    waitTask: async () => {
      state.order.push(label);
      return { uid: 0, status: "succeeded" };
    },
  });
  const index = {
    updateSearchableAttributes: (a: string[]) => {
      state.searchable = a;
      return task("settings");
    },
    updateSortableAttributes: (a: string[]) => {
      state.sortable = a;
      return task("settings");
    },
    updateFilterableAttributes: (a: string[]) => {
      state.filterable = a;
      return task("settings");
    },
    addDocuments: (docs: MeiliLineDoc[]) => {
      state.batches.push(docs);
      return task("load");
    },
  };
  const client = {
    index: () => index,
    deleteIndex: () => task("delete"),
  };
  return { client: client as unknown as Meilisearch, state };
}

/** Seed a source-of-truth SQLite DB with two sections and three lines. */
function seed(db: ReturnType<typeof openDb>): number {
  db.prepare(
    `INSERT INTO updates (id, posted_at, title, url, feedname, game, raw_body, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("g1", 1_700_000_000, "Counter-Strike 2 Update", "https://example.test/1", "steam_community_announcements", "cs2", "raw", 0);

  db.prepare(`INSERT INTO sections (id, update_id, section_index, header) VALUES (?, ?, ?, ?)`).run("g1_0", "g1", 0, "MAPS");
  db.prepare(`INSERT INTO sections (id, update_id, section_index, header) VALUES (?, ?, ?, ?)`).run("g1_1", "g1", 1, null);

  const line = db.prepare(
    `INSERT INTO lines (id, section_id, update_id, line_index, text, game) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  line.run("g1_0_0", "g1_0", "g1", 0, "Fixed a bug on Dust II", "cs2");
  line.run("g1_0_1", "g1_0", "g1", 1, "Adjusted bomb site A cover", "cs2");
  line.run("g1_1_0", "g1_1", "g1", 0, "General stability improvements", "cs2");

  return (db.prepare("SELECT COUNT(*) AS c FROM lines").get() as { c: number }).c;
}

test("reindexFromSqlite emits exactly one document per line row", async () => {
  const db = openDb(":memory:");
  const lineCount = seed(db);
  const { client, state } = makeStubClient();

  const result = await reindexFromSqlite(client, db);

  expect(result.documents).toBe(lineCount);
  expect(state.batches.flat()).toHaveLength(lineCount);
  db.close();
});

test("every emitted document reserves empty categories and entities arrays", async () => {
  const db = openDb(":memory:");
  seed(db);
  const { client, state } = makeStubClient();

  await reindexFromSqlite(client, db);

  const docs = state.batches.flat();
  expect(docs.length).toBeGreaterThan(0);
  for (const d of docs) {
    expect(d.categories).toEqual([]);
    expect(d.entities).toEqual([]);
    // Doc carries the JOINed projection fields.
    expect(d.id).toMatch(/^g1_/);
    // The id is a valid Meilisearch primary key (alphanumeric, _ and - only).
    expect(d.id).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(d.title).toBe("Counter-Strike 2 Update");
    expect(d.posted_at).toBe(1_700_000_000);
  }
  db.close();
});

test("documents load with primaryKey id so re-loading upserts rather than duplicating", async () => {
  const db = openDb(":memory:");
  seed(db);
  let capturedPrimaryKey: string | undefined;

  const ok = { waitTask: async () => ({ uid: 0, status: "succeeded" }) };
  const capturingClient = {
    index: () => ({
      updateSearchableAttributes: () => ok,
      updateSortableAttributes: () => ok,
      updateFilterableAttributes: () => ok,
      addDocuments: (_docs: MeiliLineDoc[], opts?: { primaryKey?: string }) => {
        capturedPrimaryKey = opts?.primaryKey;
        return ok;
      },
    }),
    deleteIndex: () => ok,
  } as unknown as Meilisearch;

  await reindexFromSqlite(capturingClient, db);
  expect(capturedPrimaryKey).toBe("id");
  db.close();
});

test("reindexFromSqlite throws when a Meili load task fails (no silent success)", async () => {
  const db = openDb(":memory:");
  seed(db);
  const failing = {
    index: () => ({
      addDocuments: () => ({
        waitTask: async () => ({
          uid: 3,
          status: "failed",
          error: { message: "Document identifier `1_0_0` is invalid." },
        }),
      }),
    }),
  } as unknown as Meilisearch;

  await expect(reindexFromSqlite(failing, db)).rejects.toThrow(/failed/);
  db.close();
});

test("ensureIndexAndSettings registers searchable, sortable, and filterable attributes", async () => {
  const { client, state } = makeStubClient();

  await ensureIndexAndSettings(client);

  expect(state.searchable).toEqual(["text", "title", "section"]);
  expect(state.sortable).toEqual(["posted_at"]);
  expect(state.filterable).toEqual(["game", "posted_at"]);
});

test("rebuild deletes, then applies settings, then loads — in that order", async () => {
  const db = openDb(":memory:");
  seed(db);
  const { client, state } = makeStubClient();

  await rebuild(client, db);

  const firstDelete = state.order.indexOf("delete");
  const firstSettings = state.order.indexOf("settings");
  const firstLoad = state.order.indexOf("load");

  expect(firstDelete).toBe(0);
  expect(firstDelete).toBeLessThan(firstSettings);
  expect(firstSettings).toBeLessThan(firstLoad);
  db.close();
});

test("two consecutive rebuilds over the same SQLite data emit identical document sets", async () => {
  const db = openDb(":memory:");
  seed(db);

  const first = makeStubClient();
  await rebuild(first.client, db);

  const second = makeStubClient();
  await rebuild(second.client, db);

  // The disposable index is fully reproducible from the source of truth: no
  // network fetch, so the emitted documents are byte-for-byte identical.
  expect(second.state.batches.flat()).toEqual(first.state.batches.flat());
  db.close();
});

test("cli wires all four subcommands: poll, parse, reindex, rebuild", () => {
  expect(Object.keys(COMMANDS).sort()).toEqual(["parse", "poll", "rebuild", "reindex"]);
  expect(COMMANDS.reindex).toEqual({ module: "./reindex.js", runner: "runReindex" });
  expect(COMMANDS.rebuild).toEqual({ module: "./reindex.js", runner: "runRebuild" });
});
