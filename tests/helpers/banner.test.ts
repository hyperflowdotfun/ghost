/**
 * Snapshot tests for the daemon startup banner.
 * Tests the structural content (provider line, gateway URL,
 * channels list, scheduler state) without coupling to exact ANSI codes.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { printDaemonStartupBanner } from "../../src/helpers/banner.js";
import type { BannerDeps } from "../../src/helpers/banner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRuntime(overrides: Partial<{
  provider: string;
  model: string;
  mode: "live" | "testnet" | "paper";
  paperEnabled: boolean;
  paperBalance: number;
  paperFee: number;
  schedulerEnabled: boolean;
}>= {}) {
  const {
    provider = "anthropic",
    model = "claude-sonnet-4-5",
    paperEnabled = false,
    paperBalance = 10000,
    paperFee = 0.0002,
    schedulerEnabled = true,
  } = overrides;
  // Derive mode from legacy paperEnabled when not explicitly set so older tests
  // that branch on `paperEnabled` keep working without spelling out `mode`.
  const mode = overrides.mode ?? (paperEnabled ? "paper" : "live");

  return {
    config: {
      provider,
      model,
      mode,
      paper: { enabled: paperEnabled, initialBalance: paperBalance, takerFee: paperFee },
      cron: { enableScheduler: schedulerEnabled },
    },
    // cronService is referenced in banner.ts but not accessed — stub suffices
    cronService: {},
  } as unknown as BannerDeps["runtime"];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("printDaemonStartupBanner", () => {
  const lines: string[] = [];
  let logMock: ReturnType<typeof mock>;

  beforeEach(() => {
    lines.length = 0;
    logMock = mock((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    // eslint-disable-next-line no-console
    (console as unknown as { log: unknown }).log = logMock;
  });

  afterEach(() => {
    // Restore to the original console.log (no-op if not captured — tests are isolated)
    (console as unknown as { log: typeof console.log }).log =
      (globalThis as unknown as { __origConsoleLog?: typeof console.log }).__origConsoleLog ?? console.log;
  });

  test("prints provider/model line", () => {
    printDaemonStartupBanner({
      runtime: makeRuntime({ provider: "openai", model: "gpt-4o" }),
      gateway: { host: "127.0.0.1", port: 15401 },
      authDisplay: "API Key",
      enabledChannels: [],
    });
    const output = lines.join("\n");
    expect(output).toContain("openai/gpt-4o");
  });

  test("prints gateway URL with correct host and port", () => {
    printDaemonStartupBanner({
      runtime: makeRuntime(),
      gateway: { host: "0.0.0.0", port: 9999 },
      authDisplay: "API Key",
      enabledChannels: [],
    });
    expect(lines.join("\n")).toContain("http://0.0.0.0:9999");
  });

  test("prints auth display string as-is", () => {
    printDaemonStartupBanner({
      runtime: makeRuntime(),
      gateway: { host: "127.0.0.1", port: 15401 },
      authDisplay: "OAuth (anthropic)",
      enabledChannels: [],
    });
    expect(lines.join("\n")).toContain("OAuth (anthropic)");
  });

  test("prints joined channel list when channels provided", () => {
    printDaemonStartupBanner({
      runtime: makeRuntime(),
      gateway: { host: "127.0.0.1", port: 15401 },
      authDisplay: "API Key",
      enabledChannels: ["telegram", "web"],
    });
    expect(lines.join("\n")).toContain("telegram, web");
  });

  test("prints 'none' dim-string when no channels", () => {
    printDaemonStartupBanner({
      runtime: makeRuntime(),
      gateway: { host: "127.0.0.1", port: 15401 },
      authDisplay: "API Key",
      enabledChannels: [],
    });
    // ANSI dim wraps "none"
    expect(lines.join("\n")).toContain("none");
  });

  test("paper mode: shows PAPER heading and balance", () => {
    printDaemonStartupBanner({
      runtime: makeRuntime({ paperEnabled: true, paperBalance: 50000, paperFee: 0.0005 }),
      gateway: { host: "127.0.0.1", port: 15401 },
      authDisplay: "API Key",
      enabledChannels: [],
    });
    const output = lines.join("\n");
    expect(output).toContain("Ghost Paper Trading");
    expect(output).toContain("PAPER (simulated)");
    expect(output).toContain("50,000");
  });

  test("testnet mode: shows TESTNET heading + label", () => {
    printDaemonStartupBanner({
      runtime: makeRuntime({ mode: "testnet" }),
      gateway: { host: "127.0.0.1", port: 15401 },
      authDisplay: "API Key",
      enabledChannels: [],
    });
    const output = lines.join("\n");
    expect(output).toContain("Ghost Testnet Trading");
    expect(output).toContain("TESTNET (real exchange, testnet USDC)");
  });

  test("live mode: shows 'Ghost daemon ready' heading", () => {
    printDaemonStartupBanner({
      runtime: makeRuntime({ paperEnabled: false }),
      gateway: { host: "127.0.0.1", port: 15401 },
      authDisplay: "API Key",
      enabledChannels: [],
    });
    expect(lines.join("\n")).toContain("Ghost daemon ready");
  });

  test("scheduler on/off text reflects cron config", () => {
    printDaemonStartupBanner({
      runtime: makeRuntime({ schedulerEnabled: false }),
      gateway: { host: "127.0.0.1", port: 15401 },
      authDisplay: "API Key",
      enabledChannels: [],
    });
    expect(lines.join("\n")).toContain("off");
  });
});
