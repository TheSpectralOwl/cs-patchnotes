import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

const apps: ReturnType<typeof buildServer>[] = [];
const FIXTURE_SHA = "a".repeat(40);

function activeCorpusDir(revisionRoot: string) {
  return join(revisionRoot, "worktrees", FIXTURE_SHA);
}

function reload(app: ReturnType<typeof buildServer>) {
  return app.inject({
    method: "POST",
    url: "/internal/reload",
    headers: { authorization: "Bearer secret", "content-type": "application/json" },
    payload: { sha: FIXTURE_SHA },
  });
}

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
  contentDir = activeCorpusDir(contentDir);
  const rawDir = join(contentDir, "raw", "steam", steamGid);
  const notesDir = join(contentDir, "content", "notes", steamGid);
  rmSync(rawDir, { recursive: true, force: true });
  rmSync(notesDir, { recursive: true, force: true });
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(notesDir, { recursive: true });
  const raw = {
    gid: steamGid,
    title,
    date,
    game,
    content_kind: "patch_notes",
    body_format: "plain_text",
    source_url: `https://example.test/${steamGid}`,
    body,
    body_sha256: createHash("sha256").update(body).digest("hex"),
  };
  const rawContents = `${JSON.stringify(raw, null, 2)}\n`;
  const revision = createHash("sha256").update(rawContents).digest("hex");
  const markdown = `---\ntitle: ${JSON.stringify(title)}\ndate: ${date}\ngame: ${JSON.stringify(game)}\ncontent_kind: "patch_notes"\nbody_format: "plain_text"\nsteam_gid: "${steamGid}"\nsource_url: "https://example.test/${steamGid}"\nsource_sha256: "${raw.body_sha256}"\nsource_revision: "${revision}"\ngenerated_sha256: "${createHash("sha256").update(body).digest("hex")}"\n---\n${body}`;
  writeFileSync(join(rawDir, `${revision}.json`), rawContents);
  writeFileSync(join(rawDir, "index.json"), `${JSON.stringify({ gid: steamGid, latest_revision: revision, revisions: [revision] }, null, 2)}\n`);
  writeFileSync(join(notesDir, `${revision}.md`), markdown);
  writeFileSync(join(notesDir, "index.json"), `${JSON.stringify({
    gid: steamGid,
    note_id: filename,
    legacy_filename: filename,
    latest_revision: revision,
    revisions: [revision],
    legacy_migration_revisions: [],
  }, null, 2)}\n`);
  return { markdown, revision, sourceHash };
}

function contentFixture(notes: NoteFixture[] = [{
  filename: "2024-01-01-update.md",
  steamGid: "1",
  sourceHash: "source",
  body: "# Counter-Strike 2 Update\n\n## Gameplay\n\n- Updated smoke behavior.\n",
}]) {
  const contentDir = mkdtempSync(join(tmpdir(), "cs-patchnotes-api-"));
  const corpusDir = activeCorpusDir(contentDir);
  mkdirSync(join(corpusDir, "raw", "steam"), { recursive: true });
  mkdirSync(join(corpusDir, "content", "notes"), { recursive: true });
  writeFileSync(join(contentDir, "active"), `${FIXTURE_SHA}\n`);
  notes.forEach((note) => writeNote(contentDir, note));
  return contentDir;
}

