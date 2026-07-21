import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { CanonicalBlockData, PristineSource } from "../src/parse/contract.js";
import { ParserRegistry } from "../src/parse/registry.js";
import { steamNewsBbcodeParser } from "../src/parse/steam-bbcode.js";
import { steamPatchPlaintextParser } from "../src/parse/steam-plaintext.js";
import {
  STEAM_MAX_DIAGNOSTICS,
  STEAM_MAX_NESTING_DEPTH,
  STEAM_MAX_SOURCE_BYTES,
  STEAM_MAX_TOKENS,
  tokenizeSteamBbcode,
} from "../src/parse/steam-tokenizer.js";

interface SteamFixture {
  gid: string;
  title: string;
  contents: string;
}

function loadFixture(name: string): SteamFixture {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as SteamFixture;
}

function source(body: string, bodyFormat: PristineSource["bodyFormat"] = "bbcode"): PristineSource {
  return {
    documentId: "document-fixture",
    sourceRecordId: "source-fixture",
    sourceAdapter: "steam_news",
    bodyFormat,
    pristineBody: body,
    bodySha256: createHash("sha256").update(body, "utf8").digest("hex"),
  };
}

function spanOf(body: string, syntax: string, from = 0): { start: number; end: number } {
  const start = body.indexOf(syntax, from);
  if (start < 0) throw new Error(`syntax not found: ${syntax.slice(0, 40)}`);
  return { start, end: start + syntax.length };
}

function structuralLayout(blocks: CanonicalBlockData[]) {
  const siblingCounts = new Map<number | null, number>();
  return blocks.map((block, index) => {
    const sibling = siblingCounts.get(block.parentIndex) ?? 0;
    siblingCounts.set(block.parentIndex, sibling + 1);
    return {
      preorder: index,
      parent: block.parentIndex,
      sibling,
      kind: block.kind,
      text: block.text,
      label: block.label,
      span: [block.sourceSpan.start, block.sourceSpan.end],
    };
  });
}

function semanticText(output: ReturnType<typeof steamNewsBbcodeParser.parse>): string {
  return output.blocks
    .flatMap((block) => [block.text, block.label])
    .filter((value): value is string => value !== null)
    .join("\n");
}

describe("official Steam fixture integrity", () => {
  test("keeps the complete official carousel body byte-for-byte offline", () => {
    const fixture = loadFixture("steam-carousel.json");

    expect(fixture.gid).toBe("1826992588591187");
    expect(fixture.title).toBe("The Dead Hand");
    expect(fixture.contents.length).toBe(4_732);
    expect(Buffer.byteLength(fixture.contents, "utf8")).toBe(4_732);
    expect(createHash("sha256").update(fixture.contents, "utf8").digest("hex")).toBe(
      "c4570c6e53753beab385a5c565afd94aa54126d364cf343fb3a530ca542efb7e",
    );
    expect(fixture.contents.match(/\[carousel\]/g)).toHaveLength(2);
    expect(fixture.contents.match(/\[img\]/g)).toHaveLength(40);
  });
});

describe("exact parser selection", () => {
  const registry = new ParserRegistry([steamPatchPlaintextParser, steamNewsBbcodeParser]);
  const reversed = new ParserRegistry([steamNewsBbcodeParser, steamPatchPlaintextParser]);

  test.each([
    ["plain", "[ MAPS ]\n- Updated Mirage", "plain_text", "steam-patch-plaintext"],
    ["rich list", "[ MAPS ]\n[list][*] Updated Mirage[/list]", "bbcode", "steam-news-bbcode"],
    ["official h3/images", loadFixture("cs2-image-heavy.json").contents, "bbcode", "steam-news-bbcode"],
    ["official carousel", loadFixture("steam-carousel.json").contents, "bbcode", "steam-news-bbcode"],
  ] as const)("selects one parser for %s independent of registration order", (_, body, format, key) => {
    const forward = registry.selectParser(source(body, format));
    const backward = reversed.selectParser(source(body, format));

    expect(forward.status).toBe("selected");
    expect(backward.status).toBe("selected");
    if (forward.status !== "selected" || backward.status !== "selected") {
      throw new Error("expected exact-one parser selection");
    }
    expect(forward.parserKey).toBe(key);
    expect(backward.parserKey).toBe(key);
    expect(JSON.stringify(backward.evidence)).toBe(JSON.stringify(forward.evidence));
  });
});

