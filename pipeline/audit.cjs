#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { parseNote, sha256 } = require("./convert.cjs");
const { assertNoSymlinks } = require("./corpus.cjs");
const { readNoteLayouts, readRawLayouts } = require("./revision-layout.cjs");

const DEFAULT_CONTENT_DIR = path.resolve(__dirname, "..", "..", "cs-patchnotes-content-v2");
const DEFAULT_REPORT_PATH = path.resolve(__dirname, "..", ".cache", "corpus-audit.json");
const REQUIRED_FRONTMATTER = ["title", "date", "game", "content_kind", "body_format", "steam_gid", "source_url", "source_sha256", "generated_sha256"];

const FINDING_CATALOG = Object.freeze({
  invalid_layout: ["The corpus does not use one complete revisioned layout.", "Restore the manifest and revision files without mixing the retired flat layout."],
  invalid_raw_record: ["An immutable Steam capture is malformed or does not match its revision hash.", "Restore the exact raw evidence and its matching SHA-256 revision filename."],
  invalid_note_evidence: ["Markdown provenance does not match the raw revision it claims to present.", "Restore the immutable Markdown revision or its directly evidenced metadata."],
  missing_presentation: ["The selected raw revision has no effective Markdown presentation.", "Generate the missing revision or provide an override evidenced by that selected revision."],
  duplicate_note_id: ["More than one GID claims the same stable public Markdown ID.", "Restore the distinct note_id recorded for each GID."],
  invalid_override_evidence: ["An override is not complete evidence for a known raw revision.", "Restore a complete override and record its supporting revision in the note manifest."],
});

function createFinding(findingClass, details = {}) {
  const [reason, remediation] = FINDING_CATALOG[findingClass];
  return { class: findingClass, ...details, reason, remediation };
}

function sortFindings(findings) {
  return findings.sort((left, right) => left.class.localeCompare(right.class)
    || (left.filename || "").localeCompare(right.filename || "")
    || (left.steam_gid || "").localeCompare(right.steam_gid || ""));
}

function evidenceIssue(contents, raw, gid, revision, legacyRevisions = []) {
  const note = parseNote(contents);
  if (note.body === null || REQUIRED_FRONTMATTER.some((field) => typeof note.frontmatter[field] !== "string" || !note.frontmatter[field])) {
    return "missing required frontmatter";
  }
  if (note.frontmatter.steam_gid !== gid || note.frontmatter.source_sha256 !== raw.body_sha256 || note.frontmatter.generated_sha256 !== sha256(note.body)) {
    return "hash or gid provenance does not match";
  }
  for (const field of ["title", "date", "game", "content_kind", "body_format", "source_url"]) {
    if (note.frontmatter[field] !== raw[field]) return `${field} does not match raw evidence`;
  }
  if (note.frontmatter.source_revision !== revision && !(note.frontmatter.source_revision === undefined && legacyRevisions.includes(revision))) {
    return "source_revision does not match raw evidence";
  }
  return null;
}

