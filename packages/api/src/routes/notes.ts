import type { FastifyInstance } from "fastify";
import type { Database as DatabaseType } from "better-sqlite3";
import { z } from "zod";
import { openDb } from "@cs-patchnotes/shared";
import type { UpdateRow, SectionRow, LineRow } from "@cs-patchnotes/shared";

/** `:id` is untrusted path input — require a non-empty string before any DB touch. */
const ParamsSchema = z.object({ id: z.string().min(1) });

/**
 * Lazily open a single SQLite read handle per process and memoize it. Opening on
 * first request (rather than at registration) keeps `buildServer()` side-effect
 * free — routes that never read SQLite (e.g. /search, /health) never open a DB.
 */
let dbHandle: DatabaseType | undefined;
function getDb(): DatabaseType {
  if (!dbHandle) dbHandle = openDb();
  return dbHandle;
}

/**
 * Notes route plugin. Registers `GET /notes/:id`, serving note detail read
 * directly from the SQLite source of truth. The API is allowed read access to
 * the source of truth for detail and never writes canonical data. Returns 404
 * (never 500) when the id is unknown.
 */
export async function notesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/notes/:id", async (req, reply) => {
    const parsed = ParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid note id" });
    }
    const { id } = parsed.data;
    const db = getDb();

    const update = db
      .prepare("SELECT * FROM updates WHERE id = ?")
      .get(id) as UpdateRow | undefined;
    if (!update) {
      return reply.code(404).send({ error: "not found" });
    }

    const sections = db
      .prepare("SELECT * FROM sections WHERE update_id = ? ORDER BY section_index")
      .all(id) as SectionRow[];
    const lines = db
      .prepare("SELECT * FROM lines WHERE update_id = ? ORDER BY line_index")
      .all(id) as LineRow[];

    return { update, sections, lines };
  });
}
