const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { convertAll, generatedBody, renderNote } = require("../convert.cjs");
const { noteManifest, noteRevisionDirectory, revisionFilename } = require("../revision-layout.cjs");
const { addRawRevision, createCorpus, rawFor } = require("./revisioned-fixture.cjs");

test("creates one immutable Markdown revision for the selected raw revision", () => {
  const contentDir = createCorpus();
  const raw = rawFor();
  const revision = addRawRevision(contentDir, raw);
  assert.deepEqual(convertAll(contentDir), { created: 1, unchanged: 0, manifests_updated: 1 });
  const noteDir = noteRevisionDirectory(contentDir, raw.gid);
  const note = path.join(noteDir, revisionFilename(revision, "md"));
  assert.match(fs.readFileSync(note, "utf8"), new RegExp(`source_revision: "${revision}"`));
  assert.equal(JSON.parse(fs.readFileSync(path.join(noteDir, "index.json"), "utf8")).note_id, "2024-01-01-counter-strike-2-update.md");
  assert.deepEqual(convertAll(contentDir), { created: 0, unchanged: 1, manifests_updated: 0 });
});

test("never rewrites an existing Markdown revision", () => {
  const contentDir = createCorpus();
  const first = rawFor();
  const firstRevision = addRawRevision(contentDir, first);
  convertAll(contentDir);
  const note = path.join(noteRevisionDirectory(contentDir, "1"), revisionFilename(firstRevision, "md"));
  const preserved = "manually preserved historical bytes\n";
  fs.writeFileSync(note, preserved);
  const secondRevision = addRawRevision(contentDir, rawFor("1", "[ GAMEPLAY ]\n- New source.\n"));
  const result = convertAll(contentDir);
  assert.equal(result.created, 1);
  assert.equal(fs.readFileSync(note, "utf8"), preserved);
  assert.ok(fs.existsSync(path.join(noteRevisionDirectory(contentDir, "1"), revisionFilename(secondRevision, "md"))));
});

test("preserves migrated Markdown without a source_revision marker", () => {
  const contentDir = createCorpus();
  const raw = rawFor();
  const revision = addRawRevision(contentDir, raw);
  const noteDir = noteRevisionDirectory(contentDir, raw.gid);
  fs.mkdirSync(noteDir, { recursive: true });
  const migrated = renderNote(raw, generatedBody(raw));
  fs.writeFileSync(path.join(noteDir, revisionFilename(revision, "md")), migrated);
  fs.writeFileSync(path.join(noteDir, "index.json"), `${JSON.stringify(noteManifest(raw.gid, "stable.md", revision), null, 2)}\n`);
  assert.equal(convertAll(contentDir).created, 0);
  assert.equal(fs.readFileSync(path.join(noteDir, revisionFilename(revision, "md")), "utf8"), migrated);
});
