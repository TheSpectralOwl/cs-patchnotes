import type { ContentKind, Game, SearchFragmentKind } from "./types.js";

/** One deterministic, disposable search projection built from a canonical SQLite fragment. */
export interface MeiliFragmentDocument {
  id: string;
  fragment_id: string;
  block_id: string;
  document_id: string;
  primary_release_id: string | null;
  group_anchor_block_id: string | null;
  text: string;
  fragment_kind: SearchFragmentKind;
  content_kind: ContentKind;
  title: string;
  game: Game;
  posted_at: number;
  ancestor_ids: string[];
  ancestor_labels: string[];
  categories: string[];
  entities: string[];
}

/**
 * Normalized match presence for the only fields allowed to influence ranked
 * collapse. Matched values and offsets are deliberately excluded.
 */
export interface FragmentMatchPresence {
  text: boolean;
  title: boolean;
  ancestor_labels: boolean;
}

/**
 * The bounded portion of a Meilisearch hit used before authoritative SQLite
 * hydration. Search text, titles, labels, and tags are never display data here.
 */
export type RankedFragmentHit = Pick<
  MeiliFragmentDocument,
  | "id"
  | "fragment_id"
  | "block_id"
  | "document_id"
  | "primary_release_id"
  | "group_anchor_block_id"
  | "fragment_kind"
  | "content_kind"
  | "posted_at"
> & {
  matched_fields: FragmentMatchPresence;
};
