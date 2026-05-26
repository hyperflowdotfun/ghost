/**
 * Shared types for the CompositePriceFeed system.
 *
 * A PriceSource is any ticker provider (WebSocket or REST) that emits
 * (symbol, price) ticks through the callback passed to start().
 * The Composite orchestrates multiple sources with priority-based failover.
 */

/**
 * Stable identifier for a price source. Used in event payloads, cache keys
 * (`${source}:${symbol}`), watchlist rows, and gateway dispatch.
 */
export type PriceSourceId = "hyperliquid" | "binance";

/**
 * Callback invoked by a PriceSource when a new tick arrives.
 * `prevDayPrice` is optional — sources that do not have it (e.g. Binance WS
 * mark-price stream) omit it; the HL source includes it from both REST ticks
 * and `allDexsAssetCtxs` frames (prevDayPx field).
 */
export type PriceTickCallback = (symbol: string, price: number, prevDayPrice?: number) => void;

/**
 * Source-tagged tick callback used by WatchlistPriceFeed. Carries
 * source-native symbol (e.g. "BTCUSDT" for binance, "BTC" for hyperliquid)
 * tagged with the source id. No canonicalization is applied.
 */
export type WatchlistTickCallback = (
  source: PriceSourceId,
  symbol: string,
  price: number,
  prevDayPrice?: number,
) => void;

export interface PriceSource {
  /** Stable identifier — used in logs and primary-selection comparisons. */
  readonly name: string;
  /** Lower number = higher priority. 0 = preferred primary. */
  readonly priority: number;

  /** Start the source and begin invoking onTick for every price update. */
  start(onTick: PriceTickCallback): Promise<void>;
  /** Stop the source and release all resources (sockets, timers). */
  stop(): Promise<void>;
  /**
   * Timestamp (ms epoch) of the most recent tick emitted by this source.
   * Returns 0 if the source has never produced a tick. Sources that run
   * multiple internal transports (e.g. WS + REST fallback) should return
   * the max across transports — the composite uses this as the single
   * health signal per exchange.
   */
  getLastTickAt(): number;
}

export interface CompositeConfig {
  /** A source is considered stale if it has not produced a tick within this window. */
  staleThresholdMs?: number;
  /** A higher-priority source must be healthy continuously for this long before being restored as primary. */
  stabilityWindowMs?: number;
  /** How often the health-check loop runs. */
  healthCheckIntervalMs?: number;
}

export const DEFAULT_COMPOSITE_CONFIG = {
  staleThresholdMs: 10_000,
  stabilityWindowMs: 30_000,
  healthCheckIntervalMs: 1_000,
} as const;
