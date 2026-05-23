import { describe, expect, test } from "bun:test";
import { detectNews } from "../../src/observer/detect/news.js";
import type { NewsArticle } from "../../src/services/news-types.js";

function article(overrides: Partial<NewsArticle> = {}): NewsArticle {
  return {
    id: "art-1",
    sourceId: "coindesk",
    externalId: "ext-1",
    url: "https://example.com/a",
    title: "BTC ETF approved",
    description: "SEC approves bitcoin ETF…",
    imageUrl: null,
    coins: ["BTC"],
    importance: "important",
    publishedAt: 1_700_000_000, // unix seconds
    fetchedAt: 1_700_000_010,
    expiresAt: 1_700_086_400,
    body: null,
    summary: "Long-form summary of the ETF approval and its expected market impact.",
    aiRelevant: true,
    aiDuplicateOf: null,
    ...overrides,
  };
}

const NOW = 1_700_000_100_000;

describe("detectNews", () => {
  test("empty articles → no events", () => {
    const r = detectNews({ articles: [], priorEmittedIds: new Set(), nowMs: NOW });
    expect(r.events).toEqual([]);
    expect(r.emittedIds).toEqual([]);
  });

  test("emits one NewsEvent per article with full field projection", () => {
    const r = detectNews({
      articles: [article()],
      priorEmittedIds: new Set(),
      nowMs: NOW,
    });
    expect(r.events).toHaveLength(1);
    const ev = r.events[0];
    expect(ev.type).toBe("news");
    expect(ev.detectedAt).toBe(NOW);
    expect(ev.articleId).toBe("art-1");
    expect(ev.title).toBe("BTC ETF approved");
    expect(ev.summary).toBe("Long-form summary of the ETF approval and its expected market impact.");
    expect(ev.source).toBe("coindesk");
    expect(ev.url).toBe("https://example.com/a");
    expect(ev.importance).toBe("important");
    expect(ev.coins).toEqual(["BTC"]);
    // publishedAt converted seconds→ms
    expect(ev.publishedAt).toBe(1_700_000_000 * 1000);
    expect(r.emittedIds).toEqual(["art-1"]);
  });

  test("article in priorEmittedIds → skipped", () => {
    const r = detectNews({
      articles: [article({ id: "art-1" }), article({ id: "art-2", title: "Other" })],
      priorEmittedIds: new Set(["art-1"]),
      nowMs: NOW,
    });
    expect(r.events).toHaveLength(1);
    expect(r.events[0].articleId).toBe("art-2");
    expect(r.emittedIds).toEqual(["art-2"]);
  });

  test("intra-batch duplicates → only first emit", () => {
    // Defensive — SQL shouldn't return duplicates, but make detector robust.
    const r = detectNews({
      articles: [article({ id: "dup" }), article({ id: "dup" })],
      priorEmittedIds: new Set(),
      nowMs: NOW,
    });
    expect(r.events).toHaveLength(1);
    expect(r.emittedIds).toEqual(["dup"]);
  });

  test("article with null summary → emits using description as fallback", () => {
    const r = detectNews({
      articles: [article({
        id: "no-summary",
        summary: null,
        description: "Body unavailable, but description has the gist.",
      })],
      priorEmittedIds: new Set(),
      nowMs: NOW,
    });
    expect(r.events).toHaveLength(1);
    expect(r.events[0].summary).toBe("Body unavailable, but description has the gist.");
    expect(r.emittedIds).toEqual(["no-summary"]);
  });

  test("article with null summary AND empty description → skipped", () => {
    const r = detectNews({
      articles: [article({ id: "no-text", summary: null, description: "" })],
      priorEmittedIds: new Set(),
      nowMs: NOW,
    });
    expect(r.events).toEqual([]);
    expect(r.emittedIds).toEqual([]);
  });

  test("coins array is copied — mutating event.coins does not affect article", () => {
    const a = article({ coins: ["BTC", "ETH"] });
    const r = detectNews({
      articles: [a],
      priorEmittedIds: new Set(),
      nowMs: NOW,
    });
    r.events[0].coins.push("FOO");
    expect(a.coins).toEqual(["BTC", "ETH"]);
  });

  test("preserves input ordering (newest-first from SQL)", () => {
    const r = detectNews({
      articles: [
        article({ id: "art-newest", publishedAt: 1_700_000_300 }),
        article({ id: "art-middle", publishedAt: 1_700_000_200 }),
        article({ id: "art-oldest", publishedAt: 1_700_000_100 }),
      ],
      priorEmittedIds: new Set(),
      nowMs: NOW,
    });
    expect(r.events.map((e) => e.articleId)).toEqual([
      "art-newest",
      "art-middle",
      "art-oldest",
    ]);
  });
});
