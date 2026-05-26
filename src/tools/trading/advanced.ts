/** Advanced trading tools: watchlist, price alerts. */

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { defineTool } from "./types.js";
import type { ITradingClient } from "../../services/interfaces/trading-client.js";
import type { WatchlistService } from "../../services/watchlist/service.js";
import type { AlertRulesService } from "../../services/alert-rules.js";
import type { PriceCache } from "../../services/price-cache.js";
import type { BinanceService } from "../../services/binance.js";
import type { PriceSourceId } from "../../services/price-feed/types.js";
import {
  validateWatchlistSymbol,
  canonicalWatchlistSymbol,
} from "../../services/watchlist/sources.js";
import { textResult, errorResult, getErrorMessage } from "../../helpers/result.js";
import { formatUsd, formatPct } from "../../helpers/formatters.js";
import { detectPriceTargetCrossings } from "../../observer/detect/price-target.js";

interface PriceLookup {
  price: number | undefined;
  source: "live mark" | "rest mark" | "missing";
}

async function getCurrentPrice(
  hl: ITradingClient,
  cache: PriceCache | undefined,
  symbol: string,
): Promise<PriceLookup> {
  // Prefer cached live mark from the gateway-owned PriceCache (WS-fed);
  // REST markPx is fallback when the cache is empty.
  const cached = cache?.get(symbol);
  if (cached) return { price: cached.price, source: "live mark" };
  try {
    const t = await hl.getTicker(symbol);
    return { price: t.markPrice, source: "rest mark" };
  } catch {
    return { price: undefined, source: "missing" };
  }
}

function suggestedTarget(condition: "above" | "below", current: number): number {
  // 1% nudge — close enough to the current price to feel relevant,
  // far enough to avoid an immediate fire-on-next-tick.
  const delta = current * 0.01;
  return condition === "above"
    ? Math.round((current + delta) * 100) / 100
    : Math.round((current - delta) * 100) / 100;
}

const SOURCE_PARAM = Type.Optional(
  Type.Union([Type.Literal("hyperliquid"), Type.Literal("binance")], {
    description: "Price source. Defaults to 'hyperliquid'.",
  }),
);

