import type { Database } from "better-sqlite3";
import { openDb, sectionId, lineId } from "@cs-patchnotes/shared";
import { parseBody, detectEra } from "./parse/bbcode.js";

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

/** CLI entrypoint for `pipeline parse`. */
export async function runParse(): Promise<void> {
  const db = openDb();
  const { sections, lines, zeroLineUpdates } = parseStoredUpdates(db);
  console.log(
    `parse: wrote ${sections} section(s), ${lines} line(s)` +
      (zeroLineUpdates > 0 ? `; ${zeroLineUpdates} zero-line update(s) surfaced` : ""),
  );
}
