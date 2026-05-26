/**
 * Unit tests for symbol-mapping — Binance → HL translation table.
 *
 * Covers:
 *   - Structural integrity of the mapping table (every entry valid).
 *   - Direct lookups for representative major + k-prefix entries.
 *   - Case-sensitivity (exact match only).
 *   - Empty / unmapped / null-ish inputs.
 *   - Price-multiplier semantics: kX entries scale 1000× correctly.
 */

import { describe, test, expect } from "bun:test";
import {
  BINANCE_TO_HL,
  mapBinanceSymbol,
} from "../../../src/services/price-feed/symbol-mapping.js";

describe("symbol-mapping: BINANCE_TO_HL table integrity", () => {
  test("every entry has a non-empty hlSymbol", () => {
    for (const [binance, mapping] of Object.entries(BINANCE_TO_HL)) {
      expect(typeof mapping.hlSymbol).toBe("string");
      expect(mapping.hlSymbol.length).toBeGreaterThan(0);
      expect(mapping.hlSymbol).not.toContain(" ");
      // Sanity: Binance keys follow XUSDT convention in practice.
      expect(binance).toMatch(/USDT$/);
    }
  });

  test("every entry has a positive finite multiplier", () => {
    for (const [, mapping] of Object.entries(BINANCE_TO_HL)) {
      expect(Number.isFinite(mapping.multiplier)).toBe(true);
      expect(mapping.multiplier).toBeGreaterThan(0);
    }
  });

  test("k-prefix HL symbols all use the 1000× multiplier", () => {
    for (const [, mapping] of Object.entries(BINANCE_TO_HL)) {
      if (mapping.hlSymbol.startsWith("k")) {
        // Convention: kX on HL means 1000× of the underlying base.
        expect(mapping.multiplier).toBe(1000);
      }
    }
  });

  test("1000-prefix HL symbols all use the 1000× multiplier", () => {
    for (const [, mapping] of Object.entries(BINANCE_TO_HL)) {
      if (/^1000/.test(mapping.hlSymbol)) {
        expect(mapping.multiplier).toBe(1000);
      }
    }
  });

  test("non-k / non-1000 entries use multiplier 1", () => {
    for (const [, mapping] of Object.entries(BINANCE_TO_HL)) {
      const isScaled = mapping.hlSymbol.startsWith("k") || /^1000/.test(mapping.hlSymbol);
      if (!isScaled) expect(mapping.multiplier).toBe(1);
    }
  });

  test("no duplicate hlSymbol targets (every Binance symbol maps to a unique HL perp)", () => {
    const seen = new Set<string>();
    for (const [, mapping] of Object.entries(BINANCE_TO_HL)) {
      expect(seen.has(mapping.hlSymbol)).toBe(false);
      seen.add(mapping.hlSymbol);
    }
  });
});

