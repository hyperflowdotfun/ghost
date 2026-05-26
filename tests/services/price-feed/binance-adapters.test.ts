import { describe, test, expect } from "bun:test";
import pino from "pino";
import { BinanceSource } from "../../../src/services/price-feed/sources/binance.js";
import {
  asMarkPriceSource,
  asMiniTickerSource,
} from "../../../src/services/price-feed/sources/binance.js";

const silent = pino({ level: "silent" });

function mkFakeWs(): WebSocket {
  return {
    addEventListener: () => { /* noop */ },
    close: () => { /* noop */ },
  } as unknown as WebSocket;
}

describe("asMarkPriceSource", () => {
  test("identity (name='binance', priority=1)", () => {
    const src = new BinanceSource({ logger: silent, wsUrl: "ws://_", wsConnect: () => mkFakeWs() });
    const adapter = asMarkPriceSource(src);
    expect(adapter.name).toBe("binance");
    expect(adapter.priority).toBe(1);
  });

  test("start() subscribes; mark frame reaches downstream (HL-canonical)", async () => {
    const src = new BinanceSource({ logger: silent, wsUrl: "ws://_", wsConnect: () => mkFakeWs() });
    const received: Array<[string, number, number | undefined]> = [];
    const adapter = asMarkPriceSource(src);
    await adapter.start((sym, price, prev) => received.push([sym, price, prev]));
    src.handleWsMessage(JSON.stringify({
      stream: "!markPrice@arr@1s",
      data: [{ s: "BTCUSDT", p: "60000" }],
    }));
    expect(received).toEqual([["BTC", 60000, undefined]]);
    await adapter.stop();
  });

  test("stop() unsubscribes — no further ticks reach downstream", async () => {
    const src = new BinanceSource({ logger: silent, wsUrl: "ws://_", wsConnect: () => mkFakeWs() });
    const received: string[] = [];
    const adapter = asMarkPriceSource(src);
    await adapter.start((sym) => received.push(sym));
    await adapter.stop();
    src.handleWsMessage(JSON.stringify({
      stream: "!markPrice@arr@1s",
      data: [{ s: "BTCUSDT", p: "60000" }],
    }));
    expect(received).toEqual([]);
  });

  test("getLastTickAt() reflects mark stream only", () => {
    const src = new BinanceSource({ logger: silent, wsUrl: "ws://_", wsConnect: () => mkFakeWs() });
    const adapter = asMarkPriceSource(src);
    void adapter.start(() => { /* noop */ });
    src.handleWsMessage(JSON.stringify({
      stream: "!miniTicker@arr",
      data: [{ s: "BTCUSDT", c: "60100", o: "59000" }],
    }));
    expect(adapter.getLastTickAt()).toBe(0); // mini ticked, mark didn't
    src.handleWsMessage(JSON.stringify({
      stream: "!markPrice@arr@1s",
      data: [{ s: "BTCUSDT", p: "60000" }],
    }));
    expect(adapter.getLastTickAt()).toBeGreaterThan(0);
  });
});

describe("asMiniTickerSource", () => {
  test("start() subscribes; miniTicker frame reaches downstream with prevDay", async () => {
    const src = new BinanceSource({ logger: silent, wsUrl: "ws://_", wsConnect: () => mkFakeWs() });
    const received: Array<[string, number, number | undefined]> = [];
    const adapter = asMiniTickerSource(src);
    await adapter.start((sym, price, prev) => received.push([sym, price, prev]));
    src.handleWsMessage(JSON.stringify({
      stream: "!miniTicker@arr",
      data: [{ s: "BTCUSDT", c: "60100", o: "59000" }],
    }));
    expect(received).toEqual([["BTCUSDT", 60100, 59000]]);
    await adapter.stop();
  });

  test("getLastTickAt() reflects mini stream only", () => {
    const src = new BinanceSource({ logger: silent, wsUrl: "ws://_", wsConnect: () => mkFakeWs() });
    const adapter = asMiniTickerSource(src);
    void adapter.start(() => { /* noop */ });
    src.handleWsMessage(JSON.stringify({
      stream: "!markPrice@arr@1s",
      data: [{ s: "BTCUSDT", p: "60000" }],
    }));
    expect(adapter.getLastTickAt()).toBe(0); // mark ticked, mini didn't
    src.handleWsMessage(JSON.stringify({
      stream: "!miniTicker@arr",
      data: [{ s: "BTCUSDT", c: "60100", o: "59000" }],
    }));
    expect(adapter.getLastTickAt()).toBeGreaterThan(0);
  });
});

describe("BinanceSource refcount via adapters", () => {
  test("two adapters share one WS; both must stop before WS closes", async () => {
    let openCount = 0;
    let closeCount = 0;
    const src = new BinanceSource({
      logger: silent,
      wsUrl: "ws://_",
      wsConnect: () => {
        openCount++;
        return {
          addEventListener: () => { /* noop */ },
          close: () => { closeCount++; },
        } as unknown as WebSocket;
      },
    });
    const mark = asMarkPriceSource(src);
    const mini = asMiniTickerSource(src);
    await mark.start(() => { /* noop */ });
    await mini.start(() => { /* noop */ });
    expect(openCount).toBe(1);
    await mark.stop();
    expect(closeCount).toBe(0);
    await mini.stop();
    expect(closeCount).toBe(1);
  });
});
