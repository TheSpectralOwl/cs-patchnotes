#!/usr/bin/env node

// This module is the search-engine seam: it reads only Markdown notes and emits
// a disposable JSON index. A future engine replaces buildIndex/searchIndex, not
// the corpus format or callers.
const fs = require("node:fs");
const path = require("node:path");
const { parseNote } = require("./convert.cjs");

const DEFAULT_CONTENT_DIR = path.resolve(__dirname, "..", "..", "cs-patchnotes-content");
const DEFAULT_INDEX_PATH = path.resolve(__dirname, "..", ".cache", "notes-index.json");

function tokens(value) {
  return (value.toLowerCase().match(/[a-z0-9]+/g) || []);
}

function loadNotes(contentDir = process.env.CONTENT_DIR || DEFAULT_CONTENT_DIR) {
  const notesDir = path.join(contentDir, "content", "notes");
  return fs
    .readdirSync(notesDir)
    .filter((filename) => filename.endsWith(".md"))
    .sort()
    .map((filename) => {
      const { frontmatter, body } = parseNote(fs.readFileSync(path.join(notesDir, filename), "utf8"));
      if (body === null || !frontmatter.title || !frontmatter.date || !frontmatter.steam_gid) {
        throw new Error(`Invalid note frontmatter: ${filename}`);
      }
      return {
        id: filename,
        title: frontmatter.title,
        date: frontmatter.date,
        game: frontmatter.game,
        steam_gid: frontmatter.steam_gid,
        source_url: frontmatter.source_url,
        source_sha256: frontmatter.source_sha256,
        body,
      };
    });
}

function buildIndex(contentDir = process.env.CONTENT_DIR || DEFAULT_CONTENT_DIR, indexPath = DEFAULT_INDEX_PATH) {
  const documents = loadNotes(contentDir);
  const canonicalBySourceHash = new Map();
  for (const document of documents) {
    if (!document.source_sha256) continue;
    const canonical = canonicalBySourceHash.get(document.source_sha256);
    if (!canonical || document.steam_gid.localeCompare(canonical.steam_gid) < 0) {
      canonicalBySourceHash.set(document.source_sha256, document);
    }
  }
  for (const document of documents) {
    const canonical = document.source_sha256 && canonicalBySourceHash.get(document.source_sha256);
    if (canonical && canonical.id !== document.id) document.duplicate_of = canonical.id;
  }

  const terms = {};
  documents.forEach((document, documentId) => {
    const frequencies = new Map();
    for (const token of tokens(`${document.title}\n${document.body}`)) {
      frequencies.set(token, (frequencies.get(token) || 0) + 1);
    }
    for (const [token, count] of frequencies) {
      (terms[token] ||= []).push([documentId, count]);
    }
  });

  const index = { version: 1, documents, terms };
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, `${JSON.stringify(index)}\n`);
  return { documents: documents.length, terms: Object.keys(terms).length, indexPath };
}

function excerpt(body, queryTokens) {
  const lower = body.toLowerCase();
  const position = queryTokens.map((token) => lower.indexOf(token)).find((index) => index >= 0) ?? 0;
  const start = Math.max(0, position - 80);
  const end = Math.min(body.length, position + 180);
  return `${start > 0 ? "..." : ""}${body.slice(start, end).replace(/\s+/g, " ").trim()}${end < body.length ? "..." : ""}`;
}

function searchIndex(index, query, filters = {}) {
  const queryTokens = [...new Set(tokens(query))];
  const scores = new Map();
  for (const token of queryTokens) {
    for (const [documentId, count] of index.terms[token] || []) {
      scores.set(documentId, (scores.get(documentId) || 0) + count);
    }
  }

  return [...scores]
    .map(([documentId, score]) => ({ ...index.documents[documentId], score }))
    .filter((document) => !document.duplicate_of)
    .filter((document) => !filters.game || document.game === filters.game)
    .filter((document) => !filters.from || document.date >= filters.from)
    .filter((document) => !filters.to || document.date <= filters.to)
    .sort((left, right) => right.score - left.score || right.date.localeCompare(left.date) || left.id.localeCompare(right.id))
    .map((document) => ({ ...document, excerpt: excerpt(document.body, queryTokens) }));
}

function readIndex(indexPath = DEFAULT_INDEX_PATH) {
  return JSON.parse(fs.readFileSync(indexPath, "utf8"));
}

function usage() {
  console.error("Usage: node pipeline/search.cjs build | query <text> [--game csgo|cs2] [--from YYYY-MM-DD] [--to YYYY-MM-DD]");
}

if (require.main === module) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "build" && args.length === 0) {
    console.log(JSON.stringify(buildIndex(), null, 2));
  } else if (command === "query" && args.length > 0) {
    const filters = {};
    const words = [];
    for (let index = 0; index < args.length; index++) {
      if (["--game", "--from", "--to"].includes(args[index])) {
        filters[args[index].slice(2)] = args[++index];
      } else {
        words.push(args[index]);
      }
    }
    if (words.length === 0) {
      usage();
      process.exitCode = 1;
    } else {
      for (const result of searchIndex(readIndex(), words.join(" "), filters)) {
        console.log(`${result.date} | ${result.game} | ${result.title}`);
        console.log(`${result.excerpt}\n${result.source_url}\n`);
      }
    }
  } else {
    usage();
    process.exitCode = 1;
  }
}

module.exports = { buildIndex, loadNotes, readIndex, searchIndex };
