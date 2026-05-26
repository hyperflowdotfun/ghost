/**
 * Regression tests for the price-feed start/stop lifecycle.
 *
 * HyperliquidSource.subscribe() performs a one-shot REST hydration via
 * getAllTickers and dispatches each ticker through every registered
 * listener. These tests verify the hydration contract without spinning up
 * the full gateway.
 *
 * Covers:
 *   - subscribe() hydrates through the listener (populates whatever cache the caller wires up)
 *   - subscribe() does not throw on getAllTickers failure (degraded start)
 *   - non-finite markPrice entries are skipped
 *   - zero prevDayPrice is treated as absent
 */

import { describe, it, expect } from "bun:test";
import { PriceCache } from "../../src/services/price-cache.js";
import { HyperliquidSource } from "../../src/services/price-feed/sources/hyperliquid.js";
import type { Ticker } from "../../src/services/interfaces/trading-types.js";
import type { ITradingClient } from "../../src/services/interfaces/trading-client.js";
import pino from "pino";

const silent = pino({ level: "silent" });

const SAMPLE_TICKERS: Ticker[] = [
  {
    symbol: "BTC",
    markPrice: 60_000,
    midPrice: 60_010,
    oraclePrice: 60_005,
    volume24h: 1_000_000,
    prevDayPrice: 58_000,
    priceChangePct24h: 3.4,
    openInterest: 500_000,
    fundingRate: 0.0001,
  },
  {
    symbol: "ETH",
    markPrice: 3_000,
    midPrice: 3_002,
    oraclePrice: 3_001,
    volume24h: 500_000,
    prevDayPrice: 2_900,
    priceChangePct24h: 3.4,
    openInterest: 200_000,
    fundingRate: 0.0001,
  },
  {
    symbol: "AAVE",
    markPrice: 100,
    midPrice: 100.5,
    oraclePrice: 100.2,
    volume24h: 10_000,
    prevDayPrice: 95,
    priceChangePct24h: 5.3,
    openInterest: 5_000,
    fundingRate: 0.0001,
  },
];

function mkClient(tickers: Ticker[], opts?: { shouldThrow?: boolean }): ITradingClient {
  return {
    async getAllTickers(): Promise<Ticker[]> {
      if (opts?.shouldThrow) throw new Error("REST unavailable");
      return tickers;
    },
    async subscribeAllDexsAssetCtxs() {
      return { unsubscribe: async () => {} };
    },
    getDexUniverses(): ReadonlyMap<string, ReadonlyArray<string>> {
      return new Map();
    },
    async ensureMeta(): Promise<void> {},
  } as unknown as ITradingClient;
}

function mkSource(client: ITradingClient): HyperliquidSource {
  return new HyperliquidSource({
    tradingClient: client,
    logger: silent,
    // Large wsStaleMs so REST fallback doesn't auto-activate during tests.
    wsStaleMs: 60_000,
    healthCheckIntervalMs: 100,
  });
}

/** Wait one microtask tick so ensureStarted()'s hydration promise drains. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

describe("price-feed lifecycle: HyperliquidSource subscribe() REST hydration", () => {
  it("subscribe() hydrates through listener — cache is populated by the time hydration drains", async () => {
    const cache = new PriceCache();
    const src = mkSource(mkClient(SAMPLE_TICKERS));

    const unsub = src.subscribe((sym, price, prev) => cache.set(sym, price, prev));
    await flush();
    unsub();

    const btc = cache.get("BTC", Infinity);
    expect(btc?.price).toBe(60_000);
    expect(btc?.prevDayPrice).toBe(58_000);

    const eth = cache.get("ETH", Infinity);
    expect(eth?.price).toBe(3_000);

    const aave = cache.get("AAVE", Infinity);
    expect(aave?.price).toBe(100);
  });

  it("subscribe() does NOT throw when getAllTickers rejects — feed starts degraded", async () => {
    const src = mkSource(mkClient([], { shouldThrow: true }));
    const unsub = src.subscribe(() => {});
    await flush();
    unsub();
  });

  it("skips tickers with non-finite markPrice", async () => {
    const badTickers: Ticker[] = [
      {
        symbol: "GHOST",
        markPrice: NaN,
        midPrice: 0,
        oraclePrice: 0,
        volume24h: 0,
        prevDayPrice: 0,
        priceChangePct24h: 0,
        openInterest: 0,
        fundingRate: 0,
      },
      ...SAMPLE_TICKERS,
    ];
    const cache = new PriceCache();
    const src = mkSource(mkClient(badTickers));

    const unsub = src.subscribe((sym, price, prev) => cache.set(sym, price, prev));
    await flush();
    unsub();

    expect(cache.get("GHOST", Infinity)).toBeUndefined();
    expect(cache.get("BTC", Infinity)?.price).toBe(60_000);
  });

  it("treats zero prevDayPrice as absent (does not pass 0 to cache)", async () => {
    const tickers: Ticker[] = [
      {
        symbol: "NEW",
        markPrice: 50,
        midPrice: 50,
        oraclePrice: 50,
        volume24h: 100,
        prevDayPrice: 0,
        priceChangePct24h: 0,
        openInterest: 0,
        fundingRate: 0,
      },
    ];
    const cache = new PriceCache();
    const src = mkSource(mkClient(tickers));

    const unsub = src.subscribe((sym, price, prev) => cache.set(sym, price, prev));
    await flush();
    unsub();

    const entry = cache.get("NEW", Infinity);
    expect(entry?.price).toBe(50);
    expect(entry?.prevDayPrice).toBeUndefined();
  });
});
