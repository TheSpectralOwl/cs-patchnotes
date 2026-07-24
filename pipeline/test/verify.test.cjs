const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { convertAll } = require("../convert.cjs");
const { formatVerificationResult, verifyCorpus } = require("../verify.cjs");

function sourceSnapshot(rootDir) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const filename = path.join(directory, entry.name);
      const relativePath = path.relative(rootDir, filename);
      if (entry.isSymbolicLink()) {
        files.push({ path: relativePath, symlink: fs.readlinkSync(filename) });
      } else if (entry.isDirectory()) visit(filename);
      else if (entry.isFile()) {
        files.push({
          path: relativePath,
          sha256: crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex"),
        });
      }
    }
  }
  visit(rootDir);
  return files;
}

function auditReport(findings = [], informational = {}) {
  return {
    documents: { raw: 1, notes: 1 },
    findings,
    duplicate_raw_bodies: informational.duplicate_raw_bodies || [],
    same_day_title_collisions: informational.same_day_title_collisions || [],
  };
}

const blockingRecords = [
  "invalid_frontmatter",
  "invalid_provenance",
  "raw_without_note",
  "note_without_raw",
  "duplicate_note_gid",
  "residual_bbcode",
  "list_headings",
  "regeneration_reviews",
].map((findingClass) => ({
  class: findingClass,
  filename: `${findingClass}.md`,
  steam_gid: "1",
  reason: `${findingClass} reason`,
  remediation: `${findingClass} remediation`,
}));

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

test("verifies a complete corpus without modifying source evidence", () => {
  const contentDir = createCorpus();
  const before = sourceSnapshot(contentDir);
  const result = verifyCorpus(contentDir);
  assert.equal(result.ok, true);
  assert.equal(result.conversion.unchanged, 1);
  assert.deepEqual(sourceSnapshot(contentDir), before);
});

test("rejects a notes-directory symlink before copying or converting", () => {
  const contentDir = createCorpus();
  const notesDir = path.join(contentDir, "content", "notes");
  const externalNotesDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-patchnotes-verify-external-notes-"));
  fs.cpSync(notesDir, externalNotesDir, { recursive: true });
  fs.rmSync(notesDir, { recursive: true });
  fs.symlinkSync(externalNotesDir, notesDir);
  const before = sourceSnapshot(contentDir);
  const externalBefore = sourceSnapshot(externalNotesDir);

  assert.throws(() => verifyCorpus(contentDir), /Candidate corpus contains a symlink/);
  assert.deepEqual(sourceSnapshot(contentDir), before);
  assert.deepEqual(sourceSnapshot(externalNotesDir), externalBefore);
});

test("rejects a raw-store symlink before copying or converting", () => {
  const contentDir = createCorpus();
  const rawDir = path.join(contentDir, "raw", "steam");
  const externalRawDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-patchnotes-verify-external-raw-"));
  fs.cpSync(rawDir, externalRawDir, { recursive: true });
  fs.rmSync(rawDir, { recursive: true });
  fs.symlinkSync(externalRawDir, rawDir);
  const before = sourceSnapshot(contentDir);
  const externalBefore = sourceSnapshot(externalRawDir);

  assert.throws(() => verifyCorpus(contentDir), /Candidate corpus contains a symlink/);
  assert.deepEqual(sourceSnapshot(contentDir), before);
  assert.deepEqual(sourceSnapshot(externalRawDir), externalBefore);
});

test("fails when committed Markdown is stale for the current converter", () => {
  const contentDir = createCorpus();
  const note = path.join(contentDir, "content", "notes", "2024-01-01-example.md");
  fs.writeFileSync(note, fs.readFileSync(note, "utf8").replace("converter_version: 6", "converter_version: 1"));
  const result = verifyCorpus(contentDir);
  assert.equal(result.ok, false);
  assert.match(result.failures[0], /not current/);
});

test("rejects every structured blocking audit record without modifying source evidence", () => {
  for (const record of blockingRecords) {
    const contentDir = createCorpus();
    const before = sourceSnapshot(contentDir);
    const result = verifyCorpus(contentDir, { audit: () => auditReport([record]) });

    assert.equal(result.ok, false, record.class);
    assert.deepEqual(result.blocking_findings, [record], record.class);
    assert.match(result.failures[0], new RegExp(`${record.class} has 1 finding`));
    assert.deepEqual(sourceSnapshot(contentDir), before, record.class);
  }
});

test("fails closed for injected audit reports without a valid findings array", () => {
  for (const report of [{}, { findings: null }, { findings: "invalid" }]) {
    const contentDir = createCorpus();
    const before = sourceSnapshot(contentDir);
    assert.throws(
      () => verifyCorpus(contentDir, { audit: () => report }),
      /Audit report is missing a valid findings array/,
    );
    assert.deepEqual(sourceSnapshot(contentDir), before);
  }
});

test("keeps informational duplicate evidence eligible and exposes deterministic actionable CLI details", () => {
  const contentDir = createCorpus();
  const result = verifyCorpus(contentDir, {
    audit: () => auditReport([], {
      duplicate_raw_bodies: [{ body_sha256: "a", gids: ["1", "2"] }],
      same_day_title_collisions: [{ date: "2024-01-01", title: "Example", gids: ["1", "2"] }],
    }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.blocking_findings, []);
  assert.deepEqual(formatVerificationResult({
    ...result,
    ok: false,
    blocking_findings: [blockingRecords[1], blockingRecords[0]],
  }), {
    ok: false,
    failures: result.failures,
    documents: { raw: 1, notes: 1 },
    conversion: result.conversion,
    blocking_class_counts: {
      invalid_frontmatter: 1,
      invalid_provenance: 1,
    },
    blocking_findings: [blockingRecords[0], blockingRecords[1]],
    informational_findings: {
      duplicate_raw_bodies: 1,
      same_day_title_collisions: 1,
    },
  });
});