export function createAdvancedTradingTools(
  hl: ITradingClient,
  watchlist: WatchlistService,
  alerts: AlertRulesService,
  binance: BinanceService | undefined,
  priceCache?: PriceCache,
): AgentTool[] {
  return [
    // ─── Watchlist ───
    defineTool({
      name: "ghost_watchlist_add",
      label: "Watchlist Add",
      description:
        "Add a symbol to your watchlist with optional notes. Defaults to Hyperliquid; pass source='binance' to watch a Binance USDⓈ-M perp (use full pair like BTCUSDT).",
      parameters: Type.Object({
        symbol: Type.String({ description: "Trading symbol (e.g. BTC for HL, BTCUSDT for Binance)" }),
        source: SOURCE_PARAM,
        notes: Type.Optional(Type.String({ description: "Optional notes about this symbol" })),
      }),
      async execute(_toolCallId, params) {
        try {
          const source = (params.source ?? "hyperliquid") as PriceSourceId;
          const v = validateWatchlistSymbol(source, params.symbol, hl, binance);
          if (!v.ok) return errorResult(v.error);
          const item = await watchlist.add(v.canonical, source, params.notes);
          return textResult(`Added ${item.symbol} (${source}) to watchlist.${item.notes ? ` Notes: ${item.notes}` : ""}`);
        } catch (e: unknown) { return errorResult(getErrorMessage(e)); }
      },
    }),
    defineTool({
      name: "ghost_watchlist_remove",
      label: "Watchlist Remove",
      description:
        "Remove a symbol from your watchlist. Alerts on the same symbol are not affected — watchlist and alerts are independent surfaces. Defaults to Hyperliquid; pass source='binance' to remove a Binance entry.",
      parameters: Type.Object({
        symbol: Type.String({ description: "Trading symbol to remove" }),
        source: SOURCE_PARAM,
      }),
      async execute(_toolCallId, params) {
        try {
          const source = (params.source ?? "hyperliquid") as PriceSourceId;
          const target = canonicalWatchlistSymbol(source, params.symbol, hl);
          const result = watchlist.remove(target, source);
          if (!result.removed) return textResult(`${target} (${source}) is not in your watchlist.`);
          return textResult(`Removed ${target} (${source}) from watchlist.`);
        } catch (e: unknown) { return errorResult(getErrorMessage(e)); }
      },
    }),
    defineTool({
      name: "ghost_watchlist_list",
      label: "Watchlist List",
      description: "List all watched symbols with current prices and 24h change.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params) {
        try {
          const items = await watchlist.list();
          if (items.length === 0) return textResult("Watchlist is empty.");
          const lines = [`Watchlist (${items.length})`, "─".repeat(40)];
          for (const item of items) {
            try {
              const t = await hl.getTicker(item.symbol);
              lines.push(`  ${t.symbol.padEnd(8)} ${formatUsd(t.markPrice).padStart(12)}  ${formatPct(t.priceChangePct24h).padStart(8)}${item.notes ? `  — ${item.notes}` : ""}`);
            } catch {
              lines.push(`  ${item.symbol.padEnd(8)} (price unavailable)${item.notes ? `  — ${item.notes}` : ""}`);
            }
          }
          return textResult(lines.join("\n"));
        } catch (e: unknown) { return errorResult(getErrorMessage(e)); }
      },
    }),

    // ─── Alerts ───
    defineTool({
      name: "ghost_alert_set",
      label: "Set Price Alert",
      description:
        "Set a price target alert on any Hyperliquid perp symbol. The alert fires once when price " +
        "crosses the target. If the current price has already crossed the target, the alert is " +
        "rejected with a suggested adjustment. The symbol does not need to be in the watchlist — " +
        "alerts and watchlist are independent.",
      parameters: Type.Object({
        symbol: Type.String({ description: "Trading symbol (e.g. BTC, ETH, HYPE)" }),
        condition: Type.Union(
          [Type.Literal("above"), Type.Literal("below")],
          { description: "'above' (fire when price ≥ target) or 'below' (fire when price ≤ target)" },
        ),
        price: Type.Number({ description: "Trigger price" }),
        note: Type.Optional(Type.String({ description: "Optional note (e.g. 'entry zone', 'take profit')" })),
      }),
      async execute(_toolCallId, params) {
        try {
          // TypeBox enforces the literal at the schema layer; the cast
          // is just to give the rest of the body a narrowed type.
          const cond: "above" | "below" = params.condition;

          const upper = params.symbol.toUpperCase();
          // Reject early if the symbol isn't known; avoids a network
          // round-trip for a name the exchange will never accept.
          if (!hl.isKnownSymbol(upper)) return errorResult(`Symbol ${upper} not found on Hyperliquid.`);

          // Past-target check — reject upfront with a "try X instead"
          // nudge so the alert doesn't fire on the very next tick. The
          // error message labels the reference price as "mark"
          // explicitly so the agent doesn't paraphrase it as "mid".
          const lookup = await getCurrentPrice(hl, priceCache, upper);
          if (lookup.price !== undefined) {
            const past =
              cond === "above"
                ? lookup.price >= params.price
                : lookup.price <= params.price;
            if (past) {
              const nudge = suggestedTarget(cond, lookup.price);
              return errorResult(
                `${upper} is already ${cond} ${formatUsd(params.price)} ` +
                  `(current mark ${formatUsd(lookup.price)}). ` +
                  `Try ${cond} ${formatUsd(nudge)} instead?`,
              );
            }
          }

          // Persist the create-time mark for the "moved X% since
          // alert was set" UI line; reuses the past-target lookup
          // rather than paying for a second getTicker.
          const alert = alerts.add(upper, cond, params.price, {
            note: params.note,
            createdPrice: lookup.price,
          });
          return textResult(
            `Alert set: ${alert.symbol} ${alert.condition} ${formatUsd(alert.price)}` +
              `${alert.note ? ` — ${alert.note}` : ""}\nID: ${alert.id}`,
          );
        } catch (e: unknown) {
          return errorResult(getErrorMessage(e));
        }
      },
    }),
    defineTool({
      name: "ghost_alert_list",
      label: "List Alerts",
      description: "List active price alerts with current price and distance to each target.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params) {
        try {
          const all = alerts.list();
          if (all.length === 0) return textResult("No active alerts.");
          const lines = [`Active Alerts (${all.length})`, "─".repeat(60)];
          for (const a of all) {
            const lookup = await getCurrentPrice(hl, priceCache, a.symbol);
            let distancePart = "";
            if (lookup.price !== undefined) {
              const diff = a.price - lookup.price;
              const pct = (diff / lookup.price) * 100;
              const arrow = diff > 0 ? "↑" : diff < 0 ? "↓" : "=";
              distancePart =
                ` | mark ${formatUsd(lookup.price)} (${arrow}${formatUsd(Math.abs(diff))} / ${pct.toFixed(2)}%)`;
            } else {
              distancePart = " | mark —";
            }
            lines.push(
              `  ${a.symbol.padEnd(6)} ${a.condition.padEnd(5)} ${formatUsd(a.price).padStart(12)}` +
                `${a.note ? ` — ${a.note}` : ""}${distancePart}`,
            );
            lines.push(`         ID: ${a.id}`);
          }
          return textResult(lines.join("\n"));
        } catch (e: unknown) {
          return errorResult(getErrorMessage(e));
        }
      },
    }),
    defineTool({
      name: "ghost_alert_remove",
      label: "Remove Alert",
      description: "Hard-delete a price alert by its ID (active or fired).",
      parameters: Type.Object({
        id: Type.String({ description: "Alert ID to remove" }),
      }),
      async execute(_toolCallId, params) {
        try {
          const removed = alerts.remove(params.id);
          return removed
            ? textResult(`Alert ${params.id} removed.`)
            : textResult(`Alert ${params.id} not found.`);
        } catch (e: unknown) { return errorResult(getErrorMessage(e)); }
      },
    }),
    defineTool({
      name: "ghost_alert_history",
      label: "Alert History",
      description: "List previously fired alerts.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params) {
        try {
          const all = alerts.list({ includeFired: true });
          const fired = all.filter((a) => a.firedAt);
          if (fired.length === 0) return textResult("No fired alerts in history.");
          const lines = [`Fired Alerts (${fired.length})`, "─".repeat(60)];
          for (const a of fired) {
            lines.push(
              `  ${a.symbol.padEnd(6)} ${a.condition.padEnd(5)} ${formatUsd(a.price).padStart(12)}` +
                `${a.note ? ` — ${a.note}` : ""} | fired ${a.firedAt}`,
            );
            lines.push(`         ID: ${a.id}`);
          }
          return textResult(lines.join("\n"));
        } catch (e: unknown) {
          return errorResult(getErrorMessage(e));
        }
      },
    }),
    defineTool({
      name: "ghost_check_alerts",
      label: "Check Alerts",
      description:
        "Force an on-demand check of all active alerts against current market prices. " +
        "Background detection runs every 5s inside the observer; this tool exists " +
        "for explicit verification when the user asks.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params) {
        try {
          const active = alerts.list();
          if (active.length === 0) return textResult("No active alerts to check.");
          const tickers = await hl.getAllTickers();
          const prices = new Map<string, number>();
          for (const t of tickers) prices.set(t.symbol.toUpperCase(), t.markPrice);
          const result = detectPriceTargetCrossings({
            rules: active,
            prices,
            nowMs: Date.now(),
          });
          for (const id of result.firedIds) alerts.markFired(id);
          if (result.events.length === 0)
            return textResult(`Checked ${active.length} alert(s) — none triggered.`);
          const lines = [`${result.events.length} alert(s) triggered!`, "─".repeat(40)];
          for (const ev of result.events) {
            lines.push(
              `  ${ev.symbol} hit ${ev.condition} ${formatUsd(ev.targetPrice)} (now ${formatUsd(ev.currentPrice)})` +
                `${ev.note ? ` — ${ev.note}` : ""}`,
            );
          }
          const remaining = alerts.list().length;
          lines.push("", `${remaining} alert(s) still active.`);
          return textResult(lines.join("\n"));
        } catch (e: unknown) {
          return errorResult(getErrorMessage(e));
        }
      },
    }),
  ];
}
