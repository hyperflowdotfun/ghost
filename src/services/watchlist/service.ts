/**
 * Watchlist service — SQLite-backed (symbol, source) watchlist.
 *
 * Watchlist and alerts are fully independent: add/remove on either
 * surface does not touch the other.
 */

import type { Database } from "bun:sqlite";
import type { PriceSourceId } from "../price-feed/types.js";

export interface WatchlistItem {
  symbol: string;
  source: PriceSourceId;
  addedAt: string;
  notes?: string;
}

export interface RemoveResult {
  removed: boolean;
}

export const DEFAULT_WATCHLIST: ReadonlyArray<{ symbol: string; source: PriceSourceId }> = [
  { symbol: "BTC", source: "hyperliquid" },
  { symbol: "ETH", source: "hyperliquid" },
  { symbol: "HYPE", source: "hyperliquid" },
];

const KNOWN_SOURCES: ReadonlySet<PriceSourceId> = new Set(["hyperliquid", "binance"]);

/** The `watchlist.source` column is TEXT with no CHECK constraint, so narrow
 *  at read time and fail loud if a non-union value lands there (debug REPL,
 *  future schema drift). */
function asPriceSourceId(raw: string): PriceSourceId {
  if (KNOWN_SOURCES.has(raw as PriceSourceId)) return raw as PriceSourceId;
  throw new Error(`watchlist: unknown source '${raw}'`);
}

export class WatchlistService {
  private readonly stmts;
  private readonly _changeListeners = new Set<
    (action: "add" | "remove", symbol: string, source: PriceSourceId) => void
  >();

  onChanged(fn: (action: "add" | "remove", symbol: string, source: PriceSourceId) => void) {
    this._changeListeners.add(fn);
  }

  constructor(private readonly db: Database) {
    this.stmts = {
      upsert: db.prepare(`
        INSERT INTO watchlist (symbol, source, notes) VALUES (?, ?, ?)
          ON CONFLICT(symbol, source) DO UPDATE SET notes = COALESCE(excluded.notes, watchlist.notes)
      `),
      remove: db.prepare(`DELETE FROM watchlist WHERE symbol = ? AND source = ?`),
      list: db.prepare(`SELECT symbol, source, notes, added_at FROM watchlist ORDER BY added_at DESC`),
      get: db.prepare(`SELECT symbol, source, notes, added_at FROM watchlist WHERE symbol = ? AND source = ?`),
      count: db.prepare(`SELECT COUNT(*) as cnt FROM watchlist`),
    };
    this.seedDefaults();
  }

  private seedDefaults() {
    const { cnt } = this.stmts.count.get() as { cnt: number };
    if (cnt > 0) return;
    for (const { symbol, source } of DEFAULT_WATCHLIST) {
      this.stmts.upsert.run(symbol, source, null);
    }
  }

  has(symbol: string, source: PriceSourceId): boolean {
    return !!this.stmts.get.get(symbol, source);
  }

  add(symbol: string, source: PriceSourceId, notes?: string): WatchlistItem {
    if (this.has(symbol, source)) {
      throw new Error(`${symbol} (${source}) is already in your watchlist`);
    }
    this.stmts.upsert.run(symbol, source, notes ?? null);
    const row = this.stmts.get.get(symbol, source) as
      | { symbol: string; source: string; notes: string | null; added_at: number }
      | undefined;
    for (const fn of this._changeListeners) fn("add", symbol, source);
    return {
      symbol,
      source,
      addedAt: row ? new Date(row.added_at * 1000).toISOString() : new Date().toISOString(),
      notes: row?.notes ?? notes,
    };
  }

  remove(symbol: string, source: PriceSourceId): RemoveResult {
    const result = this.stmts.remove.run(symbol, source);
    const removed = result.changes > 0;
    if (removed) for (const fn of this._changeListeners) fn("remove", symbol, source);
    return { removed };
  }

  list(): WatchlistItem[] {
    const rows = this.stmts.list.all() as Array<{
      symbol: string;
      source: string;
      notes: string | null;
      added_at: number;
    }>;
    return rows.map((r) => ({
      symbol: r.symbol,
      source: asPriceSourceId(r.source),
      addedAt: new Date(r.added_at * 1000).toISOString(),
      notes: r.notes ?? undefined,
    }));
  }
}
