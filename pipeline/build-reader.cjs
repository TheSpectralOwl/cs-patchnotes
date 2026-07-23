#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { buildIndex } = require("./search.cjs");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_OUTPUT_DIR = path.join(ROOT_DIR, ".cache", "reader");
const READER_SOURCE_DIR = path.join(ROOT_DIR, "reader");

function buildReader(contentDir = process.env.CONTENT_DIR, outputDir = DEFAULT_OUTPUT_DIR) {
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.cpSync(READER_SOURCE_DIR, outputDir, { recursive: true });
  const index = buildIndex(contentDir, path.join(outputDir, "notes-index.json"));
  return { outputDir, ...index };
}

if (require.main === module) {
  console.log(JSON.stringify(buildReader(), null, 2));
}

module.exports = { buildReader };
