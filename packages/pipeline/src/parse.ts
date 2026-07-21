import type { Database } from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import {
  blockId,
  getCurrentSourceRecord,
  openDb,
  sectionId,
  lineId,
  type BodyFormat,
} from "@cs-patchnotes/shared";
import { parseBody, detectEra } from "./parse/bbcode.js";
import type {
  CanonicalBlockData,
  CanonicalParseOutput,
  ParseDiagnostic,
  PristineSource,
  ReviewedParserOverride,
} from "./parse/contract.js";
import { ParserRegistry } from "./parse/registry.js";
import { steamNewsBbcodeParser } from "./parse/steam-bbcode.js";
import { steamPatchPlaintextParser } from "./parse/steam-plaintext.js";

/**
 * The write-side "parse" stage: read the pristine `raw_body` back from SQLite,
 * split it into sections and lines via the era-aware parser, and upsert those
 * with stable structural IDs (preserving parent→child nesting).
 *
 * Because it reads the stored raw body (never the network), the corpus can be
 * re-parsed at any time without re-fetching. IDs are deterministic ordinals
 * anchored on the Valve gid (`section.id = gid_idx`, `line.id = section_idx`),
 * so re-running upserts the same rows — no duplicates.
 */

interface StoredUpdate {
  id: string;
  game: string;
  raw_body: string;
  posted_at: number;
}

/** Counts written by a parse pass. */
export interface ParseResult {
  sections: number;
  lines: number;
  /** Updates that matched an era but produced zero lines (surfaced loudly). */
  zeroLineUpdates: number;
}

export interface ParseRunSummary {
  runId: string;
  attempted: number;
  selected: number;
  unchanged: number;
  materialized: number;
  quarantined: number;
  partial: number;
  errors: number;
  gateFailed: boolean;
}

export interface ParseStoredDocumentsOptions {
  runId?: string;
  now?: () => number;
}

export interface RunParseOptions extends ParseStoredDocumentsOptions {
  db?: Database;
  registry?: ParserRegistry;
  log?: (message: string) => void;
}

interface CurrentSourceKey {
  document_id: string;
  source_adapter: string;
}

interface StoredOverride {
  parser_key: string;
  reviewed_by: string;
  reason: string;
  reviewed_at: number;
}

interface ExistingParseState {
  source_record_id: string;
  selection_state: string;
  parser_key: string | null;
  parser_version: string | null;
  materialization_status: string;
  output_sha256: string | null;
}

const MAX_OUTPUT_BLOCKS = 10_000;
const MAX_OUTPUT_MEDIA_ITEMS = 2_000;
const MAX_OUTPUT_DIAGNOSTICS = 32;
const MAX_DIAGNOSTIC_DETAILS = 8;
const MAX_DIAGNOSTIC_STRING = 160;

function asPristineSource(
  row: ReturnType<typeof getCurrentSourceRecord> extends infer T ? Exclude<T, undefined> : never,
): PristineSource {
  return {
    documentId: row.document_id,
    sourceRecordId: row.id,
    sourceAdapter: row.source_adapter,
    bodyFormat: row.body_format as BodyFormat,
    pristineBody: row.pristine_body,
    bodySha256: row.body_sha256,
  };
}

function readOverride(
  db: Database,
  documentId: string,
  sourceAdapter: string,
): ReviewedParserOverride | undefined {
  const row = db
    .prepare(
      `SELECT parser_key, reviewed_by, reason, reviewed_at
         FROM parser_overrides
        WHERE document_id = ? AND source_adapter = ?`,
    )
    .get(documentId, sourceAdapter) as StoredOverride | undefined;
  return row === undefined
    ? undefined
    : {
        parserKey: row.parser_key,
        reviewedBy: row.reviewed_by,
        reason: row.reason,
        reviewedAt: row.reviewed_at,
      };
}

function outputSha256(output: CanonicalParseOutput): string {
  return createHash("sha256").update(JSON.stringify(output), "utf8").digest("hex");
}

