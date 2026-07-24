const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const STEAM_GID_PATTERN = /^[0-9]+$/;
function isSteamGid(value) { return typeof value === "string" && STEAM_GID_PATTERN.test(value); }
function assertSteamGid(value, label = "Steam GID") {
  if (!isSteamGid(value)) throw new Error(`${label} must contain only decimal digits`);
  return value;
}

function isCanonicalDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function rawRecordIssue(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "record is not an object";
  if (!isSteamGid(raw.gid)) return "missing or invalid gid";
  if (typeof raw.body !== "string") return "missing or non-string body";
  for (const field of ["title", "game", "content_kind", "body_format", "source_url"]) {
    if (typeof raw[field] !== "string") return `missing or non-string ${field}`;
    if (raw[field].length === 0) return `missing or invalid ${field}`;
  }
  if (!isCanonicalDate(raw.date)) return "missing or invalid date";
  if (!/^[a-f0-9]{64}$/.test(raw.body_sha256)) return "missing or invalid body_sha256";
  if (sha256(raw.body) !== raw.body_sha256) return "body_sha256 does not match body";
  return null;
}

function assertRawRecord(raw, label = "Raw record") {
  const issue = rawRecordIssue(raw);
  if (issue) throw new Error(`${label}: ${issue}`);
  return raw;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function resolveContainedPath(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Path escapes its containing directory: ${relativePath}`);
  return resolvedPath;
}

function assertNoSymlinks(root) {
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink()) throw new Error(`Candidate corpus contains a symlink: ${root}`);
  if (!rootStat.isDirectory()) throw new Error(`Candidate corpus is not a directory: ${root}`);

  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const filename = path.join(root, entry.name);
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink()) throw new Error(`Candidate corpus contains a symlink: ${filename}`);
    if (stat.isDirectory()) assertNoSymlinks(filename);
  }
}

function corpusSnapshot(root) {
  assertNoSymlinks(root);
  const hash = crypto.createHash("sha256");
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const filename = path.join(directory, entry.name);
      const stat = fs.lstatSync(filename);
      if (stat.isSymbolicLink()) throw new Error(`Candidate corpus contains a symlink: ${filename}`);
      hash.update(`${entry.isDirectory() ? "directory" : "file"}\0${path.relative(root, filename)}\0`);
      if (stat.isDirectory()) visit(filename);
      else if (stat.isFile()) hash.update(fs.readFileSync(filename));
      else throw new Error(`Candidate corpus contains an unsupported filesystem entry: ${filename}`);
    }
  }
  visit(root);
  return hash.digest("hex");
}

module.exports = {
  assertNoSymlinks,
  assertRawRecord,
  assertSteamGid,
  corpusSnapshot,
  isCanonicalDate,
  isSteamGid,
  rawRecordIssue,
  resolveContainedPath,
};
