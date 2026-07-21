#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(git rev-parse --show-toplevel)"
cd "$PROJECT_ROOT"

require_variable() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    printf 'ERROR: %s must be set\n' "$name" >&2
    exit 2
  fi
}

require_variable CUTOVER_TARGET_FILE
require_variable CUTOVER_BACKUP_MANIFEST_FILE

if [[ "${CUTOVER_RESUME:-0}" != "0" && "${CUTOVER_RESUME:-0}" != "1" ]]; then
  printf 'ERROR: CUTOVER_RESUME must be exactly 0 or 1\n' >&2
  exit 2
fi
if [[ -n "${CUTOVER_RESUME_STAGE:-}" && "${CUTOVER_RESUME_STAGE}" != "canonical-v2" ]]; then
  printf 'ERROR: CUTOVER_RESUME_STAGE must be empty or canonical-v2\n' >&2
  exit 2
fi
if [[ -n "${CUTOVER_RESUME_STAGE:-}" && "${CUTOVER_RESUME:-0}" != "1" ]]; then
  printf 'ERROR: CUTOVER_RESUME_STAGE requires CUTOVER_RESUME=1\n' >&2
  exit 2
fi

# Read the one approved value through Node and a NUL delimiter. `read -d` keeps
# every byte representable in a POSIX path, including spaces and trailing lines.
if ! IFS= read -r -d '' SQLITE_PATH < <(
  node - "$CUTOVER_TARGET_FILE" <<'NODE'
const { readFileSync } = require("node:fs");
const { posix } = require("node:path");
const artifact = process.argv[2];
let parsed;
try {
  parsed = JSON.parse(readFileSync(artifact, "utf8"));
} catch {
  process.stderr.write("ERROR: CUTOVER_TARGET_FILE must be readable valid JSON\n");
  process.exit(2);
}
if (
  parsed === null ||
  Array.isArray(parsed) ||
  typeof parsed !== "object" ||
  Object.keys(parsed).length !== 1 ||
  typeof parsed.sqlite_path !== "string" ||
  !posix.isAbsolute(parsed.sqlite_path)
) {
  process.stderr.write("ERROR: target JSON must contain exactly one absolute POSIX sqlite_path\n");
  process.exit(2);
}
process.stdout.write(parsed.sqlite_path);
process.stdout.write("\0");
NODE
); then
  exit 2
fi

if ! IFS= read -r -d '' CUTOVER_TARGET_FILE_ABS < <(
  node - "$CUTOVER_TARGET_FILE" <<'NODE'
const { resolve } = require("node:path");
process.stdout.write(resolve(process.argv[2]));
process.stdout.write("\0");
NODE
); then
  exit 2
fi

node - "$CUTOVER_BACKUP_MANIFEST_FILE" <<'NODE'
const { posix } = require("node:path");
if (!posix.isAbsolute(process.argv[2])) {
  process.stderr.write("ERROR: CUTOVER_BACKUP_MANIFEST_FILE must be an absolute POSIX path\n");
  process.exit(2);
}
NODE

if [[ ! -f "$CUTOVER_TARGET_FILE_ABS" ]]; then
  printf 'ERROR: CUTOVER_TARGET_FILE is not a regular file\n' >&2
  exit 2
fi
if [[ ! -f "$SQLITE_PATH" ]]; then
  printf 'ERROR: approved sqlite_path is not a regular file\n' >&2
  exit 2
fi
if ! IFS= read -r -d '' TARGET_DIRECTORY < <(
  node - "$SQLITE_PATH" <<'NODE'
const { posix } = require("node:path");
process.stdout.write(posix.dirname(process.argv[2]));
process.stdout.write("\0");
NODE
); then
  exit 2
fi
MANIFEST_DIRECTORY="${CUTOVER_BACKUP_MANIFEST_FILE%/*}"
if [[ ! -d "$MANIFEST_DIRECTORY" || ! -w "$MANIFEST_DIRECTORY" ]]; then
  printf 'ERROR: backup evidence directory must already exist and be writable\n' >&2
  exit 2
