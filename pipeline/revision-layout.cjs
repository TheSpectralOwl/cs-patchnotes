const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { assertRawRecord } = require("./corpus.cjs");

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const STEAM_GID_PATTERN = /^[0-9]+$/;

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function isRevisionId(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function assertRevisionId(value, label = "Revision ID") {
  if (!isRevisionId(value)) throw new Error(`${label} must be a lowercase SHA-256 hex digest`);
  return value;
}

function assertSteamGid(value, label = "Steam GID") {
  if (typeof value !== "string" || !STEAM_GID_PATTERN.test(value)) {
    throw new Error(`${label} must contain only decimal digits`);
  }
  return value;
}

function resolveContainedPath(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path escapes its containing directory: ${relativePath}`);
  }
  return resolvedPath;
}

function revisionFilename(revision, extension) {
  if (!/^(json|md)$/.test(extension)) throw new Error(`Unsupported revision extension: ${extension}`);
  return `${assertRevisionId(revision)}.${extension}`;
}

function rawRevisionDirectory(contentDir, gid) {
  return resolveContainedPath(path.join(contentDir, "raw", "steam"), assertSteamGid(gid));
}

function noteRevisionDirectory(contentDir, gid) {
  return resolveContainedPath(path.join(contentDir, "content", "notes"), assertSteamGid(gid));
}

function rawManifest(gid, revision) {
  return { gid: assertSteamGid(gid), latest_revision: assertRevisionId(revision), revisions: [revision] };
}

function noteManifest(gid, noteId, revision) {
  if (typeof noteId !== "string" || !noteId.endsWith(".md") || path.basename(noteId) !== noteId) {
    throw new Error("Legacy public note ID must be a Markdown filename");
  }
  const checkedGid = assertSteamGid(gid);
  const checkedRevision = assertRevisionId(revision);
  return {
    gid: checkedGid,
    note_id: noteId,
    legacy_filename: noteId,
    latest_revision: checkedRevision,
    revisions: [checkedRevision],
    legacy_migration_revisions: [checkedRevision],
  };
}

function readJson(filename, label) {
  try {
    const value = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("must be an object");
    return value;
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function directoryEntries(directory, label, optional = false) {
  if (!fs.existsSync(directory)) {
    if (optional) return [];
    throw new Error(`${label} directory is missing`);
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} is not a directory`);
  return fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
}

function assertManifest(manifest, gid, kind) {
  if (manifest.gid !== gid) throw new Error(`${kind} manifest gid does not match its directory: ${gid}`);
  if (!Array.isArray(manifest.revisions) || manifest.revisions.length === 0) {
    throw new Error(`${kind} manifest for ${gid} has no revisions`);
  }
  if (new Set(manifest.revisions).size !== manifest.revisions.length || !manifest.revisions.every(isRevisionId)) {
    throw new Error(`${kind} manifest for ${gid} has invalid revisions`);
  }
  if (!isRevisionId(manifest.latest_revision) || !manifest.revisions.includes(manifest.latest_revision)) {
    throw new Error(`${kind} manifest for ${gid} has an invalid latest_revision`);
  }
}

function readRawLayouts(contentDir) {
  const root = path.join(contentDir, "raw", "steam");
  const layouts = new Map();
  for (const entry of directoryEntries(root, "Raw Steam", true)) {
    if (!entry.isDirectory() || !STEAM_GID_PATTERN.test(entry.name)) throw new Error(`Invalid raw Steam layout entry: ${entry.name}`);
    const gid = entry.name;
    const directory = rawRevisionDirectory(contentDir, gid);
    const entries = directoryEntries(directory, `Raw revision ${gid}`);
    if (entries.some((child) => !child.isFile() || (child.name !== "index.json" && !new RegExp(`^${SHA256_PATTERN.source.slice(1, -1)}\\.json$`).test(child.name)))) {
      throw new Error(`Invalid raw revision layout for ${gid}`);
    }
    const manifest = readJson(resolveContainedPath(directory, "index.json"), `Raw manifest for ${gid}`);
    assertManifest(manifest, gid, "Raw");
    const filenames = entries.filter((child) => child.name.endsWith(".json") && child.name !== "index.json").map((child) => child.name.slice(0, -5));
    if (filenames.length !== manifest.revisions.length || filenames.some((revision) => !manifest.revisions.includes(revision))) {
      throw new Error(`Raw manifest for ${gid} does not match its revision files`);
    }
    const revisions = new Map();
    for (const revision of manifest.revisions) {
      const filename = resolveContainedPath(directory, revisionFilename(revision, "json"));
      const bytes = fs.readFileSync(filename);
      if (sha256(bytes) !== revision) throw new Error(`Raw revision ${gid}/${revision} does not match its filename hash`);
      const raw = readJson(filename, `Raw revision ${gid}/${revision}`);
      assertRawRecord(raw, `Raw revision ${gid}/${revision}`);
      if (raw.gid !== gid) throw new Error(`Raw revision ${gid}/${revision} has a mismatched gid`);
      revisions.set(revision, { bytes, raw });
    }
    layouts.set(gid, { directory, manifest, revisions });
  }
  return layouts;
}

