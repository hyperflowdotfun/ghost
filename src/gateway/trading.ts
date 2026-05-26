import type { MethodHandler } from "./method-registry.js";
import type { ITradingClient } from "../services/interfaces/trading-client.js";
import type { IWalletStore } from "../services/interfaces/wallet-store.js";
import type { AlertRulesService } from "../services/alert-rules.js";
import type { NotificationsService } from "../services/notifications.js";
import type { NewsService } from "../services/news.js";
import type { RssDiscoveryService } from "../services/rss-discovery.js";
import type { TweetService } from "../services/tweets.js";
import type { XFollowService } from "../services/x-follows.js";
import type { PreferenceStore } from "../services/preferences.js";
import type { Importance } from "../services/news-types.js";
import type { WatchlistService } from "../services/watchlist/service.js";
import type { IntelService } from "../services/intel.js";
import type { BinanceService } from "../services/binance.js";
import type { PriceSourceId } from "../services/price-feed/types.js";
import {
  validateWatchlistSymbol,
  canonicalWatchlistSymbol,
} from "../services/watchlist/sources.js";
import type { Logger } from "pino";
import type { TokensSnapshotService } from "../services/tokens-snapshot.js";
import type { PriceCache } from "../services/price-cache.js";
import type { Runner } from "../agent/runner.js";
import { DEFAULT_NEWS_FILTER_INSTRUCTION } from "../daemon/prompts/news-evaluation.js";
import { DEFAULT_TWEET_FILTER_INSTRUCTION } from "../daemon/prompts/tweet-evaluation.js";
import { NEWS_DEEPSUMMARY_SYSTEM, buildDeepSummaryPrompt } from "../daemon/prompts/news-deepsummary.js";

const FILTER_PROMPT_MAX = 2000;

interface TradingDeps {
  tradingClient: ITradingClient;
  walletStore: IWalletStore;
  alertRules: AlertRulesService;
  notifications: NotificationsService;
  newsService: NewsService;
  rssDiscovery?: RssDiscoveryService;
  tweetService?: TweetService;
  xFollowService?: XFollowService;
  preferenceStore: PreferenceStore;
  watchlist: WatchlistService;
  intel: IntelService;
  /** Binance universe lookup for watchlist add validation; undefined when
   *  Binance is disabled. Only `.has()` is consumed here. */
  binance: BinanceService | undefined;
  logger: Logger;
  /** In-memory snapshot service — serves trading.tokens.list with zero HL calls. */
  tokensSnapshot: TokensSnapshotService;
  /** Price cache — serves trading.price from in-memory state; falls back to HL on cold miss. */
  priceCache: PriceCache;
  /** Shared taskAgent runner — used by on-demand LLM endpoints (e.g. news.summarize). */
  runner: Runner;
}

