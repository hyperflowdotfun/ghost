/**
 * TokensSnapshotService — builds the token list + price snapshot for the
 * `trading.tokens.list` RPC entirely from in-memory state.
 *
 * Consumer is the watchlist add-drawer; the snapshot is intentionally
 * single-class (not split per source) because both source projections feed
 * one UI surface and ordering / dedup happens at projection time.
 *
 * Dual cache by design:
 *   - `hlPriceCache` (PriceCache) — populated by the trading-path composite
 *     feed; also consumed by chat tools, alerts, order execution. Sharing
 *     it here avoids duplicating HL ticks across two caches.
 *   - `watchlistPriceCache` — populated by WatchlistPriceFeed (Binance mini
 *     stream). View-only; kept separate from the trading cache so Binance
 *     ticks don't pollute HL-canonical reads (different symbol namespace).
 *
 * No network calls. Snapshot keys for `prices` / `prevDayPrices` are
 * `${source}:${symbol}` so the UI can render HL and Binance rows side-by-side
 * (e.g. BTC@hyperliquid vs BTCUSDT@binance). `maxLeverages` stays
 * single-keyed by HL symbol — Binance doesn't have a per-symbol leverage
 * concept on USDⓈ-M perp universe.
 */

import type { WatchlistPriceCache, PriceCache } from "./price-cache.js";
import type { TokenInfo } from "./interfaces/trading-types.js";
import type { PriceSourceId } from "./price-feed/types.js";

/** Snapshot-output token shape — extends HL-internal TokenInfo with the
 *  source tag added at projection time. Trading-internal types
 *  (`TokenInfo`) stay HL-only; multi-source labeling is a snapshot concern. */
export interface SnapshotTokenInfo extends TokenInfo {
  source: PriceSourceId;
}

/** Minimal HL surface. */
export interface TokensSnapshotClientDeps {
  getAllAssets(): ReadonlyArray<TokenInfo>;
  getMaxLeverage(symbol: string): number | undefined;
}

/** Minimal Binance universe surface. */
export interface BinanceUniverseDeps {
  list(): ReadonlyArray<{ symbol: string }>;
}

export interface TokensSnapshot {
  tokens: SnapshotTokenInfo[];
  /** Keyed `${source}:${symbol}`. */
  prices: Record<string, number>;
  /** Keyed `${source}:${symbol}`. */
  prevDayPrices: Record<string, number>;
  /** HL only — keyed by HL symbol (no source prefix). */
  maxLeverages: Record<string, number>;
}

export class TokensSnapshotService {
  constructor(
    private readonly hlClient: TokensSnapshotClientDeps,
    private readonly hlPriceCache: PriceCache,
    private readonly binance: BinanceUniverseDeps,
    private readonly watchlistPriceCache: WatchlistPriceCache,
  ) {}

  /** Build a snapshot from in-memory caches. Zero network calls. */
  build(): TokensSnapshot {
    const tokens: SnapshotTokenInfo[] = [];
    const prices: Record<string, number> = {};
    const prevDayPrices: Record<string, number> = {};
    const maxLeverages: Record<string, number> = {};

    for (const asset of this.hlClient.getAllAssets()) {
      const { symbol, isDelisted } = asset;
      tokens.push(
        isDelisted
          ? { symbol, source: "hyperliquid", isDelisted: true }
          : { symbol, source: "hyperliquid" },
      );
      const entry = this.hlPriceCache.get(symbol, 30_000);
      if (entry) {
        prices[`hyperliquid:${symbol}`] = entry.price;
        if (entry.prevDayPrice !== undefined) {
          prevDayPrices[`hyperliquid:${symbol}`] = entry.prevDayPrice;
        }
      }
      const lev = this.hlClient.getMaxLeverage(symbol);
      if (typeof lev === "number" && lev > 0) maxLeverages[symbol] = lev;
    }

    for (const { symbol } of this.binance.list()) {
      tokens.push({ symbol, source: "binance" });
      const entry = this.watchlistPriceCache.get("binance", symbol, 30_000);
      if (entry) {
        prices[`binance:${symbol}`] = entry.price;
        if (entry.prevDayPrice !== undefined) {
          prevDayPrices[`binance:${symbol}`] = entry.prevDayPrice;
        }
      }
    }

    tokens.sort((a, b) => {
      if (a.source !== b.source) return a.source < b.source ? -1 : 1;
      return a.symbol.localeCompare(b.symbol);
    });
    return { tokens, prices, prevDayPrices, maxLeverages };
  }
}
