import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, posix } from "node:path";
import {
  inspectSchemaVersion,
  LATEST_SCHEMA_VERSION,
  runMigrations,
} from "@cs-patchnotes/shared";

const MANIFEST_CONTRACT_VERSION = 1;
const META_EXPANSION_ID = "canonical_expansion_id";
const META_MANIFEST_DIGEST = "canonical_backup_manifest_sha256";
const META_MANIFEST_PATH = "canonical_backup_manifest_path";
const META_EXPANSION_CREATED_AT = "canonical_expansion_created_at";
const META_SOURCE_DIGEST = "canonical_legacy_source_digest";

const LEGACY_TABLES = ["updates", "sections", "lines", "line_tags"] as const;

interface FileIdentity {
  path: string;
  device: number;
  inode: number;
  size: number;
  mtime_ms: number;
}

interface TargetEvidence extends FileIdentity {
  user_version: number;
  table_counts: Record<(typeof LEGACY_TABLES)[number], number>;
  legacy_source_digest: string;
}

interface BackupEvidence extends FileIdentity {
  sha256: string;
}

export interface CanonicalBackupManifest {
  contract_version: number;
  manifest_id: string;
  expansion_id: string;
  created_at: string;
  target: TargetEvidence;
  backup: BackupEvidence;
  open_verification: {
    ok: true;
    user_version: number;
    quick_check: "ok";
  };
}

export interface CanonicalAuditReport {
  ok: boolean;
  target_path: string;
  schema_version: number;
  source_digest: string;
  counts: {
    legacy_updates: number;
    legacy_line_tags: number;
    documents: number;
    gid_aliases: number;
    publisher_locators: number;
    current_source_heads: number;
    source_revisions: number;
  };
  failures: Array<{ code: string; count: number }>;
}

interface ParsedMigrateArgs {
  stage: "expand";
  apply: true;
  backupManifestPath: string;
}

interface ParsedAuditArgs {
  strict: true;
}

export interface MigrationHooks {
  beforeBackupVerification?: (backupPath: string) => void;
  afterExpansion?: (db: DatabaseType) => void;
}

export interface MigrateCanonicalOptions {
  sqlitePath?: string;
  approvedTargetPath?: string;
  args?: string[];
  hooks?: MigrationHooks;
}

export interface AuditCanonicalOptions {
  sqlitePath?: string;
  args?: string[];
}

export interface MigrateCanonicalReport {
  ok: true;
  target_path: string;
  manifest_path: string;
  expansion_id: string;
  source_digest: string;
  retry: boolean;
}

interface LegacyUpdateParityRow {
  gid: string;
  raw_body: string;
  url: string | null;
  document_id: string | null;
  content_kind: string | null;
  source_record_id: string | null;
  pristine_body: string | null;
  body_sha256: string | null;
  locator_count: number;
}

function requireAbsolutePosixPath(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0 || !posix.isAbsolute(value)) {
    throw new Error(`${label} must be an explicit absolute POSIX path`);
  }
  return value;
}

export function parseMigrateCanonicalArgs(args: readonly string[]): ParsedMigrateArgs {
  let stage: string | undefined;
  let apply = false;
  let backupManifestPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") {
      if (apply) throw new Error("Duplicate --apply flag");
      apply = true;
    } else if (argument === "--stage") {
      if (stage !== undefined || index + 1 >= args.length) {
        throw new Error("--stage requires exactly one value");
      }
      stage = args[++index];
    } else if (argument === "--backup-manifest") {
      if (backupManifestPath !== undefined || index + 1 >= args.length) {
        throw new Error("--backup-manifest requires exactly one value");
      }
      backupManifestPath = args[++index];
    } else {
      throw new Error(`Unknown migrate-canonical argument: ${argument}`);
    }
  }

  if (stage !== "expand") {
    throw new Error("migrate-canonical requires --stage expand; finalization is unavailable");
  }
  if (!apply) throw new Error("migrate-canonical requires the explicit --apply flag");

  return {
    stage: "expand",
    apply: true,
    backupManifestPath: requireAbsolutePosixPath(
      backupManifestPath,
      "--backup-manifest",
    ),
  };
}

export function parseAuditCanonicalArgs(args: readonly string[]): ParsedAuditArgs {
  if (args.length !== 1 || args[0] !== "--strict") {
    throw new Error("audit-canonical requires exactly --strict");
  }
  return { strict: true };
}

