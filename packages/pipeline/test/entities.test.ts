import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { BodyFormat } from "@cs-patchnotes/shared";
import type { PristineSource } from "../src/parse/contract.js";
import { decodeSteamEntities } from "../src/parse/entities.js";
import { steamNewsBbcodeParser } from "../src/parse/steam-bbcode.js";
import { steamPatchPlaintextParser } from "../src/parse/steam-plaintext.js";

// U+FFFD is the Unicode replacement scalar; referenced by escape so no raw
// glyph appears in source that an audit scan might flag.
const REPLACEMENT = "\uFFFD";

function source(body: string, format: BodyFormat): PristineSource {
  return {
    documentId: "document-entities-test",
    sourceRecordId: "source-entities-test",
    sourceAdapter: "steam_news",
    bodyFormat: format,
    pristineBody: body,
    bodySha256: createHash("sha256").update(body, "utf8").digest("hex"),
  };
}

describe("shared Unicode-scalar entity decoder", () => {
  test("decodes valid decimal, hex, and named entities", () => {
    expect(decodeSteamEntities("&#65;")).toBe("A");
    expect(decodeSteamEntities("&#x1F600;")).toBe("\u{1F600}");
    expect(decodeSteamEntities("&lt;&gt;&quot;&apos;&amp;")).toBe("<>\"'&");
  });

  test("replaces an out-of-range numeric entity without throwing", () => {
    // 1114112 == 0x110000, one past the maximum Unicode scalar value.
    expect(() => decodeSteamEntities("&#1114112;")).not.toThrow();
    expect(decodeSteamEntities("before&#1114112;after")).toBe(`before${REPLACEMENT}after`);
    expect(decodeSteamEntities("&#x110000;")).toBe(REPLACEMENT);
  });

  test("replaces a surrogate-range numeric entity without throwing", () => {
    expect(() => decodeSteamEntities("&#xD800;")).not.toThrow();
    expect(decodeSteamEntities("&#xD800;")).toBe(REPLACEMENT);
    expect(decodeSteamEntities("&#57343;")).toBe(REPLACEMENT); // 0xDFFF, top of surrogate range
  });

  test("leaves unrelated text and unmatched ampersands intact", () => {
    expect(decodeSteamEntities("plain text with no entities")).toBe("plain text with no entities");
    expect(decodeSteamEntities("A & B")).toBe("A & B");
  });
});

describe("both Steam parsers survive a malformed numeric entity", () => {
  test("the plaintext parser drops or replaces the entity and never throws", () => {
    const body = "[ MISC ]\r\n- Fixed a thing &#1114112; here\r\n";
    const input = source(body, "plain_text");
    expect(steamPatchPlaintextParser.detect(input).matched).toBe(true);
    let output!: ReturnType<typeof steamPatchPlaintextParser.parse>;
    expect(() => {
      output = steamPatchPlaintextParser.parse(input);
    }).not.toThrow();
    const text = output.blocks.map((b) => b.text ?? "").join("\n");
    expect(text).not.toContain("&#1114112;");
  });

  test("the rich parser decodes through the shared decoder without a RangeError-of-death", () => {
    const body = "[p]Fixed a thing &#1114112; and more[/p]";
    const input = source(body, "bbcode");
    expect(steamNewsBbcodeParser.detect(input).matched).toBe(true);
    let output!: ReturnType<typeof steamNewsBbcodeParser.parse>;
    expect(() => {
      output = steamNewsBbcodeParser.parse(input);
    }).not.toThrow();
    const text = output.blocks.map((b) => b.text ?? "").join("\n");
    expect(text).not.toContain("&#1114112;");
  });
});
