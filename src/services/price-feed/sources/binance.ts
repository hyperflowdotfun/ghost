/**
 * BinanceSource — subscribe-based, multi-stream Binance USDⓈ-M perp client.
 *
 * One WebSocket (combined stream `!markPrice@arr@1s/!miniTicker@arr`) feeds
 * two subscriber lists:
 *
 *   - subscribeMarkPrice: mark price ticks (HL parity for trading composite)
 *   - subscribeMiniTicker: last price + 24h-open (watchlist UI for % change)
 *
 * The class does NOT implement `PriceSource` because that interface is
 * single-callback. Adapter functions in `./binance.ts` wrap the
 * source into per-stream `PriceSource` views for the trading composite +
 * watchlist feed.
 *
 * Lifecycle is refcount-driven: the first `subscribe*` opens the WS; the
 * last unsubscribe closes it. Re-subscribing after teardown re-opens.
 *
 * Structural filters (non-USDT, stable-stable, leveraged tokens) apply to
 * both streams — they reject genuinely invalid Binance pairs neither
 * consumer wants.
 *
 * REST fallback polls premiumIndex for mark and ticker/24hr for mini, each
 * updating its own `lastXxxTickAt`.
 */

import type { Logger } from "pino";
import { mapBinanceSymbol } from "../symbol-mapping.js";
import type { PriceSource } from "../types.js";

const DEFAULT_WS_URL =
  "wss://fstream.binance.com/stream?streams=!markPrice@arr@1s/!miniTicker@arr";
const MARK_STREAM = "!markPrice@arr@1s";
const MINI_STREAM = "!miniTicker@arr";

const DEFAULT_MARK_REST_URL = "https://fapi.binance.com/fapi/v1/premiumIndex";
const DEFAULT_MINI_REST_URL = "https://fapi.binance.com/fapi/v1/ticker/24hr";
const DEFAULT_REST_INTERVAL_MS = 5_000;
const DEFAULT_WS_STALE_MS = 10_000;
const DEFAULT_WS_STABILITY_MS = 5_000;
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 1_000;
const DEFAULT_WS_RETRY_BASE_MS = 5_000;
const DEFAULT_WS_RETRY_MAX_MS = 60_000;

const STABLE_BASES = new Set([
  "USDC", "FDUSD", "TUSD", "DAI", "USDP", "BUSD", "USDD", "USDE", "PYUSD", "USDB",
]);
const LEVERAGED_SUFFIX_RE = /(?:UP|DOWN|BULL|BEAR)$/;

export type StreamTickCallback = (
  symbol: string,
  price: number,
  prevDayPrice: number | undefined,
) => void;

export interface BinanceSourceOptions {
  logger: Logger;
  wsUrl?: string;
  /** WebSocket factory override for tests. */
  wsConnect?: (url: string) => WebSocket;
  markRestUrl?: string;
  miniRestUrl?: string;
  restIntervalMs?: number;
  wsStaleMs?: number;
  wsStabilityMs?: number;
  healthCheckIntervalMs?: number;
  /** Base delay for WS reconnect backoff. Default 5s. */
  wsRetryBaseMs?: number;
  /** Max delay for WS reconnect backoff. Default 60s. */
  wsRetryMaxMs?: number;
  fetchFn?: (input: string) => Promise<Response>;
}

interface CombinedFrame {
  stream?: string;
  data?: BinanceTickFrame[];
}

interface BinanceTickFrame {
  s?: string;
  p?: string;
  c?: string;
  o?: string;
}

export class BinanceSource {
  private readonly log: Logger;
  private readonly wsUrl: string;
  private readonly wsConnect: (url: string) => WebSocket;

  private readonly markRestUrl: string;
  private readonly miniRestUrl: string;
  private readonly restIntervalMs: number;
  private readonly wsStaleMs: number;
  private readonly wsStabilityMs: number;
  private readonly healthCheckIntervalMs: number;
  private readonly wsRetryBaseMs: number;
  private readonly wsRetryMaxMs: number;
  private readonly fetchFn: (input: string) => Promise<Response>;

  private readonly markSubs = new Set<StreamTickCallback>();
  private readonly miniSubs = new Set<StreamTickCallback>();

  private ws: WebSocket | null = null;
  private lastMarkTickAt = 0;
  private lastMiniTickAt = 0;

  private restTimer: ReturnType<typeof setTimeout> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private wsRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private wsRetryCount = 0;
  private restPolling = false;
  private wsHealthySinceMs = 0;
  private startedAt = 0;
  private shuttingDown = false;

