/**
 * Tests for the trading.tokens.list gateway method.
 *
 * The handler is now cache-first: it calls tokensSnapshot.build() which reads
 * from getAllAssetNames() + PriceCache + getMaxLeverage(). Tests wire up a
 * real TokensSnapshotService backed by a seeded PriceCache so the full
 * production code path is exercised, not a stub.
 *
 * Verifies:
 *   - maxLeverages populated only for symbols with a leverage value
 *   - prices and prevDayPrices come from PriceCache
 *   - tokens sorted alphabetically
 *   - empty maps when token list is empty
 *   - zero leverage value excluded
 */
import { describe, it, expect } from "bun:test";
import { MethodRegistry, type MethodContext } from "../../src/gateway/method-registry.js";
import { registerTradingMethods } from "../../src/gateway/trading.js";
import { TokensSnapshotService } from "../../src/services/tokens-snapshot.js";
import { PriceCache } from "../../src/services/price-cache.js";
import type { ITradingClient } from "../../src/services/interfaces/trading-client.js";

function makeCtx(): MethodContext {
  return { clientId: "c1", sessionId: "s1", broadcast: () => {}, emit: () => {} };
}

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => noopLogger,
} as any;

/** Build a minimal ITradingClient stub with controlled asset names and leverage map. */
function makeTradingClient(
  assetNames: string[],
  leverageMap: Record<string, number | undefined>,
): ITradingClient {
  return {
    getAllAssetNames: () => assetNames,
    getMaxLeverage: (symbol: string) => leverageMap[symbol],
    resolveSymbol: (s: string) => s,
    isKnownSymbol: (s: string) => assetNames.includes(s),
  } as unknown as ITradingClient;
}

interface TokensListResult {
  tokens: string[];
  prices: Record<string, number>;
  prevDayPrices: Record<string, number>;
  maxLeverages: Record<string, number>;
}

/** Seed a PriceCache with (symbol, price, prevDay?) entries. */
function seedCache(entries: Array<[string, number, number?]>): PriceCache {
  const cache = new PriceCache();
  for (const [symbol, price, prevDay] of entries) {
    cache.set(symbol, price, prevDay);
  }
  return cache;
}

/** Minimal deps — wire a real TokensSnapshotService so the handler path is exercised. */
function makeDeps(tradingClient: ITradingClient, priceCache: PriceCache) {
  return {
    tradingClient,
    walletStore: {} as any,
    alertRules: {} as any,
    notifications: {} as any,
    newsService: {} as any,
    preferenceStore: {} as any,
    watchlist: {} as any,
    logger: noopLogger,
    tokensSnapshot: new TokensSnapshotService(tradingClient, priceCache),
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

  it("populates prices and prevDayPrices from PriceCache", async () => {
    const cache = seedCache([["ETH", 3000, 2900]]);
    const client = makeTradingClient(["ETH"], { ETH: 25 });

    const reg = new MethodRegistry();
    registerTradingMethods(reg.register.bind(reg), makeDeps(client, cache));

    const result = await reg.dispatch("trading.tokens.list", makeCtx(), {}) as TokensListResult;

    expect(result.prices["ETH"]).toBe(3000);
    expect(result.prevDayPrices["ETH"]).toBe(2900);
  });

  it("returns tokens sorted alphabetically", async () => {
    const cache = seedCache([["ETH", 3000], ["BTC", 60000], ["xyz:AAPL", 195]]);
    const client = makeTradingClient(["ETH", "BTC", "xyz:AAPL"], {});

    const reg = new MethodRegistry();
    registerTradingMethods(reg.register.bind(reg), makeDeps(client, cache));

    const result = await reg.dispatch("trading.tokens.list", makeCtx(), {}) as TokensListResult;

    expect(result.tokens).toEqual(["BTC", "ETH", "xyz:AAPL"]);
  });

  it("returns empty maps when token list is empty", async () => {
    const cache = new PriceCache();
    const client = makeTradingClient([], {});

    const reg = new MethodRegistry();
    registerTradingMethods(reg.register.bind(reg), makeDeps(client, cache));

    const result = await reg.dispatch("trading.tokens.list", makeCtx(), {}) as TokensListResult;

    expect(result.tokens).toEqual([]);
    expect(result.prices).toEqual({});
    expect(result.maxLeverages).toEqual({});
  });

  it("does not include maxLeverages entry for a zero leverage value", async () => {
    const cache = seedCache([["BTC", 60000]]);
    const client = makeTradingClient(["BTC"], {});
    // Override to return 0 explicitly
    (client as any).getMaxLeverage = (_: string) => 0;

    const reg = new MethodRegistry();
    registerTradingMethods(reg.register.bind(reg), makeDeps(client, cache));

    const result = await reg.dispatch("trading.tokens.list", makeCtx(), {}) as TokensListResult;

    expect("BTC" in result.maxLeverages).toBe(false);
  });

  it("omits prevDayPrice entry when cache has no prevDay data", async () => {
    // Seed cache without prevDayPrice (3rd arg omitted)
    const cache = seedCache([["BTC", 60000]]);
    const client = makeTradingClient(["BTC"], { BTC: 40 });

    const reg = new MethodRegistry();
    registerTradingMethods(reg.register.bind(reg), makeDeps(client, cache));

    const result = await reg.dispatch("trading.tokens.list", makeCtx(), {}) as TokensListResult;

    expect(result.prices["BTC"]).toBe(60000);
    expect("BTC" in result.prevDayPrices).toBe(false);
  });

  it("calls tokensSnapshot.build() and returns its result", async () => {
    const cache = seedCache([["BTC", 60000, 59000]]);
    const client = makeTradingClient(["BTC"], { BTC: 40 });

    const reg = new MethodRegistry();
    registerTradingMethods(reg.register.bind(reg), makeDeps(client, cache));

    const result = await reg.dispatch("trading.tokens.list", makeCtx(), {}) as TokensListResult;

    expect(result.tokens).toContain("BTC");
    expect(result.prices["BTC"]).toBe(60000);
    expect(result.prevDayPrices["BTC"]).toBe(59000);
    expect(result.maxLeverages["BTC"]).toBe(40);
  });
});
