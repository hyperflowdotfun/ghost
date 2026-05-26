/**
 * Unit tests for HyperliquidClient HIP-3 universe merge:
 * ensureMeta, getAllTickers, getTicker, resolveSymbol.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { HyperliquidClient } from "../../src/services/live/client";

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => noopLogger,
} as any;

// ─── Fixtures ───

const NATIVE_META = {
  universe: [
    { name: "BTC", szDecimals: 5 },
    { name: "ETH", szDecimals: 4 },
  ],
};

const XYZ_META = {
  universe: [
    { name: "xyz:AAPL", szDecimals: 2 },
    { name: "xyz:TSLA", szDecimals: 2 },
  ],
};

const FLX_META = {
  universe: [
    { name: "flx:GOLD", szDecimals: 3 },
  ],
};

const NATIVE_CTXS = [
  { markPx: "100000", midPx: "99990", oraclePx: "99995", dayNtlVlm: "1000000", prevDayPx: "99000", openInterest: "500", funding: "0.0001" },
  { markPx: "3000", midPx: "2999", oraclePx: "2998", dayNtlVlm: "500000", prevDayPx: "2950", openInterest: "1000", funding: "0.00005" },
];

const XYZ_CTXS = [
  { markPx: "180", midPx: "179.5", oraclePx: "179", dayNtlVlm: "2000", prevDayPx: "175", openInterest: "100", funding: "0.00002" },
  { markPx: "210", midPx: "209", oraclePx: "208", dayNtlVlm: "3000", prevDayPx: "200", openInterest: "80", funding: "0.00003" },
];

const FLX_CTXS = [
  { markPx: "2100", midPx: "2099", oraclePx: "2098", dayNtlVlm: "500", prevDayPx: "2050", openInterest: "30", funding: "0.00001" },
];

/** Build a client whose info() is fully controlled by the provided map. */
function makeClient(
  infoMap: Record<string, unknown> = {},
  infoHandler?: (type: string, extra: Record<string, unknown>) => unknown,
): HyperliquidClient {
  const client = new HyperliquidClient(undefined, noopLogger);
  (client as any).info = async (type: string, extra: Record<string, unknown> = {}) => {
    if (infoHandler) {
      const result = infoHandler(type, extra);
      if (result !== undefined) return result;
    }
    const key = extra.dex !== undefined ? `${type}:${extra.dex}` : type;
    if (key in infoMap) return infoMap[key];
    throw new Error(`Unexpected info call: type=${type} dex=${extra.dex}`);
  };
  return client;
}

/** Build the standard 3-dex info map used by most tests. */
function threeUniverse(): HyperliquidClient {
  return makeClient({
    "perpDexs": [null, { name: "xyz", fullName: "XYZ", deployer: "0xabc" }, { name: "flx", fullName: "FLX", deployer: "0xdef" }],
    "meta": NATIVE_META,
    "meta:xyz": XYZ_META,
    "meta:flx": FLX_META,
    "metaAndAssetCtxs": [NATIVE_META, NATIVE_CTXS],
    "metaAndAssetCtxs:xyz": [XYZ_META, XYZ_CTXS],
    "metaAndAssetCtxs:flx": [FLX_META, FLX_CTXS],
  });
}

// ─── ensureMeta ───