fi
if [[ -e "$CUTOVER_BACKUP_MANIFEST_FILE" ]]; then
  if [[ "${CUTOVER_RESUME:-0}" != "1" ]]; then
    printf 'ERROR: explicit backup manifest exists; resume requires CUTOVER_RESUME=1\n' >&2
    exit 2
  fi
  if [[ ! -f "$CUTOVER_BACKUP_MANIFEST_FILE" || ! -f "${CUTOVER_BACKUP_MANIFEST_FILE}.sqlite-backup" ]]; then
    printf 'ERROR: resume requires the exact manifest and its manifest-owned backup\n' >&2
    exit 2
  fi
else
  if [[ "${CUTOVER_RESUME:-0}" == "1" ]]; then
    printf 'ERROR: CUTOVER_RESUME=1 requires the exact existing manifest\n' >&2
    exit 2
  fi
  if [[ -e "${CUTOVER_BACKUP_MANIFEST_FILE}.sqlite-backup" ]]; then
    printf 'ERROR: manifest-owned backup exists without its explicit manifest\n' >&2
    exit 2
  fi
fi

CUTOVER_LOG_FILE="${CUTOVER_BACKUP_MANIFEST_FILE}.cutover.log"
if [[ -e "$CUTOVER_LOG_FILE" && ! -f "$CUTOVER_LOG_FILE" ]]; then
  printf 'ERROR: cutover log path exists but is not a regular file\n' >&2
  exit 2
fi
if [[ ! -e "$CUTOVER_LOG_FILE" ]]; then
  : >"$CUTOVER_LOG_FILE"
  chmod 600 "$CUTOVER_LOG_FILE"
fi
exec > >(tee -a "$CUTOVER_LOG_FILE") 2>&1
printf '\ncutover attempt started\n'
if [[ "${CUTOVER_RESUME:-0}" == "1" ]]; then
  printf 'resume mode: exact existing manifest and backup selected; canonical retry validation is mandatory\n'
  if [[ "${CUTOVER_RESUME_STAGE:-}" == "canonical-v2" ]]; then
    printf 'resume stage: canonical-v2 evidence validation before disposable rebuild\n'
  fi
fi

SERVICES_STARTED=0
CUTOVER_SUCCEEDED=0

print_restore_evidence() {
  if [[ ! -f "$CUTOVER_BACKUP_MANIFEST_FILE" ]]; then
    printf 'restore command unavailable: explicit manifest was not published\n'
    return 0
  fi
  node - "$CUTOVER_BACKUP_MANIFEST_FILE" "$SQLITE_PATH" <<'NODE'
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const Database = require("better-sqlite3");
const manifestPath = process.argv[2];
const targetPath = process.argv[3];
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (
  manifest?.target?.path !== targetPath ||
  manifest?.backup?.path !== `${manifestPath}.sqlite-backup` ||
  typeof manifest?.backup?.sha256 !== "string"
) {
  throw new Error("explicit manifest identity is invalid; no restore command emitted");
}
const bytes = readFileSync(manifest.backup.path);
const actualHash = createHash("sha256").update(bytes).digest("hex");
if (actualHash !== manifest.backup.sha256) {
  throw new Error("explicit backup hash is invalid; no restore command emitted");
}
const db = new Database(manifest.backup.path, { readonly: true, fileMustExist: true });
try {
  if (db.pragma("quick_check", { simple: true }) !== "ok") {
    throw new Error("explicit backup quick check failed; no restore command emitted");
  }
  if (db.pragma("user_version", { simple: true }) !== 0) {
    throw new Error("explicit backup is not schema version 0; no restore command emitted");
  }
} finally {
  db.close();
}
const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
process.stdout.write(`restore command: cp -- ${quote(manifest.backup.path)} ${quote(targetPath)}\n`);
NODE
}

finish() {
  local status=$?
  set +e
  if (( SERVICES_STARTED == 1 )); then
    docker compose down
  fi
  if (( status != 0 || CUTOVER_SUCCEEDED == 0 )); then
    printf 'cutover failed (status=%s); target, explicit manifest, backup, and log were preserved\n' "$status"
    print_restore_evidence || printf 'restore evidence validation failed; do not restore from unvalidated data\n'
  else
    printf 'cutover completed; transient services stopped and evidence preserved\n'
  fi
  trap - EXIT
  exit "$status"
}
trap finish EXIT

