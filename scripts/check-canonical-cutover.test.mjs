import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import test from "node:test";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const RUNNER = join(PROJECT_ROOT, "scripts/check-canonical-cutover.sh");

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function seedLegacyDatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(`
    CREATE TABLE updates (id TEXT PRIMARY KEY, raw_body TEXT NOT NULL, url TEXT);
    CREATE TABLE sections (id INTEGER PRIMARY KEY, update_id TEXT NOT NULL, label TEXT);
    CREATE TABLE lines (id INTEGER PRIMARY KEY, section_id INTEGER NOT NULL, text TEXT);
    CREATE TABLE line_tags (line_id INTEGER, tag TEXT);
  `);
  const insertUpdate = db.prepare("INSERT INTO updates VALUES (?, ?, ?)");
  const insertSection = db.prepare("INSERT INTO sections VALUES (?, ?, ?)");
  const insertLine = db.prepare("INSERT INTO lines VALUES (?, ?, ?)");
  db.transaction(() => {
    for (let index = 0; index < 274; index += 1) {
      insertUpdate.run(`gid-${index}`, `pristine body ${index}`, `https://example.invalid/${index}`);
    }
    for (let index = 0; index < 828; index += 1) {
      insertSection.run(index, `gid-${index % 274}`, `section ${index}`);
    }
    for (let index = 0; index < 4_173; index += 1) {
      insertLine.run(index, index % 828, `line ${index}`);
    }
  })();
  db.pragma("user_version = 0");
  db.close();
}

