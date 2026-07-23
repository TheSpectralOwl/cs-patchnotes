#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const CONVERTER_VERSION = 6;
const DEFAULT_CONTENT_DIR = path.resolve(__dirname, "..", "..", "cs-patchnotes-content");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

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

function renderNote(raw, body) {
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(raw.title)}`,
    `date: ${raw.date}`,
    `game: ${raw.game}`,
    `content_kind: ${raw.content_kind}`,
    `body_format: ${raw.body_format}`,
    `steam_gid: ${JSON.stringify(raw.gid)}`,
    `source_url: ${JSON.stringify(raw.source_url)}`,
    `source_sha256: ${JSON.stringify(raw.body_sha256)}`,
    `converter_version: ${CONVERTER_VERSION}`,
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

function loadRawRecords(contentDir) {
  const rawDir = path.join(contentDir, "raw", "steam");
  return fs
    .readdirSync(rawDir)
    .filter((filename) => filename.endsWith(".json"))
    .sort()
    .map((filename) => JSON.parse(fs.readFileSync(path.join(rawDir, filename), "utf8")));
}

function writeIfChanged(filename, contents) {
  if (fs.existsSync(filename) && fs.readFileSync(filename, "utf8") === contents) {
    return false;
  }
  fs.writeFileSync(filename, contents);
  return true;
}

function convertAll(contentDir = process.env.CONTENT_DIR || DEFAULT_CONTENT_DIR) {
  const notesDir = path.join(contentDir, "content", "notes");
  const overridesDir = path.join(contentDir, "overrides");
  fs.mkdirSync(notesDir, { recursive: true });

  const records = loadRawRecords(contentDir);
  const filenameCounts = new Map();
  for (const raw of records) {
    const filename = noteFilename(raw);
    filenameCounts.set(filename, (filenameCounts.get(filename) || 0) + 1);
  }

  const summary = { created: 0, regenerated: 0, unchanged: 0, preserved: 0, overridden: 0, conflicts: [] };
  for (const raw of records) {
    const filename = noteFilename(raw, filenameCounts.get(noteFilename(raw)) > 1);

    const target = path.join(notesDir, filename);
    const override = path.join(overridesDir, `${raw.gid}.md`);
    if (fs.existsSync(override)) {
      if (writeIfChanged(target, fs.readFileSync(override, "utf8"))) {
        summary.overridden++;
      } else {
        summary.unchanged++;
      }
      continue;
    }

    const body = generatedBody(raw);
    const generated = renderNote(raw, body);
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, generated);
      summary.created++;
      continue;
    }

    const current = parseNote(fs.readFileSync(target, "utf8"));
    const oldGeneratedHash = current.frontmatter.generated_sha256;
    const currentHash = current.body === null ? null : sha256(current.body);
    if (currentHash === oldGeneratedHash) {
      if (writeIfChanged(target, generated)) {
        summary.regenerated++;
      } else {
        summary.unchanged++;
      }
      continue;
    }

    const newGeneratedHash = sha256(body);
    if (newGeneratedHash === oldGeneratedHash) {
      summary.preserved++;
      continue;
    }

    writeIfChanged(`${target}.new`, generated);
    summary.conflicts.push({ note: target, proposed: `${target}.new` });
  }

  return summary;
}

if (require.main === module) {
  const summary = convertAll();
  console.log(JSON.stringify(summary, null, 2));
  if (summary.conflicts.length > 0) {
    console.error("REGEN-REVIEW:");
    for (const conflict of summary.conflicts) {
      console.error(`- ${conflict.note} -> ${conflict.proposed}`);
    }
    process.exitCode = 1;
  }
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
