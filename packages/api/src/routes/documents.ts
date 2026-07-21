import Database, { type Database as DatabaseType } from "better-sqlite3";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  resolveDocumentReference,
  STEAM_GID_NAMESPACE,
  type BlockRow,
  type DocumentReference,
  type DocumentRow,
  type MediaItemRow,
} from "@cs-patchnotes/shared";

const CanonicalIdParamsSchema = z.object({
  id: z.string().uuid(),
});

const ExternalReferenceParamsSchema = z.object({
  namespace: z.literal(STEAM_GID_NAMESPACE),
  value: z.string().regex(/^\d{1,20}$/),
});

const MAX_UNSUPPORTED_DETAIL_LENGTH = 64;

type SafeBlock = Pick<
  BlockRow,
  "id" | "parent_block_id" | "kind" | "preorder" | "sibling_order"
> &
  (
    | Pick<BlockRow, "text" | "label">
    | {
        kind: "unsupported";
        unsupported: {
          source_node_type: string | null;
          source_span: { start: number | null; end: number | null };
          diagnostic_code: string | null;
        };
      }
  );

type SafeMediaItem = Pick<
  MediaItemRow,
  "id" | "group_block_id" | "item_order" | "media_kind" | "caption" | "alt_text"
>;

function boundedDetail(value: string | null): string | null {
  return value?.slice(0, MAX_UNSUPPORTED_DETAIL_LENGTH) ?? null;
}

function toSafeBlock(block: BlockRow): SafeBlock {
  const common = {
    id: block.id,
    parent_block_id: block.parent_block_id,
    kind: block.kind,
    preorder: block.preorder,
    sibling_order: block.sibling_order,
  };

  if (block.kind === "unsupported") {
    return {
      ...common,
      kind: "unsupported",
      unsupported: {
        source_node_type: boundedDetail(block.source_node_type),
        source_span: { start: block.source_start, end: block.source_end },
        diagnostic_code: boundedDetail(block.diagnostic_code),
      },
    };
  }

  return { ...common, text: block.text, label: block.label };
}

function loadDocumentDetail(db: DatabaseType, reference: DocumentReference) {
  const document = resolveDocumentReference(db, reference);
  if (document === undefined) return undefined;

  const blocks = db
    .prepare(
      `SELECT id, document_id, parent_block_id, kind, preorder, sibling_order,
              text, label, source_start, source_end, source_node_type, diagnostic_code
         FROM blocks
        WHERE document_id = ?
        ORDER BY preorder`,
    )
    .all(document.id) as BlockRow[];

  const mediaItems = db
    .prepare(
      `SELECT media.id, media.group_block_id, media.item_order, media.media_kind,
              media.caption, media.alt_text
         FROM media_items media
         JOIN blocks owner
           ON owner.document_id = media.document_id
          AND owner.id = media.group_block_id
        WHERE media.document_id = ?
        ORDER BY owner.preorder, media.item_order`,
    )
    .all(document.id) as SafeMediaItem[];

  const safeDocument: DocumentRow = {
    id: document.id,
    content_kind: document.content_kind,
    title: document.title,
    posted_at: document.posted_at,
    game: document.game,
    channel: document.channel,
    parse_status: document.parse_status,
  };

  return {
    document: safeDocument,
    blocks: blocks.map(toSafeBlock),
    media_items: mediaItems,
  };
}

/** Register source-neutral document detail routes backed by a lazy read-only SQLite handle. */
export async function documentRoutes(app: FastifyInstance): Promise<void> {
  let dbHandle: DatabaseType | undefined;

  function getDb(): DatabaseType {
    if (dbHandle === undefined) {
      dbHandle = new Database(process.env.SQLITE_PATH ?? "./patchnotes.db", {
        readonly: true,
        fileMustExist: true,
      });
      dbHandle.pragma("query_only = ON");
    }
    return dbHandle;
  }

  app.addHook("onClose", async () => {
    if (dbHandle?.open) dbHandle.close();
  });

  function sendDetail(
    reply: FastifyReply,
    reference: DocumentReference,
  ) {
    const detail = loadDocumentDetail(getDb(), reference);
    if (detail === undefined) {
      return reply.code(404).send({ error: "document not found" });
    }
    return detail;
  }

  app.get("/documents/by-ref/:namespace/:value", async (request, reply) => {
    const parsed = ExternalReferenceParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid document reference" });
    }
    return sendDetail(reply, parsed.data);
  });

  app.get("/documents/:id", async (request, reply) => {
    const parsed = CanonicalIdParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid document reference" });
    }
    return sendDetail(reply, parsed.data);
  });
}
