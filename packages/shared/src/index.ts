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
  | "MEILI_HOST"
  | "SQLITE_PATH"
  | "WEB_ORIGIN";

export * from "./types.js";
export * from "./search.js";
export * from "./db/ids.js";
export * from "./db/repositories/documents.js";
export * from "./db/repositories/hydration.js";
export {
  assertCanonicalFinalizationReady,
  BACKUP_MANIFEST_CONTRACT_VERSION,
  CANONICAL_EXPANSION_META,
  canonicalLegacySourceDigest,
  EXPANSION_SCHEMA_VERSION,
  initializeCanonicalSchema,
  inspectSchemaVersion,
  LATEST_SCHEMA_VERSION,
  MAX_BACKUP_MANIFEST_AGE_MS,
  migrateToVersion2,
  readAndValidateBackupManifest,
  recordCanonicalFinalizationReadiness,
  runMigrations,
} from "./db/migrations.js";
export type {
  CanonicalBackupFileEvidence,
  CanonicalBackupManifest,
  CanonicalFileIdentity,
  CanonicalTargetEvidence,
  FinalizationMigrationHooks,
  SchemaInspection,
  SchemaState,
  ValidatedBackupEvidence,
} from "./db/migrations.js";
export { openDb } from "./db/client.js";
