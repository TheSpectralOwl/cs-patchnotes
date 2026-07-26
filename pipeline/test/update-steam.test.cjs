const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { generatedBody, renderNote } = require("../convert.cjs");
const { noteRevisionDirectory, rawRevisionDirectory, sha256 } = require("../revision-layout.cjs");
const { updateSteam } = require("../update-steam.cjs");
const { createCorpus, rawFor, snapshot } = require("./revisioned-fixture.cjs");

function item(body) {
  return { gid: "1", title: "Counter-Strike 2 Update", url: "https://example.test/1", feed_type: 1, feedname: "steam_community_announcements", date: 1_704_067_200, contents: body, tags: ["patchnotes"] };
}

test("appends changed source evidence and reselects an earlier A to B to A revision", async () => {
  const contentDir = createCorpus();
  const a = "[ GAMEPLAY ]\n- A.\n";
  const b = "[ GAMEPLAY ]\n- B.\n";
  await updateSteam(contentDir, { fetchNews: async () => [item(a)] });
  const first = JSON.parse(fs.readFileSync(path.join(rawRevisionDirectory(contentDir, "1"), "index.json"), "utf8"));
  const changed = await updateSteam(contentDir, { fetchNews: async () => [item(b)] });
  assert.equal(changed.added, 1);
  const second = JSON.parse(fs.readFileSync(path.join(rawRevisionDirectory(contentDir, "1"), "index.json"), "utf8"));
  assert.equal(second.revisions.length, 2);
  const reverted = await updateSteam(contentDir, { fetchNews: async () => [item(a)] });
  const final = JSON.parse(fs.readFileSync(path.join(rawRevisionDirectory(contentDir, "1"), "index.json"), "utf8"));
  assert.equal(reverted.reselected, 1);
  assert.equal(final.revisions.length, 2);
  assert.equal(final.latest_revision, first.latest_revision);
});

test("retains historical override evidence while generating a newly selected source revision", async () => {
  const contentDir = createCorpus();
  const a = "[ GAMEPLAY ]\n- A.\n";
  await updateSteam(contentDir, { fetchNews: async () => [item(a)] });
  const rawDir = rawRevisionDirectory(contentDir, "1");
  const revision = JSON.parse(fs.readFileSync(path.join(rawDir, "index.json"), "utf8")).latest_revision;
  const raw = JSON.parse(fs.readFileSync(path.join(rawDir, `${revision}.json`), "utf8"));
  const noteDir = noteRevisionDirectory(contentDir, "1");
  const noteIndex = JSON.parse(fs.readFileSync(path.join(noteDir, "index.json"), "utf8"));
  noteIndex.override_revision = revision;
  fs.writeFileSync(path.join(noteDir, "index.json"), `${JSON.stringify(noteIndex, null, 2)}\n`);
  fs.mkdirSync(path.join(contentDir, "overrides"));
  fs.writeFileSync(path.join(contentDir, "overrides", "1.md"), renderNote(raw, generatedBody(raw), revision));
  const result = await updateSteam(contentDir, { fetchNews: async () => [item("[ GAMEPLAY ]\n- B.\n")] });
  assert.equal(result.added, 1);
  const finalIndex = JSON.parse(fs.readFileSync(path.join(noteDir, "index.json"), "utf8"));
  assert.equal(finalIndex.override_revision, revision);
  assert.notEqual(finalIndex.latest_revision, revision);
  assert.equal(fs.existsSync(path.join(noteDir, `${finalIndex.latest_revision}.md`)), true);
});

test("keeps the source corpus unchanged when staging audit fails", async () => {
  const contentDir = createCorpus();
  const before = snapshot(contentDir);
  await assert.rejects(updateSteam(contentDir, { fetchNews: async () => [item("[ GAMEPLAY ]\n- A.\n")], audit: () => ({ findings: [{ class: "invalid_layout", reason: "bad", remediation: "fix" }] }) }));
  assert.deepEqual(snapshot(contentDir), before);
});
