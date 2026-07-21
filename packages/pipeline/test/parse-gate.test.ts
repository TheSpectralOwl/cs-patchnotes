import { describe, expect, test, vi } from "vitest";
import {
  openDb,
  upsertSteamSourceRecord,
  type Game,
} from "@cs-patchnotes/shared";
import type {
  CanonicalParseOutput,
  DetectionEvidence,
  RegisteredParser,
} from "../src/parse/contract.js";
import { ParserRegistry } from "../src/parse/registry.js";
import {
  parseStoredDocuments,
  runParse,
  type ParseRunSummary,
} from "../src/parse.js";

function parser(key: string, marker: string): RegisteredParser {
  return {
    key,
    version: "1.0.0",
    detect: (source): DetectionEvidence => ({
      matched: source.pristineBody.includes(marker),
      codes: [source.pristineBody.includes(marker) ? "MARKER_MATCH" : "MARKER_MISS"],
      spans: [],
      details: { markerLength: marker.length },
    }),
    parse: (): CanonicalParseOutput => ({ status: "complete", blocks: [], diagnostics: [] }),
  };
}

function seed(
  db: ReturnType<typeof openDb>,
  gid: string,
  body: string,
  game: Game = "cs2",
): string {
  return upsertSteamSourceRecord(db, {
    gid,
    url: `https://example.test/news/${gid}`,
    title: `Update ${gid}`,
    posted_at: 1_700_000_000,
    game,
    channel: "mainline",
    content_kind: "patch_notes",
    source_adapter: "steam_news",
    body_format: "plain_text",
    pristine_body: body,
    fetched_at: 1_700_000_001,
  }).document.id;
}

interface StateRow {
  document_id: string;
  selection_state: string;
  parser_key: string | null;
  parser_version: string | null;
  detector_evidence_json: string;
}

