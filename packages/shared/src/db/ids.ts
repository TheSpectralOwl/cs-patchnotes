/**
 * The load-bearing structural-ID contract.
 *
 * Both the ingestion pipeline (writes) and the read API import these three
 * helpers so there is exactly one definition of "what a line is". The IDs are
 * purely structural — derived from the Valve gid and document ordinals, never
 * from the note text or a body hash:
 *
 *   update.id  = gid
 *   section.id = `${update_id}:${section_index}`
 *   line.id    = `${section_id}:${line_index}`
 *
 * These ordinals are stable ONLY while the parser is deterministic: given the
 * same input, the parser must always emit sections and lines in the same order.
 * Deriving an ID from the text (e.g. hashing the body) would break idempotent
 * upserts — do not do it. Never duplicate this string-concat logic elsewhere.
 */

/** Returns the Valve gid unchanged. The update ID is the gid, never a hash. */
export const updateId = (gid: string): string => gid;

/** Composes a section ID from its parent update ID and its section ordinal. */
export const sectionId = (updateId: string, i: number): string => `${updateId}:${i}`;

/** Composes a line ID from its parent section ID and its line ordinal. */
export const lineId = (sectionId: string, i: number): string => `${sectionId}:${i}`;
