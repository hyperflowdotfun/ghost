/**
 * Source-aware symbol resolution for watchlist add/remove.
 *
 * Two call sites share this contract: `gateway/trading.ts`
 * (`trading.watchlist.add/remove` RPC) and `tools/trading/advanced.ts`
 * (`ghost_watchlist_add/remove` agent tools). Behavior:
 *
 *   - hyperliquid: upper-cases via `tradingClient.resolveSymbol` and (for
 *     add) checks `isKnownSymbol` against the loaded perp universe.
 *   - binance: passes the raw pair through, validates against the loaded
 *     BinanceService universe (for add). Binance disabled → reject.
 *   - unknown source → reject.
 *
 * `validate` is for add (universe check enforced). `canonical` is for
 * remove (no universe check — callers can delete rows after delist).
 */

import type { ITradingClient } from "../interfaces/trading-client.js";
import type { BinanceService } from "../binance.js";
import type { PriceSourceId } from "../price-feed/types.js";

export type ValidateResult =
  | { ok: true; canonical: string }
  | { ok: false; error: string };

export function validateWatchlistSymbol(
  source: PriceSourceId | string,
  raw: string,
  hl: ITradingClient,
  binance: BinanceService | undefined,
): ValidateResult {
  if (source === "hyperliquid") {
    const canonical = hl.resolveSymbol(raw);
    if (!hl.isKnownSymbol(canonical)) {
      return { ok: false, error: `Symbol ${canonical} not found on Hyperliquid` };
    }
    return { ok: true, canonical };
  }
  if (source === "binance") {
    if (!binance?.has(raw)) {
      return { ok: false, error: `Symbol ${raw} not found on Binance USDⓈ-M` };
    }
    return { ok: true, canonical: raw };
  }
  return { ok: false, error: `Unknown source '${source}'` };
}

export function canonicalWatchlistSymbol(
  source: PriceSourceId | string,
  raw: string,
  hl: ITradingClient,
): string {
  // Remove path skips universe check so callers can delete stale rows
  // after upstream delist. HL still upper-cases; Binance passes raw.
  return source === "hyperliquid" ? hl.resolveSymbol(raw) : raw;
}
