const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { convertAll } = require("../convert.cjs");
const { verifyCorpus } = require("../verify.cjs");

function createCorpus() {
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-patchnotes-verify-content-"));
  const rawDir = path.join(contentDir, "raw", "steam");
  fs.mkdirSync(rawDir, { recursive: true });
  const body = "[ GAMEPLAY ]\n- Updated smoke.\n";
  const raw = { gid: "1", title: "Example", date: "2024-01-01", game: "cs2", content_kind: "patch_notes", body_format: "bbcode", source_url: "https://example.test/1", body_sha256: crypto.createHash("sha256").update(body).digest("hex"), body };
  fs.writeFileSync(path.join(rawDir, "1.json"), JSON.stringify(raw));
  convertAll(contentDir);
  return contentDir;
}

test("verifies a complete corpus without modifying it", () => {
  const contentDir = createCorpus();
  const result = verifyCorpus(contentDir);
  assert.equal(result.ok, true);
  assert.equal(result.conversion.unchanged, 1);
});

test("fails when committed Markdown is stale for the current converter", () => {
  const contentDir = createCorpus();
  const note = path.join(contentDir, "content", "notes", "2024-01-01-example.md");
  fs.writeFileSync(note, fs.readFileSync(note, "utf8").replace("converter_version: 6", "converter_version: 1"));
  const result = verifyCorpus(contentDir);
  assert.equal(result.ok, false);
  assert.match(result.failures[0], /not current/);
});
