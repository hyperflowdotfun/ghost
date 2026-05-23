import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRootLogger } from "../src/logger.js";

// Redirect HOME to an isolated tmp dir so the pino-roll factory in
// createRootLogger writes into the tmp dir instead of the user's real
// ~/.ghost/logs/. defaultLogDir() resolves HOME at call time, so this
// override propagates into every createRootLogger() call below.

let tmpHome: string;
let originalHome: string | undefined;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ghost-logger-test-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("createRootLogger", () => {
  test("default verbosity 0 sets level to info", async () => {
    const logger = await createRootLogger(0);
    expect(logger.level).toBe("info");
  });

  test("verbosity 1 sets level to debug", async () => {
    const logger = await createRootLogger(1);
    expect(logger.level).toBe("debug");
  });

  test("verbosity 2 sets level to trace", async () => {
    const logger = await createRootLogger(2);
    expect(logger.level).toBe("trace");
  });

  test("LOG_LEVEL env var overrides default when verbosity is 0", async () => {
    const original = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "warn";
    try {
      const logger = await createRootLogger(0);
      expect(logger.level).toBe("warn");
    } finally {
      if (original === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = original;
    }
  });

  test("verbosity flag takes precedence over LOG_LEVEL", async () => {
    const original = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "warn";
    try {
      const logger = await createRootLogger(1);
      expect(logger.level).toBe("debug");
    } finally {
      if (original === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = original;
    }
  });

  test("invalid LOG_LEVEL falls back to info", async () => {
    const original = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "banana";
    try {
      const logger = await createRootLogger(0);
      expect(logger.level).toBe("info");
    } finally {
      if (original === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = original;
    }
  });

  test("child logger inherits level and adds module field", async () => {
    const root = await createRootLogger(0);
    const child = root.child({ module: "news" });
    expect(child.level).toBe("info");
    expect((child as unknown as { bindings: () => Record<string, unknown> }).bindings().module).toBe("news");
  });
});
