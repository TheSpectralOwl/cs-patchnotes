import { test, expect } from "vitest";
import {
  blockId,
  createDocumentId,
  createSourceRecordId,
  fragmentId,
} from "../src/db/ids.js";

test("canonical document and source-record IDs are opaque UUIDs", () => {
  const document = createDocumentId();
  const source = createSourceRecordId();

  expect(document).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(source).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(createDocumentId()).not.toBe(document);
  expect(createSourceRecordId()).not.toBe(source);
});

test("canonical block and fragment IDs are deterministic and document-relative", () => {
  expect(blockId("doc-a", 2)).toBe(blockId("doc-a", 2));
  expect(fragmentId("doc-a", 3)).toBe(fragmentId("doc-a", 3));
  expect(blockId("doc-a", 2)).not.toBe(blockId("doc-b", 2));
  expect(fragmentId("doc-a", 3)).not.toBe(fragmentId("doc-b", 3));
  expect(blockId("doc-a", 2)).not.toBe(blockId("doc-a", 3));
  expect(fragmentId("doc-a", 2)).not.toBe(fragmentId("doc-a", 3));
});

test("canonical derived IDs are valid Meilisearch document keys", () => {
  const document = createDocumentId();
  expect(blockId(document, 0)).toMatch(/^[a-zA-Z0-9_-]+$/);
  expect(fragmentId(document, 0)).toMatch(/^[a-zA-Z0-9_-]+$/);
});
