/**
 * Regression: getBalance() must propagate transient RPC errors on the
 * spot / userAbstraction sub-calls instead of silently substituting empty
 * defaults. Swallowing 429 / network errors used to flip a unified account
 * to perp-only equity for that one fetch, producing the user-visible
 * "portfolio value momentarily drops then snaps back" symptom.
 */

import { describe, it, expect } from "bun:test";
import { HyperliquidClient } from "../../src/services/live/client";

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => noopLogger,
  // biome-ignore lint/suspicious/noExplicitAny: test stub
} as any;

const PERP_OK = {
  marginSummary: { accountValue: "812.34", totalMarginUsed: "0" },
  assetPositions: [],
};

const SPOT_OK = { balances: [{ coin: "USDC", total: "2009.00" }] };

function makeClient(
  fetchInfoImpl: (type: string, extra: Record<string, unknown>) => unknown,
): HyperliquidClient {
  const client = new HyperliquidClient(undefined, noopLogger);
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  (client as any).defaultAddress = "0x0000000000000000000000000000000000000001";
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  (client as any).fetchInfo = async (type: string, extra: Record<string, unknown>) => {
    return fetchInfoImpl(type, extra);
  };
  return client;
}

describe("HyperliquidClient.getBalance — transient RPC errors", () => {
  it("sums perp + spot for a unified account when all RPCs succeed", async () => {
    const client = makeClient((type) => {
      if (type === "clearinghouseState") return PERP_OK;
      if (type === "spotClearinghouseState") return SPOT_OK;
      if (type === "userAbstraction") return "unifiedAccount";
      throw new Error(`unexpected info type: ${type}`);
    });
    const bal = await client.getBalance();
    expect(bal.totalEquity).toBeCloseTo(812.34 + 2009.0, 2);
  });

  it("throws when userAbstraction RPC fails (instead of silently returning perp-only)", async () => {
    const client = makeClient((type) => {
      if (type === "clearinghouseState") return PERP_OK;
      if (type === "spotClearinghouseState") return SPOT_OK;
      if (type === "userAbstraction") throw new Error("HTTP 429 Too Many Requests");
      throw new Error(`unexpected info type: ${type}`);
    });
    await expect(client.getBalance()).rejects.toThrow(/429/);
  });

  it("throws when spotClearinghouseState RPC fails (instead of silently zeroing spot)", async () => {
    const client = makeClient((type) => {
      if (type === "clearinghouseState") return PERP_OK;
      if (type === "spotClearinghouseState") throw new Error("HTTP 429 Too Many Requests");
      if (type === "userAbstraction") return "unifiedAccount";
      throw new Error(`unexpected info type: ${type}`);
    });
    await expect(client.getBalance()).rejects.toThrow(/429/);
  });

  it("legitimate empty payloads still produce perp-only equity (non-unified)", async () => {
    const client = makeClient((type) => {
      if (type === "clearinghouseState") return PERP_OK;
      if (type === "spotClearinghouseState") return { balances: [] };
      if (type === "userAbstraction") return "default";
      throw new Error(`unexpected info type: ${type}`);
    });
    const bal = await client.getBalance();
    expect(bal.totalEquity).toBeCloseTo(812.34, 2);
  });
});
