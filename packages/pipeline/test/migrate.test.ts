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
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { COMMANDS } from "../src/cli.js";
import {
  parseAuditCanonicalArgs,
  parseMigrateCanonicalArgs,
  runAuditCanonical,
  runMigrateCanonical,
  type CanonicalBackupManifest,
} from "../src/migrate.js";

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

test("CLI registry exposes only expansion and strict audit contracts", () => {
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
  expect(() => parseMigrateCanonicalArgs(["--stage", "expand", "--bogus"])).toThrow();
  expect(() => parseAuditCanonicalArgs([])).toThrow();
  expect(() => parseAuditCanonicalArgs(["--strict", "--bogus"])).toThrow();
});
