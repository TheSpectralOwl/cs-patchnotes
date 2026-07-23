const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("uses the archive Worker configuration and generated Start bundle", () => {
  const config = fs.readFileSync(path.join(__dirname, "../../wrangler.jsonc"), "utf8");
  const builder = fs.readFileSync(path.join(__dirname, "../build-cloudflare.cjs"), "utf8");
  assert.match(config, /"main": "packages\/archive\/dist\/server\/index\.js"/);
  assert.match(config, /"directory": "packages\/archive\/dist\/client"/);
  assert.match(config, /"no_bundle": true/);
  assert.match(config, /"nodejs_compat"/);
  assert.match(builder, /@cs-patchnotes\/archive/);
});
