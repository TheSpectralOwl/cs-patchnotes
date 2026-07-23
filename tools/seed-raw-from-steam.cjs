#!/usr/bin/env node

// Fetch the Steam News history into the content repository's immutable raw store.
// Steam payloads are preserved verbatim; only the surrounding metadata is derived.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const APP_ID = 730;
const PAGE_SIZE = 5000;
const CS2_CUTOVER = Date.UTC(2023, 8, 27) / 1000;
const CONTENT_DIR = path.resolve(
  process.env.CONTENT_DIR || path.join(__dirname, "..", "..", "cs-patchnotes-content"),
);
const RAW_DIR = path.join(CONTENT_DIR, "raw", "steam");
const dryRun = process.argv.slice(2).includes("--dry-run");

if (process.argv.slice(2).some((argument) => argument !== "--dry-run")) {
  throw new Error("Usage: node tools/seed-raw-from-steam.cjs [--dry-run]");
}

const TITLE_PATTERNS = [
  /^Counter-Strike 2 Update/,
  /^Release Notes? for \d/,
  /Counter-Strike: Global Offensive Update Released/,
];

const ALLOW_LIST = new Map([
  ["4026755437314208134", "mainline"],
  ["4093189347044611120", "mainline"],
  ["1813041031352604", "beta"],
  ["3879252510628624545", "mainline"],
  ["4090922416496931545", "mainline"],
  ["4048146376711756574", "store"],
  ["1010228711585010877", "mainline"],
]);
const DENY_LIST = new Set();

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function bodyFormatFor(contents) {
  return /\[\/?(?:p|list|\*|h[1-6]|img|url|b|i|u)\b|\{STEAM_CLAN_IMAGE\}/i.test(contents)
    ? "bbcode"
    : "plain_text";
}

function isPatchNote(item) {
  if (item.feed_type !== 1 || item.feedname !== "steam_community_announcements") {
    return false;
  }
  if (DENY_LIST.has(item.gid)) {
    return false;
  }
  return ALLOW_LIST.has(item.gid) || TITLE_PATTERNS.some((pattern) => pattern.test(item.title));
}

async function fetchPage(enddate) {
  const params = new URLSearchParams({
    appid: String(APP_ID),
    maxlength: "0",
    count: String(PAGE_SIZE),
  });
  if (enddate !== undefined) {
    params.set("enddate", String(enddate));
  }

  const response = await fetch(`https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?${params}`);
  if (!response.ok) {
    throw new Error(`Steam News fetch failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const appnews = data?.appnews;
  if (!appnews || !Array.isArray(appnews.newsitems)) {
    throw new Error("Steam News response did not include appnews.newsitems");
  }
  return appnews.newsitems;
}

async function fetchAllNews() {
  const records = new Map();
  let enddate;

  for (;;) {
    const page = await fetchPage(enddate);
    if (page.length === 0) {
      return records;
    }

    let added = 0;
    let oldest = Number.POSITIVE_INFINITY;
    for (const item of page) {
      oldest = Math.min(oldest, item.date);
      if (!records.has(item.gid)) {
        records.set(item.gid, item);
        added++;
      }
    }

    if (page.length < PAGE_SIZE) {
      return records;
    }
    if (!Number.isFinite(oldest) || added === 0) {
      throw new Error("Steam News pagination stalled before the feed was exhausted");
    }
    enddate = oldest;
  }
}

function toRawRecord(item) {
  return {
    gid: item.gid,
    source_adapter: "steam_news",
    content_kind: "patch_notes",
    title: item.title,
    posted_at: item.date,
    date: new Date(item.date * 1000).toISOString().slice(0, 10),
    game: item.date >= CS2_CUTOVER ? "cs2" : "csgo",
    channel: ALLOW_LIST.get(item.gid) || "mainline",
    body_format: bodyFormatFor(item.contents),
    source_url: item.url,
    body_sha256: sha256(item.contents),
    body: item.contents,
  };
}

async function main() {
  const allItems = await fetchAllNews();
  const accepted = [...allItems.values()].filter(isPatchNote).sort((a, b) => a.gid.localeCompare(b.gid));
  const counts = { fetched: allItems.size, accepted: accepted.length, existing: 0, written: 0, conflicts: 0 };

  if (!dryRun) {
    fs.mkdirSync(RAW_DIR, { recursive: true });
  }

  for (const item of accepted) {
    const filename = path.join(RAW_DIR, `${item.gid}.json`);
    const contents = `${JSON.stringify(toRawRecord(item), null, 2)}\n`;
    if (fs.existsSync(filename)) {
      if (fs.readFileSync(filename, "utf8") !== contents) {
        counts.conflicts++;
        console.error(`conflict: ${filename} differs from the current Steam payload`);
      } else {
        counts.existing++;
      }
      continue;
    }
    if (!dryRun) {
      fs.writeFileSync(filename, contents);
    }
    counts.written++;
  }

  console.log(JSON.stringify({ content_dir: CONTENT_DIR, dry_run: dryRun, ...counts }, null, 2));
  if (counts.conflicts > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = { fetchAllNews, isPatchNote, toRawRecord };
