/**
 * BinanceService — unified Binance USDⓈ-M perpetual data access.
 *
 *   - Universe: `load()` / `list()` / `has()` — exchangeInfo cache used by
 *     tokens-snapshot + watchlist add validation.
 *   - Klines: `getKlines(symbol, interval, limit)` — used by the chart-data
 *     REST endpoint when the row source is Binance.
 *
 * Inputs are always source-native (e.g. `BTCUSDT`).
 */

import type { Logger } from "pino";
import type { Kline } from "./interfaces/trading-types.js";

const EXCHANGE_INFO_URL = "https://fapi.binance.com/fapi/v1/exchangeInfo";
const KLINES_URL = "https://fapi.binance.com/fapi/v1/klines";
const TICKER_24HR_URL = "https://fapi.binance.com/fapi/v1/ticker/24hr";
const OPEN_INTEREST_URL = "https://fapi.binance.com/fapi/v1/openInterest";
const FETCH_TIMEOUT_MS = 10_000;
const VENUE_STATS_TTL_MS = 30_000;

export interface BinanceUniverseEntry {
  /** Binance-native, e.g. "BTCUSDT". */
  symbol: string;
}

/** Minimal fetch signature — tests stub this without recreating `typeof fetch`. */
export type FetchLike = (input: string | URL, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface BinanceServiceOptions {
  logger: Logger;
  fetchFn?: FetchLike;
}

interface ExchangeInfoSymbol {
  symbol: string;
  contractType?: string;
  status?: string;
  quoteAsset?: string;
}

interface Ticker24hrRow {
  symbol: string;
  lastPrice: string;
  openPrice: string;
}

export interface BinanceTickerSnapshot {
  symbol: string;
  price: number;
  prevDayPrice?: number;
}

export interface BinanceVenueStats {
  /** Open interest in USD = OI tokens × lastPrice. Undefined when either
   *  fapi endpoint fails or the response is malformed. */
  openInterestUsd?: number;
  /** 24h quote volume in USDT (≈ USD) — Binance `ticker/24hr.quoteVolume`. */
  volume24hUsd?: number;
}

export class BinanceService {
  private readonly log: Logger;
  private readonly fetchFn: FetchLike;
  private symbols: BinanceUniverseEntry[] = [];
  private symbolSet = new Set<string>();
  /** Venue stats (OI in USD + 24h quote volume) per symbol, short-TTL cached
   *  so the chart drawer doesn't spam fapi on every reopen. */
  private venueStatsCache = new Map<string, { value: BinanceVenueStats; expiresAt: number }>();

  constructor(opts: BinanceServiceOptions) {
    this.log = opts.logger;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  /** Re-fetch and replace the cached universe. Errors are swallowed and logged
   *  so the daemon can boot even if Binance is unreachable. */
  async load(): Promise<void> {
    try {
      const res = await this.fetchFn(EXCHANGE_INFO_URL);
      if (!res.ok) {
        this.log.warn({ status: res.status }, "binance exchangeInfo non-200");
        return;
      }
      const body = (await res.json()) as { symbols?: ExchangeInfoSymbol[] };
      const entries: BinanceUniverseEntry[] = [];
      for (const s of body.symbols ?? []) {
        if (s.contractType !== "PERPETUAL") continue;
        if (s.status !== "TRADING") continue;
        if (s.quoteAsset && s.quoteAsset !== "USDT") continue;
        entries.push({ symbol: s.symbol });
      }
      entries.sort((a, b) => a.symbol.localeCompare(b.symbol));
      this.symbols = entries;
      this.symbolSet = new Set(entries.map((e) => e.symbol));
      this.log.info({ count: entries.length }, "binance universe refreshed");
    } catch (err) {
      this.log.warn({ err }, "binance universe refresh failed");
    }
  }

  list(): ReadonlyArray<BinanceUniverseEntry> {
    return this.symbols;
  }

  has(symbol: string): boolean {
    return this.symbolSet.has(symbol);
  }

  /** One-shot snapshot of 24h ticker for ALL USDⓈ-M perps. Used at gateway
   *  startup to seed the watchlist UI BEFORE WS frames arrive — without this,
   *  Binance rows render "--" for 1-3s while the WS connects + emits its
   *  first miniTicker frame.
   *
   *  Cannot be replaced by BinanceSource's REST fallback: that path only
   *  activates after `wsStaleMs` (default 10s) of no WS ticks, which is
   *  too slow to bridge the cold-start window. This call runs synchronously
   *  during gateway boot, fully populating the cache before the first
   *  frontend connect. Errors swallowed (boot must not fail on Binance outage). */
  async fetchTickers24hr(): Promise<BinanceTickerSnapshot[]> {
    try {
      const res = await this.fetchFn(TICKER_24HR_URL);
      if (!res.ok) {
        this.log.warn({ status: res.status }, "binance ticker24hr non-200");
        return [];
      }
      const body = (await res.json()) as Ticker24hrRow[] | undefined;
      if (!Array.isArray(body)) return [];
      const out: BinanceTickerSnapshot[] = [];
      for (const t of body) {
        const price = parseFloat(t.lastPrice);
        if (!Number.isFinite(price)) continue;
        const prev = parseFloat(t.openPrice);
        const prevDayPrice = Number.isFinite(prev) && prev > 0 ? prev : undefined;
        out.push({ symbol: t.symbol, price, prevDayPrice });
      }
      return out;
    } catch (err) {
      this.log.warn({ err }, "binance ticker24hr fetch failed");
      return [];
    }
  }

  /** Fetch venue-native OI (USD) + 24h quote volume (USDT) for a NATIVE
   *  Binance symbol (e.g. "BTCUSDT"). Two parallel fapi calls:
   *    - `/openInterest`  → tokens (we multiply by ticker24hr lastPrice → USD)
   *    - `/ticker/24hr`   → quoteVolume (USDT, already USD-equivalent) + lastPrice
   *  Short-TTL cached. Each field returns undefined independently on failure
   *  so a partial outage still surfaces whichever stat resolved. */
  async getVenueStats(symbol: string): Promise<BinanceVenueStats> {
    const cached = this.venueStatsCache.get(symbol);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    try {
      const [oiTokens, ticker] = await Promise.all([
        this.fetchOpenInterestTokens(symbol),
        this.fetchTicker24hr(symbol),
      ]);
      const lastPrice = ticker?.lastPrice;
      const openInterestUsd = oiTokens != null && lastPrice != null
        ? finitePositive(oiTokens * lastPrice)
        : undefined;
      const value: BinanceVenueStats = {
        openInterestUsd,
        volume24hUsd: ticker?.quoteVolume,
      };
      this.venueStatsCache.set(symbol, {
        value,
        expiresAt: Date.now() + VENUE_STATS_TTL_MS,
      });
      return value;
    } catch (err) {
      this.log.warn({ err, symbol }, "binance venue stats fetch failed");
      return {};
    }
  }

  private async fetchOpenInterestTokens(symbol: string): Promise<number | undefined> {
    const url = new URL(OPEN_INTEREST_URL);
    url.searchParams.set("symbol", symbol);
    const res = await this.fetchFn(url);
    if (!res.ok) return undefined;
    const body = (await res.json()) as { openInterest?: string };
    return finitePositive(parseFloat(body.openInterest ?? ""));
  }

  private async fetchTicker24hr(
    symbol: string,
  ): Promise<{ lastPrice?: number; quoteVolume?: number } | undefined> {
    const url = new URL(TICKER_24HR_URL);
    url.searchParams.set("symbol", symbol);
    const res = await this.fetchFn(url);
    if (!res.ok) return undefined;
    const body = (await res.json()) as { lastPrice?: string; quoteVolume?: string };
    return {
      lastPrice: finitePositive(parseFloat(body.lastPrice ?? "")),
      quoteVolume: finitePositive(parseFloat(body.quoteVolume ?? "")),
    };
  }

  /** Fetch klines for a NATIVE Binance symbol (e.g. "BTCUSDT"). Throws on failure. */
  async getKlines(symbol: string, interval: string, limit: number): Promise<Kline[]> {
    const url = new URL(KLINES_URL);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", String(limit));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await this.fetchFn(url, { signal: controller.signal });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Binance klines HTTP ${res.status}: ${text}`);
      }
      return parseKlinePayload(await res.json());
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseKlineRow(row: unknown): Kline {
  if (!Array.isArray(row) || row.length < 6) {
    throw new Error("Malformed Binance kline row");
  }
  return {
    openTime: Number(row[0]),
    open: parseFloat(row[1] as string),
    high: parseFloat(row[2] as string),
    low: parseFloat(row[3] as string),
    close: parseFloat(row[4] as string),
    volume: parseFloat(row[5] as string),
  };
}

function finitePositive(n: number): number | undefined {
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseKlinePayload(payload: unknown): Kline[] {
  if (!Array.isArray(payload)) {
    throw new Error("Binance klines: expected array payload");
  }
  return payload.map(parseKlineRow);
}
