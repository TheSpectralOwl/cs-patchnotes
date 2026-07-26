import Fastify from "fastify";
import { CorpusStore, noteBodySha256, type Game } from "./corpus.js";

const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;

export function buildServer(options: { contentRevisionRoot?: string; contentDir?: string; reloadToken?: string } = {}) {
  const corpus = new CorpusStore(options.contentRevisionRoot ?? options.contentDir);
  const app = Fastify({ logger: true });

  app.get("/health", async () => ({ ok: true, ...corpus.stats(), content_sha: corpus.activeSha() }));
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
  app.post<{ Body: { sha?: unknown } }>("/internal/reload", async (request, reply) => {
    if (!options.reloadToken || request.headers.authorization !== `Bearer ${options.reloadToken}`) {
      return reply.code(404).send();
    }
    const sha = request.body?.sha;
    if (typeof sha !== "string" || !GIT_SHA_PATTERN.test(sha)) {
      return reply.code(400).send({ error: "Reload requires one full lowercase Git SHA" });
    }
    try {
      return corpus.reload(sha);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Corpus reload failed";
      return reply.code(message.startsWith("Active content SHA") ? 409 : 500).send({ error: message });
    }
  });
  return app;
}
