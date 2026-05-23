/**
 * Tests for trading.news.summarize — the on-demand article summarize RPC.
 *
 * Three core paths:
 *   - Cache hit (existing summary): no LLM call, response marked cached.
 *   - Cache miss + body present: LLM is called, result is saved into the
 *     `summary` column.
 *   - No body: the RPC refuses to summarize rather than feeding the LLM an
 *     empty prompt.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { MethodRegistry, type MethodContext } from "../../src/gateway/method-registry.js";
import { registerTradingMethods } from "../../src/gateway/trading.js";
import { PreferenceStore } from "../../src/services/preferences.js";
import type { NewsArticle } from "../../src/services/news-types.js";

function makeCtx(): MethodContext {
  return { clientId: "c1", sessionId: "s1", broadcast: () => {}, emit: () => {} };
}

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => noopLogger,
} as any;

interface SummarizeResp { ok: boolean; summary?: string; cached?: boolean; error?: string }

function makeArticle(overrides: Partial<NewsArticle> = {}): NewsArticle {
  return {
    id: "art-1",
    sourceId: "coindesk",
    externalId: "ext-1",
    url: "https://example.com/a",
    title: "Bitcoin hits new high",
    description: "Short description",
    imageUrl: null,
    coins: ["BTC"],
    importance: "important",
    publishedAt: 1_700_000_000,
    fetchedAt: 1_700_000_010,
    expiresAt: 1_700_086_400,
    body: "A reasonably long article body that exceeds the 100 character minimum gate of the summarize endpoint and so on.",
    summary: null,
    aiRelevant: true,
    aiDuplicateOf: null,
    ...overrides,
  };
}

interface Harness {
  reg: MethodRegistry;
  runnerCall: ReturnType<typeof mock>;
  saveSummary: ReturnType<typeof mock>;
  article: NewsArticle;
}

function makeHarness(opts: { article?: NewsArticle; runnerReturn?: string | (() => Promise<string>) } = {}): Harness {
  const article = opts.article ?? makeArticle();
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE settings_kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const preferenceStore = new PreferenceStore(db, noopLogger);

  const runnerCall = mock(async () => {
    if (typeof opts.runnerReturn === "function") return opts.runnerReturn();
    return opts.runnerReturn ?? "Mocked summary paragraph one.\n\nMocked summary paragraph two.";
  });
  const saveSummary = mock(() => {});

  const newsService = {
    getArticle: mock((id: string) => (id === article.id ? article : null)),
    saveSummary,
  } as any;

  const reg = new MethodRegistry();
  registerTradingMethods(reg.register.bind(reg), {
    tradingClient: {} as any,
    walletStore: {} as any,
    alertRules: {} as any,
    notifications: {} as any,
    newsService,
    preferenceStore,
    watchlist: {} as any,
    logger: noopLogger,
    tokensSnapshot: { build: () => ({ tokens: [], prices: {}, prevDayPrices: {}, maxLeverages: {} }) } as any,
    priceCache: { get: () => undefined, set: () => {} } as any,
    runner: { call: runnerCall } as any,
  });

  return { reg, runnerCall, saveSummary, article };
}

describe("trading.news.summarize", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  it("cache hit — returns existing summary without invoking the LLM", async () => {
    const article = makeArticle({ summary: "Already summarised text — cached result." });
    harness = makeHarness({ article });

    const res = (await harness.reg.dispatch("trading.news.summarize", makeCtx(), {
      articleId: article.id,
    })) as SummarizeResp;

    expect(res.ok).toBe(true);
    expect(res.cached).toBe(true);
    expect(res.summary).toBe("Already summarised text — cached result.");
    expect(harness.runnerCall).not.toHaveBeenCalled();
    expect(harness.saveSummary).not.toHaveBeenCalled();
  });

  it("cache miss — calls the LLM, saves the result, returns cached=false", async () => {
    const res = (await harness.reg.dispatch("trading.news.summarize", makeCtx(), {
      articleId: harness.article.id,
    })) as SummarizeResp;

    expect(res.ok).toBe(true);
    expect(res.cached).toBe(false);
    expect(res.summary).toBeDefined();
    expect(harness.runnerCall).toHaveBeenCalledTimes(1);
    expect(harness.saveSummary).toHaveBeenCalledWith(harness.article.id, expect.any(String));
  });

  it("missing body — refuses to summarize", async () => {
    const article = makeArticle({ body: null, summary: null });
    harness = makeHarness({ article });

    const res = (await harness.reg.dispatch("trading.news.summarize", makeCtx(), {
      articleId: article.id,
    })) as SummarizeResp;

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/body unavailable/i);
    expect(harness.runnerCall).not.toHaveBeenCalled();
  });

  it("missing articleId — rejected", async () => {
    const res = (await harness.reg.dispatch("trading.news.summarize", makeCtx(), {})) as SummarizeResp;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/articleId/i);
  });

  it("unknown article id — rejected", async () => {
    const res = (await harness.reg.dispatch("trading.news.summarize", makeCtx(), {
      articleId: "does-not-exist",
    })) as SummarizeResp;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/i);
  });

  it("LLM returns empty text — rejected, summary NOT saved", async () => {
    harness = makeHarness({ runnerReturn: "   " });
    const res = (await harness.reg.dispatch("trading.news.summarize", makeCtx(), {
      articleId: harness.article.id,
    })) as SummarizeResp;
    expect(res.ok).toBe(false);
    expect(harness.saveSummary).not.toHaveBeenCalled();
  });

  it("LLM throws — returns ok:false, no save", async () => {
    harness = makeHarness({
      runnerReturn: async () => {
        throw new Error("LLM down");
      },
    });
    const res = (await harness.reg.dispatch("trading.news.summarize", makeCtx(), {
      articleId: harness.article.id,
    })) as SummarizeResp;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/summarize failed/i);
    expect(harness.saveSummary).not.toHaveBeenCalled();
  });
});
