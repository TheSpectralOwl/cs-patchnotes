import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { initializeCanonicalSchema } from "@cs-patchnotes/shared";
import { COMMANDS, main } from "../src/cli.js";
import {
  parseAuditCanonicalArgs,
  parseMigrateCanonicalArgs,
  runAuditCanonical,
  runMigrateCanonical,
  type CanonicalBackupManifest,
} from "../src/migrate.js";
import { runParse } from "../src/parse.js";

const temporaryDirectories: string[] = [];
const openDatabases: DatabaseType[] = [];

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

function makePaths(): { directory: string; target: string; manifest: string } {
  const directory = mkdtempSync(join(tmpdir(), "canonical cutover "));
  temporaryDirectories.push(directory);
  return {
    directory,
    target: join(directory, "accepted archive.sqlite"),
    manifest: join(directory, "operator evidence arbitrary name.json"),
  };
}

function createLegacySchema(db: DatabaseType): void {
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE updates (
      id TEXT PRIMARY KEY,
      posted_at INTEGER NOT NULL,
      title TEXT NOT NULL,
      url TEXT,
      feedname TEXT,
      game TEXT NOT NULL,
      raw_body TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      channel TEXT NOT NULL DEFAULT 'mainline'
    );
    CREATE TABLE sections (
      id TEXT PRIMARY KEY,
      update_id TEXT NOT NULL REFERENCES updates(id) ON DELETE CASCADE,
      section_index INTEGER NOT NULL,
      header TEXT,
      UNIQUE(update_id, section_index)
    );
    CREATE TABLE lines (
      id TEXT PRIMARY KEY,
      section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
      update_id TEXT NOT NULL REFERENCES updates(id) ON DELETE CASCADE,
      line_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      game TEXT NOT NULL,
      subheader TEXT,
      parent_line_index INTEGER,
      UNIQUE(section_id, line_index)
    );
    CREATE TABLE line_tags (
      line_id TEXT NOT NULL REFERENCES lines(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      category TEXT,
      entity TEXT,
      source TEXT NOT NULL,
      confidence REAL,
      PRIMARY KEY (line_id, kind, category, entity)
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
}

function seedLegacyDatabase(path: string, count = 274): Map<string, string> {
  const db = new Database(path);
  createLegacySchema(db);
  const bodies = new Map<string, string>();
  const insert = db.prepare(`
    INSERT INTO updates
      (id, posted_at, title, url, feedname, game, raw_body, fetched_at, channel)
    VALUES (?, ?, ?, ?, 'steam_community_announcements', ?, ?, ?, 'mainline')
  `);
  const seed = db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const gid = String(10_000_000 + index);
      const body =
        index % 2 === 0
          ? `[ GAMEPLAY ]\r\n– Exact legacy bytes ${index}: 🧪`
          : `[list][*]Exact rich bytes ${index}[/list]`;
      bodies.set(gid, body);
      insert.run(
        gid,
        1_700_000_000 + index,
        `Counter-Strike 2 Update ${index}`,
        `https://steamcommunity.com/games/CSGO/announcements/detail/${gid}`,
        index < 10 ? "csgo" : "cs2",
        body,
        1_700_100_000 + index,
      );
    }
  });
  seed();
  db.close();
  return bodies;
}

function track<T extends DatabaseType>(db: T): T {
  openDatabases.push(db);
  return db;
}

function snapshotLegacy(path: string): unknown {
  const db = new Database(path, { readonly: true });
  const snapshot = {
    version: db.pragma("user_version", { simple: true }),
    tables: db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .pluck()
      .all(),
    updates: db.prepare("SELECT * FROM updates ORDER BY id").all(),
    lineTags: db.prepare("SELECT * FROM line_tags ORDER BY line_id").all(),
  };
  db.close();
  return snapshot;
}

