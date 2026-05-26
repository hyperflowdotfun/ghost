import { useState, useEffect, useCallback, useMemo, createContext, useContext, type ReactNode } from 'react';
import { useGateway } from '@/hooks/useGateway';
import { useChartPanel } from '@/components/chart/ChartPanelContext-internals';
import { WatchlistAddDrawer } from './WatchlistAddDrawer';
import { formatSymbolDisplay, sourceLabel, type MarketType, type PriceSourceId } from './symbol-utils';

interface WatchlistEditCtx {
  isEditing: boolean;
  setIsEditing: (v: boolean) => void;
}

const WatchlistEditContext = createContext<WatchlistEditCtx>({
  isEditing: false, setIsEditing: () => {},
});

export function WatchlistEditProvider({ children }: { children: ReactNode }) {
  const [isEditing, setIsEditing] = useState(false);
  const value = useMemo(() => ({ isEditing, setIsEditing }), [isEditing]);
  return <WatchlistEditContext.Provider value={value}>{children}</WatchlistEditContext.Provider>;
}

function useWatchlistEditing(): [boolean, (v: boolean) => void] {
  const ctx = useContext(WatchlistEditContext);
  return [ctx.isEditing, ctx.setIsEditing];
}

function EmptyCard({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="px-4 py-6 flex flex-col items-center gap-2.5">
      <div className="w-10 h-10 rounded-[4px] bg-[rgba(0,184,255,0.04)] border border-[rgba(0,184,255,0.1)] flex items-center justify-center">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00b8ff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-60">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      </div>
      <div className="flex flex-col items-center gap-[3px]">
        <span className="text-caption text-[var(--color-text-secondary)]">{title}</span>
        <span className="text-footnote text-[var(--color-text-secondary)] text-center leading-[1.4]">{subtitle}</span>
      </div>
    </div>
  );
}

