// src/gateway/chart-data.ts
import type { ChartDataResponse } from "../services/interfaces/chart-types.js";
import type { ChartIndicator } from "../services/chart-series.js";
import { ChartSeriesService } from "../services/chart-series.js";
import { TaLevelsService } from "../services/ta-levels.js";
import type { BinanceService } from "../services/binance.js";
import type { PriceSourceId } from "../services/price-feed/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_INTERVALS = new Set(["1m", "5m", "15m", "1h", "4h", "1d"]);
const VALID_INDICATORS = new Set<ChartIndicator>([
  "bb", "rsi", "macd", "ichimoku", "keltner", "adx",
  "stochrsi", "obv", "williamsr", "atr", "cci", "vwap",
]);
const DEFAULT_INTERVAL = "4h";

// ---------------------------------------------------------------------------
// Handler deps type
// ---------------------------------------------------------------------------

export interface ChartDataDeps {
  chartSeries: ChartSeriesService;
  taLevels?: TaLevelsService;
  /** Optional — when present, `?source=binance` fetches klines from Binance
   *  USDⓈ-M instead of HL. Indicators are computed from Binance candles via
   *  `ChartSeriesService.buildSeries` and S/R levels via
   *  `TaLevelsService.computeLevels` — both are pure, no I/O. */
  binance?: BinanceService;
}

function parseSource(raw: string | undefined): PriceSourceId {
  return raw === "binance" ? "binance" : "hyperliquid";
}

// ---------------------------------------------------------------------------
// Query param parsing helpers
// ---------------------------------------------------------------------------

function parseIndicators(raw: string | undefined): ChartIndicator[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter((s): s is ChartIndicator => VALID_INDICATORS.has(s as ChartIndicator));
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleChartData(
  query: Record<string, string | undefined>,
  deps: ChartDataDeps,
): Promise<{ status: number; body: ChartDataResponse | { error: string } }> {
  const { symbol, interval: rawInterval, indicators: rawIndicators, source: rawSource } = query;

  if (!symbol || typeof symbol !== "string" || symbol.trim().length === 0) {
    return { status: 400, body: { error: "symbol is required" } };
  }

  const interval = rawInterval ?? DEFAULT_INTERVAL;
  if (!VALID_INTERVALS.has(interval)) {
    return {
      status: 400,
      body: { error: `interval must be one of: ${[...VALID_INTERVALS].join(", ")}` },
    };
  }

  const indicators = parseIndicators(rawIndicators);
  const source = parseSource(rawSource);
  const cleanSymbol = symbol.trim();

  if (source === "binance") {
    if (!deps.binance) {
      return { status: 400, body: { error: "Binance source not enabled" } };
    }
    try {
      const klines = await deps.binance.getKlines(cleanSymbol, interval, 500);
      // Reuse the static helpers — both are pure (no I/O) so the same
      // indicator suite + swing/fib/pivot S/R logic that runs for HL also
      // runs for Binance candles. `computeLevels` throws on <10 candles —
      // swallowed here so chart still renders even when the level pass fails.
      let levels;
      try {
        levels = TaLevelsService.computeLevels(klines, cleanSymbol, interval);
      } catch {
        // proceed without levels
      }
      const body = ChartSeriesService.buildSeries(klines, cleanSymbol, interval, indicators, levels);
      return { status: 200, body };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: 500, body: { error: `Failed to fetch Binance klines: ${message}` } };
    }
  }

  // Fetch S/R levels (optional — failure is non-fatal)
  let levels;
  if (deps.taLevels) {
    try {
      levels = await deps.taLevels.getLevels(cleanSymbol, interval, 200);
    } catch {
      // proceed without levels
    }
  }

  try {
    const data = await deps.chartSeries.build(cleanSymbol, interval, indicators, levels);
    return { status: 200, body: data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 500, body: { error: `Failed to build chart data: ${message}` } };
  }
}
