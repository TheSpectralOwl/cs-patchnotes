import Database, { type Database as DatabaseType } from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  collapseRankedGroupHits,
  hydrateRankedFragments,
  type RankedFragmentHit,
} from "@cs-patchnotes/shared";
import { Meilisearch } from "meilisearch";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildServer } from "../src/server.js";

const INDEX_UID = "canonical_fragments";
const PATCH_NOTES_FILTER = "content_kind = patch_notes";
const LIVE_ENABLED = process.env.RUN_LIVE_CANONICAL === "1";
const EXPECTED_INTEGRATION_SCRIPT =
  "vitest run test/live-canonical.integration.test.ts";
const RETRIEVED_ATTRIBUTES = [
  "id",
  "fragment_id",
  "block_id",
  "document_id",
  "primary_release_id",
  "group_anchor_block_id",
  "fragment_kind",
  "content_kind",
  "posted_at",
];

interface LiveHit {
  id: string;
  fragment_id: string;
  block_id: string;
  document_id: string;
  primary_release_id: string | null;
  group_anchor_block_id: string | null;
  fragment_kind: "block_text" | "media_caption";
  content_kind: "patch_notes";
  posted_at: number;
  _matchesPosition?: Record<string, unknown>;
}

interface CanonicalFragmentRow {
  fragment_id: string;
  block_id: string;
  document_id: string;
  group_anchor_block_id: string | null;
  posted_at: number;
  block_kind: string;
}

interface TitleMatchDiagnostic {
  query_candidate: string;
  document_id: string;
  projection_count: number;
  matched_fields: string[];
  metadata_paths: string[];
}

const MAX_TITLE_MATCH_DIAGNOSTICS = 32;
const SAFE_MATCH_FIELDS = new Set(["text", "title", "ancestor_labels"]);

function titleCandidateId(query: string): string {
  return `sha256:${createHash("sha256").update(query, "utf8").digest("hex").slice(0, 16)}`;
}

function appendTitleMatchDiagnostics(
  diagnostics: TitleMatchDiagnostic[],
  query: string,
  groups: Map<string, Array<[number, LiveHit]>>,
): void {
  if (diagnostics.length >= MAX_TITLE_MATCH_DIAGNOSTICS) return;
  for (const [documentId, entries] of groups) {
    if (entries.length < 2) continue;
    const matchedFields = [...new Set(
      entries.flatMap(([, hit]) => {
        const fields = Object.keys(hit._matchesPosition ?? {});
        return fields.map((field) => SAFE_MATCH_FIELDS.has(field) ? field : "unexpected");
      }),
    )].sort();
    const metadataPaths = [...new Set(
      entries.flatMap(([, hit]) =>
        Object.keys(hit._matchesPosition ?? {}).map(
          (field) => `match_position.${field.slice(0, 64)}`,
        ),
      ),
    )].sort().slice(0, 8);
    diagnostics.push({
      query_candidate: titleCandidateId(query),
      document_id: documentId,
      projection_count: entries.length,
      matched_fields: matchedFields,
      metadata_paths: metadataPaths,
    });
    if (diagnostics.length >= MAX_TITLE_MATCH_DIAGNOSTICS) return;
    break;
  }
}

function selectCrossDocumentDirectRow(
  rows: readonly CanonicalFragmentRow[],
  headingDocumentId: string,
): CanonicalFragmentRow | undefined {
  return rows.find(
    (row) => row.document_id !== headingDocumentId && row.block_kind !== "heading",
  );
}

function buildTitleOnlyQueryCandidates(titles: readonly string[]): string[] {
  const uniqueTitles = [...new Set(titles.map((title) => title.trim()).filter(Boolean))];
  uniqueTitles.sort((left, right) => {
    const leftHasDate = /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(left);
    const rightHasDate = /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(right);
    return Number(rightHasDate) - Number(leftHasDate) || left.localeCompare(right);
  });
  const candidates: string[] = [];
  for (const title of uniqueTitles) {
    const escapedTitle = title.replaceAll('"', '\\"');
    candidates.push(`"${escapedTitle}"`, title);
    const date = title.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/)?.[0];
    if (date !== undefined) candidates.push(`"${date}"`, date);
  }
  return [...new Set(candidates)].filter((query) => query.length <= 200);
}