function validateSpan(source: PristineSource, start: number, end: number): void {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > source.pristineBody.length
  ) {
    throw new Error("Parser output contains an invalid UTF-16 source span");
  }
}

function validateOutput(source: PristineSource, output: CanonicalParseOutput): void {
  if (output.blocks.length > MAX_OUTPUT_BLOCKS) {
    throw new Error(`Parser output exceeds ${MAX_OUTPUT_BLOCKS} blocks`);
  }
  if ((output.mediaItems?.length ?? 0) > MAX_OUTPUT_MEDIA_ITEMS) {
    throw new Error(`Parser output exceeds ${MAX_OUTPUT_MEDIA_ITEMS} media items`);
  }
  if (output.diagnostics.length > MAX_OUTPUT_DIAGNOSTICS) {
    throw new Error(`Parser output exceeds ${MAX_OUTPUT_DIAGNOSTICS} diagnostics`);
  }

  output.blocks.forEach((block, index) => {
    validateSpan(source, block.sourceSpan.start, block.sourceSpan.end);
    if (
      block.parentIndex !== null &&
      (!Number.isSafeInteger(block.parentIndex) || block.parentIndex < 0 || block.parentIndex >= index)
    ) {
      throw new Error("Parser output parent must precede its child");
    }
    if ((block.text?.length ?? 0) > 20_000 || (block.label?.length ?? 0) > 2_000) {
      throw new Error("Parser output text exceeds the canonical bound");
    }
  });

  for (const media of output.mediaItems ?? []) {
    validateSpan(source, media.sourceSpan.start, media.sourceSpan.end);
    const owner = output.blocks[media.groupBlockIndex];
    if (owner?.kind !== "media_group") {
      throw new Error("Parser media item must reference a preceding media_group block");
    }
  }

  for (const diagnostic of output.diagnostics) {
    if (diagnostic.sourceSpan !== null) {
      validateSpan(source, diagnostic.sourceSpan.start, diagnostic.sourceSpan.end);
    }
  }
}

function siblingOrders(blocks: readonly CanonicalBlockData[]): number[] {
  const counts = new Map<number | null, number>();
  return blocks.map((block) => {
    const order = counts.get(block.parentIndex) ?? 0;
    counts.set(block.parentIndex, order + 1);
    return order;
  });
}

function boundedDetails(source: PristineSource, details: ParseDiagnostic["details"]): string {
  const environment = new Set(
    Object.values(process.env).filter(
      (value): value is string => typeof value === "string" && value.length >= 8,
    ),
  );
  const bounded = Object.fromEntries(
    Object.entries(details)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, MAX_DIAGNOSTIC_DETAILS)
      .map(([key, value]) => {
        if (Array.isArray(value)) {
          return [
            key.slice(0, 64),
            value.slice(0, 8).map((entry) =>
              environment.has(entry) || (entry.length >= 16 && source.pristineBody.includes(entry))
                ? "[redacted]"
                : entry.replace(/https?:\/\/\S+/gi, "[url]").slice(0, MAX_DIAGNOSTIC_STRING),
            ),
          ];
        }
        if (typeof value !== "string") return [key.slice(0, 64), value];
        const redacted =
          environment.has(value) ||
          value === source.pristineBody ||
          (value.length >= 16 && source.pristineBody.includes(value))
            ? "[redacted]"
            : value.replace(/https?:\/\/\S+/gi, "[url]").replace(/[\r\n\t]+/g, " ");
        return [key.slice(0, 64), redacted.slice(0, MAX_DIAGNOSTIC_STRING)];
      }),
  );
  return JSON.stringify(bounded);
}

