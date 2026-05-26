/**
 * Intel service — consolidated CoinGecko + DefiLlama + Alternative.me adapters.
 */

import type { ITradingClient } from "./interfaces/trading-client.js";
import type { BinanceService } from "./binance.js";

export type CoinStatsSource = "hyperliquid" | "binance";

// ─── Types ───

export interface FearGreedData {
  value: number;
  classification: string;
  timestamp: number;
  history?: { value: number; classification: string; timestamp: number }[];
}

export interface MarketOverview {
  totalMarketCap: number;
  totalVolume24h: number;
  btcDominance: number;
  ethDominance: number;
  marketCapChangePct24h: number;
}

export interface TrendingCoin {
  id: string;
  symbol: string;
  name: string;
  rank: number;
  price: number;
  priceChangePct24h: number;
  marketCap: number;
}

export interface TVLData {
  chain?: string;
  protocol?: string;
  tvl: number;
  tvlChangePct1d: number;
  tvlChangePct7d: number;
}

export interface StablecoinData {
  name: string;
  symbol: string;
  supply: number;
  supplyChangePct7d: number;
}

export interface FullOverview {
  fearGreed: FearGreedData | null;
  market: MarketOverview | null;
  trending: TrendingCoin[];
  totalTvl: number;
  stablecoinSupply: number;
}

export interface CoinStats {
  symbol: string;
  marketCap?: number;
  volume24h?: number;
  fdv?: number;
  priceChangePct24h?: number;
  openInterest?: number;
}

// ─── Helpers ───

/** Source-native symbol → CoinGecko search ticker. HL stores base tickers
 *  directly ("BTC"); Binance USDⓈ-M perps suffix "USDT" — strip it so CG
 *  resolves the same coin id for both sources. */
function cgTickerFor(symbol: string, source: CoinStatsSource): string {
  if (source === "binance" && symbol.endsWith("USDT") && symbol.length > 4) {
    return symbol.slice(0, -4);
  }
  return symbol;
}

// ─── Service ───

export class IntelService {
  // Per-symbol coin-stats cache. CoinGecko free tier rate-limits aggressively
  // (~30 req/min); 60 s TTL keeps the drawer snappy without hammering the API.
  private coinStatsCache = new Map<string, { value: CoinStats; expiresAt: number }>();
  private static COIN_STATS_TTL_MS = 60_000;

  // Permanent ticker → CG id resolution. `null` = searched and no match
  // (negative-cache, don't retry). Survives until process restart.
  private cgIdCache = new Map<string, string | null>();
  // De-dupes concurrent `/search` calls for the same ticker (e.g. drawer
  // opened twice for the same symbol before the first resolved).
  private cgIdInflight = new Map<string, Promise<string | null>>();

  constructor(
    private tradingClient?: ITradingClient,
    private binance?: BinanceService,
  ) {}

  // ─── Alternative.me: Fear & Greed ───

  async getFearGreed(days = 7): Promise<FearGreedData> {
    const res = await fetch(`https://api.alternative.me/fng/?limit=${days + 1}&format=json`);
    if (!res.ok) throw new Error(`Alternative.me: ${res.status}`);
    const data = await res.json() as any;
    const entries = data.data ?? [];
    if (entries.length === 0) throw new Error("No Fear & Greed data");

    const current = entries[0];
    return {
      value: parseInt(current.value),
      classification: current.value_classification,
      timestamp: parseInt(current.timestamp) * 1000,
      history: entries.slice(1).map((e: any) => ({
        value: parseInt(e.value),
        classification: e.value_classification,
        timestamp: parseInt(e.timestamp) * 1000,
      })),
    };
  }

  // ─── CoinGecko: Market overview ───