  constructor(opts: BinanceSourceOptions) {
    this.log = opts.logger;
    this.wsUrl = opts.wsUrl ?? DEFAULT_WS_URL;
    this.wsConnect = opts.wsConnect ?? ((url: string) => new WebSocket(url));
    this.markRestUrl = opts.markRestUrl ?? DEFAULT_MARK_REST_URL;
    this.miniRestUrl = opts.miniRestUrl ?? DEFAULT_MINI_REST_URL;
    this.restIntervalMs = opts.restIntervalMs ?? DEFAULT_REST_INTERVAL_MS;
    this.wsStaleMs = opts.wsStaleMs ?? DEFAULT_WS_STALE_MS;
    this.wsStabilityMs = opts.wsStabilityMs ?? DEFAULT_WS_STABILITY_MS;
    this.healthCheckIntervalMs = opts.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS;
    this.wsRetryBaseMs = opts.wsRetryBaseMs ?? DEFAULT_WS_RETRY_BASE_MS;
    this.wsRetryMaxMs = opts.wsRetryMaxMs ?? DEFAULT_WS_RETRY_MAX_MS;
    this.fetchFn = opts.fetchFn ?? ((input: string) => fetch(input));
  }

  subscribeMarkPrice(cb: StreamTickCallback): () => void {
    this.markSubs.add(cb);
    this.ensureStarted();
    return () => {
      this.markSubs.delete(cb);
      this.maybeStop();
    };
  }

  subscribeMiniTicker(cb: StreamTickCallback): () => void {
    this.miniSubs.add(cb);
    this.ensureStarted();
    return () => {
      this.miniSubs.delete(cb);
      this.maybeStop();
    };
  }

  getLastMarkTickAt(): number { return this.lastMarkTickAt; }
  getLastMiniTickAt(): number { return this.lastMiniTickAt; }

  /** Public escape hatch — close WS + cancel timers regardless of subscribers.
   *  Used by tests; also safe for daemon shutdown. */
  shutdown(): void {
    this.markSubs.clear();
    this.miniSubs.clear();
    this.teardown();
  }

  isRestPolling(): boolean { return this.restPolling; }

  /**
   * Production WS `message` dispatcher. Also reused as a test entry point
   * to drive frames without opening a real socket — pass a string `raw` and
   * the parse + dispatch path runs as if a real frame arrived.
   */
  handleWsMessage(raw: unknown): void {
    if (this.ws === null) return;
    const text = typeof raw === "string" ? raw : null;
    if (text === null) return;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return; }
    const frame = parsed as CombinedFrame;
    if (!frame || typeof frame !== "object") return;
    if (!Array.isArray(frame.data)) return;

