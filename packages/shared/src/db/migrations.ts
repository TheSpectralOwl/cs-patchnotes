import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { posix } from "node:path";
import {
  CANONICAL_SCHEMA_SQL,
  SCHEMA_SQL,
  TRANSITIONAL_SCHEMA_SQL,
} from "./schema.js";

export const EXPANSION_SCHEMA_VERSION = 1;
export const LATEST_SCHEMA_VERSION = 2;
export const BACKUP_MANIFEST_CONTRACT_VERSION = 1;
export const MAX_BACKUP_MANIFEST_AGE_MS = 24 * 60 * 60 * 1_000;

export const CANONICAL_EXPANSION_META = {
  expansionId: "canonical_expansion_id",
  manifestDigest: "canonical_backup_manifest_sha256",
  manifestPath: "canonical_backup_manifest_path",
  expansionCreatedAt: "canonical_expansion_created_at",
  sourceDigest: "canonical_legacy_source_digest",
} as const;

const PROTOTYPE_TABLES = ["updates", "sections", "lines", "line_tags"] as const;
const CANONICAL_TABLES = [
  "documents",
  "source_records",
  "document_source_heads",
  "external_identifiers",
  "source_locators",
  "parser_overrides",
  "document_parse_state",
  "parse_runs",
  "parse_diagnostics",
  "canonical_cutover_audits",
  "blocks",
  "media_items",
  "search_fragments",
  "fragment_ancestors",
  "fragment_tags",
] as const;
const LEGACY_EVIDENCE_TABLES = ["updates", "sections", "lines", "line_tags"] as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sealedBackupEvidence = new WeakSet<object>();

export type SchemaState = "empty" | "legacy" | "transitional" | "canonical" | "unsupported";

export interface SchemaInspection {
  userVersion: number;
  state: SchemaState;
  tables: string[];
}

interface LegacyUpdate {
  id: string;
  posted_at: number;
  title: string;
  url: string | null;
  game: "csgo" | "cs2";
  raw_body: string;
  fetched_at: number;
  channel: "mainline" | "beta" | "workshop" | "prerelease" | "store";
}

export interface CanonicalFileIdentity {
  path: string;
  device: number;
  inode: number;
  size: number;
  mtime_ms: number;
}

export interface CanonicalTargetEvidence extends CanonicalFileIdentity {
  user_version: number;
  table_counts: Record<(typeof LEGACY_EVIDENCE_TABLES)[number], number>;
  legacy_source_digest: string;
}

export interface CanonicalBackupFileEvidence extends CanonicalFileIdentity {
  sha256: string;
}

export interface CanonicalBackupManifest {
  contract_version: number;
  manifest_id: string;
  expansion_id: string;
  created_at: string;
  target: CanonicalTargetEvidence;
  backup: CanonicalBackupFileEvidence;
  open_verification: {
    ok: true;
    user_version: number;
    quick_check: "ok";
  };
}

export interface ValidatedBackupEvidence {
  readonly manifestPath: string;
  readonly manifestDigest: string;
  readonly expansionId: string;
  readonly sourceDigest: string;
  readonly backupPath: string;
  readonly backupSha256: string;
  readonly createdAtMs: number;
}

interface FinalizationState {
  sourceHeadDigest: string;
  parserStateDigest: string;
  successfulParseRunId: string;
  noopParseRunId: string;
  noopStateDigest: string;
}

interface FinalizationAuditRow {
  manifest_path: string;
  manifest_digest: string;
  expansion_id: string;
  source_head_digest: string;
  parser_state_digest: string;
  successful_parse_run_id: string;
  noop_parse_run_id: string;
  noop_state_digest: string;
  backup_path: string;
  backup_sha256: string;
}

export interface FinalizationMigrationHooks {
  afterPrototypeDrop?: (db: DatabaseType) => void;
}