printf 'cutover preflight: approved target and explicit evidence paths validated\n'

# Every workspace and image gate runs before the first database mutation.
node scripts/check-canonical-stale-references.mjs --strict
npm test
npm run build
docker compose --profile seed build poller api
docker build --target build --tag cs-patchnotes-api-live-test:local --file packages/api/Dockerfile .

# Resolve Compose's already-configured private key without printing it. The key is
# exported only so `docker run -e MEILI_MASTER_KEY` can forward the value by name.
if ! IFS= read -r -d '' MEILI_MASTER_KEY < <(
  docker compose config --format json | node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const value = JSON.parse(input)?.services?.meili?.environment?.MEILI_MASTER_KEY;
      if (typeof value !== "string" || value.length === 0) process.exit(2);
      process.stdout.write(value);
      process.stdout.write("\0");
    });
  '
); then
  printf 'ERROR: private Meilisearch configuration is missing\n' >&2
  exit 2
fi
export MEILI_MASTER_KEY

docker compose up -d meili
SERVICES_STARTED=1

run_poller() {
  docker compose --profile seed run --rm --no-deps \
    -e "SQLITE_PATH=$SQLITE_PATH" \
    -e "CANONICAL_CUTOVER_TARGET_FILE=$CUTOVER_TARGET_FILE_ABS" \
    -v "$TARGET_DIRECTORY:$TARGET_DIRECTORY" \
    -v "$CUTOVER_TARGET_FILE_ABS:$CUTOVER_TARGET_FILE_ABS:ro" \
    -v "$MANIFEST_DIRECTORY:$MANIFEST_DIRECTORY" \
    poller "$@"
}

verify_backup() {
  local mode="$1"
  docker compose --profile seed run --rm --no-deps \
    --entrypoint node \
    -e "SQLITE_PATH=$SQLITE_PATH" \
    -v "$TARGET_DIRECTORY:$TARGET_DIRECTORY" \
    -v "$MANIFEST_DIRECTORY:$MANIFEST_DIRECTORY:ro" \
    poller -e '
      const { createHash } = require("node:crypto");
      const { readFileSync } = require("node:fs");
      const Database = require("better-sqlite3");
      const mode = process.argv[1];
      const manifestPath = process.argv[2];
      const targetPath = process.argv[3];
      const manifestBytes = readFileSync(manifestPath);
      const manifest = JSON.parse(manifestBytes);
      if (manifest.target.path !== targetPath) throw new Error("backup target identity mismatch");
      if (manifest.backup.path !== manifestPath + ".sqlite-backup") throw new Error("backup path identity mismatch");
      const hash = createHash("sha256").update(readFileSync(manifest.backup.path)).digest("hex");
      if (hash !== manifest.backup.sha256) throw new Error("backup SHA-256 mismatch");
      const backup = new Database(manifest.backup.path, { readonly: true, fileMustExist: true });
      try {
        if (backup.pragma("quick_check", { simple: true }) !== "ok") throw new Error("backup quick check failed");
        if (backup.pragma("user_version", { simple: true }) !== 0) throw new Error("backup schema is not version 0");
        const expected = { updates: 274, sections: 828, lines: 4173, line_tags: 0 };
        for (const [table, count] of Object.entries(expected)) {
          const actual = backup.prepare(`SELECT count(*) FROM ${table}`).pluck().get();
          if (actual !== count || manifest.target.table_counts[table] !== count) {
            throw new Error(`backup ${table} count mismatch`);
          }
        }
        if (mode === "pre") {
          const target = new Database(targetPath, { readonly: true, fileMustExist: true });
          try {
            if (target.pragma("user_version", { simple: true }) !== 1) throw new Error("live target did not stop at version 1");
            const backupRows = backup.prepare("SELECT id, raw_body, url FROM updates ORDER BY id").all();
            const targetRows = target.prepare("SELECT id, raw_body, url FROM updates ORDER BY id").all();
            if (JSON.stringify(backupRows) !== JSON.stringify(targetRows)) throw new Error("legacy source bytes changed during expansion");
            const currentRows = target.prepare(`
              SELECT identifier.value AS gid, source.pristine_body, source.body_sha256
                FROM external_identifiers identifier
                JOIN document_source_heads head ON head.document_id = identifier.document_id
                JOIN source_records source ON source.id = head.source_record_id
               WHERE identifier.namespace = ?
                 AND head.source_adapter = ?
               ORDER BY identifier.value`).all("steam_news_gid", "steam_news");
            if (currentRows.length !== backupRows.length) throw new Error("canonical source row count mismatch");
            for (let index = 0; index < backupRows.length; index += 1) {
              const legacy = backupRows[index];
              const current = currentRows[index];
              const bodyHash = createHash("sha256").update(Buffer.from(legacy.raw_body, "utf8")).digest("hex");
              if (current.gid !== legacy.id || current.pristine_body !== legacy.raw_body || current.body_sha256 !== bodyHash) {
                throw new Error("canonical pristine source parity mismatch");
              }
            }
          } finally {
            target.close();
          }
        }
      } finally {
        backup.close();
      }
      console.log("backup_verified schema=0 updates=274 sections=828 lines=4173 line_tags=0 sha256=" + hash);
    ' "$mode" "$CUTOVER_BACKUP_MANIFEST_FILE" "$SQLITE_PATH"
}