function duplicateGroups(records, keyFor, map) {
  const groups = new Map();
  for (const record of records) {
    const key = keyFor(record);
    (groups.get(key) || groups.set(key, []).get(key)).push(record);
  }
  return [...groups.values()].filter((group) => group.length > 1).map(map).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function auditCorpus(contentDir = process.env.CONTENT_DIR || DEFAULT_CONTENT_DIR) {
  const findings = [];
  let raws;
  let notes;
  try {
    assertNoSymlinks(contentDir);
    raws = readRawLayouts(contentDir);
    notes = readNoteLayouts(contentDir, raws);
  } catch (error) {
    const rawFailure = /Raw revision .*?(?:hash|Raw record|body_sha256|invalid JSON)/.test(error.message);
    findings.push(createFinding(rawFailure ? "invalid_raw_record" : "invalid_layout", { detail: error.message }));
    return report(findings, [], 0);
  }

  const allRawRecords = [];
  let noteCount = 0;
  const noteIds = new Map();
  for (const [gid, rawLayout] of raws) {
    const noteLayout = notes.get(gid);
    const manifest = noteLayout.manifest;
    (noteIds.get(manifest.note_id) || noteIds.set(manifest.note_id, []).get(manifest.note_id)).push(gid);
    for (const [revision, source] of rawLayout.revisions) allRawRecords.push({ ...source.raw, revision });
    for (const revision of manifest.revisions) {
      noteCount++;
      const source = rawLayout.revisions.get(revision).raw;
      const filename = path.join("content", "notes", gid, `${revision}.md`);
      const issue = evidenceIssue(
        fs.readFileSync(path.join(noteLayout.directory, `${revision}.md`), "utf8"),
        source,
        gid,
        revision,
        manifest.legacy_migration_revisions || [],
      );
      if (issue) findings.push(createFinding("invalid_note_evidence", { filename, steam_gid: gid, detail: issue }));
    }
    const selected = rawLayout.manifest.latest_revision;
    if (!manifest.revisions.includes(selected) && manifest.override_revision === undefined) {
      findings.push(createFinding("missing_presentation", { steam_gid: gid }));
    }
  }
  for (const [noteId, gids] of noteIds) {
    if (gids.length > 1) for (const gid of gids) findings.push(createFinding("duplicate_note_id", { filename: noteId, steam_gid: gid }));
  }

  const overridesDir = path.join(contentDir, "overrides");
  const overrideGids = new Set();
  if (fs.existsSync(overridesDir)) {
    const entries = fs.readdirSync(overridesDir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const gid = entry.name.endsWith(".md") ? entry.name.slice(0, -3) : "";
      const filename = path.join("overrides", entry.name);
      const rawLayout = raws.get(gid);
      const noteLayout = notes.get(gid);
      overrideGids.add(gid);
      if (!entry.isFile() || !/^[0-9]+\.md$/.test(entry.name) || !rawLayout || !noteLayout || !noteLayout.manifest.override_revision) {
        findings.push(createFinding("invalid_override_evidence", { filename, steam_gid: gid || undefined, detail: "override is not mapped by a note manifest" }));
        continue;
      }
      const revision = noteLayout.manifest.override_revision;
      const issue = evidenceIssue(
        fs.readFileSync(path.join(overridesDir, entry.name), "utf8"),
        rawLayout.revisions.get(revision).raw,
        gid,
        revision,
        noteLayout.manifest.legacy_migration_revisions || [],
      );
      if (issue) findings.push(createFinding("invalid_override_evidence", { filename, steam_gid: gid, detail: issue }));
    }
  }
  for (const [gid, noteLayout] of notes) {
    if (noteLayout.manifest.override_revision !== undefined && !overrideGids.has(gid)) {
      findings.push(createFinding("invalid_override_evidence", { steam_gid: gid, detail: "manifest selects a missing override" }));
    }
  }
  return report(findings, allRawRecords, noteCount);
}

function report(findings, rawRecords, noteCount) {
  return {
    documents: { raw: rawRecords.length, notes: noteCount },
    findings: sortFindings(findings),
    duplicate_raw_bodies: duplicateGroups(rawRecords, (record) => record.body_sha256, (group) => ({ body_sha256: group[0].body_sha256, gids: group.map((record) => record.gid).sort() })),
    same_day_title_collisions: duplicateGroups(rawRecords, (record) => `${record.date}\0${record.title.toLowerCase()}`, (group) => ({ date: group[0].date, title: group[0].title, gids: group.map((record) => record.gid).sort() })),
  };
}

function blockingFindings(reportValue) {
  if (!reportValue || !Array.isArray(reportValue.findings)) throw new Error("Audit report is missing a valid findings array");
  for (const [index, finding] of reportValue.findings.entries()) {
    if (!finding || typeof finding.class !== "string" || !finding.class || typeof finding.reason !== "string" || !finding.reason || typeof finding.remediation !== "string" || !finding.remediation) {
      throw new Error(`Audit report contains an invalid finding record at index ${index}`);
    }
  }
  return reportValue.findings;
}

if (require.main === module) {
  const reportPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_REPORT_PATH;
  const result = auditCorpus();
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ report: reportPath, documents: result.documents, findings: result.findings.length }, null, 2));
}

module.exports = { auditCorpus, blockingFindings };
