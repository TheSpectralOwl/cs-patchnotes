import Fastify, { type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import { healthRoutes } from "./routes/health.js";

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
  app.register(healthRoutes);

  app.get("/", async () => ({
    service: "cs-patchnotes-api",
    status: "ok",
  }));

  return app;
}