describe("mapBinanceSymbol", () => {
  test("BTCUSDT → { BTC, 1 }", () => {
    expect(mapBinanceSymbol("BTCUSDT")).toEqual({ hlSymbol: "BTC", multiplier: 1 });
  });

  test("ETHUSDT → { ETH, 1 }", () => {
    expect(mapBinanceSymbol("ETHUSDT")).toEqual({ hlSymbol: "ETH", multiplier: 1 });
  });

  test("PEPEUSDT → { kPEPE, 1000 }", () => {
    expect(mapBinanceSymbol("PEPEUSDT")).toEqual({ hlSymbol: "kPEPE", multiplier: 1000 });
  });

  test("SHIBUSDT → { kSHIB, 1000 }", () => {
    expect(mapBinanceSymbol("SHIBUSDT")).toEqual({ hlSymbol: "kSHIB", multiplier: 1000 });
  });

  test("BONKUSDT → { kBONK, 1000 }", () => {
    expect(mapBinanceSymbol("BONKUSDT")).toEqual({ hlSymbol: "kBONK", multiplier: 1000 });
  });

  test("LUNCUSDT → { kLUNC, 1000 }", () => {
    // Round-2 CR caught this missing — LUNC (LUNA Classic) is on both
    // Binance spot and HL but HL wraps it as kLUNC × 1000, so the mapping
    // has to carry the 1000× multiplier or prices render at 1/1000 scale.
    expect(mapBinanceSymbol("LUNCUSDT")).toEqual({ hlSymbol: "kLUNC", multiplier: 1000 });
  });

  test("representative newly-added majors round-trip correctly", () => {
    // Spot-check a handful of the popular perps added in round 2. Direct
    // (×1) pairs — the drift detector covers the full set; these keep the
    // explicit contract visible in the test file for quick reference.
    expect(mapBinanceSymbol("BNBUSDT")).toEqual({ hlSymbol: "BNB", multiplier: 1 });
    expect(mapBinanceSymbol("TONUSDT")).toEqual({ hlSymbol: "TON", multiplier: 1 });
    expect(mapBinanceSymbol("ORDIUSDT")).toEqual({ hlSymbol: "ORDI", multiplier: 1 });
    expect(mapBinanceSymbol("TAOUSDT")).toEqual({ hlSymbol: "TAO", multiplier: 1 });
    expect(mapBinanceSymbol("PENDLEUSDT")).toEqual({ hlSymbol: "PENDLE", multiplier: 1 });
    expect(mapBinanceSymbol("EIGENUSDT")).toEqual({ hlSymbol: "EIGEN", multiplier: 1 });
    expect(mapBinanceSymbol("TURBOUSDT")).toEqual({ hlSymbol: "TURBO", multiplier: 1 });
    expect(mapBinanceSymbol("BOMEUSDT")).toEqual({ hlSymbol: "BOME", multiplier: 1 });
    expect(mapBinanceSymbol("MEWUSDT")).toEqual({ hlSymbol: "MEW", multiplier: 1 });
    expect(mapBinanceSymbol("XMRUSDT")).toEqual({ hlSymbol: "XMR", multiplier: 1 });
    expect(mapBinanceSymbol("ZROUSDT")).toEqual({ hlSymbol: "ZRO", multiplier: 1 });
    expect(mapBinanceSymbol("ETHFIUSDT")).toEqual({ hlSymbol: "ETHFI", multiplier: 1 });
    expect(mapBinanceSymbol("BERAUSDT")).toEqual({ hlSymbol: "BERA", multiplier: 1 });
  });

  test("unmapped symbol (XYZUSDT) → null", () => {
    expect(mapBinanceSymbol("XYZUSDT")).toBeNull();
  });

  test("empty string → null", () => {
    expect(mapBinanceSymbol("")).toBeNull();
  });

  test("lowercase input → null (exact-match lookup, no case folding)", () => {
    // Binance emits upper-case in miniTicker. Lowercase doesn't match any
    // hand-curated entry — masking case bugs is caller's concern.
    expect(mapBinanceSymbol("btcusdt")).toBeNull();
    expect(mapBinanceSymbol("BtcUsdt")).toBeNull();
  });

  test("non-USDT / leveraged / stable inputs all return null", () => {
    expect(mapBinanceSymbol("ETHBTC")).toBeNull();
    expect(mapBinanceSymbol("USDCUSDT")).toBeNull();
    expect(mapBinanceSymbol("BTCUPUSDT")).toBeNull();
  });
});

/**
 * Snapshot of the live HL perp universe at the time of this commit
 * (2026-04-20), filtered to `isDelisted != true`. This is the reference set
 * the mapping table is maintained against.
 *
 * The drift-detector test below compares every `hlSymbol` we map to against
 * this snapshot — when HL adds, renames, or delists a symbol the test will
 * guide the Dev to refresh the snapshot (via the curl one-liner in the
 * symbol-mapping.ts header) at the same time they touch the mapping table.
 *
 * This catches the "someone added a mapping with a typo / wrong multiplier
 * / stale HL name" class of bug before it ships.
 */
