/**
 * Row and document types for the patch-notes source of truth.
 *
 * The `*Row` interfaces mirror the SQLite columns declared in `SCHEMA_SQL`;
 * both the ingestion pipeline (writes) and the read API bind to these so the
 * schema has one typed definition. `MeiliLineDoc` is the shape of one document
 * in the disposable Meilisearch index (one document per line).
 */

/** A row in `updates` — one real Steam patch-note post. */
export interface UpdateRow {
  /** Steam gid (stable, Valve-assigned). Equals `update.id`. */
  id: string;
  /** Unix epoch seconds (from Steam `date`). */
  posted_at: number;
  title: string;
  /** Steam permalink. */
  url: string | null;
  feedname: string | null;
  /** Derived from `posted_at`. */
  game: "cs2" | "csgo";
  /** ORIGINAL body, untouched — enables re-parse without re-fetch. */
  raw_body: string;
  fetched_at: number;
}

/** A row in `sections` — a `[ HEADER ]` split within an update. */
export interface SectionRow {
  /** `${update_id}_${section_index}`. */
  id: string;
  update_id: string;
  section_index: number;
  /** Section header, or null for a pre-header/untitled section. */
  header: string | null;
}

/** A row in `lines` — one cleaned note line. Pristine; tags live elsewhere. */
export interface LineRow {
  /** `${section_id}_${line_index}`. */
  id: string;
  section_id: string;
  /** Denormalised from the parent section for query speed. */
  update_id: string;
  line_index: number;
  text: string;
  /** Denormalised from the parent update for filtering. */
  game: "cs2" | "csgo";
}

/**
 * One document in the Meilisearch `patch_lines` index (one per line).
 *
 * `categories` and `entities` are reserved as empty arrays this phase. Because
 * the shape already carries them, later classification enriches these fields via
 * a JOIN rather than forcing a reindexer rewrite.
 */
export interface MeiliLineDoc {
  id: string;
  update_id: string;
  text: string;
  game: "cs2" | "csgo";
  section: string;
  posted_at: number;
  title: string;
  url: string;
  /** Empty this phase — populated by a later classification pass. */
  categories: string[];
  /** Empty this phase — populated by a later classification pass. */
  entities: string[];
}
