const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { migrateRevisionedCorpus } = require("../migrate-revisioned-corpus.cjs");
const { sha256 } = require("../revision-layout.cjs");

function rawRecord() {
  const body = "[ GAMEPLAY ]\n[*] Updated smoke.\n";
  return {
    gid: "123",
    title: "Counter-Strike 2 Update",
    date: "2024-01-01",
    game: "cs2",
    content_kind: "patch_notes",
    body_format: "bbcode",
    source_url: "https://example.test/123",
    body,
    body_sha256: sha256(body),
  };
}

function legacyCorpus(override = false) {
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-patchnotes-legacy-"));
  const raw = rawRecord();
  const rawBytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`);
  const body = "# Counter-Strike 2 Update\n\n## Gameplay\n\n- Updated smoke.\n";
  const markdown = Buffer.from([
    "---",
    `title: ${JSON.stringify(raw.title)}`,
    `date: ${raw.date}`,
    `game: ${raw.game}`,
    `content_kind: ${raw.content_kind}`,
    `body_format: ${raw.body_format}`,
    `steam_gid: ${JSON.stringify(raw.gid)}`,
    `source_url: ${JSON.stringify(raw.source_url)}`,
    `source_sha256: ${JSON.stringify(raw.body_sha256)}`,
    "converter_version: 6",
    `generated_sha256: ${JSON.stringify(sha256(body))}`,
    "---",
    body,
  ].join("\n"));
  fs.mkdirSync(path.join(contentDir, "raw", "steam"), { recursive: true });
  fs.mkdirSync(path.join(contentDir, "content", "notes"), { recursive: true });
  fs.writeFileSync(path.join(contentDir, "raw", "steam", "123.json"), rawBytes);
  fs.writeFileSync(path.join(contentDir, "content", "notes", "legacy-public-id.md"), markdown);
  let overrideBytes;
  if (override) {
    const overrideBody = body.replace("Updated smoke.", "Corrected smoke.");
    overrideBytes = Buffer.from(markdown.toString("utf8").replace(sha256(body), sha256(overrideBody)).replace(body, overrideBody));
    fs.mkdirSync(path.join(contentDir, "overrides"));
    fs.writeFileSync(path.join(contentDir, "overrides", "123.md"), overrideBytes);
  }
  return { contentDir, markdown, overrideBytes, rawBytes };
}

test("migration is dry-run first and does not mutate the source corpus", () => {
  const { contentDir } = legacyCorpus();
  const rawPath = path.join(contentDir, "raw", "steam", "123.json");
  const notePath = path.join(contentDir, "content", "notes", "legacy-public-id.md");
  const beforeRaw = fs.readFileSync(rawPath);
  const beforeNote = fs.readFileSync(notePath);

  assert.deepEqual(migrateRevisionedCorpus(contentDir), { dry_run: true, raw_revisions: 1, notes: 1, overrides: 0 });
  assert.deepEqual(fs.readFileSync(rawPath), beforeRaw);
  assert.deepEqual(fs.readFileSync(notePath), beforeNote);
});

test("applied migration preserves raw and Markdown bytes and public note IDs", () => {
  const { contentDir, markdown, rawBytes } = legacyCorpus();
  const revision = sha256(rawBytes);

  assert.deepEqual(migrateRevisionedCorpus(contentDir, { apply: true }), { dry_run: false, raw_revisions: 1, notes: 1, overrides: 0 });
  assert.deepEqual(fs.readFileSync(path.join(contentDir, "raw", "steam", "123", `${revision}.json`)), rawBytes);
  assert.deepEqual(fs.readFileSync(path.join(contentDir, "content", "notes", "123", `${revision}.md`)), markdown);
  const manifest = JSON.parse(fs.readFileSync(path.join(contentDir, "content", "notes", "123", "index.json"), "utf8"));
  assert.equal(manifest.note_id, "legacy-public-id.md");
  assert.deepEqual(manifest.legacy_migration_revisions, [revision]);
  assert.equal(fs.existsSync(path.join(contentDir, "raw", "steam", "123.json")), false);
  assert.equal(fs.existsSync(path.join(contentDir, "content", "notes", "legacy-public-id.md")), false);
});

test("migration refuses manual legacy Markdown without changing the source", () => {
  const { contentDir } = legacyCorpus();
  const notePath = path.join(contentDir, "content", "notes", "legacy-public-id.md");
  fs.writeFileSync(notePath, "# A hand-written note\n");
  const before = fs.readFileSync(notePath);

  assert.throws(() => migrateRevisionedCorpus(contentDir), /manual or lacks generated provenance/);
  assert.deepEqual(fs.readFileSync(notePath), before);
  assert.ok(fs.existsSync(path.join(contentDir, "raw", "steam", "123.json")));
});

test("migration preserves and records a valid legacy override", () => {
  const { contentDir, overrideBytes, rawBytes } = legacyCorpus(true);
  const revision = sha256(rawBytes);

  assert.deepEqual(migrateRevisionedCorpus(contentDir, { apply: true }), { dry_run: false, raw_revisions: 1, notes: 1, overrides: 1 });
  assert.deepEqual(fs.readFileSync(path.join(contentDir, "overrides", "123.md")), overrideBytes);
  const manifest = JSON.parse(fs.readFileSync(path.join(contentDir, "content", "notes", "123", "index.json"), "utf8"));
  assert.equal(manifest.override_revision, revision);
});
