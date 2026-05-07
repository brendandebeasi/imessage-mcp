// Edit / unsend tools — send_edit, send_unsend.
//
// macOS Sequoia exposes edit-message and undo-send to the user's
// fingertips but not to AppleScript. There's no scripting verb,
// no accessibility-stable UI path, and chat.db writes go through
// BlastDoor IPC we can't replicate. The honest path: send a
// follow-up message that reads sensibly across all clients.
//
//   send_edit:    sends "✏️ Edited: <new>" addressed at the
//                 same chat as the parent message.
//   send_unsend:  sends "🗑 Unsent: <original>".
//
// Same chat-resolution path send_tapback uses — look up the
// parent message's chat_identifier / handle by ROWID, then
// dispatch through the existing AppleScript send. Returns the
// composed body so the caller can echo it for confirmation.

import { spawn } from "node:child_process";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../db.js";

const OSASCRIPT_TIMEOUT_MS = 30_000;

function runOsascript(script: string): Promise<{
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}> {
  return new Promise((resolve) => {
    const proc = spawn("osascript", ["-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, OSASCRIPT_TIMEOUT_MS);
    proc.stdout.on("data", (b) => {
      stdout += b.toString();
    });
    proc.stderr.on("data", (b) => {
      stderr += b.toString();
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code,
      });
    });
  });
}

function asLiteral(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

interface ParentRow {
  text: string | null;
  chat_identifier: string | null;
  handle: string | null;
  is_from_me: 0 | 1;
}

function lookupParent(rowid: number): ParentRow | null {
  const db = getDb();
  return (
    (db
      .prepare(
        `SELECT m.text,
                c.chat_identifier,
                h.id   AS handle,
                m.is_from_me
           FROM message m
      LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      LEFT JOIN chat c                ON c.ROWID = cmj.chat_id
      LEFT JOIN handle h              ON h.ROWID = m.handle_id
          WHERE m.ROWID = ?
          LIMIT 1`,
      )
      .get(rowid) as ParentRow) ?? null
  );
}

async function dispatchTextToChat(
  target: string,
  body: string,
): Promise<{ ok: boolean; stderr: string; code: number | null }> {
  const lines = [
    'tell application "Messages"',
    `  set theTarget to first chat whose name is ${asLiteral(target)} or id contains ${asLiteral(target)}`,
    `  send ${asLiteral(body)} to theTarget`,
    "end tell",
  ];
  const r = await runOsascript(lines.join("\n"));
  return { ok: r.ok, stderr: r.stderr || r.stdout, code: r.code };
}

export function registerEditUnsendTools(server: McpServer) {
  server.tool(
    "send_edit",
    "Edit a previously-sent iMessage by sending a follow-up '✏️ Edited: <new>' message addressed to the same chat. macOS doesn't expose Sequoia's native edit-message verb to AppleScript, so this is a text-format compatibility fallback. Recipients on every iMessage version see a clean follow-up with the corrected text.",
    {
      message_rowid: z.number().int().describe("message.ROWID of the message you originally sent"),
      text: z.string().min(1).max(10_000).describe("Replacement text"),
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
          content: [
            { type: "text", text: `message ${params.message_rowid} not found` },
          ],
        };
      }
      if (parent.is_from_me !== 1) {
        return {
          isError: true,
          content: [
            { type: "text", text: "can only edit your own messages" },
          ],
        };
      }
      const target = parent.chat_identifier ?? parent.handle ?? null;
      if (!target) {
        return {
          isError: true,
          content: [
            { type: "text", text: "could not resolve target chat from message ROWID" },
          ],
        };
      }
      const body = `✏️ Edited: ${params.text.trim()}`;
      const result = await dispatchTextToChat(target, body);
      if (!result.ok) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `osascript failed (exit ${result.code ?? "?"}): ${result.stderr || "(no output)"}`,
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
              kind: "edit_fallback",
              body,
              note:
                "iMessage's native edit-message verb isn't exposed to AppleScript. " +
                "This sent a follow-up message visible to all recipients.",
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "send_unsend",
    "'Unsend' a previously-sent iMessage by sending a follow-up '🗑 Unsent: <original>' message addressed to the same chat. macOS doesn't expose Sequoia's native unsend-message verb to AppleScript, so this is a text-format compatibility fallback — the original message remains in everyone's history but the follow-up makes the retraction explicit.",
    {
      message_rowid: z.number().int().describe("message.ROWID of the message you originally sent"),
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
          content: [
            { type: "text", text: `message ${params.message_rowid} not found` },
          ],
        };
      }
      if (parent.is_from_me !== 1) {
        return {
          isError: true,
          content: [
            { type: "text", text: "can only unsend your own messages" },
          ],
        };
      }
      const target = parent.chat_identifier ?? parent.handle ?? null;
      if (!target) {
        return {
          isError: true,
          content: [
            { type: "text", text: "could not resolve target chat from message ROWID" },
          ],
        };
      }
      const original = (parent.text ?? "").trim();
      const body = original ? `🗑 Unsent: ${original}` : "🗑 Unsent a message";
      const result = await dispatchTextToChat(target, body);
      if (!result.ok) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `osascript failed (exit ${result.code ?? "?"}): ${result.stderr || "(no output)"}`,
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
              kind: "unsend_fallback",
              body,
              note:
                "iMessage's native unsend-message verb isn't exposed to AppleScript. " +
                "The original message stays in everyone's chat.db; this sent a follow-up explicit retraction.",
            }),
          },
        ],
      };
    },
  );
}
