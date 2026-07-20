import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { stageB64Attachments } from "../src/tools/send.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

describe("stageB64Attachments()", () => {
  it("decodes entries to real files under a fresh temp dir", () => {
    const staged = stageB64Attachments(
      JSON.stringify([
        { filename: "hello.txt", content_base64: b64("hello world") },
        { filename: "note.md", content_base64: b64("# note") },
      ]),
    );
    expect(staged.error).toBeNull();
    expect(staged.tmpdir).toBeTruthy();
    if (staged.tmpdir) cleanup.push(staged.tmpdir);
    expect(staged.paths).toHaveLength(2);
    expect(readFileSync(staged.paths[0], "utf8")).toBe("hello world");
    expect(readFileSync(staged.paths[1], "utf8")).toBe("# note");
    expect(staged.paths[0].endsWith("hello.txt")).toBe(true);
  });

  it("strips path components from filenames (no traversal)", () => {
    const staged = stageB64Attachments(
      JSON.stringify([{ filename: "../../etc/passwd", content_base64: b64("x") }]),
    );
    expect(staged.error).toBeNull();
    if (staged.tmpdir) cleanup.push(staged.tmpdir);
    expect(staged.paths[0].endsWith("/passwd")).toBe(true);
    expect(staged.paths[0]).not.toContain("..");
  });

  it("disambiguates duplicate display names", () => {
    const staged = stageB64Attachments(
      JSON.stringify([
        { filename: "a.txt", content_base64: b64("one") },
        { filename: "a.txt", content_base64: b64("two") },
      ]),
    );
    expect(staged.error).toBeNull();
    if (staged.tmpdir) cleanup.push(staged.tmpdir);
    expect(staged.paths[0]).not.toBe(staged.paths[1]);
    expect(readFileSync(staged.paths[0], "utf8")).toBe("one");
    expect(readFileSync(staged.paths[1], "utf8")).toBe("two");
  });

  it("rejects invalid JSON without leaving a temp dir", () => {
    const staged = stageB64Attachments("not json");
    expect(staged.error).toMatch(/valid JSON/);
    expect(staged.tmpdir).toBeNull();
    expect(staged.paths).toHaveLength(0);
  });

  it("rejects a non-list payload", () => {
    const staged = stageB64Attachments(JSON.stringify({ filename: "x" }));
    expect(staged.error).toMatch(/JSON list/);
    expect(staged.tmpdir).toBeNull();
  });

  it("rejects an empty list", () => {
    const staged = stageB64Attachments(JSON.stringify([]));
    expect(staged.error).toMatch(/empty list/);
    expect(staged.tmpdir).toBeNull();
  });

  it("rejects an entry missing content_base64 and cleans up", () => {
    const staged = stageB64Attachments(JSON.stringify([{ filename: "x.txt" }]));
    expect(staged.error).toMatch(/missing content_base64/);
    expect(staged.tmpdir).toBeNull();
    expect(staged.paths).toHaveLength(0);
  });

  it("does not leak the temp dir on a mid-list failure", () => {
    const staged = stageB64Attachments(
      JSON.stringify([
        { filename: "ok.txt", content_base64: b64("ok") },
        { filename: "bad.txt" },
      ]),
    );
    expect(staged.error).toMatch(/missing content_base64/);
    expect(staged.tmpdir).toBeNull();
    // The partial temp dir created before the failure must be gone.
    expect(staged.paths.every((p) => !existsSync(p))).toBe(true);
  });
});
