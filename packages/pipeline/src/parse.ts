import type { Database } from "better-sqlite3";
import { openDb, sectionId, lineId } from "@cs-patchnotes/shared";
import { parseCs2Body } from "./parse/bbcode.js";

/**
 * The write-side "parse" stage: read the pristine `raw_body` back from SQLite,
 * split it into sections and lines via the CS2 parser, and upsert those with
 * stable structural IDs.
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
}

/** Counts written by a parse pass. */
export interface ParseResult {
  sections: number;
  lines: number;
}

/**
 * Parse every stored update's raw body into sections + lines and upsert them.
 * All writes run in a single transaction. Re-running reproduces identical IDs
 * and rows (idempotent).
 */
export function parseStoredUpdates(db: Database): ParseResult {
  const updates = db
    .prepare("SELECT id, game, raw_body FROM updates")
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
    INSERT INTO lines (id, section_id, update_id, line_index, text, game)
    VALUES (@id, @section_id, @update_id, @line_index, @text, @game)
    ON CONFLICT(id) DO UPDATE SET
      section_id = excluded.section_id,
      update_id  = excluded.update_id,
      line_index = excluded.line_index,
      text       = excluded.text,
      game       = excluded.game
  `);

  const result: ParseResult = { sections: 0, lines: 0 };

  const tx = db.transaction((rows: StoredUpdate[]) => {
    for (const update of rows) {
      const parsed = parseCs2Body(update.raw_body);
      parsed.forEach((section, sectionIndex) => {
        const sid = sectionId(update.id, sectionIndex);
        sectionStmt.run({
          id: sid,
          update_id: update.id,
          section_index: sectionIndex,
          header: section.header,
        });
        result.sections += 1;

        section.lines.forEach((text, lineIndex) => {
          lineStmt.run({
            id: lineId(sid, lineIndex),
            section_id: sid,
            update_id: update.id,
            line_index: lineIndex,
            text,
            game: update.game, // carry game from the parent update
          });
          result.lines += 1;
        });
      });
    }
  });

  tx(updates);
  return result;
}

/** CLI entrypoint for `pipeline parse`. */
export async function runParse(): Promise<void> {
  const db = openDb();
  const { sections, lines } = parseStoredUpdates(db);
  console.log(`parse: wrote ${sections} section(s), ${lines} line(s)`);
}
