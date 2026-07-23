#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CONTENT_REPOSITORY = process.env.CONTENT_REPOSITORY || "https://github.com/TheSpectralOwl/cs-patchnotes-content.git";
const CONTENT_REF = process.env.CONTENT_REF || "main";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
}

function buildCloudflare() {
  let contentDir = process.env.CONTENT_DIR;
  let temporaryDir;
  try {
    if (!contentDir) {
      temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-patchnotes-content-"));
      contentDir = path.join(temporaryDir, "content");
      run("git", ["clone", "--depth", "1", "--branch", CONTENT_REF, CONTENT_REPOSITORY, contentDir]);
    }
    run("npm", ["run", "build", "-w", "@cs-patchnotes/archive"], {
      env: { ...process.env, CONTENT_DIR: path.resolve(contentDir) },
    });
  } finally {
    if (temporaryDir) fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

if (require.main === module) buildCloudflare();

module.exports = { buildCloudflare };
