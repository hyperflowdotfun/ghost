/**
 * Support/resistance level detection service.
 * Fetches klines from ITradingClient, detects levels, returns typed data.
 */

import type { ITradingClient } from "./interfaces/trading-client.js";
import type { Kline } from "./interfaces/trading-types.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface LevelEntry {
  price: number;
  label: string;
  distPct: number;
}

export interface LevelsResult {
  symbol: string;
  interval: string;
  price: number;
  resistance: LevelEntry[];
  support: LevelEntry[];
}

// ---------------------------------------------------------------------------
// Pure math helpers (private to this module)
// ---------------------------------------------------------------------------

function swingHighs(highs: number[], n = 3): number[] {
  const levels: number[] = [];
  for (let i = n; i < highs.length - n; i++) {
    let isSwing = true;
    for (let j = 1; j <= n; j++) {
      if (highs[i] <= highs[i - j] || highs[i] <= highs[i + j]) {
        isSwing = false;
        break;
      }
    }
    if (isSwing) levels.push(highs[i]);
  }
  return levels;
}

function swingLows(lows: number[], n = 3): number[] {
  const levels: number[] = [];
  for (let i = n; i < lows.length - n; i++) {
    let isSwing = true;
    for (let j = 1; j <= n; j++) {
      if (lows[i] >= lows[i - j] || lows[i] >= lows[i + j]) {
        isSwing = false;
        break;
      }
    }
    if (isSwing) levels.push(lows[i]);
  }
  return levels;
}

function clusterLevels(levels: number[], tolerancePct = 0.5): { price: number; tests: number }[] {
  if (levels.length === 0) return [];
  const sorted = [...levels].sort((a, b) => a - b);
  const clusters: { sum: number; count: number }[] = [];
  let current = { sum: sorted[0], count: 1 };
  for (let i = 1; i < sorted.length; i++) {
    const avg = current.sum / current.count;
    if (Math.abs(sorted[i] - avg) / avg * 100 <= tolerancePct) {
      current.sum += sorted[i];
      current.count++;
    } else {
      clusters.push(current);
      current = { sum: sorted[i], count: 1 };
    }
  }
  clusters.push(current);
  return clusters.map(c => ({ price: c.sum / c.count, tests: c.count }));
}

function fibonacciLevels(swingHigh: number, swingLow: number): { ratio: number; price: number }[] {
  const range = swingHigh - swingLow;
  const ratios = [0.236, 0.382, 0.5, 0.618, 0.786];
  return ratios.map(r => ({ ratio: r, price: swingHigh - range * r }));
}

function pivotPoints(high: number, low: number, close: number): { label: string; price: number }[] {
  const p = (high + low + close) / 3;
  const range = high - low;
  return [
    { label: "R3", price: high + 2 * (p - low) },
    { label: "R2", price: p + range },
    { label: "R1", price: 2 * p - low },
    { label: "P", price: p },
    { label: "S1", price: 2 * p - high },
    { label: "S2", price: p - range },
    { label: "S3", price: low - 2 * (high - p) },
  ];
}

function fibPivotPoints(high: number, low: number, close: number): { label: string; price: number }[] {
  const p = (high + low + close) / 3;
  const range = high - low;
  return [
    { label: "Fib R3", price: p + range },
    { label: "Fib R2", price: p + 0.618 * range },
    { label: "Fib R1", price: p + 0.382 * range },
    { label: "P", price: p },
    { label: "Fib S1", price: p - 0.382 * range },
    { label: "Fib S2", price: p - 0.618 * range },
    { label: "Fib S3", price: p - range },
  ];
}

