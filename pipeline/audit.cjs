#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { parseNote, sha256 } = require("./convert.cjs");

const DEFAULT_CONTENT_DIR = path.resolve(__dirname, "..", "..", "cs-patchnotes-content");
const DEFAULT_REPORT_PATH = path.resolve(__dirname, "..", ".cache", "corpus-audit.json");

function readRawRecords(contentDir) {
  const rawDir = path.join(contentDir, "raw", "steam");
  return fs
    .readdirSync(rawDir)
    .filter((filename) => filename.endsWith(".json"))
    .sort()
    .map((filename) => JSON.parse(fs.readFileSync(path.join(rawDir, filename), "utf8")));
}

function groupBy(items, keyFor) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFor(item);
    (groups.get(key) || groups.set(key, []).get(key)).push(item);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

function auditCorpus(contentDir = process.env.CONTENT_DIR || DEFAULT_CONTENT_DIR) {
  const rawRecords = readRawRecords(contentDir);
  const rawByGid = new Map(rawRecords.map((record) => [record.gid, record]));
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

  const invalidFrontmatter = [];
  const invalidProvenance = [];
  const residualBbcode = [];
  const listHeadings = [];
  const noteGids = new Set();
  for (const note of notes) {
    const gid = note.frontmatter.steam_gid;
    const raw = rawByGid.get(gid);
    if (!note.body || !gid || !note.frontmatter.source_sha256 || !note.frontmatter.generated_sha256) {
      invalidFrontmatter.push(note.filename);
      continue;
    }
    noteGids.add(gid);
    if (
      !raw ||
      raw.body_sha256 !== sha256(raw.body) ||
      note.frontmatter.source_sha256 !== raw.body_sha256 ||
      note.frontmatter.generated_sha256 !== sha256(note.body)
    ) {
      invalidProvenance.push(note.filename);
    }
    if (/\[(?:\/?(?:list|url|img|h[1-6])(?:[=\]\s])|\/?p(?:[=\]\s])|\/?\*\])/i.test(note.body)) {
      residualBbcode.push(note.filename);
    }
    if (/^## List$/m.test(note.body)) {
      listHeadings.push(note.filename);
    }
  }

  const duplicates = groupBy(rawRecords, (record) => record.body_sha256).map((group) => ({
    body_sha256: group[0].body_sha256,
    gids: group.map((record) => record.gid).sort(),
  }));
  const sameDayTitle = groupBy(rawRecords, (record) => `${record.date}\u0000${record.title.toLowerCase()}`).map(
    (group) => ({
      date: group[0].date,
      title: group[0].title,
      gids: group.map((record) => record.gid).sort(),
    }),
  );
  const proposedFiles = fs.existsSync(notesDir)
    ? fs.readdirSync(notesDir).filter((filename) => filename.endsWith(".md.new")).sort()
    : [];

  return {
    documents: { raw: rawRecords.length, notes: notes.length },
    invalid_frontmatter: invalidFrontmatter,
    invalid_provenance: invalidProvenance,
    raw_without_note: rawRecords.filter((record) => !noteGids.has(record.gid)).map((record) => record.gid),
    note_without_raw: notes
      .filter((note) => note.frontmatter.steam_gid && !rawByGid.has(note.frontmatter.steam_gid))
      .map((note) => note.filename),
    residual_bbcode: residualBbcode,
    list_headings: listHeadings,
    duplicate_raw_bodies: duplicates,
    same_day_title_collisions: sameDayTitle,
    regeneration_reviews: proposedFiles,
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

module.exports = { auditCorpus };
