const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { auditCorpus, blockingFindings } = require("../audit.cjs");
const { convertAll, generatedBody, renderNote } = require("../convert.cjs");
const { noteRevisionDirectory, rawRevisionDirectory } = require("../revision-layout.cjs");
const { addRawRevision, createCorpus, rawFor } = require("./revisioned-fixture.cjs");

function completeCorpus() {
  const contentDir = createCorpus();
  addRawRevision(contentDir, rawFor());
  convertAll(contentDir);
  return contentDir;
}

test("audits a revisioned corpus and retains duplicate raw bodies as informational evidence", () => {
  const contentDir = completeCorpus();
  addRawRevision(contentDir, rawFor("2"));
  convertAll(contentDir);
  const report = auditCorpus(contentDir);
  assert.deepEqual(blockingFindings(report), []);
  assert.deepEqual(report.duplicate_raw_bodies[0].gids, ["1", "2"]);
});

test("rejects mixed layouts, orphan revisions, invalid raw hashes, and duplicate public IDs", () => {
  const contentDir = completeCorpus();
  fs.writeFileSync(path.join(contentDir, "raw", "steam", "legacy.json"), "{}");
  assert.equal(blockingFindings(auditCorpus(contentDir))[0].class, "invalid_layout");

  fs.rmSync(path.join(contentDir, "raw", "steam", "legacy.json"));
  const rawDir = rawRevisionDirectory(contentDir, "1");
  fs.writeFileSync(path.join(rawDir, `${"a".repeat(64)}.json`), "{}");
  assert.equal(blockingFindings(auditCorpus(contentDir))[0].class, "invalid_layout");
  fs.rmSync(path.join(rawDir, `${"a".repeat(64)}.json`));

  const revision = JSON.parse(fs.readFileSync(path.join(rawDir, "index.json"), "utf8")).latest_revision;
  fs.writeFileSync(path.join(rawDir, `${revision}.json`), "{}");
  assert.equal(blockingFindings(auditCorpus(contentDir))[0].class, "invalid_raw_record");
  fs.rmSync(rawDir, { recursive: true });
  addRawRevision(contentDir, rawFor());

  addRawRevision(contentDir, rawFor("2"));
  convertAll(contentDir);
  const first = JSON.parse(fs.readFileSync(path.join(noteRevisionDirectory(contentDir, "1"), "index.json"), "utf8"));
  const secondPath = path.join(noteRevisionDirectory(contentDir, "2"), "index.json");
  const second = JSON.parse(fs.readFileSync(secondPath, "utf8"));
  second.note_id = first.note_id;
  second.legacy_filename = first.note_id;
  fs.writeFileSync(secondPath, `${JSON.stringify(second, null, 2)}\n`);
  assert.ok(blockingFindings(auditCorpus(contentDir)).some((finding) => finding.class === "duplicate_note_id"));
});

test("rejects symlinked revision trees without following them", (t) => {
  if (process.platform !== "linux") return t.skip("symlink regression requires Linux");
  const contentDir = completeCorpus();
  const rawDir = path.join(contentDir, "raw", "steam");
  const external = createCorpus("cs-patchnotes-external-");
  fs.rmSync(rawDir, { recursive: true });
  fs.symlinkSync(external, rawDir);
  assert.equal(blockingFindings(auditCorpus(contentDir))[0].class, "invalid_layout");
});

test("rejects override evidence without an evidenced source revision", () => {
  const contentDir = completeCorpus();
  const raw = rawFor();
  const noteDir = noteRevisionDirectory(contentDir, "1");
  const indexPath = path.join(noteDir, "index.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  index.override_revision = index.latest_revision;
  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  fs.mkdirSync(path.join(contentDir, "overrides"));
  fs.writeFileSync(path.join(contentDir, "overrides", "1.md"), renderNote(raw, generatedBody(raw)).replace(/source_sha256: .+/, 'source_sha256: "bad"'));
  assert.ok(blockingFindings(auditCorpus(contentDir)).some((finding) => finding.class === "invalid_override_evidence"));
});
