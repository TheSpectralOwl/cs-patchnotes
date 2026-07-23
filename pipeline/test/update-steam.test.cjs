const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { updateSteam } = require("../update-steam.cjs");

function steamItem(body = "[ GAMEPLAY ]\n- Updated smoke.\n") {
  return { gid: "1", title: "Counter-Strike 2 Update", url: "https://example.test/1", feed_type: 1, feedname: "steam_community_announcements", date: 1_704_067_200, contents: body, tags: ["patchnotes"] };
}

function fakeBuild(documents = 1) {
  return () => ({ documents, terms: 1, indexPath: "generated" });
}

test("adds new captures, converts them, and rebuilds derived indexes", async () => {
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-patchnotes-update-"));
  const fetchNews = async () => new Map([["1", steamItem()]]);
  const result = await updateSteam(contentDir, { fetchNews, buildSearchIndex: fakeBuild() });
  assert.equal(result.added, 1);
  assert.equal(result.conversion.created, 1);
  assert.ok(fs.existsSync(path.join(contentDir, "raw", "steam", "1.json")));
  assert.ok(fs.existsSync(path.join(contentDir, "content", "notes", "2024-01-01-counter-strike-2-update.md")));

  const repeat = await updateSteam(contentDir, { fetchNews, buildSearchIndex: fakeBuild() });
  assert.equal(repeat.existing, 1);
  assert.equal(repeat.added, 0);
  assert.equal(repeat.conversion.unchanged, 1);
});

test("detects changed payloads without changing the raw store", async () => {
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-patchnotes-update-conflict-"));
  const first = async () => new Map([["1", steamItem()]]);
  await updateSteam(contentDir, { fetchNews: first, buildSearchIndex: fakeBuild() });
  const conflicting = async () => new Map([["1", steamItem("[ GAMEPLAY ]\n- Changed source payload.\n")]]);
  const result = await updateSteam(contentDir, { fetchNews: conflicting, buildSearchIndex: fakeBuild() });
  assert.equal(result.conflicts.length, 1);
  assert.match(fs.readFileSync(path.join(contentDir, "raw", "steam", "1.json"), "utf8"), /Updated smoke/);
});

test("reports additions without writing during a dry run", async () => {
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-patchnotes-update-dry-run-"));
  const result = await updateSteam(contentDir, { fetchNews: async () => new Map([["1", steamItem()]]), dryRun: true });
  assert.equal(result.added, 1);
  assert.equal(fs.existsSync(path.join(contentDir, "raw")), false);
});