verify_canonical_v2_resume() {
  docker compose --profile seed run --rm --no-deps \
    --entrypoint node \
    -e "SQLITE_PATH=$SQLITE_PATH" \
    -v "$TARGET_DIRECTORY:$TARGET_DIRECTORY" \
    -v "$MANIFEST_DIRECTORY:$MANIFEST_DIRECTORY:ro" \
    poller -e '
      const { createHash } = require("node:crypto");
      const { readFileSync, statSync } = require("node:fs");
      const Database = require("better-sqlite3");
      const manifestPath = process.argv[1];
      const targetPath = process.argv[2];
      const bytes = readFileSync(manifestPath);
      const digest = createHash("sha256").update(bytes).digest("hex");
      const manifest = JSON.parse(bytes);
      if (manifest.contract_version !== 1) throw new Error("resume manifest contract mismatch");
      if (manifest.target.path !== targetPath) throw new Error("resume target path mismatch");
      if (manifest.backup.path !== manifestPath + ".sqlite-backup") throw new Error("resume backup path mismatch");
      const targetStat = statSync(targetPath);
      if (targetStat.dev !== manifest.target.device || targetStat.ino !== manifest.target.inode) {
        throw new Error("resume target file identity mismatch");
      }
      const backupStat = statSync(manifest.backup.path);
      for (const [actual, expected, label] of [
        [backupStat.dev, manifest.backup.device, "device"],
        [backupStat.ino, manifest.backup.inode, "inode"],
        [backupStat.size, manifest.backup.size, "size"],
        [backupStat.mtimeMs, manifest.backup.mtime_ms, "modified time"],
      ]) {
        if (actual !== expected) throw new Error(`resume backup ${label} mismatch`);
      }
      const backupHash = createHash("sha256").update(readFileSync(manifest.backup.path)).digest("hex");
      if (backupHash !== manifest.backup.sha256) throw new Error("resume backup SHA-256 mismatch");
      const backup = new Database(manifest.backup.path, { readonly: true, fileMustExist: true });
      const target = new Database(targetPath, { readonly: true, fileMustExist: true });
      const count = (db, table) => db.prepare(`SELECT count(*) FROM ${table}`).pluck().get();
      const meta = (key) => target.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(key);
      try {
        if (backup.pragma("quick_check", { simple: true }) !== "ok" || backup.pragma("user_version", { simple: true }) !== 0) {
          throw new Error("resume backup open verification failed");
        }
        const expectedLegacy = { updates: 274, sections: 828, lines: 4173, line_tags: 0 };
        for (const [table, expected] of Object.entries(expectedLegacy)) {
          if (count(backup, table) !== expected || manifest.target.table_counts[table] !== expected) {
            throw new Error(`resume backup ${table} evidence mismatch`);
          }
        }
        if (target.pragma("quick_check", { simple: true }) !== "ok" || target.pragma("user_version", { simple: true }) !== 2) {
          throw new Error("resume target is not healthy canonical version 2");
        }
        if (target.pragma("foreign_key_check").length !== 0) throw new Error("resume target foreign keys failed");
        const prototypeCount = target.prepare(`
          SELECT count(*) FROM sqlite_master
           WHERE type = ? AND name IN (?, ?, ?, ?)`)
          .pluck().get("table", "updates", "sections", "lines", "line_tags");
        if (prototypeCount !== 0) throw new Error("resume target retains prototype tables");
        const counts = {
          documents: count(target, "documents"),
          gids: target.prepare("SELECT count(*) FROM external_identifiers WHERE namespace = ?").pluck().get("steam_news_gid"),
          locators: target.prepare("SELECT count(*) FROM source_locators WHERE namespace = ?").pluck().get("steam_news_url"),
          heads: target.prepare("SELECT count(*) FROM document_source_heads WHERE source_adapter = ?").pluck().get("steam_news"),
          revisions: target.prepare("SELECT count(*) FROM source_records WHERE source_adapter = ?").pluck().get("steam_news"),
          unresolved: target.prepare("SELECT count(*) FROM documents WHERE parse_status <> ?").pluck().get("parsed"),
          incomplete: target.prepare("SELECT count(*) FROM document_parse_state WHERE selection_state <> ? OR materialization_status <> ?").pluck().get("selected", "complete"),
          bbcode: target.prepare("SELECT count(*) FROM document_parse_state WHERE parser_key = ?").pluck().get("steam-news-bbcode"),
          plaintext: target.prepare("SELECT count(*) FROM document_parse_state WHERE parser_key = ?").pluck().get("steam-patch-plaintext"),
        };
        if (JSON.stringify(counts) !== JSON.stringify({ documents: 274, gids: 274, locators: 274, heads: 274, revisions: 274, unresolved: 0, incomplete: 0, bbcode: 224, plaintext: 50 })) {
          throw new Error("resume canonical corpus baseline mismatch");
        }
        if (meta("canonical_expansion_id") !== manifest.expansion_id ||
            meta("canonical_backup_manifest_path") !== manifestPath ||
            meta("canonical_backup_manifest_sha256") !== digest ||
            meta("canonical_legacy_source_digest") !== manifest.target.legacy_source_digest) {
          throw new Error("resume expansion metadata mismatch");
        }
        const audit = target.prepare("SELECT * FROM canonical_cutover_audits WHERE expansion_id = ? AND manifest_path = ?").get(manifest.expansion_id, manifestPath);
        if (!audit || audit.manifest_digest !== digest || audit.backup_path !== manifest.backup.path || audit.backup_sha256 !== manifest.backup.sha256) {
          throw new Error("resume finalization audit mismatch");
        }
        const materialized = target.prepare("SELECT * FROM parse_runs WHERE id = ?").get(audit.successful_parse_run_id);
        const unchanged = target.prepare("SELECT * FROM parse_runs WHERE id = ?").get(audit.noop_parse_run_id);
        if (!materialized || materialized.status !== "succeeded" || materialized.attempted_count !== 274 || materialized.selected_count !== 274 || materialized.unchanged_count !== 0 || materialized.partial_count !== 0 || materialized.quarantined_count !== 0 || materialized.error_count !== 0) {
          throw new Error("resume materializing parse evidence mismatch");
        }
        if (!unchanged || unchanged.status !== "succeeded" || unchanged.attempted_count !== 274 || unchanged.selected_count !== 274 || unchanged.unchanged_count !== 274 || unchanged.partial_count !== 0 || unchanged.quarantined_count !== 0 || unchanged.error_count !== 0) {
          throw new Error("resume no-op parse evidence mismatch");
        }
        const legacyRows = backup.prepare("SELECT id, raw_body FROM updates ORDER BY id").all();
        const sourceRows = target.prepare(`
          SELECT identifier.value AS gid, source.pristine_body, source.body_sha256
            FROM external_identifiers identifier
            JOIN document_source_heads head ON head.document_id = identifier.document_id
            JOIN source_records source ON source.id = head.source_record_id
           WHERE identifier.namespace = ? AND head.source_adapter = ?
           ORDER BY identifier.value`).all("steam_news_gid", "steam_news");
        if (legacyRows.length !== sourceRows.length) throw new Error("resume pristine source count mismatch");
        for (let index = 0; index < legacyRows.length; index += 1) {
          const legacy = legacyRows[index];
          const source = sourceRows[index];
          const bodyHash = createHash("sha256").update(Buffer.from(legacy.raw_body, "utf8")).digest("hex");
          if (source.gid !== legacy.id || source.pristine_body !== legacy.raw_body || source.body_sha256 !== bodyHash) {
            throw new Error("resume pristine source bytes mismatch");
          }
        }
      } finally {
        target.close();
        backup.close();
      }
      console.log("canonical_v2_resume_verified documents=274 bbcode=224 plaintext=50 unchanged=274 backup_sha256=" + backupHash);
    ' "$CUTOVER_BACKUP_MANIFEST_FILE" "$SQLITE_PATH"
}

