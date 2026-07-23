const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { buildReader } = require("../build-reader.cjs");

test("builds a self-contained static reader from Markdown notes", () => {
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-patchnotes-reader-content-"));
  const notesDir = path.join(contentDir, "content", "notes");
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(path.join(notesDir, "note.md"), "---\ntitle: \"Example\"\ndate: 2024-01-01\ngame: cs2\nsteam_gid: \"1\"\nsource_url: \"https://example.test/1\"\n---\n# Example\n\n## Gameplay\n\n- Updated smoke.\n");
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-patchnotes-reader-output-"));

  const result = buildReader(contentDir, outputDir);
  assert.equal(result.documents, 1);
  assert.ok(fs.existsSync(path.join(outputDir, "index.html")));
  assert.ok(fs.existsSync(path.join(outputDir, "app.js")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(outputDir, "notes-index.json"), "utf8")).documents.length, 1);
});
