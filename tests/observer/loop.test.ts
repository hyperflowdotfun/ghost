import { describe, expect, test, beforeEach, mock, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDatabase } from "../../src/core/database.js";
import { runDbMigrations } from "../../src/core/migrations/db.js";
import { DB_MIGRATIONS } from "../../src/core/migrations/registry.js";
import { AlertRulesService } from "../../src/services/alert-rules.js";
import { NewsService } from "../../src/services/news.js";
import { WatchlistService } from "../../src/services/watchlist/service.js";
import { NotificationsService } from "../../src/services/notifications.js";
import { PriceCache } from "../../src/services/price-cache.js";
import { ApprovalManager } from "../../src/gateway/approval.js";
import { SessionManager } from "../../src/session/manager.js";
import { EventBus } from "../../src/bus/events.js";
import { ChannelManager } from "../../src/channels/manager.js";
import { PairingStore } from "../../src/pairing/store.js";
import { ObserverLoop, MIN_COOLDOWN_MS } from "../../src/observer/loop.js";
import { ObserverStateStore } from "../../src/observer/state-store.js";
import type { ITradingClient } from "../../src/services/interfaces/trading-client.js";
import type { Position, OpenOrder, Fill, OrderRecord } from "../../src/services/interfaces/trading-types.js";

const noopLogger = {
  info: mock(),
  warn: mock(),
  error: mock(),
  debug: mock(),
  trace: mock(),
  child: () => noopLogger,
} as any;

async function freshDb(): Promise<Database> {
  const dir = mkdtempSync(join(tmpdir(), "ghost-obs-loop-"));
  const db = initDatabase(join(dir, "test.db"));
  await runDbMigrations(db, DB_MIGRATIONS);
  return db;
}

interface StubClientOpts {
  positions?: Position[];
  openOrders?: OpenOrder[];
  newFills?: Fill[];
  historicalOrders?: OrderRecord[];
  address?: string;
}

function stubClient(opts: StubClientOpts = {}): ITradingClient {
  return {
    canWrite: false,
    address: opts.address ?? "0x0",
    connect: () => {},
    disconnect: () => {},
    resolveSymbol: (s) => s.toUpperCase(),
    getBalance: async () => ({ totalEquity: 0, availableBalance: 0, usedMargin: 0, unrealizedPnl: 0 }),
    getPositions: async () => opts.positions ?? [],
    getOpenOrders: async () => opts.openOrders ?? [],
    getFills: async () => opts.newFills ?? [],
    getFillsByTime: async () => opts.newFills ?? [],
    getHistoricalOrders: async () => opts.historicalOrders ?? [],
    getTicker: async () => ({ symbol: "X", markPrice: 0, midPrice: 0, oraclePrice: 0, volume24h: 0, prevDayPrice: 0, priceChangePct24h: 0, openInterest: 0, fundingRate: 0 }),
    getAllTickers: async () => [],
    getOrderbook: async () => ({ symbol: "X", bids: [], asks: [] }),
    getKlines: async () => [],
    getFundingHistory: async () => [],
    ensureMeta: async () => {},
    getAssetIndex: async () => 0,
    getMaxLeverage: () => undefined,
    getAllAssetNames: () => [],
    isKnownSymbol: () => false,
    getAllAssets: () => [],
    getDexUniverses: () => new Map(),
    subscribeAllDexsAssetCtxs: async () => ({ unsubscribe: async () => {} }),
    closeWs: async () => {},
    placeOrder: async () => ({ symbol: "X", side: "buy", orderType: "market", status: "filled" }),
    cancelOrder: async () => ({ symbol: "X", orderId: "x", status: "cancelled" }),
    cancelAllOrders: async () => [],
    setLeverage: async () => ({ symbol: "X", leverage: 1, marginMode: "cross" }),
    closePosition: async () => ({ symbol: "X", side: "buy", orderType: "market", status: "filled" }),
    partialClose: async () => ({ symbol: "X", side: "buy", orderType: "market", status: "filled" }),
    adjustMargin: async () => ({ symbol: "X", amount: 0 }),
  };
}

