import { buildServer } from "./server.js";

const app = buildServer({ reloadToken: process.env.RELOAD_TOKEN });
await app.listen({ host: process.env.HOST ?? "0.0.0.0", port: Number(process.env.PORT ?? 3001) });
