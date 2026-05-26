import { useEffect, useRef, useState } from "react";
import { Popover } from "@/components/Popover";
import { sourceLabel, type PriceSourceId } from "@/components/layout/symbol-utils";

export interface CoinStats {
  symbol: string;
  marketCap?: number;
  volume24h?: number;
  fdv?: number;
  priceChangePct24h?: number;
  openInterest?: number;
}

export const DRAWER_INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d", "1w"] as const;
export type DrawerInterval = typeof DRAWER_INTERVALS[number];

interface ChartDrawerHeaderProps {
  symbol: string;
  /** Source-native: HL passes "BTC" / Binance passes "BTCUSDT". Surfaced as
   *  the "Source" stat cell so users can see which venue the chart + stats
   *  come from. */
  source: PriceSourceId;
  price: number | null;
  change24hPct: number | null;
  stats: CoinStats | null;
  interval: string;
  onIntervalChange: (next: string) => void;
  onClose: () => void;
}

/** Drawer header — Figma node 984:4565. Two rows: identity (symbol + price +
 *  signed USD/% change + timeframe select + ESC chip) then a 4-column stats
 *  grid (Marketcap / 24H Vol / OI / Source). */
export function ChartDrawerHeader({
  symbol,
  source,
  price,
  change24hPct,
  stats,
  interval,
  onIntervalChange,
  onClose,
}: ChartDrawerHeaderProps) {
  const changeColor = change24hPct == null
    ? "text-text-secondary"
    : change24hPct >= 0
      ? "text-brand-default"
      : "text-[var(--color-error-default)]";
  const changeSign = change24hPct != null && change24hPct >= 0 ? "+" : "";

  return (
    <div className="shrink-0 border-b border-border-subtle">
      <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-3 border-b border-border-subtle">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
          <span className="text-body-lg-semibold text-text-primary leading-none whitespace-nowrap">{symbol}</span>
          <span className="text-body-lg-semibold text-text-primary [font-variant-numeric:tabular-nums] leading-none whitespace-nowrap">
            {price != null ? formatPrice(price) : "—"}
          </span>
          {change24hPct != null ? (
            <span className={`text-body-lg [font-variant-numeric:tabular-nums] leading-none whitespace-nowrap ${changeColor}`}>
              {price != null && (
                <>{changeSign}{formatSignedUsd(price * change24hPct / 100)} </>
              )}
              ({changeSign}{change24hPct.toFixed(2)}%)
            </span>
          ) : (
            <span className="text-body-lg text-text-tertiary leading-none">—</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <TimeframeSelect value={interval} onChange={onIntervalChange} />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close (Esc)"
            title="Close (Esc)"
            className="inline-flex items-center justify-center h-7 box-border px-2.5 py-0 m-0 rounded-[3px] border border-[var(--color-border-strong)] bg-transparent text-body-sm leading-none font-normal text-text-secondary cursor-pointer transition-colors duration-fast ease-out hover:text-text-primary hover:border-[var(--color-text-tertiary)]"
          >
            <span className="leading-none">ESC</span>
          </button>
        </div>
      </div>
      <StatsRow stats={stats} source={source} />
    </div>
  );
}

function TimeframeSelect({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Chart timeframe"
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex items-center justify-center gap-1.5 h-7 box-border px-2.5 py-0 m-0 rounded-[3px] border border-[var(--color-border-strong)] bg-transparent text-body-sm leading-none font-normal text-text-secondary cursor-pointer transition-colors duration-fast ease-out hover:text-text-primary hover:border-[var(--color-text-tertiary)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-brand-default)]"
      >
        <span className="leading-none">{value}</span>
        <svg className="shrink-0" width="10" height="10" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <Popover
        open={open}
        origin="top-right"
        onEscape={() => setOpen(false)}
        initialFocus="first"
        className={
          "absolute right-0 top-[calc(100%+4px)] z-50 min-w-[72px] " +
          "bg-[var(--color-surface-raised)] border border-[var(--color-border-subtle)] " +
          "drop-shadow-[0_16px_19px_rgba(0,0,0,0.45)] rounded-[4px] p-2 flex flex-col gap-0"
        }
        role="listbox"
        aria-label="Chart timeframe"
      >
        {DRAWER_INTERVALS.map((tf) => {
          const selected = tf === value;
          return (
            <button
              key={tf}
              type="button"
              role="option"
              aria-selected={selected}
              onClick={() => {
                onChange(tf);
                setOpen(false);
              }}
              className={
                "w-full text-left px-2.5 py-1.5 bg-transparent border-none cursor-pointer rounded-[3px] " +
                "text-body-sm transition-colors duration-fast ease-out " +
                (selected
                  ? "text-[var(--color-brand-default)] font-medium "
                  : "text-text-secondary hover:text-text-primary hover:bg-[var(--color-brand-subtle)]")
              }
            >
              {tf}
            </button>
          );
        })}
      </Popover>
    </div>
  );
}

function StatsRow({ stats, source }: { stats: CoinStats | null; source: PriceSourceId }) {
  return (
    <div className="grid grid-cols-4 gap-2 px-4 pt-3 pb-3">
      <StatCell label="Marketcap" value={stats?.marketCap} />
      <StatCell label="24H Vol" value={stats?.volume24h} />
      <StatCell label="OI" value={stats?.openInterest} />
      <StatCell label="Source" textValue={sourceLabel(source)} />
    </div>
  );
}

function StatCell({
  label,
  value,
  textValue,
}: {
  label: string;
  value?: number;
  textValue?: string;
}) {
  const display = textValue ?? (value != null ? formatCompactUsd(value) : "—");
  return (
    <div className="flex flex-col gap-[3px] min-w-0">
      <span className="text-caption text-text-tertiary leading-none">{label}</span>
      <span className="text-body-md-semibold text-text-primary [font-variant-numeric:tabular-nums] leading-none truncate">
        {display}
      </span>
    </div>
  );
}

function formatPrice(n: number): string {
  const fractionDigits = n >= 100 ? 0 : n >= 1 ? 2 : 4;
  return "$" + n.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: fractionDigits,
  });
}

const COMPACT = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 2,
});

function formatCompactUsd(n: number): string {
  return "$" + COMPACT.format(n);
}

function formatSignedUsd(n: number): string {
  const abs = Math.abs(n);
  const fractionDigits = abs >= 100 ? 0 : abs >= 1 ? 2 : 4;
  return "$" + abs.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: fractionDigits,
  });
}
