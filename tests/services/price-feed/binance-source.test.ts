/**
 * Unit tests for BinanceSource — subscribe-based multi-stream Binance USDⓈ-M
 * source. Combined-stream WS multiplexes markPrice + miniTicker; per-stream
 * REST fallback polls premiumIndex + ticker/24hr.
 *
 * Covers:
 *   - subscribe lifecycle (refcount opens/closes WS exactly once)
 *   - combined-stream frame dispatch by `stream` field
 *   - structural filters (non-USDT, stable-stable, leveraged)
 *   - REST fallback per stream (premiumIndex / ticker/24hr)
 *   - getLastMarkTickAt / getLastMiniTickAt track independently
 */

import { describe, test, expect } from "bun:test";
import pino from "pino";
import { BinanceSource } from "../../../src/services/price-feed/sources/binance.js";

const silent = pino({ level: "silent" });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("BinanceSource — subscribe lifecycle (refcount)", () => {
  test("first subscribeMarkPrice opens WS exactly once", () => {
    let connectCount = 0;
    const src = new BinanceSource({
      logger: silent,
      wsUrl: "ws://127.0.0.1:1",
      wsConnect: () => { connectCount++; return mkFakeWs(); },
    });
    src.subscribeMarkPrice(() => { /* noop */ });
    src.subscribeMarkPrice(() => { /* noop */ });
    expect(connectCount).toBe(1);
  });

  test("second subscriber (different stream) reuses the same WS", () => {
    let connectCount = 0;
    const src = new BinanceSource({
      logger: silent,
      wsUrl: "ws://127.0.0.1:1",
      wsConnect: () => { connectCount++; return mkFakeWs(); },
    });
    src.subscribeMarkPrice(() => { /* noop */ });
    src.subscribeMiniTicker(() => { /* noop */ });
    expect(connectCount).toBe(1);
  });

  test("last unsubscribe closes WS", () => {
    let closeCount = 0;
    const fake = mkFakeWs(() => { closeCount++; });
    const src = new BinanceSource({
      logger: silent,
      wsUrl: "ws://127.0.0.1:1",
      wsConnect: () => fake,
    });
    const unsubA = src.subscribeMarkPrice(() => { /* noop */ });
    const unsubB = src.subscribeMiniTicker(() => { /* noop */ });
    unsubA();
    expect(closeCount).toBe(0);
    unsubB();
    expect(closeCount).toBe(1);
  });

  test("re-subscribe after teardown opens a fresh WS", () => {
    let connectCount = 0;
    const src = new BinanceSource({
      logger: silent,
      wsUrl: "ws://127.0.0.1:1",
      wsConnect: () => { connectCount++; return mkFakeWs(); },
    });
    const unsub = src.subscribeMarkPrice(() => { /* noop */ });
    unsub();
    src.subscribeMarkPrice(() => { /* noop */ });
    expect(connectCount).toBe(2);
  });
});

