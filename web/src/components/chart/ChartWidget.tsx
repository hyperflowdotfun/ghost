import { useEffect, useRef, useState, useCallback, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type LogicalRange,
} from "lightweight-charts";
import { useChartData } from "@/hooks/useChartData";
import type {
  ChartBandOverlay,
  ChartDataResponse,
  ChartLineOverlay,
  ChartSubPane,
} from "@/lib/chartTypes";
import { useChartDataStore, chartDataKey } from "@/components/chat/ChartDataContext-internals";
import {
  CHART_BG,
  TEXT_COLOR,
  FULLSCREEN_MAIN_MIN,
  GRID_COLOR,
  BORDER_COLOR,
  CANDLE_UP,
  CANDLE_DOWN,
  SUPPORT_COLOR,
  RESISTANCE_COLOR,
  INLINE_CHART_HEIGHT,
  VOLUME_HEIGHT_FACTOR,
  SUB_PANE_HEIGHT,
  FONT_FAMILY,
  FONT_SIZE,
} from "./chart-config";
import { ChartLegend } from "./ChartLegend";
import { splitSymbol } from "@/components/layout/symbol-utils";
import {
  toBandLineColor,
  lineKey,
  bandKey,
  levelKey,
  type FocusSpec,
  type VisibleLevel,
} from "./ChartWidget-helpers";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ChartWidgetProps {
  symbol: string;
  interval?: string;
  indicators?: string;
  levels?: string;
  "focus-time"?: string;
  "focus-price"?: string;
  /** Render in screenshot mode — fills parent (no inline preview, no chrome, no portal).
   *  Consumed by /chart route + Bun.WebView screenshot driver. */
  headless?: boolean;
}

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

function indicatorLabelMatches(label: string, name: string): boolean {
  const l = label.toLowerCase();
  const n = name.toLowerCase();
  if (n === "ema") return l.startsWith("ema");
  return l === n;
}

function parseFocusTime(raw: string | undefined): [number, number] | null {
  if (!raw) return null;
  const parts = raw.split(",").map((s) => s.trim());
  if (parts.length !== 2) return null;
  const from = Math.floor(new Date(parts[0]).getTime() / 1000);
  const to = Math.floor(new Date(parts[1]).getTime() / 1000);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return [from, to];
}

function parseFocusPrice(raw: string | undefined): [number, number] | null {
  if (!raw) return null;
  const parts = raw.split(",").map((s) => parseFloat(s.trim()));
  if (parts.length !== 2 || parts.some(Number.isNaN)) return null;
  return [parts[0], parts[1]];
}

function parseLevels(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => parseFloat(s.trim()))
    .filter((n) => !Number.isNaN(n));
}

interface VisibleOverlays {
  lines: ChartLineOverlay[];
  bands: ChartBandOverlay[];
  levels: VisibleLevel[];
}

/** Filter overlays by focus spec — shared by buildMainChart and legend so both
 * render exactly the same set of items. */
function computeVisibleOverlays(
  data: ChartDataResponse,
  extraLevels: number[],
  focus?: FocusSpec,
): VisibleOverlays {
  const indicatorFocus = focus?.kind === "indicator" ? focus.name : null;
  const levelFocus = focus?.kind === "level" ? focus.price : null;

  // Level focus → no overlays (match LevelChartMini popover, keep chart clean)
  // Indicator focus → only matching overlays
  // No focus → all overlays
  const lines =
    levelFocus !== null
      ? []
      : indicatorFocus !== null
        ? data.lineOverlays.filter((o) =>
            indicatorLabelMatches(o.label, indicatorFocus),
          )
        : data.lineOverlays;
  const bands =
    levelFocus !== null
      ? []
      : indicatorFocus !== null
        ? data.bandOverlays.filter((b) =>
            indicatorLabelMatches(b.label, indicatorFocus),
          )
        : data.bandOverlays;

  const isLevelTarget = (price: number) =>
    levelFocus !== null && Math.abs(price - levelFocus) / levelFocus < 0.005;

  // Level focus → render ALL levels (match LevelChartMini popover: target
  // emphasized, others dimmed as context). Target is ordered first.
  const indicatorHidesLevels = indicatorFocus !== null;
  const rawLevels: VisibleLevel[] = indicatorHidesLevels
    ? []
    : [
        ...data.levels.map((l) => ({
          price: l.price,
          label: l.label,
          side: l.side,
          isTarget: isLevelTarget(l.price),
        })),
        ...extraLevels.map((price) => ({
          price,
          label: "",
          isTarget: isLevelTarget(price),
        })),
      ];
  const levels =
    levelFocus !== null
      ? [...rawLevels.filter((l) => l.isTarget), ...rawLevels.filter((l) => !l.isTarget)]
      : rawLevels;

  return { lines, bands, levels };
}