function persistDiagnostic(
  db: Database,
  runId: string,
  source: PristineSource,
  diagnostic: ParseDiagnostic,
  createdAt: number,
): void {
  db.prepare(
    `INSERT INTO parse_diagnostics
       (id, parse_run_id, document_id, source_record_id, severity, code,
        source_start, source_end, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    runId,
    source.documentId,
    source.sourceRecordId,
    diagnostic.severity,
    diagnostic.code.slice(0, 64) || "UNSPECIFIED",
    diagnostic.sourceSpan?.start ?? null,
    diagnostic.sourceSpan?.end ?? null,
    boundedDetails(source, diagnostic.details),
    createdAt,
  );
}

function persistSelectionState(
  db: Database,
  source: PristineSource,
  input: {
    selectionState: "selected" | "quarantined_zero_match" | "quarantined_multiple_match";
    parserKey: string | null;
    parserVersion: string | null;
    evidenceJson: string;
    materializationStatus: "unparsed" | "complete" | "partial" | "failed";
    outputHash: string | null;
    runId: string;
    updatedAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO document_parse_state
       (document_id, source_adapter, source_record_id, selection_state,
        parser_key, parser_version, detector_evidence_json, grouping_policy_version,
        materialization_status, output_sha256, last_parse_run_id, updated_at)
     VALUES
       (@document_id, @source_adapter, @source_record_id, @selection_state,
        @parser_key, @parser_version, @detector_evidence_json, NULL,
        @materialization_status, @output_sha256, @last_parse_run_id, @updated_at)
     ON CONFLICT(document_id, source_adapter) DO UPDATE SET
       source_record_id = excluded.source_record_id,
       selection_state = excluded.selection_state,
       parser_key = excluded.parser_key,
       parser_version = excluded.parser_version,
       detector_evidence_json = excluded.detector_evidence_json,
       grouping_policy_version = excluded.grouping_policy_version,
       materialization_status = excluded.materialization_status,
       output_sha256 = excluded.output_sha256,
       last_parse_run_id = excluded.last_parse_run_id,
       updated_at = excluded.updated_at`,
  ).run({
    document_id: source.documentId,
    source_adapter: source.sourceAdapter,
    source_record_id: source.sourceRecordId,
    selection_state: input.selectionState,
    parser_key: input.parserKey,
    parser_version: input.parserVersion,
    detector_evidence_json: input.evidenceJson,
    materialization_status: input.materializationStatus,
    output_sha256: input.outputHash,
    last_parse_run_id: input.runId,
    updated_at: input.updatedAt,
  });
}

