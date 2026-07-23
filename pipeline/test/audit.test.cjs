const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { renderNote, sha256 } = require("../convert.cjs");
const { auditCorpus } = require("../audit.cjs");

test("reports broken provenance and residual BBCode without changing the corpus", () => {
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-patchnotes-audit-"));
  const rawDir = path.join(contentDir, "raw", "steam");
  const notesDir = path.join(contentDir, "content", "notes");
  fs.mkdirSync(rawDir, { recursive: true });
  fs.mkdirSync(notesDir, { recursive: true });
  const raw = {
    gid: "1", title: "Example", date: "2024-01-01", game: "cs2", content_kind: "patch_notes",
    body_format: "bbcode", source_url: "https://example.test/1", body: "[list][*]Example[/list]",
  };
  raw.body_sha256 = sha256(raw.body);
  fs.writeFileSync(path.join(rawDir, "1.json"), JSON.stringify(raw));
  fs.writeFileSync(path.join(notesDir, "good.md"), renderNote(raw, "# Example\n\n- Example\n"));
  fs.writeFileSync(path.join(notesDir, "bad.md"), "---\nsteam_gid: \"missing\"\n---\n[broken]\n");

  const report = auditCorpus(contentDir);
  assert.deepEqual(report.documents, { raw: 1, notes: 2 });
  assert.deepEqual(report.invalid_frontmatter, ["bad.md"]);
  assert.deepEqual(report.raw_without_note, []);
});