function tableNames(db: DatabaseType): string[] {
  return db
    .prepare(
      `SELECT name
         FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    )
    .all()
    .map((row) => (row as { name: string }).name);
}

function containsEvery(tables: ReadonlySet<string>, required: readonly string[]): boolean {
  return required.every((name) => tables.has(name));
}

export function inspectSchemaVersion(db: DatabaseType): SchemaInspection {
  const tables = tableNames(db);
  const tableSet = new Set(tables);
  const userVersion = db.pragma("user_version", { simple: true }) as number;
  const hasMetadata = tableSet.has("meta");
  const hasPrototype = containsEvery(tableSet, PROTOTYPE_TABLES);
  const hasCanonical = containsEvery(tableSet, CANONICAL_TABLES);

  let state: SchemaState = "unsupported";
  if (tables.length === 0 && userVersion === 0) {
    state = "empty";
  } else if (
    userVersion === 0 &&
    hasMetadata &&
    hasPrototype &&
    !CANONICAL_TABLES.some((name) => tableSet.has(name))
  ) {
    state = "legacy";
  } else if (
    userVersion === EXPANSION_SCHEMA_VERSION &&
    hasMetadata &&
    hasPrototype &&
    hasCanonical
  ) {
    state = "transitional";
  } else if (
    userVersion === LATEST_SCHEMA_VERSION &&
    hasMetadata &&
    !PROTOTYPE_TABLES.some((name) => tableSet.has(name)) &&
    hasCanonical
  ) {
    state = "canonical";
  }

  return { userVersion, state, tables };
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function detectLegacyBodyFormat(body: string): "bbcode" | "plain_text" {
  return /\[\/?(?:p|list|\*|h[1-6]|img|url|b|i|u)\b|\{STEAM_CLAN_IMAGE\}/i.test(body)
    ? "bbcode"
    : "plain_text";
}

function migrateLegacyUpdates(db: DatabaseType): void {
  const updates = db.prepare("SELECT * FROM updates ORDER BY id").all() as LegacyUpdate[];
  const insertDocument = db.prepare(
    `INSERT INTO documents
       (id, content_kind, title, posted_at, game, channel, parse_status)
     VALUES (@id, 'patch_notes', @title, @posted_at, @game, @channel, 'unparsed')`,
  );
  const insertSource = db.prepare(
    `INSERT INTO source_records
       (id, document_id, source_adapter, body_format, pristine_body, body_sha256, fetched_at)
     VALUES (@id, @document_id, 'steam_news', @body_format, @pristine_body, @body_sha256, @fetched_at)`,
  );
  const insertHead = db.prepare(
    `INSERT INTO document_source_heads
       (document_id, source_adapter, source_record_id, updated_at)
     VALUES (?, 'steam_news', ?, ?)`,
  );
  const insertIdentifier = db.prepare(
    `INSERT INTO external_identifiers (namespace, value, document_id, created_at)
     VALUES ('steam_news_gid', ?, ?, ?)`,
  );
  const insertLocator = db.prepare(
    `INSERT INTO source_locators
       (id, document_id, source_record_id, namespace, locator, locator_kind, created_at)
     VALUES (?, ?, ?, 'steam_news_url', ?, 'publisher', ?)`,
  );

  for (const update of updates) {
    const documentId = randomUUID();
    const sourceRecordId = randomUUID();
    insertDocument.run({
      id: documentId,
      title: update.title,
      posted_at: update.posted_at,
      game: update.game,
      channel: update.channel,
    });
    insertSource.run({
      id: sourceRecordId,
      document_id: documentId,
      body_format: detectLegacyBodyFormat(update.raw_body),
      pristine_body: update.raw_body,
      body_sha256: sha256(Buffer.from(update.raw_body, "utf8")),
      fetched_at: update.fetched_at,
    });
    insertHead.run(documentId, sourceRecordId, update.fetched_at);
    insertIdentifier.run(update.id, documentId, update.fetched_at);
    if (update.url !== null && update.url.length > 0) {
      insertLocator.run(randomUUID(), documentId, sourceRecordId, update.url, update.fetched_at);
    }
  }
}

/**
 * Advance an empty or prototype database only to the additive schema version 1.
 * This function has no path to destructive canonical-only finalization.
 */
export function runMigrations(db: DatabaseType): SchemaInspection {
  const before = inspectSchemaVersion(db);
  if (before.state === "transitional" || before.state === "canonical") return before;
  if (before.state === "unsupported") {
    throw new Error(`Unsupported SQLite schema version ${before.userVersion}`);
  }

  const migrate = db.transaction(() => {
    if (before.state === "empty") {
      db.exec(TRANSITIONAL_SCHEMA_SQL);
    } else {
      db.exec(CANONICAL_SCHEMA_SQL);
      migrateLegacyUpdates(db);
    }
    db.pragma(`user_version = ${EXPANSION_SCHEMA_VERSION}`);
  });
  migrate();

  const after = inspectSchemaVersion(db);
  if (after.state !== "transitional") {
    throw new Error("SQLite migration did not produce the transitional schema");
  }
  return after;
}

/** Initialize a genuinely new database directly at the canonical-only schema. */
export function initializeCanonicalSchema(db: DatabaseType): SchemaInspection {
  const before = inspectSchemaVersion(db);
  if (before.state === "canonical") return before;
  if (before.state !== "empty") {
    throw new Error("Fresh canonical initialization requires an empty database");
  }
  db.transaction(() => {
    db.exec(SCHEMA_SQL);
    db.pragma(`user_version = ${LATEST_SCHEMA_VERSION}`);
  })();
  const after = inspectSchemaVersion(db);
  if (after.state !== "canonical") throw new Error("Canonical initialization failed");
  return after;
}

function getMeta(db: DatabaseType, key: string): string | undefined {
  return db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(key) as string | undefined;
}

function legacyTableCounts(
  db: DatabaseType,
): Record<(typeof LEGACY_EVIDENCE_TABLES)[number], number> {
  return {
    updates: db.prepare("SELECT count(*) FROM updates").pluck().get() as number,
    sections: db.prepare("SELECT count(*) FROM sections").pluck().get() as number,
    lines: db.prepare("SELECT count(*) FROM lines").pluck().get() as number,
    line_tags: db.prepare("SELECT count(*) FROM line_tags").pluck().get() as number,
  };
}

export function canonicalLegacySourceDigest(db: DatabaseType): string {
  const rows = db
    .prepare("SELECT id, raw_body FROM updates ORDER BY id")
    .all() as Array<{ id: string; raw_body: string }>;
  const hash = createHash("sha256");
  for (const row of rows) {
    const id = Buffer.from(row.id, "utf8");
    const body = Buffer.from(row.raw_body, "utf8");
    const lengths = Buffer.allocUnsafe(8);
    lengths.writeUInt32BE(id.length, 0);
    lengths.writeUInt32BE(body.length, 4);
    hash.update(lengths);
    hash.update(id);
    hash.update(body);
  }
  return hash.digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains missing or unexpected fields`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
  return value;
}

function parseBackupManifest(bytes: Buffer): CanonicalBackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Backup manifest is not valid JSON");
  }
  requireExactKeys(
    parsed,
    ["contract_version", "manifest_id", "expansion_id", "created_at", "target", "backup", "open_verification"],
    "Backup manifest",
  );
  requireExactKeys(
    parsed.target,
    ["path", "device", "inode", "size", "mtime_ms", "user_version", "table_counts", "legacy_source_digest"],
    "Backup manifest target",
  );
  requireExactKeys(parsed.target.table_counts, LEGACY_EVIDENCE_TABLES, "Backup manifest table counts");
  requireExactKeys(
    parsed.backup,
    ["path", "device", "inode", "size", "mtime_ms", "sha256"],
    "Backup manifest backup",
  );
  requireExactKeys(parsed.open_verification, ["ok", "user_version", "quick_check"], "Backup open verification");

  if (parsed.contract_version !== BACKUP_MANIFEST_CONTRACT_VERSION) {
    throw new Error("Backup manifest contract version is unsupported");
  }
  if (!UUID_PATTERN.test(requireString(parsed.manifest_id, "manifest_id"))) {
    throw new Error("Backup manifest ID is invalid");
  }
  if (!UUID_PATTERN.test(requireString(parsed.expansion_id, "expansion_id"))) {
    throw new Error("Backup expansion ID is invalid");
  }
  requireString(parsed.created_at, "created_at");
  requireString(parsed.target.path, "target.path");
  requireNumber(parsed.target.device, "target.device");
  requireNumber(parsed.target.inode, "target.inode");
  requireNumber(parsed.target.size, "target.size");
  requireNumber(parsed.target.mtime_ms, "target.mtime_ms");
  requireNumber(parsed.target.user_version, "target.user_version");
  for (const table of LEGACY_EVIDENCE_TABLES) {
    requireNumber(parsed.target.table_counts[table], `target.table_counts.${table}`);
  }
  if (!SHA256_PATTERN.test(requireString(parsed.target.legacy_source_digest, "target.legacy_source_digest"))) {
    throw new Error("Target source digest is invalid");
  }
  requireString(parsed.backup.path, "backup.path");
  requireNumber(parsed.backup.device, "backup.device");
  requireNumber(parsed.backup.inode, "backup.inode");
  requireNumber(parsed.backup.size, "backup.size");
  requireNumber(parsed.backup.mtime_ms, "backup.mtime_ms");
  if (!SHA256_PATTERN.test(requireString(parsed.backup.sha256, "backup.sha256"))) {
    throw new Error("Backup SHA-256 is invalid");
  }
  if (parsed.open_verification.ok !== true || parsed.open_verification.quick_check !== "ok") {
    throw new Error("Backup open verification is not successful");
  }
  requireNumber(parsed.open_verification.user_version, "open_verification.user_version");
  return parsed as unknown as CanonicalBackupManifest;
}

