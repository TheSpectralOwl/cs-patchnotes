const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { sha256 } = require("../revision-layout.cjs");
const { rawManifest, rawRevisionDirectory, revisionFilename } = require("../revision-layout.cjs");

function rawFor(gid = "1", body = "[ GAMEPLAY ]\n- Updated smoke.\n") {
  return {
    gid,
    title: "Counter-Strike 2 Update",
    date: "2024-01-01",
    game: "cs2",
    content_kind: "patch_notes",
    body_format: "bbcode",
    source_url: `https://example.test/${gid}`,
    body,
    body_sha256: sha256(body),
  };
}

function createCorpus(prefix = "cs-patchnotes-revisioned-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function addRawRevision(contentDir, raw, select = true) {
  const directory = rawRevisionDirectory(contentDir, raw.gid);
  const bytes = `${JSON.stringify(raw, null, 2)}\n`;
  const revision = sha256(bytes);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, revisionFilename(revision, "json")), bytes);
    fs.writeFileSync(path.join(directory, "index.json"), `${JSON.stringify(rawManifest(raw.gid, revision), null, 2)}\n`);
    return revision;
  }
  const indexPath = path.join(directory, "index.json");
  const manifest = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  if (!manifest.revisions.includes(revision)) {
    fs.writeFileSync(path.join(directory, revisionFilename(revision, "json")), bytes);
    manifest.revisions.push(revision);
  }
  if (select) manifest.latest_revision = revision;
  fs.writeFileSync(indexPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return revision;
}

function snapshot(root) {
  const entries = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else entries.push([path.relative(root, filename), sha256(fs.readFileSync(filename))]);
    }
  }
  visit(root);
  return entries;
}

module.exports = { addRawRevision, createCorpus, rawFor, snapshot };
