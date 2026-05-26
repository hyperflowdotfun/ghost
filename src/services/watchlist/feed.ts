/**
 * WatchlistPriceFeed — view-only multi-source fan-out for the
 * watchlist UI.
 *
 * No failover, no canonicalization. Every tick from every wrapped source is
 * forwarded downstream tagged with its source id and source-native symbol
 * (e.g. "BTCUSDT" for binance). Lives alongside CompositePriceFeed (HL
 * canonical, failover) without sharing source instances — keep the trading
 * path isolated from view-only consumers.
 *
 * Sources are expected to emit source-native symbols (BinanceSource's mini
 * stream emits native Binance pairs). No mapping logic in this feed.
 */

import type { Logger } from "pino";
import type { PriceSource, PriceSourceId, WatchlistTickCallback } from "../price-feed/types.js";

export class WatchlistPriceFeed {
  private started = false;
  private onTick: WatchlistTickCallback | null = null;

  constructor(
    private readonly sources: ReadonlyArray<PriceSource>,
    private readonly log: Logger,
  ) {}

  async start(onTick: WatchlistTickCallback): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.onTick = onTick;
    if (this.sources.length === 0) {
      this.log.info("watchlist composite started with no sources");
      return;
    }
    await Promise.all(
      this.sources.map(async (s) => {
        try {
          await s.start((symbol, price, prevDayPrice) => {
            this.onTick?.(s.name as PriceSourceId, symbol, price, prevDayPrice);
          });
        } catch (err) {
          this.log.warn({ err, source: s.name }, "watchlist source failed to start");
        }
      }),
    );
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.onTick = null;
    await Promise.all(
      this.sources.map(async (s) => {
        try {
          await s.stop();
        } catch (err) {
          this.log.warn({ err, source: s.name }, "watchlist source failed to stop");
        }
      }),
    );
  }
}
