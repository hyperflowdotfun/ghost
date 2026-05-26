/**
 * ObserverLoop — composition root for the unified observer.
 *
 * Single loop, two cadences:
 *   - EVAL  every `tickMs` (default 5s): read in-memory state + PriceCache,
 *           run detection, filter, judge, dispatch. Cheap.
 *   - SYNC  every `syncIntervalMs` (default 60s): REST poll HL for
 *           positions / open orders / fills / historical orders. Refreshes
 *           `cachedRest` in-memory. Throttled separately from eval so the
 *           tick can run 12× per HL poll without spiking REST calls.
 *
 * One tick (eval) does:
 *   1. Confirm-card gate: if any approval pending on the main session,
 *      advance baseline quietly + skip the rest.
 *   2. (Sync sub-step, age-aware): if elapsed since last REST sync ≥
 *      `syncIntervalMs`, refresh `cachedRest`.
 *   3. Read AlertRulesService + PriceCache for crossing detection.
 *   4. Diff against prior persisted snapshot → typed events + fired alert ids.
 *   5. Mark fired rules in AlertRulesService.
 *   6. Filter: skip the LLM call when no structural change happened.
 *   7. Invoke event-judge skill (single LLM call): { decision, body, notify }.
 *   8. On fire: dispatch chat (always) + notification (when notify=true).
 *   9. Persist next evaluated baseline.
 *
 * Wired into the BackgroundJobRunner as `observer` via
 * `src/daemon/jobs/observer.ts`.
 */

import type { Logger } from "pino";
import type { Database } from "bun:sqlite";
import type { Runtime } from "../runtime.js";
import type { Runner } from "../agent/runner.js";
import type { ContextBuilder } from "../agent/context-builder.js";
import type { ITradingClient } from "../services/interfaces/trading-client.js";
import type { AlertRulesService } from "../services/alert-rules.js";
import type { NewsService } from "../services/news.js";
import type { NotificationsService, NotificationKind } from "../services/notifications.js";
import type { PriceCache } from "../services/price-cache.js";
import type { ApprovalManager } from "../gateway/approval.js";
import type { SessionManager } from "../session/manager.js";
import type { EventBus } from "../bus/events.js";
import type { ChannelManager } from "../channels/manager.js";
import type { PairingStore } from "../pairing/store.js";
import type { ObserverConfig } from "../config/schema.js";
import { MAIN_SESSION_KEY } from "../session/session.js";
import {
  ObserverStateStore,
  RECENT_CANCEL_OIDS_CAP,
  RECENT_FILL_IDS_CAP,
  RECENT_NEWS_IDS_CAP,
  type ObserverSnapshot,
  type PositionSnapshot,
} from "./state-store.js";
import { diffSnapshot } from "./diff.js";
import { fetchSnapshot, type SnapshotInput } from "./snapshot.js";
import type { ObserverEvent } from "./events.js";
import { callJudge, type JudgeResponse } from "./judge.js";
import { decidePnlDrift, type PnlDriftState } from "./pnl-drift.js";
import type { ChatSnippet } from "../daemon/prompts/event-judge.js";
import { dispatchOutbound, type OutboundChannel } from "../channels/index.js";
import { ChannelId } from "../channels/types.js";
import type { Message } from "@earendil-works/pi-ai";

const RECENT_CHAT_MAX = 20;

/**
 * Per-position `pnl_snapshot` rate-limit thresholds. Code-side floor that
 * prevents waking the LLM judge on every tick of a position whose state
 * hasn't meaningfully moved. The judge skill makes the actual fire/silent
 * decision; this is just a cheap wake-up gate.
 *
 *   - `MIN_PRICE_PCT_DELTA = 0.5` (pct of mark price). Leverage-invariant —
 *     measures the only thing that should re-wake a position-status thought.
 *   - `MIN_COOLDOWN_MS = 60 min`. Matches the event-judge skill's
 *     non-urgent cooldown rule so the code floor and the LLM judge agree
 *     on a single source of truth.
 *
 * The margin-pct gate from BUG-0143 was removed (see BUG-0146): 5% on
 * margin = 1% price at 5x but 0.25% price at 20x — same constant gates
 * very different market moves. Price-pct + time alone is leverage-clean.
 */
