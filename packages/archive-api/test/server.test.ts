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
      body: "# Counter-Strike 2 Update\n\n## Gameplay\n\n- Before the adjustment.\n- Updated smoke behavior.\n- After the adjustment.\n\n## Maps\n\n- Smoke now covers the new route.\n",
    }]), reloadToken: "secret" });
    apps.push(app);
    const response = await app.inject("/api/search?q=smoke&game=cs2");
    expect(response.statusCode).toBe(200);
    expect(response.json().hits[0]).toMatchObject({
      sections: [
        {
          heading: "Gameplay",
          items: [
            { markdown: "Before the adjustment.", kind: "change", matched: false },
            { markdown: "Updated smoke behavior.", kind: "change", matched: true },
            { markdown: "After the adjustment.", kind: "change", matched: false },
          ],
        },
        {
          heading: "Maps",
          items: [{ markdown: "Smoke now covers the new route.", kind: "change", matched: true }],
        },
      ],
    });
    expect(response.json().hits[0]).not.toHaveProperty("body");
    expect(response.json().hits[0]).toHaveProperty("body_sha256", expect.any(String));
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

  it("de-duplicates overlapping sibling context in source order", async () => {
    const app = buildServer({ contentDir: contentFixture([{
      filename: "2024-01-01-overlap.md",
      steamGid: "1",
      sourceHash: "overlap-source",
      body: "# Counter-Strike 2 Update\n\n## Gameplay\n\n- First smoke change.\n- Second smoke change.\n- Third smoke change.\n",
    }]), reloadToken: "secret" });
    apps.push(app);

    const response = await app.inject("/api/search?q=smoke");
    expect(response.json().hits[0].sections[0].items).toEqual([
      { markdown: "First smoke change.", kind: "change", matched: true },
      { markdown: "Second smoke change.", kind: "change", matched: true },
      { markdown: "Third smoke change.", kind: "change", matched: true },
    ]);
  });

  it("keeps continuation-paragraph matches with their list-item siblings", async () => {
    const app = buildServer({ contentDir: contentFixture([{
      filename: "2024-01-01-continuation.md",
      steamGid: "1",
      sourceHash: "continuation-source",
      body: "# Counter-Strike 2 Update\n\n## Gameplay\n\n- Before the adjustment.\n\n- Initial detail.\n\n  Continuation smoke detail.\n\n- After the adjustment.\n\n## Maps\n\n- Unrelated map update.\n",
    }]), reloadToken: "secret" });
    apps.push(app);

    const response = await app.inject("/api/search?q=smoke");

    expect(response.json().hits[0].sections).toEqual([{
      heading: "Gameplay",
      items: [
        { markdown: "Before the adjustment.", kind: "change", matched: false },
        { markdown: "Initial detail.", kind: "change", matched: false },
        { markdown: "Continuation smoke detail.", kind: "change", matched: true },
        { markdown: "After the adjustment.", kind: "change", matched: false },
      ],
    }]);
  });

  it("keeps blockquote prose under its authored heading instead of falling back to an unrelated section", async () => {
    const app = buildServer({ contentDir: contentFixture([{
      filename: "2024-01-01-blockquote.md",
      steamGid: "1",
      sourceHash: "blockquote-source",
      body: "# Counter-Strike 2 Update\n\n## Gameplay\n\n> Smoke behavior changed in this quoted source note.\n\n## Maps\n\n- Unrelated map update.\n",
    }]), reloadToken: "secret" });
    apps.push(app);

    const response = await app.inject("/api/search?q=smoke");

    expect(response.json().hits[0].sections).toEqual([{
      heading: "Gameplay",
      items: [{ markdown: "Smoke behavior changed in this quoted source note.", kind: "prose", matched: true }],
    }]);
  });

  it("uses nested block and list headings as local source context", async () => {
    const app = buildServer({ contentDir: contentFixture([{
      filename: "2024-01-01-nested-headings.md",
      steamGid: "1",
      sourceHash: "nested-headings-source",
      body: "# Counter-Strike 2 Update\n\n## Gameplay\n\n> ### Networking\n>\n> Quoted packet synchronization changed.\n\n- Outer list context.\n  - ### Matchmaking\n    - Nested queue assignment changed.\n- Outer smoke behavior remains.\n",
    }]), reloadToken: "secret" });
    apps.push(app);

    const blockquoteHeading = await app.inject("/api/search?q=networking");
    expect(blockquoteHeading.json().hits[0].sections).toEqual([{
      heading: "Networking",
      items: [{ markdown: "Networking", kind: "heading", matched: true }],
    }]);

    const blockquoteProse = await app.inject("/api/search?q=synchronization");
    expect(blockquoteProse.json().hits[0].sections).toEqual([{
      heading: "Networking",
      items: [{ markdown: "Quoted packet synchronization changed.", kind: "prose", matched: true }],
    }]);

    const nestedListHeading = await app.inject("/api/search?q=matchmaking");
    expect(nestedListHeading.json().hits[0].sections).toEqual([{
      heading: "Matchmaking",
      items: [
        { markdown: "Matchmaking", kind: "heading", matched: true },
        { markdown: "Nested queue assignment changed.", kind: "change", matched: false },
      ],
    }]);

    const nestedListProse = await app.inject("/api/search?q=assignment");
    expect(nestedListProse.json().hits[0].sections).toEqual([{
      heading: "Matchmaking",
      items: [{ markdown: "Nested queue assignment changed.", kind: "change", matched: true }],
    }]);

    const outerProse = await app.inject("/api/search?q=smoke");
    expect(outerProse.json().hits[0].sections).toEqual([{
      heading: "Gameplay",
      items: [
        { markdown: "Outer list context.", kind: "change", matched: false },
        { markdown: "Outer smoke behavior remains.", kind: "change", matched: true },
      ],
    }]);
  });

  it("keeps direct list-item prose under a local heading without changing outer siblings", async () => {
    const app = buildServer({ contentDir: contentFixture([{
      filename: "2024-01-01-direct-list-heading.md",
      steamGid: "1",
      sourceHash: "direct-list-heading-source",
      body: "# Counter-Strike 2 Update\n\n## Gameplay\n\n- ### Networking\n\n  Packet synchronization changed.\n- Outer smoke behavior remains.\n",
    }]), reloadToken: "secret" });
    apps.push(app);

    const synchronization = await app.inject("/api/search?q=synchronization");
    expect(synchronization.json().hits[0].sections).toEqual([{
      heading: "Networking",
      items: [{ markdown: "Packet synchronization changed.", kind: "change", matched: true }],
    }]);

    const smoke = await app.inject("/api/search?q=smoke");
    expect(smoke.json().hits[0].sections).toEqual([{
      heading: "Gameplay",
      items: [{ markdown: "Outer smoke behavior remains.", kind: "change", matched: true }],
    }]);
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

  it("rejects a body fetch whose search-result digest became stale after a reload", async () => {
    const contentDir = contentFixture([{
      filename: "2024-01-01-versioned.md",
      steamGid: "1",
      sourceHash: "versioned-source",
      body: "# Counter-Strike 2 Update\n\n## Gameplay\n\n- Original smoke behavior.\n",
    }]);
    const app = buildServer({ contentDir, reloadToken: "secret" });
    apps.push(app);

    const staleHit = (await app.inject("/api/search?q=smoke")).json().hits[0];
    const newBody = "# Counter-Strike 2 Update\n\n## Gameplay\n\n- Replacement smoke behavior.\n";
    writeNote(contentDir, {
      filename: "2024-01-01-versioned.md",
      steamGid: "1",
      sourceHash: "versioned-source",
      body: newBody,
    });
    expect((await app.inject({ method: "POST", url: "/internal/reload", headers: { authorization: "Bearer secret" } })).statusCode).toBe(200);

    const staleBody = await app.inject(`/api/notes/${staleHit.id}?body_sha256=${staleHit.body_sha256}`);
    expect(staleBody.statusCode).toBe(409);
    expect(staleBody.json()).toEqual({ error: "Note body changed; refresh search results" });

    const currentHit = (await app.inject("/api/search?q=smoke")).json().hits[0];
    const currentBody = await app.inject(`/api/notes/${currentHit.id}?body_sha256=${currentHit.body_sha256}`);
    expect(currentBody.statusCode).toBe(200);
    expect(currentBody.json()).toMatchObject({ body: newBody });
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