function writeExecutable(path, source) {
  writeFileSync(path, source, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function makeHarness(t, mode = "success") {
  const root = mkdtempSync(join(tmpdir(), "canonical runner harness "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "canonical cutover", "accepted archive.sqlite");
  const targetArtifact = join(root, "approved target.json");
  const manifest = join(root, "canonical evidence", "backup proof.json");
  const recordFile = join(root, "commands.jsonl");
  const stateFile = join(root, "shim-state.json");
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(dirname(manifest), { recursive: true });
  seedLegacyDatabase(target);
  writeFileSync(targetArtifact, `${JSON.stringify({ sqlite_path: target }, null, 2)}\n`);
  writeFileSync(stateFile, JSON.stringify({ parseCount: 0 }));

  writeExecutable(
    join(bin, "npm"),
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.HARNESS_RECORD_FILE, JSON.stringify({ tool: "npm", argv: process.argv.slice(2) }) + "\\n");
console.log("npm shim: pass");
`,
  );
  writeExecutable(
    join(bin, "docker"),
    `#!/usr/bin/env node
import { appendFileSync, copyFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import Database from ${JSON.stringify(pathToFileURL(join(PROJECT_ROOT, "node_modules/better-sqlite3/lib/index.js")).href)};

const argv = process.argv.slice(2);
const record = { tool: "docker", argv };
appendFileSync(process.env.HARNESS_RECORD_FILE, JSON.stringify(record) + "\\n");
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const envValues = new Map();
for (let index = 0; index < argv.length - 1; index += 1) {
  if (argv[index] === "-e") {
    const [key, ...rest] = argv[index + 1].split("=");
    envValues.set(key, rest.length === 0 ? process.env[key] : rest.join("="));
  }
}
const target = envValues.get("SQLITE_PATH");
const manifestIndex = argv.lastIndexOf("--backup-manifest");
const manifest = manifestIndex >= 0 ? argv[manifestIndex + 1] : undefined;
const has = (...values) => values.every((value) => argv.includes(value));

if (argv[0] === "compose" && has("config", "--format", "json")) {
  console.log(JSON.stringify({ services: { meili: { environment: { MEILI_MASTER_KEY: "harness-secret-key" } } } }));
  process.exit(0);
}
if (argv[0] === "compose" && (has("build") || has("up") || has("down"))) {
  console.log("compose shim: pass");
  process.exit(0);
}
if (argv[0] === "build") {
  console.log("docker build shim: pass");
  process.exit(0);
}
if (argv[0] === "compose" && has("run") && has("--entrypoint", "node")) {
  console.log("backup_verified schema=0 updates=274 sections=828 lines=4173 line_tags=0");
  process.exit(0);
}
if (argv[0] === "compose" && has("run") && argv.includes("poller")) {
  if (!target) throw new Error("poller stage missing exact SQLITE_PATH environment");
  if (has("migrate-canonical", "expand")) {
    if (!manifest) throw new Error("expansion missing manifest");
    const backup = manifest + ".sqlite-backup";
    copyFileSync(target, backup);
    const targetStat = statSync(target);
    const backupStat = statSync(backup);
    writeFileSync(manifest, JSON.stringify({
      contract_version: 1,
      manifest_id: "manifest-harness",
      expansion_id: "expansion-harness",
      created_at: new Date().toISOString(),
      target: { path: target, device: targetStat.dev, inode: targetStat.ino, size: targetStat.size, mtime_ms: targetStat.mtimeMs, user_version: 0, table_counts: { updates: 274, sections: 828, lines: 4173, line_tags: 0 }, legacy_source_digest: "harness-source-digest" },
      backup: { path: backup, device: backupStat.dev, inode: backupStat.ino, size: backupStat.size, mtime_ms: backupStat.mtimeMs, sha256: hash(backup) },
      open_verification: { ok: true, user_version: 0, quick_check: "ok" }
    }, null, 2) + "\\n");
    const db = new Database(target); db.pragma("user_version = 1"); db.close();
    console.log(JSON.stringify({ ok: true, stage: "expand", target_path: target, manifest_path: manifest }));
    process.exit(0);
  }
  if (argv.includes("parse")) {
    const state = JSON.parse(readFileSync(process.env.HARNESS_STATE_FILE, "utf8"));
    state.parseCount += 1;
    writeFileSync(process.env.HARNESS_STATE_FILE, JSON.stringify(state));
    console.log(state.parseCount === 1
      ? "parse: attempted=274 selected=274 unchanged=0 materialized=274 quarantined=0 partial=0 errors=0"
      : "parse: attempted=274 selected=274 unchanged=274 materialized=0 quarantined=0 partial=0 errors=0");
    process.exit(0);
  }
  if (has("audit-canonical", "--record-finalization-readiness")) {
    if (process.env.HARNESS_MODE === "fail-readiness") {
      console.error("readiness shim failure"); process.exit(9);
    }
    console.log(JSON.stringify({ ok: true, readiness: true, manifest_path: manifest }));
    process.exit(0);
  }
  if (has("migrate-canonical", "finalize")) {
    if (!manifest) throw new Error("finalization missing manifest");
    const db = new Database(target);
    db.exec("DROP TABLE line_tags; DROP TABLE lines; DROP TABLE sections; DROP TABLE updates;");
    db.pragma("user_version = 2");
    db.close();
    console.log(JSON.stringify({ ok: true, stage: "finalize", target_path: target, manifest_path: manifest }));
    process.exit(0);
  }
  if (has("audit-canonical", "--strict")) {
    console.log(JSON.stringify({ ok: true, schema_version: 2, documents: 274 }));
    process.exit(0);
  }
  if (argv.includes("rebuild")) {
    console.log("rebuild: dropped + repopulated canonical_fragments");
    process.exit(0);
  }
}
if (argv[0] === "run") {
  const imageIndex = argv.indexOf("cs-patchnotes-api-live-test:local");
  const command = imageIndex >= 0 ? argv.slice(imageIndex + 1) : [];
  if (envValues.get("RUN_LIVE_CANONICAL") !== "1") {
    console.error("live integration missing RUN_LIVE_CANONICAL=1"); process.exit(8);
  }
  if (JSON.stringify(command) !== JSON.stringify(["npm", "run", "test:integration", "-w", "packages/api"])) {
    console.error("unexpected live integration argv: " + JSON.stringify(command)); process.exit(8);
  }
  if (process.env.HARNESS_MODE === "skip-live") {
    console.log("LIVE_CANONICAL_ENV=1\\nTests 1 passed | 6 skipped"); process.exit(0);
  }
  if (process.env.HARNESS_MODE === "omit-live-proof") {
    console.log("Tests 7 passed"); process.exit(0);
  }
  console.log("LIVE_CANONICAL_ENV=1\\nLIVE_CANONICAL_ASSERTIONS_PASSED\\nTests 7 passed");
  process.exit(0);
}
console.error("unhandled docker shim invocation: " + JSON.stringify(argv));
process.exit(7);
`,
  );

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CUTOVER_TARGET_FILE: targetArtifact,
    CUTOVER_BACKUP_MANIFEST_FILE: manifest,
    HARNESS_RECORD_FILE: recordFile,
    HARNESS_STATE_FILE: stateFile,
    HARNESS_MODE: mode,
  };
  return { root, target, targetArtifact, manifest, recordFile, env };
}

function runHarness(harness, overrides = {}) {
  return spawnSync("bash", [RUNNER], {
    cwd: PROJECT_ROOT,
    env: { ...harness.env, ...overrides },
    encoding: "utf8",
    timeout: 120_000,
  });
}

function records(harness) {
  if (!existsSync(harness.recordFile)) return [];
  return readFileSync(harness.recordFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function pollerStage(record) {
  const args = record.argv;
  if (!args.includes("poller")) return undefined;
  if (args.includes("migrate-canonical") && args.includes("expand")) return "expand";
  if (args.includes("parse")) return "parse";
  if (args.includes("--record-finalization-readiness")) return "readiness";
  if (args.includes("migrate-canonical") && args.includes("finalize")) return "finalize";
  if (args.includes("audit-canonical")) return "post-audit";
  if (args.includes("rebuild")) return "rebuild";
  return undefined;
}

test("propagates arbitrary target and manifest paths through every ordered live stage", (t) => {
  const harness = makeHarness(t);
  const decoyManifest = join(dirname(harness.manifest), "newer decoy manifest.json");
  const decoyBackup = `${decoyManifest}.sqlite-backup`;
  writeFileSync(decoyManifest, "decoy");
  writeFileSync(decoyBackup, "decoy");
  const result = runHarness(harness);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const allRecords = records(harness);
  const serialized = JSON.stringify(allRecords);
  assert.doesNotMatch(serialized, /newer decoy manifest|decoy.*sqlite-backup/);
  const stages = allRecords.map(pollerStage).filter(Boolean);
  assert.deepEqual(stages, [
    "expand",
    "parse",
    "parse",
    "readiness",
    "finalize",
    "post-audit",
    "rebuild",
  ]);

  const databaseStages = allRecords.filter((record) => pollerStage(record));
  for (const record of databaseStages) {
    assert.ok(
      record.argv.some((value, index) =>
        record.argv[index - 1] === "-e" && value === `SQLITE_PATH=${harness.target}`,
      ),
      `missing exact target in ${JSON.stringify(record.argv)}`,
    );
  }
  for (const stage of ["expand", "readiness", "finalize"]) {
    const record = databaseStages.find((candidate) => pollerStage(candidate) === stage);
    const index = record.argv.indexOf("--backup-manifest");
    assert.equal(record.argv[index + 1], harness.manifest);
  }
  assert.equal(
    databaseStages.filter((record) => record.argv.includes("migrate-canonical")).every(
      (record) => !(record.argv.includes("expand") && record.argv.includes("finalize")),
    ),
    true,
  );

  const api = allRecords.find(
    (record) => record.tool === "docker" && record.argv[0] === "run",
  );
  assert.ok(api);
  assert.ok(api.argv.includes("RUN_LIVE_CANONICAL=1"));
  assert.deepEqual(api.argv.slice(api.argv.indexOf("cs-patchnotes-api-live-test:local") + 1), [
    "npm",
    "run",
    "test:integration",
    "-w",
    "packages/api",
  ]);

  const manifest = JSON.parse(readFileSync(harness.manifest, "utf8"));
  assert.equal(manifest.target.path, harness.target);
  assert.equal(manifest.backup.path, `${harness.manifest}.sqlite-backup`);
  assert.equal(manifest.backup.sha256, sha256(manifest.backup.path));
  const backupHash = sha256(manifest.backup.path);
  const backup = new Database(manifest.backup.path, { readonly: true, fileMustExist: true });
  assert.equal(backup.pragma("user_version", { simple: true }), 0);
  assert.deepEqual(
    ["updates", "sections", "lines", "line_tags"].map((table) =>
      backup.prepare(`SELECT count(*) FROM ${table}`).pluck().get(),
    ),
    [274, 828, 4_173, 0],
  );
  backup.close();
  assert.equal(sha256(manifest.backup.path), backupHash);
  const live = new Database(harness.target, { readonly: true, fileMustExist: true });
  assert.equal(live.pragma("user_version", { simple: true }), 2);
  assert.equal(
    live.prepare("SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('updates','sections','lines','line_tags')").pluck().get(),
    0,
  );
  live.close();
  const log = readFileSync(`${harness.manifest}.cutover.log`, "utf8");
  assert.match(log, /RUN_LIVE_CANONICAL=1 npm run test:integration -w packages\/api/);
  assert.match(log, /LIVE_CANONICAL_ENV=1/);
  assert.match(log, /LIVE_CANONICAL_ASSERTIONS_PASSED/);
  assert.doesNotMatch(log, /skipped/i);
});

test("rejects malformed target artifacts and relative manifests before any command", (t) => {
  const cases = [
    { name: "missing", json: {} },
    { name: "extra", json: { sqlite_path: "/tmp/x", other: true } },
    { name: "relative", json: { sqlite_path: "relative.sqlite" } },
  ];
  for (const item of cases) {
    const harness = makeHarness(t);
    writeFileSync(harness.targetArtifact, JSON.stringify(item.json));
    const result = runHarness(harness);
    assert.notEqual(result.status, 0, item.name);
    assert.deepEqual(records(harness), [], item.name);
  }
  const malformed = makeHarness(t);
  writeFileSync(malformed.targetArtifact, "{not-json");
  assert.notEqual(runHarness(malformed).status, 0);
  assert.deepEqual(records(malformed), []);

  const relativeManifest = makeHarness(t);
  const result = runHarness(relativeManifest, {
    CUTOVER_BACKUP_MANIFEST_FILE: "relative proof.json",
  });
  assert.notEqual(result.status, 0);
  assert.deepEqual(records(relativeManifest), []);
});

test("rejects skipped or unproven enabled integration output", (t) => {
  for (const mode of ["skip-live", "omit-live-proof"]) {
    const harness = makeHarness(t, mode);
    const result = runHarness(harness);
    assert.notEqual(result.status, 0, mode);
    const log = readFileSync(`${harness.manifest}.cutover.log`, "utf8");
    assert.match(log, mode === "skip-live" ? /skipped/i : /positive live assertion evidence/i);
  }
});

test("preserves the exact manifest backup and bounded log on a failed gate", (t) => {
  const harness = makeHarness(t, "fail-readiness");
  const result = runHarness(harness);
  assert.notEqual(result.status, 0);
  const manifest = JSON.parse(readFileSync(harness.manifest, "utf8"));
  assert.equal(manifest.backup.path, `${harness.manifest}.sqlite-backup`);
  assert.equal(manifest.backup.sha256, sha256(manifest.backup.path));
  const backup = new Database(manifest.backup.path, { readonly: true, fileMustExist: true });
  assert.equal(backup.pragma("user_version", { simple: true }), 0);
  assert.equal(backup.prepare("SELECT count(*) FROM lines").pluck().get(), 4_173);
  backup.close();
  const live = new Database(harness.target, { readonly: true, fileMustExist: true });
  assert.equal(live.pragma("user_version", { simple: true }), 1);
  live.close();
  const log = readFileSync(`${harness.manifest}.cutover.log`, "utf8");
  assert.match(log, /cutover failed/);
  assert.match(log, /restore command/);
  assert.match(log, new RegExp(harness.manifest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("runner source has no approved-database basename or sibling-discovery shortcuts", () => {
  const source = readFileSync(RUNNER, "utf8");
  assert.doesNotMatch(source, /patchnotes\.db/);
  assert.doesNotMatch(source, /\bbasename\b/);
  assert.doesNotMatch(source, /\b(?:find|ls)\b[^\n]*(?:manifest|backup)/i);
  assert.doesNotMatch(source, /mtime|newest/i);
  assert.match(source, /set -euo pipefail/);
});
