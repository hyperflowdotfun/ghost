import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { formatSymbolDisplay, sourceLabel, type PriceSourceId } from './symbol-utils';
import emptyTokenSearchIllustration from '@/assets/empty-token-search.svg';
import hyperliquidLogoSvg from '@/assets/hype.svg';
import binanceLogoSvg from '@/assets/binance.svg';

const SOURCE_LOGO: Record<PriceSourceId, string> = {
  hyperliquid: hyperliquidLogoSvg,
  binance: binanceLogoSvg,
};

function SourceLogo({ source, size = 16 }: { source: PriceSourceId; size?: number }) {
  return (
    <img
      src={SOURCE_LOGO[source]}
      alt=""
      width={size}
      height={size}
      className="block shrink-0 select-none"
      draggable={false}
      aria-hidden="true"
    />
  );
}

export interface TokenEntry {
  symbol: string;
  source: PriceSourceId;
}

export interface WatchlistAddDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Full (symbol, source) universe — already pre-filtered + sorted by parent. */
  tokens: TokenEntry[];
  /** Keyed `${source}:${symbol}`. */
  prices: Record<string, number>;
  /** Keyed `${source}:${symbol}`. */
  prevDayPrices: Record<string, number>;
  /** Set of `${source}:${symbol}` already on the user's watchlist. */
  watchlistSet: Set<string>;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onToggle: (symbol: string, source: PriceSourceId) => void;
}

