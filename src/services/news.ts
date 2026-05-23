/**
 * News service — SQLite-backed news aggregation with dedup, classification, and pruning.
 */

import type { Database } from "bun:sqlite";
import type { WatchlistService } from "./watchlist.js";
import type { CredentialStore } from "../config/credentials.js";
import type { Logger } from "pino";
import {
  type NewsArticle,
  type NewsSource,
  type Importance,
  URGENT_KEYWORDS,
  CRYPTO_KEYWORDS,
  URGENT_TTL,
  IMPORTANT_TTL,
  REFERENCE_TTL,
  NEWS_SOURCE_PRESETS,
} from "./news-types.js";
import { createAdapter, type RawArticle } from "./news-sources.js";
import { mapRow, mapSource, tokenize, tokenOverlap, stripHtmlToText } from "./news-helpers.js";
import { validateUrlSafety } from "../helpers/url-safety.js";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import sanitizeHtml from "sanitize-html";

const MAX_BODY_LEN = 300_000;
const BODY_FETCH_CONCURRENCY = 5;
const BODY_FETCH_TIMEOUT_MS = 10_000;
// Plain UA — default fetch UA gets blocked by some news sites.
const BODY_FETCH_UA = "Mozilla/5.0 (compatible; Ghost/1.0; +https://github.com/anthropics)";

export class NewsService {
  private readonly stmts;
  private readonly log: Logger;

