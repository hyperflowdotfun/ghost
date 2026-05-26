import type { PriceSourceId } from "../services/price-feed/types.js";

export interface PriceUpdateEvent {
  type: "trading.price.update";
  payload: { symbol: string; price: number; prevDayPrice?: number };
}

/**
 * Source-tagged tick — emitted alongside `trading.price.update` for the
 * watchlist UI which renders HL + Binance rows side-by-side. HL ticks fan
 * out from CompositePriceFeed.onPrice; Binance ticks from
 * WatchlistPriceFeed.onTick.
 */
export interface SourceTickEvent {
  type: "trading.source.tick";
  payload: { source: PriceSourceId; symbol: string; price: number; prevDayPrice?: number };
}

export interface WatchlistChangedEvent {
  type: "trading.watchlist.changed";
  payload: { action: "add" | "remove"; symbol: string; source: PriceSourceId };
}

/**
 * Published after a batch of tweets is persisted to the DB so the UI can
 * refresh promptly instead of waiting on its poll interval. Source identifies
 * whether the batch came from the user's X.com following list or a manually
 * tracked account.
 */
export interface TweetsInsertedEvent {
  type: "trading.tweets.inserted";
  payload: { count: number; source: "following" | "manual" };
}

/**
 * The alert-rules CRUD lifecycle — used by the gateway to re-evaluate the
 * "always-on price feed when alerts pending" gate, and by the web UI to
 * refresh its read-only list without polling.
 *
 * Trigger detection no longer publishes its own event — the observer reads
 * rules + prices inline on every 5s eval tick and dispatches `chat.proactive`
 * directly when the judge says fire.
 */
export interface AlertSetEvent {
  type: "trading.alert.set";
  payload: {
    id: string;
    symbol: string;
    condition: "above" | "below";
    price: number;
    note?: string;
  };
}
export interface AlertRemovedEvent {
  type: "trading.alert.removed";
  payload: { id: string; symbol: string };
}

export const TradingEvents = {
  priceUpdate: (p: PriceUpdateEvent["payload"]): PriceUpdateEvent =>
    ({ type: "trading.price.update", payload: p }),
  sourceTick: (p: SourceTickEvent["payload"]): SourceTickEvent =>
    ({ type: "trading.source.tick", payload: p }),
  watchlistChanged: (p: WatchlistChangedEvent["payload"]): WatchlistChangedEvent =>
    ({ type: "trading.watchlist.changed", payload: p }),
  tweetsInserted: (p: TweetsInsertedEvent["payload"]): TweetsInsertedEvent =>
    ({ type: "trading.tweets.inserted", payload: p }),
  alertSet: (p: AlertSetEvent["payload"]): AlertSetEvent =>
    ({ type: "trading.alert.set", payload: p }),
  alertRemoved: (p: AlertRemovedEvent["payload"]): AlertRemovedEvent =>
    ({ type: "trading.alert.removed", payload: p }),
} as const;

export type TradingEvent =
  | PriceUpdateEvent
  | SourceTickEvent
  | WatchlistChangedEvent
  | TweetsInsertedEvent
  | AlertSetEvent
  | AlertRemovedEvent;
