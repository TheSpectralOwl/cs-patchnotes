import type { FastifyInstance } from "fastify";

/**
 * Health route plugin. Registers `GET /health` returning 200 `{ status: "ok" }`.
 * Container orchestration and the Cloudflare Tunnel readiness both key off this
 * signal.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({ status: "ok" }));
}
