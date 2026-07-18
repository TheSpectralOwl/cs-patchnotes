import { buildServer } from "./server.js";

/**
 * Runtime entrypoint. Binds Fastify to 0.0.0.0 (mandatory inside containers per
 * D-07) on the env-parameterized PORT (default 3000). On listen error, log and
 * exit non-zero so the container/orchestrator restarts it.
 */
const app = buildServer();
const port = Number(process.env.PORT ?? 3000);

app.listen({ host: "0.0.0.0", port }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
