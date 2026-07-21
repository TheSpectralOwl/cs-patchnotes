import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type {
  CanonicalParseOutput,
  DetectionEvidence,
  PristineSource,
  RegisteredParser,
  ReviewedParserOverride,
} from "../src/parse/contract.js";
import { ParserRegistry } from "../src/parse/registry.js";
import { steamPatchPlaintextParser } from "../src/parse/steam-plaintext.js";

const SOURCE: PristineSource = {
  documentId: "document-a",
  sourceRecordId: "source-a",
  sourceAdapter: "steam_news",
  bodyFormat: "plain_text",
  pristineBody: "[ MAPS ]\n- Updated Mirage",
  bodySha256: "a".repeat(64),
};

function parser(
  key: string,
  matched: boolean,
  evidence: Partial<DetectionEvidence> = {},
): RegisteredParser {
  return {
    key,
    version: "1.0.0",
    detect: (): DetectionEvidence => ({
      matched,
      codes: [matched ? "STRUCTURE_MATCH" : "STRUCTURE_MISS"],
      spans: [{ start: 0, end: 8 }],
      details: { detector: key, signalCount: matched ? 1 : 0 },
      ...evidence,
    }),
    parse: (): CanonicalParseOutput => ({
      status: "complete",
      blocks: [],
      diagnostics: [],
    }),
  };
}

describe("ParserRegistry", () => {
  test("rejects duplicate parser keys during construction", () => {
    expect(() => new ParserRegistry([parser("duplicate", true), parser("duplicate", false)])).toThrow(
      /duplicate parser key/i,
    );
  });

  test("selects exactly one matching detector and records its key and version", () => {
    const selected = new ParserRegistry([
      parser("miss", false),
      parser("selected", true),
    ]).selectParser(SOURCE);

    expect(selected.status).toBe("selected");
    if (selected.status !== "selected") throw new Error("expected selected result");
    expect(selected.parserKey).toBe("selected");
    expect(selected.parserVersion).toBe("1.0.0");
    expect(selected.matchKeys).toEqual(["selected"]);
    expect(selected.evidence.map((entry) => entry.parserKey)).toEqual(["miss", "selected"]);
  });

  test("quarantines zero matches without exposing a parser instance", () => {
    const selection = new ParserRegistry([
      parser("alpha", false),
      parser("beta", false),
    ]).selectParser(SOURCE);

    expect(selection).toMatchObject({
      status: "quarantined",
      reason: "zero_match",
      matchKeys: [],
    });
    expect("parser" in selection).toBe(false);
  });

  test("quarantines multiple matches with every candidate key and no first-match parser", () => {
    const selection = new ParserRegistry([
      parser("beta", true),
      parser("alpha", true),
      parser("miss", false),
    ]).selectParser(SOURCE);

    expect(selection).toMatchObject({
      status: "quarantined",
      reason: "multiple_match",
      matchKeys: ["alpha", "beta"],
    });
    expect("parser" in selection).toBe(false);
  });

  test("produces byte-equivalent evidence when registration order is reversed", () => {
    const parsers = [parser("zeta", false), parser("alpha", true), parser("middle", false)];
    const forward = new ParserRegistry(parsers).selectParser(SOURCE);
    const reversed = new ParserRegistry([...parsers].reverse()).selectParser(SOURCE);

    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });

  test("accepts a reviewed override only for a registered parser and retains its audit fields", () => {
    const override: ReviewedParserOverride = {
      parserKey: "forced",
      reviewedBy: "reviewer@example.test",
      reason: "Verified source format manually",
      reviewedAt: 1_700_000_000,
    };
    const selected = new ParserRegistry([
      parser("forced", false),
      parser("detected", true),
    ]).selectParser(SOURCE, override);

    expect(selected.status).toBe("selected");
    if (selected.status !== "selected") throw new Error("expected selected result");
    expect(selected.parserKey).toBe("forced");
    expect(selected.override).toEqual(override);
    expect(selected.matchKeys).toEqual(["detected"]);
  });

  test("rejects a reviewed override that names an unknown parser", () => {
    const override: ReviewedParserOverride = {
      parserKey: "unknown",
      reviewedBy: "reviewer@example.test",
      reason: "Attempted invalid override",
      reviewedAt: 1_700_000_000,
    };

    expect(() => new ParserRegistry([parser("known", true)]).selectParser(SOURCE, override)).toThrow(
      /unknown parser key/i,
    );
  });

  test("bounds serializable detector evidence without retaining pristine bodies or environment values", () => {
    const secret = "do-not-persist-this-environment-value";
    process.env.PARSER_REGISTRY_TEST_SECRET = secret;
    const noisy = parser("noisy", false, {
      codes: Array.from({ length: 40 }, (_, index) => `CODE_${index}`),
      spans: Array.from({ length: 40 }, (_, index) => ({ start: index, end: index + 1 })),
      details: Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [`count${index}`, index]),
      ),
    });

    const selection = new ParserRegistry([noisy]).selectParser({
      ...SOURCE,
      pristineBody: `${SOURCE.pristineBody}\n${secret}`,
    });
    const serialized = JSON.stringify(selection);
    const evidence = selection.evidence[0];

    expect(evidence.codes.length).toBeLessThanOrEqual(8);
    expect(evidence.spans.length).toBeLessThanOrEqual(8);
    expect(Object.keys(evidence.details).length).toBeLessThanOrEqual(8);
    expect(serialized).not.toContain(SOURCE.pristineBody);
    expect(serialized).not.toContain(secret);
    delete process.env.PARSER_REGISTRY_TEST_SECRET;
  });
});

describe("steamPatchPlaintextParser", () => {
  test("matches bracket or bullet structure only when recognized block tags are absent", () => {
    expect(steamPatchPlaintextParser.detect(SOURCE).matched).toBe(true);
    expect(
      steamPatchPlaintextParser.detect({
        ...SOURCE,
        pristineBody: "[ MAPS ]\n[list][*] Updated Mirage[/list]",
        bodyFormat: "bbcode",
      }).matched,
    ).toBe(false);
    expect(
      steamPatchPlaintextParser.detect({
        ...SOURCE,
        pristineBody: "An editorial paragraph with no patch structure.",
      }).matched,
    ).toBe(false);
  });

  test("emits only approved canonical kinds with UTF-16 source spans", () => {
    const output = steamPatchPlaintextParser.parse({
      ...SOURCE,
      pristineBody: "Release notes\n[ MAPS ]\n- Updated 😀 Mirage\n• Fixed clipping",
    });

    expect(output.status).toBe("complete");
    expect(output.blocks.map((block) => block.kind)).toEqual([
      "paragraph",
      "heading",
      "patch_change",
      "patch_change",
    ]);
    for (const block of output.blocks) {
      expect(block.sourceSpan.start).toBeGreaterThanOrEqual(0);
      expect(block.sourceSpan.end).toBeLessThanOrEqual(
        "Release notes\n[ MAPS ]\n- Updated 😀 Mirage\n• Fixed clipping".length,
      );
      expect(block.sourceSpan.end).toBeGreaterThan(block.sourceSpan.start);
    }
  });

  test("has a frozen representative plain-text Valve fixture", () => {
    const fixture = fileURLToPath(new URL("./fixtures/csgo-2013-crlf.json", import.meta.url));
    expect(existsSync(fixture)).toBe(true);
  });
});
