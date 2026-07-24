import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

const apps: ReturnType<typeof buildServer>[] = [];

type NoteFixture = {
  filename: string;
  steamGid: string;
  sourceHash: string;
  body: string;
};

function writeNote(contentDir: string, { filename, steamGid, sourceHash, body }: NoteFixture) {
  const hash = createHash("sha256").update(body).digest("hex");
  writeFileSync(join(contentDir, "content", "notes", filename), `---\ntitle: "Counter-Strike 2 Update"\ndate: 2024-01-01\ngame: cs2\nsteam_gid: "${steamGid}"\nsource_url: "https://example.test/${steamGid}"\nsource_sha256: "${sourceHash}"\ngenerated_sha256: "${hash}"\n---\n${body}`);
}

function contentFixture() {
  const contentDir = mkdtempSync(join(tmpdir(), "cs-patchnotes-api-"));
  const notesDir = join(contentDir, "content", "notes");
  mkdirSync(notesDir, { recursive: true });
  const body = "# Counter-Strike 2 Update\n\n## Gameplay\n\n- Updated smoke behavior.\n";
  writeNote(contentDir, { filename: "2024-01-01-update.md", steamGid: "1", sourceHash: "source", body });
  return contentDir;
}

afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("archive API", () => {
  it("searches Markdown notes and returns matching lines", async () => {
    const app = buildServer({ contentDir: contentFixture(), reloadToken: "secret" });
    apps.push(app);
    const response = await app.inject("/api/search?q=smoke&game=cs2");
    expect(response.statusCode).toBe(200);
    expect(response.json().hits[0].matching_lines).toContain("- Updated smoke behavior.");
  });

  it("does not expose reload without its private token", async () => {
    const app = buildServer({ contentDir: contentFixture(), reloadToken: "secret" });
    apps.push(app);
    expect((await app.inject({ method: "POST", url: "/internal/reload" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/internal/reload", headers: { authorization: "Bearer secret" } })).statusCode).toBe(200);
  });
});
