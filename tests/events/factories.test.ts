import { describe, test, expect } from "bun:test";
import {
  WalletEvents,
  ApprovalEvents,
  TradingEvents,
  ToolEvents,
  ClientEvents,
} from "../../src/events/index.js";

describe("event factories", () => {
  test("WalletEvents.changed shape", () => {
    const e = WalletEvents.changed({ action: "connect", address: "0xabc" });
    expect(e).toEqual({ type: "wallet.changed", payload: { action: "connect", address: "0xabc" } });
  });

  test("ApprovalEvents.tradingRequested shape", () => {
    const e = ApprovalEvents.tradingRequested({
      approvalId: "a", sessionKey: "trade:1",
      preview: { action: "buy", actionLabel: "Buy", summary: "s", details: {} },
      createdAtMs: 1, preText: "pt", origin: null,
    });
    expect(e.type).toBe("trading.approval.requested");
    expect(e.payload.approvalId).toBe("a");
    expect(e.payload.preText).toBe("pt");
  });

  test("ApprovalEvents.tradingResolved shape", () => {
    const e = ApprovalEvents.tradingResolved({ approvalId: "a", decision: "approved", ts: 10 });
    expect(e).toEqual({ type: "trading.approval.resolved", payload: { approvalId: "a", decision: "approved", ts: 10 } });
  });

  test("TradingEvents.priceUpdate shape", () => {
    const e = TradingEvents.priceUpdate({ symbol: "BTC", price: 60000 });
    expect(e).toEqual({ type: "trading.price.update", payload: { symbol: "BTC", price: 60000 } });
  });

  test("TradingEvents.watchlistChanged shape", () => {
    const e = TradingEvents.watchlistChanged({ action: "add", symbol: "ETH", source: "hyperliquid" });
    expect(e).toEqual({ type: "trading.watchlist.changed", payload: { action: "add", symbol: "ETH", source: "hyperliquid" } });
  });

  test("TradingEvents.sourceTick shape", () => {
    const e = TradingEvents.sourceTick({ source: "binance", symbol: "BTCUSDT", price: 60_010 });
    expect(e).toEqual({ type: "trading.source.tick", payload: { source: "binance", symbol: "BTCUSDT", price: 60_010 } });
  });

  test("ToolEvents.approvalRequested shape", () => {
    const e = ToolEvents.approvalRequested({
      approvalId: "t1",
      preview: { action: "exec", actionLabel: "Execute", summary: "rm -rf", details: { risk: "high", tool: "exec" } },
      createdAtMs: 1,
    });
    expect(e.type).toBe("tool.approval.requested");
  });

  test("ToolEvents.approvalResolved shape", () => {
    const e = ToolEvents.approvalResolved({ approvalId: "t1", decision: "rejected", ts: 10 });
    expect(e).toEqual({ type: "tool.approval.resolved", payload: { approvalId: "t1", decision: "rejected", ts: 10 } });
  });

  test("ToolEvents.mcpResult shape", () => {
    const e = ToolEvents.mcpResult({ toolCallId: "c", name: "read_file", success: true, durationSecs: 1 });
    expect(e).toEqual({ type: "mcp.tool_result", payload: { toolCallId: "c", name: "read_file", success: true, durationSecs: 1 } });
  });

  test("ClientEvents.connected / disconnected shapes", () => {
    expect(ClientEvents.connected({ clients: 3 })).toEqual({ type: "client.connected", payload: { clients: 3 } });
    expect(ClientEvents.disconnected({ clients: 2 })).toEqual({ type: "client.disconnected", payload: { clients: 2 } });
  });
});