    if (frame.stream === MARK_STREAM) {
      this.dispatch(frame.data, "mark");
    } else if (frame.stream === MINI_STREAM) {
      this.dispatch(frame.data, "mini");
    }
  }

  private ensureStarted(): void {
    if (this.ws !== null) return;
    this.shuttingDown = false;
    if (this.startedAt === 0) this.startedAt = Date.now();
    if (this.healthTimer === null) {
      this.healthTimer = setInterval(
        () => { this.reconcileTransports(); },
        this.healthCheckIntervalMs,
      );
    }
    this.connectWs();
  }

  private connectWs(): void {
    if (this.shuttingDown) return;
    if (this.ws !== null) return;
    this.wsHealthySinceMs = 0;
    const ws = this.wsConnect(this.wsUrl);
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.wsRetryCount = 0;
      this.log.info("binance source: WS connected");
    });
    ws.addEventListener("message", (ev: MessageEvent) => {
      this.handleWsMessage(ev.data);
    });
    ws.addEventListener("error", (ev) => {
      if (this.shuttingDown) return;
      this.log.warn(
        { event: serializeWsErrorEvent(ev) },
        "binance source: WS error",
      );
    });
    // WebSocket spec: `close` always follows `error`. Trigger reconnect
    // from `close` only — retrying on both would double-schedule.
    ws.addEventListener("close", () => {
      if (this.shuttingDown) return;
      if (this.markSubs.size + this.miniSubs.size === 0) return;
      this.ws = null;
      this.log.warn("binance source: WS closed, scheduling retry");
      this.scheduleWsRetry();
    });
    this.log.info({ url: this.wsUrl }, "binance source: WS opened");
  }

  private scheduleWsRetry(): void {
    if (this.shuttingDown) return;
    if (this.wsRetryTimer !== null) return;
    if (this.markSubs.size + this.miniSubs.size === 0) return;
    const delay = Math.min(this.wsRetryBaseMs * 2 ** this.wsRetryCount, this.wsRetryMaxMs);
    this.wsRetryCount++;
    this.log.info({ delay, attempt: this.wsRetryCount }, "binance source: WS retry scheduled");
    this.wsRetryTimer = setTimeout(() => {
      this.wsRetryTimer = null;
      if (this.shuttingDown) return;
      if (this.markSubs.size + this.miniSubs.size === 0) return;
      this.connectWs();
    }, delay);
  }

  private maybeStop(): void {
    if (this.markSubs.size + this.miniSubs.size > 0) return;
    this.teardown();
  }

  private teardown(): void {
    this.shuttingDown = true;
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
    if (this.wsRetryTimer) { clearTimeout(this.wsRetryTimer); this.wsRetryTimer = null; }
    this.wsRetryCount = 0;
    this.startedAt = 0;
    this.deactivateRest();
    if (this.ws !== null) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.log.info("binance source: torn down");
  }

  private dispatch(data: BinanceTickFrame[], kind: "mark" | "mini"): void {
    const subs = kind === "mark" ? this.markSubs : this.miniSubs;
    if (subs.size === 0) return;
    const now = Date.now();
    let anyEmitted = false;
    for (const entry of data) {
      const sym = entry?.s;
      const priceStr = kind === "mark" ? entry?.p : entry?.c;
      if (typeof sym !== "string" || typeof priceStr !== "string") continue;
      const emitted = kind === "mark"
        ? this.emitMark(sym, priceStr, subs)
        : this.emitMini(sym, priceStr, entry.o, subs);
      if (emitted) anyEmitted = true;
    }
    if (anyEmitted) {
      if (kind === "mark") this.lastMarkTickAt = now;
      else this.lastMiniTickAt = now;
    }
  }

  /**
   * Mark stream — feeds the trading composite (HL-parity). Translates the
   * Binance symbol to its HL-canonical name (BTCUSDT→BTC, PEPEUSDT→kPEPE×1000)
   * and drops ticks for symbols HL doesn't list.
   */
  private emitMark(
    binanceSymbol: string,
    priceStr: string,
    subs: Set<StreamTickCallback>,
  ): boolean {
    if (!passesStructuralFilter(binanceSymbol)) return false;
    const price = parseFloat(priceStr);
    if (!Number.isFinite(price)) return false;
    const mapping = mapBinanceSymbol(binanceSymbol);
    if (mapping === null) return false;
    const hlPrice = price * mapping.multiplier;
    for (const cb of subs) cb(mapping.hlSymbol, hlPrice, undefined);
    return true;
  }

  /**
   * Mini stream — feeds the watchlist UI. Emits native Binance symbols +
   * 24h-open prevDay so the FE can render ALL Binance pairs and compute %
   * change. No HL mapping applied.
   */
  private emitMini(
    binanceSymbol: string,
    priceStr: string,
    prevDayPriceStr: string | undefined,
    subs: Set<StreamTickCallback>,
  ): boolean {
    if (!passesStructuralFilter(binanceSymbol)) return false;
    const price = parseFloat(priceStr);
    if (!Number.isFinite(price)) return false;

    let prevDay: number | undefined;
    if (prevDayPriceStr !== undefined) {
      const p = Number.parseFloat(prevDayPriceStr);
      if (Number.isFinite(p) && p > 0) prevDay = p;
    }

    for (const cb of subs) cb(binanceSymbol, price, prevDay);
    return true;
  }

  // --- Internal REST fallback orchestration --------------------------------

  private reconcileTransports(): void {
    if (this.shuttingDown) return;
    const now = Date.now();
    const lastWsTickAt = Math.max(this.lastMarkTickAt, this.lastMiniTickAt);
    const wsAge = lastWsTickAt === 0 ? now - this.startedAt : now - lastWsTickAt;
    const wsFresh = wsAge <= this.wsStaleMs && lastWsTickAt > 0;

    if (wsFresh) {
      if (this.wsHealthySinceMs === 0) this.wsHealthySinceMs = now;
    } else if (wsAge > this.wsStaleMs) {
      this.wsHealthySinceMs = 0;
    }

    if (!this.restPolling) {
      if (wsAge > this.wsStaleMs) {
        this.log.warn({ wsAgeMs: wsAge }, "binance source: WS stale, activating REST fallback");
        this.activateRest();
      }
      return;
    }
    if (!wsFresh) return;
    if (now - this.wsHealthySinceMs < this.wsStabilityMs) return;
    this.log.info("binance source: WS stable, deactivating REST fallback");
    this.deactivateRest();
  }

  private activateRest(): void {
    if (this.shuttingDown || this.restPolling) return;
    this.restPolling = true;
    this.restTimer = setTimeout(() => { void this.restTick(); }, 0);
  }

  private deactivateRest(): void {
    this.restPolling = false;
    if (this.restTimer !== null) { clearTimeout(this.restTimer); this.restTimer = null; }
  }

  private async restTick(): Promise<void> {
    if (this.shuttingDown || !this.restPolling) return;
    await Promise.all([this.pollMarkRest(), this.pollMiniRest()]);
    if (!this.shuttingDown && this.restPolling) {
      this.restTimer = setTimeout(() => { void this.restTick(); }, this.restIntervalMs);
    }
  }

  private async pollMarkRest(): Promise<void> {
    try {
      const res = await this.fetchFn(this.markRestUrl);
      if (this.shuttingDown || !this.restPolling || !res.ok) return;
      const body = await res.json() as Array<{ symbol?: string; markPrice?: string }>;
      if (!Array.isArray(body)) return;
      const now = Date.now();
      let anyEmitted = false;
      for (const row of body) {
        if (this.shuttingDown || !this.restPolling) return;
        const sym = row?.symbol;
        const priceStr = row?.markPrice;
        if (typeof sym !== "string" || typeof priceStr !== "string") continue;
        if (this.emitMark(sym, priceStr, this.markSubs)) anyEmitted = true;
      }
      if (anyEmitted) this.lastMarkTickAt = now;
    } catch (err) {
      this.log.warn({ err }, "binance source: mark REST poll failed");
    }
  }

  private async pollMiniRest(): Promise<void> {
    try {
      const res = await this.fetchFn(this.miniRestUrl);
      if (this.shuttingDown || !this.restPolling || !res.ok) return;
      const body = await res.json() as Array<{ symbol?: string; lastPrice?: string; openPrice?: string }>;
      if (!Array.isArray(body)) return;
      const now = Date.now();
      let anyEmitted = false;
      for (const row of body) {
        if (this.shuttingDown || !this.restPolling) return;
        const sym = row?.symbol;
        const priceStr = row?.lastPrice;
        if (typeof sym !== "string" || typeof priceStr !== "string") continue;
        if (this.emitMini(sym, priceStr, row.openPrice, this.miniSubs)) anyEmitted = true;
      }
      if (anyEmitted) this.lastMiniTickAt = now;
    } catch (err) {
      this.log.warn({ err }, "binance source: mini REST poll failed");
    }
  }
}

