import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  openDb,
  upsertSteamSourceRecord,
  type BodyFormat,
} from "@cs-patchnotes/shared";
import type { PristineSource } from "../src/parse/contract.js";
import { ParserRegistry } from "../src/parse/registry.js";
import { steamNewsBbcodeParser } from "../src/parse/steam-bbcode.js";
import { steamPatchPlaintextParser } from "../src/parse/steam-plaintext.js";
import { parseStoredDocuments } from "../src/parse.js";

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

const registry = new ParserRegistry([steamPatchPlaintextParser, steamNewsBbcodeParser]);
const FORBIDDEN = /\{STEAM_CLAN_IMAGE\}|https?:\/\/|steamstatic|\.png|\[\/?(?:img|url|p|list|h[1-6])\b|\[\*\]|\[\/\*\]/i;

function bodyFormat(body: string): BodyFormat {
  return /\[(?:\/?(?:p|list|h[1-6]|img|carousel)\b|\/?\*)/i.test(body)
    ? "bbcode"
    : "plain_text";
}

function source(fixture: Fixture): PristineSource {
  return {
    documentId: `document-${fixture.gid}`,
    sourceRecordId: `source-${fixture.gid}`,
    sourceAdapter: "steam_news",
    bodyFormat: bodyFormat(fixture.contents),
    pristineBody: fixture.contents,
    bodySha256: createHash("sha256").update(fixture.contents, "utf8").digest("hex"),
  };
}

function parseFixture(fixture: Fixture) {
  const selection = registry.selectParser(source(fixture));
  expect(selection.status).toBe("selected");
  if (selection.status !== "selected") throw new Error("fixture did not select exactly one parser");
  return { key: selection.parserKey, output: selection.parser.parse(source(fixture)) };
}

function seedFixture(db: ReturnType<typeof openDb>, fixture: Fixture): string {
  return upsertSteamSourceRecord(db, {
    gid: fixture.gid,
    url: fixture.url,
    title: fixture.title,
    posted_at: fixture.date,
    game: fixture.date >= 1_695_772_800 ? "cs2" : "csgo",
    channel: "mainline",
    content_kind: "patch_notes",
    source_adapter: "steam_news",
    body_format: bodyFormat(fixture.contents),
    pristine_body: fixture.contents,
    fetched_at: fixture.date,
  }).document.id;
}

const HISTORICAL_FIXTURES = [
  "csgo-2013-crlf.json",
  "csgo-2018-lf.json",
  "csgo-2021-lf.json",
  "cs2-2023-richtext.json",
  "cs2-2026-richtext.json",
  "cs2-2023-btag-header.json",
  "edge-headerless.json",
  "edge-off-title-allowlisted.json",
  "edge-nested-map-subheader.json",
] as const;

describe("historical fixtures through the canonical registry", () => {
  test.each(HISTORICAL_FIXTURES)("%s selects exactly one parser and retains searchable semantics", (file) => {
    const fixture = loadFixture(file);
    const { output } = parseFixture(fixture);
    const semantic = output.blocks
      .flatMap((block) => [block.text, block.label])
      .filter((value): value is string => value !== null);

    expect(output.blocks.length).toBeGreaterThan(0);
    expect(semantic.length).toBeGreaterThan(0);
    expect(output.blocks.map((block) => block.sourceSpan.start)).toEqual(
      [...output.blocks].map((block) => block.sourceSpan.start).sort((a, b) => a - b),
    );
    for (const text of semantic) {
      expect(text).not.toContain("[object Object]");
      expect(text).not.toMatch(FORBIDDEN);
    }
  });

  test("retains the known early release text and the headerless note without a fallback era", () => {
    const early = parseFixture(loadFixture("csgo-2013-crlf.json")).output;
    const headerless = parseFixture(loadFixture("edge-headerless.json")).output;

    expect(early.blocks.some((block) => block.text === "Release Notes for 12/18/2013")).toBe(true);
    expect(headerless.blocks.filter((block) => block.kind === "heading")).toHaveLength(0);
    expect(headerless.blocks.filter((block) => block.text !== null).length).toBeGreaterThan(0);
  });

  test("retains wrapped section labels and nested map ownership as canonical ancestors", () => {
    const wrapped = parseFixture(loadFixture("cs2-2023-btag-header.json")).output;
    const nested = parseFixture(loadFixture("edge-nested-map-subheader.json")).output;
    const labels = wrapped.blocks.map((block) => block.label).filter(Boolean);
    const inferno = nested.blocks.findIndex((block) => block.label === "Inferno" || block.text === "Inferno");
    const balcony = nested.blocks.findIndex((block) => block.text === "Balcony at Bombsite A has been extended.");

    expect(labels).toEqual(expect.arrayContaining(["CASE DROPS", "MAPS", "WEAPONS", "WORKSHOP TOOLS"]));
    expect(inferno).toBeGreaterThanOrEqual(0);
    expect(balcony).toBeGreaterThan(inferno);
    const parentIndexes = new Set<number>();
    let cursor = nested.blocks[balcony].parentIndex;
    while (cursor !== null) {
      parentIndexes.add(cursor);
      cursor = nested.blocks[cursor].parentIndex;
    }
    expect(parentIndexes.has(inferno)).toBe(true);
  });
});

describe("historical fixtures through current-source canonical persistence", () => {
  test("materializes current immutable source heads into ordered blocks and fragments", () => {
    const db = openDb(":memory:");
    const cs2 = loadFixture("cs2-multi-section.json");
    const imageHeavy = loadFixture("cs2-image-heavy.json");
    const documentIds = [seedFixture(db, cs2), seedFixture(db, imageHeavy)];

    const summary = parseStoredDocuments(db, registry, { runId: "historical-current-heads", now: () => 1_700_000_000 });
    expect(summary).toMatchObject({ attempted: 2, selected: 2, materialized: 2, gateFailed: false });

    for (const documentId of documentIds) {
      const blocks = db.prepare("SELECT kind, text, preorder FROM blocks WHERE document_id = ? ORDER BY preorder").all(documentId) as Array<{ kind: string; text: string | null; preorder: number }>;
      const fragments = db.prepare("SELECT text, fragment_order FROM search_fragments WHERE document_id = ? ORDER BY fragment_order").all(documentId) as Array<{ text: string; fragment_order: number }>;
      expect(blocks.length).toBeGreaterThan(0);
      expect(blocks.map((block) => block.preorder)).toEqual(blocks.map((_, index) => index));
      expect(fragments.length).toBeGreaterThan(0);
      for (const fragment of fragments) expect(fragment.text).not.toMatch(FORBIDDEN);
    }
    db.close();
  });
});
