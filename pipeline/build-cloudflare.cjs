#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
}

function buildCloudflare() {
  run("npm", ["run", "build", "-w", "@cs-patchnotes/archive"]);
}

if (require.main === module) buildCloudflare();

module.exports = { buildCloudflare };
