import { test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@cs-patchnotes/shared";

// Seed a temp SQLite source-of-truth DB and point the API at it via SQLITE_PATH
// BEFORE buildServer() opens its own read handle to the same file.
const dir = mkdtempSync(join(tmpdir(), "cs-notes-"));
const dbPath = join(dir, "patchnotes.db");
const KNOWN_ID = "gid-known-123";

beforeAll(() => {
  process.env.SQLITE_PATH = dbPath;
  const db = openDb(dbPath);
  db.prepare(
    `INSERT INTO updates (id, posted_at, title, url, feedname, game, raw_body, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    KNOWN_ID,
    1_700_000_000,
    "CS2 Update",
    "https://store.steampowered.com/news/app/730",
    "steam_community_announcements",
    "cs2",
    "[MISC]\n- Fixed a grenade bug",
    1_700_000_001,
  );
  db.close();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("GET /notes/:id returns 200 with detail for a known id", async () => {
  const { buildServer } = await import("../src/server.js");
  const app = buildServer();
  const res = await app.inject({ method: "GET", url: `/notes/${KNOWN_ID}` });
  expect(res.statusCode).toBe(200);
  expect(res.json().update.id).toBe(KNOWN_ID);
  await app.close();
});

test("GET /notes/:id returns 404 for an unknown id", async () => {
  const { buildServer } = await import("../src/server.js");
  const app = buildServer();
  const res = await app.inject({ method: "GET", url: "/notes/does-not-exist" });
  expect(res.statusCode).toBe(404);
  await app.close();
});