function previousDayHLC(klines: Kline[]): { high: number; low: number; close: number } | null {
  const dayMap = new Map<string, { h: number; l: number; c: number; t: number }>();
  for (const k of klines) {
    const day = new Date(k.openTime).toISOString().slice(0, 10);
    const existing = dayMap.get(day);
    if (!existing) {
      dayMap.set(day, { h: k.high, l: k.low, c: k.close, t: k.openTime });
    } else {
      if (k.high > existing.h) existing.h = k.high;
      if (k.low < existing.l) existing.l = k.low;
      if (k.openTime > existing.t) { existing.c = k.close; existing.t = k.openTime; }
    }
  }
  const days = [...dayMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (days.length < 2) return null;
  const prev = days[days.length - 2][1];
  return { high: prev.h, low: prev.l, close: prev.c };
}

/** Deduplicate levels within tolerance -- merges labels for near-identical prices. */
function deduplicateLevels(levels: LevelEntry[], tolerancePct = 0.1): void {
  for (let i = 0; i < levels.length; i++) {
    for (let j = i + 1; j < levels.length; j++) {
      const pctDiff = Math.abs(levels[i].price - levels[j].price) / levels[i].price * 100;
      if (pctDiff <= tolerancePct) {
        levels[i] = { ...levels[i], label: `${levels[i].label} / ${levels[j].label}` };
        levels.splice(j, 1);
        j--;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class TaLevelsService {
  constructor(private readonly hl: ITradingClient) {}

  /** Detect support/resistance levels for a symbol. Returns typed data. */
  async getLevels(symbol: string, interval: string, lookback: number, method?: string): Promise<LevelsResult> {
    const klines = await this.hl.getKlines(symbol, interval, lookback);
    const resolved = this.hl.resolveSymbol(symbol);
    return TaLevelsService.computeLevels(klines, resolved, interval, method);
  }

  /** Pure computation — no I/O. Reused by `/api/chart-data?source=binance`
   *  so Binance klines get the same swing / fibonacci / pivot S/R logic as HL.
   *  Throws when fewer than 10 candles are supplied. */
  static computeLevels(
    klines: Kline[],
    symbol: string,
    interval: string,
    method?: string,
  ): LevelsResult {
    if (klines.length < 10) throw new Error("Insufficient candle data.");

    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);
    const closes = klines.map(k => k.close);
    const price = closes[closes.length - 1];
    const normalizedMethod = (method ?? "all").toLowerCase();
    const showMethod = (m: string) => normalizedMethod === "all" || normalizedMethod === m;

    const resistance: LevelEntry[] = [];
    const support: LevelEntry[] = [];
    const addLevel = (p: number, label: string) => {
      const distPct = ((p - price) / price) * 100;
      (p > price ? resistance : support).push({ price: p, label, distPct });
    };

    // Swing S/R
    if (showMethod("swing")) {
      const allSwings = [...swingHighs(highs, 3), ...swingLows(lows, 3)];
      for (const z of clusterLevels(allSwings, 0.5)) addLevel(z.price, `Swing (tested ${z.tests}x)`);
    }

    // Fibonacci
    if (showMethod("fibonacci")) {
      const sh = swingHighs(highs, 3), sl = swingLows(lows, 3);
      const swHigh = sh.length > 0 ? sh[sh.length - 1] : Math.max(...highs);
      const swLow = sl.length > 0 ? sl[sl.length - 1] : Math.min(...lows);
      if (swHigh > swLow) {
        for (const f of fibonacciLevels(swHigh, swLow)) addLevel(f.price, `Fib ${f.ratio}`);
      }
    }

    // Pivot Points
    if (showMethod("pivot")) {
      const subDaily = ["1m", "5m", "15m", "30m", "1h", "2h", "4h"].includes(interval);
      const src = subDaily ? previousDayHLC(klines) : (() => {
        const p = klines[klines.length - 2];
        return p ? { high: p.high, low: p.low, close: p.close } : null;
      })();
      if (src) {
        for (const p of pivotPoints(src.high, src.low, src.close)) {
          if (p.label !== "P") addLevel(p.price, `Pivot ${p.label}`);
        }
        for (const p of fibPivotPoints(src.high, src.low, src.close)) {
          if (p.label !== "P") addLevel(p.price, p.label);
        }
      }
    }

    deduplicateLevels(resistance);
    deduplicateLevels(support);
    resistance.sort((a, b) => a.distPct - b.distPct);
    support.sort((a, b) => Math.abs(a.distPct) - Math.abs(b.distPct));

    return {
      symbol, interval, price,
      resistance: resistance.slice(0, 8),
      support: support.slice(0, 8),
    };
  }
}
