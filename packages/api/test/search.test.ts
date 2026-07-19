import { test, expect, vi, beforeEach } from "vitest";

// Mock the server-side Meili factory so the route never needs a live Meili.
// The spy is hoisted so the mock factory (also hoisted) can close over it.
const searchMock = vi.hoisted(() => vi.fn());

vi.mock("../src/meili.js", () => ({
  buildMeili: () => ({
    index: () => ({ search: searchMock }),
  }),
}));

import { buildServer } from "../src/server.js";

const ORIGIN = "https://cs-patchnotes.pages.dev";

beforeEach(() => {
  searchMock.mockReset();
  searchMock.mockResolvedValue({
    hits: [
      {
        id: "1_0_0",
        text: "grenade damage tweaked",
        title: "CS2 Update",
        posted_at: 1_700_000_000,
        game: "cs2",
      },
    ],
    query: "",
  });
  process.env.WEB_ORIGIN = ORIGIN;
});

test("GET /search?q=grenade returns 200 with a results array", async () => {
  const app = buildServer();
  const res = await app.inject({ method: "GET", url: "/search?q=grenade" });
  expect(res.statusCode).toBe(200);
  expect(Array.isArray(res.json().hits)).toBe(true);
  expect(searchMock).toHaveBeenCalledWith(
    "grenade",
    expect.objectContaining({ limit: 20 }),
  );
  await app.close();
});

test("empty-q GET /search returns 200 and uses posted_at descending sort", async () => {
  const app = buildServer();
  const res = await app.inject({ method: "GET", url: "/search" });
  expect(res.statusCode).toBe(200);
  expect(searchMock).toHaveBeenCalledWith(
    "",
    expect.objectContaining({ sort: ["posted_at:desc"] }),
  );
  await app.close();
});

test("GET /search clamps an over-limit `limit` to <= 50", async () => {
  const app = buildServer();
  const res = await app.inject({ method: "GET", url: "/search?q=x&limit=999" });
  expect(res.statusCode).toBe(200);
  const opts = searchMock.mock.calls[0]?.[1] as { limit: number };
  expect(opts.limit).toBeLessThanOrEqual(50);
  expect(opts.limit).toBe(50);
  await app.close();
});

test("GET /search carries an Access-Control-Allow-Origin header for the SPA origin", async () => {
  const app = buildServer();
  const res = await app.inject({
    method: "GET",
    url: "/search?q=grenade",
    headers: { origin: ORIGIN },
  });
  expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
  await app.close();
});
