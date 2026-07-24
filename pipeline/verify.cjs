#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { auditCorpus, blockingFindings } = require("./audit.cjs");
const { convertAll } = require("./convert.cjs");

const DEFAULT_CONTENT_DIR = path.resolve(__dirname, "..", "..", "cs-patchnotes-content");

function compareFindings(left, right) {
  return left.class.localeCompare(right.class)
    || (left.filename || "").localeCompare(right.filename || "")
    || (left.steam_gid || "").localeCompare(right.steam_gid || "");
}

function findingClassCounts(findings) {
  return Object.fromEntries([...findings
    .reduce((counts, finding) => counts.set(finding.class, (counts.get(finding.class) || 0) + 1), new Map())
    .entries()]
    .sort(([left], [right]) => left.localeCompare(right)));
}

function auditFailures(findings) {
  return Object.entries(findingClassCounts(findings))
    .map(([findingClass, count]) => `${findingClass} has ${count} finding(s)`);
}

function verifyCorpus(contentDir = process.env.CONTENT_DIR || DEFAULT_CONTENT_DIR, options = {}) {
  const auditCorpusCopy = options.audit || auditCorpus;
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-patchnotes-verify-"));
  const copiedContentDir = path.join(temporaryDir, "content");
  try {
    fs.cpSync(contentDir, copiedContentDir, { recursive: true });
    const conversion = convertAll(copiedContentDir);
    const audit = auditCorpusCopy(copiedContentDir);
    const blocking_findings = blockingFindings(audit);
    const failures = [];
    if (conversion.created || conversion.regenerated || conversion.overridden || conversion.conflicts.length) {
      failures.push("generated Markdown is not current with the converter");
    }
    failures.push(...auditFailures(blocking_findings));
    return { ok: failures.length === 0, failures, conversion, audit, blocking_findings };
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

function formatVerificationResult(result) {
  const informational = {
    duplicate_raw_bodies: (result.audit.duplicate_raw_bodies || []).length,
    same_day_title_collisions: (result.audit.same_day_title_collisions || []).length,
  };
  return {
    ok: result.ok,
    failures: result.failures,
    documents: result.audit.documents,
    conversion: result.conversion,
    blocking_class_counts: findingClassCounts(result.blocking_findings),
    blocking_findings: [...result.blocking_findings].sort(compareFindings),
    informational_findings: informational,
  };
}

if (require.main === module) {
  const result = verifyCorpus();
  console.log(JSON.stringify(formatVerificationResult(result), null, 2));
  if (!result.ok) process.exitCode = 1;
}

module.exports = { formatVerificationResult, verifyCorpus };
