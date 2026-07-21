import type { Database } from "better-sqlite3";
import type {
  BlockKind,
  Channel,
  ContentKind,
  Game,
  MediaKind,
  ParseStatus,
} from "../../types.js";
import type { RankedFragmentHit } from "../../search.js";

export const MAX_HYDRATE_IDS = 100;

const DEFAULT_MAX_CONTEXT_BLOCKS = 50;
const DEFAULT_MAX_MEDIA_PER_GROUP = 20;

export interface HydrationOptions {
  max_context_blocks?: number;
  max_media_per_group?: number;
}

export interface DirectFragmentHydrationRequest {
  kind: "direct";
  fragment_id: string;
  rank: number;
}

export interface SubgroupHydrationRequest {
  kind: "subgroup";
  group_anchor_block_id: string;
  rank: number;
}

export interface DocumentHydrationRequest {
  kind: "document";
  document_id: string;
  rank: number;
}

export type RankedHydrationRequest =
  | DirectFragmentHydrationRequest
  | SubgroupHydrationRequest
  | DocumentHydrationRequest;

export interface HydratedDocument {
  id: string;
  content_kind: ContentKind;
  title: string;
  posted_at: number;
  game: Game;
  channel: Channel;
  parse_status: ParseStatus;
}

export interface HydratedBlock {
  id: string;
  parent_block_id: string | null;
  kind: BlockKind;
  preorder: number;
  sibling_order: number;
  text?: string | null;
  label?: string | null;
}

export interface HydratedMediaItem {
  id: string;
  group_block_id: string;
  item_order: number;
  media_kind: MediaKind;
  caption: string | null;
}

export interface HydratedDocumentContext {
  document: HydratedDocument;
  blocks: HydratedBlock[];
  media_items: HydratedMediaItem[];
  descendant_overflow: number;
}

export interface HydratedFragmentMatch {
  kind: RankedHydrationRequest["kind"];
  rank: number;
  document_id: string;
  fragment_id: string | null;
  block_id: string | null;
  group_anchor_block_id: string | null;
  representative_text: string;
  context: HydratedDocumentContext;
}

export interface HydrationResult {
  matches: HydratedFragmentMatch[];
  missing: RankedHydrationRequest[];
}

interface ResolvedRequestRow {
  request_index: number;
  kind: RankedHydrationRequest["kind"];
  rank: number;
  document_id: string;
  fragment_id: string | null;
  block_id: string | null;
  group_anchor_block_id: string | null;
  representative_text: string;
  content_kind: ContentKind;
  title: string;
  posted_at: number;
  game: Game;
  channel: Channel;
  parse_status: ParseStatus;
}

interface ContextRow {
  request_index: number;
  content_kind: ContentKind;
  title: string;
  posted_at: number;
  game: Game;
  channel: Channel;
  parse_status: ParseStatus;
  block_id: string | null;
  parent_block_id: string | null;
  block_kind: BlockKind | null;
  preorder: number | null;
  sibling_order: number | null;
  block_text: string | null;
  block_label: string | null;
  candidate_count: number | null;
  media_id: string | null;
  group_block_id: string | null;
  item_order: number | null;
  media_kind: MediaKind | null;
  caption: string | null;
}

const KIND_PRIORITY: Record<RankedHydrationRequest["kind"], number> = {
  direct: 0,
  subgroup: 1,
  document: 2,
};

function requestId(request: RankedHydrationRequest): string {
  switch (request.kind) {
    case "direct":
      return request.fragment_id;
    case "subgroup":
      return request.group_anchor_block_id;
    case "document":
      return request.document_id;
  }
}

function requestKey(request: RankedHydrationRequest): string {
  return `${request.kind}\u0000${requestId(request)}`;
}

function compareRequests(a: RankedHydrationRequest, b: RankedHydrationRequest): number {
  return (
    a.rank - b.rank ||
    KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] ||
    requestId(a).localeCompare(requestId(b))
  );
}

function boundedInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > MAX_HYDRATE_IDS) {
    throw new Error(`Hydration bounds must be integers between 1 and ${MAX_HYDRATE_IDS}`);
  }
  return value;
}

function deduplicateRequests(requests: readonly RankedHydrationRequest[]): RankedHydrationRequest[] {
  const byKey = new Map<string, RankedHydrationRequest>();
  for (const request of requests) {
    const key = requestKey(request);
    const previous = byKey.get(key);
    if (previous === undefined || request.rank < previous.rank) {
      byKey.set(key, request);
    }
  }
  return [...byKey.values()].sort(compareRequests);
}

function retainFirst(
  target: Map<string, RankedHydrationRequest>,
  request: RankedHydrationRequest,
): void {
  const key = requestKey(request);
  const previous = target.get(key);
  if (previous === undefined || request.rank < previous.rank) target.set(key, request);
}

/** Convert a bounded ranked projection window into independently deduplicated canonical requests. */
export function collapseRankedGroupHits(
  hits: readonly RankedFragmentHit[],
): RankedHydrationRequest[] {
  if (hits.length > MAX_HYDRATE_IDS) {
    throw new Error(`Cannot collapse more than ${MAX_HYDRATE_IDS} ranked hits`);
  }

  const requests = new Map<string, RankedHydrationRequest>();
  hits.forEach((hit, rank) => {
    if (hit.matched_fields.title) {
      retainFirst(requests, { kind: "document", document_id: hit.document_id, rank });
    }

    const isAnchorHeading =
      hit.group_anchor_block_id !== null && hit.block_id === hit.group_anchor_block_id;
    if (hit.matched_fields.text) {
      if (isAnchorHeading) {
        retainFirst(requests, {
          kind: "subgroup",
          group_anchor_block_id: hit.group_anchor_block_id!,
          rank,
        });
      } else {
        retainFirst(requests, { kind: "direct", fragment_id: hit.fragment_id, rank });
      }
    }

    if (hit.matched_fields.ancestor_labels && hit.group_anchor_block_id !== null) {
      retainFirst(requests, {
        kind: "subgroup",
        group_anchor_block_id: hit.group_anchor_block_id,
        rank,
      });
    }
  });

  return [...requests.values()].sort(compareRequests);
}

function requestValues(requests: readonly RankedHydrationRequest[]): {
  sql: string;
  bindings: unknown[];
} {
  const bindings: unknown[] = [];
  const rows = requests.map((request, index) => {
    bindings.push(index, request.kind, requestId(request), request.rank);
    return "(?, ?, ?, ?)";
  });
  return { sql: rows.join(", "), bindings };
}

function resolvedValues(rows: readonly ResolvedRequestRow[]): {
  sql: string;
  bindings: unknown[];
} {
  if (rows.length === 0) {
    return { sql: "(?, ?, ?, ?)", bindings: [-1, "document", null, null] };
  }
  const bindings: unknown[] = [];
  const values = rows.map((row) => {
    bindings.push(row.request_index, row.kind, row.document_id, row.block_id);
    return "(?, ?, ?, ?)";
  });
  return { sql: values.join(", "), bindings };
}

function safeBlock(row: ContextRow): HydratedBlock | undefined {
  if (
    row.block_id === null ||
    row.block_kind === null ||
    row.preorder === null ||
    row.sibling_order === null
  ) {
    return undefined;
  }
  const block: HydratedBlock = {
    id: row.block_id,
    parent_block_id: row.parent_block_id,
    kind: row.block_kind,
    preorder: row.preorder,
    sibling_order: row.sibling_order,
  };
  if (row.block_kind !== "unsupported") {
    block.text = row.block_text;
    block.label = row.block_label;
  }
  return block;
}

function documentFromRow(row: ResolvedRequestRow): HydratedDocument {
  return {
    id: row.document_id,
    content_kind: row.content_kind,
    title: row.title,
    posted_at: row.posted_at,
    game: row.game,
    channel: row.channel,
    parse_status: row.parse_status,
  };
}