function sameFileIdentity(actual: CanonicalFileIdentity, expected: CanonicalFileIdentity): boolean {
  return actual.path === expected.path &&
    actual.device === expected.device &&
    actual.inode === expected.inode &&
    actual.size === expected.size &&
    actual.mtime_ms === expected.mtime_ms;
}

function fileIdentity(path: string): CanonicalFileIdentity {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`Expected a regular file at ${path}`);
  return {
    path,
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    mtime_ms: stat.mtimeMs,
  };
}

/**
 * Validate one caller-named manifest and its exact backup. No directory listing,
 * sibling discovery, path normalization, or newest-file selection occurs here.
 */
export function readAndValidateBackupManifest(
  manifestPath: string,
  expectedTarget: string,
  db: DatabaseType,
  now = Date.now(),
): ValidatedBackupEvidence {
  if (!posix.isAbsolute(manifestPath)) throw new Error("Backup manifest path must be absolute");
  if (!posix.isAbsolute(expectedTarget)) throw new Error("Expected SQLite target path must be absolute");
  if (db.name !== expectedTarget) throw new Error("Open database does not match the exact target path");
  const inspection = inspectSchemaVersion(db);
  if (inspection.state !== "transitional" || inspection.userVersion !== EXPANSION_SCHEMA_VERSION) {
    throw new Error("Backup evidence validation requires transitional schema version 1");
  }

  const manifestBytes = readFileSync(manifestPath);
  const manifest = parseBackupManifest(manifestBytes);
  const createdAtMs = Date.parse(manifest.created_at);
  if (!Number.isFinite(createdAtMs)) throw new Error("Backup manifest created_at is invalid");
  if (createdAtMs > now + 5 * 60 * 1_000 || now - createdAtMs > MAX_BACKUP_MANIFEST_AGE_MS) {
    throw new Error("Backup manifest has expired or is from the future");
  }
  if (manifest.target.path !== expectedTarget) throw new Error("Backup manifest target path mismatch");
  if (manifest.target.user_version !== 0) throw new Error("Backup manifest target must describe schema version 0");
  if (manifest.backup.path !== `${manifestPath}.sqlite-backup`) {
    throw new Error("Backup manifest does not name its exact owned backup path");
  }

  const currentTarget = fileIdentity(expectedTarget);
  if (currentTarget.device !== manifest.target.device || currentTarget.inode !== manifest.target.inode) {
    throw new Error("SQLite target file identity changed since expansion");
  }
  const manifestDigest = sha256(manifestBytes);
  if (getMeta(db, CANONICAL_EXPANSION_META.expansionId) !== manifest.expansion_id) {
    throw new Error("Database expansion identity does not match the explicit manifest");
  }
  if (getMeta(db, CANONICAL_EXPANSION_META.manifestDigest) !== manifestDigest) {
    throw new Error("Database manifest digest does not match the explicit manifest");
  }
  if (getMeta(db, CANONICAL_EXPANSION_META.manifestPath) !== manifestPath) {
    throw new Error("Database manifest path does not match the explicit manifest");
  }
  const currentSourceDigest = canonicalLegacySourceDigest(db);
  if (
    currentSourceDigest !== manifest.target.legacy_source_digest ||
    getMeta(db, CANONICAL_EXPANSION_META.sourceDigest) !== currentSourceDigest
  ) {
    throw new Error("Current source digest does not match expansion evidence");
  }

  const actualBackupIdentity = fileIdentity(manifest.backup.path);
  if (!sameFileIdentity(actualBackupIdentity, manifest.backup)) {
    throw new Error("Backup file stat identity does not match the manifest");
  }
  if (sha256(readFileSync(manifest.backup.path)) !== manifest.backup.sha256) {
    throw new Error("Backup file SHA-256 does not match the manifest");
  }
  const backup = new Database(manifest.backup.path, { readonly: true, fileMustExist: true });
  try {
    if (backup.pragma("quick_check", { simple: true }) !== "ok") {
      throw new Error("Backup PRAGMA quick_check failed");
    }
    const backupVersion = backup.pragma("user_version", { simple: true }) as number;
    if (
      manifest.open_verification.user_version !== backupVersion ||
      backupVersion !== manifest.target.user_version
    ) {
      throw new Error("Backup schema identity does not match the manifest");
    }
    const counts = legacyTableCounts(backup);
    if (LEGACY_EVIDENCE_TABLES.some((table) => counts[table] !== manifest.target.table_counts[table])) {
      throw new Error("Backup legacy table counts do not match the manifest");
    }
    if (canonicalLegacySourceDigest(backup) !== manifest.target.legacy_source_digest) {
      throw new Error("Backup source digest does not match the manifest");
    }
  } finally {
    backup.close();
  }

  const evidence: ValidatedBackupEvidence = Object.freeze({
    manifestPath,
    manifestDigest,
    expansionId: manifest.expansion_id,
    sourceDigest: currentSourceDigest,
    backupPath: manifest.backup.path,
    backupSha256: manifest.backup.sha256,
    createdAtMs,
  });
  sealedBackupEvidence.add(evidence);
  return evidence;
}

