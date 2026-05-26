/**
 * Unit tests for HyperliquidSource — subscribe-based WS + REST source with
 * internal on-demand REST fallback. Refcount-driven lifecycle (first
 * subscribe opens WS; last unsubscribe tears down) — symmetric with
 * BinanceSource.
 *
 * WS path coverage
 * ----------------
 * The WS data-plane is exposed as `handleAllDexsAssetCtxsEvent()` — a package-
 * visible method that mirrors BinanceSource.handleWsMessage. Tests drive
 * the real parsing/emission logic through it instead of reaching into
 * private fields, so future refactors to field names cannot silently
 * disable test coverage.
 *
 * The `allDexsAssetCtxs` event is multi-dex: each tuple is [dex, ctxs[]]
 * where ctxs[i] maps to universe[i] for that dex. Each WS-driving test
 * seeds the universe via `seedDexUniverse()` before pushing ctxs.
 *
 * REST path coverage
 * ------------------
 * `tradingClient` dependency is mocked via plain objects — the full REST
 * polling loop (activation/deactivation/emission/error handling) is
 * exercised end-to-end. Fallback orchestration is driven by real
 * `setInterval`/`setTimeout` timers with tight thresholds so tests complete
 * in tens of ms, not seconds.
 */

import { describe, test, expect } from "bun:test";
import pino from "pino";
import { HyperliquidSource } from "../../../src/services/price-feed/sources/hyperliquid.js";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a minimal tradingClient mock. `dexMap` seeds getDexUniverses() so
 * positional `allDexsAssetCtxs` events decode correctly without a real
 * getAllTickers round-trip. Production populates dexUniverses from
 * ensureMeta(); tests bypass that by injecting directly so the WS handler
 * stays the unit under test.
 */
function mkTradingClient(opts: {
  getAllTickers?: () => Promise<Ticker[]>;
  dexMap?: Map<string, string[]>;
  onSubscribe?: () => void;
  onUnsubscribe?: () => void;
}): import("../../../src/services/interfaces/trading-client.js").ITradingClient {
  const dexMap = opts.dexMap ?? new Map<string, string[]>();
  return {
    async getAllTickers(): Promise<Ticker[]> {
      return opts.getAllTickers ? opts.getAllTickers() : [];
    },
    async subscribeAllDexsAssetCtxs() {
      opts.onSubscribe?.();
      return { unsubscribe: async () => { opts.onUnsubscribe?.(); } };
    },
    getDexUniverses(): ReadonlyMap<string, ReadonlyArray<string>> {
      return dexMap;
    },
    async ensureMeta(): Promise<void> {},
  } as unknown as import("../../../src/services/interfaces/trading-client.js").ITradingClient;
}

/**
 * Seed the native ("") dex universe so positional `allDexsAssetCtxs` events
 * decode correctly. Tests that want multi-dex coverage build their own
 * dexMap and pass it to mkTradingClient directly.
 */
function seedDexUniverse(src: HyperliquidSource, symbols: readonly string[]): void {
  const tc = (src as unknown as { tradingClient: { getDexUniverses(): Map<string, string[]> } }).tradingClient;
  const newMap = new Map<string, string[]>();
  newMap.set("", [...symbols]);
  tc.getDexUniverses = () => newMap;
}

/** Drive a WS tick through the real handler path so `lastWsTickAt` advances
 *  the same way production code would. */
function simulateWsTick(src: HyperliquidSource, symbol: string, price: number): void {
  seedDexUniverse(src, [symbol]);
  src.handleAllDexsAssetCtxsEvent({
    ctxs: [["", [{ markPx: String(price) }]]],
  });
}

/** Wait until ensureStarted() finishes by subscribing a no-op and giving
 *  the microtask queue a chance to drain. Returns the unsubscribe fn. */
async function startAndWaitReady(
  src: HyperliquidSource,
  cb: (sym: string, price: number, prev?: number) => void,
): Promise<() => void> {
  const unsub = src.subscribe(cb);
  // Let ensureStarted's promise (WS handshake + hydration) drain.
  await sleep(0);
  return unsub;
}

