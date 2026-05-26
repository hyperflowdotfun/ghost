import { describe, test, expect } from "bun:test";
import pino from "pino";
import { BinanceService } from "../../src/services/binance.js";

const silent = pino({ level: "silent" });

describe("BinanceService — universe", () => {
  test("exchangeInfo: only PERPETUAL + TRADING + USDT", async () => {
    const fakeFetch = async () =>
      new Response(JSON.stringify({
        symbols: [
          { symbol: "BTCUSDT", contractType: "PERPETUAL", status: "TRADING", quoteAsset: "USDT" },
          { symbol: "ETHUSDT", contractType: "PERPETUAL", status: "TRADING", quoteAsset: "USDT" },
          { symbol: "BTCUSDC", contractType: "PERPETUAL", status: "TRADING", quoteAsset: "USDC" },
          { symbol: "BTCUSDT_240628", contractType: "CURRENT_QUARTER", status: "TRADING", quoteAsset: "USDT" },
          { symbol: "OLDUSDT", contractType: "PERPETUAL", status: "BREAK", quoteAsset: "USDT" },
        ],
      }));
    const svc = new BinanceService({ logger: silent, fetchFn: fakeFetch });
    await svc.load();
    expect(svc.list().map((t) => t.symbol).sort()).toEqual(["BTCUSDT", "ETHUSDT"]);
    expect(svc.has("BTCUSDT")).toBe(true);
    expect(svc.has("DOGEUSDT")).toBe(false);
  });

  test("list() empty before refresh", () => {
    const svc = new BinanceService({ logger: silent, fetchFn: async () => new Response("{}") });
    expect(svc.list()).toEqual([]);
  });

  test("non-200 + network failure both swallowed; universe stays empty", async () => {
    const svc1 = new BinanceService({ logger: silent, fetchFn: async () => new Response("", { status: 503 }) });
    await svc1.load();
    expect(svc1.list()).toEqual([]);

    const svc2 = new BinanceService({
      logger: silent,
      fetchFn: async () => { throw new Error("network down"); },
    });
    await svc2.load();
    expect(svc2.list()).toEqual([]);
  });
});

describe("BinanceService — klines", () => {
  const row = (t: number, c: number) => [t, "1", "2", "0.5", String(c), "100", t + 60_000, "0", 0, "0", "0", "0"];

  test("getKlines parses native payload", async () => {
    const svc = new BinanceService({
      logger: silent,
      fetchFn: async () => new Response(JSON.stringify([row(1_700_000_000_000, 50_000), row(1_700_000_060_000, 50_100)])),
    });
    const out = await svc.getKlines("BTCUSDT", "1m", 2);
    expect(out).toEqual([
      { openTime: 1_700_000_000_000, open: 1, high: 2, low: 0.5, close: 50_000, volume: 100 },
      { openTime: 1_700_000_060_000, open: 1, high: 2, low: 0.5, close: 50_100, volume: 100 },
    ]);
  });

  test("getKlines throws on HTTP error", async () => {
    const svc = new BinanceService({
      logger: silent,
      fetchFn: async () => new Response("bad", { status: 400 }),
    });
    expect(svc.getKlines("BTCUSDT", "1m", 1)).rejects.toThrow(/Binance klines HTTP 400/);
  });
});
