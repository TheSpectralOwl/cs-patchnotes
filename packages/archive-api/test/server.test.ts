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

function contentFixture(notes: NoteFixture[] = [{
  filename: "2024-01-01-update.md",
  steamGid: "1",
  sourceHash: "source",
  body: "# Counter-Strike 2 Update\n\n## Gameplay\n\n- Updated smoke behavior.\n",
}]) {
  const contentDir = mkdtempSync(join(tmpdir(), "cs-patchnotes-api-"));
  const notesDir = join(contentDir, "content", "notes");
  mkdirSync(notesDir, { recursive: true });
  notes.forEach((note) => writeNote(contentDir, note));
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

  it("retains duplicate evidence while presenting the lower-GID canonical note", async () => {
    const body = "# Counter-Strike 2 Update\n\n## Gameplay\n\n- Shared duplicate smoke behavior.\n";
    const canonicalId = "2024-01-01-canonical.md";
    const duplicateId = "2024-01-01-duplicate.md";
    const app = buildServer({
      contentDir: contentFixture([
        { filename: duplicateId, steamGid: "10", sourceHash: "duplicate-source", body },
        { filename: canonicalId, steamGid: "2", sourceHash: "duplicate-source", body },
      ]),
    });
    apps.push(app);

    expect((await app.inject("/health")).json()).toMatchObject({ notes: 2, visible_notes: 1 });

    const search = await app.inject("/api/search?q=duplicate&game=cs2");
    expect(search.statusCode).toBe(200);
    expect(search.json().hits).toEqual([expect.objectContaining({ id: canonicalId, steam_gid: "2" })]);

    const duplicate = await app.inject(`/api/notes/${duplicateId}`);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ id: canonicalId, steam_gid: "2", source_sha256: "duplicate-source", body });
  });
});