  constructor(
    private readonly db: Database,
    private readonly watchlist: WatchlistService,
    private readonly credentials: CredentialStore | undefined,
    logger: Logger,
  ) {
    this.log = logger;
    this.stmts = {
      insertArticle: db.prepare(`
        INSERT OR IGNORE INTO articles
          (id, source_id, external_id, url, title, description, image_url, coins, importance, published_at, fetched_at, expires_at, body)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      dismissArticle: db.prepare(`UPDATE articles SET dismissed_at = unixepoch() WHERE id = ?`),
      pruneExpired: db.prepare(`DELETE FROM articles WHERE expires_at < unixepoch()`),
      getArticle: db.prepare(`SELECT * FROM articles WHERE id = ?`),
      updateSummary: db.prepare(`UPDATE articles SET summary = ? WHERE id = ?`),
      getBody: db.prepare(`SELECT body FROM articles WHERE id = ?`),
      saveBody: db.prepare(`UPDATE articles SET body = ? WHERE id = ?`),
      // Recent titles for cross-source dedup (within 6h window)
      recentTitles: db.prepare(`
        SELECT id, title FROM articles
        WHERE published_at > ? AND source_id != ?
      `),
      // Source management
      listSources: db.prepare(`SELECT source_id, name, enabled, api_key, custom_url, added_at FROM news_sources ORDER BY added_at`),
      upsertSource: db.prepare(`
        INSERT INTO news_sources (source_id, name, enabled, api_key, custom_url)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(source_id) DO UPDATE SET name = COALESCE(NULLIF(excluded.name, ''), news_sources.name), enabled = excluded.enabled, api_key = COALESCE(excluded.api_key, news_sources.api_key), custom_url = COALESCE(excluded.custom_url, news_sources.custom_url)
      `),
      toggleSource: db.prepare(`UPDATE news_sources SET enabled = ? WHERE source_id = ?`),
      setApiKey: db.prepare(`UPDATE news_sources SET api_key = ? WHERE source_id = ?`),
      removeSource: db.prepare(`DELETE FROM news_sources WHERE source_id = ?`),
      getSource: db.prepare(`SELECT source_id, name, enabled, api_key, custom_url, added_at FROM news_sources WHERE source_id = ?`),
      // AI relevance evaluation
      updateRelevance: db.prepare(`UPDATE articles SET ai_relevant = ? WHERE id = ?`),
      updateDuplicate: db.prepare(`UPDATE articles SET ai_duplicate_of = ? WHERE id = ?`),
      pendingEvaluation: db.prepare(`SELECT id, title, description FROM articles WHERE ai_relevant IS NULL ORDER BY published_at DESC LIMIT ?`),
      evaluatedTitles: db.prepare(`SELECT id, title FROM articles WHERE ai_relevant IS NOT NULL ORDER BY published_at DESC LIMIT ?`),
      // Per-(chat, scope) /news pagination — track which articles were
      // already delivered to a chat so the next call can drain different
      // ones. Pruned alongside expired articles to bound storage.
      markShown: db.prepare(`
        INSERT OR IGNORE INTO news_shown (chat_id, scope, article_id, shown_at)
        VALUES (?, ?, ?, unixepoch())
      `),
      pruneOrphanedShown: db.prepare(`
        DELETE FROM news_shown WHERE article_id NOT IN (SELECT id FROM articles)
      `),
    };

    this.seedPresets();
  }

  private seedPresets(): void {
    for (const preset of NEWS_SOURCE_PRESETS) {
      const existing = this.stmts.getSource.get(preset.sourceId) as { source_id: string } | undefined;
      if (!existing) {
        // RSS sources enabled by default (no API key needed), API sources disabled
        const enabled = preset.needsApiKey ? 0 : 1;
        this.stmts.upsertSource.run(preset.sourceId, preset.name, enabled, null, preset.defaultUrl ?? null);
      }
    }
  }

  async fetchAll(): Promise<number> {
    const sources = this.getSources().filter((s) => s.enabled);
    if (sources.length === 0) return 0;

    const results = await Promise.allSettled(
      sources.map(async (source) => {
        const adapter = createAdapter(source.sourceId, source.customUrl ?? undefined);
        if (!adapter) return [];
        const apiKey = await this.getSourceApiKey(source.sourceId);
        return adapter.fetch(apiKey ?? undefined, source.customUrl ?? undefined);
      }),
    );

    const now = Math.floor(Date.now() / 1000);
    const watchlistSymbols = new Set(this.watchlist.list().map((w) => w.symbol));

    const candidates: Array<{ source: NewsSource; raw: RawArticle }> = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "rejected") {
        this.log.warn({ source: sources[i].sourceId, reason: result.reason }, "source fetch failed");
        continue;
      }
      for (const raw of result.value) {
        if (this.isDuplicate(raw, sources[i].sourceId, now)) continue;
        if (!this.isCryptoRelevant(raw.title, raw.description)) continue;
        candidates.push({ source: sources[i], raw });
      }
    }

    await this.fetchBodiesParallel(candidates.map((c) => c.raw));

    let inserted = 0;
    let bodyOk = 0;
    for (const { source, raw } of candidates) {
      const importance = this.classifyImportance(raw, watchlistSymbols);
      const ttl = importance === "urgent" ? URGENT_TTL : importance === "important" ? IMPORTANT_TTL : REFERENCE_TTL;
      const id = crypto.randomUUID();

      try {
        this.stmts.insertArticle.run(
          id,
          source.sourceId,
          raw.externalId,
          raw.url,
          raw.title,
          raw.description,
          raw.imageUrl ?? null,
          JSON.stringify(raw.coins),
          importance,
          raw.publishedAt,
          now,
          raw.publishedAt + ttl,
          raw.body ?? null,
        );
        inserted++;
        if (raw.body) bodyOk++;
      } catch {
        // UNIQUE constraint violation — same source+externalId, skip
      }
    }

    if (candidates.length > 0) {
      this.log.info(
        { candidates: candidates.length, inserted, bodyOk, bodyMissing: inserted - bodyOk },
        "news fetch complete",
      );
    }

    this.pruneExpired();
    return inserted;
  }

  private async fetchBodiesParallel(items: RawArticle[]): Promise<void> {
    if (items.length === 0) return;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(BODY_FETCH_CONCURRENCY, items.length) }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= items.length) return;
        const raw = items[idx]!;
        try {
          raw.body = await this.fetchArticleBody(raw.url);
        } catch (err) {
          this.log.debug({ url: raw.url, err: String(err) }, "body fetch failed");
          raw.body = null;
        }
      }
    });
    await Promise.all(workers);
  }

  // URLs come from third-party RSS feeds, so route through the SSRF guard
  // and refuse to follow redirects that might point at internal addresses.
  private async fetchArticleBody(url: string): Promise<string | null> {
    try {
      await validateUrlSafety(url);
    } catch {
      return null;
    }
    const res = await fetch(url, {
      headers: { "User-Agent": BODY_FETCH_UA, Accept: "text/html,*/*" },
      signal: AbortSignal.timeout(BODY_FETCH_TIMEOUT_MS),
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) return null;
    if (!res.ok) return null;
    const html = await res.text();

    const extracted = extractMainContent(html, url);
    if (!extracted) {
      const text = stripHtmlToText(html);
      if (text.length < 100) return null;
      return text.length > MAX_BODY_LEN ? text.slice(0, MAX_BODY_LEN) : text;
    }
    return capHtmlLength(extracted, MAX_BODY_LEN);
  }

  getArticles(opts: {
    limit?: number;
    offset?: number;
    importance?: Importance;
    coins?: string[];
    // Cursor pagination — stable against concurrent inserts (evaluator job)
    beforePublishedAt?: number;
    beforeId?: string;
    afterPublishedAt?: number;
    afterId?: string;
  } = {}): NewsArticle[] {
    const limit = opts.limit ?? 20;
    const offset = opts.offset ?? 0;
    const coins = opts.coins?.map((c) => c.toUpperCase()) ?? [];

    const coinClause = coins.length > 0
      ? `AND EXISTS (SELECT 1 FROM json_each(coins) WHERE value IN (${coins.map(() => "?").join(", ")}))`
      : "";
    const importanceClause = opts.importance ? `AND importance = ?` : "";

    let cursorClause = "";
    const cursorParams: Array<string | number> = [];
    if (opts.beforePublishedAt !== undefined && opts.beforeId !== undefined) {
      cursorClause = "AND (published_at < ? OR (published_at = ? AND id < ?))";
      cursorParams.push(opts.beforePublishedAt, opts.beforePublishedAt, opts.beforeId);
    } else if (opts.afterPublishedAt !== undefined && opts.afterId !== undefined) {
      cursorClause = "AND (published_at > ? OR (published_at = ? AND id > ?))";
      cursorParams.push(opts.afterPublishedAt, opts.afterPublishedAt, opts.afterId);
    }

    const sql = `
      SELECT id, source_id, external_id, url, title, description, image_url, coins,
             importance, published_at, fetched_at, expires_at, body, summary,
             ai_relevant, ai_duplicate_of
      FROM articles
      WHERE ai_relevant = 1 AND ai_duplicate_of IS NULL AND dismissed_at IS NULL
        ${coinClause} ${importanceClause} ${cursorClause}
      ORDER BY published_at DESC, id DESC
      LIMIT ? OFFSET ?
    `;
    const params = [
      ...coins,
      ...(opts.importance ? [opts.importance] : []),
      ...cursorParams,
      limit,
      offset,
    ];
    return this.db.prepare(sql).all(...params).map((r) => mapRow(r as Record<string, unknown>));
  }

  /**
   * Observer news detector input. Limit defaults to 20 to bound judge prompt size.
   * Caller filters by coin / position match — this read returns every ready article.
   */
  listRecentRelevant(sinceTs: number, limit = 20): NewsArticle[] {
    const sql = `
      SELECT id, source_id, external_id, url, title, description, image_url, coins,
             importance, published_at, fetched_at, expires_at, body, summary,
             ai_relevant, ai_duplicate_of
      FROM articles
      WHERE ai_relevant = 1
        AND ai_duplicate_of IS NULL
        AND dismissed_at IS NULL
        AND expires_at > unixepoch()
        AND published_at > ?
      ORDER BY published_at DESC, id DESC
      LIMIT ?
    `;
    return this.db
      .prepare(sql)
      .all(sinceTs, limit)
      .map((r) => mapRow(r as Record<string, unknown>));
  }

  /** Search articles by keyword and/or coins. For agent tool use. */
  searchArticles(opts: { query?: string; coins?: string[]; limit?: number } = {}): NewsArticle[] {
    const limit = Math.min(opts.limit ?? 50, 100);
    const conditions: string[] = ["ai_duplicate_of IS NULL"];
    const params: Array<string | number> = [];

    // Keyword search
    if (opts.query) {
      conditions.push("(title LIKE ? OR description LIKE ?)");
      const pattern = `%${opts.query}%`;
      params.push(pattern, pattern);
    }

    // Coin filter
    if (opts.coins && opts.coins.length > 0) {
      const placeholders = opts.coins.map(() => "?").join(", ");
      conditions.push(`EXISTS (SELECT 1 FROM json_each(coins) WHERE value IN (${placeholders}))`);
      params.push(...opts.coins.map((c) => c.toUpperCase()));
    }

    params.push(limit);
    const sql = `
      SELECT id, source_id, external_id, url, title, description, image_url, coins,
             importance, published_at, fetched_at, expires_at, body, summary,
             ai_relevant, ai_duplicate_of
      FROM articles
      WHERE ${conditions.join(" AND ")}
      ORDER BY published_at DESC
      LIMIT ?
    `;
    return (this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>).map(mapRow);
  }

  /** Total count of relevant non-dismissed articles, optionally filtered. */
  countArticles(opts: { coins?: string[]; importance?: Importance } = {}): number {
    const coins = opts.coins?.map((c) => c.toUpperCase()) ?? [];
    const coinClause = coins.length > 0
      ? `AND EXISTS (SELECT 1 FROM json_each(coins) WHERE value IN (${coins.map(() => "?").join(", ")}))`
      : "";
    const importanceClause = opts.importance ? `AND importance = ?` : "";
    // Same visibility filter as getArticles — count must match what the
    // widget will actually render.
    const sql = `
      SELECT COUNT(*) AS c FROM articles
      WHERE ai_relevant = 1 AND ai_duplicate_of IS NULL AND dismissed_at IS NULL
        ${coinClause} ${importanceClause}
    `;
    const params = [...coins, ...(opts.importance ? [opts.importance] : [])];
    const row = this.db.prepare(sql).get(...params) as { c: number } | null;
    return Number(row?.c ?? 0);
  }

  getArticle(articleId: string): NewsArticle | null {
    const row = this.stmts.getArticle.get(articleId) as Record<string, unknown> | undefined;
    return row ? mapRow(row) : null;
  }

  pruneExpired(): number {
    const result = this.stmts.pruneExpired.run();
    // Also drop orphaned `news_shown` rows whose article was just expired.
    // Bounds storage for active /news users without a separate cron.
    this.stmts.pruneOrphanedShown.run();
    return result.changes;
  }

  /**
   * Return up to `limit` relevant non-dismissed articles that have NOT been
   * delivered to (`chatId`, `scope`) yet via /news. Sorted newest-first so a
   * trader catching up sees fresh news at the top of every batch.
   *
   * `scope` is `global` (no filter) or `symbol:<SYM>` (only articles with
   * `<SYM>` in `coins`). Each scope has an independent shown-set, so
   * `/news` and `/news BTC` drain in parallel without colliding.
   *
   * Caller is responsible for calling {@link markArticlesShown} after a
   * successful delivery — read + write are split so a failed Telegram send
   * doesn't accidentally mark unsent articles as seen.
   */
  getUnshownArticles(
    chatId: string,
    scope: string,
    opts: { limit?: number; symbol?: string } = {},
  ): NewsArticle[] {
    const limit = opts.limit ?? 5;
    const params: Array<string | number> = [chatId, scope];
    let coinClause = "";
    if (opts.symbol) {
      coinClause = `AND EXISTS (SELECT 1 FROM json_each(a.coins) WHERE value = ?)`;
      params.push(opts.symbol.toUpperCase());
    }
    params.push(limit);
    const sql = `
      SELECT a.id, a.source_id, a.external_id, a.url, a.title, a.description,
             a.image_url, a.coins, a.importance, a.published_at, a.fetched_at,
             a.expires_at, a.body, a.summary, a.ai_relevant, a.ai_duplicate_of
      FROM articles a
      WHERE a.ai_relevant = 1
        AND a.ai_duplicate_of IS NULL
        AND a.dismissed_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM news_shown s
          WHERE s.article_id = a.id AND s.chat_id = ? AND s.scope = ?
        )
        ${coinClause}
      ORDER BY a.published_at DESC, a.id DESC
      LIMIT ?
    `;
    return this.db
      .prepare(sql)
      .all(...params)
      .map((r) => mapRow(r as Record<string, unknown>));
  }

  /** Record that the listed articles were delivered to (`chatId`, `scope`).
   *  Idempotent — re-marking is a no-op via INSERT OR IGNORE. */
  markArticlesShown(chatId: string, scope: string, articleIds: ReadonlyArray<string>): void {
    if (articleIds.length === 0) return;
    for (const id of articleIds) {
      this.stmts.markShown.run(chatId, scope, id);
    }
  }

  getSources(): NewsSource[] {
    const rows = this.stmts.listSources.all() as Array<Record<string, unknown>>;
    return rows.map(mapSource);
  }

  /** Fast lookup table from `sourceId` → display `name` for renderers that
   *  need to show the human-readable name (e.g. /news on Telegram showing
   *  `CoinTelegraph` instead of `cointelegraph`). One query per call —
   *  cheap enough to call once per /news invocation. */
  getSourceNames(): Map<string, string> {
    const sources = this.getSources();
    return new Map(sources.map((s) => [s.sourceId, s.name]));
  }

  toggleSource(sourceId: string, enabled: boolean): void {
    this.stmts.toggleSource.run(enabled ? 1 : 0, sourceId);
  }

  async setSourceApiKey(sourceId: string, apiKey: string): Promise<void> {
    if (this.credentials) {
      await this.credentials.set(`news_api_key:${sourceId}`, apiKey);
    } else {
      // Fallback: store in DB (should not happen in production)
      this.stmts.setApiKey.run(apiKey, sourceId);
    }
  }

  /** Retrieve API key from CredentialStore, falling back to DB column. */
  private async getSourceApiKey(sourceId: string): Promise<string | null> {
    if (this.credentials) {
      const key = await this.credentials.get(`news_api_key:${sourceId}`);
      if (key) return key;
    }
    // Fallback: check DB column for legacy/migration
    const source = this.stmts.getSource.get(sourceId) as { api_key: string | null } | undefined;
    return source?.api_key ?? null;
  }

  /**
   * Upsert a news source. On conflict the name and customUrl are updated.
   * Used by the agent tool layer to persist discovered feeds.
   */
  upsertSource(opts: { sourceId: string; name: string; enabled: boolean; customUrl: string }): void {
    this.stmts.upsertSource.run(opts.sourceId, opts.name, opts.enabled ? 1 : 0, null, opts.customUrl);
  }

  addCustomRss(url: string, name: string): { ok: boolean; error?: string } {
    // Validate URL format
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { ok: false, error: "URL must use http:// or https://" };
      }
    } catch {
      return { ok: false, error: "Invalid URL format" };
    }

    const sourceId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const existing = this.stmts.getSource.get(sourceId) as { source_id: string } | undefined;
    if (existing) {
      return { ok: false, error: `Source "${name}" already exists` };
    }

    this.stmts.upsertSource.run(sourceId, name, 1, null, url);
    return { ok: true };
  }

  dismissArticle(articleId: string): boolean {
    const result = this.stmts.dismissArticle.run(articleId);
    return result.changes > 0;
  }

  removeCustomSource(sourceId: string): boolean {
    // Only allow removing non-preset sources
    const isPreset = NEWS_SOURCE_PRESETS.some((p) => p.sourceId === sourceId);
    if (isPreset) return false;
    const result = this.stmts.removeSource.run(sourceId);
    return result.changes > 0;
  }

  // ---------------------------------------------------------------------------
  // Pure CRUD — called from the news background jobs via taskAgent
  // ---------------------------------------------------------------------------

  saveSummary(articleId: string, text: string): void {
    this.stmts.updateSummary.run(text, articleId);
  }

  getBody(articleId: string): string | null {
    const row = this.stmts.getBody.get(articleId) as { body: string | null } | undefined;
    return row?.body ?? null;
  }

  saveBody(articleId: string, body: string): void {
    this.stmts.saveBody.run(body, articleId);
  }

  // existingTitles is a small recent slice the LLM uses to spot duplicates
  // across the evaluation batch.
  listPendingEvaluations(batchSize = 20): {
    candidates: Array<{ id: string; title: string; description: string }>;
    existingTitles: Array<{ id: string; title: string }>;
    total: number;
  } {
    const candidates = this.stmts.pendingEvaluation.all(batchSize) as Array<{
      id: string;
      title: string;
      description: string;
    }>;
    if (candidates.length === 0) {
      return { candidates: [], existingTitles: [], total: 0 };
    }

    const existingTitles = this.stmts.evaluatedTitles.all(50) as Array<{
      id: string;
      title: string;
    }>;

    return { candidates, existingTitles, total: candidates.length };
  }

  /**
   * Persist evaluation decisions returned by the AI.
   * `selectedIds` is the set of article IDs the AI deemed relevant.
   * All candidates not in that set are marked irrelevant.
   */
  saveEvaluation(
    candidates: ReadonlyArray<{ id: string }>,
    selectedIds: ReadonlyArray<string>,
  ): void {
    const selected = new Set(selectedIds);
    for (const article of candidates) {
      this.stmts.updateRelevance.run(selected.has(article.id) ? 1 : 0, article.id);
    }
  }

  /** Rule-based check: does the article mention crypto at all? */
  private isCryptoRelevant(title: string, description: string): boolean {
    const text = `${title} ${description}`.toLowerCase();
    // Pass if any crypto keyword matches
    for (const kw of CRYPTO_KEYWORDS) {
      if (text.includes(kw)) return true;
    }
    return false;
  }

  private classifyImportance(raw: RawArticle, watchlistSymbols: Set<string>): Importance {
    const text = `${raw.title} ${raw.description}`.toLowerCase();

    // Check urgent keywords
    for (const keyword of URGENT_KEYWORDS) {
      if (text.includes(keyword)) return "urgent";
    }

    // CryptoPanic importance signal
    if (raw.importanceSignal !== undefined && raw.importanceSignal > 2) return "important";

    // Watchlist overlap
    if (raw.coins.some((c) => watchlistSymbols.has(c))) return "important";

    return "reference";
  }

  private isDuplicate(raw: RawArticle, sourceId: string, now: number): boolean {
    const sixHoursAgo = now - 6 * 3600;
    const recent = this.stmts.recentTitles.all(sixHoursAgo, sourceId) as Array<{ id: string; title: string }>;

    const tokens = tokenize(raw.title);
    if (tokens.length === 0) return false;

    for (const existing of recent) {
      const existingTokens = tokenize(existing.title);
      if (existingTokens.length === 0) continue;
      const overlap = tokenOverlap(tokens, existingTokens);
      if (overlap >= 0.6) return true;
    }

    return false;
  }
}

// Allowlist of HTML tags + attrs kept after Readability extraction. Anything
// not listed is dropped wholesale by sanitize-html (no unwrap-and-keep-children;
// we want a strict allowlist on the security boundary). SVG/MathML namespaces,
// event-handler attributes, javascript:/data: URLs, and CSS expressions are
// blocked by sanitize-html's defaults.
const ALLOWED_TAGS: ReadonlyArray<string> = [
  "p", "br", "a", "strong", "b", "em", "i", "u",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li",
  "blockquote", "img", "figure", "figcaption",
  "code", "pre", "hr",
];

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [...ALLOWED_TAGS],
  allowedAttributes: {
    // target/rel are listed so the transformTags merge can write them — the
    // transform runs after the attr sweep, so attacker-supplied values get
    // overwritten with our safe defaults.
    a: ["href", "target", "rel"],
    img: ["src", "alt"],
  },
  allowedSchemes: ["http", "https"],
  // Drop content of these tags entirely instead of unwrapping.
  nonTextTags: ["style", "script", "textarea", "option", "noscript"],
  // Mark every link target=_blank rel=noopener; sanitize-html merges these in
  // and re-validates the result so attacker-supplied rel=opener can't slip in.
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noopener noreferrer" }, true),
  },
  // Keep our own scheme allowlist as the source of truth instead of relying on
  // sanitize-html's per-tag default (allowedSchemes wins anyway, but explicit).
  allowedSchemesByTag: {},
  allowProtocolRelative: false,
};

export function extractMainContent(html: string, baseUrl?: string): string | null {
  try {
    const { document } = parseHTML(html);
    const reader = new Readability(document as unknown as Document, {
      charThreshold: 250,
    });
    const parsed = reader.parse();
    if (!parsed) return null;
    const rawHtml = parsed.content ?? "";
    if (rawHtml.trim().length === 0) return null;

    const resolved = baseUrl ? resolveRelativeUrls(rawHtml, baseUrl) : rawHtml;
    const sanitized = sanitizeHtml(resolved, SANITIZE_OPTIONS).trim();
    if (sanitized.length === 0) return null;

    const textLen = stripHtmlToText(sanitized).length;
    if (textLen < 100) return null;
    return sanitized;
  } catch {
    return null;
  }
}

// Resolve href/src to absolute URLs against baseUrl. We do this BEFORE
// sanitize-html so the scheme check has the final URL to inspect — otherwise
// a relative URL like "/x" would pass sanitize-html's scheme filter (no scheme
// to reject) only to render against the wrong origin on the client.
function resolveRelativeUrls(html: string, baseUrl: string): string {
  const { document } = parseHTML(`<div id="__root__">${html}</div>`);
  const root = document.getElementById("__root__");
  if (!root) return html;
  for (const attr of ["href", "src"] as const) {
    const els = root.querySelectorAll(`[${attr}]`);
    for (const el of els) {
      const raw = el.getAttribute(attr);
      if (!raw) continue;
      const abs = resolveUrl(raw, baseUrl);
      if (abs) el.setAttribute(attr, abs);
      else el.removeAttribute(attr);
    }
  }
  return (root as unknown as { innerHTML: string }).innerHTML;
}

// Bound HTML output size while keeping markup well-formed. Slice input below
// the cap with headroom for sanitize-html to insert closing tags (the parser
// will balance a split `<p>foo bar` to `<p>foo bar</p>` — that addition must
// not push us back over cap).
const CLOSE_TAG_BUDGET = 512;

function capHtmlLength(html: string, cap: number): string {
  if (html.length <= cap) return html;
  const budgeted = sanitizeHtml(html.slice(0, cap - CLOSE_TAG_BUDGET), SANITIZE_OPTIONS);
  return budgeted.length > cap ? budgeted.slice(0, cap) : budgeted;
}

function resolveUrl(value: string, baseUrl: string): string | null {
  const v = value.trim();
  if (!v) return null;
  try {
    const u = new URL(v, baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}