function snapshotProtectedState(path: string): unknown {
  const db = new Database(path, { readonly: true });
  const prototypeTables = ["updates", "sections", "lines", "line_tags"];
  const snapshot = {
    version: db.pragma("user_version", { simple: true }),
    prototypeDefinitions: db
      .prepare(
        `SELECT type, name, sql
           FROM sqlite_master
          WHERE name IN ('updates', 'sections', 'lines', 'line_tags')
          ORDER BY type, name`,
      )
      .all(),
    prototypeRows: Object.fromEntries(
      prototypeTables.map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    ),
    canonicalCounts: Object.fromEntries(
      [
        "documents",
        "source_records",
        "document_source_heads",
        "external_identifiers",
        "source_locators",
        "document_parse_state",
        "parse_runs",
        "blocks",
        "search_fragments",
        "fragment_tags",
        "canonical_cutover_audits",
      ].map((table) => [
        table,
        db.prepare(`SELECT count(*) FROM ${table}`).pluck().get(),
      ]),
    ),
    sourceHashes: db
      .prepare(
        `SELECT id, pristine_body, body_sha256
           FROM source_records
          ORDER BY id`,
      )
      .all(),
  };
  db.close();
  return snapshot;
}

function readManifest(path: string): CanonicalBackupManifest {
  return JSON.parse(readFileSync(path, "utf8")) as CanonicalBackupManifest;
}

