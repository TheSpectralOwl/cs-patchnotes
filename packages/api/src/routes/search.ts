import type { FastifyInstance } from "fastify";

/**
 * Search route plugin. Placeholder registration — real proxy behavior (zod
 * validation + Meili query + empty-query recent-updates landing) is implemented
 * in the search task's GREEN phase.
 */
export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get("/search", async (_req, reply) =>
    reply.code(501).send({ error: "not implemented" }),
  );
}
