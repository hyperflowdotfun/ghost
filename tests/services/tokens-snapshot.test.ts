/**
 * Unit tests for TokensSnapshotService — multi-source shape with
 * `${source}:${symbol}` keys.
 */

import { describe, test, expect } from "bun:test";
import { TokensSnapshotService } from "../../src/services/tokens-snapshot.js";
import { PriceCache, WatchlistPriceCache } from "../../src/services/price-cache.js";

function makeClient(
  assets: string[],
  leverages: Record<string, number | undefined>,
  delisted: Set<string> = new Set(),
) {
  return {
    getAllAssets: () =>
      assets.map((symbol) =>
        delisted.has(symbol)
          ? { symbol, source: "hyperliquid" as const, isDelisted: true as const }
          : { symbol, source: "hyperliquid" as const },
      ),
    getMaxLeverage: (s: string) => leverages[s],
  };
}

function emptyBinance() {
  return { list: () => [] };
}

describe("TokensSnapshotService", () => {
  test("build returns sorted tokens from getAllAssets (HL-only)", () => {
    const svc = new TokensSnapshotService(
      makeClient(["ETH", "BTC", "xyz:AAPL"], {}),
      new PriceCache(),
      emptyBinance(),
      new WatchlistPriceCache(),
    );
    const snap = svc.build();
    expect(snap.tokens.map((t) => t.symbol)).toEqual(["BTC", "ETH", "xyz:AAPL"]);
    expect(snap.tokens.every((t) => t.source === "hyperliquid")).toBe(true);
  });

  test("HL prices keyed `hyperliquid:${symbol}` from PriceCache", () => {
    const hl = new PriceCache();
    hl.set("BTC", 60_000, 59_000);
    hl.set("ETH", 3_000);
    const svc = new TokensSnapshotService(
      makeClient(["BTC", "ETH"], {}),
      hl,
      emptyBinance(),
      new WatchlistPriceCache(),
    );
    const snap = svc.build();
    expect(snap.prices["hyperliquid:BTC"]).toBe(60_000);
    expect(snap.prices["hyperliquid:ETH"]).toBe(3_000);
    expect(snap.prevDayPrices["hyperliquid:BTC"]).toBe(59_000);
    expect("hyperliquid:ETH" in snap.prevDayPrices).toBe(false);
  });

  test("maxLeverages keyed by HL symbol (no source prefix); zero excluded", () => {
    const svc = new TokensSnapshotService(
      makeClient(["BTC", "ETH", "OLD"], { BTC: 40, ETH: undefined, OLD: 0 }),
      new PriceCache(),
      emptyBinance(),
      new WatchlistPriceCache(),
    );
    const snap = svc.build();
    expect(snap.maxLeverages["BTC"]).toBe(40);
    expect("ETH" in snap.maxLeverages).toBe(false);
    expect("OLD" in snap.maxLeverages).toBe(false);
  });

  test("delisted HL symbols carry isDelisted: true; live omit", () => {
    const svc = new TokensSnapshotService(
      makeClient(["BTC", "JUP"], { BTC: 40, JUP: 10 }, new Set(["JUP"])),
      new PriceCache(),
      emptyBinance(),
      new WatchlistPriceCache(),
    );
    const snap = svc.build();
    expect(snap.tokens).toEqual([
      { symbol: "BTC", source: "hyperliquid" },
      { symbol: "JUP", source: "hyperliquid", isDelisted: true },
    ]);
  });

  test("Binance rows appended with source='binance' and binance-keyed prices", () => {
    const multi = new WatchlistPriceCache();
    multi.set("binance", "BTCUSDT", 60_010, 58_900);
    multi.set("binance", "SOLUSDT", 150);
    const svc = new TokensSnapshotService(
      makeClient(["BTC"], { BTC: 40 }),
      new PriceCache(),
      { list: () => [{ symbol: "BTCUSDT" }, { symbol: "SOLUSDT" }] },
      multi,
    );
    const snap = svc.build();
    // HL rows sort before binance because "hyperliquid" < "binance" alphabetically? No — "binance" < "hyperliquid".
    expect(snap.tokens.map((t) => `${t.source}:${t.symbol}`)).toEqual([
      "binance:BTCUSDT", "binance:SOLUSDT", "hyperliquid:BTC",
    ]);
    expect(snap.prices["binance:BTCUSDT"]).toBe(60_010);
    expect(snap.prevDayPrices["binance:BTCUSDT"]).toBe(58_900);
    expect("binance:SOLUSDT" in snap.prevDayPrices).toBe(false);
    // maxLeverages remains HL-only.
    expect(snap.maxLeverages["BTC"]).toBe(40);
    expect("BTCUSDT" in snap.maxLeverages).toBe(false);
  });

  test("empty universe (both sources) returns all-empty snapshot", () => {
    const svc = new TokensSnapshotService(
      makeClient([], {}),
      new PriceCache(),
      emptyBinance(),
      new WatchlistPriceCache(),
    );
    const snap = svc.build();
    expect(snap.tokens).toEqual([]);
    expect(snap.prices).toEqual({});
    expect(snap.prevDayPrices).toEqual({});
    expect(snap.maxLeverages).toEqual({});
  });
});
