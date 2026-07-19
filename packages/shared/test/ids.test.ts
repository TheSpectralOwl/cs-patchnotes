import { test, expect } from "vitest";
import { updateId, sectionId, lineId } from "../src/db/ids.js";

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