function writeManifest(path: string, manifest: unknown): void {
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function expandAndParseTwice(count = 2): Promise<{
  directory: string;
  target: string;
  manifest: string;
  bodies: Map<string, string>;
}> {
  const paths = makePaths();
  const bodies = seedLegacyDatabase(paths.target, count);
  await runMigrateCanonical({
    sqlitePath: paths.target,
    approvedTargetPath: paths.target,
    args: ["--stage", "expand", "--apply", "--backup-manifest", paths.manifest],
  });
  const db = new Database(paths.target);
  db.pragma("foreign_keys = ON");
  await runParse({ db, runId: "first-complete-parse", now: () => 1_700_200_000 });
  await runParse({ db, runId: "second-noop-parse", now: () => 1_700_200_100 });
  db.close();
  return { ...paths, bodies };
}

async function recordReadiness(target: string, manifest: string): Promise<void> {
  await runAuditCanonical({
    sqlitePath: target,
    args: [
      "--strict",
      "--record-finalization-readiness",
      "--backup-manifest",
      manifest,
    ],
  });
}

async function finalize(target: string, manifest: string): Promise<void> {
  await runMigrateCanonical({
    sqlitePath: target,
    approvedTargetPath: target,
    args: ["--stage", "finalize", "--apply", "--backup-manifest", manifest],
  });
}

function canonicalCounts(db: DatabaseType): Record<string, number> {
  const tables = [
    "documents",
    "source_records",
    "document_source_heads",
    "external_identifiers",
    "source_locators",
  ];
  return Object.fromEntries(
    tables.map((table) => [
      table,
      db.prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number,
    ]),
  );
}

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) {
      chmodSync(directory, 0o700);
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe("canonical migration command safety", () => {
  test("requires explicit apply, expand stage, absolute target, and absolute manifest", async () => {
    const { target, manifest } = makePaths();
    seedLegacyDatabase(target, 1);
    const before = snapshotLegacy(target);

    const invalidCalls = [
      { sqlitePath: "relative.sqlite", args: ["--stage", "expand", "--apply", "--backup-manifest", manifest] },
      { sqlitePath: target, args: ["--stage", "expand", "--apply"] },
      { sqlitePath: target, args: ["--stage", "expand", "--apply", "--backup-manifest", "relative.json"] },
      { sqlitePath: target, args: ["--stage", "finalize", "--apply", "--backup-manifest", manifest] },
      { sqlitePath: target, args: ["--stage", "expand", "--backup-manifest", manifest] },
      { sqlitePath: target, args: ["--stage", "expand", "--apply", "--unknown", manifest] },
    ];

    for (const call of invalidCalls) {
      await expect(
        runMigrateCanonical({
          ...call,
          approvedTargetPath: target,
        }),
      ).rejects.toThrow();
      expect(snapshotLegacy(target)).toEqual(before);
    }
    expect(existsSync(manifest)).toBe(false);
  });

  test("refuses an unapproved real-corpus target and classified legacy data before mutation", async () => {
    const { directory, target, manifest } = makePaths();
    seedLegacyDatabase(target, 1);
    const differentApprovedTarget = join(directory, "different approved.sqlite");
    await expect(
      runMigrateCanonical({
        sqlitePath: target,
        approvedTargetPath: differentApprovedTarget,
        args: ["--stage", "expand", "--apply", "--backup-manifest", manifest],
      }),
    ).rejects.toThrow(/approved target/i);

    const db = new Database(target);
    db.prepare("INSERT INTO sections VALUES ('s', ?, 0, 'GAMEPLAY')").run("10000000");
    db.prepare(
      "INSERT INTO lines VALUES ('l', 's', ?, 0, 'change', 'csgo', NULL, NULL)",
    ).run("10000000");
    db.prepare(
      "INSERT INTO line_tags VALUES ('l', 'category', 'gameplay', NULL, 'test', 1)",
    ).run();
    db.close();
    const before = snapshotLegacy(target);

    await expect(
      runMigrateCanonical({
        sqlitePath: target,
        approvedTargetPath: target,
        args: ["--stage", "expand", "--apply", "--backup-manifest", manifest],
      }),
    ).rejects.toThrow(/classification|line_tags/i);
    expect(snapshotLegacy(target)).toEqual(before);
    expect(existsSync(manifest)).toBe(false);
  });

  test("backup verification, manifest publication, and parity failures leave legacy rows untouched", async () => {
    for (const failure of ["verification", "publication", "parity"] as const) {
      const { target, manifest } = makePaths();
      seedLegacyDatabase(target, 3);
      const before = snapshotLegacy(target);
      const publicationDirectory = join(dirname(target), "manifest destination");
      if (failure === "publication") mkdirSync(publicationDirectory);
      const actualManifest = failure === "publication" ? publicationDirectory : manifest;

      await expect(
        runMigrateCanonical({
          sqlitePath: target,
          approvedTargetPath: target,
          args: ["--stage", "expand", "--apply", "--backup-manifest", actualManifest],
          hooks:
            failure === "verification"
              ? { beforeBackupVerification: (backupPath) => rmSync(backupPath) }
              : failure === "parity"
                ? {
                    afterExpansion: (db) =>
                      db.prepare("DELETE FROM external_identifiers WHERE value = '10000000'").run(),
                  }
                : undefined,
        }),
      ).rejects.toThrow();

      expect(snapshotLegacy(target)).toEqual(before);
      if (failure !== "parity") {
        const inspection = new Database(target, { readonly: true });
        expect(
          inspection
            .prepare("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='documents'")
            .pluck()
            .get(),
        ).toBe(0);
        inspection.close();
      }
    }
  });
});

describe("canonical expansion and audit", () => {
  test("preserves arbitrary absolute paths, seals exact backup evidence, and is retry-stable", async () => {
    const { directory, target, manifest } = makePaths();
    const bodies = seedLegacyDatabase(target);
    const ignoredSibling = join(directory, "newest sibling backup that must be ignored.sqlite");
    const ignoredManifest = join(directory, "newest sibling manifest that must be ignored.json");
    seedLegacyDatabase(ignoredSibling, 1);
    const ignoredBefore = statSync(ignoredSibling).mtimeMs;

    const first = await runMigrateCanonical({
      sqlitePath: target,
      approvedTargetPath: target,
      args: ["--stage", "expand", "--apply", "--backup-manifest", manifest],
    });

    expect(first.target_path).toBe(target);
    expect(first.manifest_path).toBe(manifest);
    expect(existsSync(manifest)).toBe(true);
    const manifestBytes = readFileSync(manifest);
    const evidence = JSON.parse(manifestBytes.toString("utf8")) as CanonicalBackupManifest;
    expect(evidence.contract_version).toBe(1);
    expect(evidence.manifest_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(evidence.expansion_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(Number.isNaN(Date.parse(evidence.created_at))).toBe(false);
    expect(evidence.target.path).toBe(target);
    expect(evidence.target.user_version).toBe(0);
    expect(evidence.target.table_counts.updates).toBe(274);
    expect(evidence.target.legacy_source_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.target.device).toBeTypeOf("number");
    expect(evidence.target.inode).toBeTypeOf("number");
    expect(evidence.target.size).toBeGreaterThan(0);
    expect(evidence.target.mtime_ms).toBeGreaterThan(0);
    expect(evidence.backup.path).toBe(`${manifest}.sqlite-backup`);
    expect(evidence.backup.sha256).toBe(sha256(readFileSync(evidence.backup.path)));
    expect(evidence.backup.size).toBe(statSync(evidence.backup.path).size);
    expect(evidence.open_verification).toEqual({ ok: true, user_version: 0, quick_check: "ok" });
    expect(readdirSync(directory).some((name) => name.includes(".tmp-"))).toBe(false);

    const db = track(new Database(target));
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    expect(canonicalCounts(db)).toEqual({
      documents: 274,
      source_records: 274,
      document_source_heads: 274,
      external_identifiers: 274,
      source_locators: 274,
    });
    const sourceRows = db
      .prepare(
        `SELECT identifier.value AS gid, source.pristine_body, source.body_sha256
           FROM external_identifiers identifier
           JOIN document_source_heads head ON head.document_id = identifier.document_id
           JOIN source_records source ON source.id = head.source_record_id
          WHERE identifier.namespace = 'steam_news_gid'
          ORDER BY identifier.value`,
      )
      .all() as Array<{ gid: string; pristine_body: string; body_sha256: string }>;
    for (const row of sourceRows) {
      expect(Buffer.from(row.pristine_body, "utf8")).toEqual(Buffer.from(bodies.get(row.gid)!, "utf8"));
      expect(row.body_sha256).toBe(sha256(bodies.get(row.gid)!));
    }
    const firstIds = db
      .prepare(
        `SELECT identifier.value AS gid, identifier.document_id, head.source_record_id
           FROM external_identifiers identifier
           JOIN document_source_heads head ON head.document_id = identifier.document_id
          ORDER BY identifier.value`,
      )
      .all();
    expect(db.prepare("SELECT value FROM meta WHERE key='canonical_expansion_id'").pluck().get()).toBe(
      evidence.expansion_id,
    );
    expect(
      db.prepare("SELECT value FROM meta WHERE key='canonical_legacy_source_digest'").pluck().get(),
    ).toBe(evidence.target.legacy_source_digest);
    expect(
      db.prepare("SELECT value FROM meta WHERE key='canonical_backup_manifest_sha256'").pluck().get(),
    ).toBe(sha256(manifestBytes));

    await runMigrateCanonical({
      sqlitePath: target,
      approvedTargetPath: target,
      args: ["--stage", "expand", "--apply", "--backup-manifest", manifest],
    });
    expect(canonicalCounts(db)).toEqual({
      documents: 274,
      source_records: 274,
      document_source_heads: 274,
      external_identifiers: 274,
      source_locators: 274,
    });
    expect(
      db.prepare(
        `SELECT identifier.value AS gid, identifier.document_id, head.source_record_id
           FROM external_identifiers identifier
           JOIN document_source_heads head ON head.document_id = identifier.document_id
          ORDER BY identifier.value`,
      ).all(),
    ).toEqual(firstIds);
    expect(readFileSync(manifest)).toEqual(manifestBytes);
    expect(statSync(ignoredSibling).mtimeMs).toBe(ignoredBefore);
    expect(existsSync(ignoredManifest)).toBe(false);

    const audit = await runAuditCanonical({ sqlitePath: target, args: ["--strict"] });
    expect(audit.ok).toBe(true);
    expect(audit.counts).toMatchObject({ documents: 274, current_source_heads: 274 });
    expect(db.prepare("SELECT count(*) FROM updates").pluck().get()).toBe(274);
    expect(db.prepare("SELECT count(*) FROM sections").pluck().get()).toBe(0);
  });

  test("strict audit rejects source, alias, head, and legacy classification drift", async () => {
    for (const drift of ["source", "alias", "head", "tags"] as const) {
      const { target, manifest } = makePaths();
      seedLegacyDatabase(target, 2);
      await runMigrateCanonical({
        sqlitePath: target,
        approvedTargetPath: target,
        args: ["--stage", "expand", "--apply", "--backup-manifest", manifest],
      });
      const db = new Database(target);
      if (drift === "source") {
        db.prepare("UPDATE updates SET raw_body = raw_body || ' changed' WHERE id='10000000'").run();
      } else if (drift === "alias") {
        db.prepare("DELETE FROM external_identifiers WHERE value='10000000'").run();
      } else if (drift === "head") {
        db.prepare("DELETE FROM document_source_heads WHERE document_id = (SELECT document_id FROM external_identifiers LIMIT 1)").run();
      } else {
        db.prepare("INSERT INTO sections VALUES ('s', '10000000', 0, 'GAMEPLAY')").run();
        db.prepare("INSERT INTO lines VALUES ('l', 's', '10000000', 0, 'change', 'csgo', NULL, NULL)").run();
        db.prepare("INSERT INTO line_tags VALUES ('l', 'category', 'gameplay', NULL, 'test', 1)").run();
      }
      db.close();

      await expect(runAuditCanonical({ sqlitePath: target, args: ["--strict"] })).rejects.toThrow();
    }
  });
});

describe("guarded canonical-only finalization", () => {
  test("requires one exact fresh closed manifest and never infers a newer sibling", async () => {
    const cases: Array<{
      name: string;
      mutate: (manifest: CanonicalBackupManifest, manifestPath: string) => void;
    }> = [
      {
        name: "malformed JSON",
        mutate: (_manifest, manifestPath) => writeFileSync(manifestPath, "{", "utf8"),
      },
      {
        name: "extra manifest field",
        mutate: (manifest, manifestPath) => writeManifest(manifestPath, { ...manifest, unexpected: true }),
      },
      {
        name: "wrong contract version",
        mutate: (manifest, manifestPath) => writeManifest(manifestPath, { ...manifest, contract_version: 99 }),
      },
      {
        name: "expired creation time",
        mutate: (manifest, manifestPath) => writeManifest(manifestPath, { ...manifest, created_at: "2000-01-01T00:00:00.000Z" }),
      },
      {
        name: "target path mismatch",
        mutate: (manifest, manifestPath) => writeManifest(manifestPath, {
          ...manifest,
          target: { ...manifest.target, path: `${manifest.target.path}.substituted` },
        }),
      },
      {
        name: "target stat mismatch",
        mutate: (manifest, manifestPath) => writeManifest(manifestPath, {
          ...manifest,
          target: { ...manifest.target, size: manifest.target.size + 1 },
        }),
      },
      {
        name: "source digest mismatch",
        mutate: (manifest, manifestPath) => writeManifest(manifestPath, {
          ...manifest,
          target: { ...manifest.target, legacy_source_digest: "f".repeat(64) },
        }),
      },
      {
        name: "expansion identity mismatch",
        mutate: (manifest, manifestPath) => writeManifest(manifestPath, {
          ...manifest,
          expansion_id: "00000000-0000-4000-8000-000000000000",
        }),
      },
      {
        name: "backup path mismatch",
        mutate: (manifest, manifestPath) => writeManifest(manifestPath, {
          ...manifest,
          backup: { ...manifest.backup, path: `${manifest.backup.path}.substituted` },
        }),
      },
      {
        name: "backup hash mismatch",
        mutate: (manifest, manifestPath) => writeManifest(manifestPath, {
          ...manifest,
          backup: { ...manifest.backup, sha256: "f".repeat(64) },
        }),
      },
      {
        name: "backup stat mismatch",
        mutate: (manifest, manifestPath) => writeManifest(manifestPath, {
          ...manifest,
          backup: { ...manifest.backup, size: manifest.backup.size + 1 },
        }),
      },
      {
        name: "open verification mismatch",
        mutate: (manifest, manifestPath) => writeManifest(manifestPath, {
          ...manifest,
          open_verification: { ...manifest.open_verification, user_version: 99 },
        }),
      },
      {
        name: "backup open or quick-check failure",
        mutate: (manifest, manifestPath) => {
          writeFileSync(manifest.backup.path, "not a sqlite database", "utf8");
          const stat = statSync(manifest.backup.path);
          writeManifest(manifestPath, {
            ...manifest,
            backup: {
              ...manifest.backup,
              device: stat.dev,
              inode: stat.ino,
              size: stat.size,
              mtime_ms: stat.mtimeMs,
              sha256: sha256(readFileSync(manifest.backup.path)),
            },
          });
          const db = new Database(manifest.target.path);
          db.prepare(
            "UPDATE meta SET value=? WHERE key='canonical_backup_manifest_sha256'",
          ).run(sha256(readFileSync(manifestPath)));
          db.close();
        },
      },
    ];

    for (const invalid of cases) {
      const { target, manifest } = await expandAndParseTwice(1);
      const evidence = readManifest(manifest);
      invalid.mutate(evidence, manifest);
      const before = snapshotProtectedState(target);

      await expect(recordReadiness(target, manifest), invalid.name).rejects.toThrow();
      expect(snapshotProtectedState(target), invalid.name).toEqual(before);
    }

    const missing = await expandAndParseTwice(1);
    const namedBytes = readFileSync(missing.manifest);
    const siblingManifest = join(missing.directory, "newer sibling evidence.json");
    writeFileSync(siblingManifest, namedBytes);
    writeFileSync(`${siblingManifest}.sqlite-backup`, readFileSync(`${missing.manifest}.sqlite-backup`));
    rmSync(missing.manifest);
    const beforeMissing = snapshotProtectedState(missing.target);
    await expect(recordReadiness(missing.target, missing.manifest)).rejects.toThrow();
    expect(snapshotProtectedState(missing.target)).toEqual(beforeMissing);

    const relative = await expandAndParseTwice(1);
    const beforeRelative = snapshotProtectedState(relative.target);
    await expect(
      runAuditCanonical({
        sqlitePath: relative.target,
        args: ["--strict", "--record-finalization-readiness", "--backup-manifest", "relative.json"],
      }),
    ).rejects.toThrow(/absolute/i);
    expect(snapshotProtectedState(relative.target)).toEqual(beforeRelative);
  });

  test("refuses every incomplete or stale readiness state without changing protected rows", async () => {
    const immediate = makePaths();
    seedLegacyDatabase(immediate.target, 1);
    await runMigrateCanonical({
      sqlitePath: immediate.target,
      approvedTargetPath: immediate.target,
      args: ["--stage", "expand", "--apply", "--backup-manifest", immediate.manifest],
    });
    const immediateBefore = snapshotProtectedState(immediate.target);
    await expect(finalize(immediate.target, immediate.manifest)).rejects.toThrow();
    expect(snapshotProtectedState(immediate.target)).toEqual(immediateBefore);

    const onePass = makePaths();
    seedLegacyDatabase(onePass.target, 1);
    await runMigrateCanonical({
      sqlitePath: onePass.target,
      approvedTargetPath: onePass.target,
      args: ["--stage", "expand", "--apply", "--backup-manifest", onePass.manifest],
    });
    const onePassDb = new Database(onePass.target);
    await runParse({ db: onePassDb, runId: "only-parse", now: () => 1_700_300_000 });
    onePassDb.close();
    const onePassBefore = snapshotProtectedState(onePass.target);
    await expect(recordReadiness(onePass.target, onePass.manifest)).rejects.toThrow(/no-op|unchanged|readiness/i);
    expect(snapshotProtectedState(onePass.target)).toEqual(onePassBefore);

    const unrecorded = await expandAndParseTwice(1);
    const unrecordedBefore = snapshotProtectedState(unrecorded.target);
    await expect(finalize(unrecorded.target, unrecorded.manifest)).rejects.toThrow(/readiness/i);
    expect(snapshotProtectedState(unrecorded.target)).toEqual(unrecordedBefore);

    const drifts: Array<{
      name: string;
      mutate: (db: DatabaseType, manifestPath: string) => void;
    }> = [
      {
        name: "legacy body",
        mutate: (db) => db.prepare("UPDATE updates SET raw_body = raw_body || ' stale'").run(),
      },
      {
        name: "GID alias",
        mutate: (db) => db.prepare("DELETE FROM external_identifiers WHERE namespace='steam_news_gid'").run(),
      },
      {
        name: "publisher locator",
        mutate: (db) => db.prepare("DELETE FROM source_locators WHERE namespace='steam_news_url'").run(),
      },
      {
        name: "source head",
        mutate: (db) => {
          const row = db.prepare(
            `SELECT head.document_id, head.source_record_id, source.pristine_body
               FROM document_source_heads head
               JOIN source_records source ON source.id = head.source_record_id
              LIMIT 1`,
          ).get() as { document_id: string; source_record_id: string; pristine_body: string };
          const body = `${row.pristine_body} changed`;
          db.prepare(
            `INSERT INTO source_records
               (id, document_id, source_adapter, body_format, pristine_body, body_sha256,
                fetched_at, supersedes_source_record_id)
             VALUES ('stale-source-head', ?, 'steam_news', 'bbcode', ?, ?, 9, ?)`,
          ).run(row.document_id, body, sha256(body), row.source_record_id);
          db.prepare(
            `UPDATE document_source_heads
                SET source_record_id='stale-source-head', updated_at=9
              WHERE document_id=? AND source_adapter='steam_news'`,
          ).run(row.document_id);
        },
      },
      {
        name: "parser assignment",
        mutate: (db) => db.prepare("UPDATE document_parse_state SET parser_version='stale'").run(),
      },
      {
        name: "quarantine state",
        mutate: (db) => {
          db.prepare(
            `UPDATE document_parse_state
                SET selection_state='quarantined_zero_match', parser_key=NULL, parser_version=NULL,
                    materialization_status='unparsed'`,
          ).run();
          db.prepare("UPDATE documents SET parse_status='quarantined'").run();
        },
      },
      {
        name: "partial state",
        mutate: (db) => {
          db.prepare("UPDATE document_parse_state SET materialization_status='partial'").run();
          db.prepare("UPDATE documents SET parse_status='partial'").run();
        },
      },
      {
        name: "nonzero canonical tag",
        mutate: (db) => {
          const fragment = db.prepare("SELECT id FROM search_fragments LIMIT 1").pluck().get() as string;
          db.prepare(
            "INSERT INTO fragment_tags (fragment_id, kind, value, source) VALUES (?, 'category', 'stale', 'test')",
          ).run(fragment);
        },
      },
      {
        name: "foreign key violation",
        mutate: (db) => {
          db.pragma("foreign_keys = OFF");
          db.prepare(
            `INSERT INTO source_locators
               (id, document_id, namespace, locator, locator_kind, created_at)
             VALUES ('orphan-locator', 'missing-document', 'test', 'orphan', 'publisher', 1)`,
          ).run();
        },
      },
      {
        name: "no-op run",
        mutate: (db) => db.prepare("UPDATE parse_runs SET status='failed' WHERE id='second-noop-parse'").run(),
      },
      {
        name: "missing backup",
        mutate: (_db, manifestPath) => rmSync(`${manifestPath}.sqlite-backup`),
      },
      {
        name: "stale manifest",
        mutate: (_db, manifestPath) => {
          const manifest = readManifest(manifestPath);
          writeManifest(manifestPath, { ...manifest, created_at: "2000-01-01T00:00:00.000Z" });
        },
      },
    ];

    for (const drift of drifts) {
      const ready = await expandAndParseTwice(1);
      await recordReadiness(ready.target, ready.manifest);
      const db = new Database(ready.target);
      db.pragma("foreign_keys = ON");
      drift.mutate(db, ready.manifest);
      db.close();
      const before = snapshotProtectedState(ready.target);

      await expect(finalize(ready.target, ready.manifest), drift.name).rejects.toThrow();
      expect(snapshotProtectedState(ready.target), drift.name).toEqual(before);
    }
  });

  test("finalizes atomically to the same canonical-only schema as a fresh database and restores the named backup", async () => {
    const rollback = await expandAndParseTwice(2);
    await recordReadiness(rollback.target, rollback.manifest);
    const beforeInjectedFailure = snapshotProtectedState(rollback.target);
    await expect(
      runMigrateCanonical({
        sqlitePath: rollback.target,
        approvedTargetPath: rollback.target,
        args: ["--stage", "finalize", "--apply", "--backup-manifest", rollback.manifest],
        hooks: { afterPrototypeDrop: () => { throw new Error("injected finalization failure"); } },
      }),
    ).rejects.toThrow(/injected finalization failure/i);
    expect(snapshotProtectedState(rollback.target)).toEqual(beforeInjectedFailure);

    const ready = await expandAndParseTwice(2);
    await recordReadiness(ready.target, ready.manifest);
    const evidence = readManifest(ready.manifest);
    await finalize(ready.target, ready.manifest);
    await finalize(ready.target, ready.manifest);

    const migrated = new Database(ready.target, { readonly: true });
    expect(migrated.pragma("user_version", { simple: true })).toBe(2);
    expect(
      migrated
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('updates','sections','lines','line_tags') ORDER BY name",
        )
        .pluck()
        .all(),
    ).toEqual([]);
    expect(migrated.prepare("SELECT count(*) FROM documents").pluck().get()).toBe(2);
    expect(migrated.prepare("SELECT count(*) FROM canonical_cutover_audits").pluck().get()).toBe(1);

    const fresh = new Database(":memory:");
    initializeCanonicalSchema(fresh);
    const schemaSql = (db: DatabaseType): unknown[] => db
      .prepare(
        `SELECT type, name, tbl_name, sql
           FROM sqlite_master
          WHERE name NOT LIKE 'sqlite_%'
          ORDER BY type, name`,
      )
      .all();
    expect(schemaSql(migrated)).toEqual(schemaSql(fresh));
    fresh.close();
    migrated.close();

    const restored = new Database(evidence.backup.path, { readonly: true, fileMustExist: true });
    expect(restored.pragma("quick_check", { simple: true })).toBe("ok");
    expect(restored.pragma("user_version", { simple: true })).toBe(0);
    expect(restored.prepare("SELECT count(*) FROM updates").pluck().get()).toBe(2);
    const restoredRows = restored.prepare("SELECT id, raw_body FROM updates ORDER BY id").all() as Array<{
      id: string;
      raw_body: string;
    }>;
    expect(restoredRows.map((row) => [row.id, row.raw_body])).toEqual(
      [...ready.bodies].sort(([left], [right]) => left.localeCompare(right)),
    );
    restored.close();
  });
});

test("CLI registry exposes separate expansion, readiness, finalization, and post-audit contracts", async () => {
  expect(COMMANDS["migrate-canonical"]).toEqual({
    module: "./migrate.js",
    runner: "runMigrateCanonical",
  });
  expect(COMMANDS["audit-canonical"]).toEqual({
    module: "./migrate.js",
    runner: "runAuditCanonical",
  });
  expect(() => parseMigrateCanonicalArgs([])).toThrow();
  expect(() => parseMigrateCanonicalArgs(["--stage", "finalize", "--apply"])).toThrow();
  expect(parseMigrateCanonicalArgs(["--stage", "finalize", "--apply", "--backup-manifest", "/tmp/evidence.json"])).toEqual({
    stage: "finalize",
    apply: true,
    backupManifestPath: "/tmp/evidence.json",
  });
  expect(() => parseMigrateCanonicalArgs(["--stage", "expand", "--bogus"])).toThrow();
  expect(() => parseAuditCanonicalArgs([])).toThrow();
  expect(() => parseAuditCanonicalArgs(["--strict", "--bogus"])).toThrow();
  expect(parseAuditCanonicalArgs([
    "--strict",
    "--record-finalization-readiness",
    "--backup-manifest",
    "/tmp/evidence.json",
  ])).toEqual({
    strict: true,
    recordFinalizationReadiness: true,
    backupManifestPath: "/tmp/evidence.json",
  });

  const originalArgv = process.argv;
  try {
    process.argv = ["node", "pipeline", "migrate-canonical"];
    await expect(main()).rejects.toThrow(/stage expand/i);
    process.argv = ["node", "pipeline", "migrate-canonical", "--unknown"];
    await expect(main()).rejects.toThrow(/unknown/i);
  } finally {
    process.argv = originalArgv;
  }
});
