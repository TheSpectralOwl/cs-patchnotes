const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { parseNote, renderNote, sha256 } = require("../convert.cjs");
const { auditCorpus, blockingFindings } = require("../audit.cjs");

function makeRaw(overrides = {}) {
  const raw = {
    gid: "1",
    title: "Example",
    date: "2024-01-01",
    game: "cs2",
    content_kind: "patch_notes",
    body_format: "bbcode",
    source_url: "https://example.test/1",
    body: "[list][*]Example[/list]",
    ...overrides,
  };
  return { ...raw, body_sha256: sha256(raw.body) };
}

function createCorpus() {
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-patchnotes-audit-"));
  fs.mkdirSync(path.join(contentDir, "raw", "steam"), { recursive: true });
  fs.mkdirSync(path.join(contentDir, "content", "notes"), { recursive: true });
  return contentDir;
}

function writeRaw(contentDir, raw) {
  fs.writeFileSync(path.join(contentDir, "raw", "steam", `${raw.gid}.json`), JSON.stringify(raw));
}

function writeNote(contentDir, filename, raw, body = `# ${raw.title}\n\n- Example\n`) {
  fs.writeFileSync(path.join(contentDir, "content", "notes", filename), renderNote(raw, body));
}

function validCorpus() {
  const contentDir = createCorpus();
  const raw = makeRaw();
  writeRaw(contentDir, raw);
  writeNote(contentDir, "example.md", raw);
  return { contentDir, raw };
}

function sortFindings(findings) {
  return [...findings].sort(
    (left, right) => left.class.localeCompare(right.class)
      || (left.filename || "").localeCompare(right.filename || "")
      || (left.steam_gid || "").localeCompare(right.steam_gid || ""),
  );
}

test("a valid loader-compatible corpus has no blocking findings", () => {
  const { contentDir } = validCorpus();
  const report = auditCorpus(contentDir);

  assert.deepEqual(report.documents, { raw: 1, notes: 1 });
  assert.deepEqual(blockingFindings(report), []);
});

test("fails closed when an audit report lacks a valid finding array or record", () => {
  for (const report of [{}, { findings: null }, { findings: "invalid" }]) {
    assert.throws(() => blockingFindings(report), /missing a valid findings array/);
  }
  assert.throws(
    () => blockingFindings({ findings: [{ class: "invalid_frontmatter" }] }),
    /invalid finding record at index 0/,
  );
});

test("rejects every archive-loader-required frontmatter field", () => {
  for (const field of ["title", "date", "game", "steam_gid", "source_url", "source_sha256", "generated_sha256"]) {
    const { contentDir } = validCorpus();
    const notePath = path.join(contentDir, "content", "notes", "example.md");
    const parsed = parseNote(fs.readFileSync(notePath, "utf8"));
    delete parsed.frontmatter[field];
    const frontmatter = Object.entries(parsed.frontmatter)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join("\n");
    fs.writeFileSync(notePath, `---\n${frontmatter}\n---\n${parsed.body}`);

    assert.ok(blockingFindings(auditCorpus(contentDir)).some((finding) => finding.class === "invalid_frontmatter"));
  }
});

test("reports named actionable findings with stable reviewer-ready records", () => {
  const cases = [
    {
      class: "invalid_frontmatter",
      filename: "example.md",
      mutate({ contentDir }) {
        fs.writeFileSync(path.join(contentDir, "content", "notes", "example.md"), "---\nsteam_gid: \"1\"\n---\n# Example\n");
      },
    },
    {
      class: "invalid_provenance",
      filename: "example.md",
      mutate({ contentDir }) {
        const notePath = path.join(contentDir, "content", "notes", "example.md");
        fs.writeFileSync(notePath, fs.readFileSync(notePath, "utf8").replace(/source_sha256: .+/, 'source_sha256: "wrong"'));
      },
    },
    {
      class: "raw_without_note",
      filename: undefined,
      mutate({ contentDir, raw }) {
        fs.rmSync(path.join(contentDir, "content", "notes", "example.md"));
        assert.equal(raw.gid, "1");
      },
    },
    {
      class: "note_without_raw",
      filename: "missing.md",
      steam_gid: "missing",
      mutate({ contentDir, raw }) {
        const missing = makeRaw({ ...raw, gid: "missing", source_url: "https://example.test/missing" });
        writeNote(contentDir, "missing.md", missing);
      },
    },
    {
      class: "duplicate_note_gid",
      filename: "second.md",
      mutate({ contentDir, raw }) {
        writeNote(contentDir, "second.md", raw);
      },
    },
    {
      class: "residual_bbcode",
      filename: "example.md",
      mutate({ contentDir, raw }) {
        writeNote(contentDir, "example.md", raw, "# Example\n\n[list][*]Example[/list]\n");
      },
    },
    {
      class: "list_headings",
      filename: "example.md",
      mutate({ contentDir, raw }) {
        writeNote(contentDir, "example.md", raw, "# Example\n\n## List\n\n- Example\n");
      },
    },
    {
      class: "regeneration_reviews",
      filename: "example.md",
      mutate({ contentDir, raw }) {
        fs.writeFileSync(path.join(contentDir, "content", "notes", "example.md.new"), renderNote(raw, "# Example\n\n- Proposed\n"));
      },
    },
  ];

  for (const auditCase of cases) {
    const fixture = validCorpus();
    auditCase.mutate(fixture);
    const findings = blockingFindings(auditCorpus(fixture.contentDir));

    assert.equal(findings.length, 1, auditCase.class);
    const [finding] = findings;
    assert.equal(finding.class, auditCase.class);
    assert.equal(finding.filename, auditCase.filename);
    if (auditCase.steam_gid) assert.equal(finding.steam_gid, auditCase.steam_gid);
    assert.equal(typeof finding.reason, "string");
    assert.notEqual(finding.reason, "");
    assert.equal(typeof finding.remediation, "string");
    assert.notEqual(finding.remediation, "");
  }
});