function buildLoop(db: Database, opts: { client?: ITradingClient; runnerCalls?: string[]; runnerResponse?: string } = {}) {
  const eventBus = new EventBus(noopLogger);
  const alertRules = new AlertRulesService(db, eventBus);
  const watchlistService = new WatchlistService(db);
  const newsService = new NewsService(db, watchlistService, undefined, noopLogger);
  const notifications = new NotificationsService(db);
  const priceCache = new PriceCache();
  const approvalManager = new ApprovalManager();
  const sessionManager = new SessionManager(mkdtempSync(join(tmpdir(), "ghost-sess-")));
  const channelManager = new ChannelManager({ logger: noopLogger });
  const pairingStore = new PairingStore(db, noopLogger);
  const runnerCalls = opts.runnerCalls ?? [];
  const runner = {
    call: async (callOpts: { systemPrompt: string; message: string }) => {
      runnerCalls.push(callOpts.message);
      return opts.runnerResponse ?? JSON.stringify({
        decision: "silent",
        primaryEventType: null,
        primarySymbol: null,
        body: null,
        notify: false,
        reason: "no-op stub",
      });
    },
  } as any;
  const contextBuilder = {
    buildFullPrompt: () => "system prompt",
  } as any;
  const loop = new ObserverLoop({
    db,
    config: { enabled: true, tickMs: 5_000, syncIntervalMs: 60_000, liquidationProgressThreshold: 0.8 },
    tradingClient: opts.client ?? stubClient(),
    alertRules,
    newsService,
    notifications,
    priceCache,
    approvalManager,
    sessionManager,
    eventBus,
    channelManager,
    pairingStore,
    runner,
    contextBuilder,
    logger: noopLogger,
    getMessageBus: () => ({ publishOutbound: () => {} }) as any,
  });
  return { loop, alertRules, notifications, priceCache, approvalManager, runnerCalls };
}

describe("ObserverLoop — confirm-card gate", () => {
  let db: Database;
  beforeEach(async () => { db = await freshDb(); });

  test("tick() skips judge call when ApprovalManager has a pending approval", async () => {
    const { loop, approvalManager, runnerCalls } = buildLoop(db, {
      client: stubClient({
        positions: [{
          symbol: "BTC",
          side: "long",
          size: 0.1,
          entryPrice: 70_000,
          markPrice: 71_000,
          liquidationPrice: 60_000,
          unrealizedPnl: 100,
          unrealizedPnlPct: 1.4,
          leverage: 10,
          marginMode: "cross",
          margin: 700,
        }],
      }),
    });

    approvalManager.create("main", {
      action: "place_order",
      actionLabel: "Place Order",
      lines: ["BTC long 0.1 @ market"],
      summary: "BTC long 0.1",
      details: {},
      riskAssessment: "medium",
    });

    await loop.tick();

    // Judge was NOT called because the gate intercepted.
    expect(runnerCalls.length).toBe(0);

    // Snapshot WAS persisted so the next post-confirm tick has a fresh baseline.
    const store = new ObserverStateStore(db);
    const snap = store.load();
    expect(Object.keys(snap.positions).length).toBe(1);
  });
});

describe("ObserverLoop — filter integration", () => {
  let db: Database;
  beforeEach(async () => { db = await freshDb(); });

  test("idle position: first tick wakes judge, subsequent identical ticks are gated", async () => {
    // Post-BUG-0146 semantics: a lone pnl_snapshot CAN wake the judge —
    // the first time it's seen. After that, the per-position floor
    // (stamped on the judge call regardless of fire/silent verdict)
    // prevents re-waking until Δprice% > 0.5% or 60min elapses. So with
    // an unchanging price across both ticks the judge is invoked exactly
    // once, not zero.
    const { loop, runnerCalls } = buildLoop(db, {
      client: stubClient({
        positions: [{
          symbol: "BTC",
          side: "long",
          size: 0.1,
          entryPrice: 70_000,
          markPrice: 70_500,
          liquidationPrice: 60_000,
          unrealizedPnl: 50,
          unrealizedPnlPct: 0.7,
          leverage: 10,
          marginMode: "cross",
          margin: 700,
        }],
      }),
    });

    await loop.tick(); // first sighting — judge wakes once (no prior fire)
    await loop.tick(); // same price, elapsed ≈ 0 → floor drops snapshot

    expect(runnerCalls.length).toBe(1);
  });
});

describe("ObserverLoop — price-target crossing", () => {
  let db: Database;
  beforeEach(async () => { db = await freshDb(); });

  test("active rule + PriceCache crossing fires PriceAlertEvent + markFired", async () => {
    const { loop, alertRules, priceCache, runnerCalls } = buildLoop(db, {
      runnerResponse: JSON.stringify({
        decision: "fire",
        primaryEventType: "price_alert",
        primarySymbol: "BTC",
        body: "BTC crossed 70k",
        notify: true,
        reason: "test",
      }),
    });

    const rule = alertRules.add("BTC", "above", 70_000);
    priceCache.set("BTC", 70_500);

    await loop.tick();

    expect(runnerCalls.length).toBe(1);
    // markFired transitioned the rule out of the active set.
    expect(alertRules.list().length).toBe(0);
    expect(alertRules.list({ includeFired: true })[0]!.id).toBe(rule.id);
  });
});

