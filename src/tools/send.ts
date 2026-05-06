// Send tool -- send_message
//
// AppleScript-driven send via the local Messages.app. Supports 1:1
// (phone/email recipient) and group (chat_identifier) targets, with
// optional file attachments.
//
// Constraints inherited from Messages.app:
//   - Messages.app must be signed-in. macOS will pop a one-time
//     "allow control" prompt the first time; users have to grant it
//     in System Settings → Privacy & Security → Automation.
//   - There's no synchronous "delivered" signal. We return as soon as
//     osascript exits cleanly; failure modes that surface later (e.g.
//     iMessage routing failures, green-bubble fallback) are NOT in
//     the response.

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const OSASCRIPT_TIMEOUT_MS = 30_000;

interface OsaResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

function runOsascript(script: string): Promise<OsaResult> {
  return new Promise((resolve) => {
    const proc = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
    }, OSASCRIPT_TIMEOUT_MS);
    proc.stdout.on("data", (b) => { stdout += b.toString(); });
    proc.stderr.on("data", (b) => { stderr += b.toString(); });
    proc.on("close", (code) => {
      if (timer) { clearTimeout(timer); timer = null; }
      resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), code });
    });
  });
}

// AppleScript string-literal escaping. Backslashes and double-quotes
// are the only chars osascript -e mishandles when wrapped in shell
// arguments via spawn (we don't pass through a shell, so no shell
// escaping needed).
function asLiteral(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

interface RecipientResolution {
  kind: "buddy" | "chat";
  // For buddies — the raw handle (phone/email).
  // For chats   — the chat_identifier (e.g. "chat123456789").
  identifier: string;
}

function resolveRecipient(to: string): RecipientResolution {
  // Group chat: chat_identifier always starts with "chat" followed by
  // digits, OR may be passed as the full GUID "iMessage;+;chat...".
  // Strip the GUID prefix if present.
  const guidMatch = to.match(/^iMessage;[+\-];(.+)$/);
  if (guidMatch) {
    return { kind: "chat", identifier: guidMatch[1] };
  }
  if (/^chat\d+$/i.test(to)) {
    return { kind: "chat", identifier: to };
  }
  return { kind: "buddy", identifier: to };
}

function buildSendScript(
  rec: RecipientResolution,
  text: string | undefined,
  attachments: string[],
  service: "iMessage" | "SMS",
): string {
  const lines: string[] = [];
  lines.push('tell application "Messages"');
  if (rec.kind === "buddy") {
    // service id "iMessage" or "SMS". Falls back to first matching
    // service if the named one is missing.
    lines.push(`  set targetService to 1st service whose service type = ${service}`);
    lines.push(`  set theTarget to buddy ${asLiteral(rec.identifier)} of targetService`);
  } else {
    // Chat targets are looked up by chat_identifier; AppleScript's
    // `text chat id` form is more reliable than iterating chats.
    lines.push(`  set theTarget to first chat whose name is ${asLiteral(rec.identifier)} or id contains ${asLiteral(rec.identifier)}`);
  }
  if (text && text.length > 0) {
    lines.push(`  send ${asLiteral(text)} to theTarget`);
  }
  for (const att of attachments) {
    lines.push(`  send (POSIX file ${asLiteral(att)}) to theTarget`);
  }
  lines.push("end tell");
  return lines.join("\n");
}

export function registerSendTools(server: McpServer) {
  server.tool(
    "send_message",
    "Send an iMessage (or SMS fallback) to a contact or group chat. `to` may be a phone number, email, chat_identifier (e.g. 'chat123456789'), or full chat GUID. Optional `attachments` is a list of absolute file paths the host (Mac) can read. Returns once Messages.app has accepted the message — there is NO delivered/read signal in the response.",
    {
      to: z
        .string()
        .min(1)
        .describe("Phone number, email, chat_identifier, or full chat GUID"),
      text: z
        .string()
        .optional()
        .describe("Message body. Optional if attachments is non-empty."),
      attachments: z
        .array(z.string())
        .optional()
        .describe("Absolute file paths on the Mac to attach (images, documents, etc.)"),
      service: z
        .enum(["iMessage", "SMS"])
        .optional()
        .describe("Service to send through; defaults to iMessage"),
    },
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (params) => {
      const text = params.text ?? "";
      const attachments = params.attachments ?? [];
      if (text.length === 0 && attachments.length === 0) {
        return {
          isError: true,
          content: [{ type: "text", text: "send_message: provide `text` and/or `attachments`" }],
        };
      }
      // Validate every attachment path exists and is a regular file before
      // we hand off to AppleScript — Messages.app's failure mode on a
      // missing path is a silent UI alert with no stderr, which would
      // otherwise look like a successful send.
      for (const att of attachments) {
        if (!path.isAbsolute(att)) {
          return {
            isError: true,
            content: [{ type: "text", text: `attachment path must be absolute: ${att}` }],
          };
        }
        if (!existsSync(att)) {
          return {
            isError: true,
            content: [{ type: "text", text: `attachment not found: ${att}` }],
          };
        }
        const st = statSync(att);
        if (!st.isFile()) {
          return {
            isError: true,
            content: [{ type: "text", text: `attachment is not a regular file: ${att}` }],
          };
        }
      }

      const rec = resolveRecipient(params.to);
      const service = params.service ?? "iMessage";
      const script = buildSendScript(rec, text, attachments, service);
      const result = await runOsascript(script);
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
              recipient_kind: rec.kind,
              recipient: rec.identifier,
              service,
              text_sent: text.length > 0,
              attachments_sent: attachments.length,
            }),
          },
        ],
      };
    },
  );
}
