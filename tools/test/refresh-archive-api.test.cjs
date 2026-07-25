const assert = require("node:assert/strict");
const test = require("node:test");

const { runRefresh } = require("../refresh-archive-api.cjs");

const TOKEN = "fixture-reload-token";
const AUTHORIZATION = `Bearer ${TOKEN}`;

function health(notes = 275, visibleNotes = 260) {
  return { ok: true, notes, visible_notes: visibleNotes };
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
  };
}

function fixture({ commandFailure, commandOutput, fetchFailure, fetchResponses = [] } = {}) {
  const trace = [];
  const output = [];
  const requests = [];
  let fetchIndex = 0;
  const options = {
    contentDir: "/fixture/content",
    apiUrl: "http://archive-api.test",
    reloadToken: TOKEN,
  };
  const dependencies = {
    runCommand(command, args) {
      const call = `${command} ${args.join(" ")}`;
      trace.push(call);
      if (commandFailure?.(call)) throw commandFailure(call);
      return commandOutput?.(call) || { stdout: "" };
    },
    async fetch(url, init = {}) {
      const call = `${init.method || "GET"} ${url.pathname}`;
      trace.push(call);
      requests.push({ url, init });
      if (fetchFailure?.(call)) throw fetchFailure(call);
      return fetchResponses[fetchIndex++];
    },
    write(message) {
      output.push(message);
    },
  };
  return { options, dependencies, output, requests, trace };
}

function assertSafeDiagnostics(output) {
  const text = output.join("\n");
  assert.doesNotMatch(text, new RegExp(TOKEN));
  assert.doesNotMatch(text, new RegExp(AUTHORIZATION));
  assert.doesNotMatch(text, /untrusted reload response/i);
}

test("stops at preflight when required configuration is absent", async () => {
  const testCase = fixture();
  testCase.options.apiUrl = "";

  const result = await runRefresh(testCase.options, testCase.dependencies);

  assert.deepEqual(result, { ok: false, stage: "preflight" });
  assert.deepEqual(testCase.trace, []);
  assert.match(testCase.output.join("\n"), /preflight/i);
  assert.match(testCase.output.join("\n"), /ARCHIVE_API_URL/i);
  assertSafeDiagnostics(testCase.output);
});

test("stops at preflight for a dirty content checkout", async () => {
  const testCase = fixture({ commandOutput: (call) => call.endsWith("status --porcelain") ? { stdout: " M content/notes/example.md\n" } : undefined });

  const result = await runRefresh(testCase.options, testCase.dependencies);

  assert.deepEqual(result, { ok: false, stage: "preflight" });
  assert.deepEqual(testCase.trace, ["git -C /fixture/content status --porcelain"]);
  assert.match(testCase.output.join("\n"), /resolve.*checkout/i);
  assertSafeDiagnostics(testCase.output);
});

test("stops after a failed fast-forward without verification or HTTP calls", async () => {
  const testCase = fixture({ commandFailure: (call) => call.endsWith("pull --ff-only") ? new Error("remote divergent") : undefined });

  const result = await runRefresh(testCase.options, testCase.dependencies);

  assert.deepEqual(result, { ok: false, stage: "Git fast-forward" });
  assert.deepEqual(testCase.trace, [
    "git -C /fixture/content status --porcelain",
    "git -C /fixture/content pull --ff-only",
  ]);
  assert.match(testCase.output.join("\n"), /reconcile/i);
  assertSafeDiagnostics(testCase.output);
});

test("stops after verification failure without resetting or calling the API", async () => {
  const testCase = fixture({ commandFailure: (call) => call.includes("pipeline/verify.cjs") ? new Error("invalid candidate") : undefined });

  const result = await runRefresh(testCase.options, testCase.dependencies);

  assert.deepEqual(result, { ok: false, stage: "verification" });
  assert.equal(testCase.trace.some((call) => call.startsWith("GET") || call.startsWith("POST")), false);
  assert.equal(testCase.trace.some((call) => /reset|rollback/.test(call)), false);
  assert.match(testCase.output.join("\n"), /inspect/i);
  assertSafeDiagnostics(testCase.output);
});

