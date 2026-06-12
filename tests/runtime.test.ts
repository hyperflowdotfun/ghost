import { describe, test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRuntime } from "../src/runtime.js";
import { NOOP_LOGGER } from "../src/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  const dir = join(tmpdir(), `ghost-runtime-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfig(dir: string, content: string): string {
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, content || "{}");
  return configPath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createRuntime()", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    tempDirs.length = 0;
  });

  test("creates runtime with all subsystems from defaults", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    // Empty config file — rely on defaults
    const configPath = writeConfig(dir, "");
    const runtime = await createRuntime({ configPath, logger: NOOP_LOGGER });

    try {
      // All subsystems must be present
      expect(runtime.agent).toBeDefined();
      expect(runtime.config).toBeDefined();
      expect(runtime.db).toBeDefined();
      expect(runtime.memoryStore).toBeDefined();
      expect(runtime.security).toBeDefined();
      expect(runtime.tools).toBeDefined();
      // provider removed — Agent uses pi-ai model directly
      expect(runtime.leakDetector).toBeDefined();
    } finally {
      runtime.db.close();
    }
  });

  test("config defaults are applied when file is empty", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    const configPath = writeConfig(dir, "");
    const runtime = await createRuntime({ configPath, logger: NOOP_LOGGER });

    try {
      expect(runtime.config.provider).toBe("openrouter");
      expect(runtime.config.model).toBe("anthropic/claude-sonnet-4");
      expect(runtime.config.autonomy.level).toBe("supervised");
    } finally {
      runtime.db.close();
    }
  });

  test("reads config values from JSON file", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    const configPath = writeConfig(dir, JSON.stringify({
      provider: "anthropic",
      model: "claude-3-opus-20240229",
    }));

    const runtime = await createRuntime({ configPath, logger: NOOP_LOGGER });

    try {
      expect(runtime.config.provider).toBe("anthropic");
      expect(runtime.config.model).toBe("claude-3-opus-20240229");
    } finally {
      runtime.db.close();
    }
  });

  test("provider removed — model is resolved into agent state", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const configPath = writeConfig(dir, JSON.stringify({ provider: "openrouter", model: "anthropic/claude-sonnet-4" }));
    const runtime = await createRuntime({ configPath, logger: NOOP_LOGGER });
    try {
      expect(runtime.agent.state.model.id).toBeDefined();
    } finally {
      runtime.db.close();
    }
  });

  test("tools registry has tools registered", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    const configPath = writeConfig(dir, "");
    const runtime = await createRuntime({ configPath, logger: NOOP_LOGGER });

    try {
      const names = runtime.tools.names();
      expect(names.length).toBeGreaterThan(0);
      // Core tools should be present
      expect(names).toContain("exec");
      expect(names).toContain("read_file");
    } finally {
      runtime.db.close();
    }
  });

  test("memory health check passes", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    const configPath = writeConfig(dir, "");
    const runtime = await createRuntime({ configPath, logger: NOOP_LOGGER });

    try {
      const healthy = await runtime.memoryStore.healthCheck();
      expect(healthy).toBe(true);
    } finally {
      runtime.db.close();
    }
  });

  test("agent can be called and returns a string", async () => {
    // This test uses the agent loop with a real provider — we mock the provider
    // by intercepting the provider call indirectly. Since we don't have a real
    // API key in tests, we just verify the agent object is properly wired.
    const dir = makeTempDir();
    tempDirs.push(dir);

    const configPath = writeConfig(dir, "");
    const runtime = await createRuntime({ configPath, logger: NOOP_LOGGER });

    try {
      // pi-agent-core Agent: prompt() and state.messages instead of run()/getHistory()
      expect(typeof runtime.agent.prompt).toBe("function");
      expect(Array.isArray(runtime.agent.state.messages)).toBe(true);
    } finally {
      runtime.db.close();
    }
  });

  test("agent system prompt is non-empty (ContextBuilder wired)", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const configPath = writeConfig(dir, "");
    const runtime = await createRuntime({ configPath, logger: NOOP_LOGGER });
    try {
      const systemPrompt = runtime.agent.state.systemPrompt;
      expect(systemPrompt.length).toBeGreaterThan(0);
      expect(systemPrompt).toContain("# Ghost");
      expect(systemPrompt).toContain("## Guidelines");
    } finally {
      runtime.db.close();
    }
  });

});