function formatPrice(v: number): string {
  const dp = v >= 1 ? 2 : 4;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

const SHELL_CLS = 'flex flex-col gap-2';

function WatchlistInternalHeader() {
  const [isEditing, setIsEditing] = useWatchlistEditing();

  return (
    <div className="h-[38px] flex items-center justify-between px-2.5 bg-surface-base border-l border-border-subtle shrink-0">
      <span className="text-body-md-semibold text-text-secondary">WATCHLIST</span>
      <button
        type="button"
        data-watchlist-edit
        aria-label={isEditing ? 'Done editing watchlist' : 'Add token to watchlist'}
        aria-pressed={isEditing}
        onClick={(e) => { e.stopPropagation(); setIsEditing(!isEditing); }}
        className={
          'bg-transparent border-none cursor-pointer transition-colors duration-fast ease-out p-0 inline-flex items-center justify-center '
          + (isEditing ? 'text-brand-default' : 'text-text-tertiary hover:text-text-primary')
        }
      >
        {isEditing ? (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M2 6L5 9L10 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M6 1.5V10.5M1.5 6H10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        )}
      </button>
    </div>
  );
}

// TradingView-style 24h change formatters. Color follows the sign of the
// 24h delta — green up, red down, muted when unknown. The signed prefix
// is part of the formatted string so the row reads as a single number,
// not a glyph + magnitude pair.
function formatChange(v: number): string {
  const abs = Math.abs(v);
  const dp = abs >= 100 ? 2 : abs >= 1 ? 2 : 4;
  const body = abs.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return (v >= 0 ? '+' : '-') + body;
}

function formatPct(v: number): string {
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
}

function changeColor(v: number | null): string {
  if (v == null) return 'var(--color-text-secondary)';
  return v >= 0 ? 'var(--color-success-default)' : 'var(--color-error-default)';
}

function MarketTypeChip({ type }: { type: MarketType }) {
  const isPerp = type === 'Perp';
  return (
    <span
      className={
        'inline-flex items-center justify-center min-w-[33px] h-[18px] px-1 pt-0.5 pb-1 rounded-[3px] ' +
        'text-number-sm leading-none ' +
        (isPerp
          ? 'bg-[var(--color-brand-subtle)] text-brand-default'
          : 'bg-[var(--color-border-default)] text-text-secondary')
      }
    >
      {type}
    </span>
  );
}

interface TokenInfo {
  symbol: string;
  source: PriceSourceId;
  isDelisted?: true;
}

interface TokenData {
  tokens: TokenInfo[];
  /** Keyed `${source}:${symbol}` (e.g. "hyperliquid:BTC", "binance:BTCUSDT"). */
  prices: Record<string, number>;
  /** Keyed `${source}:${symbol}`. */
  prevDayPrices: Record<string, number>;
}

interface WatchlistItem {
  symbol: string;
  source: PriceSourceId;
  addedAt: string;
  notes?: string;
}

export function WatchlistWidget() {
  const [watchlistItems, setWatchlistItems] = useState<WatchlistItem[]>([]);
  const [tokenData, setTokenData] = useState<TokenData>({ tokens: [], prices: {}, prevDayPrices: {} });
  const [isEditing, setIsEditing] = useWatchlistEditing();
  const [searchQuery, setSearchQuery] = useState('');
  const { request, connected, subscribe } = useGateway();
  const panel = useChartPanel();

  const loadWatchlist = useCallback(() => {
    if (!connected) return;
    request<{ items: WatchlistItem[] }>('trading.watchlist.list', {})
      .then((res) => setWatchlistItems(res.items ?? []))
      .catch(() => {});
  }, [connected, request]);

  const fetchTokens = useCallback(() => {
    if (!connected) return;
    request<TokenData>('trading.tokens.list', {})
      .then((res) => {
        // On transient HL outage the gateway returns empty maps. Preserve
        // the last-known prices so the UI doesn't flash to blank state
        // until the next successful poll.
        setTokenData((prev) => ({
          ...res,
          prices: Object.keys(res.prices).length > 0 ? res.prices : prev.prices,
          prevDayPrices: Object.keys(res.prevDayPrices).length > 0 ? res.prevDayPrices : prev.prevDayPrices,
        }));
      })
      .catch(() => {});
  }, [connected, request]);

  useEffect(() => {
    loadWatchlist();
    fetchTokens();
  }, [loadWatchlist, fetchTokens]);

  // Metadata refresh — token universe + leverage tiers change on the order
  // of hours, not seconds. Prices arrive via WS (`trading.price.update`).
  useEffect(() => {
    if (!connected) return;
    const id = window.setInterval(() => fetchTokens(), 60_000);
    return () => window.clearInterval(id);
  }, [connected, fetchTokens]);

  useEffect(() => {
    return subscribe((evt) => {
      if (evt.event === 'trading.watchlist.changed' || evt.event === 'chat.done') {
        loadWatchlist();
      }
      if (evt.event === 'trading.source.tick') {
        // Per-source tick — carries the source label so we can update HL +
        // Binance rows independently. Trading-domain consumers continue to
        // subscribe to `trading.price.update` (HL-canonical, primary-only).
        const { source, symbol, price, prevDayPrice } = evt.payload as {
          source: PriceSourceId; symbol: string; price: number; prevDayPrice?: number;
        };
        const key = `${source}:${symbol}`;
        setTokenData((prev) => {
          const priceUnchanged = prev.prices[key] === price;
          const prevDayUnchanged = prevDayPrice === undefined
            || prev.prevDayPrices[key] === prevDayPrice;
          if (priceUnchanged && prevDayUnchanged) return prev;
          return {
            ...prev,
            prices: priceUnchanged ? prev.prices : { ...prev.prices, [key]: price },
            prevDayPrices: prevDayPrice !== undefined
              ? { ...prev.prevDayPrices, [key]: prevDayPrice }
              : prev.prevDayPrices,
          };
        });
      }
    });
  }, [subscribe, loadWatchlist]);

  // Drawer owns its own input focus; this widget just resets the search
  // when the drawer closes.
  useEffect(() => {
    if (!isEditing) setSearchQuery('');
  }, [isEditing]);

  const { prices, prevDayPrices, tokens: allTokens } = tokenData;
  const hasPrices = Object.keys(prices).length > 0;

  // watchlistSet stores `${source}:${symbol}` so we can distinguish HL BTC
  // from Binance BTCUSDT (same row collision when keyed by symbol alone).
  const watchlistSet = useMemo(
    () => new Set(watchlistItems.map((i) => `${i.source}:${i.symbol}`)),
    [watchlistItems],
  );

  const tokenEntries = useMemo(
    () => allTokens.filter((t) => !t.isDelisted).map((t) => ({ symbol: t.symbol, source: t.source })),
    [allTokens],
  );

  const filteredTokens = useMemo(() => {
    const list = searchQuery
      ? tokenEntries.filter((t) => {
          const q = searchQuery.toUpperCase();
          const { notation } = formatSymbolDisplay(t.symbol, t.source);
          return t.symbol.toUpperCase().includes(q) || notation.toUpperCase().includes(q);
        })
      : tokenEntries;
    const sourceRank: Record<PriceSourceId, number> = { hyperliquid: 0, binance: 1 };
    const fav = list.filter((t) => watchlistSet.has(`${t.source}:${t.symbol}`));
    const rest = list.filter((t) => !watchlistSet.has(`${t.source}:${t.symbol}`));
    const cmp = (a: { symbol: string; source: PriceSourceId }, b: { symbol: string; source: PriceSourceId }) => {
      if (a.source !== b.source) return sourceRank[a.source] - sourceRank[b.source];
      // HL native (no colon) first, then HIP-3, then alphabetical.
      const aHip = a.symbol.includes(':') ? 1 : 0;
      const bHip = b.symbol.includes(':') ? 1 : 0;
      if (aHip !== bHip) return aHip - bHip;
      return a.symbol.localeCompare(b.symbol);
    };
    return [...fav.sort(cmp), ...rest.sort(cmp)];
  }, [tokenEntries, searchQuery, watchlistSet]);

  const toggleToken = useCallback((symbol: string, source: PriceSourceId) => {
    const isFav = watchlistSet.has(`${source}:${symbol}`);
    const method = isFav ? 'trading.watchlist.remove' : 'trading.watchlist.add';
    request(method, { symbol, source })
      .then(() => loadWatchlist())
      .catch(() => {});
  }, [watchlistSet, request, loadWatchlist]);

  function renderAddDrawer() {
    return (
      <WatchlistAddDrawer
        open={isEditing}
        onClose={() => setIsEditing(false)}
        tokens={filteredTokens}
        prices={prices}
        prevDayPrices={prevDayPrices}
        watchlistSet={watchlistSet}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onToggle={toggleToken}
      />
    );
  }

  // Loading state
  if (watchlistItems.length === 0 && !hasPrices && connected) {
    return (
      <div className={SHELL_CLS}>
        <WatchlistInternalHeader />
        <EmptyCard title="Loading prices…" subtitle="Fetching latest market data" />
        {renderAddDrawer()}
      </div>
    );
  }

  // Empty state
  if (watchlistItems.length === 0) {
    return (
      <div className={SHELL_CLS}>
        <WatchlistInternalHeader />
        <EmptyCard title="No favorites yet" subtitle="Click + to add tokens to your watchlist" />
        {renderAddDrawer()}
      </div>
    );
  }

  // Used by the "binance disabled" hint (Task 16) — when no Binance tokens
  // surface from the snapshot we can show a muted inline label on orphaned
  // Binance rows instead of `--`.
  const binanceAvailable = allTokens.some((t) => t.source === 'binance');

  return (
    <div className={SHELL_CLS}>
      <WatchlistInternalHeader />
      <div className="flex flex-col pb-2">
        {watchlistItems.map((item) => {
          const key = `${item.source}:${item.symbol}`;
          const price = prices[key];
          const prevDay = prevDayPrices[key];
          const hasChange = price != null && prevDay != null && prevDay > 0;
          const changeVal = hasChange ? price - prevDay : null;
          const changePct = hasChange ? ((price - prevDay) / prevDay) * 100 : null;
          const color = changeColor(changePct);
          const { chip, notation } = formatSymbolDisplay(item.symbol, item.source);
          const binanceDegraded = item.source === 'binance' && !binanceAvailable;
          return (
            <div
              key={key}
              className="group flex items-center justify-between gap-3 px-2.5 py-3 cursor-pointer transition-colors duration-fast ease-out hover:bg-white/[0.03] border-b border-dashed border-border-subtle"
              onClick={() => panel?.open({ symbol: item.symbol, source: item.source })}
            >
              <div className="flex flex-col gap-0.5 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-body-md text-text-primary leading-[1.5]">{notation}</span>
                  <MarketTypeChip type="Perp" />
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
                <span className="text-number-sm text-text-secondary leading-[1.5]">{sourceLabel(item.source)}</span>
              </div>
              {binanceDegraded ? (
                <span className="text-body-sm text-text-secondary">Binance disabled</span>
              ) : (
                <div className="flex flex-col items-end gap-0.5 [font-variant-numeric:tabular-nums]">
                  <span className="text-body-md text-text-primary leading-[1.5]">{price != null ? formatPrice(price) : '--'}</span>
                  <div className="flex items-center gap-1.5 text-number-sm leading-[1.5]">
                    <span style={{ color }}>{changeVal != null ? formatChange(changeVal) : '--'}</span>
                    <span style={{ color }}>{changePct != null ? formatPct(changePct) : '--'}</span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {renderAddDrawer()}
    </div>
  );
}
