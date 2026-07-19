import type { FastifyInstance } from "fastify";

/**
 * Notes route plugin. Placeholder registration — real note-detail read from the
 * SQLite source of truth is implemented in the notes task's GREEN phase.
 */
export async function notesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/notes/:id", async (_req, reply) =>
    reply.code(501).send({ error: "not implemented" }),
  );
}
