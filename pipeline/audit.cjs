#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { parseNote, sha256 } = require("./convert.cjs");

const DEFAULT_CONTENT_DIR = path.resolve(__dirname, "..", "..", "cs-patchnotes-content");
const DEFAULT_REPORT_PATH = path.resolve(__dirname, "..", ".cache", "corpus-audit.json");
const REQUIRED_FRONTMATTER = [
  "title",
  "date",
  "game",
  "steam_gid",
  "source_url",
  "source_sha256",
  "generated_sha256",
];

const FINDING_CATALOG = Object.freeze({
  invalid_frontmatter: {
    reason: "The note does not satisfy the archive loader's required frontmatter contract.",
    remediation: "Regenerate the note or restore every required frontmatter field.",
  },
  invalid_provenance: {
    reason: "The note's source or generated SHA-256 does not match its immutable raw capture or body.",
    remediation: "Regenerate from the immutable capture or correct a directly evidenced override.",
  },
  raw_without_note: {
    reason: "An immutable Steam capture has no Markdown note mapped to its Steam GID.",
    remediation: "Generate the missing Markdown note from the capture.",
  },
  note_without_raw: {
    reason: "The Markdown note references a Steam GID with no immutable raw capture.",
    remediation: "Restore the matching raw capture or remove the unmapped note.",
  },
  duplicate_note_gid: {
    reason: "More than one Markdown note maps to the same Steam GID.",
    remediation: "Keep one note for the Steam GID and correct the duplicate mapping.",
  },
  residual_bbcode: {
    reason: "The Markdown body contains known residual BBCode conversion markup.",
    remediation: "Add a deterministic converter correction or a directly evidenced complete override.",
  },
  list_headings: {
    reason: "The Markdown body contains the known converter-produced List heading artifact.",
    remediation: "Add a deterministic converter correction or a directly evidenced complete override.",
  },
  regeneration_reviews: {
    reason: "A proposed regenerated note is awaiting review.",
    remediation: "Review the proposal and resolve it through the converter or a complete per-GID override.",
  },
  invalid_raw_record: {
    reason: "An immutable Steam capture is malformed and cannot be audited safely.",
    remediation: "Restore the capture from source evidence with valid GID, title, date, and body fields.",
  },
  duplicate_raw_gid: {
    reason: "More than one immutable Steam capture claims the same Steam GID.",
    remediation: "Restore the captures so each Steam GID has exactly one immutable raw record.",
  },
});

function readRawRecords(contentDir) {
  const rawDir = path.join(contentDir, "raw", "steam");
  const findings = [];
  const records = [];
  for (const filename of fs
    .readdirSync(rawDir)
    .filter((filename) => filename.endsWith(".json"))
    .sort()) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(rawDir, filename), "utf8"));
      const detail = !isNonEmptyString(record.gid) || !/^[0-9]+$/.test(record.gid)
        ? "missing or invalid gid"
        : typeof record.body !== "string"
          ? "missing or non-string body"
          : typeof record.title !== "string"
            ? "missing or non-string title"
              : typeof record.date !== "string"
                ? "missing or non-string date"
                : !/^[a-f0-9]{64}$/i.test(record.body_sha256)
                  ? "missing or invalid body_sha256"
                  : null;
      if (detail) findings.push(createFinding("invalid_raw_record", { filename, detail }));
      else records.push({ ...record, filename });
    } catch {
      findings.push(createFinding("invalid_raw_record", { filename, detail: "invalid JSON" }));
    }
  }
  return { findings, records };
}

function groupBy(items, keyFor) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFor(item);
    (groups.get(key) || groups.set(key, []).get(key)).push(item);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function hasRequiredFrontmatter(note) {
  return note.body !== null && REQUIRED_FRONTMATTER.every((field) => isNonEmptyString(note.frontmatter[field]));
}

function createFinding(findingClass, details = {}) {
  const definition = FINDING_CATALOG[findingClass];
  if (!definition) throw new Error(`Unknown audit finding class: ${findingClass}`);
  return {
    class: findingClass,
    ...details,
    reason: definition.reason,
    remediation: definition.remediation,
  };
}

function sortFindings(findings) {
  return findings.sort((left, right) =>
    left.class.localeCompare(right.class)
      || (left.filename || "").localeCompare(right.filename || "")
      || (left.steam_gid || "").localeCompare(right.steam_gid || ""),
  );
}

function informationalDuplicateGroups(rawRecords) {
  return groupBy(rawRecords, (record) => record.body_sha256)
    .map((group) => ({
      body_sha256: group[0].body_sha256,
      gids: group.map((record) => record.gid).sort(),
    }))
    .sort((left, right) => left.body_sha256.localeCompare(right.body_sha256));
}

function informationalTitleCollisions(rawRecords) {
  return groupBy(rawRecords, (record) => `${record.date}\u0000${record.title.toLowerCase()}`)
    .map((group) => ({
      date: group[0].date,
      title: group[0].title,
      gids: group.map((record) => record.gid).sort(),
    }))
    .sort((left, right) => left.date.localeCompare(right.date) || left.title.localeCompare(right.title));
}

function blockingFindings(report) {
  if (!report || !Array.isArray(report.findings)) {
    throw new Error("Audit report is missing a valid findings array");
  }
  for (const [index, finding] of report.findings.entries()) {
    if (
      !finding
      || !isNonEmptyString(finding.class)
      || !isNonEmptyString(finding.reason)
      || !isNonEmptyString(finding.remediation)
      || (finding.filename !== undefined && typeof finding.filename !== "string")
      || (finding.steam_gid !== undefined && typeof finding.steam_gid !== "string")
    ) {
      throw new Error(`Audit report contains an invalid finding record at index ${index}`);
    }
  }
  return report.findings;
}