function writeHistory(contentDir: string, options: {
  gid: string;
  noteId: string;
  bodies: string[];
  latest: number;
  override?: number;
  title?: string;
  date?: string;
}) {
  contentDir = activeCorpusDir(contentDir);
  const { gid, noteId, bodies, latest, override, title = "Counter-Strike 2 Update", date = "2024-01-01" } = options;
  const rawDir = join(contentDir, "raw", "steam", gid);
  const notesDir = join(contentDir, "content", "notes", gid);
  rmSync(rawDir, { recursive: true, force: true });
  rmSync(notesDir, { recursive: true, force: true });
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(notesDir, { recursive: true });

  const revisions = bodies.map((body) => {
    const raw = {
      gid,
      title,
      date,
      game: "cs2",
      content_kind: "patch_notes",
      body_format: "plain_text",
      source_url: `https://example.test/${gid}`,
      body,
      body_sha256: createHash("sha256").update(body).digest("hex"),
    };
    const rawContents = `${JSON.stringify(raw, null, 2)}\n`;
    const revision = createHash("sha256").update(rawContents).digest("hex");
    const markdown = `---\ntitle: ${JSON.stringify(title)}\ndate: ${date}\ngame: "cs2"\ncontent_kind: "patch_notes"\nbody_format: "plain_text"\nsteam_gid: "${gid}"\nsource_url: "https://example.test/${gid}"\nsource_sha256: "${raw.body_sha256}"\nsource_revision: "${revision}"\ngenerated_sha256: "${createHash("sha256").update(body).digest("hex")}"\n---\n${body}`;
    writeFileSync(join(rawDir, `${revision}.json`), rawContents);
    writeFileSync(join(notesDir, `${revision}.md`), markdown);
    return { revision, markdown };
  });
  writeFileSync(join(rawDir, "index.json"), `${JSON.stringify({
    gid,
    latest_revision: revisions[latest].revision,
    revisions: revisions.map(({ revision }) => revision),
  }, null, 2)}\n`);
  writeFileSync(join(notesDir, "index.json"), `${JSON.stringify({
    gid,
    note_id: noteId,
    legacy_filename: noteId,
    latest_revision: revisions[latest].revision,
    revisions: revisions.map(({ revision }) => revision),
    legacy_migration_revisions: [],
    ...(override === undefined ? {} : { override_revision: revisions[override].revision }),
  }, null, 2)}\n`);
  const overridePath = join(contentDir, "overrides", `${gid}.md`);
  if (override === undefined) rmSync(overridePath, { force: true });
  else {
    mkdirSync(join(contentDir, "overrides"), { recursive: true });
    writeFileSync(overridePath, revisions[override].markdown);
  }
  return revisions;
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

  it("uses a meaningful patch change for unfiltered browse while retaining title-only fallback", async () => {
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
    expect(browse.json().hits[0].sections[0]).toEqual({
      heading: "Maps",
      items: [{ markdown: "Newer preview.", kind: "change", matched: false }],
    });
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
    expect((await reload(app)).statusCode).toBe(200);
  });

  it("reports the selected full content SHA and only reloads that SHA", async () => {
    const app = buildServer({ contentRevisionRoot: contentFixture(), reloadToken: "secret" });
    apps.push(app);
    expect((await app.inject("/health")).json()).toMatchObject({ ok: true, content_sha: FIXTURE_SHA });
    expect((await app.inject({
      method: "POST",
      url: "/internal/reload",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      payload: { sha: "b".repeat(40) },
    })).statusCode).toBe(409);
    expect((await app.inject({
      method: "POST",
      url: "/internal/reload",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      payload: { sha: "short" },
    })).statusCode).toBe(400);
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
    expect((await reload(app)).statusCode).toBe(200);

    const staleBody = await app.inject(`/api/notes/${staleHit.id}?body_sha256=${staleHit.body_sha256}`);
    expect(staleBody.statusCode).toBe(409);
    expect(staleBody.json()).toEqual({ error: "Note body changed; refresh search results" });

    const currentHit = (await app.inject("/api/search?q=smoke")).json().hits[0];
    const currentBody = await app.inject(`/api/notes/${currentHit.id}?body_sha256=${currentHit.body_sha256}`);
    expect(currentBody.statusCode).toBe(200);
    expect(currentBody.json()).toMatchObject({ body: newBody });
  });

  it("indexes only the latest source revision under the stable legacy public ID", async () => {
    const contentDir = contentFixture([]);
    const revisions = writeHistory(contentDir, {
      gid: "42",
      noteId: "2024-01-01-stable-id.md",
      bodies: [
        "# Counter-Strike 2 Update\n\n## Gameplay\n\n- Original smoke behavior.\n",
        "# Counter-Strike 2 Update\n\n## Gameplay\n\n- Revised smoke behavior.\n",
      ],
      latest: 1,
    });
    const app = buildServer({ contentDir, reloadToken: "secret" });
    apps.push(app);

    const hit = (await app.inject("/api/search?q=revised")).json().hits[0];
    expect(hit).toMatchObject({ id: "2024-01-01-stable-id.md" });
    expect((await app.inject(`/api/notes/${hit.id}`)).json()).toMatchObject({
      id: "2024-01-01-stable-id.md",
      source_revision: revisions[1].revision,
      body: expect.stringContaining("Revised smoke behavior"),
    });
    expect((await app.inject(`/api/notes/${revisions[0].revision}.md`)).statusCode).toBe(404);
  });

  it("follows A to B to A source state changes without exposing historical routes", async () => {
    const contentDir = contentFixture([]);
    const bodies = [
      "# Counter-Strike 2 Update\n\n## Gameplay\n\n- Alpha smoke behavior.\n",
      "# Counter-Strike 2 Update\n\n## Gameplay\n\n- Bravo smoke behavior.\n",
    ];
    writeHistory(contentDir, { gid: "7", noteId: "2024-01-01-history.md", bodies, latest: 0 });
    const app = buildServer({ contentDir, reloadToken: "secret" });
    apps.push(app);

    expect((await app.inject("/api/search?q=alpha")).json().hits).toHaveLength(1);
    writeHistory(contentDir, { gid: "7", noteId: "2024-01-01-history.md", bodies, latest: 1 });
    expect((await reload(app)).statusCode).toBe(200);
    expect((await app.inject("/api/search?q=bravo")).json().hits).toHaveLength(1);
    expect((await app.inject("/api/search?q=alpha")).json().hits).toHaveLength(0);
    writeHistory(contentDir, { gid: "7", noteId: "2024-01-01-history.md", bodies, latest: 0 });
    expect((await reload(app)).statusCode).toBe(200);
    expect((await app.inject("/api/search?q=alpha")).json().hits).toHaveLength(1);
    expect((await app.inject("/api/search?q=bravo")).json().hits).toHaveLength(0);
  });

  it("keeps an override effective after later source revisions", async () => {
    const contentDir = contentFixture([]);
    const options = {
      gid: "9",
      noteId: "2024-01-01-override.md",
      bodies: [
        "# Counter-Strike 2 Update\n\n## Gameplay\n\n- Curated smoke wording.\n",
        "# Counter-Strike 2 Update\n\n## Gameplay\n\n- Latest source smoke wording.\n",
      ],
      override: 0,
    };
    writeHistory(contentDir, { ...options, latest: 0 });
    const app = buildServer({ contentDir, reloadToken: "secret" });
    apps.push(app);

    expect((await app.inject("/api/search?q=curated")).json().hits).toHaveLength(1);
    writeHistory(contentDir, { ...options, latest: 1 });
    expect((await reload(app)).statusCode).toBe(200);
    expect((await app.inject("/api/search?q=latest")).json().hits).toHaveLength(0);
    expect((await app.inject("/api/search?q=curated")).json().hits).toHaveLength(1);
    expect((await app.inject("/api/notes/2024-01-01-override.md")).json()).toMatchObject({ body: expect.stringContaining("Curated smoke wording") });
    writeHistory(contentDir, { ...options, latest: 0 });
    expect((await reload(app)).statusCode).toBe(200);
    expect((await app.inject("/api/search?q=curated")).json().hits).toHaveLength(1);
  });

  it("rejects an unsupported game value in frontmatter at runtime", () => {
    const contentDir = contentFixture([]);
    const { revision } = writeNote(contentDir, {
      filename: "2024-01-01-invalid.md",
      steamGid: "1",
      sourceHash: "source",
      body: "# Counter-Strike 2 Update\n",
    });
    const filename = join(activeCorpusDir(contentDir), "content", "notes", "1", `${revision}.md`);
    writeFileSync(filename, readFileSync(filename, "utf8").replace('game: "cs2"', 'game: "cs1"'));
    expect(() => buildServer({
      contentDir,
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
    expect(duplicate.json()).toMatchObject({
      id: canonicalId,
      steam_gid: "2",
      source_sha256: createHash("sha256").update(body).digest("hex"),
      body,
    });
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

    expect((await reload(app)).statusCode).toBe(500);
    expect((await app.inject("/api/search?q=smoke")).json().hits).toEqual([
      expect.objectContaining({ sections: [{ heading: "Gameplay", items: expect.any(Array) }] }),
    ]);
  });

  it("preserves the serving index when a reloaded revision manifest is invalid", async () => {
    const contentDir = contentFixture([{
      filename: "2024-01-01-invalid-manifest.md",
      steamGid: "33",
      sourceHash: "invalid-manifest-source",
      body: "# Counter-Strike 2 Update\n\n## Gameplay\n\n- Existing smoke behavior.\n",
    }]);
    const app = buildServer({ contentDir, reloadToken: "secret" });
    apps.push(app);
    writeFileSync(join(activeCorpusDir(contentDir), "content", "notes", "33", "index.json"), JSON.stringify({
      gid: "33",
      note_id: "2024-01-01-invalid-manifest.md",
      legacy_filename: "2024-01-01-invalid-manifest.md",
      latest_revision: "not-a-revision",
      revisions: [],
    }));

    expect((await reload(app)).statusCode).toBe(500);
    expect((await app.inject("/api/search?q=existing")).json().hits).toHaveLength(1);
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
