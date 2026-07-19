import { test, expect } from "vitest";
import { buildServer } from "../src/server.js";

test("GET /health returns 200 { status: 'ok' }", async () => {
  const app = buildServer();
  const res = await app.inject({ method: "GET", url: "/health" });
  expect(res.statusCode).toBe(200);
  expect(res.json().status).toBe("ok");
  await app.close();
});
