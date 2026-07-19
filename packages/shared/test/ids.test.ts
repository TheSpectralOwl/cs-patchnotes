import { test, expect } from "vitest";
import { updateId, sectionId, lineId } from "../src/db/ids.js";

test("updateId returns the gid unchanged and is deterministic", () => {
  expect(updateId("g")).toBe("g");
  expect(updateId("g")).toBe(updateId("g"));
});

test("sectionId and lineId are deterministic across repeated calls", () => {
  expect(sectionId("g", 2)).toBe(sectionId("g", 2));
  expect(lineId("g:2", 3)).toBe(lineId("g:2", 3));
});

test("composed IDs nest correctly", () => {
  expect(lineId(sectionId(updateId("g"), 2), 3)).toBe("g:2:3");
});

test("distinct ordinals produce distinct IDs", () => {
  expect(sectionId("g", 0)).not.toBe(sectionId("g", 1));
  expect(lineId("g:0", 0)).not.toBe(lineId("g:0", 1));
});