function assertPublicNoteId(value, label) {
  if (typeof value !== "string" || !value.endsWith(".md") || path.basename(value) !== value) {
    throw new Error(`${label} must be a Markdown filename`);
  }
}

function readNoteLayouts(contentDir, rawLayouts, options = {}) {
  const root = path.join(contentDir, "content", "notes");
  const layouts = new Map();
  for (const entry of directoryEntries(root, "Note", true)) {
    if (!entry.isDirectory() || !STEAM_GID_PATTERN.test(entry.name)) throw new Error(`Invalid note layout entry: ${entry.name}`);
    const gid = entry.name;
    const rawLayout = rawLayouts.get(gid);
    if (!rawLayout) throw new Error(`Note revisions for ${gid} have no raw source`);
    const directory = noteRevisionDirectory(contentDir, gid);
    const entries = directoryEntries(directory, `Note revision ${gid}`);
    if (entries.some((child) => !child.isFile() || (child.name !== "index.json" && !new RegExp(`^${SHA256_PATTERN.source.slice(1, -1)}\\.md$`).test(child.name)))) {
      throw new Error(`Invalid note revision layout for ${gid}`);
    }
    const manifest = readJson(resolveContainedPath(directory, "index.json"), `Note manifest for ${gid}`);
    assertManifest(manifest, gid, "Note");
    assertPublicNoteId(manifest.note_id, `Note manifest note_id for ${gid}`);
    if (manifest.legacy_filename !== manifest.note_id) throw new Error(`Note manifest legacy_filename does not match note_id for ${gid}`);
    if (!options.allowStaleLatest && manifest.latest_revision !== rawLayout.manifest.latest_revision) {
      throw new Error(`Note manifest latest_revision does not match raw source for ${gid}`);
    }
    if (manifest.revisions.some((revision) => !rawLayout.revisions.has(revision))) throw new Error(`Note manifest for ${gid} references an unknown raw revision`);
    const filenames = entries.filter((child) => child.name.endsWith(".md") && child.name !== "index.json").map((child) => child.name.slice(0, -3));
    if (filenames.length !== manifest.revisions.length || filenames.some((revision) => !manifest.revisions.includes(revision))) {
      throw new Error(`Note manifest for ${gid} does not match its revision files`);
    }
    if (manifest.legacy_migration_revisions !== undefined && (!Array.isArray(manifest.legacy_migration_revisions)
      || manifest.legacy_migration_revisions.some((revision) => !manifest.revisions.includes(revision)))) {
      throw new Error(`Note manifest for ${gid} has invalid legacy migration revisions`);
    }
    if (manifest.override_revision !== undefined && !rawLayout.revisions.has(manifest.override_revision)) {
      throw new Error(`Note manifest for ${gid} has an invalid override revision`);
    }
    layouts.set(gid, { directory, manifest });
  }
  if (!options.allowMissing && layouts.size !== rawLayouts.size) {
    for (const gid of rawLayouts.keys()) if (!layouts.has(gid)) throw new Error(`Raw revision ${gid} has no note manifest`);
  }
  return layouts;
}

module.exports = {
  assertRevisionId,
  assertSteamGid,
  assertPublicNoteId,
  directoryEntries,
  isRevisionId,
  noteManifest,
  noteRevisionDirectory,
  rawManifest,
  rawRevisionDirectory,
  readJson,
  readNoteLayouts,
  readRawLayouts,
  resolveContainedPath,
  revisionFilename,
  sha256,
};
