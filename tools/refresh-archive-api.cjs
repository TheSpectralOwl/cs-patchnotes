#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const CONNECTION_CODES = new Set(["EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT"]);

function defaultRunCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    ...options,
  });
  if (result.error || result.status !== 0) throw new Error("command failed");
  return result;
}

function safeConnectionCode(error) {
  return error && CONNECTION_CODES.has(error.code) ? error.code : "connection error";
}

function validHealth(value) {
  return value
    && typeof value === "object"
    && value.ok === true
    && Number.isFinite(value.notes)
    && Number.isFinite(value.visible_notes)
    && value.notes >= 0
    && value.visible_notes >= 0;
}

async function requestHealth(fetch, apiUrl) {
  try {
    const response = await fetch(new URL("/health", apiUrl));
    if (!response?.ok) return { ok: false, context: `HTTP ${Number.isInteger(response?.status) ? response.status : "error"}` };
    const body = await response.json();
    return validHealth(body)
      ? { ok: true, health: { ok: true, notes: body.notes, visible_notes: body.visible_notes } }
      : { ok: false, context: "invalid health response" };
  } catch (error) {
    return { ok: false, context: safeConnectionCode(error) };
  }
}

function refreshOptions(options) {
  const { contentDir, apiUrl, reloadToken } = options;
  if (!contentDir || !apiUrl || !reloadToken) return undefined;
  try {
    return { contentDir, apiUrl: new URL(apiUrl).toString(), reloadToken };
  } catch {
    return undefined;
  }
}

function failure(write, stage, detail, action) {
  write(`${stage}: ${detail}. ${action}`);
  return { ok: false, stage };
}

async function runRefresh(options = {}, dependencies = {}) {
  const config = refreshOptions(options);
  const runCommand = dependencies.runCommand || defaultRunCommand;
  const fetch = dependencies.fetch || globalThis.fetch;
  const write = dependencies.write || console.log;

  if (!config || typeof fetch !== "function") {
    return failure(write, "preflight", "ARCHIVE_API_URL, CONTENT_DIR, and RELOAD_TOKEN must be configured", "Set the required refresh configuration and retry manually");
  }

  let status;
  try {
    status = runCommand("git", ["-C", config.contentDir, "status", "--porcelain"]);
  } catch {
    return failure(write, "preflight", "content checkout status could not be read", "Inspect the content checkout and resolve it manually");
  }
  if (String(status?.stdout || "").trim()) {
    return failure(write, "preflight", "content checkout is dirty", "Resolve the checkout changes before retrying");
  }

  try {
    runCommand("git", ["-C", config.contentDir, "pull", "--ff-only"]);
  } catch {
    return failure(write, "Git fast-forward", "content checkout could not fast-forward", "Reconcile the checkout history manually before retrying");
  }

  let revision;
  try {
    revision = String(runCommand("git", ["-C", config.contentDir, "rev-parse", "HEAD"]).stdout || "").trim();
  } catch {
    return failure(write, "Git fast-forward", "post-pull revision could not be read", "Inspect the content checkout manually before retrying");
  }

  try {
    runCommand(process.execPath, [path.join(__dirname, "..", "pipeline", "verify.cjs")], {
      env: { ...process.env, CONTENT_DIR: config.contentDir },
    });
  } catch {
    return failure(write, "verification", "candidate corpus verification failed", "Inspect the candidate checkout before retrying");
  }

  const before = await requestHealth(fetch, config.apiUrl);
  if (!before.ok) {
    return failure(write, "health confirmation", `baseline health check failed (${before.context})`, "Run the API health check manually before retrying");
  }

  try {
    const response = await fetch(new URL("/internal/reload", config.apiUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${config.reloadToken}` },
    });
    if (!response?.ok) {
      return failure(write, "reload", `reload request was rejected (HTTP ${Number.isInteger(response?.status) ? response.status : "error"})`, "Check API reload credentials and connectivity manually; the prior in-memory index remains active");
    }
  } catch (error) {
    return failure(write, "reload", `reload request was unreachable (${safeConnectionCode(error)})`, "Check API reload credentials and connectivity manually; the prior in-memory index remains active");
  }

  const after = await requestHealth(fetch, config.apiUrl);
  if (!after.ok) {
    return failure(write, "health confirmation", `refresh is unconfirmed (${after.context})`, "Manually run the API health check before further operation");
  }

  write(`refresh confirmed: revision ${revision}; verification passed; before notes=${before.health.notes} visible_notes=${before.health.visible_notes}; after notes=${after.health.notes} visible_notes=${after.health.visible_notes}`);
  return { ok: true, revision, before: before.health, after: after.health };
}

if (require.main === module) {
  const contentDir = path.resolve(process.env.CONTENT_DIR || path.join(__dirname, "..", "..", "cs-patchnotes-content"));
  runRefresh({ contentDir, apiUrl: process.env.ARCHIVE_API_URL, reloadToken: process.env.RELOAD_TOKEN }).then((result) => {
    if (!result.ok) process.exitCode = 1;
  }).catch(() => {
    console.error("refresh failed: unexpected failure. Inspect the refresh environment and retry manually.");
    process.exitCode = 1;
  });
}

module.exports = { runRefresh };
