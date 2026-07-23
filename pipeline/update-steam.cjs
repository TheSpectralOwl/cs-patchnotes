#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { auditCorpus } = require("./audit.cjs");
const { buildAppCorpus } = require("./build-app.cjs");
const { convertAll } = require("./convert.cjs");
const { buildIndex } = require("./search.cjs");
const { fetchAllNews, isPatchNote, toRawRecord } = require("../tools/seed-raw-from-steam.cjs");

const DEFAULT_CONTENT_DIR = path.resolve(__dirname, "..", "..", "cs-patchnotes-content");
const REQUIRED_EMPTY_FINDINGS = [
  "invalid_frontmatter",
  "invalid_provenance",
  "raw_without_note",
  "note_without_raw",
  "residual_bbcode",
  "list_headings",
  "regeneration_reviews",
];

function assertAuditClean(audit) {
  const failures = REQUIRED_EMPTY_FINDINGS.filter((finding) => audit[finding].length > 0);
  if (failures.length > 0) {
    throw new Error(`Corpus audit failed: ${failures.join(", ")}`);
  }
}

async function updateSteam(contentDir = process.env.CONTENT_DIR || DEFAULT_CONTENT_DIR, options = {}) {
  const fetchNews = options.fetchNews || fetchAllNews;
  const convert = options.convert || convertAll;
  const audit = options.audit || auditCorpus;
  const buildSearchIndex = options.buildSearchIndex || buildIndex;
  const buildAppIndex = options.buildAppIndex || buildAppCorpus;
  const dryRun = options.dryRun || false;
  const rawDir = path.join(contentDir, "raw", "steam");
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

  fs.mkdirSync(rawDir, { recursive: true });
  for (const entry of planned) fs.writeFileSync(entry.filename, entry.contents);
  summary.conversion = convert(contentDir);
  if (summary.conversion.conflicts.length > 0) {
    summary.conflicts = summary.conversion.conflicts.map((conflict) => conflict.note);
    return summary;
  }
  summary.audit = audit(contentDir);
  assertAuditClean(summary.audit);
  summary.search_index = buildSearchIndex(contentDir);
  summary.app_index = buildAppIndex(contentDir);
  return summary;
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
      search_index: summary.search_index,
      app_index: summary.app_index,
    }, null, 2));
    if (summary.conflicts.length > 0) process.exitCode = 1;
  }).catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = { updateSteam };