describe("HyperliquidClient.ensureMeta — HIP-3 merge", () => {
  it("merges native + 2 dex universes into assetNames", async () => {
    const client = threeUniverse();
    await (client as any).ensureMeta();

    const names: string[] = (client as any).assetNames;
    expect(names).toContain("BTC");
    expect(names).toContain("ETH");
    expect(names).toContain("xyz:AAPL");
    expect(names).toContain("xyz:TSLA");
    expect(names).toContain("flx:GOLD");
    expect(names).toHaveLength(5);
  });

  it("populates assetMap with resolveSymbol-canonical keys for all symbols", async () => {
    const client = threeUniverse();
    await (client as any).ensureMeta();

    const map: Map<string, number> = (client as any).assetMap;
    // Native — resolveSymbol("BTC") = "BTC"
    expect(map.has("BTC")).toBe(true);
    expect(map.has("ETH")).toBe(true);
    // HIP-3 — resolveSymbol("xyz:AAPL") = "xyz:AAPL" (lowercase dex prefix, NOT "XYZ:AAPL")
    expect(map.has("xyz:AAPL")).toBe(true);
    expect(map.has("xyz:TSLA")).toBe(true);
    expect(map.has("flx:GOLD")).toBe(true);
    // Legacy uppercase form must NOT be present (that was the bug)
    expect(map.has("XYZ:AAPL")).toBe(false);
  });

  it("stores per-dex universes in dexUniverses map", async () => {
    const client = threeUniverse();
    await (client as any).ensureMeta();

    const dexU: Map<string, string[]> = (client as any).dexUniverses;
    expect(dexU.get("")).toEqual(["BTC", "ETH"]);
    expect(dexU.get("xyz")).toEqual(["xyz:AAPL", "xyz:TSLA"]);
    expect(dexU.get("flx")).toEqual(["flx:GOLD"]);
  });

  it("skips failed dex but still merges the rest", async () => {
    // flx meta throws; xyz should still be merged
    let callCount = 0;
    const client = makeClient({}, (type, extra) => {
      if (type === "perpDexs") return [null, { name: "xyz", fullName: "XYZ", deployer: "0xabc" }, { name: "flx", fullName: "FLX", deployer: "0xdef" }];
      if (type === "meta" && !extra.dex) return NATIVE_META;
      if (type === "meta" && extra.dex === "xyz") return XYZ_META;
      if (type === "meta" && extra.dex === "flx") throw new Error("flx meta unavailable");
    });

    await (client as any).ensureMeta();

    const names: string[] = (client as any).assetNames;
    expect(names).toContain("BTC");
    expect(names).toContain("xyz:AAPL");
    // flx was skipped due to error
    expect(names).not.toContain("flx:GOLD");
  });

  it("is idempotent — subsequent calls do not reload", async () => {
    let metaCallCount = 0;
    const client = makeClient({}, (type, extra) => {
      if (type === "perpDexs") return [null, { name: "xyz", fullName: "XYZ", deployer: "0xabc" }];
      if (type === "meta" && !extra.dex) { metaCallCount++; return NATIVE_META; }
      if (type === "meta" && extra.dex === "xyz") return XYZ_META;
    });

    await (client as any).ensureMeta();
    await (client as any).ensureMeta();

    expect(metaCallCount).toBe(1);
  });
});

// ─── getAllTickers ───

describe("HyperliquidClient.getAllTickers", () => {
  it("returns tickers from native + all HIP-3 dexes", async () => {
    const client = threeUniverse();
    const tickers = await client.getAllTickers();

    const symbols = tickers.map((t) => t.symbol);
    expect(symbols).toContain("BTC");
    expect(symbols).toContain("ETH");
    expect(symbols).toContain("xyz:AAPL");
    expect(symbols).toContain("xyz:TSLA");
    expect(symbols).toContain("flx:GOLD");
    expect(tickers).toHaveLength(5);
  });

  it("skips a dex whose ctxs fetch fails but includes the rest", async () => {
    const client = makeClient({}, (type, extra) => {
      if (type === "perpDexs") return [null, { name: "xyz", fullName: "XYZ", deployer: "0xabc" }, { name: "flx", fullName: "FLX", deployer: "0xdef" }];
      if (type === "meta" && !extra.dex) return NATIVE_META;
      if (type === "meta" && extra.dex === "xyz") return XYZ_META;
      if (type === "meta" && extra.dex === "flx") return FLX_META;
      if (type === "metaAndAssetCtxs" && !extra.dex) return [NATIVE_META, NATIVE_CTXS];
      if (type === "metaAndAssetCtxs" && extra.dex === "xyz") return [XYZ_META, XYZ_CTXS];
      if (type === "metaAndAssetCtxs" && extra.dex === "flx") throw new Error("flx ctxs unavailable");
    });

    const tickers = await client.getAllTickers();
    const symbols = tickers.map((t) => t.symbol);

    expect(symbols).toContain("BTC");
    expect(symbols).toContain("xyz:AAPL");
    expect(symbols).not.toContain("flx:GOLD");
    // native(2) + xyz(2) = 4
    expect(tickers).toHaveLength(4);
  });

  it("maps markPrice correctly for HIP-3 ticker", async () => {
    const client = threeUniverse();
    const tickers = await client.getAllTickers();
    const aapl = tickers.find((t) => t.symbol === "xyz:AAPL");

    expect(aapl).toBeDefined();
    expect(aapl!.markPrice).toBe(180);
    expect(aapl!.fundingRate).toBeCloseTo(0.00002);
  });
});

// ─── getTicker (HIP-3 routing) ───

