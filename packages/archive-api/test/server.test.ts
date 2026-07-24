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
  game?: string;
  title?: string;
  date?: string;
};

function writeNote(contentDir: string, {
  filename,
  steamGid,
  sourceHash,
  body,
  game = "cs2",
  title = "Counter-Strike 2 Update",
  date = "2024-01-01",
}: NoteFixture) {
  const hash = createHash("sha256").update(body).digest("hex");
  writeFileSync(join(contentDir, "content", "notes", filename), `---\ntitle: ${JSON.stringify(title)}\ndate: ${date}\ngame: ${JSON.stringify(game)}\nsteam_gid: "${steamGid}"\nsource_url: "https://example.test/${steamGid}"\nsource_sha256: "${sourceHash}"\ngenerated_sha256: "${hash}"\n---\n${body}`);
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
  it("returns every matched section with source-owned headings and local list siblings", async () => {
    const app = buildServer({ contentDir: contentFixture([{
      filename: "2024-01-01-context.md",
      steamGid: "1",
      sourceHash: "context-source",
      body: "# Counter-Strike 2 Update\n\n## Gameplay\n\n- Before smoke adjustment.\n- Updated smoke behavior.\n- After smoke adjustment.\n\n## Maps\n\n- Smoke now covers the new route.\n",
    }]), reloadToken: "secret" });
    apps.push(app);
    const response = await app.inject("/api/search?q=smoke&game=cs2");
    expect(response.statusCode).toBe(200);
    expect(response.json().hits[0]).toMatchObject({
      sections: [
        {
          heading: "Gameplay",
          items: [
            { markdown: "Before smoke adjustment.", kind: "change", matched: false },
            { markdown: "Updated smoke behavior.", kind: "change", matched: true },
            { markdown: "After smoke adjustment.", kind: "change", matched: false },
          ],
        },
        {
          heading: "Maps",
          items: [{ markdown: "Smoke now covers the new route.", kind: "change", matched: true }],
        },
      ],
    });
    expect(response.json().hits[0]).not.toHaveProperty("body");
    expect(response.json().hits[0]).not.toHaveProperty("matching_lines");
    expect(response.json().hits[0]).not.toHaveProperty("more_changes");
  });

  it("returns real heading and prose matches before local section changes", async () => {
    const app = buildServer({ contentDir: contentFixture([{
      filename: "2024-01-01-prose.md",
      steamGid: "1",
      sourceHash: "prose-source",
      body: "# Counter-Strike 2 Update\n\n## Weapon tuning\n\nRecoil recovery is now more predictable.\n\n- Nearby weapon change.\n",
    }]), reloadToken: "secret" });
    apps.push(app);

    const heading = await app.inject("/api/search?q=tuning");
    expect(heading.json().hits[0].sections).toEqual([{
      heading: "Weapon tuning",
      items: expect.arrayContaining([{ markdown: "Weapon tuning", kind: "heading", matched: true }]),
    }]);

    const prose = await app.inject("/api/search?q=recoil");
    expect(prose.json().hits[0].sections).toEqual([{
      heading: "Weapon tuning",
      items: expect.arrayContaining([
        { markdown: "Recoil recovery is now more predictable.", kind: "prose", matched: true },
        { markdown: "Nearby weapon change.", kind: "change", matched: false },
      ]),
    }]);
    expect(prose.json().hits[0].sections[0].items[0]).toEqual({
      markdown: "Recoil recovery is now more predictable.", kind: "prose", matched: true,
    });
  });

  it("uses the earliest headed source preview for title-only hits and unfiltered browse", async () => {
    const app = buildServer({ contentDir: contentFixture([
      {
        filename: "2024-01-01-older.md",
        steamGid: "1",
        sourceHash: "older-source",
        date: "2024-01-01",
        title: "Archive-only older patch",
        body: "# Official Update\n\n## Gameplay\n\n- Older preview.\n",
      },
      {
        filename: "2024-02-01-newer.md",
        steamGid: "2",
        sourceHash: "newer-source",
        date: "2024-02-01",
        title: "Newer patch",
        body: "# Newer patch\n\n## Maps\n\n- Newer preview.\n",
      },
    ]), reloadToken: "secret" });
    apps.push(app);

    const titleOnly = await app.inject("/api/search?q=archive");
    expect(titleOnly.json().hits).toEqual([expect.objectContaining({
      title: "Archive-only older patch",
      sections: [{ heading: "Official Update", items: [{ markdown: "Official Update", kind: "heading", matched: false }] }],
    })]);

    const browse = await app.inject("/api/search");
    expect(browse.json().hits.map((hit: { date: string }) => hit.date)).toEqual(["2024-02-01", "2024-01-01"]);
    expect(browse.json().hits[0].sections[0]).toMatchObject({ heading: "Newer patch" });
  });

  it("keeps represented game and date filters with compact contextual responses", async () => {
    const app = buildServer({ contentDir: contentFixture([
      {
        filename: "2024-01-01-csgo.md", steamGid: "1", sourceHash: "csgo-source", game: "csgo", date: "2024-01-01",
        body: "# Counter-Strike Update\n\n## Gameplay\n\n- Smoke change.\n",
      },
      {
        filename: "2024-02-01-cs2.md", steamGid: "2", sourceHash: "cs2-source", game: "cs2", date: "2024-02-01",
        body: "# Counter-Strike 2 Update\n\n## Gameplay\n\n- Smoke change.\n",
      },
    ]), reloadToken: "secret" });
    apps.push(app);

    const response = await app.inject("/api/search?q=smoke&game=cs2&from=2024-02-01&to=2024-02-01");
    expect(response.json().hits).toEqual([expect.objectContaining({ game: "cs2", date: "2024-02-01", sections: expect.any(Array) })]);
  });

  it("does not expose reload without its private token", async () => {
    const app = buildServer({ contentDir: contentFixture(), reloadToken: "secret" });
    apps.push(app);
    expect((await app.inject({ method: "POST", url: "/internal/reload" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/internal/reload", headers: { authorization: "Bearer secret" } })).statusCode).toBe(200);
  });

  it("rejects an unsupported game value in frontmatter at runtime", () => {
    expect(() => buildServer({
      contentDir: contentFixture([{
        filename: "2024-01-01-invalid.md",
        steamGid: "1",
        sourceHash: "source",
        body: "# Counter-Strike 2 Update\n",
        game: "cs1",
      }]),
    })).toThrow(/invalid game frontmatter/);
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

  it("rejects headingless source candidates before an atomic reload can replace the serving index", async () => {
    const contentDir = contentFixture([{
      filename: "2024-01-01-reload.md",
      steamGid: "1",
      sourceHash: "reload-source",
      body: "# Counter-Strike 2 Update\n\n## Gameplay\n\n- Existing smoke behavior.\n",
    }]);
    const app = buildServer({ contentDir, reloadToken: "secret" });
    apps.push(app);
    writeNote(contentDir, {
      filename: "2024-01-01-reload.md",
      steamGid: "1",
      sourceHash: "reload-source",
      body: "This searchable text has no authored heading.\n",
    });

    expect((await app.inject({ method: "POST", url: "/internal/reload", headers: { authorization: "Bearer secret" } })).statusCode).toBe(500);
    expect((await app.inject("/api/search?q=smoke")).json().hits).toEqual([
      expect.objectContaining({ sections: [{ heading: "Gameplay", items: expect.any(Array) }] }),
    ]);
  });

  it("rejects bodies over the one MiB parser ceiling", () => {
    expect(() => buildServer({ contentDir: contentFixture([{
      filename: "2024-01-01-oversized.md",
      steamGid: "1",
      sourceHash: "oversized-source",
      body: `# Counter-Strike 2 Update\n\n## Gameplay\n\n${"x".repeat(1024 * 1024)}`,
    }]) })).toThrow(/1 MiB/);
  });
});
