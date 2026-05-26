import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useChartData } from "@/hooks/useChartData";
import { useGateway } from "@/hooks/useGateway";
import { FullscreenOverlay } from "./ChartWidget";
import { ChartDrawerHeader, type CoinStats } from "./ChartDrawerHeader";
import {
  ChartPanelCtx,
  useChartPanel,
  type ChartPanelRequest,
} from "./ChartPanelContext-internals";
import type { PriceSourceId } from "../layout/symbol-utils";

export { useChartPanel } from "./ChartPanelContext-internals";

const DEFAULT_INTERVAL = "4h";
const DEFAULT_DRAWER_WIDTH = 500;
const MIN_DRAWER_WIDTH = 500;
const MAX_DRAWER_WIDTH = 720;

function clampDrawerWidth(w: number): number {
  return Math.min(MAX_DRAWER_WIDTH, Math.max(MIN_DRAWER_WIDTH, w));
}

/** Right-side push-layout chart drawer (wave/24, Figma node 984:4565). Non-modal:
 *  participates in the layout flow as an inline flex item that animates its width
 *  0 ↔ 500px. The right Sidebar collapses simultaneously in Layout so the chat
 *  column never gets covered. Single slot only; opening a new symbol swaps.
 *  Esc key and ESC chip close it. State resets on route change. */
export function ChartPanelProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ChartPanelRequest | null>(null);

  const open = useCallback((req: ChartPanelRequest) => setRequest(req), []);
  const close = useCallback(() => setRequest(null), []);

  // Reset on route change.
  const location = useLocation();
  useEffect(() => { setRequest(null); }, [location.pathname]);

  return (
    <ChartPanelCtx.Provider value={{ request, open, close }}>
      {children}
    </ChartPanelCtx.Provider>
  );
}

/** Mount-once drawer slot: renders inline as a flex sibling of the right
 *  Sidebar, animating its width 0 ↔ 500px when open changes. */