describe("HyperliquidClient.getTicker", () => {
  it("routes xyz:AAPL to metaAndAssetCtxs with dex=xyz", async () => {
    const capturedExtras: Record<string, unknown>[] = [];
    const client = makeClient({}, (type, extra) => {
      if (type === "perpDexs") return [null, { name: "xyz", fullName: "XYZ", deployer: "0xabc" }, { name: "flx", fullName: "FLX", deployer: "0xdef" }];
      if (type === "meta" && !extra.dex) return NATIVE_META;
      if (type === "meta" && extra.dex === "xyz") return XYZ_META;
      if (type === "meta" && extra.dex === "flx") return FLX_META;
      if (type === "metaAndAssetCtxs") {
        capturedExtras.push({ ...extra });
        if (!extra.dex) return [NATIVE_META, NATIVE_CTXS];
        if (extra.dex === "xyz") return [XYZ_META, XYZ_CTXS];
        if (extra.dex === "flx") return [FLX_META, FLX_CTXS];
      }
    });

    await client.getTicker("xyz:AAPL");

    const dexCall = capturedExtras.find((e) => e.dex === "xyz");
    expect(dexCall).toBeDefined();
  });

  it("returns correct ticker data for xyz:AAPL", async () => {
    const client = threeUniverse();
    const ticker = await client.getTicker("xyz:AAPL");

    expect(ticker.symbol).toBe("xyz:AAPL");
    expect(ticker.markPrice).toBe(180);
  });

  it("routes BTC to native metaAndAssetCtxs (no dex param)", async () => {
    const capturedExtras: Record<string, unknown>[] = [];
    const client = makeClient({}, (type, extra) => {
      if (type === "perpDexs") return [null, { name: "xyz", fullName: "XYZ", deployer: "0xabc" }];
      if (type === "meta" && !extra.dex) return NATIVE_META;
      if (type === "meta" && extra.dex === "xyz") return XYZ_META;
      if (type === "metaAndAssetCtxs") {
        capturedExtras.push({ ...extra });
        if (!extra.dex) return [NATIVE_META, NATIVE_CTXS];
        if (extra.dex === "xyz") return [XYZ_META, XYZ_CTXS];
      }
    });

    await client.getTicker("BTC");

    // The call for BTC should have no dex property
    const btcCall = capturedExtras.find((e) => !e.dex);
    expect(btcCall).toBeDefined();
  });

  it("throws for unknown symbol", async () => {
    const client = threeUniverse();
    await expect(client.getTicker("xyz:UNKNOWN999")).rejects.toThrow();
  });
});

// ─── resolveSymbol ───

describe("HyperliquidClient.resolveSymbol", () => {
  const client = new HyperliquidClient(undefined, noopLogger);

  it("uppercases native symbol", () => {
    expect(client.resolveSymbol("btc")).toBe("BTC");
  });

  it("strips USDT suffix from native symbol", () => {
    expect(client.resolveSymbol("BTC-USDT")).toBe("BTC");
    expect(client.resolveSymbol("ETHUSDT")).toBe("ETH");
  });

  it("keeps dex prefix lowercase for HIP-3 symbol", () => {
    // HL dex param is case-sensitive: uppercase dex name returns null from the API.
    expect(client.resolveSymbol("xyz:AAPL")).toBe("xyz:AAPL");
    expect(client.resolveSymbol("XYZ:AAPL")).toBe("xyz:AAPL");
  });

  it("uppercases the asset part of HIP-3 symbol", () => {
    expect(client.resolveSymbol("xyz:aapl")).toBe("xyz:AAPL");
    expect(client.resolveSymbol("XYZ:aapl")).toBe("xyz:AAPL");
  });

  it("handles mixed-case dex prefix", () => {
    expect(client.resolveSymbol("Flx:Gold")).toBe("flx:GOLD");
  });

  it("strips USDT suffix from HIP-3 symbol asset part", () => {
    // Unlikely in practice but the rule should apply consistently
    expect(client.resolveSymbol("xyz:AAPLUSDT")).toBe("xyz:AAPL");
  });

  it("is idempotent — calling twice produces the same string", () => {
    const inputs = ["BTC", "xyz:AAPL", "XYZ:AAPL", "flx:GOLD", "btc-usdt", "xyz:aapl", "kPEPE", "KPEPE"];
    for (const input of inputs) {
      const once = client.resolveSymbol(input);
      expect(client.resolveSymbol(once)).toBe(once);
    }
  });

  it("preserves lowercase k for HL k-prefix tokens (kPEPE, kBONK, ...)", () => {
    // HL canonical names use lowercase `k` prefix for 1000-unit normalized perps.
    expect(client.resolveSymbol("kPEPE")).toBe("kPEPE");
    expect(client.resolveSymbol("KPEPE")).toBe("kPEPE");
    expect(client.resolveSymbol("kpepe")).toBe("kPEPE");
    expect(client.resolveSymbol("kBONK")).toBe("kBONK");
    expect(client.resolveSymbol("kSHIB")).toBe("kSHIB");
    expect(client.resolveSymbol("kFLOKI")).toBe("kFLOKI");
    expect(client.resolveSymbol("kNEIRO")).toBe("kNEIRO");
    expect(client.resolveSymbol("kLUNC")).toBe("kLUNC");
  });

  it("does NOT mangle non-k-prefix tokens that happen to start with K (e.g. KAITO)", () => {
    expect(client.resolveSymbol("KAITO")).toBe("KAITO");
    expect(client.resolveSymbol("kaito")).toBe("KAITO");
  });
});