function sha256Bytes(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashFile(path: string): string {
  return sha256Bytes(readFileSync(path));
}

function fileIdentity(path: string): FileIdentity {
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

function countTable(db: DatabaseType, table: (typeof LEGACY_TABLES)[number]): number {
  return db.prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number;
}

function legacyTableCounts(
  db: DatabaseType,
): Record<(typeof LEGACY_TABLES)[number], number> {
  return {
    updates: countTable(db, "updates"),
    sections: countTable(db, "sections"),
    lines: countTable(db, "lines"),
    line_tags: countTable(db, "line_tags"),
  };
}

function legacySourceDigest(db: DatabaseType): string {
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

function targetEvidence(db: DatabaseType, path: string): TargetEvidence {
  return {
    ...fileIdentity(path),
    user_version: db.pragma("user_version", { simple: true }) as number,
    table_counts: legacyTableCounts(db),
    legacy_source_digest: legacySourceDigest(db),
  };
}

function verifyBackup(path: string): CanonicalBackupManifest["open_verification"] {
  const backup = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const quickCheck = backup.pragma("quick_check", { simple: true });
    if (quickCheck !== "ok") throw new Error("Backup PRAGMA quick_check failed");
    return {
      ok: true,
      user_version: backup.pragma("user_version", { simple: true }) as number,
      quick_check: "ok",
    };
  } finally {
    backup.close();
  }
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
}

function publishManifestAtomically(path: string, bytes: Buffer): void {
  if (existsSync(path)) throw new Error(`Backup manifest already exists at ${path}`);
  const directory = dirname(path);
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeAll(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (existsSync(path)) throw new Error(`Backup manifest appeared concurrently at ${path}`);
    renameSync(temporaryPath, path);
    const directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
}

function readApprovedTarget(): string {
  const artifactPath = requireAbsolutePosixPath(
    process.env.CANONICAL_CUTOVER_TARGET_FILE,
    "CANONICAL_CUTOVER_TARGET_FILE",
  );
  const parsed = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
  if (Object.keys(parsed).length !== 1 || typeof parsed.sqlite_path !== "string") {
    throw new Error("Approved cutover target artifact must contain only sqlite_path");
  }
  return requireAbsolutePosixPath(parsed.sqlite_path, "approved sqlite_path");
}

function getMeta(db: DatabaseType, key: string): string | undefined {
  return db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(key) as
    | string
    | undefined;
}

function setMeta(db: DatabaseType, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

function auditDatabase(db: DatabaseType, targetPath: string): CanonicalAuditReport {
  const inspection = inspectSchemaVersion(db);
  const failures = new Map<string, number>();
  const fail = (code: string, count = 1): void => {
    failures.set(code, (failures.get(code) ?? 0) + count);
  };

  if (inspection.userVersion !== LATEST_SCHEMA_VERSION || inspection.state !== "transitional") {
    fail("SCHEMA_VERSION");
  }

  const counts = {
    legacy_updates: countTable(db, "updates"),
    legacy_line_tags: countTable(db, "line_tags"),
    documents: db.prepare("SELECT count(*) FROM documents").pluck().get() as number,
    gid_aliases: db
      .prepare("SELECT count(*) FROM external_identifiers WHERE namespace='steam_news_gid'")
      .pluck()
      .get() as number,
    publisher_locators: db
      .prepare("SELECT count(*) FROM source_locators WHERE namespace='steam_news_url'")
      .pluck()
      .get() as number,
    current_source_heads: db
      .prepare("SELECT count(*) FROM document_source_heads WHERE source_adapter='steam_news'")
      .pluck()
      .get() as number,
    source_revisions: db
      .prepare("SELECT count(*) FROM source_records WHERE source_adapter='steam_news'")
      .pluck()
      .get() as number,
  };

  if (counts.legacy_line_tags !== 0) fail("LEGACY_CLASSIFICATION_ROWS", counts.legacy_line_tags);
  if (counts.documents !== counts.legacy_updates) fail("DOCUMENT_COUNT");
  if (counts.gid_aliases !== counts.legacy_updates) fail("GID_ALIAS_COUNT");
  if (counts.publisher_locators !== counts.legacy_updates) fail("PUBLISHER_LOCATOR_COUNT");
  if (counts.current_source_heads !== counts.legacy_updates) fail("CURRENT_HEAD_COUNT");
  if (counts.source_revisions < counts.legacy_updates) fail("SOURCE_REVISION_COUNT");

  const rows = db
    .prepare(
      `SELECT legacy.id AS gid,
              legacy.raw_body,
              legacy.url,
              identifier.document_id,
              document.content_kind,
              head.source_record_id,
              source.pristine_body,
              source.body_sha256,
              (SELECT count(*)
                 FROM source_locators locator
                WHERE locator.document_id = identifier.document_id
                  AND locator.namespace = 'steam_news_url'
                  AND locator.locator = legacy.url) AS locator_count
         FROM updates legacy
         LEFT JOIN external_identifiers identifier
           ON identifier.namespace = 'steam_news_gid' AND identifier.value = legacy.id
         LEFT JOIN documents document ON document.id = identifier.document_id
         LEFT JOIN document_source_heads head
           ON head.document_id = identifier.document_id AND head.source_adapter = 'steam_news'
         LEFT JOIN source_records source
           ON source.id = head.source_record_id
          AND source.document_id = head.document_id
          AND source.source_adapter = head.source_adapter
        ORDER BY legacy.id`,
    )
    .all() as LegacyUpdateParityRow[];

  for (const row of rows) {
    if (row.document_id === null || row.content_kind !== "patch_notes") fail("IDENTITY_PARITY");
    if (row.source_record_id === null || row.pristine_body === null) {
      fail("CURRENT_SOURCE_PARITY");
    } else if (
      row.pristine_body !== row.raw_body ||
      row.body_sha256 !== sha256Bytes(Buffer.from(row.raw_body, "utf8"))
    ) {
      fail("CURRENT_SOURCE_PARITY");
    }
    if (row.url !== null && row.url.length > 0 && row.locator_count !== 1) {
      fail("LOCATOR_PARITY");
    }
  }

  const foreignKeyFailures = db.pragma("foreign_key_check") as unknown[];
  if (foreignKeyFailures.length > 0) fail("FOREIGN_KEY_CHECK", foreignKeyFailures.length);

  const sourceDigest = legacySourceDigest(db);
  const recordedDigest = getMeta(db, META_SOURCE_DIGEST);
  if (recordedDigest !== undefined && recordedDigest !== sourceDigest) fail("SOURCE_DIGEST_DRIFT");

  return {
    ok: failures.size === 0,
    target_path: targetPath,
    schema_version: inspection.userVersion,
    source_digest: sourceDigest,
    counts,
    failures: [...failures].map(([code, count]) => ({ code, count })),
  };
}

function parseManifest(bytes: Buffer): CanonicalBackupManifest {
  const manifest = JSON.parse(bytes.toString("utf8")) as CanonicalBackupManifest;
  if (
    manifest.contract_version !== MANIFEST_CONTRACT_VERSION ||
    typeof manifest.manifest_id !== "string" ||
    typeof manifest.expansion_id !== "string" ||
    typeof manifest.target?.path !== "string" ||
    typeof manifest.backup?.path !== "string" ||
    typeof manifest.target?.legacy_source_digest !== "string"
  ) {
    throw new Error("Backup manifest does not satisfy the canonical contract");
  }
  return manifest;
}

function verifyRetryEvidence(
  db: DatabaseType,
  targetPath: string,
  manifestPath: string,
): { manifest: CanonicalBackupManifest; manifestBytes: Buffer } {
  const manifestBytes = readFileSync(manifestPath);
  const manifest = parseManifest(manifestBytes);
  if (manifest.target.path !== targetPath) throw new Error("Manifest target identity mismatch");
  if (manifest.backup.path !== `${manifestPath}.sqlite-backup`) {
    throw new Error("Manifest backup identity mismatch");
  }
  if (hashFile(manifest.backup.path) !== manifest.backup.sha256) {
    throw new Error("Manifest backup SHA-256 mismatch");
  }
  const verification = verifyBackup(manifest.backup.path);
  if (verification.user_version !== manifest.open_verification.user_version) {
    throw new Error("Manifest backup schema identity mismatch");
  }
  if (getMeta(db, META_EXPANSION_ID) !== manifest.expansion_id) {
    throw new Error("Database expansion identity does not match explicit manifest");
  }
  if (getMeta(db, META_MANIFEST_DIGEST) !== sha256Bytes(manifestBytes)) {
    throw new Error("Database manifest digest does not match explicit manifest");
  }
  if (getMeta(db, META_MANIFEST_PATH) !== manifestPath) {
    throw new Error("Database manifest path does not match explicit manifest");
  }
  if (getMeta(db, META_SOURCE_DIGEST) !== manifest.target.legacy_source_digest) {
    throw new Error("Database source digest does not match explicit manifest");
  }
  return { manifest, manifestBytes };
}

export async function runMigrateCanonical(
  options: MigrateCanonicalOptions = {},
): Promise<MigrateCanonicalReport> {
  const cliInvocation = arguments.length === 0;
  const args = parseMigrateCanonicalArgs(options.args ?? process.argv.slice(3));
  const targetPath = requireAbsolutePosixPath(
    options.sqlitePath ?? process.env.SQLITE_PATH,
    "SQLITE_PATH",
  );
  const approvedTargetPath = requireAbsolutePosixPath(
    options.approvedTargetPath ?? readApprovedTarget(),
    "approved target",
  );
  if (targetPath !== approvedTargetPath) {
    throw new Error("SQLITE_PATH does not match the machine-readable approved target");
  }

  const manifestPath = args.backupManifestPath;
  const db = new Database(targetPath, { fileMustExist: true });
  db.pragma("foreign_keys = ON");
  try {
    const inspection = inspectSchemaVersion(db);
    if (inspection.state === "transitional") {
      const { manifest } = verifyRetryEvidence(db, targetPath, manifestPath);
      const audit = auditDatabase(db, targetPath);
      if (!audit.ok) throw new Error(`Canonical retry audit failed: ${JSON.stringify(audit.failures)}`);
      const report: MigrateCanonicalReport = {
        ok: true,
        target_path: targetPath,
        manifest_path: manifestPath,
        expansion_id: manifest.expansion_id,
        source_digest: audit.source_digest,
        retry: true,
      };
      if (cliInvocation) console.log(JSON.stringify(report));
      return report;
    }
    if (inspection.state !== "legacy") {
      throw new Error(`Canonical expansion requires a legacy version-0 database, found ${inspection.state}`);
    }

    const target = targetEvidence(db, targetPath);
    if (cliInvocation) {
      console.log(
        JSON.stringify({
          event: "canonical_preflight",
          target_path: targetPath,
          user_version: target.user_version,
          table_counts: target.table_counts,
          source_digest: target.legacy_source_digest,
        }),
      );
    }
    if (target.table_counts.line_tags !== 0) {
      throw new Error("Canonical expansion refuses existing legacy classification rows in line_tags");
    }
    if (existsSync(manifestPath)) throw new Error(`Backup manifest already exists at ${manifestPath}`);

    const backupPath = `${manifestPath}.sqlite-backup`;
    if (existsSync(backupPath)) throw new Error(`Backup destination already exists at ${backupPath}`);
    await db.backup(backupPath);
    options.hooks?.beforeBackupVerification?.(backupPath);
    const openVerification = verifyBackup(backupPath);
    if (openVerification.user_version !== target.user_version) {
      throw new Error("Backup schema version does not match preflight target");
    }

    const manifest: CanonicalBackupManifest = {
      contract_version: MANIFEST_CONTRACT_VERSION,
      manifest_id: randomUUID(),
      expansion_id: randomUUID(),
      created_at: new Date().toISOString(),
      target,
      backup: {
        ...fileIdentity(backupPath),
        sha256: hashFile(backupPath),
      },
      open_verification: openVerification,
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    publishManifestAtomically(manifestPath, manifestBytes);

    const expand = db.transaction(() => {
      runMigrations(db);
      options.hooks?.afterExpansion?.(db);
      const parity = auditDatabase(db, targetPath);
      if (!parity.ok) throw new Error(`Canonical expansion parity failed: ${JSON.stringify(parity.failures)}`);
      setMeta(db, META_EXPANSION_ID, manifest.expansion_id);
      setMeta(db, META_MANIFEST_DIGEST, sha256Bytes(manifestBytes));
      setMeta(db, META_MANIFEST_PATH, manifestPath);
      setMeta(db, META_EXPANSION_CREATED_AT, manifest.created_at);
      setMeta(db, META_SOURCE_DIGEST, target.legacy_source_digest);
    });
    expand();

    const report: MigrateCanonicalReport = {
      ok: true,
      target_path: targetPath,
      manifest_path: manifestPath,
      expansion_id: manifest.expansion_id,
      source_digest: target.legacy_source_digest,
      retry: false,
    };
    if (cliInvocation) console.log(JSON.stringify(report));
    return report;
  } finally {
    db.close();
  }
}

export async function runAuditCanonical(
  options: AuditCanonicalOptions = {},
): Promise<CanonicalAuditReport> {
  const cliInvocation = arguments.length === 0;
  parseAuditCanonicalArgs(options.args ?? process.argv.slice(3));
  const targetPath = requireAbsolutePosixPath(
    options.sqlitePath ?? process.env.SQLITE_PATH,
    "SQLITE_PATH",
  );
  const db = new Database(targetPath, { readonly: true, fileMustExist: true });
  try {
    const report = auditDatabase(db, targetPath);
    if (!report.ok) throw new Error(`Strict canonical audit failed: ${JSON.stringify(report)}`);
    if (cliInvocation) console.log(JSON.stringify(report));
    return report;
  } finally {
    db.close();
  }
}