if [[ "${CUTOVER_RESUME_STAGE:-}" == "canonical-v2" ]]; then
  verify_canonical_v2_resume
  run_poller audit-canonical --strict
  run_poller rebuild
else
  run_poller migrate-canonical --stage expand --apply \
    --backup-manifest "$CUTOVER_BACKUP_MANIFEST_FILE"
  verify_backup pre

  FIRST_PARSE_LOG="${CUTOVER_LOG_FILE}.parse-first"
  SECOND_PARSE_LOG="${CUTOVER_LOG_FILE}.parse-second"
  run_poller parse | tee "$FIRST_PARSE_LOG"
  grep -Fq 'parse: attempted=274 selected=274 unchanged=0 materialized=274 quarantined=0 partial=0 errors=0' "$FIRST_PARSE_LOG"
  run_poller parse | tee "$SECOND_PARSE_LOG"
  grep -Fq 'parse: attempted=274 selected=274 unchanged=274 materialized=0 quarantined=0 partial=0 errors=0' "$SECOND_PARSE_LOG"

  run_poller audit-canonical --strict --record-finalization-readiness \
    --backup-manifest "$CUTOVER_BACKUP_MANIFEST_FILE"
  run_poller migrate-canonical --stage finalize --apply \
    --backup-manifest "$CUTOVER_BACKUP_MANIFEST_FILE"
  run_poller audit-canonical --strict
  run_poller rebuild