export function registerTradingMethods(
  register: (method: string, handler: MethodHandler) => void,
  deps: TradingDeps,
): void {
  const log = deps.logger;
  register("trading.wallets.list", async () => {
    return deps.walletStore.listWallets();
  });

  register("trading.portfolio.get", async (_ctx, payload) => {
    const p = payload as { address?: string } | undefined;
    const wallets = deps.walletStore.listWallets();
    // If specific address requested, use that; otherwise use default
    const target = p?.address
      ? wallets.find((w) => w.address === p.address)
      : (wallets.find((w) => w.isDefault) ?? wallets[0]);
    if (!target) return { connected: false };

    const address = target.address;

    try {
      const [balance, positions, openOrders] = await Promise.all([
        deps.tradingClient.getBalance(address),
        deps.tradingClient.getPositions(address),
        deps.tradingClient.getOpenOrders(address),
      ]);

      return {
        connected: true,
        address,
        testnet: target.testnet,
        status: target.status,
        balance,
        positions,
        openOrders,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ error: msg }, "portfolio.get failed");
      return {
        connected: true,
        address,
        testnet: target.testnet,
        status: target.status,
        error: msg,
        balance: null,
        positions: [],
        openOrders: [],
      };
    }
  });

  register("trading.portfolio.aggregate", async () => {
    const wallets = deps.walletStore.listWallets();
    if (wallets.length === 0) return { connected: false };

    let totalEquity = 0;
    let totalAvailable = 0;
    let totalUnrealizedPnl = 0;
    const allPositions: unknown[] = [];
    const allOrders: unknown[] = [];
    const perWallet: unknown[] = [];

    // Sequential per wallet to avoid Hyperliquid rate limits
    for (const w of wallets) {
      try {
        const [balance, positions, openOrders] = await Promise.all([
          deps.tradingClient.getBalance(w.address),
          deps.tradingClient.getPositions(w.address),
          deps.tradingClient.getOpenOrders(w.address),
        ]);
        totalEquity += balance.totalEquity;
        totalAvailable += balance.availableBalance;
        totalUnrealizedPnl += balance.unrealizedPnl;
        allPositions.push(...positions);
        allOrders.push(...openOrders);
        perWallet.push({ address: w.address, status: w.status, testnet: w.testnet, balance, positions, openOrders });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ address: w.address, error: msg }, "portfolio.aggregate failed");
        perWallet.push({ address: w.address, status: w.status, testnet: w.testnet, balance: null, positions: [], openOrders: [], error: msg });
      }
    }

    return {
      connected: true,
      totalEquity,
      totalAvailable,
      totalUnrealizedPnl,
      positionCount: allPositions.length,
      orderCount: allOrders.length,
      walletCount: wallets.length,
      perWallet,
    };
  });

  register("trading.fills.list", async (_ctx, payload) => {
    // Trade history for the dashboard modal (US 03-04). Accepts:
    //   - address?: scope to one wallet
    //   - all?: aggregate across every wallet (overrides address)
    //   - lookbackHours?: convenience window from now
    //   - startTime?, endTime?: explicit window in ms
    //   - symbol?: filter by coin
    //   - side?: 'buy' | 'sell'
    // Returns fills sorted by timestamp desc, capped at 1000 to keep payloads sane.
    const p = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
    const address = typeof p.address === "string" ? p.address : undefined;
    const all = p.all === true;
    const lookbackHours = typeof p.lookbackHours === "number" && p.lookbackHours > 0 ? p.lookbackHours : undefined;
    const explicitStart = typeof p.startTime === "number" ? p.startTime : undefined;
    const explicitEnd = typeof p.endTime === "number" ? p.endTime : undefined;
    const symbolFilter = typeof p.symbol === "string" && p.symbol.length > 0 ? p.symbol.toUpperCase() : undefined;
    const sideFilter = p.side === "buy" || p.side === "sell" ? p.side : undefined;

    const now = Date.now();
    const endTime = explicitEnd ?? now;
    const startTime = explicitStart ?? (lookbackHours ? endTime - lookbackHours * 3600_000 : endTime - 7 * 24 * 3600_000);

    const wallets = deps.walletStore.listWallets();
    const targets: string[] = all
      ? wallets.map((w) => w.address)
      : address
        ? [address]
        : (wallets.find((w) => w.isDefault)?.address ?? wallets[0]?.address ? [wallets.find((w) => w.isDefault)?.address ?? wallets[0]!.address] : []);

    if (targets.length === 0) return { fills: [], window: { startTime, endTime } };

    const collected: Array<{ walletAddress: string; tradeId: string; symbol: string; side: "buy" | "sell"; price: number; size: number; fee: number; feeToken: string; realizedPnl: number; timestamp: number }> = [];
    for (const addr of targets) {
      try {
        const fills = await deps.tradingClient.getFillsByTime(addr, startTime, endTime);
        for (const f of fills) collected.push({ walletAddress: addr, ...f });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ address: addr, error: msg }, "fills.list failed for wallet");
      }
    }

    // Dedupe by tradeId — paper mode multi-wallet returns the same SQLite-backed
    // fills for every wallet address (engine ignores address), so identical
    // tradeIds appear N times. Live mode rarely sees collisions but harmless.
    const seen = new Set<string>();
    const deduped = collected.filter((f) => (seen.has(f.tradeId) ? false : (seen.add(f.tradeId), true)));

    let filtered = deduped;
    if (symbolFilter) filtered = filtered.filter((f) => f.symbol.toUpperCase() === symbolFilter);
    if (sideFilter) filtered = filtered.filter((f) => f.side === sideFilter);
    filtered.sort((a, b) => b.timestamp - a.timestamp);
    const cap = 1000;
    const capped = filtered.length > cap;
    if (capped) filtered = filtered.slice(0, cap);

    return { fills: filtered, window: { startTime, endTime }, capped };
  });

  register("trading.tokens.list", async () => {
    return deps.tokensSnapshot.build();
  });

  register("trading.price", async (_ctx, payload) => {
    const params = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
    const symbol = typeof params.symbol === "string" ? params.symbol : undefined;
    if (!symbol) return { price: null, symbol: null };
    const resolved = deps.tradingClient.resolveSymbol(symbol);
    // Fast path: serve from in-memory price cache (updated by composite feed).
    const entry = deps.priceCache.get(resolved, 30_000);
    if (entry) return { symbol: resolved, price: entry.price };
    // Cold miss (daemon just started, feed not yet populated): fall back to HL.
    try {
      const ticker = await deps.tradingClient.getTicker(resolved);
      return { symbol: ticker.symbol, price: ticker.markPrice };
    } catch {
      return { price: null, symbol };
    }
  });

  register("trading.intel.coinStats", async (_ctx, payload) => {
    // Per-coin stats for the chart drawer header (marketcap / 24h vol / FDV).
    // Returns the symbol with empty fields for unknown tickers — frontend
    // renders "—" for missing values rather than erroring.
    const params = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
    const symbol = typeof params.symbol === "string" ? params.symbol : undefined;
    const source = params.source === "binance" ? "binance" : "hyperliquid";
    if (!symbol) return { symbol: "", marketCap: undefined, volume24h: undefined, fdv: undefined };
    try {
      return await deps.intel.getCoinStats(symbol, source);
    } catch (err) {
      log.warn({ symbol, source, err }, "trading.intel.coinStats failed");
      return { symbol, marketCap: undefined, volume24h: undefined, fdv: undefined };
    }
  });

  register("trading.watchlist.list", async () => {
    try {
      return { items: deps.watchlist.list() };
    } catch {
      return { items: [] };
    }
  });

  register("trading.watchlist.add", async (_ctx, payload) => {
    const params = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
    const symbol = typeof params.symbol === "string" ? params.symbol : undefined;
    const source = (typeof params.source === "string" ? params.source : "hyperliquid") as PriceSourceId;
    if (!symbol) return { error: "symbol required" };
    const v = validateWatchlistSymbol(source, symbol, deps.tradingClient, deps.binance);
    if (!v.ok) return { error: v.error };
    try {
      return { item: deps.watchlist.add(v.canonical, source) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  register("trading.watchlist.remove", async (_ctx, payload) => {
    const params = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
    const symbol = typeof params.symbol === "string" ? params.symbol : undefined;
    const source = (typeof params.source === "string" ? params.source : "hyperliquid") as PriceSourceId;
    if (!symbol) return { removed: false };
    try {
      const target = canonicalWatchlistSymbol(source, symbol, deps.tradingClient);
      return deps.watchlist.remove(target, source);
    } catch {
      return { removed: false };
    }
  });

  register("trading.alerts.list", async (_ctx, payload) => {
    // Optional `includeFired` returns active + history in one call. Default
    // active-only so the portfolio poll stays cheap.
    const params = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
    const includeFired = params.includeFired === true;
    try {
      return deps.alertRules.list({ includeFired });
    } catch {
      return [];
    }
  });

  register("trading.alerts.remove", async (_ctx, payload) => {
    const params = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
    const id = typeof params.id === "string" ? params.id : undefined;
    if (!id) return { removed: false };
    try {
      return { removed: deps.alertRules.remove(id) };
    } catch {
      return { removed: false };
    }
  });

  // -- Notifications (bell-dropdown feed) --

  register("trading.notifications.list", async (_ctx, payload) => {
    const params = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
    const includeDismissed = params.includeDismissed === true;
    const limit = typeof params.limit === "number" ? Math.min(Math.max(1, params.limit), 500) : 100;
    try {
      return deps.notifications.list({ includeDismissed, limit });
    } catch {
      return [];
    }
  });

  register("trading.notifications.dismiss", async (_ctx, payload) => {
    const params = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
    const id = typeof params.id === "string" ? params.id : undefined;
    if (!id) return { dismissed: false };
    try {
      return { dismissed: deps.notifications.dismiss(id) };
    } catch {
      return { dismissed: false };
    }
  });

  // -- News methods --

  register("trading.news.list", async (_ctx, payload) => {
    const p = payload as {
      limit?: number;
      offset?: number;
      importance?: string;
      coins?: string[];
      beforePublishedAt?: number;
      beforeId?: string;
      afterPublishedAt?: number;
      afterId?: string;
    } | undefined;
    const importance = p?.importance as Importance | undefined;
    return {
      articles: deps.newsService.getArticles({
        limit: p?.limit ?? 20,
        offset: p?.offset,
        importance,
        coins: p?.coins,
        beforePublishedAt: p?.beforePublishedAt,
        beforeId: p?.beforeId,
        afterPublishedAt: p?.afterPublishedAt,
        afterId: p?.afterId,
      }),
      total: deps.newsService.countArticles({ importance, coins: p?.coins }),
    };
  });

  register("trading.news.dismiss", async (_ctx, payload) => {
    const p = payload as { articleId: string };
    if (!p?.articleId) return { ok: false, error: "Missing articleId" };
    const dismissed = deps.newsService.dismissArticle(p.articleId);
    return dismissed ? { ok: true } : { ok: false, error: "Article not found" };
  });

  register("trading.news.sources.list", async () => {
    // Strip apiKey from the wire response — gateway has no in-app auth, so
    // returning raw credentials would expose them to any client that can reach
    // the port (LAN attacker, DNS-rebind from browser tab).
    const sources = deps.newsService.getSources().map(({ apiKey: _apiKey, ...rest }) => rest);
    return { sources };
  });

  register("trading.news.sources.toggle", async (_ctx, payload) => {
    const p = payload as { sourceId: string; enabled: boolean };
    if (!p?.sourceId || typeof p.enabled !== "boolean") return { ok: false, error: "Missing sourceId or enabled" };

    deps.newsService.toggleSource(p.sourceId, p.enabled);

    const remaining = deps.newsService.getSources().filter((s) => s.enabled);
    return { ok: true, warning: remaining.length === 0 ? "News feed will be empty until a source is enabled." : undefined };
  });

  register("trading.news.sources.setKey", async (_ctx, payload) => {
    const p = payload as { sourceId: string; apiKey: string };
    if (!p?.sourceId || !p?.apiKey) return { ok: false, error: "Missing sourceId or apiKey" };
    await deps.newsService.setSourceApiKey(p.sourceId, p.apiKey);
    return { ok: true };
  });

  // -- Tweets methods --

  register("trading.tweets.list", async (_ctx, payload) => {
    const p = payload as {
      limit?: number;
      beforePublishedAt?: number;
      beforeId?: string;
      afterPublishedAt?: number;
      afterId?: string;
      username?: string;
    } | undefined;
    if (!deps.tweetService) return { tweets: [], total: 0 };
    return {
      tweets: deps.tweetService.getTweets({
        limit: p?.limit ?? 20,
        username: p?.username,
        beforePublishedAt: p?.beforePublishedAt,
        beforeId: p?.beforeId,
        afterPublishedAt: p?.afterPublishedAt,
        afterId: p?.afterId,
      }),
      total: deps.tweetService.countTweets({ username: p?.username }),
    };
  });

  register("trading.tweets.dismiss", async (_ctx, payload) => {
    const p = payload as { id: string };
    if (!p?.id || !deps.tweetService) return { ok: false, error: "Missing id" };
    deps.tweetService.dismissTweet(p.id);
    return { ok: true };
  });

  register("trading.tweets.hasAuth", async () => {
    if (!deps.xFollowService) return { hasAuth: false };
    return { hasAuth: await deps.xFollowService.hasAuth() };
  });

  register("trading.tweets.status", async () => {
    if (!deps.xFollowService) {
      return {
        hasAuth: false,
        authUser: null,
        follows: [],
        includeFollowing: false,
        fetchState: "idle" as const,
        followingCount: null,
      };
    }
    const hasAuth = await deps.xFollowService.hasAuth();
    const authUser = hasAuth ? await deps.xFollowService.getAuthUser() : null;
    // Per-row `enabled` + `source` powers the redesigned "Manage follower"
    // modal (per-account multi-select + auto-imported source badge). Older
    // web builds ignore the extra fields — backward-compatible.
    const follows = deps.xFollowService.list().map((f) => ({
      username: f.username,
      displayName: f.displayName,
      enabled: f.enabled,
      source: f.source,
    }));
    const includeFollowing = await deps.xFollowService.getIncludeFollowing();
    const fetchState = deps.xFollowService.getFetchState();
    // Skip Following resolution when not authed — saves one X round-trip per
    // status call and avoids a noisy warn log on every poll for the
    // unauthenticated case.
    const followingCount = hasAuth ? await deps.xFollowService.getFollowingCount() : null;
    return { hasAuth, authUser, follows, includeFollowing, fetchState, followingCount };
  });

  register("trading.tweets.settings.set", async (_ctx, payload) => {
    const p = payload as { includeFollowing?: boolean };
    if (!deps.xFollowService) return { ok: false, error: "X service not available" };
    if (typeof p?.includeFollowing === "boolean") {
      await deps.xFollowService.setIncludeFollowing(p.includeFollowing);
      if (p.includeFollowing) deps.xFollowService.triggerFetch();
    }
    return { ok: true };
  });

  register("trading.tweets.auth", async (_ctx, payload) => {
    const p = payload as { auth_token: string; ct0: string };
    if (!p?.auth_token || !p?.ct0 || !deps.xFollowService) return { ok: false, error: "Missing credentials" };
    try {
      const user = await deps.xFollowService.auth(p.auth_token, p.ct0);
      // Trigger an immediate fetch if the user has the "include following" toggle ON
      // so first-time connect populates the feed without waiting for the next scheduler tick.
      // Race against a 3 s deadline: if the fetch completes in time the response already
      // reflects a populated feed; otherwise fall back to fire-and-forget (the widget's
      // ~5 s poll picks it up) so we don't block the UI on a slow Following fetch.
      if (await deps.xFollowService.getIncludeFollowing()) {
        const fetchPromise = deps.xFollowService.triggerFetch();
        await Promise.race([
          fetchPromise,
          new Promise<void>((resolve) => setTimeout(resolve, 3000)),
        ]);
        // Keep the fetch alive past the deadline — swallow errors so we don't
        // reject an already-resolved handler or crash the daemon.
        fetchPromise.catch(() => {});
      }
      return { ok: true, user };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  register("trading.tweets.unlink", async () => {
    if (!deps.xFollowService) return { ok: false, error: "X service unavailable" };
    try {
      await deps.xFollowService.unlinkAuth();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  register("trading.tweets.follows.list", async () => {
    if (!deps.xFollowService) return { follows: [] };
    return {
      follows: deps.xFollowService.list().map((f) => ({
        username: f.username, displayName: f.displayName,
      })),
    };
  });

  register("trading.tweets.follows.add", async (_ctx, payload) => {
    const p = payload as { username: string };
    if (!p?.username || !deps.xFollowService) return { ok: false, error: "Missing username" };
    const { added, notFound } = await deps.xFollowService.follow(p.username);
    if (notFound) return { ok: false, error: `@${p.username} not found` };
    if (!added) return { ok: false, error: `Already following @${p.username}` };
    deps.xFollowService.triggerFetch();
    return { ok: true };
  });

  register("trading.tweets.follows.remove", async (_ctx, payload) => {
    const p = payload as { username: string };
    if (!p?.username || !deps.xFollowService) return { ok: false, error: "Missing username" };
    deps.xFollowService.unfollow(p.username);
    return { ok: true };
  });

  // Flip the per-account enabled flag. Persisted immediately by the service;
  // the next fetch cycle will skip muted rows. Pure SQLite write — no X call.
  register("trading.tweets.follows.setEnabled", async (_ctx, payload) => {
    const p = payload as { username?: unknown; enabled?: unknown };
    if (typeof p?.username !== "string" || !p.username.trim()) {
      return { ok: false, error: "Missing username" };
    }
    if (typeof p?.enabled !== "boolean") {
      return { ok: false, error: "Missing enabled flag" };
    }
    if (!deps.xFollowService) return { ok: false, error: "X service unavailable" };
    const changed = deps.xFollowService.setEnabled(p.username, p.enabled);
    if (!changed) return { ok: false, error: `Account @${p.username} not tracked` };
    return { ok: true };
  });

  // Substring search over (a) the tracked list and (b) the user's X.com
  // Following list. Returns two parallel arrays so the modal can render the
  // "Followed" + "Not Follow" sub-sections without further filtering.
  register("trading.tweets.follows.search", async (_ctx, payload) => {
    const p = payload as { query?: unknown };
    if (typeof p?.query !== "string") return { followed: [], notFollow: [] };
    if (!deps.xFollowService) return { followed: [], notFollow: [] };
    const { followed, notFollow } = await deps.xFollowService.search(p.query);
    return {
      followed: followed.map((f) => ({
        username: f.username,
        displayName: f.displayName,
        enabled: f.enabled,
        source: f.source,
      })),
      notFollow: notFollow.map((u) => ({
        username: u.username,
        displayName: u.displayName,
      })),
    };
  });

  // Auto-discover RSS/Atom feed candidates for a given site URL.
  // Returns candidates in the shape consumed by the web "Add feed" flow.
  // The discoverer itself enforces URL safety (SSRF guard, scheme allow-list,
  // 8 s fetch timeout, redirect blocking) — see RssDiscoveryService.
  register("trading.news.sources.discover", async (_ctx, payload) => {
    const p = payload as { site?: unknown };
    const site = typeof p?.site === "string" ? p.site.trim() : "";
    if (!site) return { ok: false, error: "Missing site URL" };
    // Cap input length to avoid abuse — discovery never legitimately needs more.
    if (site.length > 2048) return { ok: false, error: "Site URL too long" };
    if (!deps.rssDiscovery) return { ok: false, error: "RSS discovery unavailable" };
    try {
      const candidates = await deps.rssDiscovery.discover(site);
      return {
        candidates: candidates.map((c) => ({ name: c.title, url: c.url, source: c.source })),
      };
    } catch (err) {
      // Log the real cause server-side; return a generic message to the
      // client so internal error strings (incl. stack-trace fragments) don't
      // leak across the RPC boundary.
      log.warn({ site, err }, "trading.news.sources.discover failed");
      return { ok: false, error: "Discovery failed" };
    }
  });

  register("trading.news.sources.addCustom", async (_ctx, payload) => {
    const p = payload as { url: string; name: string };
    if (!p?.url || !p?.name) return { ok: false, error: "Missing url or name" };
    return deps.newsService.addCustomRss(p.url, p.name);
  });

  register("trading.news.sources.remove", async (_ctx, payload) => {
    const p = payload as { sourceId: string };
    if (!p?.sourceId) return { ok: false, error: "Missing sourceId" };
    const removed = deps.newsService.removeCustomSource(p.sourceId);
    return removed ? { ok: true } : { ok: false, error: "Source not found or is a preset" };
  });

  // -- Filter prompt methods (per-feed, web-only) --
  // When no override is stored, the getter returns the built-in default so
  // the UI can show the actual prompt the evaluator is currently using.
  // Empty input on set clears the override; the evaluator then falls back to
  // its built-in default selector on the next tick.

  register("trading.news.filter.get", async () => {
    const override = deps.preferenceStore.getNewsFilterPrompt();
    return { prompt: override ?? DEFAULT_NEWS_FILTER_INSTRUCTION };
  });

  register("trading.news.filter.set", async (_ctx, payload) => {
    const p = payload as { prompt?: unknown };
    if (typeof p?.prompt !== "string") return { ok: false, error: "Missing prompt" };
    const trimmed = p.prompt.trim();
    if (trimmed.length > FILTER_PROMPT_MAX) {
      return { ok: false, error: `Prompt exceeds ${FILTER_PROMPT_MAX} characters` };
    }
    deps.preferenceStore.setNewsFilterPrompt(trimmed);
    return { ok: true };
  });

  register("trading.tweets.filter.get", async () => {
    const override = deps.preferenceStore.getTweetFilterPrompt();
    return { prompt: override ?? DEFAULT_TWEET_FILTER_INSTRUCTION };
  });

  register("trading.tweets.filter.set", async (_ctx, payload) => {
    const p = payload as { prompt?: unknown };
    if (typeof p?.prompt !== "string") return { ok: false, error: "Missing prompt" };
    const trimmed = p.prompt.trim();
    if (trimmed.length > FILTER_PROMPT_MAX) {
      return { ok: false, error: `Prompt exceeds ${FILTER_PROMPT_MAX} characters` };
    }
    deps.preferenceStore.setTweetFilterPrompt(trimmed);
    return { ok: true };
  });

  register("trading.news.filter.enabled.get", async () => {
    return { enabled: deps.preferenceStore.getNewsFilterEnabled() };
  });

  register("trading.news.filter.enabled.set", async (_ctx, payload) => {
    const p = payload as { enabled?: unknown };
    if (typeof p?.enabled !== "boolean") return { ok: false, error: "Missing enabled flag" };
    deps.preferenceStore.setNewsFilterEnabled(p.enabled);
    return { ok: true };
  });

  register("trading.tweets.filter.enabled.get", async () => {
    return { enabled: deps.preferenceStore.getTweetFilterEnabled() };
  });

  register("trading.tweets.filter.enabled.set", async (_ctx, payload) => {
    const p = payload as { enabled?: unknown };
    if (typeof p?.enabled !== "boolean") return { ok: false, error: "Missing enabled flag" };
    deps.preferenceStore.setTweetFilterEnabled(p.enabled);
    return { ok: true };
  });

  register("trading.news.summarize", async (_ctx, payload) => {
    const p = payload as { articleId?: unknown };
    if (typeof p?.articleId !== "string" || p.articleId.length === 0) {
      return { ok: false, error: "Missing articleId" };
    }
    const article = deps.newsService.getArticle(p.articleId);
    if (!article) return { ok: false, error: "Article not found" };

    if (article.summary && article.summary.length > 0) {
      return { ok: true, summary: article.summary, cached: true };
    }

    const body = article.body;
    if (!body || body.length < 100) {
      return { ok: false, error: "Article body unavailable" };
    }

    // Body may be HTML — strip tags to plain text for the LLM prompt.
    const plain = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (plain.length < 100) return { ok: false, error: "Article body unavailable" };

    let raw: string;
    try {
      raw = await deps.runner.call({
        systemPrompt: NEWS_DEEPSUMMARY_SYSTEM,
        message: buildDeepSummaryPrompt(article.title, plain),
      });
    } catch (err) {
      log.warn({ err, articleId: article.id }, "news.summarize LLM call failed");
      return { ok: false, error: "Summarize failed" };
    }

    const summary = raw.trim();
    if (summary.length === 0) {
      return { ok: false, error: "Summarize returned empty text" };
    }
    deps.newsService.saveSummary(article.id, summary);
    return { ok: true, summary, cached: false };
  });
}
