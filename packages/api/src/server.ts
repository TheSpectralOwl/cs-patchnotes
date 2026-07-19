import Fastify, { type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import { healthRoutes } from "./routes/health.js";
import { searchRoutes } from "./routes/search.js";
import { notesRoutes } from "./routes/notes.js";

/**
 * Build a fresh Fastify instance with security headers, the health route, and a
 * root endpoint. Returns the app WITHOUT calling `listen()` so tests can drive it
 * offline via `app.inject`. Each call yields an independent instance.
 */
export function buildServer(): FastifyInstance {
  const isProduction = process.env.NODE_ENV === "production";

  const app = Fastify({
    logger: isProduction
      ? true
      : {
          transport: {
            target: "pino-pretty",
          },
        },
  });

  app.register(helmet);
  // CORS restricted to the Cloudflare Pages SPA origin. A permissive default is
  // used only when WEB_ORIGIN is unset (local dev); production always sets it.
  // No `*`-with-credentials — this public read API needs no credentials.
  app.register(cors, { origin: process.env.WEB_ORIGIN ?? true });
  app.register(healthRoutes);
  app.register(searchRoutes);
  app.register(notesRoutes);

  app.get("/", async () => ({
    service: "cs-patchnotes-api",
    status: "ok",
  }));

  return app;
}