describe("ObserverLoop — no wallet", () => {
  let db: Database;
  beforeEach(async () => { db = await freshDb(); });

  test("tick() short-circuits when trading client has no address", async () => {
    // HL's `clearinghouseState` (and friends) return 422 when `user` is
    // empty — previously surfaced as a noisy WARN every 5s before a wallet
    // is connected. The wallet gate must intercept before any HL fetch.
    let getPositionsCalls = 0;
    const client = stubClient({ address: "" });
    client.getPositions = async () => {
      getPositionsCalls++;
      return [];
    };

    const { loop, runnerCalls } = buildLoop(db, { client });
    await loop.tick();
    await loop.tick();

    expect(getPositionsCalls).toBe(0);
    expect(runnerCalls.length).toBe(0);
  });
});

describe("ObserverLoop — fill dedup across ticks", () => {
  let db: Database;
  beforeEach(async () => { db = await freshDb(); });

  test("same fill does not re-emit on cached-rest ticks between syncs", async () => {
    // Reproduces the user-observed spam: a position close fires `position_closed`
    // on tick 1 (synced), then cachedRest keeps the same `newFills` array for
    // every eval tick until the next REST sync. Without dedup, every cached
    // tick re-emits `position_closed`, the filter passes (non-snapshot event),
    // and the judge LLM is called ~10 times before sync advances the anchor.
    const closeFill: Fill = {
      tradeId: "CLOSE-T1",
      symbol: "BTC",
      side: "sell",
      price: 70_000,
      size: 0.1,
      fee: 0.5,
      feeToken: "USDC",
      realizedPnl: -12,
      timestamp: 1_700_000_000_000,
      dir: "Close Long",
    };

    const { loop, runnerCalls } = buildLoop(db, {
      client: stubClient({ newFills: [closeFill] }),
      runnerResponse: JSON.stringify({
        decision: "fire",
        primaryEventType: "position_closed",
        primarySymbol: "BTC",
        body: "BTC closed -$12.",
        notify: false,
        reason: "test",
      }),
    });

    await loop.tick();
    expect(runnerCalls.length).toBe(1);

    // Snapshot records the fill's tradeId in the rolling dedup window.
    const store = new ObserverStateStore(db);
    expect(store.load().recentEmittedFillIds).toContain("CLOSE-T1");

    // Subsequent ticks: stub returns the same fill array (the production
    // path holds it in `cachedRest` between 60s syncs). Detector skips,
    // filter has no structural events, judge NOT called.
    await loop.tick();
    await loop.tick();
    expect(runnerCalls.length).toBe(1);
  });
});

