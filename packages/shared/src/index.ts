/**
 * @cs-patchnotes/shared
 *
 * Minimal placeholder export. This package intentionally ships a real,
 * non-empty export that grows over time — it is not an idle stub.
 */

export const SHARED_PACKAGE = "@cs-patchnotes/shared";

/**
 * Names of the environment variables the deployed stack reads. The committed
 * `.env.example` documents these names (values live only in a git-ignored `.env`).
 */
export type EnvVarName =
  | "MEILI_MASTER_KEY"
  | "TUNNEL_TOKEN"
  | "ANTHROPIC_API_KEY"
  | "PORT"
  | "MEILI_HOST";
