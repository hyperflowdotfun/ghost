import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { startDaemon } from "../src/daemon/index.js";
import { createGateway } from "../src/gateway/server.js";
import { createRuntime } from "../src/runtime.js";
import { ApprovalManager } from "../src/gateway/approval.js";
import { NOOP_LOGGER } from "../src/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  const dir = join(tmpdir(), `ghost-daemon-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe("daemon", () => {
  describe("startDaemon()", () => {
    test("exports startDaemon function", () => {
      expect(typeof startDaemon).toBe("function");
    });

    test("accepts optional configPath parameter", () => {
      // Signature check without invoking (would start a long-running server)
      expect(startDaemon.length).toBeLessThanOrEqual(1);
    });
  });

  // Old CronScheduler tests removed — replaced by CronService (Epic 34)

  describe("gateway health endpoint", () => {
    test("returns 200 for GET /health", async () => {
      const dir = makeTempDir();
      try {
        const configPath = writeConfig(dir, "");
        const runtime = await createRuntime({ configPath, logger: NOOP_LOGGER });

        const { app } = createGateway(runtime.config.gateway, {
          config: runtime.config,
          orchestrator: runtime.orchestrator,
          memoryStore: runtime.memoryStore,
          tools: runtime.tools,
          sessionManager: runtime.sessionManager,
          cronService: runtime.cronService,
          timezoneService: runtime.timezoneService,
          configPath,
          tradingClient: runtime.tradingClient,
          walletStore: runtime.walletStore,
          alertRules: runtime.alertRules,
          notifications: runtime.notifications,
          priceCache: runtime.priceCache,
          newsService: runtime.newsService,
          preferenceStore: runtime.preferenceStore,
          watchlistService: runtime.watchlistService,
          approvalManager: new ApprovalManager(),
          eventBus: runtime.eventBus,
          skillService: runtime.skillService,
          channelManager: runtime.channelManager,
          runner: runtime.runner,
          logger: runtime.logger,
        });

        const response = await app.handle(new Request("http://localhost/health"));
        expect(response.status).toBe(200);

        runtime.db.close();
      } finally {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