export const MIN_PRICE_PCT_DELTA = 0.5;
export const MIN_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Filter `pnl_snapshot` events against per-position last-fired thresholds.
 *
 * For each pnl_snapshot in `events`:
 *   - If the corresponding `priorPositions[key]` has no `lastFired*` triple
 *     (any field null) → keep (first fire is unconstrained).
 *   - Else drop iff BOTH of these hold vs the prior fire:
 *       |Δprice%| < MIN_PRICE_PCT_DELTA
 *       (nowMs - lastFiredAtMs) < MIN_COOLDOWN_MS
 *   - Either threshold exceeded → keep (the snapshot reflects a meaningful
 *     change worth letting the judge see).
 *
 * Non-pnl_snapshot events pass through untouched. Pure helper — exported
 * for unit-test coverage.
 */
export function filterPnlSnapshots(
  events: ObserverEvent[],
  priorPositions: Record<string, PositionSnapshot>,
  nowMs: number,
): ObserverEvent[] {
  return events.filter((ev) => {
    if (ev.type !== "pnl_snapshot") return true;
    const key = `${ev.symbol.toUpperCase()}|${ev.side}`;
    const prior = priorPositions[key];
    if (!prior) return true;
    const { lastFiredMarkPrice, lastFiredAtMs } = prior;
    if (
      lastFiredMarkPrice === null ||
      lastFiredAtMs === null ||
      lastFiredMarkPrice === 0
    ) {
      return true; // never fired before — pass through.
    }
    const pricePctDelta = Math.abs(
      ((ev.markPrice - lastFiredMarkPrice) / lastFiredMarkPrice) * 100,
    );
    const elapsedMs = nowMs - lastFiredAtMs;
    const bothBelow =
      pricePctDelta < MIN_PRICE_PCT_DELTA && elapsedMs < MIN_COOLDOWN_MS;
    return !bothBelow;
  });
}

/**
 * Decide whether the diff result warrants spending an LLM call. Any event
 * that survived the upstream `filterPnlSnapshots` floor counts — including
 * a lone `pnl_snapshot`, since surviving the floor means price moved past
 * MIN_PRICE_PCT_DELTA or the per-position cooldown elapsed. Open-order set
 * change is a fallback wake reason for ticks with zero events.
 */
export function filterPassesLlm(
  events: ObserverEvent[],
  prior: ObserverSnapshot,
  currentOpenOrderIds: string[],
): boolean {
  if (events.length > 0) return true;
  const priorIds = new Set(prior.openOrderIds);
  if (priorIds.size !== currentOpenOrderIds.length) return true;
  for (const id of currentOpenOrderIds) {
    if (!priorIds.has(id)) return true;
  }
  return false;
}

export interface ObserverLoopDeps {
  db: Database;
  config: ObserverConfig;
  tradingClient: ITradingClient;
  alertRules: AlertRulesService;
  newsService: NewsService;
  notifications: NotificationsService;
  priceCache: PriceCache;
  approvalManager: ApprovalManager;
  sessionManager: SessionManager;
  eventBus: EventBus;
  channelManager: ChannelManager;
  pairingStore: PairingStore;
  runner: Runner;
  contextBuilder: ContextBuilder;
  logger: Logger;
  /** Lazy bus accessor so tests can stub. Production passes runtime.bus. */
  getMessageBus: () => Runtime["bus"];
}

export class ObserverLoop {
  private readonly store: ObserverStateStore;
  private cachedRest: SnapshotInput | null = null;
  // Seeded to construction time, NOT null. Treats "daemon just started" as
  // "we just spoke" so the judge stays quiet on routine status (pnl_snapshot,
  // routine order_filled) for the first hour after every boot. Without this,
  // the first tick post-restart fires "ETH short running nicely +$X" the
  // moment the user opens the web app — which is exactly the spam complaint
  // this loop is supposed to prevent.
  private lastProactiveAtMs: number;
  // Portfolio PnL-drift detector state. In-memory only — a daemon restart
  // re-seeds the baseline on the next tick, intentionally muting the first
  // post-restart drift evaluation. See pnl-drift.ts for thresholds.
  private pnlDriftState: PnlDriftState = { lastSnapshotPnl: null, lastSentAtMs: null };

