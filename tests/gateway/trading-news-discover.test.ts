/**
 * Tests for the trading.news.sources.discover gateway method.
 *
 * Behaviour matrix:
 * - Returns `candidates` (mapped to { name, url, source }) when discovery yields results.
 * - Returns `{ candidates: [] }` when discovery finds nothing.
 * - Returns `{ ok: false }` with a helpful error when:
 *     - `rssDiscovery` is missing from deps,
 *     - the site is empty / whitespace,
 *     - the site exceeds 2048 chars,
 *     - the discover() call throws.
 */
import { describe, it, expect } from "bun:test";
import type { Logger } from "pino";
import { MethodRegistry, type MethodContext } from "../../src/gateway/method-registry.js";
import { registerTradingMethods } from "../../src/gateway/trading.js";
import type { RssDiscoveryService, RssCandidate } from "../../src/services/rss-discovery.js";

function makeCtx(): MethodContext {
  return { clientId: "c1", sessionId: "s1", broadcast: () => {}, emit: () => {} };
}

// Minimal logger stub typed through `Logger` (only the methods the code
// under test actually calls). Avoids `as any` per CLAUDE.md.
const noopLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  trace: () => {}, fatal: () => {}, silent: () => {},
  child: () => noopLogger,
} as unknown as Logger;

function makeRegistry(opts: { rssDiscovery?: Partial<RssDiscoveryService> | null } = {}) {
  const reg = new MethodRegistry();
  registerTradingMethods(reg.register.bind(reg), {
    tradingClient: {} as any,
    walletStore: {} as any,
    alertRules: {} as any,
    notifications: {} as any,
    newsService: {} as any,
    rssDiscovery: opts.rssDiscovery === null ? undefined : (opts.rssDiscovery as RssDiscoveryService | undefined),
    preferenceStore: {} as any,
    watchlist: {} as any,
    logger: noopLogger,
    tokensSnapshot: { build: () => ({ tokens: [], prices: {}, prevDayPrices: {}, maxLeverages: {} }) } as any,
    priceCache: { get: () => undefined, set: () => {} } as any,
    runner: { call: async () => "" } as any,
  });
  return reg;
}

describe("trading.news.sources.discover", () => {
  it("maps discover() output to { candidates: [{ name, url, source }] }", async () => {
    const sample: RssCandidate[] = [
      { url: "https://example.com/feed", title: "Example Feed", source: "html-link" },
      { url: "https://example.com/rss", title: "Example RSS", source: "well-known" },
    ];
    const reg = makeRegistry({ rssDiscovery: { discover: async () => sample } });
    const res = await reg.dispatch("trading.news.sources.discover", makeCtx(), { site: "https://example.com" }) as {
      candidates: { name: string; url: string; source: string }[];
    };
    expect(res.candidates).toEqual([
      { name: "Example Feed", url: "https://example.com/feed", source: "html-link" },
      { name: "Example RSS", url: "https://example.com/rss", source: "well-known" },
    ]);
  });

  it("returns empty candidates when discover() yields nothing", async () => {
    const reg = makeRegistry({ rssDiscovery: { discover: async () => [] } });
    const res = await reg.dispatch("trading.news.sources.discover", makeCtx(), { site: "https://nothing.example" }) as {
      candidates: unknown[];
    };
    expect(res.candidates).toEqual([]);
  });

  it("returns { ok: false } when rssDiscovery is not wired", async () => {
    const reg = makeRegistry({ rssDiscovery: null });
    const res = await reg.dispatch("trading.news.sources.discover", makeCtx(), { site: "https://example.com" }) as {
      ok: false; error: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unavailable/i);
  });

  it("rejects empty / whitespace site URLs", async () => {
    const reg = makeRegistry({ rssDiscovery: { discover: async () => [] } });
    const empty = await reg.dispatch("trading.news.sources.discover", makeCtx(), { site: "" }) as { ok: false; error: string };
    expect(empty.ok).toBe(false);
    const blank = await reg.dispatch("trading.news.sources.discover", makeCtx(), { site: "   " }) as { ok: false; error: string };
    expect(blank.ok).toBe(false);
  });

  it("rejects sites longer than 2048 chars", async () => {
    const reg = makeRegistry({ rssDiscovery: { discover: async () => [] } });
    const big = "https://x.example/" + "a".repeat(2100);
    const res = await reg.dispatch("trading.news.sources.discover", makeCtx(), { site: big }) as { ok: false; error: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/too long/i);
  });

  it("surfaces discover() errors as { ok: false, error } without leaking internal messages", async () => {
    const reg = makeRegistry({
      rssDiscovery: {
        discover: async () => { throw new Error("boom internal detail"); },
      },
    });
    const res = await reg.dispatch("trading.news.sources.discover", makeCtx(), { site: "https://example.com" }) as {
      ok: false; error: string;
    };
    expect(res.ok).toBe(false);
    // Should be a generic message, NOT the internal "boom internal detail" string.
    expect(res.error).toBe("Discovery failed");
    expect(res.error).not.toContain("boom");
  });
});