function requireSealedEvidence(evidence: ValidatedBackupEvidence): void {
  if (!sealedBackupEvidence.has(evidence)) {
    throw new Error("Finalization requires evidence returned by readAndValidateBackupManifest");
  }
}

function digestRows(value: unknown): string {
  return sha256(Buffer.from(JSON.stringify(value), "utf8"));
}

function assertExactCurrentParity(db: DatabaseType): FinalizationState {
  const inspection = inspectSchemaVersion(db);
  if (inspection.state !== "transitional" || inspection.userVersion !== EXPANSION_SCHEMA_VERSION) {
    throw new Error("Canonical finalization readiness requires schema version 1");
  }
  const documentCount = db.prepare("SELECT count(*) FROM documents").pluck().get() as number;
  const updateCount = db.prepare("SELECT count(*) FROM updates").pluck().get() as number;
  if (documentCount === 0 || documentCount !== updateCount) {
    throw new Error("Canonical document parity is incomplete");
  }
  if ((db.prepare("SELECT count(*) FROM line_tags").pluck().get() as number) !== 0) {
    throw new Error("Legacy classification rows must be zero before finalization");
  }
  if ((db.prepare("SELECT count(*) FROM fragment_tags").pluck().get() as number) !== 0) {
    throw new Error("Canonical classification rows must be zero before finalization");
  }

  const parityRows = db.prepare(
    `SELECT legacy.id AS gid, legacy.raw_body, legacy.url,
            document.id AS document_id, document.content_kind, document.parse_status,
            head.source_record_id, source.pristine_body, source.body_sha256,
            state.source_record_id AS parsed_source_record_id,
            state.selection_state, state.parser_key, state.parser_version,
            state.grouping_policy_version, state.materialization_status,
            state.output_sha256, state.last_parse_run_id,
            (SELECT count(*) FROM external_identifiers alias
              WHERE alias.namespace='steam_news_gid' AND alias.value=legacy.id
                AND alias.document_id=document.id) AS alias_count,
            (SELECT count(*) FROM source_locators locator
              WHERE locator.namespace='steam_news_url' AND locator.locator=legacy.url
                AND locator.document_id=document.id) AS locator_count
       FROM updates legacy
       LEFT JOIN external_identifiers identity
         ON identity.namespace='steam_news_gid' AND identity.value=legacy.id
       LEFT JOIN documents document ON document.id=identity.document_id
       LEFT JOIN document_source_heads head
         ON head.document_id=document.id AND head.source_adapter='steam_news'
       LEFT JOIN source_records source
         ON source.id=head.source_record_id AND source.document_id=head.document_id
       LEFT JOIN document_parse_state state
         ON state.document_id=document.id AND state.source_adapter='steam_news'
      ORDER BY legacy.id`,
  ).all() as Array<Record<string, string | number | null>>;
  if (parityRows.length !== documentCount) throw new Error("Legacy source parity row count is incomplete");
  for (const row of parityRows) {
    const rawBody = row.raw_body as string;
    if (
      row.document_id === null ||
      row.content_kind !== "patch_notes" ||
      row.parse_status !== "parsed" ||
      row.alias_count !== 1 ||
      row.locator_count !== 1 ||
      row.source_record_id === null ||
      row.parsed_source_record_id !== row.source_record_id ||
      row.pristine_body !== rawBody ||
      row.body_sha256 !== sha256(Buffer.from(rawBody, "utf8")) ||
      row.selection_state !== "selected" ||
      typeof row.parser_key !== "string" ||
      typeof row.parser_version !== "string" ||
      typeof row.grouping_policy_version !== "string" ||
      row.materialization_status !== "complete" ||
      !SHA256_PATTERN.test(String(row.output_sha256 ?? ""))
    ) {
      throw new Error("Canonical source, identity, parser, or materialization parity is incomplete");
    }
  }

  const sourceRows = db
    .prepare("SELECT id, pristine_body, body_sha256 FROM source_records ORDER BY id")
    .all() as Array<{ id: string; pristine_body: string; body_sha256: string }>;
  for (const source of sourceRows) {
    if (sha256(Buffer.from(source.pristine_body, "utf8")) !== source.body_sha256) {
      throw new Error(`Immutable source body hash mismatch for ${source.id}`);
    }
  }
  if ((db.pragma("foreign_key_check") as unknown[]).length !== 0) {
    throw new Error("Foreign key check failed before canonical finalization");
  }

  const noOpRun = db.prepare(
    `SELECT * FROM parse_runs
      WHERE status='succeeded'
        AND attempted_count=? AND selected_count=? AND unchanged_count=?
        AND partial_count=0 AND quarantined_count=0 AND error_count=0
      ORDER BY completed_at DESC, rowid DESC
      LIMIT 1`,
  ).get(documentCount, documentCount, documentCount) as Record<string, string | number | null> | undefined;
  if (noOpRun === undefined) throw new Error("A persisted all-unchanged no-op parse is required");
  const successfulRun = db.prepare(
    `SELECT * FROM parse_runs
      WHERE id<>? AND status='succeeded'
        AND attempted_count=? AND selected_count=? AND unchanged_count<?
        AND partial_count=0 AND quarantined_count=0 AND error_count=0
        AND completed_at<=?
      ORDER BY completed_at DESC, rowid DESC
      LIMIT 1`,
  ).get(
    noOpRun.id,
    documentCount,
    documentCount,
    documentCount,
    noOpRun.completed_at,
  ) as Record<string, string | number | null> | undefined;
  if (successfulRun === undefined) throw new Error("A successful materializing parse before the no-op is required");
  if (parityRows.some((row) => row.last_parse_run_id !== noOpRun.id)) {
    throw new Error("Every current parser state must be persisted by the no-op replay");
  }

  const sourceHeads = db.prepare(
    `SELECT head.document_id, head.source_adapter, head.source_record_id, source.body_sha256
       FROM document_source_heads head
       JOIN source_records source
         ON source.id=head.source_record_id
        AND source.document_id=head.document_id
        AND source.source_adapter=head.source_adapter
      ORDER BY head.document_id, head.source_adapter`,
  ).all();
  const parserStates = db.prepare(
    `SELECT document_id, source_adapter, source_record_id, parser_key, parser_version,
            grouping_policy_version, output_sha256, last_parse_run_id
       FROM document_parse_state
      ORDER BY document_id, source_adapter`,
  ).all();
  if (sourceHeads.length !== documentCount || parserStates.length !== documentCount) {
    throw new Error("Current source-head or parser-state cardinality is incomplete");
  }
  const sourceHeadDigest = digestRows(sourceHeads);
  const parserStateDigest = digestRows(parserStates);
  return {
    sourceHeadDigest,
    parserStateDigest,
    successfulParseRunId: String(successfulRun.id),
    noopParseRunId: String(noOpRun.id),
    noopStateDigest: digestRows({ run: noOpRun, sourceHeadDigest, parserStateDigest }),
  };
}