  constructor(private readonly deps: ObserverLoopDeps) {
    this.store = new ObserverStateStore(deps.db);
    this.lastProactiveAtMs = Date.now();
  }

  /**
   * One observer pass. Catches all errors internally — never throws back
   * to the BackgroundJobRunner so a transient HL outage doesn't disable
   * the loop. Emits exactly one info-level log line per tick.
   */
  async tick(): Promise<void> {
    const nowMs = Date.now();

    // -----------------------------------------------------------------
    // 0. Wallet gate. Account-data endpoints (`clearinghouseState`,
    //    `openOrders`, fills, historical orders) all require a valid HL
    //    address. With no wallet connected the trading client's
    //    `defaultAddress` is the empty string and HL responds 422 on every
    //    sync — which previously surfaced as a noisy WARN every tickMs.
    //    Quietly no-op until a wallet is connected.
    // -----------------------------------------------------------------
    if (!this.deps.tradingClient.address) {
      this.deps.logger.debug("observer tick — no wallet connected, skipping");
      return;
    }

    const prior = this.store.load();

    // -----------------------------------------------------------------
    // 1. Confirm-card gate.
    // -----------------------------------------------------------------
    const pending = this.deps.approvalManager.getPending(MAIN_SESSION_KEY);
    if (pending) {
      await this.refreshBaselineQuietly(prior, nowMs);
      this.deps.logger.debug("observer tick — gated (confirm card open)");
      return;
    }

    // -----------------------------------------------------------------
    // 2. Age-aware REST sync.
    // -----------------------------------------------------------------
    let rest: SnapshotInput;
    let synced = false;
    const syncDue =
      this.cachedRest === null ||
      nowMs - prior.lastRestSyncAtMs >= this.deps.config.syncIntervalMs;
    try {
      if (syncDue) {
        rest = await fetchSnapshot(this.deps.tradingClient, prior.lastFillTimestamp);
        this.cachedRest = rest;
        synced = true;
      } else {
        rest = this.cachedRest!;
      }
    } catch (err) {
      this.deps.logger.warn({ err }, "observer tick — REST sync failed");
      return;
    }

    // -----------------------------------------------------------------
    // 3. Detect — pure predicates over (rest + alertRules + priceCache + news).
    //    News query gates on "user has at least one open position": F18
    //    scope is news impact on held positions; flat user has nothing
    //    actionable, and the /news widget already covers passive reading.
    // -----------------------------------------------------------------
    const currentOpenOrderIds = rest.openOrders.map((o) => o.orderId);
    const prices = this.deps.priceCache.snapshot();
    const alertRules = this.deps.alertRules.list();

    const articles = rest.positions.length === 0
      ? []
      : this.deps.newsService.listRecentRelevant(newsScanSinceTs(prior.lastNewsScanTs, nowMs));

    const diff = diffSnapshot({
      prior,
      positions: rest.positions,
      openOrders: rest.openOrders,
      newFills: rest.newFills,
      newHistoricalOrders: rest.newHistoricalOrders,
      alertRules,
      prices,
      liqProgressThreshold: this.deps.config.liquidationProgressThreshold,
      articles,
      nowMs,
    });

    // -----------------------------------------------------------------
    // 4. Mark fired alert rules. Idempotent — `markFired` no-ops when
    //    already fired, so re-running across ticks before sync advances
    //    won't re-emit.
    // -----------------------------------------------------------------
    for (const id of diff.firedAlertIds) {
      this.deps.alertRules.markFired(id, Math.floor(nowMs / 1000));
    }

    // -----------------------------------------------------------------
    // 4b. Per-position pnl_snapshot rate-limit. Drop snapshots
    //     where Δpnl%, Δprice%, AND elapsed-ms are all under threshold vs
    //     the prior fired pnl message on the same position. Detector keeps
    //     emitting every tick; the gate sits between diff and judge.
    // -----------------------------------------------------------------
    const gatedEvents = filterPnlSnapshots(diff.events, prior.positions, nowMs);

    // -----------------------------------------------------------------
    // 4c. Portfolio PnL-drift gate. Account-level drift while the user is
    //     idle for hours is a separate signal from per-position pnl_snapshot:
    //     it can fire even when no single position moved past the per-position
    //     price floor, and it intentionally bypasses that floor when the user
    //     has been silent long enough that one summary message is welcome.
    //
    //     With zero open positions the totalUnrealizedPnl collapses to 0,
    //     which would (with a non-zero baseline from a prior tick) look like
    //     a 100% drift and fire a stale "PnL went from $X to $0" message
    //     hours after the close. Re-seed the baseline on empty portfolio so
    //     the next position open starts a fresh observation window.
    // -----------------------------------------------------------------
    if (rest.positions.length === 0) {
      this.pnlDriftState = { lastSnapshotPnl: null, lastSentAtMs: null };
    } else {
      const totalUnrealizedPnl = rest.positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
      const session = this.deps.sessionManager.getOrCreate(MAIN_SESSION_KEY);
      const lastUserActivityMs = session.lastActiveAt?.getTime() ?? null;
      const driftDecision = decidePnlDrift({
        state: this.pnlDriftState,
        currentPnl: totalUnrealizedPnl,
        lastUserActivityMs,
        nowMs,
      });
      if (driftDecision.fire) {
        gatedEvents.push(driftDecision.event);
      }
      this.pnlDriftState = {
        lastSnapshotPnl: driftDecision.nextSnapshotPnl,
        lastSentAtMs: driftDecision.fire ? nowMs : this.pnlDriftState.lastSentAtMs,
      };
    }

    // -----------------------------------------------------------------
    // 5. Next baseline. Persist AFTER eval succeeds so a crash mid-tick
    //    re-evaluates the same input next tick (idempotent).
    // -----------------------------------------------------------------
    const nextSnapshot: ObserverSnapshot = {
      positions: diff.nextPositions,
      lastFillTimestamp: rest.latestFillTimestamp,
      openOrderIds: currentOpenOrderIds,
      lastRestSyncAtMs: synced ? nowMs : prior.lastRestSyncAtMs,
      recentCancelOids: mergeCancelOids(prior.recentCancelOids, diff.emittedCancelOids),
      recentEmittedFillIds: mergeBoundedIds(
        prior.recentEmittedFillIds,
        diff.emittedFillIds,
        RECENT_FILL_IDS_CAP,
      ),
      recentEmittedNewsIds: mergeBoundedIds(
        prior.recentEmittedNewsIds,
        diff.emittedNewsIds,
        RECENT_NEWS_IDS_CAP,
      ),
      lastNewsScanTs: maxArticlePublishedAtSec(articles, prior.lastNewsScanTs),
    };
    const scanCounts = {
      positions: rest.positions.length,
      orders: rest.openOrders.length,
      fills: rest.newFills.length,
      history: rest.newHistoricalOrders.length,
      alertRules: alertRules.length,
      firedAlerts: diff.firedAlertIds.length,
      synced,
    };

    // -----------------------------------------------------------------
    // 6. Filter — skip LLM when nothing structural happened. Operates on
    //    the pnl-gated event list so a tick whose only events were
    //    rate-limited pnl_snapshots also short-circuits.
    // -----------------------------------------------------------------
    if (!filterPassesLlm(gatedEvents, prior, currentOpenOrderIds)) {
      this.store.save(nextSnapshot);
      this.deps.eventBus.publish({
        type: "observer.tick",
        payload: { eventCount: gatedEvents.length, decision: "skip", ts: nowMs },
      });
      this.deps.logger.debug(
        { ...scanCounts, events: gatedEvents.length, decision: "skip" },
        "observer tick — no structural change, judge skipped",
      );
      return;
    }

    // -----------------------------------------------------------------
    // 7. Judge skill — single LLM call. Decides body + notify flag.
    // -----------------------------------------------------------------
    const recentChat = this.snapshotRecentChat();
    let judge: JudgeResponse;
    try {
      judge = await callJudge({
        runner: this.deps.runner,
        contextBuilder: this.deps.contextBuilder,
        events: gatedEvents,
        recentChat,
        lastProactiveAtMs: this.lastProactiveAtMs,
        nowMs,
      });
    } catch (err) {
      this.deps.logger.warn({ err }, "observer: judge call failed — treating as silent");
      judge = {
        decision: "silent",
        primaryEventType: null,
        primarySymbol: null,
        body: null,
        notify: false,
        reason: "judge_threw",
      };
    }

    this.deps.eventBus.publish({
      type: "observer.tick",
      payload: {
        eventCount: gatedEvents.length,
        decision: judge.decision,
        primaryEventType: judge.primaryEventType,
        primarySymbol: judge.primarySymbol,
        reason: judge.reason,
        ts: nowMs,
      },
    });

    // -----------------------------------------------------------------
    // 8. Dispatch on fire.
    // -----------------------------------------------------------------
    if (judge.decision === "fire" && judge.body) {
      await this.dispatch(judge, nowMs);
      this.lastProactiveAtMs = nowMs;
    }

    // Arm the per-position pnl_snapshot floor for every pnl_snapshot the
    // judge actually examined — fire OR silent. Reason: the floor is a
    // wake-up gate, not a "spoke to user" record. If the judge spent an
    // LLM call considering this position's PnL state, we shouldn't wake
    // it again on the same state next tick. Without this, a silent judge
    // verdict (e.g. "position running fine, no need to chat") would
    // re-wake every tick and burn LLM cost.
    stampPnlFloor(nextSnapshot, gatedEvents, nowMs);

    this.deps.logger.debug(
      {
        ...scanCounts,
        events: gatedEvents.length,
        eventTypes: countEventsByType(gatedEvents),
        decision: judge.decision,
        primaryEventType: judge.primaryEventType,
        primarySymbol: judge.primarySymbol,
        notify: judge.notify,
        reason: judge.reason,
      },
      `observer tick — judge ${judge.decision}`,
    );

    // -----------------------------------------------------------------
    // 9. Persist baseline.
    // -----------------------------------------------------------------
    this.store.save(nextSnapshot);
  }