describe("canonical source order and spans", () => {
  test("preserves exact heading, list, change, parent, sibling, and UTF-16 relationships", () => {
    const body = "[ GAMEPLAY ]\n[list][*] First 😀 change[*] Parent[list][*] Nested change[/list][/*][/list]";
    const output = steamNewsBbcodeParser.parse(source(body));
    const headingSyntax = "[ GAMEPLAY ]";
    const firstSyntax = "[*] First 😀 change";
    const parentSyntax = "[*] Parent[list][*] Nested change[/list][/*]";
    const nestedSyntax = "[*] Nested change";

    expect(output.status).toBe("complete");
    expect(structuralLayout(output.blocks)).toEqual([
      {
        preorder: 0,
        parent: null,
        sibling: 0,
        kind: "heading",
        text: "GAMEPLAY",
        label: "GAMEPLAY",
        span: Object.values(spanOf(body, headingSyntax)),
      },
      {
        preorder: 1,
        parent: 0,
        sibling: 0,
        kind: "list",
        text: null,
        label: null,
        span: Object.values(spanOf(body, body.slice(body.indexOf("[list]"), body.lastIndexOf("[/list]") + 7))),
      },
      {
        preorder: 2,
        parent: 1,
        sibling: 0,
        kind: "patch_change",
        text: "First 😀 change",
        label: null,
        span: Object.values(spanOf(body, firstSyntax)),
      },
      {
        preorder: 3,
        parent: 1,
        sibling: 1,
        kind: "patch_change",
        text: "Parent",
        label: null,
        span: Object.values(spanOf(body, parentSyntax)),
      },
      {
        preorder: 4,
        parent: 3,
        sibling: 0,
        kind: "list",
        text: null,
        label: null,
        span: Object.values(spanOf(body, "[list][*] Nested change[/list]", body.indexOf("Parent"))),
      },
      {
        preorder: 5,
        parent: 4,
        sibling: 0,
        kind: "patch_change",
        text: "Nested change",
        label: null,
        span: Object.values(spanOf(body, nestedSyntax)),
      },
    ]);
    expect(body.slice(output.blocks[2].sourceSpan.start, output.blocks[2].sourceSpan.end)).toBe(firstSyntax);
  });

  test("retains a real h3 and two adjacent standalone images as separate ordered groups", () => {
    const fixture = loadFixture("cs2-image-heavy.json");
    const output = steamNewsBbcodeParser.parse(source(fixture.contents));
    const headingIndex = output.blocks.findIndex((block) => block.label === "A Call to Arms-ory");
    const groups = output.blocks
      .map((block, index) => ({ block, index }))
      .filter(({ block }) => block.kind === "media_group");

    expect(headingIndex).toBeGreaterThan(0);
    expect(output.blocks[headingIndex]).toMatchObject({
      kind: "heading",
      parentIndex: null,
      sourceNodeType: "h3",
      sourceSpan: spanOf(fixture.contents, "[h3]A Call to Arms-ory[/h3]"),
    });
    expect(groups).toHaveLength(2);
    expect(groups[1].index).toBe(groups[0].index + 1);
    expect(groups.map(({ block }) => block.parentIndex)).toEqual([headingIndex, headingIndex]);
    expect(output.mediaItems).toHaveLength(2);
    expect(output.mediaItems?.map((item) => item.groupBlockIndex)).toEqual(
      groups.map(({ index }) => index),
    );
    expect(output.mediaItems?.map((item) => item.originalLocator)).toEqual([
      "{STEAM_CLAN_IMAGE}/3381077/3f23de85ca6d44c82af2cefb0b66d9435e1f783f.png",
      "{STEAM_CLAN_IMAGE}/3381077/4130c29d0220e97f1c31cd3c74f0527afa286e5e.png",
    ]);
  });

  test("maps official carousels to exact-position groups with exact ordered items", () => {
    const fixture = loadFixture("steam-carousel.json");
    const output = steamNewsBbcodeParser.parse(source(fixture.contents));
    const layouts = structuralLayout(output.blocks);
    const groupIndexes = output.blocks
      .map((block, index) => ({ block, index }))
      .filter(({ block }) => block.kind === "media_group")
      .map(({ index }) => index);

    expect(layouts.map(({ kind, parent, sibling }) => ({ kind, parent, sibling }))).toEqual([
      { kind: "paragraph", parent: null, sibling: 0 },
      { kind: "media_group", parent: null, sibling: 1 },
      { kind: "heading", parent: null, sibling: 2 },
      { kind: "paragraph", parent: 2, sibling: 0 },
      { kind: "media_group", parent: 2, sibling: 1 },
      { kind: "paragraph", parent: 2, sibling: 2 },
    ]);
    expect(groupIndexes).toEqual([1, 4]);
    expect(output.blocks[1].sourceSpan).toEqual({ start: 147, end: 1_970 });
    expect(output.blocks[2].sourceSpan).toEqual({ start: 1_972, end: 2_011 });
    expect(output.blocks[4].sourceSpan).toEqual({ start: 2_111, end: 4_570 });
    expect(output.mediaItems?.filter((item) => item.groupBlockIndex === 1)).toHaveLength(17);
    expect(output.mediaItems?.filter((item) => item.groupBlockIndex === 4)).toHaveLength(23);
    expect(output.mediaItems?.[0].originalLocator).toBe(
      "https://clan.fastly.steamstatic.com/images/3381077/55ed2cb8da5c61796d087c29b39e0b4bd8220443.png",
    );
    expect(output.mediaItems?.at(-1)?.originalLocator).toBe(
      "https://clan.fastly.steamstatic.com/images/3381077/efc53924ba4c57105b0760f32c45c87b0b603055.png",
    );
    expect(output.mediaItems?.map((item) => fixture.contents.slice(item.sourceSpan.start, item.sourceSpan.end)))
      .toSatisfy((items: string[]) => items.every((item) => /^\[img\]https:\/\/[^[]+\[\/img\]$/.test(item)));
  });

  test("preserves plain-era headings and changes from a real CRLF fixture", () => {
    const fixture = loadFixture("csgo-2013-crlf.json");
    const output = steamNewsBbcodeParser.parse(source(fixture.contents));
    const maps = output.blocks.findIndex((block) => block.kind === "heading" && block.label === "MAPS");
    const firstMapChange = output.blocks.findIndex((block) =>
      block.text?.startsWith("Added Cobblestone and Overpass maps"),
    );

    expect(output.blocks[0].kind).toBe("media_group");
    expect(maps).toBeGreaterThan(0);
    expect(firstMapChange).toBeGreaterThan(maps);
    expect(output.blocks[firstMapChange].parentIndex).toBe(maps);
    expect(fixture.contents.slice(output.blocks[maps].sourceSpan.start, output.blocks[maps].sourceSpan.end)).toBe(
      "[ MAPS ]",
    );
    expect(output.blocks.every((block) => block.sourceSpan.end >= block.sourceSpan.start)).toBe(true);
  });
});

describe("unsupported constructs and semantic-text exclusions", () => {
  test("keeps one local unknown construct in exact order while recognized siblings survive", () => {
    const body = "[p]Before[/p][spoiler level=\"2\"]hidden payload[/spoiler][p]After[/p]";
    const output = steamNewsBbcodeParser.parse(source(body));
    const unknownSyntax = "[spoiler level=\"2\"]hidden payload[/spoiler]";

    expect(output.status).toBe("partial");
    expect(output.blocks.map((block) => [block.kind, block.text])).toEqual([
      ["paragraph", "Before"],
      ["unsupported", null],
      ["paragraph", "After"],
    ]);
    expect(output.blocks[1]).toMatchObject({
      parentIndex: null,
      sourceSpan: spanOf(body, unknownSyntax),
      sourceNodeType: "spoiler",
      diagnosticCode: "UNSUPPORTED_CONSTRUCT",
    });
    expect(output.diagnostics).toEqual([
      expect.objectContaining({
        code: "UNSUPPORTED_CONSTRUCT",
        sourceSpan: spanOf(body, unknownSyntax),
      }),
    ]);
    expect(semanticText(output)).not.toContain("hidden payload");
  });

  test("retains visible labels and captions without locator, alt, raw-tag, or synthetic breadcrumb leakage", () => {
    const body =
      "[h3]Workshop[/h3][p]Read [url=\"https://example.test/private.png\"]patch details[/url].[/p]" +
      "[img alt=\"secret-alt.png\"]https://cdn.example.test/source-file.png[/img]" +
      "[p]Visible caption text[/p]";
    const output = steamNewsBbcodeParser.parse(source(body));
    const text = semanticText(output);

    expect(text).toContain("Workshop");
    expect(text).toContain("Read patch details.");
    expect(text).toContain("Visible caption text");
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toContain("private.png");
    expect(text).not.toContain("source-file.png");
    expect(text).not.toContain("secret-alt.png");
    expect(text).not.toContain("[h3]");
    expect(text).not.toContain("Workshop >");
    expect(output.mediaItems?.[0]).toMatchObject({
      originalLocator: "https://cdn.example.test/source-file.png",
      altText: "secret-alt.png",
    });
  });

  test("decodes entities only in visible semantic leaves", () => {
    const body = "[p]Use &lt;utility&gt; &amp; [url=https://example.test?a=1&amp;b=2]read more[/url][/p]";
    const output = steamNewsBbcodeParser.parse(source(body));

    expect(output.blocks.map((block) => block.text).filter(Boolean)).toEqual([
      "Use <utility> & read more",
    ]);
    expect(semanticText(output)).not.toContain("example.test");
  });
});

describe("bounded tokenizer and parser", () => {
  test("emits ordered source-span tokens for text, tags, placeholders, and unknown syntax", () => {
    const body = "A{STEAM_CLAN_IMAGE}[p]B[/p][mystery]C[/mystery]";
    const result = tokenizeSteamBbcode(body);

    expect(result.status).toBe("complete");
    expect(result.tokens.map((token) => token.type)).toEqual([
      "text",
      "placeholder",
      "tag",
      "text",
      "tag",
      "unknown",
      "text",
      "unknown",
    ]);
    expect(result.tokens.map((token) => body.slice(token.sourceSpan.start, token.sourceSpan.end))).toEqual([
      "A",
      "{STEAM_CLAN_IMAGE}",
      "[p]",
      "B",
      "[/p]",
      "[mystery]",
      "C",
      "[/mystery]",
    ]);
  });

  test("quarantines source larger than the declared UTF-8 byte limit", () => {
    const result = tokenizeSteamBbcode("😀".repeat(Math.ceil(STEAM_MAX_SOURCE_BYTES / 4) + 1));

    expect(result.status).toBe("quarantined");
    expect(result.tokens.length).toBeLessThanOrEqual(STEAM_MAX_TOKENS);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("SOURCE_LIMIT_EXCEEDED");
  });

  test("bounds tokens, nesting depth, and diagnostics for adversarial input", () => {
    const deep = "[list]".repeat(STEAM_MAX_NESTING_DEPTH + 8) + "x" + "[/list]".repeat(STEAM_MAX_NESTING_DEPTH + 8);
    const flood = Array.from({ length: STEAM_MAX_DIAGNOSTICS + 40 }, (_, index) => `[unknown${index}]x[/unknown${index}]`).join("");
    const malformed = "[url=\"" + "x".repeat(4_096) + "[script]alert(1)</script>";

    for (const body of [deep, flood, malformed]) {
      const tokens = tokenizeSteamBbcode(body);
      expect(tokens.tokens.length).toBeLessThanOrEqual(STEAM_MAX_TOKENS);
      expect(tokens.diagnostics.length).toBeLessThanOrEqual(STEAM_MAX_DIAGNOSTICS);

      const output = steamNewsBbcodeParser.parse(source(body));
      expect(output.blocks.length).toBeLessThanOrEqual(STEAM_MAX_TOKENS);
      expect(output.diagnostics.length).toBeLessThanOrEqual(STEAM_MAX_DIAGNOSTICS);
      expect(JSON.stringify(output)).not.toContain("alert(1)");
    }
  });

  test("stops at the token cap for a diagnostic-light recognized-token flood", () => {
    const body = "[p][/p]".repeat(STEAM_MAX_TOKENS + 100);
    const result = tokenizeSteamBbcode(body);

    expect(result.status).not.toBe("complete");
    expect(result.tokens).toHaveLength(STEAM_MAX_TOKENS);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("TOKEN_LIMIT_EXCEEDED");
  });
});