function assertEvidenceMatchesDatabase(db: DatabaseType, evidence: ValidatedBackupEvidence): void {
  if (
    getMeta(db, CANONICAL_EXPANSION_META.expansionId) !== evidence.expansionId ||
    getMeta(db, CANONICAL_EXPANSION_META.manifestDigest) !== evidence.manifestDigest ||
    getMeta(db, CANONICAL_EXPANSION_META.manifestPath) !== evidence.manifestPath ||
    getMeta(db, CANONICAL_EXPANSION_META.sourceDigest) !== evidence.sourceDigest ||
    canonicalLegacySourceDigest(db) !== evidence.sourceDigest
  ) {
    throw new Error("Validated backup evidence is stale or belongs to another expansion");
  }
}

export function recordCanonicalFinalizationReadiness(
  db: DatabaseType,
  evidence: ValidatedBackupEvidence,
  now = Math.floor(Date.now() / 1_000),
): string {
  requireSealedEvidence(evidence);
  assertEvidenceMatchesDatabase(db, evidence);
  const state = assertExactCurrentParity(db);
  const id = randomUUID();
  db.transaction(() => {
    db.prepare("DELETE FROM canonical_cutover_audits").run();
    db.prepare(
      `INSERT INTO canonical_cutover_audits
         (id, manifest_path, manifest_digest, expansion_id, source_head_digest,
          parser_state_digest, successful_parse_run_id, noop_parse_run_id,
          noop_state_digest, backup_path, backup_sha256, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      evidence.manifestPath,
      evidence.manifestDigest,
      evidence.expansionId,
      state.sourceHeadDigest,
      state.parserStateDigest,
      state.successfulParseRunId,
      state.noopParseRunId,
      state.noopStateDigest,
      evidence.backupPath,
      evidence.backupSha256,
      now,
    );
  })();
  return id;
}

export function assertCanonicalFinalizationReady(
  db: DatabaseType,
  evidence: ValidatedBackupEvidence,
): void {
  requireSealedEvidence(evidence);
  assertEvidenceMatchesDatabase(db, evidence);
  const state = assertExactCurrentParity(db);
  const audit = db.prepare(
    `SELECT manifest_path, manifest_digest, expansion_id, source_head_digest,
            parser_state_digest, successful_parse_run_id, noop_parse_run_id,
            noop_state_digest, backup_path, backup_sha256
       FROM canonical_cutover_audits
      ORDER BY recorded_at DESC, rowid DESC
      LIMIT 1`,
  ).get() as FinalizationAuditRow | undefined;
  if (audit === undefined) throw new Error("Canonical finalization readiness has not been recorded");
  const expected: FinalizationAuditRow = {
    manifest_path: evidence.manifestPath,
    manifest_digest: evidence.manifestDigest,
    expansion_id: evidence.expansionId,
    source_head_digest: state.sourceHeadDigest,
    parser_state_digest: state.parserStateDigest,
    successful_parse_run_id: state.successfulParseRunId,
    noop_parse_run_id: state.noopParseRunId,
    noop_state_digest: state.noopStateDigest,
    backup_path: evidence.backupPath,
    backup_sha256: evidence.backupSha256,
  };
  if (Object.keys(expected).some((key) => audit[key as keyof FinalizationAuditRow] !== expected[key as keyof FinalizationAuditRow])) {
    throw new Error("Canonical finalization readiness is stale or substituted");
  }
}

export function migrateToVersion2(
  db: DatabaseType,
  evidence: ValidatedBackupEvidence,
  hooks: FinalizationMigrationHooks = {},
): SchemaInspection {
  const before = inspectSchemaVersion(db);
  if (before.state === "canonical") return before;
  if (before.state !== "transitional") {
    throw new Error("Canonical-only migration requires transitional schema version 1");
  }
  db.transaction(() => {
    assertCanonicalFinalizationReady(db, evidence);
    db.exec(`
      DROP TABLE line_tags;
      DROP TABLE lines;
      DROP TABLE sections;
      DROP TABLE updates;
    `);
    hooks.afterPrototypeDrop?.(db);
    db.pragma(`user_version = ${LATEST_SCHEMA_VERSION}`);
  })();
  const after = inspectSchemaVersion(db);
  if (after.state !== "canonical") throw new Error("Canonical-only migration did not reach schema version 2");
  return after;
}