  /**
   * Refresh the persisted baseline while a confirm card blocks the tick.
   * REST sync still respects the age gate; no events are emitted, no LLM
   * call is made, no fired rules are marked. The next post-confirm tick
   * diffs against fresh state.
   */
  private async refreshBaselineQuietly(prior: ObserverSnapshot, nowMs: number): Promise<void> {
    try {
      let rest: SnapshotInput;
      const syncDue =
        this.cachedRest === null ||
        nowMs - prior.lastRestSyncAtMs >= this.deps.config.syncIntervalMs;
      if (syncDue) {
        rest = await fetchSnapshot(this.deps.tradingClient, prior.lastFillTimestamp);
        this.cachedRest = rest;
      } else {
        rest = this.cachedRest!;
      }
      // No news under confirm gate — next post-confirm tick picks them up.
      const diff = diffSnapshot({
        prior,
        positions: rest.positions,
        openOrders: rest.openOrders,
        newFills: rest.newFills,
        newHistoricalOrders: rest.newHistoricalOrders,
        alertRules: this.deps.alertRules.list(),
        prices: this.deps.priceCache.snapshot(),
        liqProgressThreshold: this.deps.config.liquidationProgressThreshold,
        articles: [],
        nowMs,
      });
      this.store.save({
        positions: diff.nextPositions,
        lastFillTimestamp: rest.latestFillTimestamp,
        openOrderIds: rest.openOrders.map((o) => o.orderId),
        lastRestSyncAtMs: syncDue ? nowMs : prior.lastRestSyncAtMs,
        recentCancelOids: mergeCancelOids(prior.recentCancelOids, diff.emittedCancelOids),
        recentEmittedFillIds: mergeBoundedIds(
          prior.recentEmittedFillIds,
          diff.emittedFillIds,
          RECENT_FILL_IDS_CAP,
        ),
        recentEmittedNewsIds: prior.recentEmittedNewsIds,
        lastNewsScanTs: prior.lastNewsScanTs,
      });
    } catch (err) {
      this.deps.logger.warn({ err }, "observer: baseline refresh failed under confirm gate");
    }
  }

