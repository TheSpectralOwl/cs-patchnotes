import Fastify from "fastify";
import { CorpusStore, noteBodySha256, type Game } from "./corpus.js";

export function buildServer(options: { contentDir?: string; reloadToken?: string } = {}) {
  const corpus = new CorpusStore(options.contentDir);
  const app = Fastify({ logger: true });

  app.get("/health", async () => ({ ok: true, ...corpus.stats() }));
  app.get<{ Querystring: { q?: string; game?: Game; from?: string; to?: string } }>("/api/search", async (request) => ({
    hits: corpus.search(request.query.q ?? "", request.query),
  }));
  app.get<{ Params: { id: string }; Querystring: { body_sha256?: string } }>("/api/notes/:id", async (request, reply) => {
    const note = corpus.note(request.params.id);
    if (!note) return reply.code(404).send({ error: "Note not found" });
    if (request.query.body_sha256 && request.query.body_sha256 !== noteBodySha256(note)) {
      return reply.code(409).send({ error: "Note body changed; refresh search results" });
    }
    return note;
  });
  app.post("/internal/reload", async (request, reply) => {
    if (!options.reloadToken || request.headers.authorization !== `Bearer ${options.reloadToken}`) {
      return reply.code(404).send();
    }
    return corpus.reload();
  });
  return app;
}
