/**
 * The load-bearing structural-ID contract.
 *
 * Both the ingestion pipeline (writes) and the read API import these three
 * helpers so there is exactly one definition of "what a line is". The IDs are
 * purely structural — derived from the Valve gid and document ordinals, never
 * from the note text or a body hash:
 *
 *   update.id  = gid
 *   section.id = `${update_id}_${section_index}`
 *   line.id    = `${section_id}_${line_index}`
 *
 * The separator is `_` (not `:`) so a structural ID is a valid Meilisearch
 * document primary key as-is: Meili keys allow only `[a-zA-Z0-9_-]`, so a colon
 * would be rejected. Keeping the separator index-safe makes the source-of-truth
 * ID and the index document ID identical — no transform layer, no drift.
 *
 * These ordinals are stable ONLY while the parser is deterministic: given the
 * same input, the parser must always emit sections and lines in the same order.
 * Deriving an ID from the text (e.g. hashing the body) would break idempotent
 * upserts — do not do it. Never duplicate this string-concat logic elsewhere.
 */

/** Returns the Valve gid unchanged. The update ID is the gid, never a hash. */
export const updateId = (gid: string): string => gid;

/** Composes a section ID from its parent update ID and its section ordinal. */
export const sectionId = (updateId: string, i: number): string => `${updateId}_${i}`;

/** Composes a line ID from its parent section ID and its line ordinal. */
export const lineId = (sectionId: string, i: number): string => `${sectionId}_${i}`;
