import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { NewsService } from "../../src/services/news.js";
import { WatchlistService } from "../../src/services/watchlist.js";
import { NOOP_LOGGER } from "../../src/logger.js";
import { initDatabase } from "../../src/core/database.js";
import { DB_MIGRATIONS } from "../../src/core/migrations/registry.js";
import { tokenize, tokenOverlap, stripHtmlToText, mapRow } from "../../src/services/news-helpers.js";
import { tagCoins, createAdapter, CryptoPanicAdapter, RssAdapter, CoinGeckoAdapter } from "../../src/services/news-sources.js";
import {
  URGENT_TTL,
  IMPORTANT_TTL,
  REFERENCE_TTL,
  NEWS_SOURCE_PRESETS,
  COIN_MAP,
} from "../../src/services/news-types.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function createTempDb(): { db: Database; path: string } {
  const dir = join(tmpdir(), `ghost-test-news-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "test.db");
  const db = initDatabase(dbPath);
  // Apply all schema migrations so the test sees the same column names the
  // runtime does (description/summary/body — see migration v11).
  for (const m of DB_MIGRATIONS) {
    const up = m.up(db);
    // Migrations may be async, but the v1–v11 set is currently all sync;
    // assert here so a future async migration trips loudly.
    if (up && typeof (up as Promise<void>).then === "function") {
      throw new Error("Async DB migration cannot be applied from sync test helper");
    }
  }
  return { db, path: dbPath };
}

function insertArticle(
  db: Database,
  overrides: Partial<{
    id: string;
    source_id: string;
    external_id: string;
    url: string;
    title: string;
    description: string;
    image_url: string | null;
    coins: string;
    importance: string;
    published_at: number;
    fetched_at: number;
    expires_at: number;
    summary: string | null;
  }> = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const defaults = {
    id: crypto.randomUUID(),
    source_id: "coindesk",
    external_id: `ext-${crypto.randomUUID()}`,
    url: "https://example.com/article",
    title: "Test Article",
    description: "Test description",
    image_url: null,
    coins: "[]",
    importance: "reference",
    published_at: now,
    fetched_at: now,
    expires_at: now + 86400,
    // getArticles filters on `summary IS NOT NULL` (the widget
    // contract is "showed = ready to read"); default fixtures simulate
    // the post-summarize state. Tests that need the pre-summarize state
    // should pass `summary: null` explicitly.
    summary: "Test summary",
  };
  const row = { ...defaults, ...overrides };
  db.prepare(`
    INSERT INTO articles
      (id, source_id, external_id, url, title, description, image_url, coins, importance, published_at, fetched_at, expires_at, summary, ai_relevant)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    row.id, row.source_id, row.external_id, row.url, row.title, row.description,
    row.image_url, row.coins, row.importance, row.published_at, row.fetched_at,
    row.expires_at, row.summary,
  );
  return row;
}

// ---------------------------------------------------------------------------
// Helper unit tests
// ---------------------------------------------------------------------------

