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

import { randomUUID } from "node:crypto";

/** Creates an opaque canonical identity with no source or content semantics. */
export const createDocumentId = (): string => randomUUID();

/** Creates an opaque identity for one immutable source revision. */
export const createSourceRecordId = (): string => randomUUID();

function derivedId(documentId: string, kind: "b" | "f", ordinal: number): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new RangeError("Canonical structural ID ordinal must be a non-negative safe integer");
  }
  return `${documentId}_${kind}${ordinal}`;
}

/** Derives a stable block key from the opaque document ID and canonical preorder. */
export const blockId = (documentId: string, preorder: number): string =>
  derivedId(documentId, "b", preorder);

/** Derives a stable fragment key from the opaque document ID and fragment order. */
export const fragmentId = (documentId: string, order: number): string =>
  derivedId(documentId, "f", order);

/** Returns the Valve gid unchanged for the transitional prototype model. */
export const updateId = (gid: string): string => gid;

/** Composes a section ID from its parent update ID and its section ordinal. */
export const sectionId = (updateId: string, i: number): string => `${updateId}_${i}`;

/** Composes a line ID from its parent section ID and its line ordinal. */
export const lineId = (sectionId: string, i: number): string => `${sectionId}_${i}`;