  /**
   * Single dispatch path. Chat broadcast goes to web + every paired
   * Telegram identity. When `notify=true`, also stamps a row into
   * NotificationsService (powers bell-dropdown).
   */
  private async dispatch(judge: JudgeResponse, nowMs: number): Promise<void> {
    if (!judge.body) return;

    const messageId = `observer:${nowMs}:${crypto.randomUUID()}`;

    const channels = this.buildOutboundChannels();

    // Chat broadcast — every fire produces a chat turn.
    await dispatchOutbound(channels, judge.body, {
      eventBus: this.deps.eventBus,
      bus: this.deps.getMessageBus(),
      source: judge.notify ? `observer:notify` : `observer:chat`,
      id: messageId,
      logger: this.deps.logger,
    });

    // Persist into the main session so `chat.history` returns the
    // message after F5. Web's HistoryMessage reads only role/content/
    // timestamp/id — pi-ai's api/provider/model/usage fields are elided
    // via the cast (synthetic turns never round-trip through pi-ai
    // consumers).
    try {
      const session = this.deps.sessionManager.getOrCreate(MAIN_SESSION_KEY);
      session.addMessage({
        role: "assistant",
        content: [{ type: "text", text: judge.body }],
        timestamp: nowMs,
        id: messageId,
      } as unknown as Message);
    } catch (err) {
      this.deps.logger.warn(
        { err, messageId },
        "observer: failed to persist proactive message to session log",
      );
    }

    if (!judge.notify) return;

    // Notification badge — typed kind, no schema-abuse sentinels.
    const kind = mapKindFromEventType(judge.primaryEventType);
    const symbol = judge.primarySymbol ?? undefined;
    try {
      this.deps.notifications.insert(kind, judge.body, {
        id: messageId,
        symbol,
        payload: { primaryEventType: judge.primaryEventType },
        tsUnix: Math.floor(nowMs / 1000),
      });
    } catch (err) {
      this.deps.logger.warn({ err, id: messageId }, "observer: notification insert failed");
    }
  }

