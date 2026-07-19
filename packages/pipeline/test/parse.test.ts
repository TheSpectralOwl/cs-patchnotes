import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb, type LineRow, type SectionRow } from "@cs-patchnotes/shared";
import { parseCs2Body } from "../src/parse/bbcode.js";
import { parseStoredUpdates } from "../src/parse.js";

interface Fixture {
  gid: string;
  title: string;
  url: string;
  feedname: string;
  date: number;
  contents: string;
}

function loadFixture(name: string): Fixture {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Fixture;
}

const cs2 = loadFixture("cs2-multi-section.json");
const imageHeavy = loadFixture("cs2-image-heavy.json");

/** Anything that must NEVER survive into searchable line text. */
const FORBIDDEN =
  /\{STEAM_CLAN_IMAGE\}|steamstatic|\.png|\[\/?(?:img|url|p|list|h[1-6])\b|\[\*\]|\[\/\*\]/i;

function seedUpdate(db: ReturnType<typeof openDb>, fx: Fixture): void {
  db.prepare(
    `INSERT INTO updates (id, posted_at, title, url, feedname, game, raw_body, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET raw_body = excluded.raw_body`,
  ).run(fx.gid, fx.date, fx.title, fx.url, fx.feedname, "cs2", fx.contents, 0);
}

test("parseCs2Body splits a multi-section body into ordered sections with non-null headers", () => {
  const sections = parseCs2Body(cs2.contents);
  const headers = sections.map((s) => s.header).filter((h): h is string => h !== null);
  expect(headers.length).toBeGreaterThan(1);
  // Document order: the first bracket header in the body is PREMIER.
  expect(headers[0]).toBe("PREMIER");
  // Every non-null-header section carries at least one line.
  for (const s of sections) {
    if (s.header !== null) expect(s.lines.length).toBeGreaterThan(0);
  }
});

test("backslash-escaped headers are unescaped and detected as section boundaries", () => {
  const headers = parseCs2Body(cs2.contents).map((s) => s.header);
  // \[ MAPS ] in the raw body must surface as a MAPS section header.
  expect(headers).toContain("MAPS");
});

test("no image tokens, steamstatic URLs, .png, or residual BBCode survive into line text", () => {
  const db = openDb(":memory:");
  seedUpdate(db, cs2);
  seedUpdate(db, imageHeavy); // the {STEAM_CLAN_IMAGE}/[img]/.png stress fixture
  parseStoredUpdates(db);

  const lines = db.prepare("SELECT text FROM lines").all() as Pick<LineRow, "text">[];
  expect(lines.length).toBeGreaterThan(0);
  for (const { text } of lines) {
    expect(text).not.toMatch(FORBIDDEN);
  }
  db.close();
});

test("parsing is idempotent — identical section/line IDs and stable row counts on re-run", () => {
  const db = openDb(":memory:");
  seedUpdate(db, cs2);

  const first = parseStoredUpdates(db);
  const sectionsA = (db.prepare("SELECT id FROM sections ORDER BY id").all() as Pick<SectionRow, "id">[]).map((r) => r.id);
  const linesA = (db.prepare("SELECT id FROM lines ORDER BY id").all() as Pick<LineRow, "id">[]).map((r) => r.id);

  const second = parseStoredUpdates(db);
  const sectionsB = (db.prepare("SELECT id FROM sections ORDER BY id").all() as Pick<SectionRow, "id">[]).map((r) => r.id);
  const linesB = (db.prepare("SELECT id FROM lines ORDER BY id").all() as Pick<LineRow, "id">[]).map((r) => r.id);

  expect(second.sections).toBe(first.sections);
  expect(second.lines).toBe(first.lines);
  expect(sectionsB).toEqual(sectionsA);
  expect(linesB).toEqual(linesA);

  // IDs are structural ordinals anchored on gid: section 0 = "<gid>_0", line 0 = "<gid>_0_0".
  expect(sectionsA[0]).toBe(`${cs2.gid}_0`);
  expect(linesA).toContain(`${cs2.gid}_0_0`);
  db.close();
});