describe("HyperliquidSource", () => {
  test("first subscribe opens WS; last unsubscribe tears down (refcount)", async () => {
    let subCount = 0;
    let unsubCount = 0;
    const src = new HyperliquidSource({
      tradingClient: mkTradingClient({
        onSubscribe: () => { subCount++; },
        onUnsubscribe: () => { unsubCount++; },
      }),
      logger: silent,
      wsStaleMs: 60_000,
      healthCheckIntervalMs: 10,
    });
    const u1 = await startAndWaitReady(src, () => { /* noop */ });
    const u2 = await startAndWaitReady(src, () => { /* noop */ });
    expect(subCount).toBe(1); // single WS subscribe shared by both
    u1();
    expect(unsubCount).toBe(0); // still one live subscriber
    u2();
    await sleep(5);
    expect(unsubCount).toBe(1);
  });

  test("dispatch fans out to all subscribers", async () => {
    const src = new HyperliquidSource({
      tradingClient: mkTradingClient({}),
      logger: silent,
      wsStaleMs: 60_000,
      healthCheckIntervalMs: 10,
    });
    const a: string[] = [];
    const b: string[] = [];
    const ua = await startAndWaitReady(src, (sym) => a.push(sym));
    const ub = await startAndWaitReady(src, (sym) => b.push(sym));
    seedDexUniverse(src, ["BTC"]);
    src.handleAllDexsAssetCtxsEvent({ ctxs: [["", [{ markPx: "60000" }]]] });
    expect(a).toEqual(["BTC"]);
    expect(b).toEqual(["BTC"]);
    ua();
    src.handleAllDexsAssetCtxsEvent({ ctxs: [["", [{ markPx: "60001" }]]] });
    expect(a).toEqual(["BTC"]); // no further ticks after unsub
    expect(b).toEqual(["BTC", "BTC"]);
    ub();
  });

  test("subscribe / unsubscribe are idempotent and clean up cleanly", async () => {
    const src = new HyperliquidSource({
      tradingClient: mkTradingClient({}),
      logger: silent,
      wsStaleMs: 60_000,
      healthCheckIntervalMs: 10,
    });
    const unsub = await startAndWaitReady(src, () => { /* noop */ });
    unsub();
    unsub(); // second call is a no-op
    await sleep(5);
    expect(src.isRestPolling()).toBe(false);
  });

  test("getLastTickAt() returns max of WS and REST timestamps (real paths)", async () => {
    const src = new HyperliquidSource({
      tradingClient: mkTradingClient({ getAllTickers: async () => [mkTicker("BTC", 100)] }),
      logger: silent,
      wsStaleMs: 60_000,
      healthCheckIntervalMs: 10,
    });
    const unsub = await startAndWaitReady(src, () => { /* noop */ });

    expect(src.getLastTickAt()).toBe(0);

    seedDexUniverse(src, ["BTC"]);
    const beforeWs = Date.now();
    src.handleAllDexsAssetCtxsEvent({ ctxs: [["", [{ markPx: "100" }]]] });
    const afterWs = src.getLastTickAt();
    expect(afterWs).toBeGreaterThanOrEqual(beforeWs);

    src.handleAllDexsAssetCtxsEvent({ ctxs: [["", [{ markPx: "NaN" }]]] });
    expect(src.getLastTickAt()).toBe(afterWs);

    unsub();
  });

  test("WS stale from cold-start → internal REST activates after wsStaleMs", async () => {
    let restCallCount = 0;
    const src = new HyperliquidSource({
      tradingClient: mkTradingClient({
        getAllTickers: async () => { restCallCount++; return [mkTicker("BTC", 100)]; },
      }),
      logger: silent,
      wsStaleMs: 20,
      restIntervalMs: 10,
      healthCheckIntervalMs: 5,
    });
    const received: Array<[string, number]> = [];
    const unsub = await startAndWaitReady(src, (sym, price) => received.push([sym, price]));

    expect(src.isRestPolling()).toBe(false);
    await sleep(40);
    expect(src.isRestPolling()).toBe(true);
    expect(restCallCount).toBeGreaterThanOrEqual(1);
    expect(received).toContainEqual(["BTC", 100]);
    expect(src.getLastTickAt()).toBeGreaterThan(0);
    unsub();
  });

  test("WS tick then silent → internal REST activates mid-flight", async () => {
    let restCallCount = 0;
    const src = new HyperliquidSource({
      tradingClient: mkTradingClient({
        getAllTickers: async () => { restCallCount++; return [mkTicker("BTC", 50)]; },
      }),
      logger: silent,
      wsStaleMs: 20,
      restIntervalMs: 10,
      healthCheckIntervalMs: 5,
    });
    const received: Array<[string, number]> = [];
    const unsub = await startAndWaitReady(src, (sym, price) => received.push([sym, price]));

    simulateWsTick(src, "BTC", 40);
    expect(src.isRestPolling()).toBe(false);
    await sleep(10);
    expect(src.isRestPolling()).toBe(false);

    await sleep(30);
    expect(src.isRestPolling()).toBe(true);
    expect(restCallCount).toBeGreaterThanOrEqual(1);
    unsub();
  });

  test("WS recovers + stable for wsStabilityMs → internal REST deactivates", async () => {
    const src = new HyperliquidSource({
      tradingClient: mkTradingClient({
        getAllTickers: async () => [mkTicker("BTC", 100)],
      }),
      logger: silent,
      wsStaleMs: 20,
      wsStabilityMs: 25,
      restIntervalMs: 10,
      healthCheckIntervalMs: 5,
    });
    const received: Array<[string, number]> = [];
    const unsub = await startAndWaitReady(src, (sym, price) => received.push([sym, price]));

    await sleep(35);
    expect(src.isRestPolling()).toBe(true);

    const end = Date.now() + 60;
    while (Date.now() < end) {
      simulateWsTick(src, "BTC", 200);
      await sleep(5);
    }
    expect(src.isRestPolling()).toBe(false);
    unsub();
  });

  test("REST tick during WS outage keeps source healthy (getLastTickAt advances)", async () => {
    let lastFetchAt = 0;
    const src = new HyperliquidSource({
      tradingClient: mkTradingClient({
        getAllTickers: async () => { lastFetchAt = Date.now(); return [mkTicker("BTC", 100)]; },
      }),
      logger: silent,
      wsStaleMs: 20,
      restIntervalMs: 10,
      healthCheckIntervalMs: 5,
    });
    const unsub = await startAndWaitReady(src, () => { /* noop */ });

    await sleep(45);
    expect(src.isRestPolling()).toBe(true);
    expect(lastFetchAt).toBeGreaterThan(0);
    expect(Date.now() - src.getLastTickAt()).toBeLessThan(50);
    unsub();
  });

  test("both WS and REST silent → getLastTickAt freezes at last known", async () => {
    let callCount = 0;
    const src = new HyperliquidSource({
      tradingClient: mkTradingClient({
        getAllTickers: async () => {
          callCount++;
          if (callCount <= 2) return [mkTicker("BTC", 100)];
          throw new Error("network down");
        },
      }),
      logger: silent,
      wsStaleMs: 20,
      restIntervalMs: 10,
      healthCheckIntervalMs: 5,
    });
    const unsub = await startAndWaitReady(src, () => { /* noop */ });

    await sleep(50);
    const snapshot = src.getLastTickAt();
    expect(snapshot).toBeGreaterThan(0);

    await sleep(40);
    expect(src.getLastTickAt()).toBe(snapshot);
    unsub();
  });

  test("unsubscribe while REST is polling halts further polls", async () => {
    let callCount = 0;
    const src = new HyperliquidSource({
      tradingClient: mkTradingClient({
        getAllTickers: async () => { callCount++; return [mkTicker("BTC", 100)]; },
      }),
      logger: silent,
      wsStaleMs: 10,
      restIntervalMs: 5,
      healthCheckIntervalMs: 5,
    });
    const unsub = await startAndWaitReady(src, () => { /* noop */ });
    await sleep(20);
    expect(src.isRestPolling()).toBe(true);

    unsub();
    await sleep(5);
    const snapshot = callCount;
    await sleep(30);
    expect(callCount).toBe(snapshot);
    expect(src.isRestPolling()).toBe(false);
  });

  test("REST error does not kill the source — next poll still runs", async () => {
    let callCount = 0;
    const src = new HyperliquidSource({
      tradingClient: mkTradingClient({
        getAllTickers: async () => {
          callCount++;
          if (callCount === 1) throw new Error("boom");
          return [mkTicker("BTC", 100)];
        },
      }),
      logger: silent,
      wsStaleMs: 10,
      restIntervalMs: 20,
      healthCheckIntervalMs: 5,
    });
    const received: Array<[string, number]> = [];
    const unsub = await startAndWaitReady(src, (sym, price) => received.push([sym, price]));

    await sleep(80);
    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(received).toContainEqual(["BTC", 100]);
    unsub();
  });

  test("REST emits raw HL symbols — no mapping applied (HL is canonical)", async () => {
    const src = new HyperliquidSource({
      tradingClient: mkTradingClient({
        getAllTickers: async () => [
          mkTicker("BTC", 60000),
          mkTicker("kPEPE", 0.02),
          mkTicker("1000SHIB", 0.025),
        ],
      }),
      logger: silent,
      wsStaleMs: 10,
      restIntervalMs: 20,
      healthCheckIntervalMs: 5,
    });
    const received: Array<[string, number]> = [];
    const unsub = await startAndWaitReady(src, (sym, price) => received.push([sym, price]));
    await sleep(30);
    unsub();

    expect(received).toContainEqual(["BTC", 60000]);
    expect(received).toContainEqual(["kPEPE", 0.02]);
    expect(received).toContainEqual(["1000SHIB", 0.025]);
  });

  test("REST response with zero emittable ticks does not advance lastRestTickAt", async () => {
    const src = new HyperliquidSource({
      tradingClient: mkTradingClient({}),
      logger: silent,
      wsStaleMs: 10,
      restIntervalMs: 15,
      healthCheckIntervalMs: 5,
    });
    const unsub = await startAndWaitReady(src, () => { /* noop */ });
    await sleep(40);
    expect(src.isRestPolling()).toBe(true);
    expect(src.getLastTickAt()).toBe(0);
    unsub();
  });

  test("REST response with only non-finite markPrice entries does not advance lastRestTickAt", async () => {
    const src = new HyperliquidSource({
      tradingClient: mkTradingClient({
        getAllTickers: async () => [mkTicker("BTC", NaN), mkTicker("ETH", Infinity)],
      }),
      logger: silent,
      wsStaleMs: 10,
      restIntervalMs: 15,
      healthCheckIntervalMs: 5,
    });
    const unsub = await startAndWaitReady(src, () => { /* noop */ });
    await sleep(40);
    expect(src.isRestPolling()).toBe(true);
    expect(src.getLastTickAt()).toBe(0);
    unsub();
  });

  test("handleAllDexsAssetCtxsEvent parses string mark prices and emits ticks", async () => {
    const src = new HyperliquidSource({
      tradingClient: mkTradingClient({}),
      logger: silent,
      wsStaleMs: 60_000,
      healthCheckIntervalMs: 10,
    });
    const received: Array<[string, number]> = [];
    const unsub = await startAndWaitReady(src, (sym, price) => received.push([sym, price]));

    seedDexUniverse(src, ["BTC", "ETH", "kPEPE"]);
    src.handleAllDexsAssetCtxsEvent({
      ctxs: [["", [{ markPx: "60000" }, { markPx: "3000" }, { markPx: "0.02" }]]],
    });
    expect(received).toContainEqual(["BTC", 60000]);
    expect(received).toContainEqual(["ETH", 3000]);
    expect(received).toContainEqual(["kPEPE", 0.02]);
    expect(src.getLastTickAt()).toBeGreaterThan(0);
    unsub();
  });

  test("handleAllDexsAssetCtxsEvent drops NaN/Infinity/null mark prices without emitting", async () => {
    const src = new HyperliquidSource({
      tradingClient: mkTradingClient({}),
      logger: silent,
      wsStaleMs: 60_000,
      healthCheckIntervalMs: 10,
    });
    const received: Array<[string, number]> = [];
    const unsub = await startAndWaitReady(src, (sym, price) => received.push([sym, price]));

    seedDexUniverse(src, ["BAD1", "BAD2", "BAD3"]);
    src.handleAllDexsAssetCtxsEvent({
      ctxs: [["", [{ markPx: "NaN" }, { markPx: "Infinity" }, { markPx: null }]]],
    });
    expect(received).toEqual([]);
    expect(src.getLastTickAt()).toBe(0);

    seedDexUniverse(src, ["BAD", "BTC"]);
    src.handleAllDexsAssetCtxsEvent({
      ctxs: [["", [{ markPx: "NaN" }, { markPx: "60000" }]]],
    });
    expect(received).toEqual([["BTC", 60000]]);
    expect(src.getLastTickAt()).toBeGreaterThan(0);
    unsub();
  });

  test("handleAllDexsAssetCtxsEvent accepts numeric mark prices (not just strings)", async () => {
    const src = new HyperliquidSource({
      tradingClient: mkTradingClient({}),
      logger: silent,
      wsStaleMs: 60_000,
      healthCheckIntervalMs: 10,
    });
    const received: Array<[string, number]> = [];
    const unsub = await startAndWaitReady(src, (sym, price) => received.push([sym, price]));

    seedDexUniverse(src, ["BTC"]);
    src.handleAllDexsAssetCtxsEvent({ ctxs: [["", [{ markPx: 60000 as unknown as string }]]] });
    expect(received).toEqual([["BTC", 60000]]);
    unsub();
  });

  test("handleAllDexsAssetCtxsEvent handles multiple dexes in one frame", async () => {
    const dexMap = new Map<string, string[]>();
    dexMap.set("", ["BTC", "ETH"]);
    dexMap.set("xyz", ["xyz:AAPL", "xyz:TSLA"]);
    const src = new HyperliquidSource({
      tradingClient: mkTradingClient({ dexMap }),
      logger: silent,
      wsStaleMs: 60_000,
      healthCheckIntervalMs: 10,
    });
    const received: Array<[string, number]> = [];
    const unsub = await startAndWaitReady(src, (sym, price) => received.push([sym, price]));

    src.handleAllDexsAssetCtxsEvent({
      ctxs: [
        ["", [{ markPx: "60000" }, { markPx: "3000" }]],
        ["xyz", [{ markPx: "192.5" }, { markPx: "250.0" }]],
      ],
    });
    expect(received).toContainEqual(["BTC", 60000]);
    expect(received).toContainEqual(["ETH", 3000]);
    expect(received).toContainEqual(["xyz:AAPL", 192.5]);
    expect(received).toContainEqual(["xyz:TSLA", 250.0]);
    expect(src.getLastTickAt()).toBeGreaterThan(0);
    unsub();
  });

  test("REST drops non-finite markPrice entries", async () => {
    const src = new HyperliquidSource({
      tradingClient: mkTradingClient({
        getAllTickers: async () => [
          mkTicker("BTC", 60000),
          mkTicker("BADNAN", NaN),
          mkTicker("BADINF", Infinity),
          mkTicker("ETH", 3000),
        ],
      }),
      logger: silent,
      wsStaleMs: 10,
      restIntervalMs: 20,
      healthCheckIntervalMs: 5,
    });
    const received: Array<[string, number]> = [];
    const unsub = await startAndWaitReady(src, (sym, price) => received.push([sym, price]));
    await sleep(30);
    unsub();

    expect(received).toContainEqual(["BTC", 60000]);
    expect(received).toContainEqual(["ETH", 3000]);
    expect(received.find((r) => r[0] === "BADNAN")).toBeUndefined();
    expect(received.find((r) => r[0] === "BADINF")).toBeUndefined();
  });

  test("subscribe() runs REST hydration (each valid ticker dispatched)", async () => {
    const hydrationTickers = [
      mkTicker("BTC", 60000),
      mkTicker("ETH", 3000),
      mkTicker("SOL", 150),
    ];
    const src = new HyperliquidSource({
      tradingClient: mkTradingClient({
        getAllTickers: async () => hydrationTickers,
      }),
      logger: silent,
      wsStaleMs: 60_000,
      healthCheckIntervalMs: 100,
    });
    const received: Array<[string, number]> = [];
    const unsub = src.subscribe((sym, price) => received.push([sym, price]));
    // Hydration runs inside ensureStarted(); wait for the microtask chain to drain.
    await sleep(5);

    expect(received).toContainEqual(["BTC", 60000]);
    expect(received).toContainEqual(["ETH", 3000]);
    expect(received).toContainEqual(["SOL", 150]);
    unsub();
  });

  test("subscribe() does NOT throw if getAllTickers rejects — feed comes up degraded", async () => {
    const wsReceived: Array<[string, number]> = [];
    const src = new HyperliquidSource({
      tradingClient: mkTradingClient({
        getAllTickers: async () => { throw new Error("network error"); },
      }),
      logger: silent,
      wsStaleMs: 60_000,
      healthCheckIntervalMs: 100,
    });

    const unsub = src.subscribe((sym, price) => wsReceived.push([sym, price]));
    await sleep(10);

    simulateWsTick(src, "BTC", 70000);
    expect(wsReceived).toContainEqual(["BTC", 70000]);
    unsub();
  });

  test("shutdown() drops subscribers and tears down regardless of refcount", async () => {
    let unsubCount = 0;
    const src = new HyperliquidSource({
      tradingClient: mkTradingClient({
        onUnsubscribe: () => { unsubCount++; },
      }),
      logger: silent,
      wsStaleMs: 60_000,
      healthCheckIntervalMs: 10,
    });
    await startAndWaitReady(src, () => { /* noop */ });
    await startAndWaitReady(src, () => { /* noop */ });
    await src.shutdown();
    expect(unsubCount).toBe(1);
    expect(src.isRestPolling()).toBe(false);
  });
});
