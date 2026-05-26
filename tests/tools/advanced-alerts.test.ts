import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDatabase } from "../../src/core/database.js";
import { runDbMigrations } from "../../src/core/migrations/db.js";
import { DB_MIGRATIONS } from "../../src/core/migrations/registry.js";
import { AlertRulesService } from "../../src/services/alert-rules.js";
import { WatchlistService } from "../../src/services/watchlist/service.js";
import { createAdvancedTradingTools } from "../../src/tools/trading/advanced.js";
import type { ITradingClient } from "../../src/services/interfaces/trading-client.js";
import type { Ticker } from "../../src/services/interfaces/trading-types.js";

async function freshDb(): Promise<Database> {
  const dir = mkdtempSync(join(tmpdir(), "ghost-tools-alerts-"));
  const db = initDatabase(join(dir, "test.db"));
  await runDbMigrations(db, DB_MIGRATIONS);
  return db;
}

function fakeTradingClient(prices: Record<string, number>): ITradingClient {
  return {
    resolveSymbol(symbol: string): string {
      return symbol.toUpperCase();
    },
    isKnownSymbol(symbol: string): boolean {
      return Object.prototype.hasOwnProperty.call(prices, symbol.toUpperCase());
    },
    async getTicker(symbol: string): Promise<Ticker> {
      const upper = symbol.toUpperCase();
      const markPrice = prices[upper];
      if (markPrice === undefined) throw new Error(`unknown ${upper}`);
      return {
        symbol: upper,
        markPrice,
        priceChangePct24h: 0,
        volume24h: 0,
        openInterest: 0,
        fundingRate: 0,
      } as Ticker;
    },
    async getAllTickers(): Promise<Ticker[]> {
      return Object.entries(prices).map(([symbol, markPrice]) => ({
        symbol,
        markPrice,
        priceChangePct24h: 0,
        volume24h: 0,
        openInterest: 0,
        fundingRate: 0,
      })) as Ticker[];
    },
  } as unknown as ITradingClient;
}

function findTool(tools: ReturnType<typeof createAdvancedTradingTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool;
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

function extractText(result: unknown): string {
  const r = result as ToolResult;
  return r.content.map((c) => c.text).join("\n");
}

describe("advanced trading tools — alerts", () => {
  let db: Database;
  let alerts: AlertRulesService;
  let watchlist: WatchlistService;
  let tools: ReturnType<typeof createAdvancedTradingTools>;

  beforeEach(async () => {
    db = await freshDb();
    alerts = new AlertRulesService(db);
    watchlist = new WatchlistService(db);
    const hl = fakeTradingClient({ BTC: 70000, ETH: 3500, HYPE: 25, DOGE: 0.10 });
    // Binance disabled in this fixture — alert flows are HL-only.
    tools = createAdvancedTradingTools(hl, watchlist, alerts, undefined);
  });

  test("ghost_alert_set accepts symbols not in watchlist (alerts independent of watchlist)", async () => {
    const tool = findTool(tools, "ghost_alert_set");
    // DOGE is intentionally not pre-seeded in the watchlist — the test
    // ticker stub returns a finite mark price for it (current=0.10) so
    // the alert should be created with target 0.5 (above current → not
    // past-target).
    const result = await tool.execute("call-1", {
      symbol: "DOGE",
      condition: "above",
      price: 0.5,
    });
    expect(extractText(result)).toContain("Alert set");
    expect(extractText(result)).toContain("DOGE");
  });

  test("ghost_alert_set rejects past-target with a suggested adjustment", async () => {
    const tool = findTool(tools, "ghost_alert_set");
    // BTC is seeded in watchlist; current price is 70000.
    const result = await tool.execute("call-1", {
      symbol: "BTC",
      condition: "above",
      price: 65000,
    });
    const text = extractText(result);
    expect(text).toContain("BTC is already above");
    expect(text).toMatch(/Try above \$70/);
  });

  test("ghost_alert_set rejects duplicate active triple with a friendly error", async () => {
    const tool = findTool(tools, "ghost_alert_set");
    await tool.execute("c1", { symbol: "BTC", condition: "above", price: 80000 });
    const result = await tool.execute("c2", {
      symbol: "BTC",
      condition: "above",
      price: 80000,
    });
    expect(extractText(result)).toContain("already have an active above alert");
  });

  test("ghost_alert_set with valid future target succeeds and persists note", async () => {
    const tool = findTool(tools, "ghost_alert_set");
    const result = await tool.execute("c1", {
      symbol: "BTC",
      condition: "above",
      price: 80000,
      note: "take profit",
    });
    expect(extractText(result)).toContain("take profit");
    expect(alerts.list()[0]?.note).toBe("take profit");
  });

  test("ghost_alert_list shows distance to target", async () => {
    alerts.add("BTC", "above", 80000, { note: "tp1" });
    const tool = findTool(tools, "ghost_alert_list");
    const result = await tool.execute("c1", {});
    const text = extractText(result);
    expect(text).toContain("BTC");
    expect(text).toMatch(/mark \$70,000\.00/);
    expect(text).toContain("14.29%");
  });

  test("ghost_alert_history surfaces fired alerts only", async () => {
    const a = alerts.add("BTC", "above", 65000);
    alerts.markFired(a.id);
    alerts.add("ETH", "above", 4000);

    const tool = findTool(tools, "ghost_alert_history");
    const result = await tool.execute("c1", {});
    const text = extractText(result);
    expect(text).toContain("BTC");
    expect(text).not.toContain("ETH");
  });

  test("ghost_watchlist_remove leaves alerts on the same symbol intact", async () => {
    alerts.add("BTC", "above", 80000);
    alerts.add("BTC", "below", 60000);
    const tool = findTool(tools, "ghost_watchlist_remove");
    const result = await tool.execute("c1", { symbol: "BTC" });
    const text = extractText(result);
    expect(text).toContain("Removed BTC (hyperliquid) from watchlist");
    expect(text).not.toContain("alert"); // no cascade copy
    // Alerts on BTC are untouched — independent surfaces.
    expect(alerts.list()).toHaveLength(2);
  });
});
