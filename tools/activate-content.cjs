#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const CONNECTION_CODES = new Set(["EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT"]);
const DEFAULT_LOCK_STALE_MS = 30 * 60 * 1000;

function defaultRunCommand(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
  if (result.error || result.status !== 0) throw new Error("command failed");
  return result;
}

function readLockRecord(lock) {
  const lockStat = fs.lstatSync(lock);
  if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) throw new Error("activation lock is not a regular directory");
  const filename = path.join(lock, "owner.json");
  let owner;
  try {
    const ownerStat = fs.lstatSync(filename);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) throw new Error("not a regular file");
    const value = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (!value || typeof value !== "object" || typeof value.token !== "string" || typeof value.hostname !== "string"
      || !Number.isInteger(value.pid) || value.pid <= 0 || !Number.isFinite(value.started_at)) {
      throw new Error("invalid owner record");
    }
    owner = value;
  } catch (error) {
    if (error && error.code === "ENOENT") return { owner: undefined, startedAt: lockStat.mtimeMs };
    throw new Error("activation lock owner record is invalid");
  }
  return { owner, startedAt: owner.started_at };
}

function defaultOwnerAlive(owner) {
  if (owner.hostname !== os.hostname()) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return !(error && error.code === "ESRCH");
  }
}

function acquireActivationLock(revisionRoot, options = {}) {
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  if (!Number.isInteger(staleMs) || staleMs < 60_000) throw new Error("activation lock stale interval must be at least one minute");
  const now = options.now || Date.now;
  const ownerAlive = options.ownerAlive || defaultOwnerAlive;
  const owner = options.owner || {
    token: crypto.randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    started_at: now(),
  };
  if (!owner || typeof owner.token !== "string" || typeof owner.hostname !== "string" || !Number.isInteger(owner.pid) || owner.pid <= 0 || !Number.isFinite(owner.started_at)) {
    throw new Error("activation lock owner is invalid");
  }
  fs.mkdirSync(revisionRoot, { recursive: true });
  const lock = path.join(revisionRoot, ".activation-lock");
  for (;;) {
    try {
      fs.mkdirSync(lock);
      try {
        fs.writeFileSync(path.join(lock, "owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: "wx" });
      } catch (error) {
        fs.rmdirSync(lock);
        throw error;
      }
      return () => {
        let current;
        try {
          current = readLockRecord(lock).owner;
        } catch {
          return;
        }
        if (current?.token === owner.token) fs.rmSync(lock, { recursive: true, force: false });
      };
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
    }

    const record = readLockRecord(lock);
    const age = now() - record.startedAt;
    if (!record.owner) {
      if (age < staleMs) throw new Error("another activation is already running");
      throw new Error("activation lock has no owner record; inspect it manually after the stale interval");
    }
    if (age < staleMs) throw new Error("another activation is already running");
    if (ownerAlive(record.owner)) throw new Error("activation lock owner is still running");

    const retired = path.join(revisionRoot, `.activation-lock.stale-${owner.token}`);
    try {
      fs.renameSync(lock, retired);
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }
    fs.rmSync(retired, { recursive: true, force: false });
  }
}

function defaultAcquireLock(revisionRoot) {
  return acquireActivationLock(revisionRoot);
}

function defaultReadMarker(revisionRoot) {
  const marker = path.join(revisionRoot, "active");
  if (!fs.existsSync(marker)) throw new Error("active marker is missing; bootstrap the revision root before activation");
  const markerStat = fs.lstatSync(marker);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error("active marker must be a regular file");
  const sha = fs.readFileSync(marker, "utf8").trim();
  if (!GIT_SHA_PATTERN.test(sha)) throw new Error("active marker must contain one full lowercase Git SHA");
  return sha;
}

function defaultPublishMarker(revisionRoot, sha) {
  const temporary = path.join(revisionRoot, `.active-${process.pid}-${Date.now()}`);
  // The non-root API container must read the selected revision from this bind mount.
  fs.writeFileSync(temporary, `${sha}\n`, { mode: 0o644 });
  fs.renameSync(temporary, path.join(revisionRoot, "active"));
}

function activationOptions(options) {
  const { sha, revisionRoot, contentRepository, apiUrl, reloadToken } = options;
  if (!GIT_SHA_PATTERN.test(sha || "") || !revisionRoot || !contentRepository || !reloadToken) return undefined;
  try {
    const parsedApiUrl = new URL(apiUrl);
    if (parsedApiUrl.protocol !== "http:" && parsedApiUrl.protocol !== "https:") return undefined;
    return { sha, revisionRoot: path.resolve(revisionRoot), contentRepository: path.resolve(contentRepository), apiUrl: parsedApiUrl.toString(), reloadToken };
  } catch {
    return undefined;
  }
}

function connectionContext(error) {
  return error && CONNECTION_CODES.has(error.code) ? error.code : "connection error";
}

function validHealth(value, sha) {
  return value && typeof value === "object" && value.ok === true
    && Number.isFinite(value.notes) && Number.isFinite(value.visible_notes)
    && value.content_sha === sha;
}

async function requestHealth(fetch, apiUrl, sha) {
  try {
    const response = await fetch(new URL("/health", apiUrl));
    if (!response?.ok) return { ok: false, context: `HTTP ${Number.isInteger(response?.status) ? response.status : "error"}` };
    const body = await response.json();
    return validHealth(body, sha) ? { ok: true, health: body } : { ok: false, context: "active SHA was not confirmed by health" };
  } catch (error) {
    return { ok: false, context: connectionContext(error) };
  }
}

function fail(write, stage, detail) {
  write(`${stage}: ${detail}.`);
  return { ok: false, stage };
}

function candidateDirectory(config) {
  return path.join(config.revisionRoot, "worktrees", config.sha);
}

function ensureCandidate(config, dependencies) {
  const { runCommand } = dependencies;
  const candidate = candidateDirectory(config);
  fs.mkdirSync(path.dirname(candidate), { recursive: true });
  runCommand("git", ["-C", config.contentRepository, "fetch", "--quiet", "origin", config.sha]);
  runCommand("git", ["-C", config.contentRepository, "cat-file", "-e", `${config.sha}^{commit}`]);
  const resolved = String(runCommand("git", ["-C", config.contentRepository, "rev-parse", `${config.sha}^{commit}`]).stdout || "").trim();
  if (resolved !== config.sha) throw new Error("requested SHA did not resolve exactly");
  try {
    const current = String(runCommand("git", ["-C", candidate, "rev-parse", "HEAD"]).stdout || "").trim();
    if (current !== config.sha) throw new Error("existing candidate is not the requested SHA");
    const status = String(runCommand("git", ["-C", candidate, "status", "--porcelain"]).stdout || "").trim();
    if (status) throw new Error("existing candidate is dirty");
  } catch (error) {
    if (error && error.message !== "command failed") throw error;
    runCommand("git", ["-C", config.contentRepository, "worktree", "add", "--detach", candidate, config.sha]);
  }
  return candidate;
}

async function runActivation(options = {}, injected = {}) {
  const config = activationOptions(options);
  const dependencies = {
    runCommand: injected.runCommand || defaultRunCommand,
    fetch: injected.fetch || globalThis.fetch,
    write: injected.write || console.log,
    acquireLock: injected.acquireLock || defaultAcquireLock,
    readMarker: injected.readMarker || defaultReadMarker,
    publishMarker: injected.publishMarker || defaultPublishMarker,
  };
  if (!config || typeof dependencies.fetch !== "function") {
    return fail(dependencies.write, "preflight", "CONTENT_SHA, CONTENT_REVISION_ROOT, CONTENT_REPOSITORY_DIR, ARCHIVE_API_URL, and RELOAD_TOKEN must be configured with a full lowercase SHA");
  }

  let releaseLock;
  try {
    releaseLock = dependencies.acquireLock(config.revisionRoot);
  } catch (error) {
    return fail(dependencies.write, "preflight", error instanceof Error ? error.message : "activation lock could not be acquired");
  }

  try {
    let candidate;
    try {
      candidate = ensureCandidate(config, dependencies);
    } catch (error) {
      return fail(dependencies.write, "candidate", error instanceof Error ? error.message : "candidate could not be prepared");
    }

    try {
      dependencies.runCommand(process.execPath, [path.join(__dirname, "..", "pipeline", "verify.cjs")], {
        env: { ...process.env, CONTENT_DIR: candidate },
      });
    } catch {
      return fail(dependencies.write, "verification", "candidate corpus verification failed");
    }

    let previous;
    try {
      previous = dependencies.readMarker(config.revisionRoot);
      dependencies.publishMarker(config.revisionRoot, config.sha);
    } catch (error) {
      return fail(dependencies.write, "publication", error instanceof Error ? error.message : "active marker could not be published");
    }

    let reload;
    try {
      reload = await dependencies.fetch(new URL("/internal/reload", config.apiUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${config.reloadToken}`, "content-type": "application/json" },
        body: JSON.stringify({ sha: config.sha }),
      });
    } catch (error) {
      dependencies.write(`reload: candidate ${config.sha} remains selected but is unconfirmed (${connectionContext(error)}).`);
      return { ok: false, stage: "reload", unconfirmed: true, sha: config.sha };
    }
    if (!reload?.ok) {
      try {
        dependencies.publishMarker(config.revisionRoot, previous);
      } catch {
        return fail(dependencies.write, "reload", "reload was rejected and the previous active marker could not be restored");
      }
      return fail(dependencies.write, "reload", "reload was rejected and the previous active marker was restored");
    }

    const confirmation = await requestHealth(dependencies.fetch, config.apiUrl, config.sha);
    if (!confirmation.ok) {
      dependencies.write(`health confirmation: candidate ${config.sha} remains selected but is unconfirmed (${confirmation.context}).`);
      return { ok: false, stage: "health confirmation", unconfirmed: true, sha: config.sha };
    }
    dependencies.write(`activation confirmed: content SHA ${config.sha}; notes=${confirmation.health.notes} visible_notes=${confirmation.health.visible_notes}.`);
    return { ok: true, sha: config.sha, health: confirmation.health };
  } finally {
    releaseLock();
  }
}

if (require.main === module) {
  runActivation({
    sha: process.argv[2] || process.env.CONTENT_SHA,
    revisionRoot: process.env.CONTENT_REVISION_ROOT,
    contentRepository: process.env.CONTENT_REPOSITORY_DIR,
    apiUrl: process.env.ARCHIVE_API_URL,
    reloadToken: process.env.RELOAD_TOKEN,
  }).then((result) => {
    if (!result.ok) process.exitCode = 1;
  }).catch(() => {
    console.error("activation failed: unexpected failure.");
    process.exitCode = 1;
  });
}

module.exports = { DEFAULT_LOCK_STALE_MS, acquireActivationLock, runActivation };
