/**
 * Tests for runtime.taskAgent — verifies the background Agent instance is
 * constructed correctly and isolated from chatAgent.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  createAgent,
  buildAgentOptions,
  type CreateAgentOptions,
} from "../../src/runtime.js";
import { SecurityPolicy } from "../../src/security/policy.js";
import { LeakDetector } from "../../src/security/leak-detector.js";
import { OAuthManager } from "../../src/auth/oauth.js";
import { ApprovalManager } from "../../src/gateway/approval.js";
import { EventBus } from "../../src/bus/events.js";
import { NOOP_LOGGER } from "../../src/logger.js";
import { EMPTY_CUSTOM_MODEL_REGISTRY } from "../../src/providers/models-config.js";
import { Database } from "bun:sqlite";
import { initDatabase } from "../../src/core/database.js";
import { DB_MIGRATIONS } from "../../src/core/migrations/registry.js";
import { CredentialStore } from "../../src/config/credentials.js";
import { SecretStore } from "../../src/config/secrets.js";
import { createToolRegistry } from "../../src/tools/index.js";
import { CronService } from "../../src/scheduler/service.js";
import { MemoryStore } from "../../src/memory/store.js";
import type { TimezoneService } from "../../src/services/timezone.js";
import { getModel } from "@earendil-works/pi-ai";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { Config } from "../../src/config/schema.js";

// ---------------------------------------------------------------------------
// Minimal config stub
// ---------------------------------------------------------------------------

function makeMinimalConfig(): Config {
  return {
    provider: "anthropic",
    model: "claude-3-5-haiku-20241022",
    apiUrl: "",
    gateway: { host: "127.0.0.1", port: 15401, requirePairing: false, pairedTokens: [] },
    agent: {
      thinkingLevel: "low",
      thinkingBudgets: {},
      parallelTools: false,
      maxContextTokens: 100_000,
    },
    memory: { contextWindowTokens: 100_000, maxCompletionTokens: 4096, maxConsolidationRounds: 3 },
    channels: {
      telegram: { enabled: false, botToken: "", allowedChatIds: [] },
      sendProgress: false,
      sendToolHints: false,
      sendMaxRetries: 3,
      maxConcurrentRequests: 2,
    },
    autonomy: {
      level: "manual",
      blockHighRiskCommands: true,
      requireApprovalForMediumRisk: false,
    },
    security: { allowedCommands: [], blockedPaths: [] },
    cron: { timezone: "UTC", enableScheduler: false },
    skills: { skillsDir: "~/.ghost/skills", builtinSkillsDir: undefined },
    paper: { enabled: false, initialBalance: 10_000 },
    proactive: { enabled: false },
  } as unknown as Config;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  const dir = join(tmpdir(), `ghost-test-ta-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeSharedDeps() {
  const config = makeMinimalConfig();
  const security = new SecurityPolicy("supervised", { allowedCommands: [], workspaceDir: "/tmp", forbiddenPaths: [], blockHighRiskCommands: false, requireApprovalForMediumRisk: false });
  const leakDetector = new LeakDetector();
  const tmpDir = makeTempDir();
  const db: Database = initDatabase(join(tmpDir, "test.db"));
  const secretStore = new SecretStore(join(tmpDir, "secret.key"));
  const credentials = new CredentialStore(join(tmpDir, "creds.json"), secretStore, NOOP_LOGGER);
  const oauthManager = new OAuthManager(credentials);
  const approvalManager = new ApprovalManager();
  const eventBus = new EventBus(NOOP_LOGGER);
  // Isolated DB for CronService — only the cron_jobs migration is needed here.
  const cronDb = new Database(":memory:");
  const cronMigration = DB_MIGRATIONS.find((m) => m.version === 10)!;
  (cronMigration.up as (db: Database) => void)(cronDb);
  const cronService = new CronService(cronDb);
  const memoryStore = new MemoryStore(tmpDir);
  const timezoneService: TimezoneService = { get: () => "UTC", set: () => ({ ok: true as const, tz: "UTC" }) };
  const tools = createToolRegistry(security, { cronService, timezoneService, memoryStore, logger: NOOP_LOGGER });
  // anthropic haiku is a real built-in model — no network needed for construction
  const model = getModel("anthropic", "claude-3-5-haiku-20241022")!;

  const baseOpts: CreateAgentOptions = {
    config,
    model,
    security,
    leakDetector,
    oauthManager,
    tools,
    systemPrompt: "Test system prompt.",
    credentials,
    extraReadDirs: [],
    approvalManager,
    eventBus,
    logger: NOOP_LOGGER,
    customModelRegistry: EMPTY_CUSTOM_MODEL_REGISTRY,
    confirmDeps: { getConfirmService: () => null },
  };

  return { config, security, leakDetector, credentials, oauthManager, tools, model, approvalManager, eventBus, baseOpts, db };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("taskAgent construction", () => {
  test("chatAgent and taskAgent are distinct Agent instances", () => {
    const { baseOpts } = makeSharedDeps();

    const chatAgent = createAgent({ ...baseOpts, systemPrompt: "Chat prompt." });
    const taskAgent = createAgent({ ...baseOpts, systemPrompt: "Task prompt.", bypassConfirm: true });

    // Must be separate instances
    expect(chatAgent).not.toBe(taskAgent);
    expect(chatAgent instanceof Agent).toBe(true);
    expect(taskAgent instanceof Agent).toBe(true);
  });

  test("taskAgent system prompt is independent from chatAgent", () => {
    const { baseOpts } = makeSharedDeps();

    const chatAgent = createAgent({ ...baseOpts, systemPrompt: "Chat prompt." });
    const taskAgent = createAgent({ ...baseOpts, systemPrompt: "Task prompt.", bypassConfirm: true });

    expect(chatAgent.state.systemPrompt).toBe("Chat prompt.");
    expect(taskAgent.state.systemPrompt).toBe("Task prompt.");

    // Mutating one does not affect the other
    taskAgent.state.systemPrompt = "Mutated task prompt.";
    expect(chatAgent.state.systemPrompt).toBe("Chat prompt.");
  });

  test("taskAgent tool set matches chatAgent tool set at construction time", () => {
    const { baseOpts } = makeSharedDeps();

    const chatAgent = createAgent({ ...baseOpts });
    const taskAgent = createAgent({ ...baseOpts, bypassConfirm: true });

    // Both see the same tools (same registry snapshot)
    const chatTools = chatAgent.state.tools.map((t: { name: string }) => t.name).sort();
    const taskTools = taskAgent.state.tools.map((t: { name: string }) => t.name).sort();
    expect(taskTools).toEqual(chatTools);
  });

  test("taskAgent thinkingLevel can be overridden to off independently", () => {
    const { baseOpts } = makeSharedDeps();

    const chatAgent = createAgent({ ...baseOpts });
    const taskAgent = createAgent({ ...baseOpts, bypassConfirm: true });
    taskAgent.state.thinkingLevel = "off";

    // chatAgent keeps whatever was in config (low)
    expect(chatAgent.state.thinkingLevel).not.toBe("off");
    expect(taskAgent.state.thinkingLevel).toBe("off");
  });
});

describe("bypassConfirm option", () => {
  test("buildAgentOptions with bypassConfirm=false produces a beforeToolCall hook", () => {
    const { baseOpts } = makeSharedDeps();
    const { config, model, security, leakDetector, oauthManager, tools, credentials, approvalManager, eventBus } = baseOpts;

    const opts = buildAgentOptions(
      config, model, security, leakDetector, oauthManager, tools,
      "system prompt", credentials, [], approvalManager, eventBus,
      NOOP_LOGGER, EMPTY_CUSTOM_MODEL_REGISTRY,
      { getConfirmService: () => null },
      false,
    );
    expect(typeof opts.beforeToolCall).toBe("function");
  });

  test("buildAgentOptions with bypassConfirm=true also produces a beforeToolCall hook (still handles security checks)", () => {
    const { baseOpts } = makeSharedDeps();
    const { config, model, security, leakDetector, oauthManager, tools, credentials, approvalManager, eventBus } = baseOpts;

    const opts = buildAgentOptions(
      config, model, security, leakDetector, oauthManager, tools,
      "system prompt", credentials, [], approvalManager, eventBus,
      NOOP_LOGGER, EMPTY_CUSTOM_MODEL_REGISTRY,
      { getConfirmService: () => null },
      true,
    );
    // Hook is present — it skips the confirm path but still enforces security policy
    expect(typeof opts.beforeToolCall).toBe("function");
  });

  test("bypassConfirm=true: hook does not call confirmService even for confirmable tools", async () => {
    const { baseOpts } = makeSharedDeps();
    const { config, model, security, leakDetector, oauthManager, tools, credentials, approvalManager, eventBus } = baseOpts;

    let confirmCalled = false;
    const mockConfirmService = {
      confirm: async () => {
        confirmCalled = true;
        return { decision: "approved" as const };
      },
    };

    const opts = buildAgentOptions(
      config, model, security, leakDetector, oauthManager, tools,
      "system prompt", credentials, [], approvalManager, eventBus,
      NOOP_LOGGER, EMPTY_CUSTOM_MODEL_REGISTRY,
      { getConfirmService: () => mockConfirmService },
      true, // bypassConfirm
    );

    // Simulate a beforeToolCall for a confirmable tool (ghost_market_order)
    // with a non-null assistantMessage to ensure the bypass is on the right path.
    // Use `as unknown as never` casts to avoid coupling to pi-agent-core internals.
    const fakeAssistantMessage = { role: "assistant", content: [{ type: "toolCall", name: "ghost_market_order", arguments: {} }] };
    await opts.beforeToolCall!({
      assistantMessage: fakeAssistantMessage as unknown as never,
      toolCall: { name: "ghost_market_order" } as unknown as never,
      args: {},
      context: { messages: [{ role: "user" } as unknown as never], tools: [], systemPrompt: "" },
    });

    // bypassConfirm=true → confirm was NOT called
    expect(confirmCalled).toBe(false);
    // Security policy may still block or allow based on autonomy level,
    // but the confirm service was definitely not invoked.
  });
});
