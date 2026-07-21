import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  getCurrentSourceRecord,
  getDocumentByExternalIdentifier,
  openDb,
  STEAM_GID_NAMESPACE,
} from "@cs-patchnotes/shared";
import {
  isPatchNote,
  channelForItem,
  assertReceivedAll,
  upsertUpdates,
  gameForDate,
  type SteamNewsItem,
} from "../src/poll.js";
import { DENY_LIST } from "../src/overrides.js";

function loadFixture(name: string): SteamNewsItem {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as SteamNewsItem;
}

const cs2 = loadFixture("cs2-multi-section.json");
const workshop = loadFixture("cs2-image-heavy.json");
const marketing = loadFixture("marketing-post.json");

/** Build a minimal Valve-community-announcement item for filter tests. */
function item(overrides: Partial<SteamNewsItem>): SteamNewsItem {
  return {
    gid: "test-gid",
    title: "Untitled",
    url: "https://example.invalid/post",
    feed_type: 1,
    feedname: "steam_community_announcements",
    date: 1_700_000_000,
    contents: "body",
    ...overrides,
  };
}

function rowCount(db: ReturnType<typeof openDb>, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

test("isPatchNote accepts a real CS2 Update post", () => {
  expect(isPatchNote(cs2)).toBe(true);
});

test("isPatchNote accepts each per-era title pattern", () => {
  // CS:GO "Release Notes for <date>"
  expect(isPatchNote(item({ title: "Release Notes for 6/4/2014" }))).toBe(true);
  // CS:GO singular "Release Note for <date>" (Valve uses the singular too)
  expect(isPatchNote(item({ title: "Release Note for 3/8/2024" }))).toBe(true);
  // CS:GO major update headline
  expect(
    isPatchNote(item({ title: "Counter-Strike: Global Offensive Update Released" })),
  ).toBe(true);
});

test("isPatchNote rejects the marketing post even though it carries the patchnotes tag", () => {
  // Live data proves marketing carries feed_type 1 + steam_community_announcements + patchnotes.
  expect((marketing.tags ?? []).includes("patchnotes")).toBe(true);
  expect(isPatchNote(marketing)).toBe(false);
});

test("isPatchNote rejects a third-party (feed_type 0) item at stage 1", () => {
  const thirdParty = item({ title: "Release Notes for 6/4/2014", feed_type: 0 });
  expect(isPatchNote(thirdParty)).toBe(false);
});

test("isPatchNote rejects a same-source post whose title matches no era pattern", () => {
  // Stage-1 passes (feed_type 1, steam_community_announcements) but no title pattern matches.
  expect(workshop.feed_type).toBe(1);
  expect(workshop.feedname).toBe("steam_community_announcements");
  expect(isPatchNote(workshop)).toBe(false);
});

test("isPatchNote accepts an off-title allow-listed gid regardless of body shape", () => {
  // gid 1813041031352604 is the human-audited CS2 Pre-Release Update (beta).
  const offTitle = item({
    gid: "1813041031352604",
    title: "Counter-Strike 2 Pre-Release Update",
    contents: "no bracket headers, no bullets",
  });
  expect(isPatchNote(offTitle)).toBe(true);
});

test("isPatchNote rejects a deny-listed gid even when its title matches", () => {
  const gid = "deny-me-gid";
  const titleMatched = item({ gid, title: "Counter-Strike 2 Update" });
  // Sanity: without the deny-list entry it would be accepted.
  expect(isPatchNote(titleMatched)).toBe(true);

  const mutableDeny = DENY_LIST as Set<string>;
  mutableDeny.add(gid);
  try {
    expect(isPatchNote(titleMatched)).toBe(false);
  } finally {
    mutableDeny.delete(gid); // keep the shared deny-list pristine for other tests
  }
});

test("channelForItem returns the allow-list channel, else mainline", () => {
  const preRelease = item({ gid: "1813041031352604", title: "Counter-Strike 2 Pre-Release Update" });
  expect(channelForItem(preRelease)).toBe("beta");
  // A plain title-matched CS2 Update defaults to mainline.
  expect(channelForItem(cs2)).toBe("mainline");
});

test("assertReceivedAll returns for equal counts and throws for unequal", () => {
  expect(() => assertReceivedAll(10, 10)).not.toThrow();
  expect(() => assertReceivedAll(9, 10)).toThrow();
});

test("game is derived from posted_at against the 2023-09-27 CS2 cutover", () => {
  expect(gameForDate(cs2.date)).toBe("cs2");
  // 2023-09-27T00:00:00Z is the cutover; the day before is csgo.
  const dayBefore = Date.UTC(2023, 8, 26) / 1000;
  expect(gameForDate(dayBefore)).toBe("csgo");
});

test("upsert writes only accepted notes to canonical identity and pristine current source", () => {
  const db = openDb(":memory:");
  const preRelease = item({
    gid: "1813041031352604",
    title: "Counter-Strike 2 Pre-Release Update",
    contents: "beta body",
    date: cs2.date,
  });
  const feed = [marketing, cs2, workshop, preRelease];

  const acceptedFirst = upsertUpdates(db, feed);
  expect(acceptedFirst).toBe(2); // CS2 Update (title) + Pre-Release (allow-list)
  expect(rowCount(db, "documents")).toBe(2);

  const firstDocument = getDocumentByExternalIdentifier(db, STEAM_GID_NAMESPACE, cs2.gid)!;
  const firstSource = getCurrentSourceRecord(db, firstDocument.id, "steam_news")!;

  // Second run over the same feed must reuse canonical identity and the exact source revision.
  const acceptedSecond = upsertUpdates(db, feed);
  expect(acceptedSecond).toBe(2);
  expect(rowCount(db, "documents")).toBe(2);
  expect(rowCount(db, "source_records")).toBe(2);
  const stored = getDocumentByExternalIdentifier(db, STEAM_GID_NAMESPACE, cs2.gid)!;
  const storedSource = getCurrentSourceRecord(db, stored.id, "steam_news")!;
  expect(stored.id).toBe(firstDocument.id);
  expect(storedSource.id).toBe(firstSource.id);
  expect(storedSource.pristine_body).toBe(cs2.contents);
  expect(stored.game).toBe("cs2");
  expect(stored.title).toBe(cs2.title);
  expect(stored.channel).toBe("mainline");

  const storedBeta = getDocumentByExternalIdentifier(
    db,
    STEAM_GID_NAMESPACE,
    "1813041031352604",
  )!;
  expect(storedBeta.channel).toBe("beta");
  expect(
    db.prepare("SELECT count(*) FROM source_locators").pluck().get(),
  ).toBe(2);

  for (const table of [
    "document_parse_state",
    "blocks",
    "search_fragments",
    "parse_diagnostics",
    "fragment_tags",
  ]) {
    expect(rowCount(db, table)).toBe(0);
  }

  db.close();
});

test("changed Steam bytes append immutable history and move only the explicit source head", () => {
  const db = openDb(":memory:");
  const original = item({
    gid: "changed-body-gid",
    title: "Counter-Strike 2 Update",
    url: "https://example.invalid/changed-body-gid",
    contents: "first exact body 🧪",
  });
  const changed = { ...original, contents: `${original.contents}\nsecond exact body` };

  upsertUpdates(db, [original]);
  const document = getDocumentByExternalIdentifier(db, STEAM_GID_NAMESPACE, original.gid)!;
  const first = getCurrentSourceRecord(db, document.id, "steam_news")!;
  upsertUpdates(db, [changed]);
  const current = getCurrentSourceRecord(db, document.id, "steam_news")!;

  expect(current.id).not.toBe(first.id);
  expect(current.pristine_body).toBe(changed.contents);
  expect(current.supersedes_source_record_id).toBe(first.id);
  expect(
    db.prepare("SELECT pristine_body FROM source_records WHERE id = ?").pluck().get(first.id),
  ).toBe(original.contents);
  expect(rowCount(db, "source_records")).toBe(2);
  expect(rowCount(db, "documents")).toBe(1);
  db.close();
});

test("similar title and date with distinct GIDs remain distinct documents", () => {
  const db = openDb(":memory:");
  const first = item({
    gid: "similar-a",
    title: "Counter-Strike 2 Update",
    url: "https://example.invalid/similar-a",
    contents: "same body",
  });
  const second = { ...first, gid: "similar-b", url: "https://example.invalid/similar-b" };
  expect(upsertUpdates(db, [first, second])).toBe(2);
  expect(rowCount(db, "documents")).toBe(2);
  expect(
    getDocumentByExternalIdentifier(db, STEAM_GID_NAMESPACE, first.gid)?.id,
  ).not.toBe(getDocumentByExternalIdentifier(db, STEAM_GID_NAMESPACE, second.gid)?.id);
  db.close();
});
