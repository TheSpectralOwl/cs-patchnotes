#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { auditCorpus, blockingFindings } = require("./audit.cjs");
const { assertNoSymlinks } = require("./corpus.cjs");
const { convertAll } = require("./convert.cjs");
const { fetchAllNews, isPatchNote, toRawRecord } = require("../tools/seed-raw-from-steam.cjs");

const DEFAULT_CONTENT_DIR = path.resolve(__dirname, "..", "..", "cs-patchnotes-content");

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

async function updateSteam(contentDir = process.env.CONTENT_DIR || DEFAULT_CONTENT_DIR, options = {}) {
  const fetchNews = options.fetchNews || fetchAllNews;
  const convert = options.convert || convertAll;
  const audit = options.audit || auditCorpus;
  const dryRun = options.dryRun || false;
  const rawDir = path.join(contentDir, "raw", "steam");
  assertNoSymlinks(contentDir);
  const fetched = await fetchNews();
  const items = fetched instanceof Map ? [...fetched.values()] : fetched;
  const accepted = items.filter(isPatchNote).sort((left, right) => left.gid.localeCompare(right.gid));
  const planned = [];
  const summary = { fetched: items.length, accepted: accepted.length, existing: 0, added: 0, conflicts: [], dry_run: dryRun };

  for (const item of accepted) {
    const filename = path.join(rawDir, `${item.gid}.json`);
    const contents = `${JSON.stringify(toRawRecord(item), null, 2)}\n`;
    if (fs.existsSync(filename)) {
      if (fs.readFileSync(filename, "utf8") !== contents) summary.conflicts.push(filename);
      else summary.existing++;
    } else {
      planned.push({ filename, contents });
    }
  }

  if (summary.conflicts.length > 0) return summary;
  summary.added = planned.length;
  if (dryRun) return summary;

  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-patchnotes-update-"));
  const stagedContentDir = path.join(stagingDir, "content");
  try {
    fs.cpSync(contentDir, stagedContentDir, { recursive: true });
    const stagedRawDir = path.join(stagedContentDir, "raw", "steam");
    fs.mkdirSync(stagedRawDir, { recursive: true });
    for (const entry of planned) {
      fs.writeFileSync(path.join(stagedRawDir, path.basename(entry.filename)), entry.contents);
    }

    summary.conversion = convert(stagedContentDir);
    if (summary.conversion.conflicts.length > 0) {
      summary.conflicts = summary.conversion.conflicts.map((conflict) => path.join(
        contentDir,
        path.relative(stagedContentDir, conflict.note),
      ));
      return summary;
    }
    summary.audit = audit(stagedContentDir);
    assertAuditClean(summary.audit);
    assertNoSymlinks(contentDir);
    fs.cpSync(stagedContentDir, contentDir, { recursive: true, force: true });
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