// ─── getAssetIndex with HIP-3 ───

describe("HyperliquidClient.getAssetIndex — HIP-3", () => {
  it("returns merged index for xyz:AAPL", async () => {
    const client = threeUniverse();
    // After ensureMeta: BTC=0, ETH=1, xyz:AAPL=2, xyz:TSLA=3, flx:GOLD=4
    const idx = await client.getAssetIndex("xyz:AAPL");
    expect(idx).toBe(2);
  });

  it("resolves XYZ:AAPL (uppercase dex) identically to xyz:AAPL", async () => {
    const client = threeUniverse();
    const lowerIdx = await client.getAssetIndex("xyz:AAPL");
    const upperIdx = await client.getAssetIndex("XYZ:AAPL");
    expect(upperIdx).toBe(lowerIdx);
  });

  it("returns correct index for native BTC", async () => {
    const client = threeUniverse();
    const idx = await client.getAssetIndex("BTC");
    expect(idx).toBe(0);
  });

  it("throws for unknown HIP-3 symbol", async () => {
    const client = threeUniverse();
    await expect(client.getAssetIndex("xyz:UNKNOWN999")).rejects.toThrow();
  });
});

// ─── roundSize with HIP-3 ───

describe("HyperliquidClient.roundSize — HIP-3", () => {
  it("rounds xyz:AAPL using dex szDecimals (2)", async () => {
    const client = threeUniverse();
    await (client as any).ensureMeta();
    // xyz:AAPL has szDecimals: 2
    const result = (client as any).roundSize("xyz:AAPL", 1.234567);
    expect(result).toBe("1.23");
  });

  it("rounds XYZ:AAPL (uppercase dex) same as xyz:AAPL", async () => {
    const client = threeUniverse();
    await (client as any).ensureMeta();
    const lower = (client as any).roundSize("xyz:AAPL", 1.234567);
    const upper = (client as any).roundSize("XYZ:AAPL", 1.234567);
    expect(upper).toBe(lower);
  });

  it("rounds native BTC using native szDecimals (5)", async () => {
    const client = threeUniverse();
    await (client as any).ensureMeta();
    const result = (client as any).roundSize("BTC", 0.123456789);
    expect(result).toBe("0.12346");
  });
});

// ─── listPerpDexes — edge cases ───

describe("HyperliquidClient.listPerpDexes — edge cases", () => {
  it("returns [] when info returns null", async () => {
    const client = makeClient({}, (type) => {
      if (type === "perpDexs") return null;
    });
    const result = await client.listPerpDexes(true);
    expect(result).toEqual([]);
  });

  it("returns [] when info returns plain object", async () => {
    const client = makeClient({}, (type) => {
      if (type === "perpDexs") return {};
    });
    const result = await client.listPerpDexes(true);
    expect(result).toEqual([]);
  });

  it("filters null entries from valid array", async () => {
    const client = makeClient({}, (type) => {
      if (type === "perpDexs") return [null, { name: "xyz", fullName: "XYZ", deployer: "0xabc" }, null];
    });
    const result = await client.listPerpDexes(true);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("xyz");
  });
});

// ─── parseDex edge cases ───

describe("parseDex — edge cases", () => {
  // parseDex is not exported; exercise via resolveSymbol which calls it.
  const client = new HyperliquidClient(undefined, noopLogger);

  it("handles whitespace-padded symbol", () => {
    // trim() is applied; " xyz:AAPL " should resolve like "xyz:AAPL"
    expect(client.resolveSymbol("  xyz:AAPL  ")).toBe("xyz:AAPL");
  });

  it("treats ':AAPL' (empty dex prefix) as native lookup", () => {
    // Empty dex → treated as native → uppercase whole thing
    expect(client.resolveSymbol(":AAPL")).toBe(":AAPL");
  });

  it("treats 'xyz:' (empty asset) as native lookup", () => {
    expect(client.resolveSymbol("xyz:")).toBe("XYZ:");
  });
});
