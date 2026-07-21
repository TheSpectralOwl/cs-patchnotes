/** Opaque canonical identities and deterministic document-relative derived keys. */

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
