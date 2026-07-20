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
import { existsSync, statSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
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

// ── Inline (base64) attachments ───────────────────────────────────────
// Sane runs on prod with no filesystem access to this Mac, so it cannot
// use the path-based `attachments` param. Instead it passes the bytes
// inline as `attachments_b64`: a JSON list of objects shaped like
//   {"filename": "photo.jpg", "content_base64": "<b64>"}
// Each entry is decoded and written to a fresh, secure per-call temp dir
// (mkdtemp under the OS tempdir); the resolved paths then feed the same
// AppleScript path used for `attachments`. The caller must remove the
// returned tmpdir when done. Mirrors the apple-mail-mcp fork pattern.

export interface StagedB64 {
  paths: string[];
  tmpdir: string | null;
  error: string | null;
}

export function stageB64Attachments(attachmentsB64: string): StagedB64 {
  let items: unknown;
  try {
    items = JSON.parse(attachmentsB64);
  } catch (e) {
    return { paths: [], tmpdir: null, error: `attachments_b64 must be valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!Array.isArray(items)) {
    return { paths: [], tmpdir: null, error: "attachments_b64 must be a JSON list of {filename, content_base64}." };
  }
  if (items.length === 0) {
    return { paths: [], tmpdir: null, error: "attachments_b64 is an empty list." };
  }

  const tmpdir = mkdtempSync(path.join(os.tmpdir(), "sane-b64-att-"));
  const fail = (msg: string): StagedB64 => {
    rmSync(tmpdir, { recursive: true, force: true });
    return { paths: [], tmpdir: null, error: msg };
  };

  const paths: string[] = [];
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx] as Record<string, unknown>;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return fail(`attachments_b64[${idx}] must be an object with filename and content_base64.`);
    }
    const rawName = (item.filename as string) || `attachment-${idx}`;
    const contentB64 = item.content_base64;
    if (!contentB64 || typeof contentB64 !== "string") {
      return fail(`attachments_b64[${idx}] is missing content_base64.`);
    }
    // Strip any path component — the recipient only sees the basename and
    // we never want "../etc/passwd" escaping the temp dir.
    const safeName = path.basename(String(rawName)) || `attachment-${idx}`;
    let payload: Buffer;
    try {
      payload = Buffer.from(contentB64, "base64");
      if (payload.length === 0 && contentB64.length > 0) {
        return fail(`attachments_b64[${idx}] base64 decode failed: empty output`);
      }
    } catch (e) {
      return fail(`attachments_b64[${idx}] base64 decode failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Guard against two entries with the same display name clobbering.
    let dest = path.join(tmpdir, safeName);
    if (existsSync(dest)) {
      const ext = path.extname(safeName);
      const stem = path.basename(safeName, ext);
      dest = path.join(tmpdir, `${stem}-${idx}${ext}`);
    }
    try {
      writeFileSync(dest, payload);
    } catch (e) {
      return fail(`attachments_b64[${idx}] write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    paths.push(dest);
  }
  return { paths, tmpdir, error: null };
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
    "Send an iMessage (or SMS fallback) to a contact or group chat. `to` may be a phone number, email, chat_identifier (e.g. 'chat123456789'), or full chat GUID. Optional `attachments` is a list of absolute file paths the host (Mac) can read; `attachments_b64` carries inline bytes for callers without Mac filesystem access. Returns once Messages.app has accepted the message — there is NO delivered/read signal in the response.",
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
      attachments_b64: z
        .string()
        .optional()
        .describe(
          'Inline attachments for callers without filesystem access to this Mac (e.g. Sane on prod). A JSON list of objects {"filename": "<name>", "content_base64": "<base64 bytes>"}. Each is decoded to a secure per-call temp file, attached by path, and deleted after the send. Combine freely with `attachments`.',
        ),
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
      // Stage inline (base64) attachments into a per-call temp dir. These
      // paths are appended to any host-path `attachments` and cleaned up in
      // the finally block below regardless of send outcome.
      let b64Tmpdir: string | null = null;
      const b64Paths: string[] = [];
      if (params.attachments_b64) {
        const staged = stageB64Attachments(params.attachments_b64);
        if (staged.error) {
          return {
            isError: true,
            content: [{ type: "text", text: `send_message: ${staged.error}` }],
          };
        }
        b64Tmpdir = staged.tmpdir;
        b64Paths.push(...staged.paths);
      }

      try {
        const attachments = [...(params.attachments ?? []), ...b64Paths];
        if (text.length === 0 && attachments.length === 0) {
          return {
            isError: true,
            content: [{ type: "text", text: "send_message: provide `text` and/or `attachments`/`attachments_b64`" }],
          };
        }
        // Validate every attachment path exists and is a regular file before
        // we hand off to AppleScript — Messages.app's failure mode on a
        // missing path is a silent UI alert with no stderr, which would
        // otherwise look like a successful send. (Staged b64 paths are
        // absolute + freshly written, so they pass these checks too.)
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
      } finally {
        if (b64Tmpdir) rmSync(b64Tmpdir, { recursive: true, force: true });
      }
    },
  );
}
