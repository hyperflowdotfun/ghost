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
import { detectPriceTargetCrossings } from "../../src/observer/detect/price-target.js";

async function freshDb(): Promise<Database> {
  const dir = mkdtempSync(join(tmpdir(), "ghost-wl-indep-"));
  const db = initDatabase(join(dir, "test.db"));
  await runDbMigrations(db, DB_MIGRATIONS);
  return db;
}

/**
 * Watchlist and alerts must be fully independent. Removing a watchlist
 * row leaves alerts on the same symbol untouched (no cascade), and
 * creating / firing an alert never adds to or removes from the watchlist.
 * The two services exist to answer different questions; coupling them
 * confused users in earlier iterations.
 */
function fireCrossings(alerts: AlertRulesService, prices: Map<string, number>): void {
  const result = detectPriceTargetCrossings({
    rules: alerts.list(),
    prices,
    nowMs: Date.now(),
  });
  for (const id of result.firedIds) alerts.markFired(id);
}

describe("watchlist and alerts are independent", () => {
  let db: Database;
  let alerts: AlertRulesService;
  let watchlist: WatchlistService;

  beforeEach(async () => {
    db = await freshDb();
    alerts = new AlertRulesService(db);
    watchlist = new WatchlistService(db);
  });

  test("watchlist.remove leaves active alerts on the same symbol intact", () => {
    alerts.add("BTC", "above", 70000, { note: "entry" });
    alerts.add("BTC", "below", 60000, { note: "stop" });
    expect(alerts.list()).toHaveLength(2);

    const result = watchlist.remove("BTC", "hyperliquid");
    expect(result).toEqual({ removed: true });

    expect(alerts.list()).toHaveLength(2);
    expect(alerts.list().map((a) => a.symbol).sort()).toEqual(["BTC", "BTC"]);
  });

  test("watchlist.remove leaves fired-history alerts intact", () => {
    alerts.add("BTC", "above", 70000);
    fireCrossings(alerts, new Map([["BTC", 71000]]));
    expect(alerts.list({ includeFired: true })).toHaveLength(1);

    watchlist.remove("BTC", "hyperliquid");

    const all = alerts.list({ includeFired: true });
    expect(all).toHaveLength(1);
    expect(all[0]?.firedAt).toBeDefined();
  });

  test("alerts.add does NOT add the symbol to the watchlist", () => {
    expect(watchlist.has("PEPE", "hyperliquid")).toBe(false);
    alerts.add("PEPE", "above", 0.001);
    expect(watchlist.has("PEPE", "hyperliquid")).toBe(false);
  });

  test("alert fire does NOT touch the watchlist", () => {
    alerts.add("BTC", "above", 70000);
    expect(watchlist.has("BTC", "hyperliquid")).toBe(true);
    fireCrossings(alerts, new Map([["BTC", 71000]]));
    expect(watchlist.has("BTC", "hyperliquid")).toBe(true);
    expect(watchlist.list().map((w) => w.symbol)).toContain("BTC");
  });

  test("alerts.remove does NOT touch the watchlist", () => {
    const a = alerts.add("BTC", "above", 70000);
    alerts.remove(a.id);
    expect(watchlist.has("BTC", "hyperliquid")).toBe(true);
  });

  test("watchlist.remove of a symbol that's never been watched returns false without affecting alerts", () => {
    alerts.add("DOGE", "above", 0.5);
    const result = watchlist.remove("DOGE", "hyperliquid");
    expect(result).toEqual({ removed: false });
    expect(alerts.list()).toHaveLength(1);
  });
});