const HL_UNIVERSE_SNAPSHOT = new Set<string>([
  "0G", "2Z", "AAVE", "ACE", "ADA", "AERO", "AIXBT", "ALGO", "ALT", "ANIME",
  "APE", "APEX", "APT", "AR", "ARB", "ARK", "ASTER", "ATOM", "AVAX", "AVNT",
  "AXS", "AZTEC", "BABY", "BANANA", "BCH", "BERA", "BIGTIME", "BIO", "BLAST",
  "BLUR", "BNB", "BOME", "BRETT", "BSV", "BTC", "CAKE", "CC", "CELO", "CFX",
  "CHILLGUY", "CHIP", "COMP", "CRV", "DASH", "DOGE", "DOOD", "DOT", "DYDX",
  "DYM", "EIGEN", "ENA", "ENS", "ETC", "ETH", "ETHFI", "FARTCOIN", "FET",
  "FIL", "FOGO", "FTT", "GALA", "GAS", "GMT", "GMX", "GOAT", "GRASS",
  "GRIFFAIN", "HBAR", "HEMI", "HMSTR", "HYPE", "HYPER", "ICP", "IMX", "INIT",
  "INJ", "IO", "IOTA", "IP", "JTO", "JUP", "KAITO", "KAS", "LAYER", "LDO",
  "LINEA", "LINK", "LIT", "LTC", "MANTA", "MAV", "MAVIA", "ME", "MEGA",
  "MELANIA", "MEME", "MERL", "MET", "MEW", "MINA", "MNT", "MON", "MOODENG",
  "MORPHO", "MOVE", "NEAR", "NEO", "NIL", "NOT", "NXPC", "ONDO", "OP", "ORDI",
  "PAXG", "PENDLE", "PENGU", "PEOPLE", "PNUT", "POL", "POLYX", "POPCAT",
  "PROMPT", "PROVE", "PUMP", "PURR", "PYTH", "RENDER", "RESOLV", "REZ", "RSR",
  "RUNE", "S", "SAGA", "SAND", "SCR", "SEI", "SKR", "SKY", "SNX", "SOL",
  "SOPH", "SPX", "STABLE", "STBL", "STRK", "STX", "SUI", "SUPER", "SUSHI",
  "SYRUP", "TAO", "TIA", "TNSR", "TON", "TRB", "TRUMP", "TRX", "TST", "TURBO",
  "UMA", "UNI", "USTC", "USUAL", "VINE", "VIRTUAL", "VVV", "W", "WCT", "WIF",
  "WLD", "WLFI", "XAI", "XLM", "XMR", "XPL", "XRP", "YGG", "YZY", "ZEC",
  "ZEN", "ZEREBRO", "ZETA", "ZK", "ZORA", "ZRO",
  "kBONK", "kFLOKI", "kLUNC", "kNEIRO", "kPEPE", "kSHIB",
]);

describe("symbol-mapping: drift detector vs HL universe snapshot", () => {
  test("every mapped hlSymbol exists in the reference HL universe snapshot", () => {
    // When HL delists or renames a perp, the mapping entry becomes dead
    // code and should be removed. When this test fails, either remove the
    // offending entry or refresh HL_UNIVERSE_SNAPSHOT using the curl
    // one-liner in src/services/price-feed/symbol-mapping.ts.
    const offenders: string[] = [];
    for (const [binance, mapping] of Object.entries(BINANCE_TO_HL)) {
      if (!HL_UNIVERSE_SNAPSHOT.has(mapping.hlSymbol)) {
        offenders.push(`${binance} → ${mapping.hlSymbol}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("snapshot itself is self-consistent (size + shape)", () => {
    // Guardrail: prevent accidental snapshot destruction in diffs.
    expect(HL_UNIVERSE_SNAPSHOT.size).toBeGreaterThan(150);
    for (const name of HL_UNIVERSE_SNAPSHOT) {
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
      expect(name).not.toContain(" ");
    }
  });
});

describe("mapBinanceSymbol: price-scaling arithmetic", () => {
  test("PEPE $0.00002 on Binance → kPEPE $0.02 on HL (1000×)", () => {
    const m = mapBinanceSymbol("PEPEUSDT")!;
    const hlPrice = 0.00002 * m.multiplier;
    // 0.00002 * 1000 = 0.02 — but JS arithmetic yields 0.019999... so compare
    // with a relative tolerance instead of strict equality.
    expect(hlPrice).toBeCloseTo(0.02, 10);
  });

  test("SHIB $0.0000085 on Binance → kSHIB $0.0085 on HL (1000×)", () => {
    const m = mapBinanceSymbol("SHIBUSDT")!;
    expect(0.0000085 * m.multiplier).toBeCloseTo(0.0085, 10);
  });

  test("BTC $60000 on Binance → BTC $60000 on HL (1×)", () => {
    const m = mapBinanceSymbol("BTCUSDT")!;
    expect(60000 * m.multiplier).toBe(60000);
  });
});
