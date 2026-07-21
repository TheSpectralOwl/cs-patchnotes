import type { Database } from "better-sqlite3";
import type { Meilisearch, Task } from "meilisearch";
import {
  openDb,
  type ContentKind,
  type Game,
  type MeiliFragmentDocument,
  type SearchFragmentKind,
} from "@cs-patchnotes/shared";
import { buildMeili } from "./meili.js";

/**
 * Assert an awaited Meili task actually succeeded. `waitTask()` resolves for
 * BOTH `succeeded` and `failed` tasks, so without this check a rejected batch
 * (e.g. an invalid document id) would be silently reported as a successful load.
 * SQLite is the source of truth, so a failed projection task must abort loudly.
 */
function assertTaskSucceeded(task: Task): void {
  if (task.status !== "succeeded") {
    throw new Error(
      `Meili task ${task.uid} ${task.status}: ${task.error?.message ?? "unknown error"}`,
    );
  }
}

/**
 * The write-side "reindex" stage projects canonical SQLite search fragments
 * into a disposable Meilisearch ranking index.
 *
 * SQLite is authoritative. This module is the only index writer: all projection
 * data flows SQLite → reindex and canonical display data is never read back from
 * Meilisearch.
 *
 * Settings and document loads enqueue async Meili tasks; each is awaited via the
 * enqueued task's `.waitTask()` helper (never fire-and-forget) so a destructive
 * step cannot race the step that follows it.
 */

/** The private disposable index containing one document per canonical fragment. */
export const INDEX_UID = "canonical_fragments";

/** Own semantic text, document title, and hierarchy context remain distinct. */
const SEARCHABLE = ["text", "title", "ancestor_labels"];
/** Only identifiers and collapse metadata may be returned from the index. */
const DISPLAYED = [
  "id",
  "fragment_id",
  "block_id",
  "document_id",
  "primary_release_id",
  "group_anchor_block_id",
  "fragment_kind",
  "content_kind",
  "posted_at",
];
const SORTABLE = ["posted_at"];
const FILTERABLE = ["game", "content_kind", "posted_at", "categories", "entities"];

/** Batch size for `addDocuments` loads. */
const BATCH_SIZE = 1000;

/** Counts written by a reindex pass. */
export interface ReindexResult {
  documents: number;
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
  const index = client.index<MeiliFragmentDocument>(INDEX_UID);
  assertTaskSucceeded(await index.updateSearchableAttributes(SEARCHABLE).waitTask());
  assertTaskSucceeded(await index.updateDisplayedAttributes(DISPLAYED).waitTask());
  assertTaskSucceeded(await index.updateSortableAttributes(SORTABLE).waitTask());
  assertTaskSucceeded(await index.updateFilterableAttributes(FILTERABLE).waitTask());
}

interface FragmentProjectionRow {
  id: string;
  block_id: string;
  document_id: string;
  group_anchor_block_id: string | null;
  text: string;
  fragment_kind: SearchFragmentKind;
  content_kind: ContentKind;
  title: string;
  game: Game;
  posted_at: number;
}

interface AncestorProjectionRow {
  fragment_id: string;
  ancestor_block_id: string;
  label: string;
}

interface TagProjectionRow {
  fragment_id: string;
  kind: "category" | "entity";
  value: string;
}

/** Build the complete deterministic ranking projection from canonical SQLite rows. */
export function buildFragmentDocs(db: Database): MeiliFragmentDocument[] {
  const fragments = db
    .prepare(
      `SELECT
         sf.id,
         b.id AS block_id,
         sf.document_id,
         sf.group_anchor_block_id,
         sf.text,
         sf.fragment_kind,
         d.content_kind,
         d.title,
         d.game,
         d.posted_at
       FROM search_fragments sf
       JOIN documents d
         ON d.id = sf.document_id
       JOIN blocks b
         ON b.id = sf.block_id
        AND b.document_id = sf.document_id
       ORDER BY sf.document_id, sf.fragment_order, sf.id`,
    )
    .all() as FragmentProjectionRow[];

  const ancestorRows = db
    .prepare(
      `SELECT fragment_id, ancestor_block_id, label
       FROM fragment_ancestors
       ORDER BY fragment_id, depth, ancestor_block_id`,
    )
    .all() as AncestorProjectionRow[];
  const ancestors = new Map<string, { ids: string[]; labels: string[] }>();
  for (const row of ancestorRows) {
    const path = ancestors.get(row.fragment_id) ?? { ids: [], labels: [] };
    path.ids.push(row.ancestor_block_id);
    path.labels.push(row.label);
    ancestors.set(row.fragment_id, path);
  }

  const tagRows = db
    .prepare(
      `SELECT fragment_id, kind, value
       FROM fragment_tags
       ORDER BY fragment_id, kind, value`,
    )
    .all() as TagProjectionRow[];
  const tags = new Map<string, { categories: string[]; entities: string[] }>();
  for (const row of tagRows) {
    const values = tags.get(row.fragment_id) ?? { categories: [], entities: [] };
    if (row.kind === "category") values.categories.push(row.value);
    else values.entities.push(row.value);
    tags.set(row.fragment_id, values);
  }

  return fragments.map((fragment) => {
    const path = ancestors.get(fragment.id) ?? { ids: [], labels: [] };
    const values = tags.get(fragment.id) ?? { categories: [], entities: [] };
    return {
      id: fragment.id,
      fragment_id: fragment.id,
      block_id: fragment.block_id,
      document_id: fragment.document_id,
      primary_release_id: null,
      group_anchor_block_id: fragment.group_anchor_block_id,
      text: fragment.text,
      fragment_kind: fragment.fragment_kind,
      content_kind: fragment.content_kind,
      title: fragment.title,
      game: fragment.game,
      posted_at: fragment.posted_at,
      ancestor_ids: path.ids,
      ancestor_labels: path.labels,
      categories: values.categories,
      entities: values.entities,
    };
  });
}

/**
 * Project SQLite into the index: build one document per fragment and load them in
 * batches with `primaryKey: "id"` so re-loading upserts (never duplicates).
 * Each batch's enqueued task is awaited.
 */
export async function reindexFromSqlite(client: Meilisearch, db: Database): Promise<ReindexResult> {
  const docs = buildFragmentDocs(db);
  const index = client.index<MeiliFragmentDocument>(INDEX_UID);

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE);
    assertTaskSucceeded(await index.addDocuments(batch, { primaryKey: "id" }).waitTask());
  }

  return { documents: docs.length };
}

function isMissingIndexError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("cause" in error)) return false;
  const cause = (error as { cause?: unknown }).cause;
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "index_not_found";
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
    assertTaskSucceeded(await client.deleteIndex(INDEX_UID).waitTask());
  } catch (error) {
    if (!isMissingIndexError(error)) throw error;
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
