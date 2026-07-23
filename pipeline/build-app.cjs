#!/usr/bin/env node

const path = require("node:path");
const { buildIndex } = require("./search.cjs");

const APP_PUBLIC_DIR = path.resolve(__dirname, "..", "packages", "archive", "public");

function buildAppCorpus(contentDir = process.env.CONTENT_DIR, indexPath = path.join(APP_PUBLIC_DIR, "notes-index.json")) {
  return buildIndex(contentDir, indexPath);
}

if (require.main === module) {
  console.log(JSON.stringify(buildAppCorpus(), null, 2));
}

module.exports = { buildAppCorpus };
