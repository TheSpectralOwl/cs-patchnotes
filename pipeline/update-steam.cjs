#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { auditCorpus, blockingFindings } = require("./audit.cjs");
const { assertNoSymlinks, assertSteamGid, corpusSnapshot } = require("./corpus.cjs");
const { convertAll } = require("./convert.cjs");
const { rawManifest, rawRevisionDirectory, readRawLayouts, resolveContainedPath, revisionFilename, sha256 } = require("./revision-layout.cjs");
const { fetchAllNews, isPatchNote, toRawRecord } = require("../tools/seed-raw-from-steam.cjs");

const DEFAULT_CONTENT_DIR = path.resolve(__dirname, "..", "..", "cs-patchnotes-content-v2");

function assertAuditClean(audit) {
  const findings = blockingFindings(audit);
  if (findings.length > 0) {
    const failures = findings.map((finding) => {
      const location = [finding.filename, finding.steam_gid && `gid ${finding.steam_gid}`]
        .filter(Boolean)
        .join("; ");
      const prefix = location ? `${finding.class} (${location})` : finding.class;
      return `${prefix}: ${finding.reason} Remediation: ${finding.remediation}`;
    });
    throw new Error(`Corpus audit failed: ${failures.join("; ")}`);
  }
}

function publishStagedCorpus(contentDir, stagedContentDir, sourceSnapshot) {
  if (corpusSnapshot(contentDir) !== sourceSnapshot) throw new Error("Source corpus changed while the Steam update was staged");
  // The snapshot detects edits before publication; it does not claim to close
  // hostile TOCTOU races that require descriptor-relative filesystem APIs.
  const backupDir = path.join(path.dirname(stagedContentDir), "backup");
  fs.renameSync(contentDir, backupDir);
  try { fs.renameSync(stagedContentDir, contentDir); } catch (error) {
    fs.renameSync(backupDir, contentDir);
    throw error;
  }
  fs.rmSync(backupDir, { recursive: true, force: true });
}

async function updateSteam(contentDir = process.env.CONTENT_DIR || DEFAULT_CONTENT_DIR, options = {}) {
  const fetchNews = options.fetchNews || fetchAllNews;
  const convert = options.convert || convertAll;
  const audit = options.audit || auditCorpus;
  const dryRun = options.dryRun || false;
  assertNoSymlinks(contentDir);
  const existingRaws = readRawLayouts(contentDir);
  const fetched = await fetchNews();
  const items = fetched instanceof Map ? [...fetched.values()] : fetched;
  const accepted = items.filter(isPatchNote);
  const seenGids = new Set();
  for (const item of accepted) {
    assertSteamGid(item.gid, "Steam feed GID");
    if (seenGids.has(item.gid)) throw new Error(`Steam feed contains duplicate GID: ${item.gid}`);
    seenGids.add(item.gid);
  }
  accepted.sort((left, right) => left.gid.localeCompare(right.gid));
  const planned = [];
  const summary = { fetched: items.length, accepted: accepted.length, existing: 0, added: 0, reselected: 0, conflicts: [], dry_run: dryRun };

  for (const item of accepted) {
    const contents = `${JSON.stringify(toRawRecord(item), null, 2)}\n`;
    const revision = sha256(contents);
    const current = existingRaws.get(item.gid);
    if (!current) planned.push({ gid: item.gid, contents, revision, kind: "new" });
    else if (current.revisions.has(revision)) {
      if (current.manifest.latest_revision === revision) summary.existing++;
      else planned.push({ gid: item.gid, revision, kind: "reselect" });
    } else planned.push({ gid: item.gid, contents, revision, kind: "append" });
  }

  summary.added = planned.filter((entry) => entry.kind === "new" || entry.kind === "append").length;
  summary.reselected = planned.filter((entry) => entry.kind === "reselect").length;
  if (dryRun) return summary;

  const sourceSnapshot = corpusSnapshot(contentDir);
  const stagingDir = fs.mkdtempSync(path.join(path.dirname(contentDir), `.${path.basename(contentDir)}.staging-`));
  const stagedContentDir = path.join(stagingDir, "content");
  try {
    fs.cpSync(contentDir, stagedContentDir, { recursive: true, dereference: false });
    assertNoSymlinks(stagedContentDir);
    fs.mkdirSync(path.join(stagedContentDir, "raw", "steam"), { recursive: true });
    for (const entry of planned) {
      const directory = rawRevisionDirectory(stagedContentDir, entry.gid);
      const current = existingRaws.get(entry.gid);
      if (entry.kind === "new") {
        fs.mkdirSync(directory);
        fs.writeFileSync(resolveContainedPath(directory, revisionFilename(entry.revision, "json")), entry.contents);
        fs.writeFileSync(resolveContainedPath(directory, "index.json"), `${JSON.stringify(rawManifest(entry.gid, entry.revision), null, 2)}\n`);
        continue;
      }
      const manifest = { ...current.manifest, revisions: [...current.manifest.revisions] };
      if (entry.kind === "append") {
        fs.writeFileSync(resolveContainedPath(directory, revisionFilename(entry.revision, "json")), entry.contents);
        manifest.revisions.push(entry.revision);
      }
      manifest.latest_revision = entry.revision;
      fs.writeFileSync(resolveContainedPath(directory, "index.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    }

    summary.conversion = convert(stagedContentDir);
    summary.audit = audit(stagedContentDir);
    assertAuditClean(summary.audit);
    publishStagedCorpus(contentDir, stagedContentDir, sourceSnapshot);
    return summary;
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some((argument) => argument !== "--dry-run")) {
    throw new Error("Usage: node pipeline/update-steam.cjs [--dry-run]");
  }
  updateSteam(undefined, { dryRun: args.includes("--dry-run") }).then((summary) => {
    console.log(JSON.stringify({
      fetched: summary.fetched,
      accepted: summary.accepted,
      existing: summary.existing,
      added: summary.added,
      reselected: summary.reselected,
      conflicts: summary.conflicts,
      dry_run: summary.dry_run,
      conversion: summary.conversion,
      audit: summary.audit && {
        documents: summary.audit.documents,
        informational_findings: {
          duplicate_raw_bodies: summary.audit.duplicate_raw_bodies.length,
          same_day_title_collisions: summary.audit.same_day_title_collisions.length,
        },
      },
    }, null, 2));
    if (summary.conflicts.length > 0) process.exitCode = 1;
  }).catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = { updateSteam };
