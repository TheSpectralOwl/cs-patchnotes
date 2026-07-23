const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("uses the archive Worker configuration and public content repository", () => {
  const config = fs.readFileSync(path.join(__dirname, "../../wrangler.jsonc"), "utf8");
  const builder = fs.readFileSync(path.join(__dirname, "../build-cloudflare.cjs"), "utf8");
  assert.match(config, /"directory": "\.\/packages\/archive\/dist"/);
  assert.match(config, /"not_found_handling": "single-page-application"/);
  assert.match(builder, /TheSpectralOwl\/cs-patchnotes-content\.git/);
  assert.match(builder, /@cs-patchnotes\/archive/);
});
