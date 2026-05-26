import { describe, test, expect } from "bun:test";
import pino from "pino";
import { HyperliquidSource } from "../../../src/services/price-feed/sources/hyperliquid.js";
import { asHlPriceSource } from "../../../src/services/price-feed/sources/hyperliquid.js";
import type { ITradingClient } from "../../../src/services/interfaces/trading-client.js";
import type { Ticker } from "../../../src/services/interfaces/trading-types.js";

const silent = pino({ level: "silent" });

function mkTicker(symbol: string, markPrice: number): Ticker {
  return {
    symbol,
    markPrice,
    midPrice: markPrice,
    oraclePrice: markPrice,
    volume24h: 0,
    prevDayPrice: markPrice,
    priceChangePct24h: 0,
    openInterest: 0,
    fundingRate: 0,
  };
}

function mkTradingClient(opts: {
  getAllTickers?: () => Promise<Ticker[]>;
  onSubscribe?: () => void;
  onUnsubscribe?: () => void;
}): ITradingClient {
  return {
    async getAllTickers(): Promise<Ticker[]> {
      return opts.getAllTickers ? opts.getAllTickers() : [];
    },
    async subscribeAllDexsAssetCtxs() {
      opts.onSubscribe?.();
      return { unsubscribe: async () => { opts.onUnsubscribe?.(); } };
    },
    getDexUniverses(): ReadonlyMap<string, ReadonlyArray<string>> {
      return new Map();
    },
    async ensureMeta(): Promise<void> {},
  } as unknown as ITradingClient;
}

function seedDexUniverse(src: HyperliquidSource, symbols: readonly string[]): void {
  const tc = (src as unknown as { tradingClient: { getDexUniverses(): Map<string, string[]> } }).tradingClient;
  const newMap = new Map<string, string[]>();
  newMap.set("", [...symbols]);
  tc.getDexUniverses = () => newMap;
}

describe("asHlPriceSource", () => {
  test("identity (name='hyperliquid', priority=0)", () => {
    const src = new HyperliquidSource({
      tradingClient: mkTradingClient({}),
      logger: silent,
    });
    const adapter = asHlPriceSource(src);
    expect(adapter.name).toBe("hyperliquid");
    expect(adapter.priority).toBe(0);
  });

  test("start() subscribes; WS frame reaches downstream", async () => {
    const src = new HyperliquidSource({
      tradingClient: mkTradingClient({}),
      logger: silent,
      wsStaleMs: 60_000,
      healthCheckIntervalMs: 100,
    });
    const received: Array<[string, number, number | undefined]> = [];
    const adapter = asHlPriceSource(src);
    await adapter.start((sym, price, prev) => received.push([sym, price, prev]));

    seedDexUniverse(src, ["BTC"]);
    src.handleAllDexsAssetCtxsEvent({
      ctxs: [["", [{ markPx: "60000", prevDayPx: "58000" }]]],
    });
    expect(received).toEqual([["BTC", 60000, 58000]]);
    await adapter.stop();
  });

  test("stop() unsubscribes — no further ticks reach downstream", async () => {
    const src = new HyperliquidSource({
      tradingClient: mkTradingClient({}),
      logger: silent,
      wsStaleMs: 60_000,
      healthCheckIntervalMs: 100,
    });
    const received: string[] = [];
    const adapter = asHlPriceSource(src);
    await adapter.start((sym) => received.push(sym));
    await adapter.stop();

    seedDexUniverse(src, ["BTC"]);
    src.handleAllDexsAssetCtxsEvent({ ctxs: [["", [{ markPx: "60000" }]]] });
    expect(received).toEqual([]);
  });

  test("getLastTickAt() proxies to the source (max of WS/REST)", async () => {
    const src = new HyperliquidSource({
      tradingClient: mkTradingClient({}),
      logger: silent,
      wsStaleMs: 60_000,
      healthCheckIntervalMs: 100,
    });
    const adapter = asHlPriceSource(src);
    await adapter.start(() => { /* noop */ });

    expect(adapter.getLastTickAt()).toBe(0);

    seedDexUniverse(src, ["BTC"]);
    src.handleAllDexsAssetCtxsEvent({ ctxs: [["", [{ markPx: "60000" }]]] });
    expect(adapter.getLastTickAt()).toBeGreaterThan(0);
    expect(adapter.getLastTickAt()).toBe(src.getLastTickAt());
    await adapter.stop();
  });

  test("two adapters share one WS subscription via refcount", async () => {
    let subCount = 0;
    let unsubCount = 0;
    const src = new HyperliquidSource({
      tradingClient: mkTradingClient({
        onSubscribe: () => { subCount++; },
        onUnsubscribe: () => { unsubCount++; },
      }),
      logger: silent,
      wsStaleMs: 60_000,
      healthCheckIntervalMs: 100,
    });
    const a = asHlPriceSource(src);
    const b = asHlPriceSource(src);
    await a.start(() => { /* noop */ });
    await b.start(() => { /* noop */ });
    expect(subCount).toBe(1);
    await a.stop();
    expect(unsubCount).toBe(0); // still one live subscriber
    await b.stop();
    // give microtasks a chance to flush
    await new Promise((r) => setTimeout(r, 5));
    expect(unsubCount).toBe(1);
  });
});