fi

API_LIVE_LOG="${CUTOVER_LOG_FILE}.api-live"
printf 'live integration command: RUN_LIVE_CANONICAL=1 npm run test:integration -w packages/api\n'
set +e
docker run --rm \
  --network cs-patchnotes_internal \
  --mount "type=bind,src=$TARGET_DIRECTORY,dst=$TARGET_DIRECTORY,readonly" \
  -e "SQLITE_PATH=$SQLITE_PATH" \
  -e "MEILI_HOST=http://meili:7700" \
  -e MEILI_MASTER_KEY \
  -e "RUN_LIVE_CANONICAL=1" \
  cs-patchnotes-api-live-test:local \
  npm run test:integration -w packages/api 2>&1 | tee "$API_LIVE_LOG"
API_STATUS=${PIPESTATUS[0]}
set -e
if (( API_STATUS != 0 )); then
  printf 'ERROR: enabled live integration process failed\n' >&2
  exit "$API_STATUS"
fi
if grep -Eqi '(^|[^[:alpha:]])skip(ped)?([^[:alpha:]]|$)' "$API_LIVE_LOG"; then
  printf 'ERROR: enabled live integration output reported skipped assertions\n' >&2
  exit 1
fi
if ! grep -Fq 'LIVE_CANONICAL_ENV=1' "$API_LIVE_LOG" || \
   ! grep -Fq 'LIVE_CANONICAL_ASSERTIONS_PASSED' "$API_LIVE_LOG"; then
  printf 'ERROR: positive live assertion evidence is missing\n' >&2
  exit 1
fi

verify_backup post
node scripts/check-canonical-stale-references.mjs --strict
npm test
npm run build

CUTOVER_SUCCEEDED=1
