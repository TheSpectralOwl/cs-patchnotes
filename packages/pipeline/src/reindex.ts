import type { Database } from "better-sqlite3";
import type { Meilisearch, Task } from "meilisearch";
import { openDb, type MeiliLineDoc } from "@cs-patchnotes/shared";
import { buildMeili } from "./meili.js";

/**
 * Assert an awaited Meili task actually succeeded. `waitTask()` resolves for
 * BOTH `succeeded` and `failed` tasks, so without this check a rejected batch
 * (e.g. an invalid document id) would be silently reported as a successful load.
 * The index is the source of search truth — a failed task must abort loudly.
 */
function assertTaskSucceeded(task: Task): void {
  if (task.status !== "succeeded") {
    throw new Error(
      `Meili task ${task.uid} ${task.status}: ${task.error?.message ?? "unknown error"}`,
    );
  }
}

/**
 * The write-side "reindex" stage: project the SQLite source of truth into the
 * disposable Meilisearch index (one document per line).
 *
 * SQLite is authoritative; the `patch_lines` index is a rebuildable cache. This
 * module is the ONLY writer of that index — all writes flow SQLite → reindex,
 * never edited directly in Meili. Documents reserve empty `categories`/
 * `entities` arrays so a later classification pass enriches them via a JOIN
 * change here, not a reindexer rewrite.
 *
 * Settings and document loads enqueue async Meili tasks; each is awaited via the
 * enqueued task's `.waitTask()` helper (never fire-and-forget) so a destructive
 * step cannot race the step that follows it.
 */

/** The disposable Meilisearch index name (one document per note line). */
export const INDEX_UID = "patch_lines";

/** Attributes made full-text searchable. */
const SEARCHABLE = ["text", "title", "section"];
/** Attributes made sortable (seeds the recent-updates sort). */
const SORTABLE = ["posted_at"];
/** Attributes made filterable (seeds the disposable-rebuild discipline + future facets). */
const FILTERABLE = ["game", "posted_at"];

/** Batch size for `addDocuments` loads. */
const BATCH_SIZE = 1000;

/** Counts written by a reindex pass. */
export interface ReindexResult {
  documents: number;
}

/**
 * One row of the lines-over-source-of-truth JOIN. `categories`/`entities` are
 * concatenated from `line_tags` (empty this phase → always null → `[]`).
 */
interface JoinRow {
  id: string;
  update_id: string;
  text: string;
  game: "cs2" | "csgo";
  section: string | null;
  posted_at: number;
  title: string;
  url: string | null;
  categories: string | null;
  entities: string | null;
}

/**
 * Register the index settings idempotently, awaiting each enqueued task's
 * completion before returning. Sending settings to a not-yet-existent index
 * creates it, so this doubles as the index-create step used by `rebuild`.
 *
 * `game` and `posted_at` are registered filterable now even though the facet UI
 * is a later phase — this seeds the disposable-rebuild discipline; a later phase
 * only *adds* `categories`/`entities` to the filterable list.
 */
export async function ensureIndexAndSettings(client: Meilisearch): Promise<void> {
  const index = client.index<MeiliLineDoc>(INDEX_UID);
  assertTaskSucceeded(await index.updateSearchableAttributes(SEARCHABLE).waitTask());
  assertTaskSucceeded(await index.updateSortableAttributes(SORTABLE).waitTask());
  assertTaskSucceeded(await index.updateFilterableAttributes(FILTERABLE).waitTask());
}

/**
 * Build the one-document-per-line projection from SQLite. Joins `lines` to their
 * parent `updates` and `sections`, LEFT JOINs `line_tags` (empty this phase) and
 * aggregates any category/entity tags into arrays — so once classification
 * populates `line_tags`, enrichment is this JOIN, not a rewrite.
 */
export function buildLineDocs(db: Database): MeiliLineDoc[] {
  const rows = db
    .prepare(
      `SELECT
         l.id         AS id,
         l.update_id  AS update_id,
         l.text       AS text,
         l.game       AS game,
         s.header     AS section,
         u.posted_at  AS posted_at,
         u.title      AS title,
         u.url        AS url,
         GROUP_CONCAT(CASE WHEN t.kind = 'category' THEN t.category END) AS categories,
         GROUP_CONCAT(CASE WHEN t.kind = 'entity'   THEN t.entity   END) AS entities
       FROM lines l
       JOIN updates  u ON u.id = l.update_id
       JOIN sections s ON s.id = l.section_id
       LEFT JOIN line_tags t ON t.line_id = l.id
       GROUP BY l.id
       ORDER BY l.id`,
    )
    .all() as JoinRow[];

  return rows.map((r) => ({
    id: r.id,
    update_id: r.update_id,
    text: r.text,
    game: r.game,
    section: r.section ?? "",
    posted_at: r.posted_at,
    title: r.title,
    url: r.url ?? "",
    categories: r.categories ? r.categories.split(",") : [],
    entities: r.entities ? r.entities.split(",") : [],
  }));
}

/**
 * Project SQLite into the index: build one document per line and load them in
 * batches with `primaryKey: "id"` so re-loading upserts (never duplicates).
 * Each batch's enqueued task is awaited.
 */
export async function reindexFromSqlite(client: Meilisearch, db: Database): Promise<ReindexResult> {
  const docs = buildLineDocs(db);
  const index = client.index<MeiliLineDoc>(INDEX_UID);

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE);
    assertTaskSucceeded(await index.addDocuments(batch, { primaryKey: "id" }).waitTask());
  }

  return { documents: docs.length };
}

/**
 * Rebuild the disposable index from the source of truth: drop the index (waiting
 * for the delete to complete before recreating — an un-awaited delete races the
 * recreate and lands docs in a half-configured or missing index), recreate it
 * with settings, then repopulate from SQLite. No network fetch — reads only
 * SQLite, so two rebuilds over the same data reproduce the same result set.
 */
export async function rebuild(client: Meilisearch, db: Database): Promise<ReindexResult> {
  try {
    await client.deleteIndex(INDEX_UID).waitTask();
  } catch {
    // Deleting a non-existent index (e.g. the very first rebuild) is fine — the
    // point is a guaranteed clean slate, not that a prior index existed.
  }
  await ensureIndexAndSettings(client);
  return reindexFromSqlite(client, db);
}

/** CLI entrypoint for `pipeline reindex`. */
export async function runReindex(): Promise<void> {
  const db = openDb();
  const client = buildMeili();
  await ensureIndexAndSettings(client);
  const { documents } = await reindexFromSqlite(client, db);
  console.log(`reindex: loaded ${documents} document(s) into ${INDEX_UID}`);
}

/** CLI entrypoint for `pipeline rebuild`. */
export async function runRebuild(): Promise<void> {
  const db = openDb();
  const client = buildMeili();
  const { documents } = await rebuild(client, db);
  console.log(`rebuild: dropped + repopulated ${INDEX_UID} with ${documents} document(s)`);
}
