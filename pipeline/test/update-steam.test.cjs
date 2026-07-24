const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { updateSteam } = require("../update-steam.cjs");

function sourceSnapshot(rootDir) {
  const entries = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const filename = path.join(directory, entry.name);
      const relativePath = path.relative(rootDir, filename);
      if (entry.isSymbolicLink()) entries.push({ path: relativePath, symlink: fs.readlinkSync(filename) });
      else if (entry.isDirectory()) {
        entries.push({ path: relativePath, type: "directory" });
        visit(filename);
      } else if (entry.isFile()) {
        entries.push({
          path: relativePath,
          sha256: crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex"),
        });
      }
    }
  }
  visit(rootDir);
  return entries;
}

function steamItem(body = "[ GAMEPLAY ]\n- Updated smoke.\n") {
  return { gid: "1", title: "Counter-Strike 2 Update", url: "https://example.test/1", feed_type: 1, feedname: "steam_community_announcements", date: 1_704_067_200, contents: body, tags: ["patchnotes"] };
}

function auditReport(findings = [], informational = {}) {
  return {
    documents: { raw: 1, notes: 1 },
    findings,
    duplicate_raw_bodies: informational.duplicate_raw_bodies || [],
    same_day_title_collisions: informational.same_day_title_collisions || [],
  };
}

test("adds new captures and converts them to Markdown", async () => {
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-patchnotes-update-"));
  const fetchNews = async () => new Map([["1", steamItem()]]);
  const result = await updateSteam(contentDir, { fetchNews });
  assert.equal(result.added, 1);
  assert.equal(result.conversion.created, 1);
  assert.ok(fs.existsSync(path.join(contentDir, "raw", "steam", "1.json")));
  assert.ok(fs.existsSync(path.join(contentDir, "content", "notes", "2024-01-01-counter-strike-2-update.md")));

  const repeat = await updateSteam(contentDir, { fetchNews });
  assert.equal(repeat.existing, 1);
  assert.equal(repeat.added, 0);
  assert.equal(repeat.conversion.unchanged, 1);
});

test("detects changed payloads without changing the raw store", async () => {
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-patchnotes-update-conflict-"));
  const first = async () => new Map([["1", steamItem()]]);
  await updateSteam(contentDir, { fetchNews: first });
  const conflicting = async () => new Map([["1", steamItem("[ GAMEPLAY ]\n- Changed source payload.\n")]]);
  const result = await updateSteam(contentDir, { fetchNews: conflicting });
  assert.equal(result.conflicts.length, 1);
  assert.match(fs.readFileSync(path.join(contentDir, "raw", "steam", "1.json"), "utf8"), /Updated smoke/);
});

test("reports additions without writing during a dry run", async () => {
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-patchnotes-update-dry-run-"));
  const result = await updateSteam(contentDir, { fetchNews: async () => new Map([["1", steamItem()]]), dryRun: true });
  assert.equal(result.added, 1);
  assert.equal(fs.existsSync(path.join(contentDir, "raw")), false);
});

test("rejects unsafe and duplicate Steam GIDs before accessing the raw store", async () => {
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-patchnotes-update-invalid-gid-"));
  for (const gid of ["../outside", "1/2"]) {
    await assert.rejects(updateSteam(contentDir, { fetchNews: async () => [{ ...steamItem(), gid }] }), /Steam feed GID must contain only decimal digits/);
  }
  await assert.rejects(updateSteam(contentDir, { fetchNews: async () => [steamItem(), steamItem()] }), /Steam feed contains duplicate GID: 1/);
  assert.equal(fs.existsSync(path.join(contentDir, "raw")), false);
});

test("rejects a structured blocking audit finding with actionable record details", async () => {
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-patchnotes-update-audit-blocking-"));
  const before = sourceSnapshot(contentDir);
  const finding = {
    class: "invalid_provenance",
    filename: "2024-01-01-counter-strike-2-update.md",
    steam_gid: "1",
    reason: "The source hash differs from the immutable capture.",
    remediation: "Regenerate the note from the immutable capture.",
  };

  await assert.rejects(
    updateSteam(contentDir, {
      fetchNews: async () => new Map([["1", steamItem()]]),
      audit: () => auditReport([finding]),
    }),
    /Corpus audit failed: invalid_provenance \(2024-01-01-counter-strike-2-update\.md; gid 1\): The source hash differs from the immutable capture\. Remediation: Regenerate the note from the immutable capture\./,
  );
  assert.deepEqual(sourceSnapshot(contentDir), before);
});

test("fails closed for injected audit reports without a valid findings array", async () => {
  for (const report of [{}, { findings: null }, { findings: "invalid" }]) {
    const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-patchnotes-update-invalid-audit-"));
    const before = sourceSnapshot(contentDir);
    await assert.rejects(
      updateSteam(contentDir, {
        fetchNews: async () => new Map([["1", steamItem()]]),
        audit: () => report,
      }),
      /Audit report is missing a valid findings array/,
    );
    assert.deepEqual(sourceSnapshot(contentDir), before);
  }
});

test("leaves the source corpus byte-identical when staged conversion conflicts", async () => {
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-patchnotes-update-conversion-conflict-"));
  await updateSteam(contentDir, { fetchNews: async () => new Map([["1", steamItem()]]) });
  const rawPath = path.join(contentDir, "raw", "steam", "1.json");
  const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
  raw.body = "[ GAMEPLAY ]\n- Changed source payload.\n";
  fs.writeFileSync(rawPath, `${JSON.stringify(raw, null, 2)}\n`);
  const notePath = path.join(contentDir, "content", "notes", "2024-01-01-counter-strike-2-update.md");
  fs.writeFileSync(notePath, fs.readFileSync(notePath, "utf8").replace("Updated smoke.", "Hand edit."));
  const before = sourceSnapshot(contentDir);

  const result = await updateSteam(contentDir, {
    fetchNews: async () => new Map([["2", { ...steamItem(), gid: "2", title: "Second Update", url: "https://example.test/2" }]]),
  });

  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(sourceSnapshot(contentDir), before);
});

test("rejects symlinked corpora before staging or conversion", async () => {
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-patchnotes-update-symlink-"));
  const externalNotesDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-patchnotes-update-external-notes-"));
  fs.mkdirSync(path.join(contentDir, "content"), { recursive: true });
  fs.symlinkSync(externalNotesDir, path.join(contentDir, "content", "notes"));
  const before = sourceSnapshot(contentDir);
  const externalBefore = sourceSnapshot(externalNotesDir);

  await assert.rejects(
    updateSteam(contentDir, { fetchNews: async () => new Map([["1", steamItem()]]) }),
    /Candidate corpus contains a symlink/,
  );
  assert.deepEqual(sourceSnapshot(contentDir), before);
  assert.deepEqual(sourceSnapshot(externalNotesDir), externalBefore);
});

test("keeps informational duplicate evidence from rejecting an update", async () => {
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-patchnotes-update-audit-informational-"));
  const report = auditReport([], {
    duplicate_raw_bodies: [{ body_sha256: "a", gids: ["1", "2"] }],
    same_day_title_collisions: [{ date: "2024-01-01", title: "Example", gids: ["1", "2"] }],
  });

  const result = await updateSteam(contentDir, {
    fetchNews: async () => new Map([["1", steamItem()]]),
    audit: () => report,
  });

  assert.equal(result.added, 1);
  assert.equal(result.audit, report);
});

test("delegates update eligibility to the audit-owned predicate", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "update-steam.cjs"), "utf8");
  assert.match(source, /blockingFindings/);
  assert.doesNotMatch(source, /REQUIRED_EMPTY_FINDINGS/);
});
