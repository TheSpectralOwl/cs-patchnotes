import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildMeili } from "../meili.js";

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
 * Search route plugin. Registers `GET /search` as the single public search
 * surface, proxying validated queries to the private `patch_lines` Meilisearch
 * index. An empty query returns a newest-first recent-updates landing (sorted
 * `posted_at:desc`) so the SPA never shows a blank screen. Each returned line
 * document already carries `text`, `title`, `posted_at`, and `game` for a result
 * row. Meilisearch stays private — the browser never holds its key or host.
 */
export async function searchRoutes(app: FastifyInstance): Promise<void> {
  const meili = buildMeili();

  app.get("/search", async (req, reply) => {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid query parameters" });
    }
    const { q, limit } = parsed.data;
    const index = meili.index("patch_lines");

    // Empty query → recent-updates landing (newest first, no ranking noise).
    return q.trim() === ""
      ? index.search("", { limit, sort: ["posted_at:desc"] })
      : index.search(q, { limit });
  });
}
