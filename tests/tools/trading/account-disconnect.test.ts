/**
 * Tests for ghost_disconnect_wallet tool
 */

import { describe, test, expect } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import type { HyperliquidClient } from "../../../src/services/live/client.js";
import type { IWalletStore } from "../../../src/services/interfaces/wallet-store.js";
import { createAccountTools } from "../../../src/tools/trading/account.js";

// ─── Mock HyperliquidClient (minimal for disconnect tests) ───

function createMockHL(address = "0x1234567890abcdef1234567890abcdef12345678"): HyperliquidClient {
  return {
    address,
    canWrite: true,
    connect: () => {},
    disconnect() { /* no-op for mock */ },
  } as unknown as HyperliquidClient;
}

// ─── Mock WalletStore ───

function createMockWalletStore(): IWalletStore {
  return {
    async load() { return null; },
    async save() {},
    async addWatch() { return false; },
    async enableTrading() {},
    listWallets() { return []; },
    getWallet() { return null; },
    setDefault() {},
    async remove() { return false; },
    async removeBySource() { return []; },
  };
}

// ─── Helper to extract text from tool result ───

function getText(result: { content: { type: string; text?: string }[] }): string {
  const item = result.content[0];
  if (item && "text" in item) return item.text as string;
  return "";
}

function findTool(tools: AgentTool<TSchema>[], name: string): AgentTool<TSchema> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

describe("ghost_disconnect_wallet", () => {
  test("disconnects successfully and returns confirmation", async () => {
    const address = "0xabcdef1234567890abcdef1234567890abcdef12";
    const disconnectWallet = async () => ({ address });
    const tools = createAccountTools({
      hl: createMockHL(address),
      walletStore: createMockWalletStore(),
      testnet: false,

      disconnectWallet,
    });
    const tool = findTool(tools, "ghost_disconnect_wallet");

    const result = await tool.execute("call-1", {});
    const text = getText(result);
    expect(text).toContain("Wallet disconnected");
    expect(text).toContain("0xabcd");
    expect(text).toContain("ef12");
    expect(text).toContain("Credentials cleared");
  });

  test("returns error when no wallet connected", async () => {
    const disconnectWallet = async () => ({ address: "" });
    const tools = createAccountTools({
      hl: createMockHL(""),
      walletStore: createMockWalletStore(),
      testnet: false,

      disconnectWallet,
    });
    const tool = findTool(tools, "ghost_disconnect_wallet");

    const result = await tool.execute("call-1", {});
    const text = getText(result);
    expect(text).toContain("No wallet connected");
  });

  test("returns error when callback returns null", async () => {
    const address = "0xabcdef1234567890abcdef1234567890abcdef12";
    const disconnectWallet = async () => null;
    const tools = createAccountTools({
      hl: createMockHL(address),
      walletStore: createMockWalletStore(),
      testnet: false,

      disconnectWallet,
    });
    const tool = findTool(tools, "ghost_disconnect_wallet");

    const result = await tool.execute("call-1", {});
    const text = getText(result);
    expect(text).toContain("No wallet connected");
  });

  test("returns error when disconnectWallet callback not provided", async () => {
    const tools = createAccountTools({
      hl: createMockHL(),
      walletStore: createMockWalletStore(),
      testnet: false,

    });
    const tool = findTool(tools, "ghost_disconnect_wallet");

    const result = await tool.execute("call-1", {});
    const text = getText(result);
    expect(text).toContain("Disconnect not available");
  });
});
