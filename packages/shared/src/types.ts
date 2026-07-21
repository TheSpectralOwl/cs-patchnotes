/** Canonical row and document types for the patch-notes source of truth. */

/**
 * The release channel of a stored update. A closed string-literal union
 * (modelled exactly like `game`) so an invalid channel is a compile-time error.
 *
 * `mainline` is the default and the pristine timeline players search. The
 * non-mainline members flag beta/workshop/prerelease/store posts so they are
 * distinguishable and never silently merged into the mainline history.
 */
export type Channel = "mainline" | "beta" | "workshop" | "prerelease" | "store";

/** Source-neutral editorial classification for one canonical document. */
export type ContentKind = "patch_notes" | "release_article" | "announcement";

/** Encoding/markup contract of an immutable pristine source revision. */
export type BodyFormat = "bbcode" | "plain_text" | "html";

/** Visible lifecycle state of canonical parser selection and materialization. */
export type ParseStatus =
  | "unparsed"
  | "selected"
  | "parsed"
  | "partial"
  | "quarantined"
  | "failed";

/** Closed, source-neutral vocabulary accepted by canonical storage. */
export type BlockKind =
  | "heading"
  | "paragraph"
  | "list"
  | "list_item"
  | "patch_change"
  | "media_group"
  | "unsupported";

export type Game = "cs2" | "csgo";

/** A source-neutral row in `documents`. External identities are stored separately. */
export interface DocumentRow {
  id: string;
  content_kind: ContentKind;
  title: string;
  posted_at: number;
  game: Game;
  channel: Channel;
  parse_status: ParseStatus;
}

/** One append-only, byte-pristine revision in `source_records`. */
export interface SourceRecordRow {
  id: string;
  document_id: string;
  source_adapter: string;
  body_format: BodyFormat;
  pristine_body: string;
  body_sha256: string;
  fetched_at: number;
  supersedes_source_record_id: string | null;
}

/** The sole explicit current-revision selector for one document/adapter pair. */
export interface DocumentSourceHeadRow {
  document_id: string;
  source_adapter: string;
  source_record_id: string;
  updated_at: number;
}

export interface ExternalIdentifierRow {
  namespace: string;
  value: string;
  document_id: string;
  created_at: number;
}

export type SourceLocatorKind = "publisher" | "archive" | "capture";

export interface SourceLocatorRow {
  id: string;
  document_id: string;
  source_record_id: string | null;
  namespace: string;
  locator: string;
  locator_kind: SourceLocatorKind;
  created_at: number;
}

/** One parser-produced node in deterministic document preorder. */
export interface BlockRow {
  id: string;
  document_id: string;
  parent_block_id: string | null;
  kind: BlockKind;
  preorder: number;
  sibling_order: number;
  text: string | null;
  label: string | null;
  source_start: number | null;
  source_end: number | null;
  source_node_type: string | null;
  diagnostic_code: string | null;
}

export type MediaKind = "image" | "video" | "audio" | "embed";

export interface MediaItemRow {
  id: string;
  document_id: string;
  group_block_id: string;
  item_order: number;
  media_kind: MediaKind;
  original_locator: string;
  archive_locator: string | null;
  caption: string | null;
  alt_text: string | null;
  provenance_json: string | null;
}

export type SearchFragmentKind = "block_text" | "media_caption";

export interface SearchFragmentRow {
  id: string;
  document_id: string;
  block_id: string;
  media_item_id: string | null;
  fragment_order: number;
  fragment_kind: SearchFragmentKind;
  text: string;
  text_sha256: string;
  group_anchor_block_id: string | null;
}

export interface FragmentAncestorRow {
  fragment_id: string;
  document_id: string;
  depth: number;
  ancestor_block_id: string;
  label: string;
}