describe("complete parse gate", () => {
  test("attempts every current source and persists one terminal selection state before reporting failure", () => {
    const db = openDb(":memory:");
    const selectedId = seed(db, "selected", "ALPHA only");
    const zeroId = seed(db, "zero", "neither marker");
    const multipleId = seed(db, "multiple", "ALPHA and BETA");
    const registry = new ParserRegistry([parser("alpha", "ALPHA"), parser("beta", "BETA")]);

    const summary = parseStoredDocuments(db, registry, {
      runId: "run-complete-gate",
      now: () => 1_700_000_100,
    });
    const states = db
      .prepare("SELECT * FROM document_parse_state ORDER BY document_id")
      .all() as StateRow[];

    expect(summary).toMatchObject<Partial<ParseRunSummary>>({
      attempted: 3,
      selected: 1,
      materialized: 1,
      quarantined: 2,
      partial: 0,
      errors: 0,
      gateFailed: true,
    });
    expect(states).toHaveLength(3);
    expect(states.find((row) => row.document_id === selectedId)).toMatchObject({
      selection_state: "selected",
      parser_key: "alpha",
      parser_version: "1.0.0",
    });
    expect(states.find((row) => row.document_id === zeroId)?.selection_state).toBe(
      "quarantined_zero_match",
    );
    expect(states.find((row) => row.document_id === multipleId)?.selection_state).toBe(
      "quarantined_multiple_match",
    );

    const run = db.prepare("SELECT * FROM parse_runs WHERE id = ?").get("run-complete-gate") as {
      status: string;
      attempted_count: number;
      selected_count: number;
      quarantined_count: number;
    };
    expect(run).toMatchObject({
      status: "failed",
      attempted_count: 3,
      selected_count: 1,
      quarantined_count: 2,
    });
    db.close();
  });

  test("records bounded zero/multiple diagnostics and candidate evidence without source or secret disclosure", () => {
    const db = openDb(":memory:");
    const secret = "not-for-diagnostics";
    seed(db, "zero", `unrecognized ${secret}`);
    seed(db, "multiple", `ALPHA BETA ${secret}`);
    const registry = new ParserRegistry([parser("alpha", "ALPHA"), parser("beta", "BETA")]);

    parseStoredDocuments(db, registry, {
      runId: "run-diagnostics",
      now: () => 1_700_000_200,
    });
    const rows = db
      .prepare(
        "SELECT code, source_start, source_end, details_json FROM parse_diagnostics WHERE parse_run_id = ? ORDER BY code",
      )
      .all("run-diagnostics") as Array<{
      code: string;
      source_start: number | null;
      source_end: number | null;
      details_json: string;
    }>;
    const serialized = JSON.stringify(rows);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.code)).toEqual([
      "PARSER_MULTIPLE_MATCH",
      "PARSER_ZERO_MATCH",
    ]);
    expect(JSON.parse(rows[0].details_json)).toMatchObject({ candidateKeys: ["alpha", "beta"] });
    expect(rows.every((row) => row.source_start === null && row.source_end === null)).toBe(true);
    expect(serialized.length).toBeLessThan(2_000);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("unrecognized");
    db.close();
  });

  test("keeps a successful document committed when another parser throws", () => {
    const db = openDb(":memory:");
    const goodId = seed(db, "good", "GOOD");
    const badId = seed(db, "bad", "BAD");
    const good = parser("good", "GOOD");
    const bad: RegisteredParser = {
      ...parser("bad", "BAD"),
      parse: () => {
        throw new Error("deliberate parser failure");
      },
    };

    const summary = parseStoredDocuments(db, new ParserRegistry([good, bad]), {
      runId: "run-isolated-errors",
      now: () => 1_700_000_300,
    });
    const states = db
      .prepare("SELECT * FROM document_parse_state ORDER BY document_id")
      .all() as StateRow[];

    expect(summary).toMatchObject({ attempted: 2, selected: 2, materialized: 1, errors: 1 });
    expect(states.find((row) => row.document_id === goodId)).toMatchObject({
      selection_state: "selected",
      parser_key: "good",
    });
    expect(states.find((row) => row.document_id === badId)).toMatchObject({
      selection_state: "selected",
      parser_key: "bad",
    });
    db.close();
  });

  test("keeps unsupported blocks visible and gates a newly partial document", () => {
    const db = openDb(":memory:");
    const documentId = seed(db, "partial", "MATCH");
    const partial: RegisteredParser = {
      ...parser("partial", "MATCH"),
      parse: (): CanonicalParseOutput => ({
        status: "partial",
        blocks: [
          {
            kind: "unsupported",
            parentIndex: null,
            text: null,
            label: null,
            sourceSpan: { start: 0, end: 5 },
            sourceNodeType: "unknown_construct",
            diagnosticCode: "UNSUPPORTED_CONSTRUCT",
          },
        ],
        diagnostics: [
          {
            severity: "error",
            code: "UNSUPPORTED_CONSTRUCT",
            sourceSpan: { start: 0, end: 5 },
            details: { construct: "unknown_construct" },
          },
        ],
      }),
    };

    const summary = parseStoredDocuments(db, new ParserRegistry([partial]), {
      runId: "run-partial",
      now: () => 1_700_000_350,
    });
    const block = db
      .prepare("SELECT kind, diagnostic_code FROM blocks WHERE document_id = ?")
      .get(documentId) as { kind: string; diagnostic_code: string };

    expect(summary).toMatchObject({
      attempted: 1,
      selected: 1,
      materialized: 1,
      partial: 1,
      gateFailed: true,
    });
    expect(block).toEqual({ kind: "unsupported", diagnostic_code: "UNSUPPORTED_CONSTRUCT" });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM search_fragments WHERE document_id = ?").get(
        documentId,
      ),
    ).toEqual({ count: 0 });
    expect(db.prepare("SELECT parse_status FROM documents WHERE id = ?").get(documentId)).toEqual({
      parse_status: "partial",
    });
    db.close();
  });

  test("retains prior canonical blocks when a later pass quarantines the source", () => {
    const db = openDb(":memory:");
    const documentId = seed(db, "retained", "MATCH");
    const complete: RegisteredParser = {
      ...parser("complete", "MATCH"),
      parse: (): CanonicalParseOutput => ({
        status: "complete",
        blocks: [
          {
            kind: "paragraph",
            parentIndex: null,
            text: "Previously materialized text",
            label: null,
            sourceSpan: { start: 0, end: 5 },
            sourceNodeType: "plain_text",
            diagnosticCode: null,
          },
        ],
        diagnostics: [],
      }),
    };
    parseStoredDocuments(db, new ParserRegistry([complete]), {
      runId: "run-before-quarantine",
      now: () => 1_700_000_360,
    });

    const summary = parseStoredDocuments(db, new ParserRegistry([parser("miss", "NEVER")]), {
      runId: "run-after-quarantine",
      now: () => 1_700_000_361,
    });
    const retained = db
      .prepare("SELECT kind, text FROM blocks WHERE document_id = ?")
      .all(documentId);

    expect(summary).toMatchObject({ attempted: 1, quarantined: 1, gateFailed: true });
    expect(retained).toEqual([{ kind: "paragraph", text: "Previously materialized text" }]);
    expect(
      db
        .prepare("SELECT selection_state FROM document_parse_state WHERE document_id = ?")
        .get(documentId),
    ).toEqual({ selection_state: "quarantined_zero_match" });
    db.close();
  });

  test("prints exactly one complete summary before runParse rejects the non-zero gate", async () => {
    const db = openDb(":memory:");
    seed(db, "selected", "ALPHA");
    seed(db, "quarantined", "no marker");
    const log = vi.fn();

    await expect(
      runParse({
        db,
        registry: new ParserRegistry([parser("alpha", "ALPHA")]),
        log,
        runId: "run-cli-gate",
        now: () => 1_700_000_400,
      }),
    ).rejects.toThrow(/parse gate failed/i);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(
      /attempted=2 selected=1 unchanged=0 materialized=1 quarantined=1 partial=0 errors=0/,
    );
    const persisted = db.prepare("SELECT attempted_count FROM parse_runs WHERE id = ?").get("run-cli-gate") as {
      attempted_count: number;
    };
    expect(persisted.attempted_count).toBe(2);
    db.close();
  });
});
