const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { buildIndex, readIndex, searchIndex } = require("../search.cjs");

function note({ title, date, game, gid, body, sourceHash }) {
  return `---\ntitle: ${JSON.stringify(title)}\ndate: ${date}\ngame: ${game}\nsteam_gid: ${JSON.stringify(gid)}\nsource_url: ${JSON.stringify(`https://example.test/${gid}`)}\nsource_sha256: ${JSON.stringify(sourceHash)}\n---\n${body}`;
}

test("builds a disposable index from Markdown and applies query filters", () => {
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-patchnotes-search-"));
  const notesDir = path.join(contentDir, "content", "notes");
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(path.join(notesDir, "csgo.md"), note({ title: "CS:GO Update", date: "2021-01-01", game: "csgo", gid: "1", sourceHash: "csgo", body: "# CS:GO Update\n\nImproved smoke grenades.\n" }));
  fs.writeFileSync(path.join(notesDir, "cs2.md"), note({ title: "CS2 Update", date: "2024-01-01", game: "cs2", gid: "2", sourceHash: "cs2", body: "# CS2 Update\n\nImproved smoke grenades and maps.\n" }));
  const indexPath = path.join(contentDir, "index.json");

  assert.deepEqual(buildIndex(contentDir, indexPath).documents, 2);
  const results = searchIndex(readIndex(indexPath), "smoke", { game: "cs2", from: "2023-01-01" });
  assert.equal(results.length, 1);
  assert.equal(results[0].steam_gid, "2");
  assert.match(results[0].excerpt, /smoke grenades/i);
});

test("hides exact duplicate source bodies while retaining their documents in the index", () => {
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-patchnotes-duplicates-"));
  const notesDir = path.join(contentDir, "content", "notes");
  fs.mkdirSync(notesDir, { recursive: true });
  const body = "# Update\n\nImproved smoke grenades.\n";
  fs.writeFileSync(path.join(notesDir, "primary.md"), note({ title: "Update", date: "2024-01-01", game: "cs2", gid: "10", sourceHash: "same-body", body }));
  fs.writeFileSync(path.join(notesDir, "alias.md"), note({ title: "Update", date: "2024-01-01", game: "cs2", gid: "20", sourceHash: "same-body", body }));
  const indexPath = path.join(contentDir, "index.json");

  buildIndex(contentDir, indexPath);
  const index = readIndex(indexPath);
  assert.equal(index.documents.filter((document) => document.duplicate_of).length, 1);
  assert.equal(searchIndex(index, "smoke").length, 1);
});
