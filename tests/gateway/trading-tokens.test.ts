/**
 * Multi-source `trading.tokens.list` — prices keyed `${source}:${symbol}`.
 */
import { describe, it, expect } from "bun:test";
import { MethodRegistry, type MethodContext } from "../../src/gateway/method-registry.js";
import { registerTradingMethods } from "../../src/gateway/trading.js";
import { TokensSnapshotService } from "../../src/services/tokens-snapshot.js";
import { PriceCache, WatchlistPriceCache } from "../../src/services/price-cache.js";
import type { ITradingClient } from "../../src/services/interfaces/trading-client.js";

function makeCtx(): MethodContext {
  return { clientId: "c1", sessionId: "s1", broadcast: () => {}, emit: () => {} };
}

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => noopLogger,
} as any;

function makeTradingClient(
  assetNames: string[],
  leverageMap: Record<string, number | undefined>,
): ITradingClient {
  return {
    getAllAssetNames: () => assetNames,
    getMaxLeverage: (symbol: string) => leverageMap[symbol],
    resolveSymbol: (s: string) => s,
    isKnownSymbol: (s: string) => assetNames.includes(s),
    getAllAssets: () =>
      assetNames.map((symbol) => ({ symbol, source: "hyperliquid" as const })),
  } as unknown as ITradingClient;
}

interface TokensListResult {
  tokens: Array<{ symbol: string; source: string }>;
  prices: Record<string, number>;
  prevDayPrices: Record<string, number>;
  maxLeverages: Record<string, number>;
}

function seedCache(entries: Array<[string, number, number?]>): PriceCache {
  const cache = new PriceCache();
  for (const [symbol, price, prevDay] of entries) cache.set(symbol, price, prevDay);
  return cache;
}

function makeDeps(tradingClient: ITradingClient, priceCache: PriceCache) {
  const binance = { list: () => [] };
  return {
    tradingClient,
    walletStore: {} as any,
    alertRules: {} as any,
    notifications: {} as any,
    newsService: {} as any,
    preferenceStore: {} as any,
    watchlist: {} as any,
    intel: {} as any,
    binance: undefined,
    logger: noopLogger,
    tokensSnapshot: new TokensSnapshotService(tradingClient, priceCache, binance, new WatchlistPriceCache()),
    priceCache,
    runner: { call: async () => "" } as any,
  };
}

describe("trading.tokens.list", () => {
  it("includes maxLeverages only for symbols that have a leverage value", async () => {
    const cache = seedCache([["BTC", 60000, 59000], ["xyz:WTIOIL", 75, 70]]);
    const client = makeTradingClient(["BTC", "xyz:WTIOIL"], { BTC: 40, "xyz:WTIOIL": undefined });
    const reg = new MethodRegistry();
    registerTradingMethods(reg.register.bind(reg), makeDeps(client, cache));
    const result = await reg.dispatch("trading.tokens.list", makeCtx(), {}) as TokensListResult;
    expect(result.maxLeverages["BTC"]).toBe(40);
    expect("xyz:WTIOIL" in result.maxLeverages).toBe(false);
  });

  it("populates prices keyed `hyperliquid:${symbol}` from PriceCache", async () => {
    const cache = seedCache([["ETH", 3000, 2900]]);
    const client = makeTradingClient(["ETH"], { ETH: 25 });
    const reg = new MethodRegistry();
    registerTradingMethods(reg.register.bind(reg), makeDeps(client, cache));
    const result = await reg.dispatch("trading.tokens.list", makeCtx(), {}) as TokensListResult;
    expect(result.prices["hyperliquid:ETH"]).toBe(3000);
    expect(result.prevDayPrices["hyperliquid:ETH"]).toBe(2900);
  });

  it("returns tokens carrying source field, sorted by (source, symbol)", async () => {
    const cache = seedCache([["ETH", 3000], ["BTC", 60000]]);
    const client = makeTradingClient(["ETH", "BTC"], {});
    const reg = new MethodRegistry();
    registerTradingMethods(reg.register.bind(reg), makeDeps(client, cache));
    const result = await reg.dispatch("trading.tokens.list", makeCtx(), {}) as TokensListResult;
    expect(result.tokens.map((t) => `${t.source}:${t.symbol}`)).toEqual([
      "hyperliquid:BTC", "hyperliquid:ETH",
    ]);
  });

  it("returns empty maps when both universes are empty", async () => {
    const cache = new PriceCache();
    const client = makeTradingClient([], {});
    const reg = new MethodRegistry();
    registerTradingMethods(reg.register.bind(reg), makeDeps(client, cache));
    const result = await reg.dispatch("trading.tokens.list", makeCtx(), {}) as TokensListResult;
    expect(result.tokens).toEqual([]);
    expect(result.prices).toEqual({});
    expect(result.maxLeverages).toEqual({});
  });

  it("omits prevDayPrice key when cache has no prevDay data", async () => {
    const cache = seedCache([["BTC", 60000]]);
    const client = makeTradingClient(["BTC"], { BTC: 40 });
    const reg = new MethodRegistry();
    registerTradingMethods(reg.register.bind(reg), makeDeps(client, cache));
    const result = await reg.dispatch("trading.tokens.list", makeCtx(), {}) as TokensListResult;
    expect(result.prices["hyperliquid:BTC"]).toBe(60000);
    expect("hyperliquid:BTC" in result.prevDayPrices).toBe(false);
  });
});