test("reports malformed raw captures as deterministic blocking findings", () => {
  const cases = [
    { filename: "invalid-json.json", contents: "{", detail: "invalid JSON" },
    { filename: "missing-body.json", contents: JSON.stringify({ ...makeRaw(), body: undefined }), detail: "missing or non-string body" },
    { filename: "non-string-title.json", contents: JSON.stringify(makeRaw({ title: 42 })), detail: "missing or non-string title" },
  ];

  for (const rawCase of cases) {
    const { contentDir } = validCorpus();
    fs.writeFileSync(path.join(contentDir, "raw", "steam", rawCase.filename), rawCase.contents);

    const report = auditCorpus(contentDir);
    const finding = blockingFindings(report).find((candidate) => candidate.filename === rawCase.filename);
    assert.deepEqual(finding, {
      class: "invalid_raw_record",
      filename: rawCase.filename,
      detail: rawCase.detail,
      reason: "An immutable Steam capture is malformed and cannot be audited safely.",
      remediation: "Restore the capture from source evidence with valid GID, title, date, and body fields.",
    });
    assert.equal(report.documents.raw, 1);
  }
});

test("rejects duplicate raw GIDs and invalid raw hashes", () => {
  const { contentDir, raw } = validCorpus();
  fs.writeFileSync(path.join(contentDir, "raw", "steam", "duplicate.json"), JSON.stringify(raw));
  const duplicateFindings = blockingFindings(auditCorpus(contentDir)).filter((finding) => finding.class === "duplicate_raw_gid");
  assert.deepEqual(duplicateFindings.map((finding) => finding.filename), ["1.json", "duplicate.json"]);

  fs.rmSync(path.join(contentDir, "raw", "steam", "duplicate.json"));
  fs.writeFileSync(path.join(contentDir, "raw", "steam", "2.json"), JSON.stringify({ ...raw, gid: "2", body_sha256: "bad" }));
  assert.ok(blockingFindings(auditCorpus(contentDir)).some((finding) => finding.class === "invalid_raw_record"));
});

test("rejects path-bearing dates and hashes that do not match raw bodies", () => {
  const { contentDir, raw } = validCorpus();
  fs.writeFileSync(path.join(contentDir, "raw", "steam", "bad-date.json"), JSON.stringify({
    ...raw,
    gid: "2",
    date: "../../outside",
  }));
  fs.writeFileSync(path.join(contentDir, "raw", "steam", "bad-hash.json"), JSON.stringify({
    ...raw,
    gid: "3",
    body_sha256: "a".repeat(64),
  }));

  const findings = blockingFindings(auditCorpus(contentDir));
  assert.deepEqual(
    findings.filter((finding) => finding.class === "invalid_raw_record").map((finding) => [finding.filename, finding.detail]),
    [["bad-date.json", "missing or invalid date"], ["bad-hash.json", "body_sha256 does not match body"]],
  );
});

test("sorts blocking records by class, filename, and Steam GID", () => {
  const { contentDir, raw } = validCorpus();
  writeRaw(contentDir, makeRaw({ gid: "2", title: "Second", source_url: "https://example.test/2" }));
  writeNote(contentDir, "z-second.md", raw);
  fs.writeFileSync(path.join(contentDir, "content", "notes", "a-bad.md"), "---\nsteam_gid: \"broken\"\n---\n# Broken\n");

  const findings = blockingFindings(auditCorpus(contentDir));
  assert.deepEqual(findings, sortFindings(findings));
});

test("keeps exact duplicate evidence and title collisions informational", () => {
  const contentDir = createCorpus();
  const first = makeRaw();
  const second = makeRaw({ gid: "2", source_url: "https://example.test/2" });
  writeRaw(contentDir, first);
  writeRaw(contentDir, second);
  writeNote(contentDir, "first.md", first);
  writeNote(contentDir, "second.md", second);

  const report = auditCorpus(contentDir);
  assert.deepEqual(blockingFindings(report), []);
  assert.deepEqual(report.duplicate_raw_bodies, [{ body_sha256: first.body_sha256, gids: ["1", "2"] }]);
  assert.deepEqual(report.same_day_title_collisions, [{ date: "2024-01-01", title: "Example", gids: ["1", "2"] }]);
});