function replaceCanonicalBlocks(
  db: Database,
  source: PristineSource,
  output: CanonicalParseOutput,
): void {
  db.prepare("DELETE FROM search_fragments WHERE document_id = ?").run(source.documentId);
  db.prepare("DELETE FROM media_items WHERE document_id = ?").run(source.documentId);
  const existing = db
    .prepare("SELECT id FROM blocks WHERE document_id = ? ORDER BY preorder DESC")
    .all(source.documentId) as Array<{ id: string }>;
  const deleteBlock = db.prepare("DELETE FROM blocks WHERE id = ?");
  for (const row of existing) deleteBlock.run(row.id);

  const orders = siblingOrders(output.blocks);
  const insertBlock = db.prepare(
    `INSERT INTO blocks
       (id, document_id, parent_block_id, kind, preorder, sibling_order, text, label,
        source_start, source_end, source_node_type, diagnostic_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  output.blocks.forEach((block, index) => {
    insertBlock.run(
      blockId(source.documentId, index),
      source.documentId,
      block.parentIndex === null ? null : blockId(source.documentId, block.parentIndex),
      block.kind,
      index,
      orders[index],
      block.text,
      block.label,
      block.sourceSpan.start,
      block.sourceSpan.end,
      block.sourceNodeType,
      block.diagnosticCode,
    );
  });

  const insertMedia = db.prepare(
    `INSERT INTO media_items
       (id, document_id, group_block_id, item_order, media_kind, original_locator,
        archive_locator, caption, alt_text, provenance_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  );
  const mediaOrder = new Map<number, number>();
  for (const media of output.mediaItems ?? []) {
    const order = mediaOrder.get(media.groupBlockIndex) ?? 0;
    mediaOrder.set(media.groupBlockIndex, order + 1);
    insertMedia.run(
      `${blockId(source.documentId, media.groupBlockIndex)}_m${order}`,
      source.documentId,
      blockId(source.documentId, media.groupBlockIndex),
      order,
      media.mediaKind,
      media.originalLocator,
      media.archiveLocator,
      media.caption,
      media.altText,
    );
  }
}

/**
 * Parse every stored update's raw body into sections + lines and upsert them.
 * All writes run in a single transaction. Re-running reproduces identical IDs
 * and rows (idempotent). An update that matches an era yet yields zero lines is
 * logged loudly (never silently dropped) and counted for reporting.
 */
export function parseStoredUpdates(db: Database): ParseResult {
  const updates = db
    .prepare("SELECT id, game, raw_body, posted_at FROM updates")
    .all() as StoredUpdate[];

  const sectionStmt = db.prepare(`
    INSERT INTO sections (id, update_id, section_index, header)
    VALUES (@id, @update_id, @section_index, @header)
    ON CONFLICT(id) DO UPDATE SET
      update_id     = excluded.update_id,
      section_index = excluded.section_index,
      header        = excluded.header
  `);

  const lineStmt = db.prepare(`
    INSERT INTO lines (id, section_id, update_id, line_index, text, game, subheader, parent_line_index)
    VALUES (@id, @section_id, @update_id, @line_index, @text, @game, @subheader, @parent_line_index)
    ON CONFLICT(id) DO UPDATE SET
      section_id        = excluded.section_id,
      update_id         = excluded.update_id,
      line_index        = excluded.line_index,
      text              = excluded.text,
      game              = excluded.game,
      subheader         = excluded.subheader,
      parent_line_index = excluded.parent_line_index
  `);

  // Index-scoped orphan prunes. These delete ONLY the tail rows a freshly
  // shrunk parse no longer produces — never a blanket per-update delete. A
  // blanket `DELETE FROM sections WHERE update_id = ?` would cascade through
  // `lines` into `line_tags` on EVERY parse, silently wiping downstream
  // classification for unchanged notes. Scoping the delete to indices at or
  // beyond the new counts means an unchanged/grown re-parse deletes zero rows
  // (preserving `line_tags`), while a shrink removes exactly the stale tail.
  const pruneSectionsStmt = db.prepare(
    "DELETE FROM sections WHERE update_id = @update_id AND section_index >= @section_count",
  );
  const pruneLinesStmt = db.prepare(
    "DELETE FROM lines WHERE section_id = @section_id AND line_index >= @line_count",
  );

  const result: ParseResult = { sections: 0, lines: 0, zeroLineUpdates: 0 };

  const tx = db.transaction((rows: StoredUpdate[]) => {
    for (const update of rows) {
      const parsed = parseBody(update.raw_body, update.posted_at);
      let linesForUpdate = 0;

      parsed.forEach((section, sectionIndex) => {
        const sid = sectionId(update.id, sectionIndex);
        sectionStmt.run({
          id: sid,
          update_id: update.id,
          section_index: sectionIndex,
          header: section.header,
        });
        result.sections += 1;

        section.lines.forEach((line, lineIndex) => {
          lineStmt.run({
            id: lineId(sid, lineIndex),
            section_id: sid,
            update_id: update.id,
            line_index: lineIndex,
            text: line.text, // extract the cleaned string — never the whole ParsedLine
            game: update.game, // carry game from the parent update
            subheader: line.subheader,
            parent_line_index: line.parentLineIndex,
          });
          result.lines += 1;
          linesForUpdate += 1;
        });

        // Within this surviving section, drop only the shrunk tail lines.
        pruneLinesStmt.run({ section_id: sid, line_count: section.lines.length });
      });

      // Drop sections beyond the new count; their lines (and cascaded line_tags)
      // fall away via ON DELETE CASCADE because those sections no longer exist.
      pruneSectionsStmt.run({ update_id: update.id, section_count: parsed.length });

      // Loud-not-silent: a note that matched an era but produced no lines is a
      // parser-drift signal, never a silent drop.
      if (linesForUpdate === 0) {
        result.zeroLineUpdates += 1;
        const era = detectEra(update.raw_body, update.posted_at);
        console.warn(
          `parse: update ${update.id} (era ${era}) produced ZERO lines — not dropped, surfaced for review`,
        );
      }
    }
  });

  tx(updates);
  return result;
}

/**
 * Evaluate and persist parser selection for every explicit current source head.
 * Each source commits independently so one quarantine or parser failure cannot
 * hide the terminal state of any other source in the complete pass.
 */
export function parseStoredDocuments(
  db: Database,
  registry: ParserRegistry,
  options: ParseStoredDocumentsOptions = {},
): ParseRunSummary {
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  const runId = options.runId ?? randomUUID();
  const summary: ParseRunSummary = {
    runId,
    attempted: 0,
    selected: 0,
    unchanged: 0,
    materialized: 0,
    quarantined: 0,
    partial: 0,
    errors: 0,
    gateFailed: false,
  };

  db.prepare(
    `INSERT INTO parse_runs (id, started_at, status)
     VALUES (?, ?, 'running')`,
  ).run(runId, now());

  const heads = db
    .prepare(
      `SELECT document_id, source_adapter
         FROM document_source_heads
        ORDER BY document_id, source_adapter`,
    )
    .all() as CurrentSourceKey[];

  for (const head of heads) {
    summary.attempted += 1;
    const sourceRow = getCurrentSourceRecord(db, head.document_id, head.source_adapter);
    if (sourceRow === undefined) {
      summary.errors += 1;
      continue;
    }
    const source = asPristineSource(sourceRow);
    const changedAt = now();
    let selectedForAttempt:
      | { parserKey: string; parserVersion: string; evidenceJson: string }
      | undefined;

    try {
      const override = readOverride(db, source.documentId, source.sourceAdapter);
      const selection = registry.selectParser(source, override);
      const evidenceJson = JSON.stringify(selection.evidence);

      if (selection.status === "quarantined") {
        const selectionState =
          selection.reason === "zero_match"
            ? "quarantined_zero_match"
            : "quarantined_multiple_match";
        const code =
          selection.reason === "zero_match" ? "PARSER_ZERO_MATCH" : "PARSER_MULTIPLE_MATCH";
        const persist = db.transaction(() => {
          persistSelectionState(db, source, {
            selectionState,
            parserKey: null,
            parserVersion: null,
            evidenceJson,
            materializationStatus: "unparsed",
            outputHash: null,
            runId,
            updatedAt: changedAt,
          });
          persistDiagnostic(
            db,
            runId,
            source,
            {
              severity: "error",
              code,
              sourceSpan: null,
              details: { candidateKeys: selection.matchKeys },
            },
            changedAt,
          );
          db.prepare("UPDATE documents SET parse_status = 'quarantined' WHERE id = ?").run(
            source.documentId,
          );
        });
        persist();
        summary.quarantined += 1;
        continue;
      }

      summary.selected += 1;
      selectedForAttempt = {
        parserKey: selection.parserKey,
        parserVersion: selection.parserVersion,
        evidenceJson,
      };
      const existing = db
        .prepare(
          `SELECT source_record_id, selection_state, parser_key, parser_version,
                  materialization_status, output_sha256
             FROM document_parse_state
            WHERE document_id = ? AND source_adapter = ?`,
        )
        .get(source.documentId, source.sourceAdapter) as ExistingParseState | undefined;
      const unchanged =
        existing?.source_record_id === source.sourceRecordId &&
        existing.selection_state === "selected" &&
        existing.parser_key === selection.parserKey &&
        existing.parser_version === selection.parserVersion &&
        existing.materialization_status === "complete";

      if (unchanged) {
        persistSelectionState(db, source, {
          selectionState: "selected",
          parserKey: selection.parserKey,
          parserVersion: selection.parserVersion,
          evidenceJson,
          materializationStatus: "complete",
          outputHash: existing.output_sha256,
          runId,
          updatedAt: changedAt,
        });
        db.prepare("UPDATE documents SET parse_status = 'parsed' WHERE id = ?").run(
          source.documentId,
        );
        summary.unchanged += 1;
        continue;
      }

      persistSelectionState(db, source, {
        selectionState: "selected",
        parserKey: selection.parserKey,
        parserVersion: selection.parserVersion,
        evidenceJson,
        materializationStatus: "unparsed",
        outputHash: null,
        runId,
        updatedAt: changedAt,
      });

      const output = selection.parser.parse(source);
      validateOutput(source, output);
      const hash = outputSha256(output);
      const persist = db.transaction(() => {
        replaceCanonicalBlocks(db, source, output);
        persistSelectionState(db, source, {
          selectionState: "selected",
          parserKey: selection.parserKey,
          parserVersion: selection.parserVersion,
          evidenceJson,
          materializationStatus: output.status,
          outputHash: hash,
          runId,
          updatedAt: changedAt,
        });
        for (const diagnostic of output.diagnostics.slice(0, MAX_OUTPUT_DIAGNOSTICS)) {
          persistDiagnostic(db, runId, source, diagnostic, changedAt);
        }
        db.prepare("UPDATE documents SET parse_status = ? WHERE id = ?").run(
          output.status === "partial" ? "partial" : "parsed",
          source.documentId,
        );
      });
      persist();
      summary.materialized += 1;
      if (output.status === "partial") summary.partial += 1;
    } catch (error) {
      summary.errors += 1;
      const message = error instanceof Error ? error.message : "unknown parser failure";
      const hasSelectedParser = selectedForAttempt !== undefined;
      const persistFailure = db.transaction(() => {
        persistSelectionState(db, source, {
          selectionState: hasSelectedParser ? "selected" : "quarantined_zero_match",
          parserKey: selectedForAttempt?.parserKey ?? null,
          parserVersion: selectedForAttempt?.parserVersion ?? null,
          evidenceJson: selectedForAttempt?.evidenceJson ?? "[]",
          materializationStatus: hasSelectedParser ? "failed" : "unparsed",
          outputHash: null,
          runId,
          updatedAt: changedAt,
        });
        persistDiagnostic(
          db,
          runId,
          source,
          {
            severity: "error",
            code: hasSelectedParser ? "PARSER_EXECUTION_FAILED" : "PARSER_SELECTION_FAILED",
            sourceSpan: null,
            details: { errorType: error instanceof Error ? error.name : "UnknownError", message },
          },
          changedAt,
        );
        db.prepare("UPDATE documents SET parse_status = 'failed' WHERE id = ?").run(
          source.documentId,
        );
      });
      persistFailure();
      if (!hasSelectedParser) summary.quarantined += 1;
    }
  }

  summary.gateFailed =
    summary.quarantined > 0 || summary.partial > 0 || summary.errors > 0;
  db.prepare(
    `UPDATE parse_runs
        SET completed_at = ?,
            status = ?,
            attempted_count = ?,
            selected_count = ?,
            unchanged_count = ?,
            partial_count = ?,
            quarantined_count = ?,
            error_count = ?
      WHERE id = ?`,
  ).run(
    now(),
    summary.gateFailed ? "failed" : "succeeded",
    summary.attempted,
    summary.selected,
    summary.unchanged,
    summary.partial,
    summary.quarantined,
    summary.errors,
    runId,
  );

  return summary;
}

function summaryLine(summary: ParseRunSummary): string {
  return (
    `parse: attempted=${summary.attempted} selected=${summary.selected}` +
    ` unchanged=${summary.unchanged} materialized=${summary.materialized}` +
    ` quarantined=${summary.quarantined} partial=${summary.partial} errors=${summary.errors}`
  );
}

/** CLI entrypoint for the complete canonical parse pass. */
export async function runParse(options: RunParseOptions = {}): Promise<void> {
  const ownsDb = options.db === undefined;
  const db = options.db ?? openDb();
  const registry = options.registry ?? new ParserRegistry([
    steamNewsBbcodeParser,
    steamPatchPlaintextParser,
  ]);
  try {
    const summary = parseStoredDocuments(db, registry, options);
    (options.log ?? console.log)(summaryLine(summary));
    if (summary.gateFailed) {
      throw new Error("Parse gate failed after the complete source pass");
    }
  } finally {
    if (ownsDb) db.close();
  }
}
