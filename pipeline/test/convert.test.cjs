const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { auditCorpus, blockingFindings } = require("../audit.cjs");
const { convertAll, generatedBody, parseNote, renderNote, sha256, toMarkdown } = require("../convert.cjs");

const fixturesDir = path.join(__dirname, "fixtures");

function fixture(year) {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, `${year}.json`), "utf8"));
}

test("converts golden fixtures from each supported Steam era", () => {
  for (const year of ["2013", "2014", "2021", "2024"]) {
    const expected = fs.readFileSync(path.join(fixturesDir, `${year}.md`), "utf8");
    assert.equal(toMarkdown(fixture(year).body), expected, year);
  }
});

function tempCorpus(raw = fixture("2024")) {
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-patchnotes-content-"));
  const rawDir = path.join(contentDir, "raw", "steam");
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, `${raw.gid}.json`), `${JSON.stringify(raw)}\n`);
  return contentDir;
}

function notePath(contentDir, raw = fixture("2024")) {
  return path.join(contentDir, "content", "notes", `${raw.date}-counter-strike-2-update.md`);
}

test("regenerates untouched output after raw content changes", () => {
  const raw = fixture("2024");
  const contentDir = tempCorpus(raw);
  assert.equal(convertAll(contentDir).created, 1);

  raw.body += "\n[*] Added a second item.";
  fs.writeFileSync(path.join(contentDir, "raw", "steam", "2024.json"), `${JSON.stringify(raw)}\n`);
  const summary = convertAll(contentDir);
  assert.equal(summary.regenerated, 1);
  assert.match(fs.readFileSync(notePath(contentDir), "utf8"), /Added a second item/);
});

test("preserves a hand edit when conversion still matches its recorded generation", () => {
  const raw = fixture("2024");
  const contentDir = tempCorpus(raw);
  convertAll(contentDir);
  const target = notePath(contentDir);
  const original = fs.readFileSync(target, "utf8");
  fs.writeFileSync(target, original.replace("Added damage prediction.", "Hand-edited damage prediction."));

  const summary = convertAll(contentDir);
  assert.equal(summary.preserved, 1);
  assert.match(fs.readFileSync(target, "utf8"), /Hand-edited damage prediction/);
});

test("flags rather than overwrites a hand edit when conversion changes", () => {
  const raw = fixture("2024");
  const contentDir = tempCorpus(raw);
  convertAll(contentDir);
  const target = notePath(contentDir);
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("Added damage prediction.", "Hand edit."));

  raw.body += "\n[*] Newly generated item.";
  fs.writeFileSync(path.join(contentDir, "raw", "steam", "2024.json"), `${JSON.stringify(raw)}\n`);
  const summary = convertAll(contentDir);
  assert.equal(summary.conflicts.length, 1);
  assert.match(fs.readFileSync(target, "utf8"), /Hand edit/);
  assert.match(fs.readFileSync(`${target}.new`, "utf8"), /Newly generated item/);
});

test("copies a complete audit-valid gid override verbatim", () => {
  const raw = { ...fixture("2024"), body_sha256: sha256(fixture("2024").body) };
  const contentDir = tempCorpus(raw);
  const overrides = path.join(contentDir, "overrides");
  fs.mkdirSync(overrides, { recursive: true });
  const correctedBody = generatedBody(raw)
    .replace("- Workshop: <https://example.test/workshop>", "- Workshop: [Workshop](https://example.test/workshop)");
  const override = renderNote(raw, correctedBody);
  fs.writeFileSync(path.join(overrides, "2024.md"), override);

  const summary = convertAll(contentDir);
  assert.equal(summary.overridden, 1);
  assert.equal(fs.readFileSync(notePath(contentDir), "utf8"), override);
  assert.deepEqual(blockingFindings(auditCorpus(contentDir)), []);
});

test("records hashes for the exact Markdown body bytes", () => {
  const raw = fixture("2024");
  const rendered = require("../convert.cjs").renderNote(raw, generatedBody(raw));
  const parsed = parseNote(rendered);
  assert.equal(parsed.frontmatter.generated_sha256, sha256(parsed.body));
});
