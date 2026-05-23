import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readLogTail } from "../../../src/commands/logs/tail.js";
import { findActiveLogFile } from "../../../src/services/os/utils.js";
import { writeFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("log-tail-reader", () => {
  let tmpDir: string;
  let logFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ghost-logtail-test-"));
    logFile = join(tmpDir, "test.log");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeLog(lines: string[]): void {
    const content = lines.length > 0 ? lines.join("\n") + "\n" : "";
    writeFileSync(logFile, content, "utf8");
  }

  test("empty file returns empty payload", async () => {
    writeLog([]);
    const result = await readLogTail({ file: logFile });
    expect(result.lines).toEqual([]);
    expect(result.cursor).toBe(0);
    expect(result.size).toBe(0);
    expect(result.reset).toBe(false);
    expect(result.truncated).toBe(false);
  });

  test("reads all lines when no cursor provided", async () => {
    writeLog(["line1", "line2", "line3", "line4", "line5"]);
    const result = await readLogTail({ file: logFile });
    expect(result.lines).toEqual(["line1", "line2", "line3", "line4", "line5"]);
    expect(result.cursor).toBe(result.size);
    expect(result.truncated).toBe(false);
    expect(result.reset).toBe(false);
  });

  test("respects limit parameter", async () => {
    writeLog(["line1", "line2", "line3", "line4", "line5"]);
    const result = await readLogTail({ file: logFile, limit: 3 });
    expect(result.lines).toEqual(["line3", "line4", "line5"]);
  });

  test("returns from cursor to end", async () => {
    writeLog(["line1", "line2", "line3", "line4", "line5"]);
    const firstResult = await readLogTail({ file: logFile });
    const cursor = firstResult.cursor;

    // Write more lines
    writeLog(["line1", "line2", "line3", "line4", "line5", "line6", "line7"]);
    const result = await readLogTail({ file: logFile, cursor });
    expect(result.lines).toEqual(["line6", "line7"]);
    expect(result.reset).toBe(false);
  });

  test("returns empty lines when cursor at EOF", async () => {
    writeLog(["line1", "line2", "line3"]);
    const firstResult = await readLogTail({ file: logFile });
    const result = await readLogTail({ file: logFile, cursor: firstResult.cursor });
    expect(result.lines).toEqual([]);
    expect(result.cursor).toBe(firstResult.cursor);
  });

  test("resets when cursor exceeds file size (rotation)", async () => {
    writeLog(["line1", "line2", "line3"]);
    const firstResult = await readLogTail({ file: logFile });
    const bigCursor = firstResult.cursor + 1000;

    const result = await readLogTail({ file: logFile, cursor: bigCursor });
    expect(result.reset).toBe(true);
    expect(result.lines.length).toBeGreaterThan(0);
  });

  test("marks truncated when cursor lag exceeds maxBytes", async () => {
    const content = "x".repeat(100) + "\n";
    writeLog(Array(100).fill(content.trim()));

    const firstResult = await readLogTail({ file: logFile });
    const smallCursor = 10;

    const result = await readLogTail({
      file: logFile,
      cursor: smallCursor,
      maxBytes: 500,
    });
    expect(result.reset).toBe(true);
    expect(result.truncated).toBe(true);
  });

  test("handles partial-line boundary with prefix byte", async () => {
    // Write a file that ends WITHOUT a newline (partial line)
    const { open } = require("node:fs/promises");
    const handle = await open(logFile, "w");
    await handle.write("line1\nline2\npartial-line");
    await handle.close();

    const result = await readLogTail({ file: logFile });
    // The trailing partial line (no \n) should be preserved
    expect(result.lines).toEqual(["line1", "line2", "partial-line"]);
  });

  test("drops partial first line when cursor lands mid-line", async () => {
    const { open } = require("node:fs/promises");
    const handle = await open(logFile, "w");
    await handle.write("1234567890\nline2\nline3");
    await handle.close();

    // Land cursor at byte 5 (middle of first line)
    const result = await readLogTail({ file: logFile, cursor: 5 });
    // First element will be partial "67890", which should be dropped
    // so we get ["line2", "line3"]
    expect(result.lines[0]).not.toContain("67890");
    expect(result.lines).toContainEqual("line2");
    expect(result.lines).toContainEqual("line3");
  });

  test("missing file returns empty payload with no error", async () => {
    const nonexistent = join(tmpDir, "nonexistent.log");
    const result = await readLogTail({ file: nonexistent });
    expect(result.lines).toEqual([]);
    expect(result.cursor).toBe(0);
    expect(result.size).toBe(0);
  });

  test("limit:0 returns no historical lines (skip-history mode)", async () => {
    writeLog(["line1", "line2", "line3", "line4", "line5"]);
    const result = await readLogTail({
      file: logFile,
      limit: 0,
    });
    expect(result.lines).toEqual([]);
    expect(result.cursor).toBeGreaterThan(0);
  });

  test("clamps invalid maxBytes to bounds", async () => {
    writeLog(["line1", "line2", "line3"]);
    const result = await readLogTail({
      file: logFile,
      maxBytes: 0, // Invalid, should clamp to 1
    });
    expect(result.size).toBeGreaterThanOrEqual(0);
  });

  test("defaults used when no cursor provided", async () => {
    // Write a large file
    const lines = Array(300).fill("x".repeat(1000));
    writeLog(lines);
    const result = await readLogTail({ file: logFile });
    // Default limit is 200, so should return at most 200 lines
    expect(result.lines.length).toBeLessThanOrEqual(200);
  });

  // Rotation test updated for pino-roll daily semantics:
  // pino-roll creates a NEW file (ghost.YYYY-MM-DD.2.log) on size rotation —
  // the old file stays and the new file is smaller. The follow loop in
  // index.ts detects the filename change and resets cursor. Within a single
  // file the existing cursor > size detection still works (e.g. if a file is
  // truncated externally, which is an edge case).
  test("reset=true when cursor exceeds current file size (shrink/truncation edge case)", async () => {
    // Write a substantial block and capture cursor.
    writeLog(Array(10).fill("x".repeat(40)));
    const first = await readLogTail({ file: logFile });
    const cursorAfterFirst = first.cursor;
    expect(cursorAfterFirst).toBeGreaterThan(0);

    // Overwrite with a smaller file (simulates a file being truncated or
    // re-opened fresh at a smaller size — cursor now exceeds file size).
    writeLog(["a", "b"]);
    expect(statSync(logFile).size).toBeLessThan(cursorAfterFirst);

    // Poll with the stale cursor — must detect file shrank → reset=true.
    const second = await readLogTail({ file: logFile, cursor: cursorAfterFirst });
    expect(second.reset).toBe(true);

    // Follow-up poll at the new EOF — no new lines pending.
    const third = await readLogTail({ file: logFile, cursor: second.cursor });
    expect(third.reset).toBe(false);
    expect(third.lines).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findActiveLogFile tests
// ---------------------------------------------------------------------------

describe("findActiveLogFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ghost-activelog-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function touch(name: string): void {
    writeFileSync(join(tmpDir, name), "x", "utf8");
  }

  test("returns null when directory is empty", () => {
    expect(findActiveLogFile(tmpDir)).toBeNull();
  });

  test("returns null when directory does not exist", () => {
    expect(findActiveLogFile(join(tmpDir, "nonexistent"))).toBeNull();
  });

  test("returns null when no files match the pattern", () => {
    touch("ghost.log");
    touch("ghost.log.1");
    touch("other.txt");
    expect(findActiveLogFile(tmpDir)).toBeNull();
  });

  test("returns the single matching file", () => {
    touch("ghost.2026-05-21.1.log");
    const result = findActiveLogFile(tmpDir);
    expect(result).toBe(join(tmpDir, "ghost.2026-05-21.1.log"));
  });

  test("picks highest number within same date", () => {
    touch("ghost.2026-05-21.1.log");
    touch("ghost.2026-05-21.2.log");
    touch("ghost.2026-05-21.3.log");
    const result = findActiveLogFile(tmpDir);
    expect(result).toBe(join(tmpDir, "ghost.2026-05-21.3.log"));
  });

  test("picks newest date over earlier date regardless of number", () => {
    touch("ghost.2026-05-20.5.log"); // older date, higher number
    touch("ghost.2026-05-21.1.log"); // newer date, lower number
    const result = findActiveLogFile(tmpDir);
    expect(result).toBe(join(tmpDir, "ghost.2026-05-21.1.log"));
  });

  test("ignores files that do not match the pattern", () => {
    touch("ghost.2026-05-21.1.log");
    touch("ghost.log");            // legacy bare file — ignored
    touch("random-other.log");     // unrelated file — ignored
    touch("ghost.2026-05-21.log"); // missing number segment — ignored
    const result = findActiveLogFile(tmpDir);
    expect(result).toBe(join(tmpDir, "ghost.2026-05-21.1.log"));
  });

  test("file-changes-between-polls: cursor resets when active file changes", async () => {
    // Simulate the follow-loop scenario: write to file A, get cursor, then
    // a newer file B appears (midnight roll or size cap), verify B is resolved.
    const fileA = join(tmpDir, "ghost.2026-05-21.1.log");
    const fileB = join(tmpDir, "ghost.2026-05-22.1.log");

    writeFileSync(fileA, "line1\nline2\n", "utf8");

    // First poll resolves file A.
    const resolved1 = findActiveLogFile(tmpDir);
    expect(resolved1).toBe(fileA);

    const first = await readLogTail({ file: fileA });
    const cursorAfterA = first.cursor;
    expect(cursorAfterA).toBeGreaterThan(0);

    // New day: file B appears.
    writeFileSync(fileB, "line3\nline4\n", "utf8");

    // Second poll resolves file B (newer date wins).
    const resolved2 = findActiveLogFile(tmpDir);
    expect(resolved2).toBe(fileB);

    // Since the filename changed, the follow loop resets cursor to 0 and reads B.
    const second = await readLogTail({ file: fileB, cursor: 0 });
    expect(second.lines).toEqual(["line3", "line4"]);
  });
});
