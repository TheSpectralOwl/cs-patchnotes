#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { assertNoSymlinks } = require("./corpus.cjs");
const {
  noteRevisionDirectory,
  rawRevisionDirectory,
  readNoteLayouts,
  readRawLayouts,
  resolveContainedPath,
  revisionFilename,
  sha256,
} = require("./revision-layout.cjs");

const CONVERTER_VERSION = 6;
const DEFAULT_CONTENT_DIR = path.resolve(__dirname, "..", "..", "cs-patchnotes-content-v2");

function decodeEntities(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    }
    if (lower.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    }
    return named[lower] || match;
  });
}

function titleCaseSection(name) {
  return name
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((word) => {
      const letters = word.replace(/[^A-Za-z]/g, "");
      if (
        letters.length > 0 &&
        letters === letters.toUpperCase() &&
        (letters.length <= 3 || letters === "CSGO" || word === "CS:GO")
      ) {
        return word;
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

function normalizeBullet(line) {
  const withoutTrailingWhitespace = line.trimEnd();
  if (/^\s*---\s+/.test(withoutTrailingWhitespace)) {
    return withoutTrailingWhitespace.replace(/^\s*---\s+/, "    - ");
  }
  if (/^\s*--\s+/.test(withoutTrailingWhitespace)) {
    return withoutTrailingWhitespace.replace(/^\s*--\s+/, "  - ");
  }
  if (/^\s*-\s+/.test(withoutTrailingWhitespace)) {
    return withoutTrailingWhitespace.replace(/^\s*-\s+/, "- ");
  }
  return withoutTrailingWhitespace.trim();
}

function toMarkdown(body) {
  let output = body.replace(/\r\n?/g, "\n");
  output = output.replace(/\\(?=[\[\]])/g, "");
  output = output.replace(/\{STEAM_CLAN_IMAGE\}/g, "https://clan.cloudflare.steamstatic.com/images");

  output = output.replace(/\[img=([^\]]+)\]\s*\[\/img\]/gi, (_match, source) => `![](${source.trim().replace(/^["']|["']$/g, "")})`);
  output = output.replace(/\[img\]([^\[]+?)\[\/img\]/gi, (_match, source) => `![](${source.trim()})`);
  output = output.replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi, (_match, href, text) => {
    const label = text.trim();
    const url = href.trim().replace(/^["']|["']$/g, "");
    return label ? `[${label}](${url})` : `<${url}>`;
  });
  output = output.replace(/\[url\]([\s\S]*?)\[\/url\]/gi, (_match, href) => `<${href.trim()}>`);

  output = output.replace(/\[h([1-3])\]([\s\S]*?)\[\/h\1\]/gi, (_match, level, text) => {
    return `\n${"#".repeat(Number(level))} ${text.trim()}\n`;
  });
  output = output.replace(/\[\/p\]|\[p(?:[ \t][^\]]*|=[^\]]*)?\]/gi, "\n");
  output = output.replace(/\[b\]([\s\S]*?)\[\/b\]/gi, (_match, text) => `**${text.trim()}**`);
  output = output.replace(/\[i\]([\s\S]*?)\[\/i\]/gi, (_match, text) => `*${text.trim()}*`);
  output = output.replace(/\[u\]([\s\S]*?)\[\/u\]/gi, (_match, text) => text.trim());

  output = output.replace(
    /^[ \t]*\[[ \t]*([A-Z0-9][A-Z0-9 &:/'\-.]*?)[ \t]*\][ \t]*(?:\[list\])?[ \t]*$/gm,
    (_match, section) => `\n## ${titleCaseSection(section)}\n\n`,
  );
  output = output.replace(/\[\/?list\]/gi, "\n");
  output = output.replace(/^\s*\[\*\]\s?/gim, "- ");
  output = output.replace(/\[\/?\*\]/g, "");
  output = output.replace(/^\s*Release Notes for .+$/gim, "");
  output = output.replace(/\[\/?[a-z][a-z0-9]*(?:=[^\]]+)?\]/gi, "");
  output = decodeEntities(output);

  output = output
    .split("\n")
    .map(normalizeBullet)
    .join("\n")
    .replace(/^(#{1,6} .+)\n(?!\n)/gm, "$1\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return output ? `${output}\n` : "";
}

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "note";
}

function noteFilename(raw, disambiguate = false) {
  const suffix = disambiguate ? `-${raw.gid}` : "";
  return `${raw.date}-${slugify(raw.title)}${suffix}.md`;
}

function generatedBody(raw) {
  return `# ${raw.title}\n\n${toMarkdown(raw.body)}`;
}

function renderNote(raw, body, sourceRevision) {
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(raw.title)}`,
    `date: ${JSON.stringify(raw.date)}`,
    `game: ${JSON.stringify(raw.game)}`,
    `content_kind: ${JSON.stringify(raw.content_kind)}`,
    `body_format: ${JSON.stringify(raw.body_format)}`,
    `steam_gid: ${JSON.stringify(raw.gid)}`,
    `source_url: ${JSON.stringify(raw.source_url)}`,
    `source_sha256: ${JSON.stringify(raw.body_sha256)}`,
    ...(sourceRevision ? [`source_revision: ${JSON.stringify(sourceRevision)}`] : []),
    `converter_version: ${JSON.stringify(CONVERTER_VERSION)}`,
    `generated_sha256: ${JSON.stringify(sha256(body))}`,
    "---",
    "",
  ];
  return `${frontmatter.join("\n")}${body}`;
}

function parseNote(contents) {
  const match = contents.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: null };
  }

  const frontmatter = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(": ");
    if (separator === -1) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 2);
    try {
      frontmatter[key] = JSON.parse(value);
    } catch {
      frontmatter[key] = value;
    }
  }
  return { frontmatter, body: match[2] };
}

function convertAll(contentDir = process.env.CONTENT_DIR || DEFAULT_CONTENT_DIR) {
  assertNoSymlinks(contentDir);
  fs.mkdirSync(path.join(contentDir, "raw", "steam"), { recursive: true });
  fs.mkdirSync(path.join(contentDir, "content", "notes"), { recursive: true });
  const raws = readRawLayouts(contentDir);
  const notes = readNoteLayouts(contentDir, raws, { allowMissing: true, allowStaleLatest: true });
  const usedNoteIds = new Set([...notes.values()].map((layout) => layout.manifest.note_id));
  const summary = { created: 0, unchanged: 0, manifests_updated: 0 };
  for (const [gid, rawLayout] of raws) {
    const revision = rawLayout.manifest.latest_revision;
    const raw = rawLayout.revisions.get(revision).raw;
    let noteLayout = notes.get(gid);
    let manifest;
    if (noteLayout) {
      manifest = { ...noteLayout.manifest, revisions: [...noteLayout.manifest.revisions] };
    } else {
      const ordinaryId = noteFilename(raw);
      const noteId = usedNoteIds.has(ordinaryId) ? noteFilename(raw, true) : ordinaryId;
      if (usedNoteIds.has(noteId)) throw new Error(`Cannot assign a unique public note ID for ${gid}`);
      usedNoteIds.add(noteId);
      manifest = {
        gid,
        note_id: noteId,
        legacy_filename: noteId,
        latest_revision: revision,
        revisions: [revision],
      };
      noteLayout = { directory: noteRevisionDirectory(contentDir, gid), manifest };
      fs.mkdirSync(noteLayout.directory);
    }
    const target = resolveContainedPath(noteLayout.directory, revisionFilename(revision, "md"));
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, renderNote(raw, generatedBody(raw), revision));
      summary.created++;
    } else {
      summary.unchanged++;
    }
    if (!manifest.revisions.includes(revision)) manifest.revisions.push(revision);
    if (manifest.latest_revision !== revision || !fs.existsSync(resolveContainedPath(noteLayout.directory, "index.json"))) {
      manifest.latest_revision = revision;
      fs.writeFileSync(resolveContainedPath(noteLayout.directory, "index.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      summary.manifests_updated++;
    }
  }
  return summary;
}

if (require.main === module) {
  const summary = convertAll();
  console.log(JSON.stringify(summary, null, 2));
}

module.exports = {
  CONVERTER_VERSION,
  convertAll,
  generatedBody,
  noteFilename,
  parseNote,
  renderNote,
  sha256,
  toMarkdown,
};
