import { createHash, randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { createDocumentId, createSourceRecordId } from "../ids.js";
import type {
  BodyFormat,
  Channel,
  ContentKind,
  DocumentRow,
  Game,
  SourceRecordRow,
} from "../../types.js";

export const STEAM_GID_NAMESPACE = "steam_news_gid";
export const STEAM_URL_NAMESPACE = "steam_news_url";

export interface SteamSourceRecordInput {
  gid: string;
  url: string | null;
  title: string;
  posted_at: number;
  game: Game;
  channel: Channel;
  content_kind: ContentKind;
  source_adapter: string;
  body_format: BodyFormat;
  pristine_body: string;
  fetched_at: number;
}

export interface UpsertSteamSourceRecordResult {
  document: DocumentRow;
  source_record: SourceRecordRow;
  created_document: boolean;
  created_source_record: boolean;
}

export type DocumentReference =
  | { id: string }
  | {
      namespace: string;
      value: string;
    };

function bodySha256(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function getDocumentById(db: Database, id: string): DocumentRow | undefined {
  return db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as DocumentRow | undefined;
}

/** Resolve a globally unique external identifier without similarity matching. */
export function getDocumentByExternalIdentifier(
  db: Database,
  namespace: string,
  value: string,
): DocumentRow | undefined {
  return db
    .prepare(
      `SELECT d.*
         FROM external_identifiers identifier
         JOIN documents d ON d.id = identifier.document_id
        WHERE identifier.namespace = ? AND identifier.value = ?`,
    )
    .get(namespace, value) as DocumentRow | undefined;
}

/**
 * Resolve an opaque canonical ID or a namespaced external identifier/locator.
 * Namespaced lookups deliberately have no title, date, or body fallback.
 */
export function resolveDocumentReference(
  db: Database,
  reference: DocumentReference,
): DocumentRow | undefined {
  if ("id" in reference) return getDocumentById(db, reference.id);

  const rows = db
    .prepare(
      `SELECT d.*
         FROM documents d
        WHERE d.id IN (
          SELECT document_id
            FROM external_identifiers
           WHERE namespace = @namespace AND value = @value
          UNION
          SELECT document_id
            FROM source_locators
           WHERE namespace = @namespace AND locator = @value
        )`,
    )
    .all(reference) as DocumentRow[];

  if (rows.length > 1) {
    throw new Error(`Ambiguous document reference in namespace ${reference.namespace}`);
  }
  return rows[0];
}

/** Read parser input only through the explicit adapter-specific current head. */
export function getCurrentSourceRecord(
  db: Database,
  documentId: string,
  sourceAdapter: string,
): SourceRecordRow | undefined {
  return db
    .prepare(
      `SELECT source.*
         FROM document_source_heads head
         JOIN source_records source
           ON source.document_id = head.document_id
          AND source.source_adapter = head.source_adapter
          AND source.id = head.source_record_id
        WHERE head.document_id = ? AND head.source_adapter = ?`,
    )
    .get(documentId, sourceAdapter) as SourceRecordRow | undefined;
}

/**
 * Atomically bind Steam identity, append unseen pristine bytes, and select the
 * current immutable revision. Parser-derived state is intentionally untouched.
 */
export function upsertSteamSourceRecord(
  db: Database,
  input: SteamSourceRecordInput,
): UpsertSteamSourceRecordResult {
  const transact = db.transaction((): UpsertSteamSourceRecordResult => {
    let document = getDocumentByExternalIdentifier(db, STEAM_GID_NAMESPACE, input.gid);
    const createdDocument = document === undefined;

    if (document === undefined) {
      const documentId = createDocumentId();
      db.prepare(
        `INSERT INTO documents
           (id, content_kind, title, posted_at, game, channel, parse_status)
         VALUES (@id, @content_kind, @title, @posted_at, @game, @channel, 'unparsed')`,
      ).run({ ...input, id: documentId });
      db.prepare(
        `INSERT INTO external_identifiers (namespace, value, document_id, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(STEAM_GID_NAMESPACE, input.gid, documentId, input.fetched_at);
      document = getDocumentById(db, documentId)!;
    } else {
      db.prepare(
        `UPDATE documents
            SET content_kind = @content_kind,
                title = @title,
                posted_at = @posted_at,
                game = @game,
                channel = @channel
          WHERE id = @id`,
      ).run({ ...input, id: document.id });
      document = getDocumentById(db, document.id)!;
    }

    const hash = bodySha256(input.pristine_body);
    let sourceRecord = db
      .prepare(
        `SELECT * FROM source_records
          WHERE document_id = ? AND source_adapter = ? AND body_sha256 = ?`,
      )
      .get(document.id, input.source_adapter, hash) as SourceRecordRow | undefined;
    const createdSourceRecord = sourceRecord === undefined;
    const currentSource = getCurrentSourceRecord(db, document.id, input.source_adapter);

    if (sourceRecord !== undefined && sourceRecord.pristine_body !== input.pristine_body) {
      throw new Error("SHA-256 collision detected for distinct pristine source bytes");
    }

    if (sourceRecord === undefined) {
      const sourceRecordId = createSourceRecordId();
      db.prepare(
        `INSERT INTO source_records
           (id, document_id, source_adapter, body_format, pristine_body, body_sha256,
            fetched_at, supersedes_source_record_id)
         VALUES
           (@id, @document_id, @source_adapter, @body_format, @pristine_body, @body_sha256,
            @fetched_at, @supersedes_source_record_id)`,
      ).run({
        id: sourceRecordId,
        document_id: document.id,
        source_adapter: input.source_adapter,
        body_format: input.body_format,
        pristine_body: input.pristine_body,
        body_sha256: hash,
        fetched_at: input.fetched_at,
        supersedes_source_record_id: currentSource?.id ?? null,
      });
      sourceRecord = db
        .prepare("SELECT * FROM source_records WHERE id = ?")
        .get(sourceRecordId) as SourceRecordRow;
    }

    if (currentSource?.id !== sourceRecord.id) {
      db.prepare(
        `INSERT INTO document_source_heads
           (document_id, source_adapter, source_record_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(document_id, source_adapter) DO UPDATE SET
           source_record_id = excluded.source_record_id,
           updated_at = excluded.updated_at`,
      ).run(document.id, input.source_adapter, sourceRecord.id, input.fetched_at);
    }

    if (input.url !== null && input.url.length > 0) {
      const locator = db
        .prepare(
          `SELECT document_id
             FROM source_locators
            WHERE namespace = ? AND locator = ?`,
        )
        .get(STEAM_URL_NAMESPACE, input.url) as { document_id: string } | undefined;

      if (locator !== undefined && locator.document_id !== document.id) {
        throw new Error("Steam publisher locator is already bound to another document");
      }
      if (locator === undefined) {
        db.prepare(
          `INSERT INTO source_locators
             (id, document_id, source_record_id, namespace, locator, locator_kind, created_at)
           VALUES (?, ?, ?, ?, ?, 'publisher', ?)`,
        ).run(
          randomUUID(),
          document.id,
          sourceRecord.id,
          STEAM_URL_NAMESPACE,
          input.url,
          input.fetched_at,
        );
      } else {
        db.prepare(
          `UPDATE source_locators
              SET source_record_id = ?
            WHERE namespace = ? AND locator = ?`,
        ).run(sourceRecord.id, STEAM_URL_NAMESPACE, input.url);
      }
    }

    return {
      document,
      source_record: sourceRecord,
      created_document: createdDocument,
      created_source_record: createdSourceRecord,
    };
  });

  return transact();
}