describe("BinanceSource — combined-stream dispatch", () => {
  function mkSrc(): BinanceSource {
    return new BinanceSource({
      logger: silent,
      wsUrl: "ws://127.0.0.1:1",
      wsConnect: () => mkFakeWs(),
    });
  }

  test("markPrice frame → only mark subscribers receive ticks (HL-canonical)", () => {
    const src = mkSrc();
    const marks: Array<[string, number, number | undefined]> = [];
    const minis: Array<[string, number, number | undefined]> = [];
    src.subscribeMarkPrice((s, p, prev) => marks.push([s, p, prev]));
    src.subscribeMiniTicker((s, p, prev) => minis.push([s, p, prev]));
    src.handleWsMessage(JSON.stringify({
      stream: "!markPrice@arr@1s",
      data: [{ s: "BTCUSDT", p: "60000" }],
    }));
    expect(marks).toEqual([["BTC", 60000, undefined]]);
    expect(minis).toEqual([]);
  });

  test("markPrice frame for k-prefix pair → emits ×1000 HL price", () => {
    const src = mkSrc();
    const marks: Array<[string, number, number | undefined]> = [];
    src.subscribeMarkPrice((s, p, prev) => marks.push([s, p, prev]));
    src.handleWsMessage(JSON.stringify({
      stream: "!markPrice@arr@1s",
      data: [{ s: "PEPEUSDT", p: "0.00002" }],
    }));
    expect(marks).toHaveLength(1);
    expect(marks[0]![0]).toBe("kPEPE");
    expect(marks[0]![1]).toBeCloseTo(0.02, 10);
    expect(marks[0]![2]).toBeUndefined();
  });

  test("markPrice frame for symbol not in BINANCE_TO_HL → dropped", () => {
    const src = mkSrc();
    const marks: Array<[string, number]> = [];
    src.subscribeMarkPrice((s, p) => marks.push([s, p]));
    src.handleWsMessage(JSON.stringify({
      stream: "!markPrice@arr@1s",
      data: [
        { s: "BTCUSDT", p: "60000" },        // listed → HL canonical
        { s: "FAKE123USDT", p: "1.0" },      // structurally valid, not in table → drop
      ],
    }));
    expect(marks).toEqual([["BTC", 60000]]);
  });

  test("miniTicker frame → only mini subscribers receive ticks (carries prevDay)", () => {
    const src = mkSrc();
    const marks: Array<[string, number, number | undefined]> = [];
    const minis: Array<[string, number, number | undefined]> = [];
    src.subscribeMarkPrice((s, p, prev) => marks.push([s, p, prev]));
    src.subscribeMiniTicker((s, p, prev) => minis.push([s, p, prev]));
    src.handleWsMessage(JSON.stringify({
      stream: "!miniTicker@arr",
      data: [{ s: "BTCUSDT", c: "60100", o: "59000" }],
    }));
    expect(marks).toEqual([]);
    expect(minis).toEqual([["BTCUSDT", 60100, 59000]]);
  });

  test("structural filters apply to both streams", () => {
    const src = mkSrc();
    const marks: string[] = [];
    const minis: string[] = [];
    src.subscribeMarkPrice((s) => marks.push(s));
    src.subscribeMiniTicker((s) => minis.push(s));
    const junk = [
      { s: "USDCUSDT", p: "1.0", c: "1.0", o: "1.0" },      // stable-stable
      { s: "BTCUPUSDT", p: "100", c: "100", o: "99" },       // leveraged
      { s: "ETHBTC", p: "0.05", c: "0.05", o: "0.05" },      // non-USDT
      { s: "BTCUSDT", p: "60000", c: "60100", o: "59000" },  // ok
    ];
    src.handleWsMessage(JSON.stringify({ stream: "!markPrice@arr@1s", data: junk }));
    src.handleWsMessage(JSON.stringify({ stream: "!miniTicker@arr", data: junk }));
    // Mark stream emits HL-canonical; mini stream emits native Binance.
    expect(marks).toEqual(["BTC"]);
    expect(minis).toEqual(["BTCUSDT"]);
  });

  test("invalid JSON / non-object frame / unknown stream silently ignored", () => {
    const src = mkSrc();
    const marks: string[] = [];
    src.subscribeMarkPrice((s) => marks.push(s));
    expect(() => src.handleWsMessage("not json")).not.toThrow();
    expect(() => src.handleWsMessage(JSON.stringify(null))).not.toThrow();
    expect(() => src.handleWsMessage(JSON.stringify({ stream: "!unknown", data: [{ s: "BTCUSDT", p: "1" }] }))).not.toThrow();
    expect(marks).toEqual([]);
  });

  test("getLastMarkTickAt / getLastMiniTickAt advance independently", () => {
    const src = mkSrc();
    src.subscribeMarkPrice(() => { /* noop */ });
    src.subscribeMiniTicker(() => { /* noop */ });
    expect(src.getLastMarkTickAt()).toBe(0);
    expect(src.getLastMiniTickAt()).toBe(0);

    src.handleWsMessage(JSON.stringify({
      stream: "!markPrice@arr@1s",
      data: [{ s: "BTCUSDT", p: "60000" }],
    }));
    expect(src.getLastMarkTickAt()).toBeGreaterThan(0);
    expect(src.getLastMiniTickAt()).toBe(0);

    src.handleWsMessage(JSON.stringify({
      stream: "!miniTicker@arr",
      data: [{ s: "BTCUSDT", c: "60100", o: "59000" }],
    }));
    expect(src.getLastMiniTickAt()).toBeGreaterThan(0);
  });
});

