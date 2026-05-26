import { describe, test, expect } from "bun:test";
import { formatSymbolDisplay } from "./symbol-utils";

describe("formatSymbolDisplay", () => {
  test("HL native: BTC → BTCUSDC, no chip", () => {
    expect(formatSymbolDisplay("BTC", "hyperliquid")).toEqual({
      chip: null,
      notation: "BTCUSDC",
    });
  });

  test("HL HIP-3: xyz:WTIOIL → chip XYZ + WTIOIL", () => {
    expect(formatSymbolDisplay("xyz:WTIOIL", "hyperliquid")).toEqual({
      chip: "XYZ",
      notation: "WTIOIL",
    });
  });

  test("Binance: BTCUSDT → BTCUSDT, no chip", () => {
    expect(formatSymbolDisplay("BTCUSDT", "binance")).toEqual({
      chip: null,
      notation: "BTCUSDT",
    });
  });

  test("Binance: PEPEUSDT → PEPEUSDT", () => {
    expect(formatSymbolDisplay("PEPEUSDT", "binance")).toEqual({
      chip: null,
      notation: "PEPEUSDT",
    });
  });
});
