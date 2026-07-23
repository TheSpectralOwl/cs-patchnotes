#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { auditCorpus } = require("./audit.cjs");
const { convertAll } = require("./convert.cjs");

const DEFAULT_CONTENT_DIR = path.resolve(__dirname, "..", "..", "cs-patchnotes-content");
const REQUIRED_EMPTY_FINDINGS = [
  "invalid_frontmatter",
  "invalid_provenance",
  "raw_without_note",
  "note_without_raw",
  "residual_bbcode",
  "list_headings",
  "regeneration_reviews",
];

function verifyCorpus(contentDir = process.env.CONTENT_DIR || DEFAULT_CONTENT_DIR) {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-patchnotes-verify-"));
  const copiedContentDir = path.join(temporaryDir, "content");
  try {
    fs.cpSync(contentDir, copiedContentDir, { recursive: true });
    const conversion = convertAll(copiedContentDir);
    const audit = auditCorpus(copiedContentDir);
    const failures = [];
    if (conversion.created || conversion.regenerated || conversion.overridden || conversion.conflicts.length) {
      failures.push("generated Markdown is not current with the converter");
    }
    for (const finding of REQUIRED_EMPTY_FINDINGS) {
      if (audit[finding].length > 0) failures.push(`${finding} has ${audit[finding].length} finding(s)`);
    }
    return { ok: failures.length === 0, failures, conversion, audit };
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const result = verifyCorpus();
  console.log(JSON.stringify({
    ok: result.ok,
    failures: result.failures,
    documents: result.audit.documents,
    conversion: result.conversion,
    informational_findings: {
      duplicate_raw_bodies: result.audit.duplicate_raw_bodies.length,
      same_day_title_collisions: result.audit.same_day_title_collisions.length,
    },
  }, null, 2));
  if (!result.ok) process.exitCode = 1;
}

module.exports = { verifyCorpus };