  /**
   * Expand outbound channels to web + every allowlisted Telegram identity.
   * Differs from the generic `getOutboundChannels` (which returns only the
   * primary chat) so multi-paired users receive every observer message.
   */
  private buildOutboundChannels(): OutboundChannel[] {
    const out: OutboundChannel[] = [{ kind: "web" }];
    if (this.deps.channelManager.isActive(ChannelId.Telegram)) {
      const ids = this.deps.pairingStore.listAllowlistIdentities(ChannelId.Telegram);
      for (const chatId of ids) {
        if (!/^\d+$/.test(chatId)) continue;
        out.push({ kind: ChannelId.Telegram, chatId });
      }
    }
    return out;
  }

  /**
   * Last N text-bearing messages from the main session, oldest first.
   * Tool calls / synthetic markers are stripped so the judge prompt sees
   * only conversational substance.
   */
  private snapshotRecentChat(): ChatSnippet[] {
    const session = this.deps.sessionManager.getOrCreate(MAIN_SESSION_KEY);
    const out: ChatSnippet[] = [];
    for (const msg of session.messages) {
      const m = msg as { role?: string; content?: unknown; timestamp?: number };
      if (m.role !== "user" && m.role !== "assistant") continue;
      // Inbound user messages persist `content` as a plain string
      // (orchestrator.ts:183); assistant turns and SDK-shaped messages use
      // the array-of-blocks shape. Accept both so the judge sees full chat
      // context after a daemon restart, not just array-shape entries.
      let text = "";
      if (typeof m.content === "string") {
        text = m.content;
      } else if (Array.isArray(m.content)) {
        for (const block of m.content as Array<{ type?: string; text?: unknown }>) {
          if (block?.type === "text" && typeof block.text === "string") {
            text += block.text;
          }
        }
      }
      if (text.trim().length === 0) continue;
      out.push({
        role: m.role,
        text: text.trim(),
        timestamp: typeof m.timestamp === "number" ? m.timestamp : Date.now(),
      });
    }
    return out.slice(-RECENT_CHAT_MAX);
  }
}