function requireLiveValue(name: "SQLITE_PATH" | "MEILI_HOST" | "MEILI_MASTER_KEY"): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Live canonical acceptance requires ${name}; value was not provided`);
  }
  return value;
}

function toRankedHit(hit: LiveHit): RankedFragmentHit {
  const positions = hit._matchesPosition ?? {};
  return {
    ...hit,
    matched_fields: {
      text: Object.hasOwn(positions, "text"),
      title: Object.hasOwn(positions, "title"),
      ancestor_labels: Object.hasOwn(positions, "ancestor_labels"),
    },
  };
}

function syntheticHit(
  row: CanonicalFragmentRow,
  matchedFields: RankedFragmentHit["matched_fields"],
): RankedFragmentHit {
  return {
    id: row.fragment_id,
    fragment_id: row.fragment_id,
    block_id: row.block_id,
    document_id: row.document_id,
    primary_release_id: null,
    group_anchor_block_id: row.group_anchor_block_id,
    fragment_kind: "block_text",
    content_kind: "patch_notes",
    posted_at: row.posted_at,
    matched_fields: matchedFields,
  };
}

function assertSafeHydratedPayload(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    "pristine_body",
    "source_locator",
    "original_locator",
    "archive_locator",
    "provenance_json",
    "diagnostic_code",
    "source_node_type",
    "MEILI_MASTER_KEY",
  ]) {
    expect(serialized).not.toContain(forbidden);
  }
  const key = process.env.MEILI_MASTER_KEY;
  if (key !== undefined && key.length > 0) expect(serialized).not.toContain(key);
}

test("the live canonical suite is opt-in and has a dedicated workspace command", () => {
  const packageJson = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };
  expect(packageJson.scripts?.["test:integration"]).toBe(EXPECTED_INTEGRATION_SCRIPT);
  if (LIVE_ENABLED) {
    console.info("LIVE_CANONICAL_ENV=1");
  } else {
    expect(process.env.RUN_LIVE_CANONICAL).not.toBe("1");
  }
});

test("controlled direct fixture selection excludes heading fragments", () => {
  const rows: CanonicalFragmentRow[] = [
    {
      fragment_id: "other-heading",
      block_id: "other-anchor",
      document_id: "doc-b",
      group_anchor_block_id: "other-anchor",
      posted_at: 2,
      block_kind: "heading",
    },
    {
      fragment_id: "other-direct",
      block_id: "other-change",
      document_id: "doc-b",
      group_anchor_block_id: "other-anchor",
      posted_at: 2,
      block_kind: "patch_change",
    },
  ];
  expect(selectCrossDocumentDirectRow(rows, "doc-a")?.fragment_id).toBe("other-direct");
});

test("title-only discovery prioritizes date-bearing full-title phrases", () => {
  const candidates = buildTitleOnlyQueryCandidates([
    "Counter-Strike 2 Update",
    "Release Notes for 10/24/2024",
  ]);
  expect(candidates[0]).toBe('"Release Notes for 10/24/2024"');
  expect(candidates).toContain('"10/24/2024"');
  expect(candidates).toContain("10/24/2024");
});

test("title-match diagnostics are bounded and contain only redacted structural evidence", () => {
  const diagnostics: TitleMatchDiagnostic[] = [];
  const hit = (documentId: string, fields: string[]): LiveHit => ({
    id: `${documentId}-fragment`,
    fragment_id: `${documentId}-fragment`,
    block_id: `${documentId}-block`,
    document_id: documentId,
    primary_release_id: null,
    group_anchor_block_id: null,
    fragment_kind: "block_text",
    content_kind: "patch_notes",
    posted_at: 1,
    _matchesPosition: Object.fromEntries(fields.map((field) => [field, []])),
  });
  for (let index = 0; index < 40; index += 1) {
    const documentId = `doc-${index}`;
    appendTitleMatchDiagnostics(
      diagnostics,
      `private title ${index}`,
      new Map([[documentId, [[0, hit(documentId, ["title", "private_field"])], [1, hit(documentId, ["text"])]]]]),
    );
  }
  expect(diagnostics).toHaveLength(MAX_TITLE_MATCH_DIAGNOSTICS);
  expect(diagnostics[0]).toEqual({
    query_candidate: expect.stringMatching(/^sha256:[a-f0-9]{16}$/),
    document_id: "doc-0",
    projection_count: 2,
    matched_fields: ["text", "title", "unexpected"],
    metadata_paths: [
      "match_position.private_field",
      "match_position.text",
      "match_position.title",
    ],
  });
  expect(JSON.stringify(diagnostics)).not.toContain("private title");
  expect(diagnostics[0]?.metadata_paths).toContain("match_position.private_field");
});

const describeLive = LIVE_ENABLED ? describe : describe.skip;

describeLive("live canonical fragment search and SQLite hydration", () => {
  let db: DatabaseType;
  let meili: Meilisearch;
  let app: ReturnType<typeof buildServer>;

  beforeAll(() => {
    const sqlitePath = requireLiveValue("SQLITE_PATH");
    const meiliHost = requireLiveValue("MEILI_HOST");
    const meiliMasterKey = requireLiveValue("MEILI_MASTER_KEY");
    db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    db.pragma("query_only = ON");
    meili = new Meilisearch({ host: meiliHost, apiKey: meiliMasterKey });
    app = buildServer();
  });

  afterAll(async () => {
    await app?.close();
    if (db?.open) db.close();
  });

  test("uses the canonical private index settings and exact corpus baseline", async () => {
    expect(db.readonly).toBe(true);
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    const counts = db
      .prepare(
        `SELECT
           (SELECT count(*) FROM documents) AS documents,
           (SELECT count(*) FROM external_identifiers WHERE namespace = 'steam_news_gid') AS gids,
           (SELECT count(*) FROM source_locators WHERE namespace = 'steam_news_url') AS locators,
           (SELECT count(*) FROM document_source_heads WHERE source_adapter = 'steam_news') AS heads,
           (SELECT count(*) FROM source_records WHERE source_adapter = 'steam_news') AS revisions,
           (SELECT count(*) FROM documents WHERE parse_status <> 'parsed') AS unresolved,
           (SELECT count(*) FROM document_parse_state WHERE materialization_status <> 'complete') AS incomplete,
           (SELECT count(*) FROM document_parse_state WHERE parser_key = 'steam-news-bbcode') AS bbcode,
           (SELECT count(*) FROM document_parse_state WHERE parser_key = 'steam-patch-plaintext') AS plaintext`,
      )
      .get() as Record<string, number>;
    expect(counts).toMatchObject({
      documents: 274,
      gids: 274,
      locators: 274,
      heads: 274,
      unresolved: 0,
      incomplete: 0,
      bbcode: 224,
      plaintext: 50,
    });
    expect(counts.revisions).toBeGreaterThanOrEqual(274);

    const settings = await meili.index(INDEX_UID).getSettings();
    expect(settings.searchableAttributes).toEqual(["text", "title", "ancestor_labels"]);
    expect(settings.displayedAttributes).toEqual(RETRIEVED_ATTRIBUTES);
    expect(settings.filterableAttributes).toContain("content_kind");
    expect(settings.sortableAttributes).toContain("posted_at");
  });

  test("returns representative filtered searches in Meili rank order using SQLite-only content", async () => {
    const index = meili.index<LiveHit>(INDEX_UID);
    let selected:
      | { query: string; raw: LiveHit[]; response: { hits: Array<Record<string, unknown>> } }
      | undefined;
    for (const query of ["grenade", "mirage", "gameplay", "weapon"]) {
      const raw = (
        await index.search(query, {
          limit: 50,
          filter: PATCH_NOTES_FILTER,
          attributesToRetrieve: RETRIEVED_ATTRIBUTES,
          showMatchesPosition: true,
        })
      ).hits as LiveHit[];
      if (raw.length === 0) continue;
      const response = await app.inject({
        method: "GET",
        url: `/search?q=${encodeURIComponent(query)}&limit=50`,
      });
      expect(response.statusCode).toBe(200);
      selected = { query, raw, response: response.json() };
      break;
    }
    expect(selected, "representative canonical query returned no patch-note hits").toBeDefined();
    const ranked = selected!.raw.map(toRankedHit);
    const requests = collapseRankedGroupHits(ranked);
    const hydrated = hydrateRankedFragments(db, requests);
    expect(hydrated.missing, "every ranked index identifier must resolve in SQLite").toEqual([]);
    expect(selected!.response.hits).toEqual(hydrated.matches);
    expect(
      selected!.response.hits.every((hit) =>
        (hit.context as { document: { content_kind: string } }).document.content_kind ===
        "patch_notes",
      ),
    ).toBe(true);
    assertSafeHydratedPayload(selected!.response);
  });

  test("collapses real anchor and mixed-field identifiers with deterministic retained ranks", () => {
    const rows = db
      .prepare(
        `SELECT sf.id AS fragment_id, sf.block_id, sf.document_id,
                sf.group_anchor_block_id, d.posted_at, b.kind AS block_kind
           FROM search_fragments sf
           JOIN documents d ON d.id = sf.document_id
           JOIN blocks b ON b.id = sf.block_id AND b.document_id = sf.document_id
          WHERE sf.group_anchor_block_id IS NOT NULL
          ORDER BY sf.document_id, sf.fragment_order`,
      )
      .all() as CanonicalFragmentRow[];
    const heading = rows.find((row) => row.block_id === row.group_anchor_block_id);
    const child = rows.find(
      (row) =>
        row.block_id !== row.group_anchor_block_id &&
        row.group_anchor_block_id === heading?.group_anchor_block_id,
    );
    const other = heading === undefined
      ? undefined
      : selectCrossDocumentDirectRow(rows, heading.document_id);
    expect({ heading, child, other }).toMatchObject({
      heading: expect.any(Object),
      child: expect.any(Object),
      other: expect.any(Object),
    });

    const requests = collapseRankedGroupHits([
      syntheticHit(other!, { text: true, title: true, ancestor_labels: false }),
      syntheticHit(child!, { text: false, title: true, ancestor_labels: true }),
      syntheticHit(heading!, { text: true, title: false, ancestor_labels: false }),
      syntheticHit(child!, { text: true, title: false, ancestor_labels: false }),
      syntheticHit(child!, { text: false, title: true, ancestor_labels: false }),
    ]);
    expect(requests.map((request) => [request.kind, request.rank])).toEqual([
      ["direct", 0],
      ["document", 0],
      ["subgroup", 1],
      ["document", 1],
      ["direct", 3],
    ]);
    const hydrated = hydrateRankedFragments(db, requests);
    expect(hydrated.missing).toEqual([]);
    expect(hydrated.matches.map((match) => [match.kind, match.rank])).toEqual([
      ["direct", 0],
      ["document", 0],
      ["subgroup", 1],
      ["document", 1],
      ["direct", 3],
    ]);
    assertSafeHydratedPayload(hydrated);
  });

  test("finds repeated real title-only projections and emits one earliest-rank document", async () => {
    const titles = db
      .prepare("SELECT id, title FROM documents WHERE content_kind = 'patch_notes' ORDER BY id")
      .all() as Array<{ id: string; title: string }>;
    const candidates = buildTitleOnlyQueryCandidates(titles.map(({ title }) => title));
    const index = meili.index<LiveHit>(INDEX_UID);
    let proof:
      | { query: string; documentId: string; raw: LiveHit[]; earliestRank: number }
      | undefined;
    const diagnostics: TitleMatchDiagnostic[] = [];
    for (const query of candidates) {
      const raw = (
        await index.search(query, {
          limit: 50,
          filter: PATCH_NOTES_FILTER,
          attributesToRetrieve: RETRIEVED_ATTRIBUTES,
          showMatchesPosition: true,
        })
      ).hits as LiveHit[];
      const byDocument = Map.groupBy(raw.entries(), ([, hit]) => hit.document_id);
      appendTitleMatchDiagnostics(diagnostics, query, byDocument);
      for (const [documentId, entries] of byDocument) {
        const titleOnly = entries.every(([, hit]) => {
          const fields = Object.keys(hit._matchesPosition ?? {});
          return fields.length === 1 && fields[0] === "title";
        });
        if (entries.length >= 2 && titleOnly) {
          proof = {
            query,
            documentId,
            raw,
            earliestRank: entries[0]![0],
          };
          break;
        }
      }
      if (proof !== undefined) break;
    }
    if (proof === undefined) {
      console.info(`TITLE_MATCH_DIAGNOSTICS ${JSON.stringify(diagnostics)}`);
    }
    expect(proof, "no repeated title-only projection window was found").toBeDefined();

    const response = await app.inject({
      method: "GET",
      url: `/search?q=${encodeURIComponent(proof!.query)}&limit=50`,
    });
    expect(response.statusCode).toBe(200);
    const matching = (response.json().hits as Array<Record<string, unknown>>).filter(
      (hit) => hit.kind === "document" && hit.document_id === proof!.documentId,
    );
    expect(matching).toHaveLength(1);
    expect(matching[0]?.rank).toBe(proof!.earliestRank);
    const expectedTitle = titles.find(({ id }) => id === proof!.documentId)?.title;
    expect((matching[0]?.context as { document: { title: string } }).document.title).toBe(
      expectedTitle,
    );
    assertSafeHydratedPayload(response.json());
  }, 30_000);

  test("browses metadata-free repeated projections as newest-first SQLite documents", async () => {
    const raw = (
      await meili.index<LiveHit>(INDEX_UID).search("", {
        limit: 50,
        filter: PATCH_NOTES_FILTER,
        attributesToRetrieve: RETRIEVED_ATTRIBUTES,
        sort: ["posted_at:desc"],
      })
    ).hits as LiveHit[];
    expect(raw.length).toBeGreaterThan(1);
    expect(raw.every((hit) => Object.keys(hit._matchesPosition ?? {}).length === 0)).toBe(true);
    expect(new Set(raw.map((hit) => hit.document_id)).size).toBeGreaterThan(1);
    expect(new Set(raw.map((hit) => hit.document_id)).size).toBeLessThan(raw.length);

    const firstByDocument = new Map<string, LiveHit>();
    for (const hit of raw) {
      if (!firstByDocument.has(hit.document_id)) firstByDocument.set(hit.document_id, hit);
    }
    const expected = [...firstByDocument.values()]
      .sort(
        (left, right) =>
          right.posted_at - left.posted_at ||
          left.document_id.localeCompare(right.document_id),
      )
      .map((hit) => hit.document_id);
    const response = await app.inject({ method: "GET", url: "/search?limit=50" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { hits: Array<Record<string, unknown>> };
    expect(body.hits.map((hit) => hit.document_id)).toEqual(expected);
    expect(body.hits.every((hit) => hit.kind === "document")).toBe(true);
    for (const hit of body.hits) {
      const row = db
        .prepare("SELECT title FROM documents WHERE id = ?")
        .get(hit.document_id) as { title: string } | undefined;
      expect(row).toBeDefined();
      expect((hit.context as { document: { title: string } }).document.title).toBe(row!.title);
    }
    assertSafeHydratedPayload(body);
  });

  test("records positive completion evidence for the guarded runner", () => {
    console.info("LIVE_CANONICAL_ASSERTIONS_PASSED");
  });
});
