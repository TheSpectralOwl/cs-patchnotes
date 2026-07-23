const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { buildAppCorpus } = require("../build-app.cjs");

test("builds the application corpus only from Markdown notes", () => {
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-patchnotes-app-content-"));
  const notesDir = path.join(contentDir, "content", "notes");
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(path.join(notesDir, "note.md"), "---\ntitle: \"Example\"\ndate: 2024-01-01\ngame: cs2\nsteam_gid: \"1\"\nsource_url: \"https://example.test/1\"\n---\n# Example\n\n- Updated smoke.\n");

  const indexPath = path.join(contentDir, "generated", "notes-index.json");
  const result = buildAppCorpus(contentDir, indexPath);
  assert.equal(result.documents, 1);
  assert.equal(JSON.parse(fs.readFileSync(indexPath, "utf8")).documents[0].title, "Example");
});

test("uses the Worker-native SPA fallback for direct note links", () => {
  assert.match(
    fs.readFileSync(path.join(__dirname, "../../wrangler.jsonc"), "utf8"),
    /"not_found_handling": "single-page-application"/,
  );
});