/**
 * Append freshly-emitted ids to a rolling dedup window. Dedup is preserved
 * (Set-based) and the result is truncated to `cap`, keeping the MOST RECENT
 * entries (newest at the tail). Pure helper for testability — shared by both
 * `recentCancelOids` and `recentEmittedFillIds`.
 */
export function mergeBoundedIds(
  prior: ReadonlyArray<string>,
  fresh: ReadonlyArray<string>,
  cap: number,
): string[] {
  if (fresh.length === 0) {
    return prior.length <= cap ? [...prior] : prior.slice(prior.length - cap);
  }
  const seen = new Set<string>(prior);
  const merged = [...prior];
  for (const id of fresh) {
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(id);
  }
  if (merged.length <= cap) return merged;
  return merged.slice(merged.length - cap);
}

/** Cancel-oid specific wrapper preserved so existing call sites and tests
 *  read naturally. */
function mergeCancelOids(prior: ReadonlyArray<string>, fresh: ReadonlyArray<string>): string[] {
  return mergeBoundedIds(prior, fresh, RECENT_CANCEL_OIDS_CAP);
}

/**
 * Stamp the last-fired pnl_snapshot quad onto the next-snapshot position
 * row after a successful judge fire. No-op for non-pnl fires.
 * Picks the matching event by `(symbol, side)` from `gatedEvents` (the
 * judge only ever sees gated events) and uses its current PnL / mark as
 * the fire-time anchor.
 *
 * Mutates `nextSnapshot.positions[key]` in place — the snapshot is owned
 * by the caller and persisted immediately after this call.
 */
function stampPnlFloor(
  nextSnapshot: ObserverSnapshot,
  gatedEvents: ObserverEvent[],
  nowMs: number,
): void {
  for (const ev of gatedEvents) {
    if (ev.type !== "pnl_snapshot") continue;
    const key = `${ev.symbol.toUpperCase()}|${ev.side}`;
    const entry = nextSnapshot.positions[key];
    if (!entry) continue;
    entry.lastFiredPnl = ev.unrealizedPnl;
    entry.lastFiredPnlPct = ev.unrealizedPnlPct;
    entry.lastFiredMarkPrice = ev.markPrice;
    entry.lastFiredAtMs = nowMs;
  }
}

/** Compact event-type histogram for the per-tick info log. */
function countEventsByType(events: ObserverEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const ev of events) out[ev.type] = (out[ev.type] ?? 0) + 1;
  return out;
}

/**
 * Map the judge's `primaryEventType` to the notification kind used for the
 * bell-dropdown row. Returns a typed `NotificationKind` so callers don't
 * need an escape hatch.
 */
function mapKindFromEventType(t: string | null): NotificationKind {
  switch (t) {
    case "position_liquidated":
    case "liquidation_risk":
      return "liquidation_risk";
    case "tp_hit":
      return "tp_hit";
    case "sl_hit":
      return "sl_hit";
    case "position_closed":
      return "position_closed";
    case "price_alert":
      return "price_target";
    case "order_canceled":
      return "order_canceled";
    case "order_filled":
      return "order_filled";
    case "news":
      return "news";
    default:
      return "proactive";
  }
}

/**
 * Sliding lookback floor for `NewsService.listRecentRelevant(sinceTs)`.
 * Bounds the query slice so a stale `lastNewsScanTs` (or first run) doesn't
 * pull the entire articles table.
 */
export const NEWS_LOOKBACK_FLOOR_SEC = 30 * 60;

/** Anchor or sliding floor, whichever is newer. */
export function newsScanSinceTs(lastScanTs: number, nowMs: number): number {
  const slidingFloor = Math.floor(nowMs / 1000) - NEWS_LOOKBACK_FLOOR_SEC;
  return lastScanTs > slidingFloor ? lastScanTs : slidingFloor;
}

function maxArticlePublishedAtSec(
  articles: ReadonlyArray<{ publishedAt: number }>,
  prior: number,
): number {
  let max = prior;
  for (const a of articles) {
    if (a.publishedAt > max) max = a.publishedAt;
  }
  return max;
}
