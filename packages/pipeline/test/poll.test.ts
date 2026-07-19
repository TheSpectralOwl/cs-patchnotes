import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb, type UpdateRow } from "@cs-patchnotes/shared";
import {
  isCs2PatchNote,
  upsertUpdates,
  gameForDate,
  type SteamNewsItem,
} from "../src/poll.js";

function loadFixture(name: string): SteamNewsItem {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as SteamNewsItem;
}

const cs2 = loadFixture("cs2-multi-section.json");
const workshop = loadFixture("cs2-image-heavy.json");
const marketing = loadFixture("marketing-post.json");

function rowCount(db: ReturnType<typeof openDb>): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM updates").get() as { n: number }).n;
}

test("isCs2PatchNote accepts a real CS2 Update post", () => {
  expect(isCs2PatchNote(cs2)).toBe(true);
});

test("isCs2PatchNote rejects the marketing post even though it carries the patchnotes tag", () => {
  // Live data proves marketing carries feed_type 1 + steam_community_announcements + patchnotes.
  expect((marketing.tags ?? []).includes("patchnotes")).toBe(true);
  expect(isCs2PatchNote(marketing)).toBe(false);
});

test("isCs2PatchNote rejects a same-source post whose title is not the CS2 Update pattern", () => {
  // Stage-1 passes (feed_type 1, steam_community_announcements) but stage-2 title filter rejects it.
  expect(workshop.feed_type).toBe(1);
  expect(workshop.feedname).toBe("steam_community_announcements");
  expect(isCs2PatchNote(workshop)).toBe(false);
});

test("game is derived from posted_at against the 2023-09-27 CS2 cutover", () => {
  expect(gameForDate(cs2.date)).toBe("cs2");
  // 2023-09-27T00:00:00Z is the cutover; the day before is csgo.
  const dayBefore = Date.UTC(2023, 8, 26) / 1000;
  expect(gameForDate(dayBefore)).toBe("csgo");
});

test("upsert stores only accepted notes, is idempotent by gid, and keeps raw_body pristine", () => {
  const db = openDb(":memory:");
  const feed = [marketing, cs2, workshop];

  const acceptedFirst = upsertUpdates(db, feed);
  expect(acceptedFirst).toBe(1); // only the CS2 Update passes the two-stage filter
  expect(rowCount(db)).toBe(1);

  // Second run over the same feed must not create duplicates (upsert on gid).
  const acceptedSecond = upsertUpdates(db, feed);
  expect(acceptedSecond).toBe(1);
  expect(rowCount(db)).toBe(1);

  const stored = db
    .prepare("SELECT * FROM updates WHERE id = ?")
    .get(cs2.gid) as UpdateRow;

  // raw_body is byte-for-byte the fixture contents (pristine source of truth).
  expect(stored.raw_body).toBe(cs2.contents);
  expect(stored.id).toBe(cs2.gid);
  expect(stored.game).toBe("cs2");
  expect(stored.title).toBe(cs2.title);

  db.close();
});
