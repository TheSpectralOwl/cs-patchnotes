#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { assertNoSymlinks, assertRawRecord, corpusSnapshot } = require("./corpus.cjs");
const {
  noteManifest,
  noteRevisionDirectory,
  rawManifest,
  rawRevisionDirectory,
  resolveContainedPath,
  revisionFilename,
  sha256,
} = require("./revision-layout.cjs");

const DEFAULT_CONTENT_DIR = path.resolve(__dirname, "..", "..", "cs-patchnotes-content-v2");

function parseLegacyNote(bytes, filename) {
  const contents = bytes.toString("utf8");
  const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error(`Legacy note ${filename} is manual or lacks generated provenance`);

  const frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(": ");
    if (separator === -1) continue;
    const key = line.slice(0, separator);
    if (Object.hasOwn(frontmatter, key)) throw new Error(`Legacy note ${filename} has ambiguous provenance`);
    const value = line.slice(separator + 2);
    try {
      frontmatter[key] = JSON.parse(value);
    } catch {
      frontmatter[key] = value;
    }
  }
  return { body: match[2], frontmatter };
}

function legacyDirectory(directory, label) {
  if (!fs.existsSync(directory)) throw new Error(`Legacy ${label} directory is missing`);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Legacy ${label} is not a directory`);
  return fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
}

function assertNoteMatchesRaw(note, filename, raw) {
  if (sha256(note.body) !== note.frontmatter.generated_sha256) {
    throw new Error(`Legacy note ${filename} is manual or lacks generated provenance`);
  }
  for (const field of ["title", "date", "game", "content_kind", "body_format", "source_url"]) {
    if (note.frontmatter[field] !== raw.raw[field]) throw new Error(`Legacy note ${filename} has ambiguous source evidence`);
  }
  if (note.frontmatter.source_sha256 !== raw.raw.body_sha256) {
    throw new Error(`Legacy note ${filename} has ambiguous source evidence`);
  }
}

function readLegacyCorpus(contentDir) {
  assertNoSymlinks(contentDir);
  const rawDir = path.join(contentDir, "raw", "steam");
  const notesDir = path.join(contentDir, "content", "notes");
  const rawEntries = legacyDirectory(rawDir, "raw");
  const noteEntries = legacyDirectory(notesDir, "notes");

  if (rawEntries.some((entry) => !entry.isFile() || !entry.name.endsWith(".json"))) {
    throw new Error("Corpus is already revisioned or has an invalid raw layout");
  }
  if (noteEntries.some((entry) => !entry.isFile() || !entry.name.endsWith(".md"))) {
    throw new Error("Corpus is already revisioned or has an invalid note layout");
  }

  const rawsByGid = new Map();
  for (const entry of rawEntries) {
    const filename = path.join(rawDir, entry.name);
    const bytes = fs.readFileSync(filename);
    let raw;
    try {
      raw = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error(`Legacy raw ${entry.name} contains invalid JSON`);
    }
    assertRawRecord(raw, `Legacy raw ${entry.name}`);
    if (entry.name !== `${raw.gid}.json`) throw new Error(`Legacy raw ${entry.name} does not match its gid`);
    if (rawsByGid.has(raw.gid)) throw new Error(`Ambiguous legacy raw GID ${raw.gid}`);
    rawsByGid.set(raw.gid, { bytes, filename, raw, revision: sha256(bytes) });
  }

  const notesByGid = new Map();
  for (const entry of noteEntries) {
    const filename = path.join(notesDir, entry.name);
    const bytes = fs.readFileSync(filename);
    const note = parseLegacyNote(bytes, entry.name);
    const gid = note.frontmatter.steam_gid;
    const raw = rawsByGid.get(gid);
    if (!raw) {
      throw new Error(`Legacy note ${entry.name} is manual or lacks generated provenance`);
    }
    assertNoteMatchesRaw(note, entry.name, raw);
    if (notesByGid.has(gid)) throw new Error(`Ambiguous legacy notes for GID ${gid}`);
    notesByGid.set(gid, { bytes, filename, name: entry.name, gid, revision: raw.revision });
  }

  for (const gid of rawsByGid.keys()) {
    if (!notesByGid.has(gid)) throw new Error(`Legacy raw ${gid} has no Markdown presentation`);
  }

  const overrides = new Map();
  const overridesDir = path.join(contentDir, "overrides");
  if (fs.existsSync(overridesDir)) {
    const overrideEntries = legacyDirectory(overridesDir, "overrides");
    if (overrideEntries.some((entry) => !entry.isFile() || !/^[0-9]+\.md$/.test(entry.name))) {
      throw new Error("Legacy overrides has an invalid layout");
    }
    for (const entry of overrideEntries) {
      const gid = entry.name.slice(0, -3);
      const raw = rawsByGid.get(gid);
      if (!raw) throw new Error(`Legacy override ${entry.name} has no raw capture`);
      const note = parseLegacyNote(fs.readFileSync(path.join(overridesDir, entry.name)), entry.name);
      assertNoteMatchesRaw(note, entry.name, raw);
      overrides.set(gid, raw.revision);
    }
  }
  return { rawsByGid, notesByGid, overrides };
}

function writeJson(filename, value) {
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function migrateInPlace(contentDir) {
  const { rawsByGid, notesByGid, overrides } = readLegacyCorpus(contentDir);

  for (const [gid, source] of rawsByGid) {
    const note = notesByGid.get(gid);
    const rawDirectory = rawRevisionDirectory(contentDir, gid);
    const noteDirectory = noteRevisionDirectory(contentDir, gid);
    fs.mkdirSync(rawDirectory);
    fs.mkdirSync(noteDirectory);
    fs.writeFileSync(resolveContainedPath(rawDirectory, revisionFilename(source.revision, "json")), source.bytes);
    fs.writeFileSync(resolveContainedPath(noteDirectory, revisionFilename(source.revision, "md")), note.bytes);
    writeJson(resolveContainedPath(rawDirectory, "index.json"), rawManifest(gid, source.revision));
    const manifest = noteManifest(gid, note.name, source.revision);
    if (overrides.has(gid)) manifest.override_revision = overrides.get(gid);
    writeJson(resolveContainedPath(noteDirectory, "index.json"), manifest);
  }
  for (const source of rawsByGid.values()) fs.rmSync(source.filename);
  for (const note of notesByGid.values()) fs.rmSync(note.filename);
  return { raw_revisions: rawsByGid.size, notes: notesByGid.size };
}

function publishStagedCorpus(contentDir, stagedContentDir, sourceSnapshot) {
  if (corpusSnapshot(contentDir) !== sourceSnapshot) throw new Error("Source corpus changed while migration was staged");
  const backupDir = path.join(path.dirname(contentDir), `.${path.basename(contentDir)}.migration-backup-${process.pid}-${Date.now()}`);
  fs.renameSync(contentDir, backupDir);
  try {
    fs.renameSync(stagedContentDir, contentDir);
  } catch (error) {
    fs.renameSync(backupDir, contentDir);
    throw error;
  }
  fs.rmSync(backupDir, { recursive: true, force: true });
}

function migrateRevisionedCorpus(contentDir = process.env.CONTENT_DIR || DEFAULT_CONTENT_DIR, options = {}) {
  const plan = readLegacyCorpus(contentDir);
  const summary = { dry_run: !options.apply, raw_revisions: plan.rawsByGid.size, notes: plan.notesByGid.size, overrides: plan.overrides.size };
  if (!options.apply) return summary;

  const sourceSnapshot = corpusSnapshot(contentDir);
  const stagingParent = fs.mkdtempSync(path.join(path.dirname(contentDir), `.${path.basename(contentDir)}.migration-`));
  const stagedContentDir = path.join(stagingParent, path.basename(contentDir));
  try {
    fs.cpSync(contentDir, stagedContentDir, { recursive: true, dereference: false });
    migrateInPlace(stagedContentDir);
    publishStagedCorpus(contentDir, stagedContentDir, sourceSnapshot);
    return { ...summary, dry_run: false };
  } finally {
    fs.rmSync(stagingParent, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--apply")) throw new Error("Usage: node pipeline/migrate-revisioned-corpus.cjs [--apply]");
  console.log(JSON.stringify(migrateRevisionedCorpus(undefined, { apply: args.includes("--apply") }), null, 2));
}

module.exports = { migrateRevisionedCorpus, parseLegacyNote, readLegacyCorpus };