  private async cg(endpoint: string, params: Record<string, string> = {}): Promise<unknown> {
    const qs = new URLSearchParams(params).toString();
    const url = `https://api.coingecko.com/api/v3${endpoint}${qs ? "?" + qs : ""}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.status === 429) throw new Error("CoinGecko rate limit. Try again in a minute.");
    if (!res.ok) throw new Error(`CoinGecko ${endpoint}: ${res.status}`);
    return res.json();
  }

  async getMarketOverview(): Promise<MarketOverview> {
    const data = await this.cg("/global") as any;
    const d = data.data;
    return {
      totalMarketCap: d.total_market_cap?.usd ?? 0,
      totalVolume24h: d.total_volume?.usd ?? 0,
      btcDominance: d.market_cap_percentage?.btc ?? 0,
      ethDominance: d.market_cap_percentage?.eth ?? 0,
      marketCapChangePct24h: d.market_cap_change_percentage_24h_usd ?? 0,
    };
  }

  async getTrending(): Promise<TrendingCoin[]> {
    const data = await this.cg("/search/trending") as any;
    return (data.coins ?? []).slice(0, 10).map((c: any) => {
      const item = c.item;
      return {
        id: item.id,
        symbol: (item.symbol ?? "").toUpperCase(),
        name: item.name,
        rank: item.market_cap_rank ?? 0,
        price: item.data?.price ?? 0,
        priceChangePct24h: item.data?.price_change_percentage_24h?.usd ?? 0,
        marketCap: parseFloat((item.data?.market_cap ?? "0").replace(/[^0-9.]/g, "")) || 0,
      };
    });
  }

  // ─── DefiLlama: TVL + Stablecoins ───

  private async dl(url: string): Promise<unknown> {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`DefiLlama: ${res.status}`);
    return res.json();
  }

  async getTotalTVL(): Promise<number> {
    const data = await this.dl("https://api.llama.fi/v2/historicalChainTvl") as any[];
    if (!data.length) return 0;
    return data[data.length - 1].tvl ?? 0;
  }

  async getTVLByChain(limit = 10): Promise<TVLData[]> {
    const data = await this.dl("https://api.llama.fi/v2/chains") as any[];
    return data
      .sort((a: any, b: any) => (b.tvl ?? 0) - (a.tvl ?? 0))
      .slice(0, limit)
      .map((c: any) => ({
        chain: c.name,
        tvl: c.tvl ?? 0,
        tvlChangePct1d: c.change_1d ?? 0,
        tvlChangePct7d: c.change_7d ?? 0,
      }));
  }

  async getStablecoins(): Promise<StablecoinData[]> {
    const data = await this.dl("https://stablecoins.llama.fi/stablecoins?includePrices=false") as any;
    return (data.peggedAssets ?? [])
      .sort((a: any, b: any) => (b.circulating?.peggedUSD ?? 0) - (a.circulating?.peggedUSD ?? 0))
      .slice(0, 10)
      .map((s: any) => {
        const supply = s.circulating?.peggedUSD ?? 0;
        const prevWeek = s.circulatingPrevWeek?.peggedUSD ?? supply;
        return {
          name: s.name,
          symbol: s.symbol,
          supply,
          supplyChangePct7d: prevWeek > 0 ? Math.round(((supply - prevWeek) / prevWeek) * 10000) / 100 : 0,
        };
      });
  }

  // ─── Per-coin stats (chart drawer header) ───

  /** Fetch marketcap / 24h volume / FDV / open interest for a single symbol.
   *  Marketcap + FDV + 24h price change come from CoinGecko (cross-venue
   *  aggregates); **OI and 24h volume are venue-native** — sourced from the
   *  HL trading client when `source === "hyperliquid"` and from Binance fapi
   *  when `source === "binance"`. This matches what the user sees on the
   *  source's own trading UI rather than a mixed-exchange aggregate.
   *
   *  `symbol` is source-native — HL "BTC" / Binance "BTCUSDT". For CG lookup
   *  we normalize to a base ticker (strip trailing "USDT" for Binance) so
   *  both sources resolve to the same coin id. Returns symbol with empty
   *  fields on unknown tickers — the UI handles missing values. */
  async getCoinStats(symbol: string, source: CoinStatsSource = "hyperliquid"): Promise<CoinStats> {
    const upper = symbol.toUpperCase();
    const cacheKey = `${source}:${upper}`;
    const cached = this.coinStatsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const cgTicker = cgTickerFor(upper, source);
    const venue = source === "binance"
      ? await this.fetchBinanceVenueStats(upper)
      : await this.fetchHlVenueStats(upper);

    const cgId = await this.resolveCgId(cgTicker);
    if (!cgId) {
      const stats: CoinStats = {
        symbol: upper,
        openInterest: venue.openInterest,
        volume24h: venue.volume24h,
      };
      this.coinStatsCache.set(cacheKey, {
        value: stats,
        expiresAt: Date.now() + IntelService.COIN_STATS_TTL_MS,
      });
      return stats;
    }

    try {
      const data = await this.cg("/coins/markets", {
        ids: cgId, vs_currency: "usd", price_change_percentage: "24h",
      }) as Array<Record<string, unknown>>;
      const row = data[0];
      const stats: CoinStats = {
        symbol: upper,
        marketCap: typeof row?.market_cap === "number" ? row.market_cap : undefined,
        // Venue-native volume preferred; CG aggregate only used as a fallback
        // when the venue endpoint failed.
        volume24h: venue.volume24h
          ?? (typeof row?.total_volume === "number" ? row.total_volume : undefined),
        fdv: typeof row?.fully_diluted_valuation === "number" ? row.fully_diluted_valuation : undefined,
        priceChangePct24h: typeof row?.price_change_percentage_24h === "number"
          ? row.price_change_percentage_24h
          : undefined,
        openInterest: venue.openInterest,
      };
      this.coinStatsCache.set(cacheKey, {
        value: stats,
        expiresAt: Date.now() + IntelService.COIN_STATS_TTL_MS,
      });
      return stats;
    } catch {
      return { symbol: upper, openInterest: venue.openInterest, volume24h: venue.volume24h };
    }
  }

  /** Resolve a ticker (e.g. "BTC", "TRUMP") to its CoinGecko slug id (e.g.
   *  "bitcoin", "official-trump") via `/search?query=…`. Cached permanently per
   *  process — including negative results so we don't re-search unknown tickers.
   *  Tickers shared by multiple coins (e.g. "UNI") resolve to the highest-
   *  market-cap match. CG keeps legacy slugs serving even after renames, so
   *  exact-symbol match handles most cases; tickers that CG itself renamed
   *  (e.g. MATIC → POL) may return null. */
  private async resolveCgId(upper: string): Promise<string | null> {
    if (this.cgIdCache.has(upper)) return this.cgIdCache.get(upper) ?? null;
    const inflight = this.cgIdInflight.get(upper);
    if (inflight) return inflight;

    const promise = this.searchCgId(upper)
      .then((id) => {
        this.cgIdCache.set(upper, id);
        return id;
      })
      .catch(() => null)
      .finally(() => { this.cgIdInflight.delete(upper); });
    this.cgIdInflight.set(upper, promise);
    return promise;
  }

  private async searchCgId(upper: string): Promise<string | null> {
    const data = await this.cg("/search", { query: upper }) as { coins?: Array<Record<string, unknown>> };
    const matches = (data.coins ?? []).filter(
      (c) => typeof c.symbol === "string" && (c.symbol as string).toUpperCase() === upper,
    );
    if (matches.length === 0) return null;
    // CG returns market_cap_rank ascending = higher cap; nulls (no rank) sink.
    matches.sort((a, b) => {
      const ra = typeof a.market_cap_rank === "number" ? a.market_cap_rank : Number.POSITIVE_INFINITY;
      const rb = typeof b.market_cap_rank === "number" ? b.market_cap_rank : Number.POSITIVE_INFINITY;
      return ra - rb;
    });
    const best = matches[0];
    return typeof best?.id === "string" ? (best.id as string) : null;
  }

  /** Pull OI (USD = tokens × markPrice) AND 24h notional volume from a single
   *  HL ticker call. Both fields are independently `undefined` when the
   *  trading client is missing or the symbol isn't in the HL perp universe. */
  private async fetchHlVenueStats(
    symbol: string,
  ): Promise<{ openInterest?: number; volume24h?: number }> {
    const client = this.tradingClient;
    if (!client) return {};
    try {
      const resolved = client.resolveSymbol(symbol);
      if (!client.isKnownSymbol(resolved)) return {};
      const ticker = await client.getTicker(resolved);
      const oi = ticker.openInterest * ticker.markPrice;
      return {
        openInterest: Number.isFinite(oi) && oi > 0 ? oi : undefined,
        volume24h: Number.isFinite(ticker.volume24h) && ticker.volume24h > 0
          ? ticker.volume24h
          : undefined,
      };
    } catch {
      return {};
    }
  }

  /** Pull OI (USD) AND 24h quote volume (USDT ≈ USD) from Binance fapi.
   *  Delegated to BinanceService.getVenueStats which parallelizes the two
   *  fapi calls and caches the result. */
  private async fetchBinanceVenueStats(
    symbol: string,
  ): Promise<{ openInterest?: number; volume24h?: number }> {
    if (!this.binance) return {};
    const v = await this.binance.getVenueStats(symbol);
    return { openInterest: v.openInterestUsd, volume24h: v.volume24hUsd };
  }

  // ─── Composite overview ───

  async getOverview(): Promise<FullOverview> {
    const [fearGreed, market, trending, tvl, stables] = await Promise.allSettled([
      this.getFearGreed(),
      this.getMarketOverview(),
      this.getTrending(),
      this.getTotalTVL(),
      this.getStablecoins(),
    ]);

    return {
      fearGreed: fearGreed.status === "fulfilled" ? fearGreed.value : null,
      market: market.status === "fulfilled" ? market.value : null,
      trending: trending.status === "fulfilled" ? trending.value : [],
      totalTvl: tvl.status === "fulfilled" ? tvl.value : 0,
      stablecoinSupply: stables.status === "fulfilled"
        ? stables.value.reduce((sum, s) => sum + s.supply, 0) : 0,
    };
  }
}