export function ChartPanelSlot() {
  const panel = useChartPanel();
  const symbol = panel?.request?.symbol ?? null;
  const source = panel?.request?.source;
  const requestedInterval = panel?.request?.interval ?? DEFAULT_INTERVAL;
  const focus = panel?.request?.focus;
  const open = panel?.request != null;

  // Local override lets the user switch timeframes from the panel header.
  // Reset whenever the symbol or the requested interval changes.
  const [interval, setInterval] = useState(requestedInterval);
  useEffect(() => { setInterval(requestedInterval); }, [symbol, requestedInterval]);

  // When the open request focuses an indicator (e.g. ichimoku, adx, obv),
  // ask the backend for that indicator explicitly — `/api/chart-data` only
  // returns indicators listed in the querystring, so omitting it leaves the
  // panel rendering the bare candles.
  const indicators = focus?.kind === "indicator" ? focus.name : undefined;

  // useChartData always runs (hook order); it no-ops when symbol is empty.
  const { data, error } = useChartData(symbol ?? "", interval, indicators, source);

  // Coin stats (marketcap / 24h vol / FDV) for the drawer header. Source is
  // required so the backend can normalize Binance "BTCUSDT" → CG ticker "BTC"
  // and fetch OI from the matching perp exchange.
  const stats = useCoinStats(symbol, source);

  // ESC closes from anywhere while drawer is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); panel?.close(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, panel]);

  // User-resizable drawer width. Persists for the lifetime of the slot
  // (mounted once in Layout). Clamped to [MIN, MAX] — fixed bounds.
  const [width, setWidth] = useState(DEFAULT_DRAWER_WIDTH);
  const [isDragging, setIsDragging] = useState(false);

  const handleResizePointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    setIsDragging(true);

    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const handleMove = (mv: PointerEvent) => {
      // Drawer is on the right edge — dragging LEFT increases width.
      setWidth(clampDrawerWidth(startWidth + (startX - mv.clientX)));
    };
    const handleUp = () => {
      setIsDragging(false);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
      document.removeEventListener("pointermove", handleMove);
      document.removeEventListener("pointerup", handleUp);
    };
    document.addEventListener("pointermove", handleMove);
    document.addEventListener("pointerup", handleUp);
  }, [width]);

  // Last price from the chart series. 24h change prefers CG's real
  // `price_change_percentage_24h`; falls back to candle-window comparison
  // (find candle closest to now − 24h) for symbols missing from CG.
  const lastCandle = data?.candles[data.candles.length - 1];
  const candlePrice = lastCandle?.close ?? null;
  const change24h = stats?.priceChangePct24h ?? computeCandle24hChange(data?.candles);

  // Live price stream — `useChartData` only fetches once via REST, so the
  // header price would otherwise be frozen at the moment the drawer opened.
  // Subscribe to `trading.source.tick` (per-source key) so HL and Binance
  // both update without needing a second subscription path. Reset to null
  // whenever the active symbol/source changes so a stale tick from the
  // previous symbol never bleeds into the new one.
  const { subscribe } = useGateway();
  const [livePrice, setLivePrice] = useState<number | null>(null);
  useEffect(() => { setLivePrice(null); }, [symbol, source]);
  useEffect(() => {
    if (!symbol) return;
    const activeSource = source ?? "hyperliquid";
    return subscribe((evt) => {
      if (evt.event !== "trading.source.tick") return;
      const p = evt.payload as { source: PriceSourceId; symbol: string; price: number };
      if (p.source !== activeSource || p.symbol !== symbol) return;
      setLivePrice(p.price);
    });
  }, [subscribe, symbol, source]);

  const lastPrice = livePrice ?? candlePrice;

  const close = panel?.close ?? (() => {});

  return (
    <div className="relative shrink-0">
      {symbol && (
        <button
          type="button"
          onClick={close}
          aria-label="Close chart drawer"
          title="Close"
          className={
            "absolute z-10 " +
            "inline-flex items-center justify-center " +
            "w-5 h-8 rounded-md " +
            "bg-[var(--color-surface-base)] " +
            "border border-border-subtle " +
            "text-text-secondary cursor-pointer " +
            "transition-colors duration-fast ease-out " +
            "hover:text-text-primary hover:border-[var(--color-text-tertiary)]"
          }
          style={{ top: 12, left: -11 }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 6 15 12 9 18" />
          </svg>
        </button>
      )}
      {symbol && open && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chart drawer"
          aria-valuenow={width}
          aria-valuemin={MIN_DRAWER_WIDTH}
          aria-valuemax={MAX_DRAWER_WIDTH}
          onPointerDown={handleResizePointerDown}
          className={
            "absolute top-0 bottom-0 left-0 w-0.5 z-[5] cursor-col-resize " +
            "transition-colors duration-fast ease-out " +
            (isDragging
              ? "bg-[var(--color-brand-default)]/60"
              : "hover:bg-[var(--color-brand-default)]/40")
          }
        />
      )}
      <div
        className={
          "h-full overflow-hidden motion-reduce:transition-none " +
          // Disable the width transition while dragging so the drawer
          // tracks the pointer 1:1 instead of lagging behind a tween.
          (isDragging ? "" : "transition-[width] duration-base ease-out")
        }
        style={{ width: open ? width : 0 }}
        aria-hidden={!open}
      >
        <aside
          role="complementary"
          aria-label="Chart panel"
          data-drawer-panel
          style={{ width }}
          className="h-full bg-[var(--color-surface-base)] flex flex-col border-l border-border-subtle"
        >
          {symbol && (
            <ChartDrawerHeader
              symbol={symbol}
              source={source ?? "hyperliquid"}
              price={lastPrice}
              change24hPct={change24h}
              stats={stats}
              interval={interval}
              onIntervalChange={setInterval}
              onClose={close}
            />
          )}
          <div className="flex-1 min-h-0 px-3 pt-3 pb-3">
            <div className="h-full w-full overflow-hidden rounded-md border border-border-subtle">
              {symbol && error && !data && (
                <div className="flex h-full items-center justify-center">
                  <span className="text-[var(--color-error-text)] text-caption">{error}</span>
                </div>
              )}
              {symbol && !error && !data && (
                <div className="flex h-full items-center justify-center">
                  <span className="text-text-secondary text-caption">Loading {symbol}…</span>
                </div>
              )}
              {symbol && data && (
                <ChartBodyAutoHeight
                  data={data}
                  focus={focus}
                  interval={interval}
                  onIntervalChange={setInterval}
                  onClose={close}
                />
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

/** Measures its own height and forwards it as `panelHeight` to FullscreenOverlay.
 *  Needed because panel mode wants an explicit pixel height for chart sizing,
 *  but the drawer flexes between header + remaining vertical space. */
function ChartBodyAutoHeight({
  data,
  focus,
  interval,
  onIntervalChange,
  onClose,
}: {
  data: NonNullable<ReturnType<typeof useChartData>["data"]>;
  focus: ChartPanelRequest["focus"];
  interval: string;
  onIntervalChange: (next: string) => void;
  onClose: () => void;
}) {
  // Optimistic initial height (viewport height - drawer header chrome). Once
  // mounted, ResizeObserver reports the real clientHeight and the chart resizes.
  const [height, setHeight] = useState<number>(() =>
    typeof window === "undefined" ? 400 : Math.max(window.innerHeight - 110, 300),
  );
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setHeight(el.clientHeight);
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={containerRef} className="h-full w-full">
      {height > 0 && (
        <FullscreenOverlay
          mode="panel"
          panelHeight={height}
          hideHeader
          data={data}
          extraLevels={[]}
          focusTime={null}
          focusPrice={null}
          focus={focus}
          interval={interval}
          onIntervalChange={onIntervalChange}
          onClose={onClose}
        />
      )}
    </div>
  );
}

/** Compute 24h price change from the loaded candle series. Walks back from
 *  the most recent candle to find one whose timestamp is >= 24h older, then
 *  returns the pct change against the latest close. Falls back to the oldest
 *  candle when the loaded range is shorter than 24h. Returns null when the
 *  series is empty or the reference price is zero. */
function computeCandle24hChange(
  candles: Array<{ time: number; close: number }> | undefined,
): number | null {
  if (!candles || candles.length < 2) return null;
  const last = candles[candles.length - 1];
  if (!last || last.close <= 0) return null;
  // Candle `time` is seconds since epoch in this codebase.
  const cutoff = last.time - 24 * 3600;
  let ref = candles[0];
  for (let i = candles.length - 2; i >= 0; i--) {
    if (candles[i].time <= cutoff) { ref = candles[i]; break; }
  }
  if (!ref || ref.close <= 0) return null;
  return ((last.close - ref.close) / ref.close) * 100;
}

/** Fetch /coins/markets-derived stats for the drawer header. Re-fetches on
 *  symbol/source change. Returns `null` until the first response lands so the
 *  header can render "—" placeholders without flicker. */
function useCoinStats(symbol: string | null, source: PriceSourceId | undefined): CoinStats | null {
  const { connected, request } = useGateway();
  const [stats, setStats] = useState<CoinStats | null>(null);

  useEffect(() => {
    setStats(null);
    if (!symbol || !connected) return;
    let cancelled = false;
    request<CoinStats>("trading.intel.coinStats", { symbol, source: source ?? "hyperliquid" })
      .then((r) => { if (!cancelled) setStats(r); })
      .catch(() => { if (!cancelled) setStats({ symbol }); });
    return () => { cancelled = true; };
  }, [symbol, source, connected, request]);

  return stats;
}
