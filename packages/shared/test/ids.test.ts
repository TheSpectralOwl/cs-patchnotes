import { test, expect } from "vitest";
import {
  blockId,
  createDocumentId,
  createSourceRecordId,
  fragmentId,
  lineId,
  sectionId,
  updateId,
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

test("updateId returns the gid unchanged and is deterministic", () => {
  expect(updateId("g")).toBe("g");
  expect(updateId("g")).toBe(updateId("g"));
});

test("sectionId and lineId are deterministic across repeated calls", () => {
  expect(sectionId("g", 2)).toBe(sectionId("g", 2));
  expect(lineId("g_2", 3)).toBe(lineId("g_2", 3));
});

test("composed IDs nest correctly", () => {
  expect(lineId(sectionId(updateId("g"), 2), 3)).toBe("g_2_3");
});

test("composed IDs are valid Meilisearch document keys (no colons)", () => {
  const id = lineId(sectionId(updateId("1831432155563523"), 0), 0);
  expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
});

test("distinct ordinals produce distinct IDs", () => {
  expect(sectionId("g", 0)).not.toBe(sectionId("g", 1));
  expect(lineId("g_0", 0)).not.toBe(lineId("g_0", 1));
});