export function WatchlistAddDrawer({
  open,
  onClose,
  tokens,
  prices,
  prevDayPrices,
  watchlistSet,
  searchQuery,
  onSearchChange,
  onToggle,
}: WatchlistAddDrawerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Source filter — single-selection tab: 'all' shows tokens from every
  // source; otherwise tokens are filtered to the chosen source.
  type SourceTab = 'all' | PriceSourceId;
  const [sourceTab, setSourceTab] = useState<SourceTab>('all');

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // Freeze list order while drawer is open. The parent sorts
  // favs to the top, so toggling a token mid-scroll reorders the list and
  // the row physically jumps under the user's cursor — the click then
  // lands on a different (or no) row. Snapshot the order on open and only
  // surface new search results / new symbols at the bottom while open.
  const stableTokens = useMemo(() => {
    if (!open) return tokens;
    const seen = new Set<string>();
    const out: TokenEntry[] = [];
    for (const t of tokens) {
      const key = `${t.source}:${t.symbol}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(t);
      }
    }
    return out;
    // Deliberately only re-derived when the search query changes — favorite
    // toggles must NOT reorder the list mid-session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, searchQuery]);

  const visibleTokens = useMemo(
    () => sourceTab === 'all' ? stableTokens : stableTokens.filter((t) => t.source === sourceTab),
    [stableTokens, sourceTab],
  );

  return createPortal(
    <>
      <div
        aria-hidden="true"
        data-drawer-scrim
        onClick={onClose}
        className={
          'fixed inset-0 z-[10001] bg-[var(--color-surface-scrim)] ' +
          'transition-opacity duration-base ease-out ' +
          (open ? 'opacity-100' : 'opacity-0 pointer-events-none')
        }
      />
      <aside
        role="dialog"
        aria-label="Add to watchlist"
        aria-modal="true"
        data-drawer-panel
        className={
          'fixed top-0 left-0 h-screen w-[424px] z-[10002] ' +
          'bg-[var(--color-surface-base)] flex flex-col ' +
          'shadow-[20px_4px_24px_0px_rgba(0,0,0,0.25)] ' +
          'transition-transform duration-base ease-out ' +
          (open ? 'translate-x-0' : '-translate-x-full pointer-events-none')
        }
      >
        <DrawerHeader onClose={onClose} />
        <SearchBox
          inputRef={inputRef}
          value={searchQuery}
          onChange={onSearchChange}
          onEnter={() => {
            const first = visibleTokens[0];
            if (first) onToggle(first.symbol, first.source);
          }}
        />
        <SourceTabRow activeTab={sourceTab} onChange={setSourceTab} />
        <TokenList
          tokens={visibleTokens}
          prices={prices}
          prevDayPrices={prevDayPrices}
          watchlistSet={watchlistSet}
          onToggle={onToggle}
          searchQuery={searchQuery}
        />
      </aside>
    </>,
    document.body,
  );
}

function DrawerHeader({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex items-center justify-between px-4 pt-[27px] pb-4 shrink-0">
      <div className="flex items-center gap-3">
        <GhostHeaderIcon />
        <span className="text-body-md-semibold text-white">Add watchlist</span>
      </div>
      <button
        type="button"
        aria-label="Close"
        data-watchlist-edit
        onClick={onClose}
        className={
          'w-7 h-7 inline-flex items-center justify-center rounded-[4px] ' +
          'bg-transparent border-none cursor-pointer ' +
          'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] ' +
          'btn-press transition-colors duration-fast ease-out'
        }
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M3 3 L11 11 M11 3 L3 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

interface SearchBoxProps {
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (v: string) => void;
  onEnter: () => void;
}

function SearchBox({ inputRef, value, onChange, onEnter }: SearchBoxProps) {
  return (
    <div className="px-[17px] pb-3 shrink-0">
      <div
        className={
          'flex h-[45px] items-center gap-3 px-4 rounded-[4px] ' +
          'bg-[var(--color-surface-canvas)] border border-[var(--color-border-default)] ' +
          'focus-within:border-[var(--color-brand-default)] ' +
          'transition-colors duration-fast ease-out'
        }
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 18 18"
          fill="none"
          aria-hidden="true"
          className="text-[var(--color-text-muted)] flex-none"
        >
          <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M12.5 12.5 L16 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onEnter();
            }
          }}
          placeholder="Search token"
          aria-label="Search tokens"
          className={
            'flex-1 min-w-0 bg-transparent border-none ' +
            'text-body-md text-text-primary ' +
            'placeholder:text-[var(--color-text-muted)] ' +
            'outline-none focus:outline-none focus-visible:outline-none'
          }
        />
      </div>
    </div>
  );
}

interface TokenListProps {
  tokens: TokenEntry[];
  prices: Record<string, number>;
  prevDayPrices: Record<string, number>;
  watchlistSet: Set<string>;
  onToggle: (symbol: string, source: PriceSourceId) => void;
  searchQuery: string;
}

function TokenList({ tokens, prices, prevDayPrices, watchlistSet, onToggle, searchQuery }: TokenListProps) {
  if (tokens.length === 0) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto pb-2">
        <div className="flex flex-col items-center gap-[14px] pt-[90px] px-4">
          <img
            src={emptyTokenSearchIllustration}
            alt=""
            width={128}
            height={129}
            className="block select-none"
            draggable={false}
            aria-hidden="true"
          />
          <p className="m-0 text-body-md text-[var(--color-text-secondary)] text-center">
            {searchQuery
              ? <>No results for &ldquo;{searchQuery.toLowerCase()}&rdquo;</>
              : 'No tokens available'}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex-1 min-h-0 overflow-y-auto pb-2">
      {tokens.map(({ symbol, source }) => {
        const key = `${source}:${symbol}`;
        const isFav = watchlistSet.has(key);
        const price = prices[key];
        const prevDayPrice = prevDayPrices[key];
        return (
          <TokenRow
            key={key}
            symbol={symbol}
            source={source}
            isFav={isFav}
            price={price}
            prevDayPrice={prevDayPrice}
            onToggle={() => onToggle(symbol, source)}
          />
        );
      })}
    </div>
  );
}

interface TokenRowProps {
  symbol: string;
  source: PriceSourceId;
  isFav: boolean;
  price: number | undefined;
  prevDayPrice: number | undefined;
  onToggle: () => void;
}

function TokenRow({ symbol, source, isFav, price, prevDayPrice, onToggle }: TokenRowProps) {
  const { chip, notation } = formatSymbolDisplay(symbol, source);
  const hasChange = price != null && prevDayPrice != null && prevDayPrice > 0;
  const delta = hasChange ? price - prevDayPrice : null;
  const pct = hasChange ? ((price - prevDayPrice) / prevDayPrice) * 100 : null;
  const changeColor = pct != null
    ? pct >= 0
      ? 'var(--color-success-default)'
      : 'var(--color-error-default)'
    : undefined;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={isFav}
      aria-label={isFav ? `Remove ${notation} from watchlist` : `Add ${notation} to watchlist`}
      className={
        'group w-full flex items-center justify-between px-4 py-3 ' +
        'bg-transparent text-left cursor-pointer ' +
        'border-b border-dashed border-border-subtle ' +
        'transition-colors duration-fast ease-out ' +
        'hover:bg-white/[0.03] focus-visible:bg-white/[0.04]'
      }
    >
      <div className="flex items-center gap-3 min-w-0">
        <StarIcon filled={isFav} />
        <div className="flex flex-col gap-0.5 items-start min-w-0">
          <span className="text-body-md text-text-primary leading-[1.5]">{notation}</span>
          <div className="flex items-center gap-1.5">
            <span
              className="inline-flex items-center justify-center h-[18px] px-1 rounded-[3px]"
              aria-label={sourceLabel(source)}
              title={sourceLabel(source)}
            >
              <SourceLogo source={source} />
            </span>
            <span
              className="inline-flex items-center justify-center min-w-[33px] h-[18px] px-1 pt-0.5 pb-1 rounded-[3px] bg-[var(--color-brand-subtle)] text-brand-default text-number-sm leading-none"
            >
              Perp
            </span>
            {chip && (
              <span
                className="inline-flex items-center justify-center h-[18px] px-1 pt-0.5 pb-1 rounded-[3px] bg-[var(--color-brand-subtle)] text-brand-default text-number-sm leading-none"
                aria-label={`HIP-3 dex ${chip}`}
                title={`HIP-3 dex ${chip}`}
              >
                {chip}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="flex flex-col items-end justify-center [font-variant-numeric:tabular-nums]">
        <span className="text-body-md text-text-primary leading-[1.5]">
          {price != null ? formatPrice(price) : '--'}
        </span>
        {hasChange && delta != null && pct != null ? (
          <div className="flex items-center gap-1.5 text-body-sm leading-[1.5]" style={{ color: changeColor }}>
            <span>{formatSignedDelta(delta)}</span>
            <span>{formatSignedPct(pct)}</span>
          </div>
        ) : (
          <span className="text-body-sm text-text-muted">--</span>
        )}
      </div>
    </button>
  );
}

function formatSignedDelta(v: number): string {
  const abs = Math.abs(v);
  const dp = abs >= 100 ? 0 : abs >= 1 ? 2 : 4;
  const body = abs.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return (v >= 0 ? '+' : '-') + body;
}

function formatSignedPct(pct: number): string {
  return (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
}

function SourceTabRow({
  activeTab,
  onChange,
}: {
  activeTab: 'all' | PriceSourceId;
  onChange: (t: 'all' | PriceSourceId) => void;
}) {
  const tabs: ReadonlyArray<{ id: 'all' | PriceSourceId; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'hyperliquid', label: sourceLabel('hyperliquid') },
    { id: 'binance', label: sourceLabel('binance') },
  ];
  // Sliding underline: single absolute-positioned indicator animated via
  // transform + width to the active tab label's measured layout. We
  // measure the inner label span (not the button) so asymmetric button
  // padding (e.g. the first tab having only pr-4) doesn't make the
  // underline overshoot the visible text. ResizeObserver re-measures
  // after web-font load (which can change the text width post-mount).
  const tablistRef = useRef<HTMLDivElement | null>(null);
  const labelRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const [indicator, setIndicator] = useState<{ left: number; width: number }>({ left: 0, width: 0 });
  const [hasMeasured, setHasMeasured] = useState(false);
  useLayoutEffect(() => {
    const measure = () => {
      const el = labelRefs.current[activeTab];
      const container = tablistRef.current;
      if (!el || !container) return;
      // `left: 0` on an absolute child anchors at the containing block's
      // padding-box outer edge, which when the container has no left
      // border equals the border-box edge — NOT the content-box edge.
      // So translateX is the label's offset from the container's
      // border-left, with NO paddingLeft subtraction. ResizeObserver
      // re-fires after font load so the measurement stays correct
      // across async layout shifts.
      const containerRect = container.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      setIndicator({
        left: rect.left - containerRect.left,
        width: rect.width,
      });
      setHasMeasured(true);
    };
    measure();
    const el = labelRefs.current[activeTab];
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeTab]);
  return (
    <div
      ref={tablistRef}
      role="tablist"
      aria-label="Filter tokens by source"
      className="relative flex items-center px-4 border-b border-border-subtle shrink-0"
    >
      {tabs.map((t, i) => {
        const active = activeTab === t.id;
        // First tab has no left padding so its label aligns with the
        // search input's left edge above (the container's px-4 already
        // matches the input wrapper).
        const padCls = i === 0 ? 'pr-4' : 'px-4';
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={
              `h-9 ${padCls} inline-flex items-center justify-center cursor-pointer ` +
              'bg-transparent border-0 ' +
              'text-body-md-semibold leading-[1.5] transition-colors duration-fast ease-out ' +
              (active ? 'text-brand-default' : 'text-white hover:text-text-secondary')
            }
          >
            <span ref={(el) => { labelRefs.current[t.id] = el; }} className="inline-block">{t.label}</span>
          </button>
        );
      })}
      <span
        aria-hidden="true"
        className="absolute bottom-0 left-0 h-[2px] bg-brand-default transition-[transform,width] duration-base ease-out pointer-events-none"
        style={{
          transform: `translateX(${indicator.left}px)`,
          width: indicator.width,
          // Hide until first measurement lands so the indicator doesn't
          // flash at translate=0 on mount before useLayoutEffect runs.
          opacity: hasMeasured ? 1 : 0,
        }}
      />
    </div>
  );
}

function StarIcon({ filled }: { filled: boolean }) {
  const color = filled ? 'var(--color-brand-default)' : 'var(--color-text-muted)';
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill={filled ? 'var(--color-brand-default)' : 'none'} aria-hidden="true">
      <path
        d="M7 1.5L8.71 5.13L12.5 5.78L9.75 8.5L10.42 12.25L7 10.5L3.58 12.25L4.25 8.5L1.5 5.78L5.29 5.13L7 1.5Z"
        stroke={color}
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GhostHeaderIcon() {
  return (
    <svg width="26" height="31" viewBox="0 0 26 31" fill="none" aria-hidden="true">
      <path
        d="M24.8806 22.2613C24.4178 19.0825 23.946 15.8943 23.2747 12.7556C21.7517 5.63365 20.642 0.722784 12.0789 1.61512C5.83391 2.26514 5.05875 8.83489 4.03022 13.969C3.52713 16.4795 2.98681 19.3324 2.7042 21.8666C2.62905 22.5363 2.48706 22.9197 2.99373 23.4774C4.26743 24.8788 6.52132 22.3196 7.74681 22.3889C8.61626 22.4388 9.0658 23.1839 9.77514 23.4919C11.951 24.4377 12.4231 22.5982 13.831 22.6275C14.7434 22.647 15.0748 23.3899 15.8523 23.6177C18.0223 24.2533 18.5063 22.3132 20.0337 22.3826C20.5644 22.407 20.9437 22.8392 21.3993 23.0669C22.4715 23.6051 23.8797 24.3989 24.622 23.3766C24.8532 23.0588 24.9354 22.652 24.8781 22.2613H24.8806ZM13.7607 15.6231C10.1454 15.6231 7.21464 12.9213 7.21464 9.58951C7.21464 6.25775 10.1454 3.55598 13.7607 3.55598C17.376 3.55598 20.3067 6.25775 20.3067 9.58951C20.3067 12.9213 17.376 15.6231 13.7607 15.6231Z"
        fill="var(--color-brand-default)"
      />
      <circle cx="6.5" cy="27.5" r="1.5" fill="var(--color-brand-default)" />
      <circle cx="13.5" cy="27.5" r="1.5" fill="var(--color-brand-default)" />
      <circle cx="20.5" cy="27.5" r="1.5" fill="var(--color-brand-default)" />
    </svg>
  );
}

function formatPrice(v: number): string {
  const dp = v >= 1 ? 2 : 4;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
