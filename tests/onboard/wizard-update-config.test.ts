import { describe, it, expect } from "bun:test";
import { configSchema, type Config } from "../../src/config/schema.js";
import { applyUpdateModeChanges } from "../../src/onboard/wizard-update-config.js";

function getTgBlock(config: Config): Record<string, unknown> {
  const block = config.telegram;
  return (block && typeof block === "object") ? block as Record<string, unknown> : {};
}

function seededConfig(): Config {
  const c = configSchema.parse({});
  c.provider = "openrouter";
  c.model = "anthropic/claude-sonnet-4";
  c.telegram = {
    streaming: true,
    replyToMessage: false,
    reactEmoji: "🤖",
  };
  c.gateway.rateLimitRpm = 120;
  c.security.allowedCommands = ["custom-cmd", "npx"];
  c.mode = "paper";
  c.paper = { ...c.paper, enabled: true, initialBalance: 50000 };
  c.verbosity = 1;
  return c;
}

describe("applyUpdateModeChanges", () => {
  it("overlays provider and model", () => {
    const next = applyUpdateModeChanges(seededConfig(), {
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    expect(next.provider).toBe("anthropic");
    expect(next.model).toBe("claude-opus-4-7");
  });

  it("preserves telegram when not in overlay", () => {
    const next = applyUpdateModeChanges(seededConfig(), {
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    expect(getTgBlock(next).reactEmoji).toBe("🤖");
    expect(getTgBlock(next).streaming).toBe(true);
  });

  it("preserves gateway.rateLimitRpm", () => {
    const next = applyUpdateModeChanges(seededConfig(), {
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    expect(next.gateway.rateLimitRpm).toBe(120);
  });

  it("preserves security tweaks", () => {
    const next = applyUpdateModeChanges(seededConfig(), {
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    expect(next.security.allowedCommands).toEqual(["custom-cmd", "npx"]);
  });

  it("preserves verbosity", () => {
    const next = applyUpdateModeChanges(seededConfig(), {
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    expect(next.verbosity).toBe(1);
  });

  it("preserves existing mode when overlay.mode is undefined", () => {
    const next = applyUpdateModeChanges(seededConfig(), {
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    expect(next.mode).toBe("paper");
    expect(next.paper.initialBalance).toBe(50000);
  });

  it("overlays mode + paperBalance when provided", () => {
    const next = applyUpdateModeChanges(seededConfig(), {
      provider: "anthropic",
      model: "claude-opus-4-7",
      mode: "paper",
      paperBalance: 100000,
    });
    expect(next.mode).toBe("paper");
    expect(next.paper.initialBalance).toBe(100000);
  });

  it("switches to testnet without touching paper block", () => {
    const next = applyUpdateModeChanges(seededConfig(), {
      provider: "anthropic",
      model: "claude-opus-4-7",
      mode: "testnet",
    });
    expect(next.mode).toBe("testnet");
    expect(next.paper.initialBalance).toBe(50000);
  });

  it("does not mutate the input config", () => {
    const input = seededConfig();
    const snapshot = JSON.parse(JSON.stringify(input));
    applyUpdateModeChanges(input, { provider: "anthropic", model: "claude-opus-4-7" });
    expect(input).toEqual(snapshot);
  });
});
