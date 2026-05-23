/**
 * Integration tests for pino-roll daily-mode log rotation.
 *
 * File naming: ghost.YYYY-MM-DD.<N>.log
 *   ghost.2026-05-21.1.log  — first file of the day
 *   ghost.2026-05-21.2.log  — after within-day size cap hit
 *
 * Retention: limit.count prunes oldest files once the cap is exceeded;
 * removeOtherLogFiles: true ensures pruning works across process restarts.
 *
 * Size strings: pino-roll parseSize accepts a single-letter suffix only:
 *   "m" = MB, "k" = KB, "g" = GB, "b" = bytes (no "mb"/"kb").
 */

import { describe, test, expect, afterEach } from "bun:test";
import pinoRoll from "pino-roll";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Writable } from "node:stream";

const DAILY_LOG_RE = /^ghost\.(\d{4}-\d{2}-\d{2})\.(\d+)\.log$/;

describe("pino-roll daily rotation", () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "ghost-pinoroll-"));
    cleanupDirs.push(dir);
    return dir;
  }

  async function makeStream(dir: string, sizeCap: string, retainCount: number): Promise<Writable> {
    return pinoRoll({
      file: join(dir, "ghost"),
      frequency: "daily",
      dateFormat: "yyyy-MM-dd",
      size: sizeCap,
      extension: ".log",
      limit: { count: retainCount, removeOtherLogFiles: true },
      mkdir: true,
    });
  }

  /**
   * Write chunks synchronously and wait for the stream to drain.
   * SonicBoom buffers writes internally; the "write" event (which triggers
   * size-rotation logic) fires after the buffer is flushed to disk.
   * Writing a single large chunk ensures the buffer fills and drains in one
   * shot, so the size check fires before we resolve.
   */
  function writeAndDrain(stream: Writable, payload: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      stream.once("error", reject);
      const flushed = stream.write(payload);
      if (flushed) {
        resolve();
      } else {
        stream.once("drain", resolve);
      }
    });
  }

  /** Destroy stream and wait for close. */
  function destroyStream(stream: Writable): Promise<void> {
    return new Promise<void>((resolve) => {
      stream.once("close", resolve);
      stream.once("finish", resolve);
      stream.destroy();
    });
  }

  test("produces ghost.YYYY-MM-DD.<N>.log naming pattern", async () => {
    const dir = makeTmpDir();
    const stream = await makeStream(dir, "1m", 7);

    await writeAndDrain(stream, "x".repeat(100) + "\n");
    await destroyStream(stream);

    const files = readdirSync(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(DAILY_LOG_RE.test(f)).toBe(true);
    }
  });

  test("first file of the day is numbered 1", async () => {
    const dir = makeTmpDir();
    const stream = await makeStream(dir, "1m", 7);

    await writeAndDrain(stream, "hello\n");
    await destroyStream(stream);

    const files = readdirSync(dir).filter((f) => DAILY_LOG_RE.test(f));
    expect(files.length).toBeGreaterThan(0);

    const today = new Date().toISOString().slice(0, 10);
    const firstFile = `ghost.${today}.1.log`;
    expect(files).toContain(firstFile);
  });

  test("within-day size cap creates a .2.log file", async () => {
    const dir = makeTmpDir();
    // 1 KB cap — write a 2 KB chunk to force rotation within the day.
    const stream = await makeStream(dir, "1k", 7);

    // Write enough to exceed 1 KB and trigger at least one rotation.
    // Use writeAndDrain so the SonicBoom buffer flushes and "write" event fires.
    const chunk = "x".repeat(512) + "\n";
    await writeAndDrain(stream, chunk + chunk + chunk + chunk);
    // Give the async drain→roll chain time to complete.
    await new Promise<void>((r) => setTimeout(r, 200));
    await destroyStream(stream);

    const files = readdirSync(dir).filter((f) => DAILY_LOG_RE.test(f));
    const today = new Date().toISOString().slice(0, 10);
    const hasNumbered = files.some((f) => {
      const m = DAILY_LOG_RE.exec(f);
      return m && m[1] === today && parseInt(m[2]!, 10) >= 2;
    });
    expect(hasNumbered).toBe(true);
  });

  test("retention count: files beyond limit are pruned", async () => {
    const dir = makeTmpDir();
    // count: 3 — only 3 files kept.
    // Use a separate stream per rotation cycle so removeOldFiles runs on each
    // explicit reopen, giving pruning a deterministic chance to complete.
    // Each stream writes > 1k to force a fresh rotation, then is destroyed.
    const chunk = "x".repeat(600) + "\n";
    for (let i = 0; i < 5; i++) {
      const s = await makeStream(dir, "1k", 3);
      await writeAndDrain(s, chunk + chunk);
      await new Promise<void>((r) => setTimeout(r, 100));
      await destroyStream(s);
    }

    const files = readdirSync(dir).filter((f) => DAILY_LOG_RE.test(f));
    // pino-roll's removeOtherLogFiles: true prunes down to count on each roll.
    // Allow count + 1 tolerance for the in-flight file at destroy time.
    expect(files.length).toBeLessThanOrEqual(4);
  });

  test("no symlink created (symlink option not passed)", async () => {
    const dir = makeTmpDir();
    const stream = await makeStream(dir, "1m", 7);

    await writeAndDrain(stream, "data\n");
    await destroyStream(stream);

    const allEntries = readdirSync(dir);
    // All entries in the dir should match the date-numbered pattern — no bare symlinks.
    for (const entry of allEntries) {
      expect(DAILY_LOG_RE.test(entry)).toBe(true);
    }
  });

  test("mkdir: creates nested directory if it does not exist", async () => {
    const dir = makeTmpDir();
    const nested = join(dir, "deep", "logs");
    const stream = await pinoRoll({
      file: join(nested, "ghost"),
      frequency: "daily",
      dateFormat: "yyyy-MM-dd",
      size: "1m",
      extension: ".log",
      limit: { count: 7, removeOtherLogFiles: true },
      mkdir: true,
    });

    await writeAndDrain(stream, "hello\n");
    await destroyStream(stream);

    const files = readdirSync(nested).filter((f) => DAILY_LOG_RE.test(f));
    expect(files.length).toBeGreaterThan(0);
  });
});
