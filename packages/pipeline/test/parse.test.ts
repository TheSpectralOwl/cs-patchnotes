import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb, type LineRow, type SectionRow } from "@cs-patchnotes/shared";
import { parseCs2Body, parseBody } from "../src/parse/bbcode.js";
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

/**
 * Anything that must NEVER survive into searchable line text. The trailing
 * `|\[` catches ANY residual bracket — an unescaped `[ HEADER ]`, a stray
 * markup fragment, or a leftover `\[` — so no bracket of any kind leaks.
 */
const FORBIDDEN =
  /\{STEAM_CLAN_IMAGE\}|steamstatic|\.png|\[\/?(?:img|url|p|list|h[1-6])\b|\[\*\]|\[\/\*\]|\[/i;

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

test("the lines table carries the nullable nesting columns", () => {
  const db = openDb(":memory:");
  const cols = (db.prepare("PRAGMA table_info(lines)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain("subheader");
  expect(cols).toContain("parent_line_index");
  db.close();
});

test("nested bullets persist a non-null subheader + parent_line_index to SQLite", () => {
  const db = openDb(":memory:");
  seedUpdate(db, cs2);
  parseStoredUpdates(db);

  const linked = db
    .prepare("SELECT text, subheader, parent_line_index FROM lines WHERE subheader IS NOT NULL AND parent_line_index IS NOT NULL")
    .all() as Pick<LineRow, "text" | "subheader" | "parent_line_index">[];
  expect(linked.length).toBeGreaterThan(0);
  for (const row of linked) {
    expect(typeof row.subheader).toBe("string");
    expect(typeof row.parent_line_index).toBe("number");
  }
  db.close();
});

test("stored line text is the extracted cleaned string, never a stringified ParsedLine", () => {
  const db = openDb(":memory:");
  seedUpdate(db, cs2);
  parseStoredUpdates(db);

  const rows = db.prepare("SELECT text FROM lines").all() as Pick<LineRow, "text">[];
  expect(rows.length).toBeGreaterThan(0);
  // (a) every row is a real string and none is a stringified object
  for (const { text } of rows) {
    expect(typeof text).toBe("string");
    expect(text).not.toContain("[object Object]");
  }
  // (b) a specific known bullet's cleaned text matches exactly — proving `.text`
  //     was extracted, not the whole ParsedLine object.
  const texts = rows.map((r) => r.text);
  expect(texts).toContain("Premier Season Five has begun");
  db.close();
});

// ---------------------------------------------------------------------------
// Cross-era golden-file lock: real Valve notes frozen from the live feed, one
// per structural era plus edge cases. Each asserts STRUCTURAL counts (section
// count + per-section line counts), preserved nesting, and no-leak negatives —
// never a full-body snapshot, so minor Valve text edits can't make them brittle.
// ---------------------------------------------------------------------------

interface Golden {
  /** Fixture filename. */
  file: string;
  /** Expected number of parsed sections (document order). */
  sections: number;
  /** Expected line count per section, in document order. */
  lineCounts: number[];
}

/** Frozen structural expectations captured from the parser over each fixture. */
const GOLDEN: Golden[] = [
  { file: "csgo-2013-crlf.json", sections: 6, lineCounts: [1, 6, 3, 1, 3, 2] },
  { file: "csgo-2018-lf.json", sections: 6, lineCounts: [1, 2, 1, 3, 1, 39] },
  { file: "csgo-2021-lf.json", sections: 3, lineCounts: [4, 2, 2] },
  { file: "cs2-2023-richtext.json", sections: 8, lineCounts: [2, 15, 14, 10, 2, 4, 11, 3] },
  { file: "cs2-2026-richtext.json", sections: 10, lineCounts: [3, 1, 11, 5, 2, 1, 22, 5, 1, 9] },
  { file: "edge-headerless.json", sections: 1, lineCounts: [3] },
  { file: "edge-off-title-allowlisted.json", sections: 4, lineCounts: [2, 4, 19, 12] },
  { file: "edge-nested-map-subheader.json", sections: 3, lineCounts: [3, 8, 14] },
];

for (const g of GOLDEN) {
  test(`golden: ${g.file} parses into the expected section/line structure with no leaks`, () => {
    const fx = loadFixture(g.file);
    const sections = parseBody(fx.contents, fx.date);

    // Structural counts (D-14) — assert shape, not text blobs.
    expect(sections.length).toBe(g.sections);
    expect(sections.map((s) => s.lines.length)).toEqual(g.lineCounts);

    // Every titled section carries at least one line (nothing empty was kept).
    for (const s of sections) {
      if (s.header !== null) expect(s.lines.length).toBeGreaterThan(0);
    }

    // No-leak negatives + positive stored-text: every produced line is a real,
    // non-empty string, carries no residual markup/image/bracket, and is never
    // a stringified ParsedLine object.
    for (const s of sections) {
      for (const line of s.lines) {
        expect(typeof line.text).toBe("string");
        expect(line.text.length).toBeGreaterThan(0);
        expect(line.text).not.toContain("[object Object]");
        expect(line.text).not.toMatch(FORBIDDEN);
      }
    }
  });
}

test("golden: a known CS:GO 2013 line's cleaned text matches exactly (positive lock)", () => {
  const fx = loadFixture("csgo-2013-crlf.json");
  const sections = parseBody(fx.contents, fx.date);
  // The pre-header intro line is a stable, exact cleaned string — proving the
  // parser emits real text, not a coincidentally count-satisfying blob.
  expect(sections[0].lines[0].text).toBe("Release Notes for 12/18/2013");
});

test("golden: headerless note yields exactly one header:null section, nothing dropped", () => {
  const fx = loadFixture("edge-headerless.json");
  const sections = parseBody(fx.contents, fx.date);
  expect(sections.length).toBe(1);
  expect(sections[0].header).toBeNull();
  expect(sections[0].lines.length).toBeGreaterThan(0);
});

test("golden: off-title allow-listed real parses into at least one non-empty line", () => {
  const fx = loadFixture("edge-off-title-allowlisted.json");
  const sections = parseBody(fx.contents, fx.date);
  const lines = sections.flatMap((s) => s.lines);
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(typeof line.text).toBe("string");
    expect(line.text.length).toBeGreaterThan(0);
  }
});

test("golden: nested-map note persists a non-null subheader + parent_line_index whose text is a real cleaned string", () => {
  const db = openDb(":memory:");
  const fx = loadFixture("edge-nested-map-subheader.json");
  seedUpdate(db, fx);
  parseStoredUpdates(db);

  const linked = db
    .prepare(
      "SELECT text, subheader, parent_line_index FROM lines WHERE subheader IS NOT NULL AND parent_line_index IS NOT NULL",
    )
    .all() as Pick<LineRow, "text" | "subheader" | "parent_line_index">[];

  // At least one map bullet is linked to its map subheader (D-12).
  expect(linked.length).toBeGreaterThan(0);
  for (const row of linked) {
    expect(typeof row.subheader).toBe("string");
    expect(typeof row.parent_line_index).toBe("number");
    // The DB write path extracted ParsedLine.text — never the whole object.
    expect(typeof row.text).toBe("string");
    expect(row.text).not.toContain("[object Object]");
  }

  // A specific map subheader ("Inferno") links a specific bullet — the exact
  // parent→child relationship the later attribution pass depends on.
  const inferno = linked.find((r) => r.subheader === "Inferno");
  expect(inferno).toBeDefined();
  expect(inferno?.text).toBe("Balcony at Bombsite A has been extended.");
  db.close();
});