test("stops at baseline health when health is invalid without reloading", async () => {
  const testCase = fixture({ fetchResponses: [response(200, { ok: false })] });

  const result = await runRefresh(testCase.options, testCase.dependencies);

  assert.deepEqual(result, { ok: false, stage: "health confirmation" });
  assert.equal(testCase.trace.filter((call) => call === "POST /internal/reload").length, 0);
  assert.equal(testCase.trace.filter((call) => call.startsWith("GET")).length, 1);
  assert.match(testCase.output.join("\n"), /health/i);
  assertSafeDiagnostics(testCase.output);
});

test("reports a rejected reload as preserving the prior index without retrying", async () => {
  const testCase = fixture({ fetchResponses: [response(200, health()), response(503, "untrusted reload response")] });

  const result = await runRefresh(testCase.options, testCase.dependencies);

  assert.deepEqual(result, { ok: false, stage: "reload" });
  assert.equal(testCase.trace.filter((call) => call === "POST /internal/reload").length, 1);
  assert.equal(testCase.trace.filter((call) => call.startsWith("GET")).length, 1);
  assert.match(testCase.output.join("\n"), /prior in-memory index remains active/i);
  assert.match(testCase.output.join("\n"), /HTTP 503/);
  assertSafeDiagnostics(testCase.output);
});

test("reports an unreachable reload as preserving the prior index without retrying", async () => {
  const testCase = fixture({
    fetchResponses: [response(200, health())],
    fetchFailure: (call) => call === "POST /internal/reload" ? Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }) : undefined,
  });

  const result = await runRefresh(testCase.options, testCase.dependencies);

  assert.deepEqual(result, { ok: false, stage: "reload" });
  assert.equal(testCase.trace.filter((call) => call === "POST /internal/reload").length, 1);
  assert.equal(testCase.trace.filter((call) => call.startsWith("GET")).length, 1);
  assert.match(testCase.output.join("\n"), /prior in-memory index remains active/i);
  assert.match(testCase.output.join("\n"), /ECONNREFUSED/);
  assertSafeDiagnostics(testCase.output);
});

test("reports accepted reload with failed confirmation as unconfirmed without an index claim or retry", async () => {
  const testCase = fixture({ fetchResponses: [response(200, health()), response(200, { reload: "accepted" }), response(200, { ok: true, notes: "invalid", visible_notes: 260 })] });

  const result = await runRefresh(testCase.options, testCase.dependencies);

  assert.deepEqual(result, { ok: false, stage: "health confirmation" });
  assert.equal(testCase.trace.filter((call) => call === "POST /internal/reload").length, 1);
  assert.equal(testCase.trace.filter((call) => call.startsWith("GET")).length, 2);
  assert.match(testCase.output.join("\n"), /unconfirmed/i);
  assert.match(testCase.output.join("\n"), /manual.*health/i);
  assert.doesNotMatch(testCase.output.join("\n"), /prior in-memory index remains active/i);
  assertSafeDiagnostics(testCase.output);
});

test("confirms refresh in one ordered, concise revision and health summary", async () => {
  const testCase = fixture({
    commandOutput: (call) => call.endsWith("rev-parse HEAD") ? { stdout: "abc123\n" } : undefined,
    fetchResponses: [response(200, health(275, 260)), response(200, { arbitrary: "untrusted reload response" }), response(200, health(276, 261))],
  });

  const result = await runRefresh(testCase.options, testCase.dependencies);

  assert.deepEqual(result, { ok: true, revision: "abc123", before: health(275, 260), after: health(276, 261) });
  assert.deepEqual(testCase.trace, [
    "git -C /fixture/content status --porcelain",
    "git -C /fixture/content pull --ff-only",
    "git -C /fixture/content rev-parse HEAD",
    `${process.execPath} ${require("node:path").join(__dirname, "../../pipeline/verify.cjs")}`,
    "GET /health",
    "POST /internal/reload",
    "GET /health",
  ]);
  assert.equal(testCase.output.length, 1);
  const reloadRequest = testCase.requests.find((request) => request.init.method === "POST");
  assert.equal(reloadRequest.url.pathname, "/internal/reload");
  assert.equal(reloadRequest.init.headers.authorization, AUTHORIZATION);
  assert.match(testCase.output[0], /revision abc123/);
  assert.match(testCase.output[0], /verification passed/);
  assert.match(testCase.output[0], /before notes=275 visible_notes=260/);
  assert.match(testCase.output[0], /after notes=276 visible_notes=261/);
  assertSafeDiagnostics(testCase.output);
});
