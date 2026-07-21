import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  collapseRankedGroupHits,
  type ContentKind,
  type RankedFragmentHit,
  type RankedHydrationRequest,
  type SearchFragmentKind,
} from "@cs-patchnotes/shared";
import { buildMeili } from "../meili.js";
import { createSearchHydrator } from "../db/hydrate.js";

const INDEX_UID = "canonical_fragments";
const PATCH_NOTES_FILTER = "content_kind = patch_notes";
const RETRIEVED_ATTRIBUTES = [
  "id",
  "fragment_id",
  "block_id",
  "document_id",
  "primary_release_id",
  "group_anchor_block_id",
  "fragment_kind",
  "content_kind",
  "posted_at",
  // Match positions are only emitted for attributes returned by the search.
  // These values are used as internal match evidence and are never serialized;
  // response display text is hydrated exclusively from SQLite below.
  "text",
  "title",
  "ancestor_labels",
] as const;

interface RawFragmentHit {
  id: string;
  fragment_id: string;
  block_id: string;
  document_id: string;
  primary_release_id: string | null;
  group_anchor_block_id: string | null;
  fragment_kind: SearchFragmentKind;
  content_kind: ContentKind;
  posted_at: number;
  _matchesPosition?: Record<string, unknown>;
}

/**
 * Query schema for `GET /search`. This is the untrusted-input boundary: `q` is
 * length-capped and `limit` is coerced and clamped to a safe range. Validated
 * params are passed to the SDK's typed search options only — user input is never
 * string-concatenated into a Meili filter expression (guards filter injection).
 */
const QuerySchema = z.object({
  q: z.string().max(200).default(""),
  // Coerce + bound the caller-supplied limit. Out-of-range values are CLAMPED
  // (not rejected) into [1, 50]; junk (non-numeric) still fails validation.
  limit: z
    .coerce.number()
    .int()
    .default(20)
    .transform((n) => Math.min(50, Math.max(1, n))),
});

/**
 * Search uses Meilisearch only for a bounded ranked identifier window. Every
 * display field and canonical context row is then read from SQLite in bulk.
 */
export async function searchRoutes(app: FastifyInstance): Promise<void> {
  const meili = buildMeili();
  const hydrator = createSearchHydrator();

  app.addHook("onClose", async () => hydrator.close());

  app.get("/search", async (req, reply) => {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid query parameters" });
    }
    const { limit } = parsed.data;
    const q = parsed.data.q.trim();
    const index = meili.index(INDEX_UID);
    const result = await index.search(q, {
      limit,
      filter: PATCH_NOTES_FILTER,
      attributesToRetrieve: [...RETRIEVED_ATTRIBUTES],
      ...(q === ""
        ? { sort: ["posted_at:desc"] }
        : { showMatchesPosition: true }),
    });
    const hits = result.hits as unknown as RawFragmentHit[];

    let requests: RankedHydrationRequest[];
    if (q === "") {
      const firstByDocument = new Map<string, RawFragmentHit>();
      for (const hit of hits) {
        if (!firstByDocument.has(hit.document_id)) firstByDocument.set(hit.document_id, hit);
      }
      requests = [...firstByDocument.values()]
        .sort(
          (a, b) =>
            b.posted_at - a.posted_at || a.document_id.localeCompare(b.document_id),
        )
        .map((hit, rank) => ({ kind: "document", document_id: hit.document_id, rank }));
    } else {
      const rankedHits: RankedFragmentHit[] = hits.map((hit) => {
        const positions = hit._matchesPosition ?? {};
        return {
          id: hit.id,
          fragment_id: hit.fragment_id,
          block_id: hit.block_id,
          document_id: hit.document_id,
          primary_release_id: hit.primary_release_id,
          group_anchor_block_id: hit.group_anchor_block_id,
          fragment_kind: hit.fragment_kind,
          content_kind: hit.content_kind,
          posted_at: hit.posted_at,
          matched_fields: {
            text: Object.hasOwn(positions, "text"),
            title: Object.hasOwn(positions, "title"),
            ancestor_labels: Object.hasOwn(positions, "ancestor_labels"),
          },
        };
      });
      requests = collapseRankedGroupHits(rankedHits);
    }

    const hydrated = hydrator.hydrate(requests);
    return { hits: hydrated.matches };
  });
}
