/**
 * Tests for the body-fetch pipeline that news-fetch runs after RSS parse:
 *   - extractMainContent → Readability over a linkedom DOM
 *   - fetchAll → SSRF guard, parallel batch, success/fail counters
 *
 * `extractMainContent` is exported standalone so the unit tests can hit it
 * without spinning up a real HTTP server. The fetchAll integration cases
 * stub `globalThis.fetch` and exercise the worker pool + cache write end
 * to end.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { NewsService, extractMainContent } from "../../src/services/news.js";
import { WatchlistService } from "../../src/services/watchlist.js";
import { NOOP_LOGGER } from "../../src/logger.js";
import { initDatabase } from "../../src/core/database.js";
import { DB_MIGRATIONS } from "../../src/core/migrations/registry.js";

let dir: string;
let db: Database;

beforeEach(() => {
  dir = join(tmpdir(), `ghost-news-body-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  db = initDatabase(join(dir, "test.db"));
  for (const m of DB_MIGRATIONS) m.up(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// extractMainContent — Readability behaviour
// ---------------------------------------------------------------------------

describe("extractMainContent", () => {
  test("extracts the <article> content and drops nav/sidebar widgets", () => {
    const html = `
      <html><head><title>Bitcoin hits new high</title></head><body>
        <nav>Home | Markets | News</nav>
        <aside class="price-ticker">
          BTC $77,253 0.33% ETH $2,130 -0.17% BNB $643 0.21%
        </aside>
        <article>
          <h1>Bitcoin hits new high</h1>
          <p>Bitcoin reached a fresh all-time high today as institutional demand
          continued to push spot ETF inflows above ten billion dollars for the
          quarter. Analysts pointed to the upcoming halving as a structural
          tailwind for the next twelve months.</p>
          <p>Funding rates across the major perps venues remained calm, with
          open interest building slowly rather than spiking. That measured
          positioning is what one strategist called "the healthiest leg of the
          cycle so far," indicating spot-driven rather than leverage-driven
          flows.</p>
        </article>
        <footer>Subscribe to our newsletter</footer>
      </body></html>
    `;
    const text = extractMainContent(html);
    expect(text).not.toBeNull();
    expect(text).toContain("Bitcoin reached a fresh all-time high");
    expect(text).toContain("Funding rates");
    // Sidebar / nav / footer must NOT leak into the extracted text.
    expect(text).not.toContain("Subscribe to our newsletter");
    expect(text).not.toMatch(/BTC \$77,253/);
    expect(text).not.toContain("Home | Markets | News");
  });

  test("returns null on malformed HTML rather than throwing", () => {
    // Truly broken input shouldn't crash the caller.
    const text = extractMainContent("<<<not-html>>>");
    expect(text).toBeNull();
  });

  test("returns sanitized HTML with allowlist tags and strips script/style", () => {
    const html = `
      <html><body><article>
        <h1>Bitcoin futures funding turns mildly positive</h1>
        <p>Funding ticked above zero for the first time in three sessions,
        suggesting basis traders are stepping back in after last week's reset.
        Open interest climbed roughly eight percent over the same window.</p>
        <script>alert('xss')</script>
        <style>body{display:none}</style>
        <p>Strategists pointed to the upcoming spot-ETF inflow window as the
        proximate catalyst.</p>
        <img src="https://example.com/chart.png" alt="Funding chart" onerror="alert(1)" />
      </article></body></html>
    `;
    const out = extractMainContent(html, "https://example.com/article");
    expect(out).not.toBeNull();
    expect(out).toContain("<p>");
    expect(out).toContain("Funding ticked above zero");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<style");
    expect(out).not.toContain("onerror");
    expect(out).toContain("<img");
    expect(out).toContain("https://example.com/chart.png");
  });

  test("drops SVG/MathML namespaces and unsafe url schemes (XSS regression)", () => {
    // Readability needs enough surrounding content; pad with a real article body.
    const padding = "<p>Bitcoin perpetual funding rates ticked above zero on the major venues this week, suggesting basis traders are returning after last week's reset. Open interest climbed eight percent over the same window. Strategists pointed to spot-ETF inflows as the proximate catalyst for the move.</p>";
    const html = `
      <html><body><article>
        <h1>XSS hardening test</h1>
        ${padding}
        ${padding}
        <svg onload="alert(1)"><a xlink:href="javascript:alert(2)"><text>click</text></a></svg>
        <math><mtext><table><mglyph><style><img src=x onerror=alert(3)></style></mglyph></table></mtext></math>
        <a href="javascript:alert(4)">js href</a>
        <a href="data:text/html,<script>alert(5)</script>">data href</a>
        <img src="data:image/svg+xml,<svg/onload=alert(6)>" alt="" />
        <p onclick="alert(7)">click body</p>
      </article></body></html>
    `;
    const out = extractMainContent(html, "https://example.com/article");
    expect(out).not.toBeNull();
    const lc = out!.toLowerCase();
    expect(lc).not.toContain("<svg");
    expect(lc).not.toContain("<math");
    expect(lc).not.toContain("javascript:");
    expect(lc).not.toContain("data:");
    expect(lc).not.toContain("onload");
    expect(lc).not.toContain("onclick");
    expect(lc).not.toContain("onerror");
    expect(lc).not.toContain("alert(");
  });

  test("anchors are forced to target=_blank rel=noopener noreferrer", () => {
    const padding = "<p>Bitcoin perpetual funding rates ticked above zero on the major venues this week, suggesting basis traders are returning after last week's reset. Open interest climbed eight percent over the same window. Strategists pointed to spot-ETF inflows as the proximate catalyst.</p>";
    const html = `
      <html><body><article>
        <h1>Anchor safety</h1>
        ${padding}
        ${padding}
        <p>Read more at <a href="https://example.com/source" target="_self" rel="opener">the source</a>.</p>
      </article></body></html>
    `;
    const out = extractMainContent(html, "https://example.com/article");
    expect(out).not.toBeNull();
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).not.toContain('target="_self"');
    expect(out).not.toContain('rel="opener"');
  });
});

// ---------------------------------------------------------------------------
// fetchAll body pipeline — SSRF guard, parallel batch, cache write
// ---------------------------------------------------------------------------

interface RecordedFetch {
  url: string;
  options?: RequestInit;
}

function stubFetch(
  responses: Record<string, { status?: number; body?: string }>,
): { restore: () => void; calls: RecordedFetch[] } {
  const calls: RecordedFetch[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, options });
    const spec = responses[url];
    if (!spec) {
      // Unrecognised URL → simulate connection failure.
      throw new Error(`stubFetch: no response for ${url}`);
    }
    const status = spec.status ?? 200;
    const body = spec.body ?? "";
    return new Response(body, { status });
  }) as typeof globalThis.fetch;
  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
    calls,
  };
}

const ARTICLE_HTML = `
  <html><body>
    <article>
      <h1>BTC ETF crosses ten billion</h1>
      <p>The spot Bitcoin exchange-traded fund category crossed ten billion in
      cumulative inflows this week, with the largest issuer reporting a
      record one-day net subscription of nine hundred million dollars.</p>
      <p>Coinciding with the milestone, the futures basis on the major venues
      widened to roughly fourteen percent annualised — still well below the
      cycle peak but the highest reading since June.</p>
    </article>
  </body></html>
`;

describe("NewsService.fetchAll — body fetch pipeline", () => {
  test("does NOT fetch URLs that fail the SSRF guard", async () => {
    // Any HTTP call this test issues must NOT touch the internal-IP URL.
    // We stub all other URLs with an empty 200 so accidental preset-feed
    // requests don't trip the test's negative assertion.
    const SSRF_URL = "http://169.254.169.254/latest/meta-data/";
    const { restore, calls } = stubFetch({});
    try {
      // The default seedPresets() pre-loads CoinDesk/Decrypt/etc. Replace
      // every source row with our adversarial entry so adapter.fetch is
      // called against it.
      const watchlist = new WatchlistService(db);
      const service = new NewsService(db, watchlist, undefined, NOOP_LOGGER);
      db.exec(`DELETE FROM news_sources`);
      db.run(
        `INSERT INTO news_sources (source_id, name, enabled, api_key, custom_url, added_at)
         VALUES ('evil', 'Evil', 1, NULL, ?, unixepoch())`,
        [SSRF_URL],
      );

      const inserted = await service.fetchAll();
      // The RSS adapter validates `custom_url` against the SSRF guard before
      // issuing any HTTP request, so the call list must NEVER contain the
      // internal-IP URL. Zero articles inserted as a consequence.
      expect(inserted).toBe(0);
      expect(calls.some((c) => c.url === SSRF_URL)).toBe(false);
    } finally {
      restore();
    }
  });

  test("redirect responses do not get followed (SSRF defence in depth)", async () => {
    // White-box probe: invoke the private `fetchArticleBody` via a
    // single-source roundtrip. Easiest to exercise is the body-fetch HTTP
    // call directly through the stubbed fetch + a known-good HTTPS URL the
    // SSRF guard accepts.
    const { restore, calls } = stubFetch({
      "https://example.com/article": { status: 301, body: "" },
    });
    try {
      // Use the public fetchAll path with a fully stubbed adapter pipeline:
      // we set up a custom RSS that returns one article via stubbed XML.
      db.exec(`DELETE FROM news_sources`);
      db.run(
        `INSERT INTO news_sources (source_id, name, enabled, api_key, custom_url, added_at)
         VALUES ('test', 'Test', 1, NULL, 'https://example.com/feed.xml', unixepoch())`,
      );
      // Provide the feed XML response too.
      (globalThis.fetch as unknown as { responses?: unknown }).responses;
      const responses: Record<string, { status?: number; body?: string }> = {
        "https://example.com/feed.xml": {
          body: `<rss><channel>
            <item>
              <title>Bitcoin news</title>
              <link>https://example.com/article</link>
              <description>Bitcoin price update — crypto market analysis.</description>
              <pubDate>${new Date().toUTCString()}</pubDate>
            </item>
          </channel></rss>`,
        },
        "https://example.com/article": { status: 301, body: "" },
      };
      // Replace stub with both feed + article responses.
      restore();
      const second = stubFetch(responses);
      try {
        const watchlist = new WatchlistService(db);
        const service = new NewsService(db, watchlist, undefined, NOOP_LOGGER);
        const inserted = await service.fetchAll();
        // The article passes the crypto pre-filter; body fetch returns 301
        // → body stays NULL; row is still inserted.
        expect(inserted).toBe(1);
        const row = db.prepare("SELECT body FROM articles LIMIT 1").get() as { body: string | null };
        expect(row.body).toBeNull();
        // Article URL must have been touched exactly once, no redirect chase.
        const articleHits = second.calls.filter((c) => c.url === "https://example.com/article");
        expect(articleHits).toHaveLength(1);
        // Manual redirect mode on the body fetch.
        expect((articleHits[0].options as RequestInit).redirect).toBe("manual");
      } finally {
        second.restore();
      }
    } catch (err) {
      restore();
      throw err;
    }
  });

  test("Readability-extracted body lands in the body column on happy path", async () => {
    db.exec(`DELETE FROM news_sources`);
    db.run(
      `INSERT INTO news_sources (source_id, name, enabled, api_key, custom_url, added_at)
       VALUES ('test', 'Test', 1, NULL, 'https://example.com/feed.xml', unixepoch())`,
    );
    const { restore } = stubFetch({
      "https://example.com/feed.xml": {
        body: `<rss><channel>
          <item>
            <title>BTC ETF crosses ten billion</title>
            <link>https://example.com/btc-etf</link>
            <description>Bitcoin spot ETF flows hit a cumulative milestone. Crypto traders are watching.</description>
            <pubDate>${new Date().toUTCString()}</pubDate>
          </item>
        </channel></rss>`,
      },
      "https://example.com/btc-etf": { body: ARTICLE_HTML },
    });
    try {
      const watchlist = new WatchlistService(db);
      const service = new NewsService(db, watchlist, undefined, NOOP_LOGGER);
      const inserted = await service.fetchAll();
      expect(inserted).toBe(1);
      const row = db.prepare("SELECT body FROM articles LIMIT 1").get() as { body: string | null };
      expect(row.body).not.toBeNull();
      expect(row.body).toContain("spot Bitcoin exchange-traded fund");
      // Readability strips the surrounding markup; check we didn't smuggle
      // raw HTML through.
      expect(row.body).not.toContain("<article>");
    } finally {
      restore();
    }
  });

  test("pre-filter drops non-crypto items BEFORE issuing a body fetch", async () => {
    db.exec(`DELETE FROM news_sources`);
    db.run(
      `INSERT INTO news_sources (source_id, name, enabled, api_key, custom_url, added_at)
       VALUES ('test', 'Test', 1, NULL, 'https://example.com/feed.xml', unixepoch())`,
    );
    const { restore, calls } = stubFetch({
      "https://example.com/feed.xml": {
        body: `<rss><channel>
          <item>
            <title>Premier League transfer news</title>
            <link>https://example.com/football</link>
            <description>Manchester United signs new striker for record fee.</description>
            <pubDate>${new Date().toUTCString()}</pubDate>
          </item>
          <item>
            <title>Bitcoin news today</title>
            <link>https://example.com/btc</link>
            <description>Bitcoin price update — crypto market analysis.</description>
            <pubDate>${new Date().toUTCString()}</pubDate>
          </item>
        </channel></rss>`,
      },
      "https://example.com/btc": { body: ARTICLE_HTML },
    });
    try {
      const watchlist = new WatchlistService(db);
      const service = new NewsService(db, watchlist, undefined, NOOP_LOGGER);
      const inserted = await service.fetchAll();
      // Only the crypto item makes it through.
      expect(inserted).toBe(1);
      // The football URL must never have been fetched — pre-filter happens
      // before the parallel body workers run.
      const footballHits = calls.filter((c) => c.url === "https://example.com/football");
      expect(footballHits).toHaveLength(0);
    } finally {
      restore();
    }
  });

  test("body length is capped to MAX_BODY_LEN (300 000 chars)", async () => {
    db.exec(`DELETE FROM news_sources`);
    db.run(
      `INSERT INTO news_sources (source_id, name, enabled, api_key, custom_url, added_at)
       VALUES ('test', 'Test', 1, NULL, 'https://example.com/feed.xml', unixepoch())`,
    );
    // Build an enormous article body — far over the 300 k cap.
    const longPara = "Crypto markets are interesting. ".repeat(60_000);
    const hugeArticle = `<html><body><article><h1>Long</h1><p>${longPara}</p></article></body></html>`;
    const { restore } = stubFetch({
      "https://example.com/feed.xml": {
        body: `<rss><channel>
          <item>
            <title>Bitcoin long-form analysis</title>
            <link>https://example.com/long</link>
            <description>Bitcoin price crypto analysis.</description>
            <pubDate>${new Date().toUTCString()}</pubDate>
          </item>
        </channel></rss>`,
      },
      "https://example.com/long": { body: hugeArticle },
    });
    try {
      const watchlist = new WatchlistService(db);
      const service = new NewsService(db, watchlist, undefined, NOOP_LOGGER);
      const inserted = await service.fetchAll();
      expect(inserted).toBe(1);
      const row = db.prepare("SELECT length(body) AS len FROM articles LIMIT 1").get() as { len: number };
      // ≤100 000 — exact value depends on Readability's trimming, but the
      // cap must be enforced.
      expect(row.len).toBeLessThanOrEqual(300_000);
      // …and the body must actually be substantial (i.e. extracted, not
      // empty/null collapsed).
      expect(row.len).toBeGreaterThan(1_000);
    } finally {
      restore();
    }
  });

  test("HTTP 4xx on the article URL yields body=NULL but the row still inserts", async () => {
    db.exec(`DELETE FROM news_sources`);
    db.run(
      `INSERT INTO news_sources (source_id, name, enabled, api_key, custom_url, added_at)
       VALUES ('test', 'Test', 1, NULL, 'https://example.com/feed.xml', unixepoch())`,
    );
    const { restore } = stubFetch({
      "https://example.com/feed.xml": {
        body: `<rss><channel>
          <item>
            <title>Bitcoin paywall</title>
            <link>https://example.com/paywalled</link>
            <description>Bitcoin crypto price news.</description>
            <pubDate>${new Date().toUTCString()}</pubDate>
          </item>
        </channel></rss>`,
      },
      "https://example.com/paywalled": { status: 403, body: "" },
    });
    try {
      const watchlist = new WatchlistService(db);
      const service = new NewsService(db, watchlist, undefined, NOOP_LOGGER);
      const inserted = await service.fetchAll();
      expect(inserted).toBe(1);
      const row = db.prepare("SELECT body FROM articles LIMIT 1").get() as { body: string | null };
      expect(row.body).toBeNull();
    } finally {
      restore();
    }
  });
});
