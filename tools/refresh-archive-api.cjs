#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const CONTENT_DIR = path.resolve(process.env.CONTENT_DIR || path.join(__dirname, "..", "..", "cs-patchnotes-content"));
const API_URL = process.env.ARCHIVE_API_URL;
const RELOAD_TOKEN = process.env.RELOAD_TOKEN;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
}

async function main() {
  if (!API_URL || !RELOAD_TOKEN) throw new Error("ARCHIVE_API_URL and RELOAD_TOKEN are required");
  run("git", ["-C", CONTENT_DIR, "pull", "--ff-only"]);
  run(process.execPath, [path.join(__dirname, "..", "pipeline", "verify.cjs")], {
    env: { ...process.env, CONTENT_DIR },
  });
  const response = await fetch(new URL("/internal/reload", API_URL), {
    method: "POST",
    headers: { authorization: `Bearer ${RELOAD_TOKEN}` },
  });
  if (!response.ok) throw new Error(`Archive API reload failed: ${response.status} ${response.statusText}`);
  console.log(await response.text());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
