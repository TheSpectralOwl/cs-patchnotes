import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { BodyFormat } from "@cs-patchnotes/shared";
import type { CanonicalParseOutput, PristineSource } from "../src/parse/contract.js";
import { ParserRegistry } from "../src/parse/registry.js";
import { steamNewsBbcodeParser } from "../src/parse/steam-bbcode.js";
import { steamPatchPlaintextParser } from "../src/parse/steam-plaintext.js";

interface Fixture {
  gid: string;
  title: string;
  contents: string;
}

function loadFixture(name: string): Fixture {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Fixture;
}

const registry = new ParserRegistry([steamPatchPlaintextParser, steamNewsBbcodeParser]);

function source(body: string, format: BodyFormat): PristineSource {
  return {
    documentId: "document-bbcode-test",
    sourceRecordId: "source-bbcode-test",
    sourceAdapter: "steam_news",
    bodyFormat: format,
    pristineBody: body,
    bodySha256: createHash("sha256").update(body, "utf8").digest("hex"),
  };
}

function selectAndParse(body: string, format: BodyFormat): { key: string; output: CanonicalParseOutput } {
  const input = source(body, format);
  const selection = registry.selectParser(input);
  expect(selection.status).toBe("selected");
  if (selection.status !== "selected") throw new Error("expected exact-one parser selection");
  return { key: selection.parserKey, output: selection.parser.parse(input) };
}

function ancestors(output: CanonicalParseOutput, blockIndex: number): number[] {
  const result: number[] = [];
  let parent = output.blocks[blockIndex].parentIndex;
  while (parent !== null) {
    result.unshift(parent);
    parent = output.blocks[parent].parentIndex;
  }
  return result;
}

describe("canonical Steam parser dispatch", () => {
  test("selects the rich parser from structural tags", () => {
    const fixture = loadFixture("cs2-multi-section.json");
    expect(selectAndParse(fixture.contents, "bbcode").key).toBe("steam-news-bbcode");
  });

  test("selects the plaintext parser from bracket headings and bullets", () => {
    const parsed = selectAndParse("[ MISC ]\r\n- Fixed a thing\r\n- Fixed another\r\n", "plain_text");
    expect(parsed.key).toBe("steam-patch-plaintext");
    expect(parsed.output.blocks.map((block) => [block.kind, block.text])).toEqual([
      ["heading", "MISC"],
      ["patch_change", "Fixed a thing"],
      ["patch_change", "Fixed another"],
    ]);
  });
});

describe("canonical rich and historical semantics", () => {
  test("keeps ordered named headings and excludes image locator data from semantic block text", () => {
    for (const fixture of [loadFixture("cs2-multi-section.json"), loadFixture("cs2-image-heavy.json")]) {
      const { output } = selectAndParse(fixture.contents, "bbcode");
      const labels = output.blocks.map((block) => block.label).filter((label): label is string => label !== null);
      const semantic = output.blocks.map((block) => block.text).filter((text): text is string => text !== null).join("\n");
      expect(labels.length).toBeGreaterThan(0);
      expect(semantic).not.toMatch(/\{STEAM_CLAN_IMAGE\}|https?:\/\/|steamstatic|\.png|\[\/?(?:img|url|p|list|h[1-6])/i);
    }
  });

  test("links map and nested-list changes through canonical parent chains", () => {
    const mapBody = "[p]\\[ MAPS ][/p][p]Mirage[/p][list][*][p]Fixed a wall[/p][*][p]Fixed a boost[/p][/list]";
    const nestedBody = "[list][*][p]Re-designed C4 damage[/p][list][*][p]Baked into the map[/p][*][p]Expands from center[/p][/list][*][p]Fixed a buy menu case[/p][/list]";

    const maps = selectAndParse(mapBody, "bbcode").output;
    const mapHeading = maps.blocks.findIndex((block) => block.label === "MAPS");
    const wall = maps.blocks.findIndex((block) => block.text === "Fixed a wall");
    expect(ancestors(maps, wall)).toContain(mapHeading);

    const nested = selectAndParse(nestedBody, "bbcode").output;
    const parent = nested.blocks.findIndex((block) => block.text === "Re-designed C4 damage");
    const children = nested.blocks
      .map((block, index) => ({ block, index }))
      .filter(({ block }) => ["Baked into the map", "Expands from center"].includes(block.text ?? ""));
    expect(children).toHaveLength(2);
    for (const child of children) expect(ancestors(nested, child.index)).toContain(parent);
    const sibling = nested.blocks.findIndex((block) => block.text === "Fixed a buy menu case");
    expect(ancestors(nested, sibling)).not.toContain(parent);
  });

  test("keeps headerless content as canonical prose instead of choosing a generic fallback", () => {
    const { key, output } = selectAndParse("[p]Just a standalone note.[/p]", "bbcode");
    expect(key).toBe("steam-news-bbcode");
    expect(output.blocks.map((block) => [block.kind, block.text])).toEqual([
      ["paragraph", "Just a standalone note."],
    ]);
  });
});
