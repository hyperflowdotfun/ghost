import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { IntelService } from "../../src/services/intel.js";
import type { ITradingClient } from "../../src/services/interfaces/trading-client.js";
import type { Ticker } from "../../src/services/interfaces/trading-types.js";

function makeTradingClient(overrides: {
  knownSymbols?: string[];
  ticker?: Partial<Ticker>;
  failGetTicker?: boolean;
} = {}): ITradingClient {
  const known = new Set((overrides.knownSymbols ?? []).map((s) => s.toUpperCase()));
  return {
    resolveSymbol: (s: string) => s.toUpperCase(),
    isKnownSymbol: (s: string) => known.has(s.toUpperCase()),
    getTicker: async (symbol: string): Promise<Ticker> => {
      if (overrides.failGetTicker) throw new Error("boom");
      return {
        symbol,
        markPrice: 60_000,
        midPrice: 60_000,
        oraclePrice: 60_000,
        volume24h: 0,
        prevDayPrice: 59_000,
        priceChangePct24h: 1.7,
        openInterest: 1_500,
        fundingRate: 0,
        ...overrides.ticker,
      };
    },
  } as unknown as ITradingClient;
}

// Stub global fetch so CoinGecko calls return a deterministic payload without
// network access. Restored in afterEach.
const ORIGINAL_FETCH = globalThis.fetch;
function stubCgFetch(rows: Array<Record<string, unknown>>) {
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/coins/markets")) {
      return new Response(JSON.stringify(rows), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

describe("IntelService.getCoinStats — open interest", () => {
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

  test("computes USD OI as openInterest × markPrice from the trading client", async () => {
    stubCgFetch([{ market_cap: 9_420_000_000, total_volume: 141_000_000, fully_diluted_valuation: 9_410_000_000, price_change_percentage_24h: 5.3 }]);
    const client = makeTradingClient({
      knownSymbols: ["BTC"],
      ticker: { markPrice: 60_000, openInterest: 1_500 },
    });
    const intel = new IntelService(client);

    const stats = await intel.getCoinStats("BTC");

    expect(stats.openInterest).toBe(1_500 * 60_000);
    expect(stats.marketCap).toBe(9_420_000_000);
    expect(stats.volume24h).toBe(141_000_000);
    expect(stats.fdv).toBe(9_410_000_000);
  });

  test("returns undefined OI when symbol is not in the perp universe", async () => {
    stubCgFetch([{ market_cap: 1, total_volume: 1, fully_diluted_valuation: 1, price_change_percentage_24h: 0 }]);
    const client = makeTradingClient({ knownSymbols: [] });
    const intel = new IntelService(client);

    const stats = await intel.getCoinStats("BTC");

    expect(stats.openInterest).toBeUndefined();
  });

  test("returns undefined OI when getTicker throws", async () => {
    stubCgFetch([{ market_cap: 1, total_volume: 1, fully_diluted_valuation: 1, price_change_percentage_24h: 0 }]);
    const client = makeTradingClient({ knownSymbols: ["BTC"], failGetTicker: true });
    const intel = new IntelService(client);

    const stats = await intel.getCoinStats("BTC");

    expect(stats.openInterest).toBeUndefined();
    expect(stats.marketCap).toBe(1);
  });

  test("still returns OI for symbols not in the CG mapping", async () => {
    // No CG entry for "FOO" → marketCap/volume/fdv undefined, but OI still resolves
    // when the perp exists on Hyperliquid.
    stubCgFetch([]);
    const client = makeTradingClient({
      knownSymbols: ["FOO"],
      ticker: { markPrice: 10, openInterest: 200 },
    });
    const intel = new IntelService(client);

    const stats = await intel.getCoinStats("FOO");

    expect(stats.openInterest).toBe(2_000);
    expect(stats.marketCap).toBeUndefined();
    expect(stats.fdv).toBeUndefined();
  });

  test("works with no trading client (back-compat)", async () => {
    stubCgFetch([{ market_cap: 1, total_volume: 1, fully_diluted_valuation: 1, price_change_percentage_24h: 0 }]);
    const intel = new IntelService();

    const stats = await intel.getCoinStats("BTC");

    expect(stats.openInterest).toBeUndefined();
    expect(stats.marketCap).toBe(1);
  });
});
