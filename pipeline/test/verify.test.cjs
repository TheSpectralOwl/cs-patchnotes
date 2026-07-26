const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { convertAll } = require("../convert.cjs");
const { noteRevisionDirectory } = require("../revision-layout.cjs");
const { verifyCorpus } = require("../verify.cjs");
const { addRawRevision, createCorpus, rawFor, snapshot } = require("./revisioned-fixture.cjs");

test("verification is read-only and does not require converter currency", () => {
  const contentDir = createCorpus();
  addRawRevision(contentDir, rawFor());
  convertAll(contentDir);
  const index = JSON.parse(fs.readFileSync(path.join(noteRevisionDirectory(contentDir, "1"), "index.json"), "utf8"));
  const note = path.join(noteRevisionDirectory(contentDir, "1"), `${index.latest_revision}.md`);
  fs.writeFileSync(note, fs.readFileSync(note, "utf8").replace("converter_version: 6", "converter_version: 1"));
  const before = snapshot(contentDir);
  assert.equal(verifyCorpus(contentDir).ok, true);
  assert.deepEqual(snapshot(contentDir), before);
});

test("verification reports invalid revisioned layouts without writing", () => {
  const contentDir = createCorpus();
  addRawRevision(contentDir, rawFor());
  convertAll(contentDir);
  fs.writeFileSync(path.join(contentDir, "content", "notes", "legacy.md"), "legacy");
  const before = snapshot(contentDir);
  assert.equal(verifyCorpus(contentDir).ok, false);
  assert.deepEqual(snapshot(contentDir), before);
});