function auditCorpus(contentDir = process.env.CONTENT_DIR || DEFAULT_CONTENT_DIR) {
  const { findings, records: rawRecords } = readRawRecords(contentDir);
  const rawGroupsByGid = new Map();
  for (const raw of rawRecords) (rawGroupsByGid.get(raw.gid) || rawGroupsByGid.set(raw.gid, []).get(raw.gid)).push(raw);
  for (const [gid, records] of rawGroupsByGid) {
    if (records.length > 1) {
      for (const record of records) findings.push(createFinding("duplicate_raw_gid", { filename: record.filename, steam_gid: gid }));
    }
  }
  const rawByGid = new Map([...rawGroupsByGid].map(([gid, records]) => [gid, records[0]]));
  const notesDir = path.join(contentDir, "content", "notes");
  const notes = fs
    .readdirSync(notesDir)
    .filter((filename) => filename.endsWith(".md"))
    .sort()
    .map((filename) => {
      const contents = fs.readFileSync(path.join(notesDir, filename), "utf8");
      const parsed = parseNote(contents);
      return { filename, ...parsed };
    });

  const noteGids = new Set();
  const noteGidCounts = new Map();
  for (const note of notes) {
    const gid = note.frontmatter.steam_gid;
    if (isNonEmptyString(gid)) noteGids.add(gid);
    if (!hasRequiredFrontmatter(note)) {
      findings.push(createFinding("invalid_frontmatter", { filename: note.filename, steam_gid: gid }));
      continue;
    }

    noteGidCounts.set(gid, (noteGidCounts.get(gid) || 0) + 1);
    const raw = rawByGid.get(gid);
    if (!raw) {
      findings.push(createFinding("note_without_raw", { filename: note.filename, steam_gid: gid }));
      continue;
    }
    if (
      raw.body_sha256 !== sha256(raw.body) ||
      note.frontmatter.source_sha256 !== raw.body_sha256 ||
      note.frontmatter.generated_sha256 !== sha256(note.body)
    ) {
      findings.push(createFinding("invalid_provenance", { filename: note.filename, steam_gid: gid }));
    }
    if (/\[(?:\/?(?:list|url|img|h[1-6])(?:[=\]\s])|\/?p(?:[=\]\s])|\/?\*\])/i.test(note.body)) {
      findings.push(createFinding("residual_bbcode", { filename: note.filename, steam_gid: gid }));
    }
    if (/^## List$/m.test(note.body)) {
      findings.push(createFinding("list_headings", { filename: note.filename, steam_gid: gid }));
    }
  }

  for (const raw of rawRecords) {
    if (!noteGids.has(raw.gid)) findings.push(createFinding("raw_without_note", { steam_gid: raw.gid }));
  }
  for (const note of notes) {
    const gid = note.frontmatter.steam_gid;
    if (hasRequiredFrontmatter(note) && noteGidCounts.get(gid) > 1) {
      const matchingNotes = notes.filter((candidate) => candidate.frontmatter.steam_gid === gid);
      if (matchingNotes[0].filename !== note.filename) {
        findings.push(createFinding("duplicate_note_gid", { filename: note.filename, steam_gid: gid }));
      }
    }
  }

  const proposedFiles = fs.existsSync(notesDir)
    ? fs.readdirSync(notesDir).filter((filename) => filename.endsWith(".md.new")).sort()
    : [];
  for (const proposedFile of proposedFiles) {
    const proposal = parseNote(fs.readFileSync(path.join(notesDir, proposedFile), "utf8"));
    findings.push(createFinding("regeneration_reviews", {
      filename: proposedFile.slice(0, -4),
      steam_gid: proposal.frontmatter.steam_gid,
    }));
  }

  const sortedFindings = sortFindings(findings);
  const legacyFindings = (findingClass, field) => sortedFindings
    .filter((finding) => finding.class === findingClass)
    .map((finding) => finding[field]);

  return {
    documents: { raw: rawRecords.length, notes: notes.length },
    findings: sortedFindings,
    invalid_frontmatter: legacyFindings("invalid_frontmatter", "filename"),
    invalid_raw_record: legacyFindings("invalid_raw_record", "filename"),
    invalid_provenance: legacyFindings("invalid_provenance", "filename"),
    raw_without_note: legacyFindings("raw_without_note", "steam_gid"),
    note_without_raw: legacyFindings("note_without_raw", "filename"),
    duplicate_note_gid: legacyFindings("duplicate_note_gid", "filename"),
    duplicate_raw_gid: legacyFindings("duplicate_raw_gid", "filename"),
    residual_bbcode: legacyFindings("residual_bbcode", "filename"),
    list_headings: legacyFindings("list_headings", "filename"),
    duplicate_raw_bodies: informationalDuplicateGroups(rawRecords),
    same_day_title_collisions: informationalTitleCollisions(rawRecords),
    regeneration_reviews: legacyFindings("regeneration_reviews", "filename"),
  };
}

function main() {
  const reportPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_REPORT_PATH;
  const report = auditCorpus();
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ report: reportPath, documents: report.documents, findings: Object.fromEntries(
    Object.entries(report).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length]),
  ) }, null, 2));
}

if (require.main === module) main();

module.exports = { auditCorpus, blockingFindings };
