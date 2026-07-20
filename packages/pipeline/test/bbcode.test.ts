import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseBody, detectEra, type ParsedSection } from "../src/parse/bbcode.js";

interface Fixture {
  gid: string;
  title: string;
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
  /\{STEAM_CLAN_IMAGE\}|steamstatic|\.png|\[\/?(?:img|url|p|list|h[1-6])\b|\[\*\]|\[\/\*\]|\\\[/i;

function findSection(sections: ParsedSection[], header: string): ParsedSection | undefined {
  return sections.find((s) => s.header === header);
}

// --- detectEra: structural sniff first ---

test("detectEra returns cs2-richtext for a [p]/[list] body", () => {
  expect(detectEra("[p]Hello[/p][list][*]a[/*][/list]")).toBe("cs2-richtext");
  expect(detectEra(cs2.contents)).toBe("cs2-richtext");
});

test("detectEra returns csgo-crlf for a CRLF body with no richtext tags", () => {
  expect(detectEra("[ MISC ]\r\n- Fixed a thing\r\n- Fixed another\r\n")).toBe("csgo-crlf");
});

test("detectEra returns csgo-lf otherwise", () => {
  expect(detectEra("[ MISC ]\n- Fixed a thing\n")).toBe("csgo-lf");
});

// --- cs2-richtext: cleaning + section split ---

test("parseBody produces the PREMIER section first on the cs2-multi-section fixture", () => {
  const sections = parseBody(cs2.contents);
  const headers = sections.map((s) => s.header).filter((h): h is string => h !== null);
  expect(headers[0]).toBe("PREMIER");
  expect(headers).toContain("MAPS");
  expect(headers).toContain("GAMEPLAY");
});

test("no image tokens, steamstatic URLs, .png, or residual BBCode survive into any line", () => {
  for (const raw of [cs2.contents, imageHeavy.contents]) {
    const sections = parseBody(raw);
    for (const s of sections) {
      for (const line of s.lines) {
        expect(line.text).not.toMatch(FORBIDDEN);
      }
    }
  }
});

// --- cs2-richtext: nesting preservation (D-12) ---

test("a [p]subheader[/p] immediately followed by a [list] links child lines via subheader + parentLineIndex", () => {
  const raw = "[p]\\[ MAPS ][/p][p]Mirage[/p][list][*][p]Fixed a wall[/p][/*][*][p]Fixed a boost[/p][/*][/list]";
  const maps = findSection(parseBody(raw), "MAPS");
  expect(maps).toBeDefined();
  const mirageIdx = maps!.lines.findIndex((l) => l.text === "Mirage");
  expect(mirageIdx).toBeGreaterThanOrEqual(0);
  const children = maps!.lines.filter((l) => l.subheader === "Mirage");
  expect(children.length).toBe(2);
  for (const child of children) {
    expect(child.parentLineIndex).toBe(mirageIdx);
  }
});

test("a top-level [*] item followed by a nested [list] links the nested bullets as children", () => {
  const raw = "[list][*][p]Re-designed C4 damage[/p][list][*][p]Baked into the map[/p][/*][*][p]Expands from center[/p][/*][/list][/*][*][p]Fixed a buy menu case[/p][/*][/list]";
  const [section] = parseBody(raw);
  const parentIdx = section.lines.findIndex((l) => l.text === "Re-designed C4 damage");
  expect(parentIdx).toBeGreaterThanOrEqual(0);
  const nested = section.lines.filter((l) => l.subheader === "Re-designed C4 damage");
  expect(nested.map((l) => l.text)).toEqual(["Baked into the map", "Expands from center"]);
  for (const child of nested) {
    expect(child.parentLineIndex).toBe(parentIdx);
  }
  // The sibling top-level item is NOT a child of the parent.
  const sibling = section.lines.find((l) => l.text === "Fixed a buy menu case");
  expect(sibling?.subheader).toBeNull();
  expect(sibling?.parentLineIndex).toBeNull();
});

test("the cs2-multi-section MAPS section preserves at least one map subheader link", () => {
  const maps = findSection(parseBody(cs2.contents), "MAPS");
  expect(maps).toBeDefined();
  const linked = maps!.lines.filter(
    (l) => l.subheader !== null && l.parentLineIndex !== null,
  );
  expect(linked.length).toBeGreaterThan(0);
  // "Cache" is a subheader paragraph followed by a nested list in the fixture.
  const cacheChild = maps!.lines.find((l) => l.subheader === "Cache");
  expect(cacheChild).toBeDefined();
});

// --- csgo eras: CRLF + LF plain-text bullet splitting ---

test("csgo-crlf: bare [ MISC ] header + hyphen bullets split into one line per bullet, glyph stripped", () => {
  const raw = "[ MISC ]\r\n- Reduced scoreboard cost\r\n- Fixed material blending\r\n";
  const misc = findSection(parseBody(raw), "MISC");
  expect(misc).toBeDefined();
  expect(misc!.lines.map((l) => l.text)).toEqual([
    "Reduced scoreboard cost",
    "Fixed material blending",
  ]);
  for (const l of misc!.lines) {
    expect(l.subheader).toBeNull();
    expect(l.parentLineIndex).toBeNull();
  }
});

test("csgo-lf: en-dash bullets split correctly with the glyph stripped", () => {
  const raw = "[ GAMEPLAY ]\n\u2013 Adjusted recoil\n\u2013 Tweaked movement\n";
  const gameplay = findSection(parseBody(raw), "GAMEPLAY");
  expect(gameplay).toBeDefined();
  expect(gameplay!.lines.map((l) => l.text)).toEqual(["Adjusted recoil", "Tweaked movement"]);
});

// --- never drop content (D-13) ---

test("a headerless body yields a single header:null section and drops nothing", () => {
  const sections = parseBody("[p]Just a standalone note.[/p]");
  expect(sections.length).toBe(1);
  expect(sections[0].header).toBeNull();
  expect(sections[0].lines.map((l) => l.text)).toEqual(["Just a standalone note."]);
});