/** Resolve all request classes in two prepared reads and return SQLite-only display data. */
export function hydrateRankedFragments(
  db: Database,
  requests: readonly RankedHydrationRequest[],
  options: HydrationOptions = {},
): HydrationResult {
  if (requests.length > MAX_HYDRATE_IDS) {
    throw new Error(`Cannot hydrate more than ${MAX_HYDRATE_IDS} requests`);
  }
  if (requests.length === 0) return { matches: [], missing: [] };

  const maxContextBlocks = boundedInteger(
    options.max_context_blocks,
    DEFAULT_MAX_CONTEXT_BLOCKS,
  );
  const maxMediaPerGroup = boundedInteger(
    options.max_media_per_group,
    DEFAULT_MAX_MEDIA_PER_GROUP,
  );
  const uniqueRequests = deduplicateRequests(requests);
  const requested = requestValues(uniqueRequests);

  const resolved = db
    .prepare(
      `WITH requested(request_index, kind, requested_id, rank) AS (
         VALUES ${requested.sql}
       )
       SELECT requested.request_index,
              requested.kind,
              requested.rank,
              document.id AS document_id,
              CASE WHEN requested.kind = 'direct' THEN fragment.id ELSE NULL END AS fragment_id,
              CASE
                WHEN requested.kind = 'direct' THEN fragment.block_id
                WHEN requested.kind = 'subgroup' THEN anchor.id
                ELSE NULL
              END AS block_id,
              CASE WHEN requested.kind = 'subgroup' THEN anchor.id ELSE NULL END
                AS group_anchor_block_id,
              CASE
                WHEN requested.kind = 'direct' THEN fragment.text
                WHEN requested.kind = 'subgroup' THEN COALESCE(anchor.label, anchor.text, '')
                ELSE document.title
              END AS representative_text,
              document.content_kind,
              document.title,
              document.posted_at,
              document.game,
              document.channel,
              document.parse_status
         FROM requested
         LEFT JOIN search_fragments fragment
           ON requested.kind = 'direct' AND fragment.id = requested.requested_id
         LEFT JOIN blocks direct_block
           ON direct_block.document_id = fragment.document_id
          AND direct_block.id = fragment.block_id
         LEFT JOIN blocks anchor
           ON requested.kind = 'subgroup'
          AND anchor.id = requested.requested_id
          AND anchor.kind = 'heading'
         JOIN documents document
           ON document.id = CASE
             WHEN requested.kind = 'direct' AND direct_block.kind <> 'heading'
               THEN fragment.document_id
             WHEN requested.kind = 'subgroup' THEN anchor.document_id
             WHEN requested.kind = 'document' THEN requested.requested_id
             ELSE NULL
           END
          AND document.content_kind = 'patch_notes'
        ORDER BY requested.request_index`,
    )
    .all(...requested.bindings) as ResolvedRequestRow[];

  const contexts = resolvedValues(resolved);
  const contextRows = db
    .prepare(
      `WITH RECURSIVE
       requested(request_index, kind, document_id, block_id) AS (
         VALUES ${contexts.sql}
       ),
       subgroup_tree(request_index, block_id) AS (
         SELECT request_index, block_id
           FROM requested
          WHERE kind = 'subgroup' AND block_id IS NOT NULL
         UNION ALL
         SELECT tree.request_index, child.id
           FROM subgroup_tree tree
           JOIN blocks child ON child.parent_block_id = tree.block_id
       ),
       direct_ancestors(request_index, block_id) AS (
         SELECT request_index, block_id
           FROM requested
          WHERE kind = 'direct' AND block_id IS NOT NULL
         UNION ALL
         SELECT ancestors.request_index, parent.id
           FROM direct_ancestors ancestors
           JOIN blocks child ON child.id = ancestors.block_id
           JOIN blocks parent ON parent.id = child.parent_block_id
       ),
       candidate_blocks(request_index, block_id) AS (
         SELECT requested.request_index, block.id
           FROM requested
           JOIN blocks block ON block.document_id = requested.document_id
          WHERE requested.kind = 'document'
         UNION
         SELECT request_index, block_id FROM subgroup_tree
         UNION
         SELECT request_index, block_id FROM direct_ancestors
       ),
       ordered_blocks AS (
         SELECT candidate.request_index,
                candidate.block_id,
                ROW_NUMBER() OVER (
                  PARTITION BY candidate.request_index ORDER BY block.preorder
                ) AS context_order,
                COUNT(*) OVER (PARTITION BY candidate.request_index) AS candidate_count
           FROM candidate_blocks candidate
           JOIN blocks block ON block.id = candidate.block_id
       ),
       bounded_blocks AS (
         SELECT * FROM ordered_blocks WHERE context_order <= ?
       ),
       ordered_media AS (
         SELECT media.id,
                media.document_id,
                media.group_block_id,
                media.item_order,
                media.media_kind,
                media.caption,
                ROW_NUMBER() OVER (
                  PARTITION BY media.document_id, media.group_block_id ORDER BY media.item_order
                ) AS media_order
           FROM media_items media
       )
       SELECT requested.request_index,
              document.content_kind,
              document.title,
              document.posted_at,
              document.game,
              document.channel,
              document.parse_status,
              block.id AS block_id,
              block.parent_block_id,
              block.kind AS block_kind,
              block.preorder,
              block.sibling_order,
              block.text AS block_text,
              block.label AS block_label,
              bounded.candidate_count,
              media.id AS media_id,
              media.group_block_id,
              media.item_order,
              media.media_kind,
              media.caption
         FROM requested
         JOIN documents document ON document.id = requested.document_id
         LEFT JOIN bounded_blocks bounded ON bounded.request_index = requested.request_index
         LEFT JOIN blocks block ON block.id = bounded.block_id
         LEFT JOIN ordered_media media
           ON media.group_block_id = block.id AND media.media_order <= ?
        ORDER BY requested.request_index, block.preorder, media.item_order`,
    )
    .all(...contexts.bindings, maxContextBlocks, maxMediaPerGroup) as ContextRow[];

  const rowsByRequest = new Map<number, ContextRow[]>();
  for (const row of contextRows) {
    const rows = rowsByRequest.get(row.request_index) ?? [];
    rows.push(row);
    rowsByRequest.set(row.request_index, rows);
  }

  const matches = resolved.map((row): HydratedFragmentMatch => {
    const rows = rowsByRequest.get(row.request_index) ?? [];
    const blocks = new Map<string, HydratedBlock>();
    const media = new Map<string, HydratedMediaItem>();
    for (const contextRow of rows) {
      const block = safeBlock(contextRow);
      if (block !== undefined) blocks.set(block.id, block);
      if (
        contextRow.media_id !== null &&
        contextRow.group_block_id !== null &&
        contextRow.item_order !== null &&
        contextRow.media_kind !== null
      ) {
        media.set(contextRow.media_id, {
          id: contextRow.media_id,
          group_block_id: contextRow.group_block_id,
          item_order: contextRow.item_order,
          media_kind: contextRow.media_kind,
          caption: contextRow.caption,
        });
      }
    }
    const candidateCount = rows[0]?.candidate_count ?? 0;
    return {
      kind: row.kind,
      rank: row.rank,
      document_id: row.document_id,
      fragment_id: row.fragment_id,
      block_id: row.block_id,
      group_anchor_block_id: row.group_anchor_block_id,
      representative_text: row.representative_text,
      context: {
        document: documentFromRow(row),
        blocks: [...blocks.values()],
        media_items: [...media.values()],
        descendant_overflow: Math.max(0, candidateCount - blocks.size),
      },
    };
  });

  const resolvedIndexes = new Set(resolved.map((row) => row.request_index));
  const missing = uniqueRequests.filter((_, index) => !resolvedIndexes.has(index));
  return { matches, missing };
}