describe("BinanceSource — REST fallback", () => {
  test("WS stale → REST polls both endpoints + dispatches to right subscribers", async () => {
    const fetchCalls: string[] = [];
    const fetchFn = async (url: string): Promise<Response> => {
      fetchCalls.push(url);
      if (url.includes("premiumIndex")) {
        return new Response(JSON.stringify([
          { symbol: "BTCUSDT", markPrice: "60000" },
          { symbol: "USDCUSDT", markPrice: "1.0" }, // filtered
        ]), { status: 200 });
      }
      if (url.includes("ticker/24hr")) {
        return new Response(JSON.stringify([
          { symbol: "BTCUSDT", lastPrice: "60100", openPrice: "59000" },
        ]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };

    const marks: Array<[string, number]> = [];
    const minis: Array<[string, number, number | undefined]> = [];
    const src = new BinanceSource({
      logger: silent,
      wsUrl: "ws://127.0.0.1:1",
      wsConnect: () => mkFakeWs(),
      fetchFn,
      wsStaleMs: 15,
      restIntervalMs: 10,
      healthCheckIntervalMs: 5,
    });
    src.subscribeMarkPrice((s, p) => marks.push([s, p]));
    src.subscribeMiniTicker((s, p, prev) => minis.push([s, p, prev]));

    await sleep(40);

    expect(fetchCalls.some((u) => u.includes("premiumIndex"))).toBe(true);
    expect(fetchCalls.some((u) => u.includes("ticker/24hr"))).toBe(true);
    // Mark REST emits HL-canonical (BTCUSDT → BTC); mini REST emits native.
    expect(marks).toContainEqual(["BTC", 60000]);
    expect(marks.find((r) => r[0] === "USDCUSDT")).toBeUndefined();
    expect(minis).toContainEqual(["BTCUSDT", 60100, 59000]);

    src.shutdown();
  });

  test("REST deactivates once WS frames resume", async () => {
    let callCount = 0;
    const fetchFn = async (): Promise<Response> => {
      callCount++;
      return new Response(JSON.stringify([]), { status: 200 });
    };

    const src = new BinanceSource({
      logger: silent,
      wsUrl: "ws://127.0.0.1:1",
      wsConnect: () => mkFakeWs(),
      fetchFn,
      wsStaleMs: 15,
      wsStabilityMs: 20,
      restIntervalMs: 10,
      healthCheckIntervalMs: 5,
    });
    src.subscribeMarkPrice(() => { /* noop */ });
    await sleep(30);
    expect(src.isRestPolling()).toBe(true);

    const end = Date.now() + 50;
    while (Date.now() < end) {
      src.handleWsMessage(JSON.stringify({
        stream: "!markPrice@arr@1s",
        data: [{ s: "BTCUSDT", p: "60000" }],
      }));
      await sleep(5);
    }
    expect(src.isRestPolling()).toBe(false);

    void callCount; // call count not asserted — coverage covered by 1st test
    src.shutdown();
  });

  test("shutdown halts REST polling immediately", async () => {
    let callCount = 0;
    const fetchFn = async (): Promise<Response> => {
      callCount++;
      return new Response(JSON.stringify([]), { status: 200 });
    };
    const src = new BinanceSource({
      logger: silent,
      wsUrl: "ws://127.0.0.1:1",
      wsConnect: () => mkFakeWs(),
      fetchFn,
      wsStaleMs: 5,
      restIntervalMs: 5,
      healthCheckIntervalMs: 5,
    });
    src.subscribeMarkPrice(() => { /* noop */ });
    await sleep(20);
    expect(src.isRestPolling()).toBe(true);
    src.shutdown();
    const snapshot = callCount;
    await sleep(30);
    expect(callCount).toBe(snapshot);
  });
});

describe("BinanceSource — WS reconnect", () => {
  test("WS close while subscribed → schedules retry → fresh wsConnect after backoff", async () => {
    const fakes: FakeWs[] = [];
    let connectCount = 0;
    const src = new BinanceSource({
      logger: silent,
      wsUrl: "ws://127.0.0.1:1",
      wsConnect: () => { connectCount++; const ws = mkFakeWs(); fakes.push(ws); return ws; },
      wsRetryBaseMs: 5,
      healthCheckIntervalMs: 1000,
    });
    src.subscribeMarkPrice(() => { /* noop */ });
    expect(connectCount).toBe(1);

    fakes[0]!.fireClose();
    await sleep(25);
    expect(connectCount).toBe(2);

    src.shutdown();
  });

  test("WS close with no subscribers → does NOT schedule retry", async () => {
    const fakes: FakeWs[] = [];
    let connectCount = 0;
    const src = new BinanceSource({
      logger: silent,
      wsUrl: "ws://127.0.0.1:1",
      wsConnect: () => { connectCount++; const ws = mkFakeWs(); fakes.push(ws); return ws; },
      wsRetryBaseMs: 5,
    });
    const unsub = src.subscribeMarkPrice(() => { /* noop */ });
    expect(connectCount).toBe(1);
    unsub();
    // After last unsub, teardown closes the WS — listeners array still
    // present on captured handle; firing close should NOT reopen.
    fakes[0]!.fireClose();
    await sleep(25);
    expect(connectCount).toBe(1);
  });

  test("shutdown clears any pending retry timer", async () => {
    const fakes: FakeWs[] = [];
    let connectCount = 0;
    const src = new BinanceSource({
      logger: silent,
      wsUrl: "ws://127.0.0.1:1",
      wsConnect: () => { connectCount++; const ws = mkFakeWs(); fakes.push(ws); return ws; },
      wsRetryBaseMs: 30,
    });
    src.subscribeMarkPrice(() => { /* noop */ });
    fakes[0]!.fireClose();
    // Retry scheduled but not yet fired.
    src.shutdown();
    await sleep(50);
    expect(connectCount).toBe(1);
  });

  test("successful reconnect resets retry counter", async () => {
    const fakes: FakeWs[] = [];
    let connectCount = 0;
    const src = new BinanceSource({
      logger: silent,
      wsUrl: "ws://127.0.0.1:1",
      wsConnect: () => { connectCount++; const ws = mkFakeWs(); fakes.push(ws); return ws; },
      wsRetryBaseMs: 20,
    });
    src.subscribeMarkPrice(() => { /* noop */ });
    expect(connectCount).toBe(1);

    // First close → 1st backoff = base (20ms). Sleep > base so retry fires.
    fakes[0]!.fireClose();
    await sleep(40);
    expect(connectCount).toBe(2);

    // Successful open resets counter.
    fakes[1]!.fireOpen();

    // Second close → should ALSO be base delay (20ms), NOT doubled to 40ms.
    // Proof: sleep 30ms is > base (20ms) but < doubled (40ms). A reconnect
    // within that window can only mean base delay was used. Avoids asserting
    // raw wall-clock elapsed, which gets flaky under full-suite CPU load.
    fakes[1]!.fireClose();
    await sleep(30);
    expect(connectCount).toBe(3);

    src.shutdown();
  });
});

/** Minimal in-memory WebSocket stand-in. Tests drive frames via src.handleWsMessage. */
function mkFakeWs(onClose: () => void = () => { /* noop */ }): FakeWs {
  const listeners: Record<string, ((ev: unknown) => void)[]> = {};
  const ws = {
    addEventListener: (type: string, cb: (ev: unknown) => void) => {
      (listeners[type] ??= []).push(cb);
    },
    close: () => { onClose(); },
  } as unknown as WebSocket;
  const handle = ws as FakeWs;
  handle.fireClose = () => { listeners.close?.forEach((cb) => cb({})); };
  handle.fireOpen = () => { listeners.open?.forEach((cb) => cb({})); };
  return handle;
}

type FakeWs = WebSocket & {
  fireClose: () => void;
  fireOpen: () => void;
};