/** Shared structural filter — rejects non-USDT, stable-stable, leveraged tokens. */
function passesStructuralFilter(binanceSymbol: string): boolean {
  if (!binanceSymbol.endsWith("USDT")) return false;
  const base = binanceSymbol.slice(0, -4);
  if (base.length < 2) return false;
  if (STABLE_BASES.has(base)) return false;
  if (LEVERAGED_SUFFIX_RE.test(base)) return false;
  return true;
}

/** Extract pino-serializable fields from a DOM-style ErrorEvent. */
function serializeWsErrorEvent(ev: Event): Record<string, unknown> {
  const e = ev as Event & { message?: unknown; error?: unknown };
  const underlying = e.error;
  return {
    type: ev.type,
    message: typeof e.message === "string" ? e.message : undefined,
    error: underlying instanceof Error
      ? { name: underlying.name, message: underlying.message }
      : underlying !== undefined
        ? String(underlying)
        : undefined,
  };
}

export function asMarkPriceSource(binance: BinanceSource): PriceSource {
  let unsub: (() => void) | null = null;
  return {
    name: "binance",
    priority: 1,
    getLastTickAt: () => binance.getLastMarkTickAt(),
    start: async (onTick) => { unsub = binance.subscribeMarkPrice(onTick); },
    stop: async () => { unsub?.(); unsub = null; },
  };
}

export function asMiniTickerSource(binance: BinanceSource): PriceSource {
  let unsub: (() => void) | null = null;
  return {
    name: "binance",
    priority: 1,
    getLastTickAt: () => binance.getLastMiniTickAt(),
    start: async (onTick) => { unsub = binance.subscribeMiniTicker(onTick); },
    stop: async () => { unsub?.(); unsub = null; },
  };
}