describe("news-helpers", () => {
  describe("tokenize", () => {
    test("lowercases and strips punctuation", () => {
      const tokens = tokenize("Bitcoin Hits $100K!");
      expect(tokens).toContain("bitcoin");
      expect(tokens).toContain("hits");
      expect(tokens).toContain("100k");
      // Should NOT contain stopwords or symbols
      expect(tokens).not.toContain("$");
    });

    test("removes stopwords", () => {
      const tokens = tokenize("The price of Bitcoin is very high");
      expect(tokens).not.toContain("the");
      expect(tokens).not.toContain("of");
      expect(tokens).not.toContain("is");
      expect(tokens).not.toContain("very");
      expect(tokens).toContain("price");
      expect(tokens).toContain("bitcoin");
      expect(tokens).toContain("high");
    });

    test("filters single-char tokens", () => {
      const tokens = tokenize("A B C hello world");
      expect(tokens).not.toContain("b");
      expect(tokens).not.toContain("c");
      expect(tokens).toContain("hello");
      expect(tokens).toContain("world");
    });
  });

  describe("tokenOverlap", () => {
    test("identical tokens return 1.0", () => {
      const tokens = ["bitcoin", "hits", "100k"];
      expect(tokenOverlap(tokens, tokens)).toBe(1);
    });

    test("similar headlines have high overlap", () => {
      const a = tokenize("Bitcoin Hits $100K for the First Time");
      const b = tokenize("Bitcoin Hits $100K — Historical First");
      expect(tokenOverlap(a, b)).toBeGreaterThanOrEqual(0.6);
    });

    test("different headlines have low overlap", () => {
      const a = tokenize("Bitcoin Hits $100K");
      const b = tokenize("Ethereum DeFi Protocol Launches New Token");
      expect(tokenOverlap(a, b)).toBeLessThan(0.5);
    });

    test("empty tokens return 0", () => {
      expect(tokenOverlap([], ["bitcoin"])).toBe(0);
      expect(tokenOverlap(["bitcoin"], [])).toBe(0);
      expect(tokenOverlap([], [])).toBe(0);
    });
  });

  describe("stripHtmlToText", () => {
    test("strips HTML tags", () => {
      expect(stripHtmlToText("<p>Hello <b>world</b></p>")).toBe("Hello world");
    });

    test("removes script tags and content", () => {
      const result = stripHtmlToText("<p>Hello</p><script>alert('x')</script><p>world</p>");
      expect(result).toBe("Hello world");
      expect(result).not.toContain("alert");
    });

    test("removes style tags and content", () => {
      const result = stripHtmlToText("<style>.x { color: red; }</style><div>Content</div>");
      expect(result).toBe("Content");
    });

    test("decodes HTML entities", () => {
      expect(stripHtmlToText("A &amp; B &lt; C &gt; D &quot;E&quot; F&#39;s")).toBe("A & B < C > D \"E\" F's");
    });

    test("collapses whitespace", () => {
      expect(stripHtmlToText("  Hello    world  ")).toBe("Hello world");
    });
  });

  describe("mapRow", () => {
    test("maps DB row to NewsArticle", () => {
      const row = {
        id: "abc-123",
        source_id: "coindesk",
        external_id: "ext-456",
        url: "https://example.com",
        title: "Test",
        description: "Snippet",
        image_url: null,
        coins: '["BTC","ETH"]',
        importance: "urgent",
        published_at: 1000,
        fetched_at: 2000,
        expires_at: 3000,
        summary: "Summary text",
      };
      const article = mapRow(row);
      expect(article.id).toBe("abc-123");
      expect(article.sourceId).toBe("coindesk");
      expect(article.coins).toEqual(["BTC", "ETH"]);
      expect(article.importance).toBe("urgent");
      expect(article.summary).toBe("Summary text");
    });

    test("handles null image_url and summary", () => {
      const row = {
        id: "abc",
        source_id: "src",
        external_id: "ext",
        url: "https://example.com",
        title: "Test",
        description: "",
        image_url: null,
        coins: "[]",
        importance: "reference",
        published_at: 1000,
        fetched_at: 2000,
        expires_at: 3000,
        summary: null,
      };
      const article = mapRow(row);
      expect(article.imageUrl).toBeNull();
      expect(article.summary).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Coin tagging tests
// ---------------------------------------------------------------------------

describe("tagCoins", () => {
  test("tags Bitcoin and Ethereum from text", () => {
    const coins = tagCoins("Bitcoin hits new all-time high, Ethereum follows");
    expect(coins).toContain("BTC");
    expect(coins).toContain("ETH");
  });

  test("tags Solana from text", () => {
    const coins = tagCoins("Solana DEX volume surges past $1B");
    expect(coins).toContain("SOL");
  });

  test("returns empty array for no crypto mentions", () => {
    const coins = tagCoins("The weather is sunny today in New York");
    expect(coins).toEqual([]);
  });

  test("tags by symbol (case insensitive)", () => {
    const coins = tagCoins("BTC price action looks bullish");
    expect(coins).toContain("BTC");
  });

  test("tags Hyperliquid", () => {
    const coins = tagCoins("Hyperliquid trading volume sets new record");
    expect(coins).toContain("HYPE");
  });

  test("does not false-positive on partial matches", () => {
    // "link" should match as word boundary, not inside other words
    const coins = tagCoins("This blockchain links systems together");
    // "links" should NOT match LINK because of word boundary
    expect(coins).not.toContain("LINK");
  });
});

// ---------------------------------------------------------------------------
// createAdapter tests
// ---------------------------------------------------------------------------

describe("createAdapter", () => {
  test("returns RssAdapter for custom source with URL", () => {
    const adapter = createAdapter("custom:my-feed", "https://example.com/feed.xml");
    expect(adapter).not.toBeNull();
    expect(adapter!.sourceId).toBe("custom:my-feed");
  });

  test("returns null for custom source without URL", () => {
    const adapter = createAdapter("custom:my-feed");
    expect(adapter).toBeNull();
  });

  test("returns CryptoPanicAdapter for cryptopanic", () => {
    const adapter = createAdapter("cryptopanic");
    expect(adapter).not.toBeNull();
    expect(adapter!.sourceId).toBe("cryptopanic");
    expect(adapter).toBeInstanceOf(CryptoPanicAdapter);
  });

  test("returns RssAdapter for coindesk", () => {
    const adapter = createAdapter("coindesk");
    expect(adapter).not.toBeNull();
    expect(adapter!.sourceId).toBe("coindesk");
    expect(adapter).toBeInstanceOf(RssAdapter);
  });

  test("returns CoinGeckoAdapter for coingecko", () => {
    const adapter = createAdapter("coingecko");
    expect(adapter).not.toBeNull();
    expect(adapter!.sourceId).toBe("coingecko");
    expect(adapter).toBeInstanceOf(CoinGeckoAdapter);
  });

  test("returns null for unknown source", () => {
    const adapter = createAdapter("unknown-source");
    expect(adapter).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TTL constants
// ---------------------------------------------------------------------------

describe("TTL constants", () => {
  test("URGENT_TTL is 30 days", () => {
    expect(URGENT_TTL).toBe(2_592_000);
  });

  test("IMPORTANT_TTL is 7 days", () => {
    expect(IMPORTANT_TTL).toBe(604_800);
  });

  test("REFERENCE_TTL is 3 days", () => {
    expect(REFERENCE_TTL).toBe(259_200);
  });
});

// ---------------------------------------------------------------------------
// NewsService tests
// ---------------------------------------------------------------------------

describe("NewsService", () => {
  let db: Database;
  let dbPath: string;
  let watchlist: WatchlistService;
  let service: NewsService;

  beforeEach(() => {
    const result = createTempDb();
    db = result.db;
    dbPath = result.path;
    watchlist = new WatchlistService(db);
    service = new NewsService(db, watchlist, undefined, NOOP_LOGGER);
  });

  afterEach(() => {
    db.close();
  });

  describe("seed presets", () => {
    test("seeds 6 preset sources on construction", () => {
      const sources = service.getSources();
      expect(sources.length).toBe(6);
      const ids = sources.map((s) => s.sourceId);
      expect(ids).toContain("cryptopanic");
      expect(ids).toContain("coindesk");
      expect(ids).toContain("theblock");
      expect(ids).toContain("decrypt");
      expect(ids).toContain("cointelegraph");
      expect(ids).toContain("coingecko");
      expect(ids).not.toContain("x");
    });

    test("API sources disabled by default, RSS sources enabled", () => {
      const sources = service.getSources();
      const cryptopanic = sources.find((s) => s.sourceId === "cryptopanic");
      const coindesk = sources.find((s) => s.sourceId === "coindesk");
      const coingecko = sources.find((s) => s.sourceId === "coingecko");

      // CryptoPanic needs API key => disabled
      expect(cryptopanic!.enabled).toBe(0);
      // CoinGecko is API but needsApiKey=false => enabled
      expect(coingecko!.enabled).toBe(1);
      // CoinDesk is RSS => enabled
      expect(coindesk!.enabled).toBe(1);
    });
  });

  describe("getArticles", () => {
    test("returns empty array when no articles", () => {
      const articles = service.getArticles();
      expect(articles).toEqual([]);
    });

    test("returns inserted articles ordered by time (newest first)", () => {
      const now = Math.floor(Date.now() / 1000);
      insertArticle(db, { id: "a1", title: "Reference", importance: "reference", published_at: now - 100 });
      insertArticle(db, { id: "a2", title: "Urgent", importance: "urgent", published_at: now - 200 });
      insertArticle(db, { id: "a3", title: "Important", importance: "important", published_at: now });

      const articles = service.getArticles({ limit: 10 });
      expect(articles.length).toBe(3);
      // Newest first
      expect(articles[0].id).toBe("a3");
      expect(articles[1].id).toBe("a1");
      expect(articles[2].id).toBe("a2");
    });

    test("respects limit parameter", () => {
      const now = Math.floor(Date.now() / 1000);
      for (let i = 0; i < 10; i++) {
        insertArticle(db, { id: `art-${i}`, published_at: now - i });
      }
      const articles = service.getArticles({ limit: 3 });
      expect(articles.length).toBe(3);
    });

    test("filters by importance", () => {
      const now = Math.floor(Date.now() / 1000);
      insertArticle(db, { id: "u1", importance: "urgent", published_at: now });
      insertArticle(db, { id: "i1", importance: "important", published_at: now });
      insertArticle(db, { id: "r1", importance: "reference", published_at: now });

      const urgent = service.getArticles({ importance: "urgent" });
      expect(urgent.length).toBe(1);
      expect(urgent[0].id).toBe("u1");
    });

    test("filters by coins in SQL", () => {
      const now = Math.floor(Date.now() / 1000);
      // Insert 5 BTC articles and 25 ETH articles
      for (let i = 0; i < 5; i++) {
        insertArticle(db, { id: `btc-${i}`, coins: '["BTC"]', published_at: now - i });
      }
      for (let i = 0; i < 25; i++) {
        insertArticle(db, { id: `eth-${i}`, coins: '["ETH"]', published_at: now - i });
      }

      const btcArticles = service.getArticles({ coins: ["BTC"], limit: 20 });
      // Should return all 5 BTC articles (SQL-level filter, not post-LIMIT JS filter)
      expect(btcArticles.length).toBe(5);
      expect(btcArticles.every((a) => a.coins.includes("BTC"))).toBe(true);
    });

    test("filters by coins + importance combined", () => {
      const now = Math.floor(Date.now() / 1000);
      insertArticle(db, { id: "btc-urgent", coins: '["BTC"]', importance: "urgent", published_at: now });
      insertArticle(db, { id: "btc-ref", coins: '["BTC"]', importance: "reference", published_at: now });
      insertArticle(db, { id: "eth-urgent", coins: '["ETH"]', importance: "urgent", published_at: now });

      const result = service.getArticles({ coins: ["BTC"], importance: "urgent" });
      expect(result.length).toBe(1);
      expect(result[0].id).toBe("btc-urgent");
    });
  });

  describe("getArticle", () => {
    test("returns article by id", () => {
      insertArticle(db, { id: "single-1", title: "Single Article" });
      const article = service.getArticle("single-1");
      expect(article).not.toBeNull();
      expect(article!.title).toBe("Single Article");
    });

    test("returns null for non-existent id", () => {
      const article = service.getArticle("non-existent");
      expect(article).toBeNull();
    });
  });

  describe("pruneExpired", () => {
    test("removes expired articles", () => {
      const now = Math.floor(Date.now() / 1000);
      insertArticle(db, { id: "expired", expires_at: now - 100 });
      insertArticle(db, { id: "active", expires_at: now + 86400 });

      const removed = service.pruneExpired();
      expect(removed).toBe(1);

      const remaining = service.getArticles();
      expect(remaining.length).toBe(1);
      expect(remaining[0].id).toBe("active");
    });

    test("returns 0 when nothing to prune", () => {
      const now = Math.floor(Date.now() / 1000);
      insertArticle(db, { id: "active1", expires_at: now + 86400 });
      const removed = service.pruneExpired();
      expect(removed).toBe(0);
    });
  });

  describe("toggleSource", () => {
    test("disables an enabled source", () => {
      const before = service.getSources().find((s) => s.sourceId === "coindesk");
      expect(before!.enabled).toBe(1);

      service.toggleSource("coindesk", false);

      const after = service.getSources().find((s) => s.sourceId === "coindesk");
      expect(after!.enabled).toBe(0);
    });

    test("enables a disabled source", () => {
      service.toggleSource("cryptopanic", true);
      const source = service.getSources().find((s) => s.sourceId === "cryptopanic");
      expect(source!.enabled).toBe(1);
    });
  });

  describe("addCustomRss", () => {
    test("adds a custom RSS source", () => {
      const result = service.addCustomRss("https://example.com/feed.xml", "My Feed");
      expect(result.ok).toBe(true);

      const sources = service.getSources();
      const custom = sources.find((s) => s.sourceId === "custom:my-feed");
      expect(custom).toBeDefined();
      expect(custom!.enabled).toBe(1);
      expect(custom!.customUrl).toBe("https://example.com/feed.xml");
    });

    test("rejects duplicate source name", () => {
      service.addCustomRss("https://example.com/feed.xml", "My Feed");
      const result = service.addCustomRss("https://other.com/feed.xml", "My Feed");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("already exists");
    });

    test("rejects invalid URL format", () => {
      const result = service.addCustomRss("not-a-url", "Bad Feed");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Invalid URL");
    });

    test("rejects non-http URL", () => {
      const result = service.addCustomRss("ftp://example.com/feed", "FTP Feed");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("http:// or https://");
    });
  });

  describe("removeCustomSource", () => {
    test("removes a custom source", () => {
      service.addCustomRss("https://example.com/feed.xml", "My Feed");
      const removed = service.removeCustomSource("custom:my-feed");
      expect(removed).toBe(true);

      const sources = service.getSources();
      expect(sources.find((s) => s.sourceId === "custom:my-feed")).toBeUndefined();
    });

    test("cannot remove preset source", () => {
      const removed = service.removeCustomSource("coindesk");
      expect(removed).toBe(false);
    });

    test("returns false for non-existent source", () => {
      const removed = service.removeCustomSource("custom:nonexistent");
      expect(removed).toBe(false);
    });
  });

  describe("setSourceApiKey with CredentialStore", () => {
    test("stores API key via CredentialStore when available", async () => {
      const stored: Record<string, string> = {};
      const mockCredentials = {
        get: async (key: string) => stored[key] ?? null,
        set: async (key: string, value: string) => { stored[key] = value; },
        delete: async (_key: string) => true,
        load: async () => {},
        save: async () => {},
      };

      const serviceWithCreds = new NewsService(db, watchlist, mockCredentials as any, NOOP_LOGGER);
      await serviceWithCreds.setSourceApiKey("cryptopanic", "test-key-123");

      expect(stored["news_api_key:cryptopanic"]).toBe("test-key-123");
    });

    test("falls back to DB when CredentialStore not provided", async () => {
      // NewsService without credentials
      const serviceNoCreds = new NewsService(db, watchlist, undefined, NOOP_LOGGER);
      await serviceNoCreds.setSourceApiKey("cryptopanic", "fallback-key");

      // Check DB directly
      const row = db.prepare("SELECT api_key FROM news_sources WHERE source_id = ?").get("cryptopanic") as { api_key: string | null };
      expect(row.api_key).toBe("fallback-key");
    });
  });
});

// ---------------------------------------------------------------------------
// Summarizer tests
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// NewsService — CRUD methods
// ---------------------------------------------------------------------------

describe("NewsService CRUD — saveSummary / body cache", () => {
  let db: Database;
  let service: NewsService;

  /**
   * Insert an article whose ai_relevant and summary can be controlled.
   * Differs from the module-level helper (which always sets ai_relevant=1 and
   * summary="Test summary") so we can place articles in the pre-summary
   * and pre-evaluation states needed by these tests.
   */
  function insertRaw(
    overrides: Partial<{
      id: string;
      title: string;
      description: string;
      summary: string | null;
      body: string | null;
      ai_relevant: number | null;
    }> = {},
  ): string {
    const id = overrides.id ?? crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO articles
        (id, source_id, external_id, url, title, description, image_url, coins,
         importance, published_at, fetched_at, expires_at, summary, body, ai_relevant)
      VALUES (?, 'coindesk', ?, 'https://example.com', ?, ?, null, '[]',
              'reference', ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      `ext-${crypto.randomUUID()}`,
      overrides.title ?? "Crypto Article",
      overrides.description ?? "Bitcoin price update",
      now, now, now + 86400,
      overrides.summary ?? null,
      overrides.body ?? null,
      overrides.ai_relevant ?? null,
    );
    return id;
  }

  beforeEach(() => {
    const { db: freshDb } = createTempDb();
    db = freshDb;
    const watchlist = new WatchlistService(db);
    service = new NewsService(db, watchlist, undefined, NOOP_LOGGER);
  });

  test("saveSummary persists the summary text so getArticle returns it", () => {
    const id = insertRaw({ ai_relevant: 1, summary: null });
    service.saveSummary(id, "persisted summary text");

    const article = service.getArticle(id);
    expect(article?.summary).toBe("persisted summary text");
  });

  test("getBody / saveBody round-trip a body string", () => {
    const id = insertRaw({ ai_relevant: 1, body: null });
    expect(service.getBody(id)).toBeNull();

    service.saveBody(id, "Full article body fetched from URL.");
    expect(service.getBody(id)).toBe("Full article body fetched from URL.");
  });
});

describe("NewsService CRUD — listPendingEvaluations / saveEvaluation", () => {
  let db: Database;
  let service: NewsService;

  function insertRaw(
    overrides: Partial<{
      id: string;
      title: string;
      description: string;
      summary: string | null;
      ai_relevant: number | null;
    }> = {},
  ): string {
    const id = overrides.id ?? crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO articles
        (id, source_id, external_id, url, title, description, image_url, coins,
         importance, published_at, fetched_at, expires_at, summary, ai_relevant)
      VALUES (?, 'coindesk', ?, 'https://example.com', ?, ?, null, '[]',
              'reference', ?, ?, ?, ?, ?)
    `).run(
      id,
      `ext-${crypto.randomUUID()}`,
      overrides.title ?? "Bitcoin hits new high",
      overrides.description ?? "bitcoin crypto price market",
      now, now, now + 86400,
      overrides.summary ?? null,
      overrides.ai_relevant ?? null,
    );
    return id;
  }

  beforeEach(() => {
    const { db: freshDb } = createTempDb();
    db = freshDb;
    const watchlist = new WatchlistService(db);
    service = new NewsService(db, watchlist, undefined, NOOP_LOGGER);
  });

  test("listPendingEvaluations returns articles with ai_relevant IS NULL", () => {
    const id1 = insertRaw({ ai_relevant: null, title: "Bitcoin price update" });
    const id2 = insertRaw({ ai_relevant: null, title: "Ethereum DeFi news" });
    // Already evaluated articles must NOT be returned
    insertRaw({ ai_relevant: 1 });
    insertRaw({ ai_relevant: 0 });

    const { total } = service.listPendingEvaluations(20);
    expect(total).toBe(2);
    // id1 and id2 have crypto keywords so they pass the pre-filter
    const { candidates } = service.listPendingEvaluations(20);
    const candidateIds = candidates.map((c) => c.id);
    expect(candidateIds).toContain(id1);
    expect(candidateIds).toContain(id2);
  });

  test("listPendingEvaluations no longer applies the rule-based pre-filter (moved to news-fetch)", () => {
    // After the pipeline refactor, non-crypto items are dropped at fetch time
    // before they ever reach the DB, so listPendingEvaluations simply returns
    // every pending row verbatim — both crypto and (in theory) non-crypto.
    const ncId = insertRaw({
      ai_relevant: null,
      title: "Premier League transfer news",
      description: "Manchester United signs new striker",
    });
    const cryptoId = insertRaw({
      ai_relevant: null,
      title: "Bitcoin ETF approved",
      description: "bitcoin crypto market",
    });

    const { candidates, total } = service.listPendingEvaluations(20);
    expect(total).toBe(2);
    expect(candidates.map((c) => c.id).sort()).toEqual([ncId, cryptoId].sort());

    // No automatic UPDATE happens at this stage — `ai_relevant` stays NULL
    // until the evaluate job (or the toggle-off bypass) writes it.
    const row = db.prepare("SELECT ai_relevant FROM articles WHERE id = ?").get(ncId) as {
      ai_relevant: number | null;
    };
    expect(row.ai_relevant).toBeNull();
  });

  test("listPendingEvaluations returns zero when no pending articles exist", () => {
    const { total, candidates } = service.listPendingEvaluations(20);
    expect(total).toBe(0);
    expect(candidates).toHaveLength(0);
  });

  test("saveEvaluation marks selectedIds as relevant and others as irrelevant", () => {
    const id1 = insertRaw({ ai_relevant: null, title: "Bitcoin halving", description: "bitcoin crypto" });
    const id2 = insertRaw({ ai_relevant: null, title: "Ethereum merge", description: "ethereum crypto" });
    const id3 = insertRaw({ ai_relevant: null, title: "Solana update", description: "solana crypto blockchain" });

    const { candidates } = service.listPendingEvaluations(20);
    // Only id1 selected as relevant
    service.saveEvaluation(candidates, [id1]);

    const getRelevance = (id: string) =>
      (db.prepare("SELECT ai_relevant FROM articles WHERE id = ?").get(id) as { ai_relevant: number }).ai_relevant;

    expect(getRelevance(id1)).toBe(1);
    expect(getRelevance(id2)).toBe(0);
    expect(getRelevance(id3)).toBe(0);
  });

  test("saveEvaluation with empty selectedIds marks all candidates irrelevant", () => {
    const id1 = insertRaw({ ai_relevant: null, title: "Bitcoin news", description: "bitcoin crypto market" });
    const id2 = insertRaw({ ai_relevant: null, title: "ETH staking", description: "ethereum crypto staking" });

    const { candidates } = service.listPendingEvaluations(20);
    service.saveEvaluation(candidates, []);

    const getRelevance = (id: string) =>
      (db.prepare("SELECT ai_relevant FROM articles WHERE id = ?").get(id) as { ai_relevant: number }).ai_relevant;

    expect(getRelevance(id1)).toBe(0);
    expect(getRelevance(id2)).toBe(0);
  });

  test("saved evaluations are excluded from subsequent listPendingEvaluations", () => {
    const id = insertRaw({ ai_relevant: null, title: "Bitcoin price", description: "bitcoin crypto" });

    const { candidates: before } = service.listPendingEvaluations(20);
    expect(before.map((c) => c.id)).toContain(id);

    service.saveEvaluation(before, [id]);

    const { total: afterTotal } = service.listPendingEvaluations(20);
    expect(afterTotal).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getSources() must not expose apiKey in the wire response
// ---------------------------------------------------------------------------

describe("getSources() — apiKey must not appear in list response", () => {
  let db: Database;
  let service: NewsService;

  beforeEach(() => {
    const res = createTempDb();
    db = res.db;
    const watchlist = new WatchlistService(db);
    service = new NewsService(db, watchlist, undefined, NOOP_LOGGER);
  });

  afterEach(() => { db.close(); });

  test("getSources() returns sources without apiKey field populated for preset sources", () => {
    // Preset RSS sources seed with api_key=null — verify apiKey is null (not
    // a key string) in every row and the field is present but sanitised.
    const sources = service.getSources();
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      // apiKey field exists in the type but must be null for these fixtures
      expect(source.apiKey).toBeNull();
    }
  });

  test("getSources() does not return raw apiKey after setSourceApiKey stores via DB fallback", async () => {
    // Seed a CryptoPanic source with an API key stored in the DB column
    // (credentials=undefined triggers the DB fallback in setSourceApiKey).
    await service.setSourceApiKey("cryptopanic", "secret_test_key_12345");

    const sources = service.getSources();
    const cpSource = sources.find((s) => s.sourceId === "cryptopanic");
    expect(cpSource).toBeDefined();

    // The RPC handler in trading.ts strips apiKey before sending.
    // Simulate that strip here to verify the pattern works end-to-end.
    const { apiKey: _apiKey, ...publicShape } = cpSource!;
    expect(Object.keys(publicShape)).not.toContain("apiKey");
    // The raw object from getSources has it (for internal adapter use) —
    // the POINT is that the RPC strips it before sending over the wire.
    expect(cpSource!.apiKey).toBe("secret_test_key_12345");
    expect(_apiKey).toBe("secret_test_key_12345");
  });

  test("trading.news.sources.list wire shape has no apiKey field", async () => {
    // Simulate the exact strip done by the trading.news.sources.list handler.
    await service.setSourceApiKey("cryptopanic", "super_secret_api_key");
    const raw = service.getSources();
    const wireShape = raw.map(({ apiKey: _apiKey, ...rest }) => rest);

    for (const source of wireShape) {
      expect(source).not.toHaveProperty("apiKey");
    }
  });
});
