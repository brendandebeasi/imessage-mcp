// Attachment tools -- list_attachments, read_attachment

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb, DATE_EXPR, getMessageText, safeText } from "../db.js";
import { clamp, DEFAULT_LIMIT, MAX_LIMIT, isoDateSchema } from "../helpers.js";

// Attachments live under ~/Library/Messages/Attachments. The chat.db
// `attachment.filename` column stores either an absolute path (post-
// macOS-12) or a tilde-prefixed one — we expand the latter ourselves
// since SQLite doesn't. Path-traversal guard below uses this constant.
const ATTACHMENTS_ROOT = path.join(homedir(), "Library/Messages/Attachments");
// Hard cap — we return base64 in the MCP text response, so a 25 MB
// video would balloon to ~33 MB of JSON. Most photos are well under.
// Callers needing larger files should fetch by path via a separate
// transport.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function expandTilde(p: string): string {
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

export function registerAttachmentTools(server: McpServer) {
  // -- list_attachments --
  server.tool(
    "list_attachments",
    "Query message attachments (images, videos, audio, documents) with filtering by contact, MIME type, and date range. Returns file metadata, not file contents.",
    {
      contact: z.string().optional().describe("Filter by contact handle"),
      mime_type: z.string().optional().describe("Filter by MIME type prefix (e.g. 'image/', 'video/', 'audio/')"),
      date_from: isoDateSchema.optional().describe("Start date (ISO)"),
      date_to: isoDateSchema.optional().describe("End date (ISO)"),
      limit: z.number().optional().describe("Max results (default 50, max 500)"),
      offset: z.number().optional().describe("Pagination offset"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();
      const limit = clamp(params.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
      const offset = params.offset ?? 0;

      const conditions: string[] = [
        "a.filename IS NOT NULL",
      ];
      const bindings: Record<string, any> = {};

      if (params.contact) {
        conditions.push("h.id LIKE @contact");
        bindings.contact = `%${params.contact}%`;
      }
      if (params.mime_type) {
        conditions.push("a.mime_type LIKE @mime_type");
        bindings.mime_type = `${params.mime_type}%`;
      }
      if (params.date_from) {
        conditions.push(`${DATE_EXPR} >= @date_from`);
        bindings.date_from = params.date_from;
      }
      if (params.date_to) {
        conditions.push(`${DATE_EXPR} <= @date_to`);
        bindings.date_to = params.date_to;
      }

      const where = conditions.join(" AND ");

      // Count
      const countSql = `
        SELECT COUNT(*) as total
        FROM attachment a
        JOIN message_attachment_join maj ON a.ROWID = maj.attachment_id
        JOIN message m ON maj.message_id = m.ROWID
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
      `;
      const countRow = db.prepare(countSql).get(bindings) as any;
      const total = countRow?.total ?? 0;

      const sql = `
        SELECT
          a.ROWID as attachment_id,
          a.filename,
          a.mime_type,
          a.total_bytes,
          a.transfer_name,
          ${DATE_EXPR} as date,
          m.is_from_me,
          h.id as handle,
          m.text as message_text,
          m.attributedBody
        FROM attachment a
        JOIN message_attachment_join maj ON a.ROWID = maj.attachment_id
        JOIN message m ON maj.message_id = m.ROWID
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
        ORDER BY m.date DESC
        LIMIT @limit OFFSET @offset
      `;
      const rows = db.prepare(sql).all({ ...bindings, limit, offset }) as any[];

      // Post-process: extract text from attributedBody when text is null
      for (const row of rows) {
        row.message_text = safeText(getMessageText({ text: row.message_text, attributedBody: row.attributedBody }));
        delete row.attributedBody;
      }

      // MIME type summary
      const typeSummary = db.prepare(`
        SELECT a.mime_type, COUNT(*) as count
        FROM attachment a
        JOIN message_attachment_join maj ON a.ROWID = maj.attachment_id
        JOIN message m ON maj.message_id = m.ROWID
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
        GROUP BY a.mime_type
        ORDER BY count DESC
        LIMIT 20
      `).all(bindings);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total,
            showing: `${offset}-${offset + (rows as any[]).length}`,
            type_summary: typeSummary,
            attachments: rows,
          }, null, 2),
        }],
      };
    },
  );

  // -- get_message_attachments --
  // Lookup-by-message companion for read_attachment. search_messages
  // returns has_attachment: 0|1 but no ROWIDs; clients use this tool
  // to resolve a message's attachments before pulling bytes.
  server.tool(
    "get_message_attachments",
    "Return attachment metadata (ROWIDs, filenames, MIME types, sizes) for a single message. Pair with read_attachment to fetch bytes. Returns an empty list when the message has no attachments.",
    {
      message_rowid: z.number().int().describe("message.ROWID"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();
      const rows = db
        .prepare(
          `SELECT a.ROWID as attachment_id, a.filename, a.mime_type,
                  a.transfer_name, a.total_bytes
             FROM attachment a
             JOIN message_attachment_join maj ON a.ROWID = maj.attachment_id
            WHERE maj.message_id = @id`,
        )
        .all({ id: params.message_rowid });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ message_rowid: params.message_rowid, attachments: rows }),
          },
        ],
      };
    },
  );

  // -- read_attachment --
  // Return the raw bytes for an attachment as base64. Pairs with
  // list_attachments / search_messages, which surface the ROWID.
  // Read-only on chat.db + the attachments directory; refuses any
  // resolved path outside ~/Library/Messages/Attachments to stop a
  // crafted ROWID from coercing the server into reading e.g. ~/.ssh.
  server.tool(
    "read_attachment",
    "Read the raw bytes of an iMessage attachment by its ROWID. Returns base64-encoded data plus filename and MIME type. Use list_attachments to discover ROWIDs. Refuses files larger than 25 MB or outside the Messages attachments directory.",
    {
      attachment_id: z.number().int().describe("attachment.ROWID from list_attachments"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();
      const row = db
        .prepare(
          `SELECT ROWID as attachment_id, filename, mime_type, transfer_name, total_bytes
           FROM attachment WHERE ROWID = @id`,
        )
        .get({ id: params.attachment_id }) as
        | {
            attachment_id: number;
            filename: string | null;
            mime_type: string | null;
            transfer_name: string | null;
            total_bytes: number | null;
          }
        | undefined;
      if (!row || !row.filename) {
        return {
          isError: true,
          content: [{ type: "text", text: `attachment ${params.attachment_id} not found or has no filename` }],
        };
      }
      const expanded = expandTilde(row.filename);
      const resolved = path.resolve(expanded);
      if (!resolved.startsWith(ATTACHMENTS_ROOT + path.sep) && resolved !== ATTACHMENTS_ROOT) {
        return {
          isError: true,
          content: [{ type: "text", text: `refusing to read path outside ${ATTACHMENTS_ROOT}: ${resolved}` }],
        };
      }
      let stat;
      try {
        stat = statSync(resolved);
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `stat failed: ${(err as Error).message}` }],
        };
      }
      if (stat.size > MAX_ATTACHMENT_BYTES) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `attachment is ${stat.size} bytes; exceeds ${MAX_ATTACHMENT_BYTES} cap`,
            },
          ],
        };
      }
      const buf = readFileSync(resolved);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              attachment_id: row.attachment_id,
              filename: row.transfer_name ?? path.basename(resolved),
              mime_type: row.mime_type ?? "application/octet-stream",
              total_bytes: stat.size,
              data_base64: buf.toString("base64"),
            }),
          },
        ],
      };
    },
  );
}
