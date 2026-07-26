const assert = require("node:assert/strict");
const { existsSync, mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { hostname } = require("node:os");
const test = require("node:test");
const path = require("node:path");
const { acquireActivationLock, runActivation } = require("../activate-content.cjs");

const SHA = "a".repeat(40);
const OLD_SHA = "b".repeat(40);
const TOKEN = "fixture-reload-token";

function response(status, body = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function lockOwner(token, startedAt) {
  return { token, pid: 1234, hostname: hostname(), started_at: startedAt };
}

function fixture({ commandFailure, fetchResponses = [], fetchFailure } = {}) {
  const calls = [];
  const output = [];
  let marker = OLD_SHA;
  let fetchIndex = 0;
  return {
    options: { sha: SHA, revisionRoot: path.join("/tmp", `cs-patchnotes-activation-${process.pid}`), contentRepository: "/fixture/repo", apiUrl: "http://archive-api.test", reloadToken: TOKEN },
    calls,
    output,
    marker: () => marker,
    dependencies: {
      acquireLock() { calls.push("lock"); return () => calls.push("unlock"); },
      readMarker() { calls.push("read marker"); return marker; },
      publishMarker(_root, sha) { calls.push(`publish ${sha}`); marker = sha; },
      clearMarker() { calls.push("clear marker"); marker = undefined; },
      runCommand(command, args) {
        const call = `${command} ${args.join(" ")}`;
        calls.push(call);
        if (commandFailure?.(call)) throw commandFailure(call);
        if (args.includes("rev-parse") && args.at(-1) === "HEAD") return { stdout: `${SHA}\n` };
        if (args.includes("rev-parse")) return { stdout: `${SHA}\n` };
        return { stdout: "" };
      },
      async fetch(url, init = {}) {
        const call = `${init.method || "GET"} ${url.pathname}`;
        calls.push(call);
        if (fetchFailure?.(call)) throw fetchFailure(call);
        return fetchResponses[fetchIndex++];
      },
      write(message) { output.push(message); },
    },
  };
}

test("rejects short SHAs before taking the activation lock", async () => {
  const testCase = fixture();
  testCase.options.sha = "abc123";
  const result = await runActivation(testCase.options, testCase.dependencies);
  assert.deepEqual(result, { ok: false, stage: "preflight" });
  assert.deepEqual(testCase.calls, []);
});

test("creates and verifies the exact detached candidate before publishing its marker", async () => {
  const testCase = fixture({
    commandFailure: (call) => call.includes("/worktrees/") && call.endsWith("rev-parse HEAD") ? new Error("command failed") : undefined,
    fetchResponses: [response(200, {}), response(200, { ok: true, notes: 2, visible_notes: 1, content_sha: SHA })],
  });
  const result = await runActivation(testCase.options, testCase.dependencies);
  assert.equal(result.ok, true);
  assert.equal(testCase.marker(), SHA);
  assert.ok(testCase.calls.findIndex((call) => call.includes("pipeline/verify.cjs")) < testCase.calls.findIndex((call) => call === `publish ${SHA}`));
  assert.ok(testCase.calls.includes(`git -C /fixture/repo fetch --quiet origin ${SHA}`));
  assert.ok(testCase.calls.includes("POST /internal/reload"));
  assert.deepEqual(testCase.calls.slice(-2), ["GET /health", "unlock"]);
});

test("restores the old marker when the API definitively rejects the SHA-bound reload", async () => {
  const testCase = fixture({ fetchResponses: [response(409)] });
  const result = await runActivation(testCase.options, testCase.dependencies);
  assert.deepEqual(result, { ok: false, stage: "reload" });
  assert.equal(testCase.marker(), OLD_SHA);
  assert.deepEqual(testCase.calls.filter((call) => call.startsWith("publish")), [`publish ${SHA}`, `publish ${OLD_SHA}`]);
  assert.equal(testCase.calls.includes("GET /health"), false);
});

test("keeps a verified candidate selected when reload delivery is unknown", async () => {
  const testCase = fixture({ fetchFailure: (call) => call === "POST /internal/reload" ? Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) : undefined });
  const result = await runActivation(testCase.options, testCase.dependencies);
  assert.deepEqual(result, { ok: false, stage: "reload", unconfirmed: true, sha: SHA });
  assert.equal(testCase.marker(), SHA);
  assert.match(testCase.output.join("\n"), /unconfirmed/i);
});

test("keeps a selected candidate unconfirmed when health cannot confirm its SHA", async () => {
  const testCase = fixture({ fetchResponses: [response(200), response(200, { ok: true, notes: 2, visible_notes: 1, content_sha: OLD_SHA })] });
  const result = await runActivation(testCase.options, testCase.dependencies);
  assert.deepEqual(result, { ok: false, stage: "health confirmation", unconfirmed: true, sha: SHA });
  assert.equal(testCase.marker(), SHA);
});

test("refuses a fresh activation lock held by another owner", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cs-patchnotes-lock-"));
  try {
    const release = acquireActivationLock(root, { staleMs: 60_000, now: () => 0, owner: lockOwner("first", 0) });
    assert.throws(
      () => acquireActivationLock(root, { staleMs: 60_000, now: () => 1, owner: lockOwner("second", 1) }),
      /another activation is already running/,
    );
    release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovers a stale lock only after its owner is confirmed dead", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cs-patchnotes-lock-"));
  try {
    const first = acquireActivationLock(root, { staleMs: 60_000, now: () => 0, owner: lockOwner("first", 0) });
    const recovered = acquireActivationLock(root, {
      staleMs: 60_000,
      now: () => 60_000,
      owner: lockOwner("second", 60_000),
      ownerAlive: () => false,
    });
    assert.equal(JSON.parse(readFileSync(path.join(root, ".activation-lock", "owner.json"), "utf8")).token, "second");
    first();
    assert.equal(existsSync(path.join(root, ".activation-lock")), true);
    recovered();
    assert.equal(existsSync(path.join(root, ".activation-lock")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not reclaim a stale lock while its owner may still be live", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cs-patchnotes-lock-"));
  try {
    const release = acquireActivationLock(root, { staleMs: 60_000, now: () => 0, owner: lockOwner("first", 0) });
    assert.throws(
      () => acquireActivationLock(root, {
        staleMs: 60_000,
        now: () => 60_000,
        owner: lockOwner("second", 60_000),
        ownerAlive: () => true,
      }),
      /owner is still running/,
    );
    assert.equal(JSON.parse(readFileSync(path.join(root, ".activation-lock", "owner.json"), "utf8")).token, "first");
    release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
