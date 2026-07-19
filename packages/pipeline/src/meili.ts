import { Meilisearch } from "meilisearch";

/**
 * Construct a server-side Meilisearch client.
 *
 * Mirrors the `buildServer()` factory shape: construct + configure + return, no
 * top-level side effects. Reads `MEILI_HOST` (default the internal compose
 * service name) and `MEILI_MASTER_KEY` from the environment.
 *
 * SECURITY: this client and the master key live ONLY inside the pipeline and the
 * API. Meilisearch is never reachable from outside the compose network and the
 * browser never receives this host or key — all search flows Browser → API →
 * Meili. Do not import this module from `packages/web`.
 */
export function buildMeili(): Meilisearch {
  return new Meilisearch({
    host: process.env.MEILI_HOST ?? "http://meili:7700",
    apiKey: process.env.MEILI_MASTER_KEY,
  });
}
