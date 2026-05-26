import { describe, test, expect } from "bun:test";

import {
  validateWatchlistSymbol,
  canonicalWatchlistSymbol,
} from "../../src/services/watchlist/sources.js";
import type { ITradingClient } from "../../src/services/interfaces/trading-client.js";
import type { BinanceService } from "../../src/services/binance.js";

function fakeHl(known: Record<string, true>): ITradingClient {
  return {
    resolveSymbol: (s: string) => s.toUpperCase(),
    isKnownSymbol: (s: string) => Object.prototype.hasOwnProperty.call(known, s),
  } as unknown as ITradingClient;
}

const fakeBinance = {
  has: (s: string) => s === "BTCUSDT" || s === "ETHUSDT",
} as unknown as BinanceService;

describe("validateWatchlistSymbol — add path", () => {
  test("hyperliquid known → ok with resolved canonical", () => {
    const r = validateWatchlistSymbol("hyperliquid", "btc", fakeHl({ BTC: true }), fakeBinance);
    expect(r).toEqual({ ok: true, canonical: "BTC" });
  });

  test("hyperliquid unknown → error names canonical + Hyperliquid", () => {
    const r = validateWatchlistSymbol("hyperliquid", "doge", fakeHl({}), fakeBinance);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("DOGE");
      expect(r.error).toContain("Hyperliquid");
    }
  });

  test("binance known → ok with native pair", () => {
    const r = validateWatchlistSymbol("binance", "BTCUSDT", fakeHl({}), fakeBinance);
    expect(r).toEqual({ ok: true, canonical: "BTCUSDT" });
  });

  test("binance unknown → error names Binance", () => {
    const r = validateWatchlistSymbol("binance", "JUNK", fakeHl({}), fakeBinance);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Binance");
  });

  test("binance disabled (binance === undefined) → all binance adds reject", () => {
    const r = validateWatchlistSymbol("binance", "BTCUSDT", fakeHl({}), undefined);
    expect(r.ok).toBe(false);
  });

  test("unknown source string → error names the offending source", () => {
    const r = validateWatchlistSymbol("bybit", "BTC", fakeHl({}), fakeBinance);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("bybit");
  });
});

describe("canonicalWatchlistSymbol — remove path (no universe check)", () => {
  test("hyperliquid → resolveSymbol (upper)", () => {
    expect(canonicalWatchlistSymbol("hyperliquid", "btc", fakeHl({}))).toBe("BTC");
  });

  test("binance → raw passthrough even when delisted", () => {
    expect(canonicalWatchlistSymbol("binance", "BTCUSDT", fakeHl({}))).toBe("BTCUSDT");
    expect(canonicalWatchlistSymbol("binance", "DELISTEDUSDT", fakeHl({}))).toBe("DELISTEDUSDT");
  });
});