describe("ObserverLoop — pnl_snapshot dedup across ticks", () => {
  let db: Database;
  beforeEach(async () => { db = await freshDb(); });

  test("near-identical PnL after a fire is gated; judge invoked exactly once across 3 ticks", async () => {
    // Reproduces the pnl_snapshot spam scenario.
    //
    // Setup: an ETH short with a price alert crossing on tick 1. The
    // pnl_snapshot tags along because the detector emits one every tick.
    // The judge picks `pnl_snapshot` as the primary event (live evidence:
    // two `pnl_snapshot`-driven messages 33 min apart with Δprice ≈ 0.3%
    // and Δpnl ≈ -$1.2). Without the gate, tick 2 & tick 3 would also
    // pass the existing `filterPassesLlm` because the price_alert is
    // still in the buffer (a single fired rule re-fires per tick until
    // markFired persists — except markFired DOES advance, so the alert
    // disappears tick 2 onward).
    //
    // What we assert: tick 1 fires once (price_alert opens the gate,
    // judge picks pnl_snapshot, stamps `lastFired*`). Ticks 2 & 3 carry
    // only pnl_snapshot, the per-position gate drops it (Δs under
    // thresholds), and the judge is NOT invoked again.
    const stablePosition: Position = {
      symbol: "ETH",
      side: "short",
      size: 1,
      entryPrice: 2_220,
      markPrice: 2_218.6,
      liquidationPrice: 2_500,
      unrealizedPnl: 73.8,
      unrealizedPnlPct: 25.7,
      leverage: 10,
      marginMode: "cross",
      margin: 287,
    };

    const { loop, alertRules, priceCache, runnerCalls } = buildLoop(db, {
      client: stubClient({ positions: [stablePosition] }),
      runnerResponse: JSON.stringify({
        decision: "fire",
        primaryEventType: "pnl_snapshot",
        primarySymbol: "ETH",
        body: "ETH short up +$73.8 (+25.7% on margin).",
        notify: false,
        reason: "test",
      }),
    });

    // Tick 1: a price-target crossing opens the judge gate; the buffer
    // also carries the routine pnl_snapshot for the open ETH short. Judge
    // picks pnl_snapshot as primary and stamps the lastFired* quad.
    alertRules.add("ETH", "below", 2_220);
    priceCache.set("ETH", 2_218.6);

    await loop.tick();
    expect(runnerCalls.length).toBe(1);

    const store = new ObserverStateStore(db);
    const after1 = store.load().positions["ETH|short"];
    expect(after1?.lastFiredPnl).toBeCloseTo(73.8);
    expect(after1?.lastFiredPnlPct).toBeCloseTo(25.7);
    expect(after1?.lastFiredMarkPrice).toBeCloseTo(2_218.6);
    expect(after1?.lastFiredAtMs).not.toBeNull();

    // Tick 2 & 3: alert is gone (markFired). Only pnl_snapshot remains;
    // gate drops it (Δprice% ≈ 0, elapsed ≈ 0), gatedEvents is empty,
    // filterPassesLlm returns false, judge NOT called.
    await loop.tick();
    await loop.tick();
    expect(runnerCalls.length).toBe(1);
  });

  test("cooldown expiry re-opens the gate on the 4th tick (judge fires twice)", async () => {
    // Coverage gap: previous test only asserts the gate-closed direction
    // (3 ticks → judge invoked once). This case mirrors the bug evidence
    // (two messages 33 min apart, each carried in alongside its own price
    // alert) and asserts that once the cooldown expires the pnl_snapshot
    // rides through the gate again. With the new 60-min floor, the
    // cooldown axis is the load-bearing one — Δpnl% and Δprice% stay below
    // their thresholds across all 4 ticks. A second price-alert crossing is
    // armed before tick 4 so `filterPassesLlm` lets the batch through; the
    // judge then sees the (cooldown-expired) pnl_snapshot and fires.
    //
    // Clock injection via `spyOn(Date, "now")` since the loop reads
    // `Date.now()` directly and has no clock-injection seam.
    const stablePosition: Position = {
      symbol: "ETH",
      side: "short",
      size: 1,
      entryPrice: 2_220,
      markPrice: 2_218.6,
      liquidationPrice: 2_500,
      unrealizedPnl: 73.8,
      unrealizedPnlPct: 25.7,
      leverage: 10,
      marginMode: "cross",
      margin: 287,
    };

    const baseMs = 1_730_000_000_000;
    let currentMs = baseMs;
    const nowSpy = spyOn(Date, "now").mockImplementation(() => currentMs);

    try {
      const { loop, alertRules, priceCache, runnerCalls } = buildLoop(db, {
        client: stubClient({ positions: [stablePosition] }),
        runnerResponse: JSON.stringify({
          decision: "fire",
          primaryEventType: "pnl_snapshot",
          primarySymbol: "ETH",
          body: "ETH short up +$73.8 (+25.7% on margin).",
          notify: false,
          reason: "test",
        }),
      });

      // Tick 1: first price-target crossing opens the gate; judge picks
      // pnl_snapshot as primary and stamps the lastFired* quad.
      alertRules.add("ETH", "below", 2_220);
      priceCache.set("ETH", 2_218.6);
      await loop.tick();
      expect(runnerCalls.length).toBe(1);

      // Ticks 2 & 3 within the same cooldown window. Δprice% < 0.5% AND
      // elapsed < MIN_COOLDOWN_MS → gate drops the snapshot,
      // filterPassesLlm short-circuits on the empty events list, judge silent.
      currentMs = baseMs + 10 * 60 * 1000; // +10 min
      await loop.tick();
      currentMs = baseMs + 30 * 60 * 1000; // +30 min
      await loop.tick();
      expect(runnerCalls.length).toBe(1);

      // Tick 4: advance past the 60-min cooldown. With Δprice% still under
      // the floor, the cooldown axis is the one that re-opens the
      // pnl_snapshot gate. A second price-alert crossing is also armed —
      // belt for filterPassesLlm; the cooldown-expired pnl_snapshot would
      // wake the judge on its own under BUG-0146.
      currentMs = baseMs + MIN_COOLDOWN_MS + 1_000; // +60 min + 1 s
      alertRules.add("ETH", "below", 2_219);
      priceCache.set("ETH", 2_218.6);
      await loop.tick();
      expect(runnerCalls.length).toBe(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("BUG-0146: lone pnl_snapshot wakes judge after price moves past floor", async () => {
    // Reproduces the BUG-0146 case: user opens a position, no price alert
    // and no order activity for hours, but price moves materially in their
    // favor. Pre-BUG-0146 the judge would NEVER fire because
    // `filterPassesLlm` dropped pnl_snapshot-only buffers wholesale. Now
    // a snapshot that survives the per-position price/time floor wakes the
    // judge on its own.
    //
    // Clock injection because the loop reads `Date.now()` directly.
    const baseMs = 1_730_000_000_000;
    let currentMs = baseMs;
    const nowSpy = spyOn(Date, "now").mockImplementation(() => currentMs);

    try {
      // Mutable position so we can advance markPrice between ticks.
      const position: Position = {
        symbol: "APT",
        side: "short",
        size: 1_000,
        entryPrice: 0.9642,
        markPrice: 0.9642, // tick 1: at entry
        liquidationPrice: 1.52,
        unrealizedPnl: 0,
        unrealizedPnlPct: 0,
        leverage: 5,
        marginMode: "cross",
        margin: 192.84,
      };
      const client = stubClient({ positions: [position] });

      const { loop, runnerCalls } = buildLoop(db, {
        client,
        runnerResponse: JSON.stringify({
          decision: "fire",
          primaryEventType: "pnl_snapshot",
          primarySymbol: "APT",
          body: "APT short up — running well.",
          notify: false,
          reason: "test",
        }),
      });

      // Tick 1: first sighting — no prior fire, snapshot passes through
      // both filters, judge fires and stamps lastFired* at baseMs.
      await loop.tick();
      expect(runnerCalls.length).toBe(1);

      // Tick 2: 10 min later, price moved 0.1% (under 0.5% floor) →
      // snapshot dropped, judge silent.
      currentMs = baseMs + 10 * 60 * 1000;
      position.markPrice = 0.9633;
      position.unrealizedPnl = 0.9;
      await loop.tick();
      expect(runnerCalls.length).toBe(1);

      // Tick 3: 30 min later, price moved 2.16% (well past 0.5% floor)
      // even though cooldown hasn't elapsed. Pre-fix: dropped wholesale by
      // filterPassesLlm. Post-fix: snapshot survives both filters and
      // wakes the judge — even with no alerts and no order activity.
      currentMs = baseMs + 30 * 60 * 1000;
      position.markPrice = 0.9434;
      position.unrealizedPnl = 20.8;
      position.unrealizedPnlPct = 10.8;
      await loop.tick();
      expect(runnerCalls.length).toBe(2);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("ObserverLoop — cancel dedup across ticks", () => {
  let db: Database;
  beforeEach(async () => { db = await freshDb(); });

  test("same canceled order does not re-emit on subsequent ticks", async () => {
    // HL keeps returning the SAME canceled row on every poll because
    // `lastFillTimestamp` (the historical-orders anchor) only advances on
    // new fills — and no fills are coming. Without the snapshot dedup
    // window, the judge would be invoked every sync. With it, only the
    // first tick fires; the rest are filter-skipped.
    const canceledOrder: OrderRecord = {
      oid: "STALE-CANCEL",
      cloid: null,
      symbol: "BTC",
      side: "buy",
      price: 65_000,
      triggerPrice: null,
      size: 0.1,
      reduceOnly: false,
      status: "canceled",
      timestamp: 1_700_000_000_000,
    };

    const { loop, runnerCalls } = buildLoop(db, {
      client: stubClient({ historicalOrders: [canceledOrder] }),
      runnerResponse: JSON.stringify({
        decision: "fire",
        primaryEventType: "order_canceled",
        primarySymbol: "BTC",
        body: "Cancelled BTC order.",
        notify: false,
        reason: "test",
      }),
    });

    await loop.tick();
    expect(runnerCalls.length).toBe(1);

    // Snapshot now records the oid in the rolling dedup window.
    const store = new ObserverStateStore(db);
    expect(store.load().recentCancelOids).toContain("STALE-CANCEL");

    // Subsequent tick: same HL response, same oid → cancel detector
    // drops it, filter has no structural events left → judge NOT called.
    await loop.tick();
    await loop.tick();
    expect(runnerCalls.length).toBe(1);
  });
});
