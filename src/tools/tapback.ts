// Send tool -- send_tapback
//
// iMessage's "real" tapbacks (Loved / Liked / Disliked / Laughed /
// Emphasized / Questioned) are stored in chat.db as separate rows
// with associated_message_type 2000-2005, but Messages.app exposes
// no AppleScript verb for sending one. The reliable workaround is
// to send a text-format tapback like "Liked: <original>" — recent
// macOS / iOS render that as a native tapback; older clients see a
// quoted message, which is still useful.
//
// This tool resolves the original message text by rowid (so the
// caller doesn't have to fetch it themselves), maps the emoji to a
// tapback verb, then falls through to the same AppleScript send
// path send_message uses. Net cost: one extra DB read; output is
// the same shape send_message returns.

import { spawn } from "node:child_process";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../db.js";

const OSASCRIPT_TIMEOUT_MS = 30_000;

// Emoji → iMessage tapback verb. The verbs are exactly the strings
// macOS uses internally so recipients on a recent client see a real
// tapback; older clients fall back to a quoted message that still
// reads correctly.
const VERB_BY_EMOJI: Record<string, string> = {
  "❤️": "Loved",
  "❤": "Loved",
  "👍": "Liked",
  "👎": "Disliked",
  "😂": "Laughed at",
  "‼️": "Emphasized",
  "‼": "Emphasized",
  "😮": "Emphasized",
  "❓": "Questioned",
  "?": "Questioned",
};

function runOsascript(script: string): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const proc = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
    }, OSASCRIPT_TIMEOUT_MS);
    proc.stdout.on("data", (b) => { stdout += b.toString(); });
    proc.stderr.on("data", (b) => { stderr += b.toString(); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), code });
    });
  });
}

function asLiteral(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

interface ChatRow {
  text: string | null;
  chat_identifier: string | null;
  handle: string | null;
}

function lookupParent(rowid: number): ChatRow | null {
  const db = getDb();
  return (
    (db
      .prepare(
        `SELECT m.text,
                c.chat_identifier,
                h.id   AS handle
           FROM message m
      LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      LEFT JOIN chat c                ON c.ROWID = cmj.chat_id
      LEFT JOIN handle h              ON h.ROWID = m.handle_id
          WHERE m.ROWID = ?
          LIMIT 1`,
      )
      .get(rowid) as ChatRow) ?? null
  );
}

export function registerTapbackTools(server: McpServer) {
  server.tool(
    "send_tapback",
    "Send an iMessage tapback to the message at the given chat.db ROWID. Resolves the parent message's text and sends 'Liked: …' / 'Loved: …' / etc., which renders as a native tapback on recent iMessage clients and as a quoted reply on older ones. `remove: true` sends 'Removed a Like: …' to undo.",
    {
      message_rowid: z.number().int().describe("message.ROWID of the message being reacted to"),
      reaction: z
        .string()
        .min(1)
        .describe("Emoji or text reaction (👍, ❤️, 😂, 😮, 😢, 🙏, 🔥, 👎). Unknown emojis fall back to a literal quote."),
      remove: z.boolean().optional().describe("If true, send a 'Removed a …' undo instead of a fresh tapback."),
    },
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (params) => {
      const parent = lookupParent(params.message_rowid);
      if (!parent) {
        return {
          isError: true,
          content: [{ type: "text", text: `message ${params.message_rowid} not found` }],
        };
      }
      const verb = VERB_BY_EMOJI[params.reaction] ?? null;
      const original = (parent.text ?? "").trim();
      // Tapback recipient: prefer the chat_identifier (works for both
      // 1:1 and group); fall back to the handle for ancient threads
      // where chat.db never recorded a chat row.
      const target = parent.chat_identifier ?? parent.handle ?? null;
      if (!target) {
        return {
          isError: true,
          content: [{ type: "text", text: "could not resolve target chat from message ROWID" }],
        };
      }

      // Compose the message body. Real tapback verbs render natively
      // on recent clients ("Liked '…'"). Unknown emojis send the
      // emoji as a regular text reply quoting the original — still
      // legible, just not a native tapback.
      const body = (() => {
        if (verb) {
          return params.remove
            ? `Removed a ${verb}: ${original}`
            : `${verb}: ${original}`;
        }
        return `${params.reaction} ${original ? `: ${original}` : ""}`;
      })();

      // Reuse send_message's AppleScript shape exactly — the only
      // delta is we already know the chat_identifier.
      const lines = [
        'tell application "Messages"',
        `  set theTarget to first chat whose name is ${asLiteral(target)} or id contains ${asLiteral(target)}`,
        `  send ${asLiteral(body)} to theTarget`,
        "end tell",
      ];
      const result = await runOsascript(lines.join("\n"));
      if (!result.ok) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `osascript failed (exit ${result.code ?? "?"}): ${result.stderr || result.stdout || "(no output)"}`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              target,
              verb,
              body,
              fallback_text_tapback: verb !== null,
            }),
          },
        ],
      };
    },
  );
}