// ---------------------------------------------------------------------------
// Shared dark theme chart options
// ---------------------------------------------------------------------------

function chartOptions(height: number, showTimeScale: boolean) {
  return {
    height,
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: CHART_BG },
      textColor: TEXT_COLOR,
      fontFamily: FONT_FAMILY,
      fontSize: FONT_SIZE,
    },
    grid: {
      vertLines: { color: GRID_COLOR },
      horzLines: { color: GRID_COLOR },
    },
    crosshair: { mode: CrosshairMode.Normal },
    rightPriceScale: {
      borderColor: BORDER_COLOR,
      scaleMargins: { top: 0.03, bottom: 0.08 },
    },
    timeScale: {
      borderColor: BORDER_COLOR,
      timeVisible: true,
      secondsVisible: false,
      visible: showTimeScale,
    },
    handleScroll: { vertTouchDrag: false },
  } as const;
}

// ---------------------------------------------------------------------------
// Build the main candlestick chart
// ---------------------------------------------------------------------------

function buildMainChart(
  container: HTMLElement,
  data: ChartDataResponse,
  height: number,
  extraLevels: number[],
  focusTime: [number, number] | null,
  focusPrice: [number, number] | null,
  compact = false,
  focus?: FocusSpec,
  hidden?: Set<string>,
): IChartApi {
  const indicatorFocus = focus?.kind === "indicator" ? focus.name : null;
  const visible = computeVisibleOverlays(data, extraLevels, focus);
  const isHidden = (key: string) => hidden?.has(key) ?? false;
  const chart = createChart(container, {
    ...chartOptions(height, true),
    width: container.clientWidth || 600,
  });

  // Candlestick series
  const candleSeries = chart.addSeries(CandlestickSeries, {
    upColor: CANDLE_UP,
    downColor: CANDLE_DOWN,
    borderDownColor: CANDLE_DOWN,
    borderUpColor: CANDLE_UP,
    wickDownColor: CANDLE_DOWN,
    wickUpColor: CANDLE_UP,
  });
  candleSeries.setData(
    data.candles as Parameters<typeof candleSeries.setData>[0],
  );

  // Volume histogram (bottom 15%)
  if (data.volumes.length > 0) {
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 1 - VOLUME_HEIGHT_FACTOR, bottom: 0 },
    });
    volumeSeries.setData(
      data.volumes as Parameters<typeof volumeSeries.setData>[0],
    );
  }

  // Line overlays (EMA, etc.) — render visible set, skip hidden, emphasize focus target
  for (const overlay of visible.lines) {
    if (isHidden(lineKey(overlay.label))) continue;
    const isTarget =
      indicatorFocus !== null &&
      indicatorLabelMatches(overlay.label, indicatorFocus);
    const series = chart.addSeries(LineSeries, {
      color: overlay.color,
      lineWidth: isTarget ? 2 : 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    series.setData(overlay.data as Parameters<typeof series.setData>[0]);
  }

  // Band overlays (BB, Ichimoku, Keltner)
  for (const band of visible.bands) {
    if (isHidden(bandKey(band.label))) continue;
    const lineColor = toBandLineColor(band.color);

    const upper = chart.addSeries(LineSeries, {
      color: lineColor,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    upper.setData(band.upperData as Parameters<typeof upper.setData>[0]);

    const lower = chart.addSeries(LineSeries, {
      color: lineColor,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    lower.setData(band.lowerData as Parameters<typeof lower.setData>[0]);
  }

  // S/R levels — when level-focused, non-target levels dimmed as context
  // (mirrors LevelChartMini popover). Compact mode also suppresses non-target
  // axis labels & titles.
  const levelFocused = focus?.kind === "level";
  for (const level of visible.levels) {
    if (isHidden(levelKey(level.price))) continue;
    const baseColor = level.side
      ? level.side === "support"
        ? SUPPORT_COLOR
        : RESISTANCE_COLOR
      : TEXT_COLOR;
    // Dim non-target levels in level-focus mode (alpha ~33%)
    const color =
      levelFocused && !level.isTarget ? baseColor + "55" : baseColor;
    const dimmedContext = levelFocused && !level.isTarget;
    const hideTitle = dimmedContext || (compact && !level.isTarget);
    const title =
      !level.label || hideTitle
        ? ""
        : level.label.length > 20
          ? level.label.slice(0, 20) + "\u2026"
          : level.label;
    candleSeries.createPriceLine({
      price: level.price,
      color,
      lineWidth: level.isTarget ? 2 : 1,
      lineStyle: level.isTarget ? LineStyle.Solid : LineStyle.Dashed,
      axisLabelVisible: level.isTarget || (!compact && !dimmedContext),
      title,
    });
  }

  // Focus zoom
  if (focusTime) {
    // Lightweight Charts expects branded time types — cast through unknown
    chart.timeScale().setVisibleRange({
      from: focusTime[0] as never,
      to: focusTime[1] as never,
    });
  } else {
    const candleCount = data.candles.length;
    // lightweight-charts asserts from <= to; with 0 candles that's 0 > -1.
    if (candleCount > 0) {
      const visibleBars = Math.min(50, candleCount);
      chart.timeScale().setVisibleLogicalRange({
        from: candleCount - visibleBars,
        to: candleCount - 1,
      });
    }
  }

  // Y-axis price zoom
  if (focusPrice) {
    const margin = (focusPrice[1] - focusPrice[0]) * 0.05;
    chart.priceScale("right").applyOptions({
      autoScale: false,
      scaleMargins: { top: 0.02, bottom: 0.15 },
    });
    candleSeries.applyOptions({
      autoscaleInfoProvider: () => ({
        priceRange: {
          minValue: focusPrice[0] - margin,
          maxValue: focusPrice[1] + margin,
        },
      }),
    });
  }

  return chart;
}

// ---------------------------------------------------------------------------
// Build a sub-pane chart (RSI, MACD, ADX, etc.)
// ---------------------------------------------------------------------------

function buildSubPaneChart(
  container: HTMLElement,
  pane: ChartSubPane,
): IChartApi {
  const chart = createChart(container, {
    ...chartOptions(SUB_PANE_HEIGHT, false),
    width: container.clientWidth || 600,
  });

  // Override price scale margins for sub-panes
  chart.priceScale("right").applyOptions({
    scaleMargins: { top: 0.1, bottom: 0.1 },
  });

  if (pane.type === "macd") {
    // MACD histogram
    if (pane.histogramData && pane.histogramData.length > 0) {
      const histSeries = chart.addSeries(HistogramSeries, {
        priceFormat: { type: "price", precision: 2, minMove: 0.01 },
        priceLineVisible: false,
        lastValueVisible: false,
      });
      histSeries.setData(
        pane.histogramData as Parameters<typeof histSeries.setData>[0],
      );
    }

    // MACD line
    if (pane.data.length > 0) {
      const macdLine = chart.addSeries(LineSeries, {
        color: pane.color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      macdLine.setData(pane.data as Parameters<typeof macdLine.setData>[0]);
    }

    // Signal line
    if (pane.signalData && pane.signalData.length > 0) {
      const signalLine = chart.addSeries(LineSeries, {
        color: "#ff9800",
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      signalLine.setData(
        pane.signalData as Parameters<typeof signalLine.setData>[0],
      );
    }
  } else {
    // Line-type panes (RSI, ADX, etc.)
    const series = chart.addSeries(LineSeries, {
      color: pane.color,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    series.setData(pane.data as Parameters<typeof series.setData>[0]);

    // Zone lines (e.g. RSI overbought/oversold at 70/30)
    if (pane.zones) {
      for (const zone of pane.zones) {
        series.createPriceLine({
          price: zone.value,
          color: zone.color,
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: false,
          title: "",
        });
      }
    }
  }

  chart.timeScale().fitContent();
  return chart;
}

// ---------------------------------------------------------------------------
// Time-scale sync helper
// ---------------------------------------------------------------------------

function syncTimeScales(main: IChartApi, subs: IChartApi[]): () => void {
  let syncing = false;

  function onMainRangeChange(range: LogicalRange | null): void {
    if (syncing || !range) return;
    syncing = true;
    for (const sub of subs) {
      sub.timeScale().setVisibleLogicalRange(range);
    }
    syncing = false;
  }

  function createSubHandler(index: number) {
    return (range: LogicalRange | null): void => {
      if (syncing || !range) return;
      syncing = true;
      main.timeScale().setVisibleLogicalRange(range);
      for (let i = 0; i < subs.length; i++) {
        if (i !== index) {
          subs[i].timeScale().setVisibleLogicalRange(range);
        }
      }
      syncing = false;
    };
  }

  main
    .timeScale()
    .subscribeVisibleLogicalRangeChange(onMainRangeChange);

  const subHandlers = subs.map((sub, i) => {
    const handler = createSubHandler(i);
    sub.timeScale().subscribeVisibleLogicalRangeChange(handler);
    return { sub, handler };
  });

  return () => {
    main
      .timeScale()
      .unsubscribeVisibleLogicalRangeChange(onMainRangeChange);
    for (const { sub, handler } of subHandlers) {
      sub.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
    }
  };
}

// ---------------------------------------------------------------------------
// Fullscreen overlay component
// ---------------------------------------------------------------------------

export function FullscreenOverlay({
  data,
  extraLevels,
  focusTime,
  focusPrice,
  focus,
  onClose,
  mode = 'fullscreen',
  panelHeight = 351,
  interval,
  onIntervalChange,
  hideHeader = false,
}: {
  data: ChartDataResponse;
  extraLevels: number[];
  focusTime: [number, number] | null;
  focusPrice: [number, number] | null;
  focus?: FocusSpec;
  onClose: () => void;
  /** 'fullscreen' = portalled scrim, 'panel' = inline Figma panel (node 331:3350),
   *  'headless' = plain in-place render filling parent at 100% (screenshot target). */
  mode?: 'fullscreen' | 'panel' | 'headless';
  /** Outer container height when mode='panel'. Header (~37px) eats from this. */
  panelHeight?: number;
  /** Current interval (panel mode only). When provided alongside
   *  `onIntervalChange`, the header renders a timeframe selector. */
  interval?: string;
  onIntervalChange?: (next: string) => void;
  /** Panel mode only — suppress the inline header (symbol/price/timeframe/ESC).
   *  Used by the chart drawer (wave/24) which renders its own header above
   *  the chart and would otherwise see it duplicated. */
  hideHeader?: boolean;
}) {
  const mainRef = useRef<HTMLDivElement>(null);
  const subRefs = useRef<HTMLDivElement[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());

  const toggleHidden = useCallback((key: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Legend items — same filter as buildMainChart so legend and chart stay in sync
  const visible = useMemo(
    () => computeVisibleOverlays(data, extraLevels, focus),
    [data, extraLevels, focus],
  );

  // When focus is set, only render the matching sub-pane (or none at all
  // for overlay/level focus). No focus → show every sub-pane as before.
  // Memoized so the array reference is stable across re-renders — otherwise
  // the useEffect below would tear down and rebuild the chart every time.
  const subPanes = useMemo(() => {
    if (!focus) return data.subPanes;
    if (focus.kind === "indicator") {
      const match = data.subPanes.find((p) =>
        indicatorLabelMatches(p.label, focus.name),
      );
      return match ? [match] : [];
    }
    return [];
  }, [data.subPanes, focus]);

  // Compute focusPrice from level focus if not explicitly provided
  const resolvedFocusPrice = useMemo(() => {
    if (focusPrice) return focusPrice;
    if (focus?.kind !== "level" || data.candles.length === 0) return null;
    const lp = focus.price;
    const cLow = Math.min(...data.candles.map((c) => c.low));
    const cHigh = Math.max(...data.candles.map((c) => c.high));
    if (lp >= cLow && lp <= cHigh) return null; // level within range, auto-scale fine
    const pad = (cHigh - cLow) * 0.08 || cHigh * 0.01;
    return [Math.min(cLow, lp) - pad, Math.max(cHigh, lp) + pad] as [number, number];
  }, [focusPrice, focus, data.candles]);

  useEffect(() => {
    const mainEl = mainRef.current;
    if (!mainEl) return;

    const subPaneCount = subPanes.length;
    // 'panel' uses explicit prop; 'headless' measures the actual parent DOM
    // (parent is `.chart-page--headless` at fixed 1200×720); 'fullscreen' uses
    // the window (portalled to body).
    const containerHeight = mode === 'panel'
      ? panelHeight
      : mode === 'headless'
        ? (mainEl.parentElement?.parentElement?.clientHeight ?? window.innerHeight)
        : window.innerHeight;
    // 52px chrome reserved for the inline panel header; drop it when the
    // caller hides the header (chart drawer renders its own above the body).
    const headerChrome = mode === 'panel' && hideHeader ? 0 : 52;
    const mainHeight =
      containerHeight - headerChrome - subPaneCount * (SUB_PANE_HEIGHT + 4);
    const mainChart = buildMainChart(
      mainEl,
      data,
      Math.max(mainHeight, FULLSCREEN_MAIN_MIN),
      extraLevels,
      focusTime,
      resolvedFocusPrice,
      false,
      focus,
      hidden,
    );

    const subCharts: IChartApi[] = [];
    for (let i = 0; i < subPaneCount; i++) {
      const el = subRefs.current[i];
      if (el) {
        subCharts.push(buildSubPaneChart(el, subPanes[i]));
      }
    }

    const unsync = subCharts.length > 0 ? syncTimeScales(mainChart, subCharts) : undefined;

    return () => {
      unsync?.();
      for (const sc of subCharts) sc.remove();
      mainChart.remove();
    };
  }, [data, extraLevels, focusTime, resolvedFocusPrice, focus, subPanes, hidden, mode, panelHeight, hideHeader]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Price + 24h change for the panel-mode header (Figma 331:3350).
  const lastCandle = data.candles[data.candles.length - 1];
  const firstCandle = data.candles[0];
  const lastPrice = lastCandle?.close ?? null;
  const change24h = lastCandle && firstCandle && firstCandle.close > 0
    ? ((lastCandle.close - firstCandle.close) / firstCandle.close) * 100
    : null;
  const changeColor = change24h == null
    ? 'text-text-secondary'
    : change24h >= 0 ? 'text-[var(--color-success-default)]' : 'text-[var(--color-error-default)]';

  const chartBody = (
    <>
      <div className="relative min-h-[160px] flex-1">
        <div ref={mainRef} className="h-full w-full" />
        {(visible.lines.length + visible.bands.length + visible.levels.length) > 0 && (
          <ChartLegend
            lines={visible.lines}
            bands={visible.bands}
            levels={visible.levels}
            hidden={hidden}
            onToggle={toggleHidden}
          />
        )}
      </div>
      {subPanes.map((pane, i) => (
        <div key={pane.label} className="relative">
          <span className="pointer-events-none absolute top-1 left-2 z-10 text-footnote text-[var(--color-text-secondary)] opacity-70">
            {pane.label}
          </span>
          <div
            ref={(el) => {
              if (el) subRefs.current[i] = el;
            }}
            style={{ height: SUB_PANE_HEIGHT }}
          />
        </div>
      ))}
    </>
  );

  if (mode === 'headless') {
    // Screenshot target — fill parent at 100%, no chrome, no portal.
    // Parent `.chart-page--headless` is fixed 1200×720; flex column propagates
    // height down to `chartBody`'s `flex-1` main chart div.
    return (
      <div className="relative flex flex-col w-full h-full px-2 py-2 gap-1 min-h-0">
        {chartBody}
      </div>
    );
  }

  if (mode === 'panel') {
    // Inline panel — Figma node 331:3350. Sits at the top of the chat column,
    // not portalled. Background opaque (surface-canvas) so chat content
    // behind is fully hidden (no blur). When the parent suppresses the
    // header (chart drawer), only the chart body renders here.
    if (hideHeader) {
      return (
        <div
          className="relative flex flex-col bg-[var(--color-surface-base)]"
          style={{ height: panelHeight }}
        >
          <div className="flex flex-1 flex-col gap-1 min-h-0">
            {chartBody}
          </div>
        </div>
      );
    }
    return (
      <div
        className="relative flex flex-col bg-[var(--color-surface-base)] border-t border-b border-[var(--color-border-subtle)]"
        style={{ height: panelHeight }}
      >
        <div className="flex items-center justify-between px-3 py-2">
          <div className="flex items-center gap-2">
            <ChartHeaderSymbol symbol={data.symbol} />
            {lastPrice != null && (
              <span className="text-body-sm text-text-primary [font-variant-numeric:tabular-nums]">
                ${lastPrice.toLocaleString(undefined, { maximumFractionDigits: lastPrice >= 100 ? 2 : 4 })}
              </span>
            )}
            {change24h != null && (
              <span className={`text-body-sm [font-variant-numeric:tabular-nums] ${changeColor}`}>
                {change24h >= 0 ? '▲' : '▼'} {Math.abs(change24h).toFixed(2)}%
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {onIntervalChange && interval && (
              <div className="flex items-center gap-0.5 rounded-[4px] border border-[var(--color-border-strong)] p-0.5">
                {['15m', '1h', '4h', '1d'].map((tf) => {
                  const active = tf === interval;
                  return (
                    <button
                      key={tf}
                      type="button"
                      onClick={() => onIntervalChange(tf)}
                      className={
                        'cursor-pointer rounded-[2px] px-2 py-0.5 text-caption transition-colors duration-fast ease-out btn-press ' +
                        (active
                          ? 'bg-[var(--color-brand-subtle)] text-brand-default'
                          : 'bg-transparent text-text-secondary hover:text-text-primary')
                      }
                      aria-pressed={active}
                    >
                      {tf}
                    </button>
                  );
                })}
              </div>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close chart panel"
              className="cursor-pointer rounded-[4px] border border-[var(--color-border-strong)] bg-transparent px-3 py-1 text-caption text-text-secondary hover:text-text-primary hover:border-[var(--color-border-default)] transition-colors duration-fast ease-out btn-press"
            >
              ESC
            </button>
          </div>
        </div>
        <div className="flex flex-1 flex-col gap-1 min-h-0">
          {chartBody}
        </div>
      </div>
    );
  }

  // Fullscreen overlay (legacy mode) — portalled scrim above everything.
  const overlayNode = (
    <div
      className="fixed inset-0 z-[9999] flex flex-col bg-black/70 backdrop-blur-[10px]"
      onClick={onClose}
    >
      <div
        className="flex items-center justify-between px-4 py-3 text-body-sm text-[var(--color-text-primary)]"
        onClick={(e) => e.stopPropagation()}
      >
        <span>
          {data.symbol} {data.interval} &mdash; {data.candles.length} candles
        </span>
        <button
          className="cursor-pointer rounded-[2px] border border-[rgba(121,121,121,0.15)] bg-transparent px-3 py-1 text-caption text-[var(--color-text-primary)]"
          onClick={onClose}
        >
          ESC
        </button>
      </div>
      <div
        className="flex flex-1 flex-col gap-1 px-2 pb-2"
        onClick={(e) => e.stopPropagation()}
      >
        {chartBody}
      </div>
    </div>
  );

  return createPortal(overlayNode, document.body);
}

function ChartHeaderSymbol({ symbol }: { symbol: string }) {
  const { dex, base } = splitSymbol(symbol);
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-body-md-medium text-text-primary">{base}</span>
      {dex && (
        <span
          className={
            'inline-flex items-center justify-center h-[18px] px-2 rounded-[2px] ' +
            'bg-[rgba(59,247,191,0.08)] text-brand-default text-caption leading-none'
          }
          aria-label={`HIP-3 dex ${dex}`}
          title={`HIP-3 dex ${dex}`}
        >
          {dex.toUpperCase()}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Skeleton loading placeholder
// ---------------------------------------------------------------------------

function ChartSkeleton() {
  return (
    <div
      // bg-[#0b1118] hex-pinned to match canvas constants (chart-config.ts) — skeleton represents the chart canvas itself, not chrome
      className="mt-2 w-full cursor-default rounded-[2px] border border-[rgba(121,121,121,0.15)] bg-[#0b1118] [animation:pulse_1.5s_ease-in-out_infinite]"
      style={{ height: INLINE_CHART_HEIGHT }}
    />
  );
}

// ---------------------------------------------------------------------------
// Main exported component
// ---------------------------------------------------------------------------

export const ChartWidget = memo(function ChartWidget(props: ChartWidgetProps) {
  const {
    symbol,
    interval,
    indicators,
    levels: levelsProp,
    "focus-time": focusTimeRaw,
    "focus-price": focusPriceRaw,
  } = props;

  const { data, loading, error } = useChartData(symbol, interval, indicators);
  const chartStore = useChartDataStore();
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (data && chartStore) {
      chartStore.set(chartDataKey(symbol, interval, indicators), data);
    }
  }, [data, chartStore, symbol, interval, indicators]);

  const mainRef = useRef<HTMLDivElement>(null);

  const openFullscreen = useCallback(() => setFullscreen(true), []);
  const closeFullscreen = useCallback(() => setFullscreen(false), []);

  const extraLevels = useMemo(() => parseLevels(levelsProp), [levelsProp]);
  const focusTime = useMemo(() => parseFocusTime(focusTimeRaw), [focusTimeRaw]);
  const focusPrice = useMemo(() => parseFocusPrice(focusPriceRaw), [focusPriceRaw]);

  // Inline chart — compact preview, no sub-panes or axis labels (those show in fullscreen)
  useEffect(() => {
    const mainEl = mainRef.current;
    if (!mainEl || !data || data.candles.length === 0) return;

    const mainChart = buildMainChart(
      mainEl,
      data,
      INLINE_CHART_HEIGHT,
      extraLevels,
      focusTime,
      focusPrice,
      true, // compact — hide level labels
    );

    return () => { mainChart.remove(); };
  }, [data, extraLevels, focusTime, focusPrice]);

  // Loading state
  if (loading) {
    return props.headless
      ? <div className="w-full h-full bg-[#0b1118]" />
      : <ChartSkeleton />;
  }

  // Error state
  if (error) {
    return (
      <div className="py-2 text-caption text-[var(--color-text-secondary)] opacity-70">
        Chart unavailable: {error}
      </div>
    );
  }

  // No data
  if (!data || data.candles.length === 0) return null;

  // Headless screenshot mode — skip inline preview, render FullscreenOverlay
  // in-place at 100% (no portal, no scrim, no header). Consumed by /chart route.
  if (props.headless) {
    return (
      <FullscreenOverlay
        data={data}
        extraLevels={extraLevels}
        focusTime={focusTime}
        focusPrice={focusPrice}
        onClose={() => { /* no-op in headless */ }}
        mode="headless"
      />
    );
  }

  return (
    <>
      {/* Compact inline preview — click to expand fullscreen */}
      <div
        className="relative mt-2 w-full cursor-pointer"
        onClick={openFullscreen}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") openFullscreen(); }}
      >
        <div
          ref={mainRef}
          className="w-full overflow-hidden rounded-[2px] border border-[rgba(121,121,121,0.12)]"
        />
        {/* Expand hint — top-right corner */}
        <div className="pointer-events-none absolute top-2 right-2 z-10 flex items-center gap-1 rounded-[2px] border border-[rgba(121,121,121,0.15)] bg-[rgba(11,17,24,0.8)] px-2 py-1 text-footnote text-[var(--color-text-secondary)]">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 3 21 3 21 9" />
            <polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="14" y2="10" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </svg>
          <span>Expand</span>
        </div>
      </div>

      {fullscreen && (
        <FullscreenOverlay
          data={data}
          extraLevels={extraLevels}
          focusTime={focusTime}
          focusPrice={focusPrice}
          onClose={closeFullscreen}
        />
      )}
    </>
  );
});
