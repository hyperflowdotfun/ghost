import { type ReactNode, Children, isValidElement, useEffect } from 'react';
import { Streamdown, type StreamdownProps } from 'streamdown';
import { code } from '@streamdown/code';
import { createMathPlugin } from '@streamdown/math';
import 'katex/dist/katex.min.css';

const math = createMathPlugin({ singleDollarTextMath: true });
import { LinkPreviewModal } from './LinkPreviewModal';
import { ChartDataProvider } from './ChartDataContext';
import { useChartDataStore, chartDataKey } from './ChartDataContext-internals';
import { useChartData } from '@/hooks/useChartData';
import { useChartPanel } from '@/components/chart/ChartPanelContext-internals';
import { IndicatorMention } from '@/components/chart/IndicatorMention';
import { LevelMention } from '@/components/chart/LevelMention';
import { normalizeMathDelimiters } from './math-delimiters';

/* ── Chart tag renderer ──
 * Fetches chart data into the ChartDataContext (used by <ind>/<lvl>
 * tooltip mentions), AND always renders a visible clickable pill so
 * the user never ends up with an empty assistant bubble when the
 * agent emits only a chart tag. Clicking the pill opens the
 * fullscreen chart overlay.
 */

/**
 * Fallback parser for body-style `<chart>` content: walks the React children
 * tree for `key: value` lines. Mirrors the backend's body-style fallback in
 * `src/channels/telegram/format/tags.ts` so web + telegram accept the same
 * malformed-but-recoverable LLM output.
 */
function parseChartBodyChildren(
  children: ReactNode,
): { symbol?: string; interval?: string; indicators?: string } | null {
  const text = collectText(children);
  if (!text) return null;
  const out: { symbol?: string; interval?: string; indicators?: string } = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(symbol|interval|indicators)\s*:\s*(.+?)\s*$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase() as 'symbol' | 'interval' | 'indicators';
    if (!out[key]) out[key] = m[2];
  }
  return out.symbol ? out : null;
}

function collectText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (isValidElement(node)) {
    const children = (node.props as { children?: ReactNode }).children;
    return Children.toArray(children).map(collectText).join('');
  }
  return '';
}

function ChartTag({
  symbol,
  interval,
  indicators,
  children,
}: {
  symbol: string;
  interval?: string;
  indicators?: string;
  children?: ReactNode;
}) {
  const { data, loading, error } = useChartData(symbol, interval, indicators);
  const chartStore = useChartDataStore();
  const panel = useChartPanel();

  useEffect(() => {
    if (data && chartStore) {
      chartStore.set(chartDataKey(symbol, interval, indicators), data);
    }
  }, [data, chartStore, symbol, interval, indicators]);

  const label = interval
    ? `${symbol.toUpperCase()} · ${interval}`
    : symbol.toUpperCase();

  const handleOpen = () => {
    if (data && panel) panel.open({ symbol: data.symbol, interval: data.interval });
  };

  const disabled = !data || loading || !!error;

  const pill = (
    <button
      type="button"
      onClick={handleOpen}
      disabled={disabled}
      aria-label={`Open ${label} chart`}
      className={
        'my-1.5 inline-flex items-center gap-1.5 px-2 py-1 rounded-[4px] ' +
        'bg-[var(--color-surface-base)] border border-[var(--color-border-default)] text-footnote ' +
        'transition-colors duration-fast ease-out ' +
        (disabled
          ? 'text-[var(--color-text-secondary)] cursor-default opacity-70'
          : 'text-[var(--color-text-primary)] cursor-pointer hover:border-[var(--color-brand-default)] hover:text-[var(--color-brand-default)] focus-visible:border-[var(--color-brand-default)] focus-visible:text-[var(--color-brand-default)]')
      }
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 3v18h18" />
        <path d="M7 14l4-4 4 4 5-5" />
      </svg>
      <span>
        {loading ? 'Loading chart…' : error ? `${label} (unavailable)` : label}
      </span>
      {!disabled && <span aria-hidden="true">→</span>}
    </button>
  );

  return (
    <>
      {children}
      {pill}
    </>
  );
}

/* ── Trading semantic components ── */

const ALLOWED_TAGS = {
  pct: ['dir'],
  price: [],
  pnl: ['dir'],
  lev: [],
  side: ['dir'],
  tag: ['type'],
  risk: ['level'],
  verdict: ['type'],
  chart: ['symbol', 'interval', 'indicators', 'levels', 'focus-time', 'focus-price'],
  ind: ['name'],
  lvl: ['price'],
  // Ask-wizard block tags. Without these, rehype-sanitize escapes the
  // unknown elements to literal text — the raw `<asks>` wrapper leaks
  // into every render path that doesn't pre-process content (chat.delta
  // streaming, chat.done !sid branch, chat.proactive, approval-requested
  // pre-text, historyToMessages reload). Registering them here + a
  // passthrough component (see askPassthroughComponents) lets the parser
  // tokenize the tags and then strip just the wrapper while keeping the
  // inner prose visible. NOTE: tag name was `ask_user_question`
  // originally but CommonMark raw-HTML tag names disallow underscores —
  // remark refused to tokenize it so this registration had no effect.
  // The rename to `asks` lets the markdown parser recognise the tag.
  asks: [],
  question: [],
  title: [],
  options: [],
  option: [],
};

const tradingComponents = {
  pct: ({ dir, children }: { dir?: string; children?: ReactNode }) => (
    <span className={dir === 'up' ? 'trade-pct-up' : 'trade-pct-down'}>{children}</span>
  ),
  price: ({ children }: { children?: ReactNode }) => (
    <span className="trade-price">{children}</span>
  ),
  pnl: ({ dir, children }: { dir?: string; children?: ReactNode }) => (
    <span className={dir === 'up' ? 'trade-pnl-up' : 'trade-pnl-down'}>{children}</span>
  ),
  lev: ({ children }: { children?: ReactNode }) => (
    <span className="trade-leverage">{children}</span>
  ),
  side: ({ dir, children }: { dir?: string; children?: ReactNode }) => (
    <span className={dir === 'long' ? 'trade-long' : 'trade-short'}>{children}</span>
  ),
  tag: ({ type, children }: { type?: string; children?: ReactNode }) => (
    <span className={`trade-tag trade-tag-${type ?? 'entry'}`}>{children}</span>
  ),
  risk: ({ level, children }: { level?: string; children?: ReactNode }) => (
    <span className={`trade-risk trade-risk-${level ?? 'medium'}`}>{children}</span>
  ),
  verdict: ({ type, children }: { type?: string; children?: ReactNode }) => (
    <span className={`trade-verdict trade-verdict-${type ?? 'neutral'}`}>{children}</span>
  ),
  ind: ({ name, children }: { name?: string; children?: ReactNode }) => (
    <IndicatorMention name={name}>{children}</IndicatorMention>
  ),
  lvl: ({ price, children }: { price?: string; children?: ReactNode }) => (
    <LevelMention price={price}>{children}</LevelMention>
  ),
  chart: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => {
    // Resolve spec — prefer attributes; fall back to parsing body-style
    // `key: value` lines (LLMs occasionally emit `<chart>\nsymbol: BTC\n…</chart>`
    // instead of the documented `<chart symbol="…" />` attribute form).
    const fallback = props.symbol ? null : parseChartBodyChildren(children);
    const symbol = String(props.symbol ?? fallback?.symbol ?? '');
    const interval = props.interval ? String(props.interval) : fallback?.interval;
    const indicators = props.indicators ? String(props.indicators) : fallback?.indicators;
    return (
      <ChartTag symbol={symbol} interval={interval} indicators={indicators}>
        {fallback ? null : children}
      </ChartTag>
    );
  },
};

/* ── Ask-wizard block: hide entirely in the bubble ──
 *  AskCard renders the wizard from `askBlocks` at the ChatInput dock —
 *  showing the same text inline would duplicate. */

// Bubble shows the agent's questions (title text) but NOT the option
// buttons — those are rendered as interactive buttons by AskCard at the
// ChatInput dock. `asks` / `question` / `title` render their children
// as a fragment so the title text stays visible; `options` / `option`
// return `null` so the option labels do not duplicate as inline prose.
const askPassthroughComponents = {
  asks: ({ children }: { children?: ReactNode }) => <>{children}</>,
  question: ({ children }: { children?: ReactNode }) => <>{children}</>,
  title: ({ children }: { children?: ReactNode }) => <>{children}</>,
  options: () => null,
  option: () => null,
};

/* ── Table components ── */

const tableComponents = {
  table: ({ children }: { children?: ReactNode }) => (
    <div className="overflow-x-auto my-3">
      <table className="w-full border-collapse text-body-md border border-white/[0.08] rounded-[4px]">{children}</table>
    </div>
  ),
  th: ({ children }: { children?: ReactNode }) => (
    <th className="px-3 py-1.5 text-left text-label-sm uppercase tracking-wider text-slate-400 border-b border-white/10 bg-white/5">
      {children}
    </th>
  ),
  td: ({ children }: { children?: ReactNode }) => (
    <td className="px-3 py-1.5 text-left text-body-md tabular-nums border-b border-white/[0.06]">
      {children}
    </td>
  ),
};

/* ── Streamdown config (stable references) ── */

const plugins = { code, math };

const mdComponents = {
  ...tradingComponents,
  ...askPassthroughComponents,
  ...tableComponents,
};

const linkSafety: StreamdownProps['linkSafety'] = {
  enabled: true,
  renderModal: ({ isOpen, onClose, onConfirm, url }) =>
    isOpen ? <LinkPreviewModal url={url} onClose={onClose} onConfirm={onConfirm} /> : null,
};

interface StreamingMarkdownProps {
  content: string;
  streaming?: boolean;
}

const LITERAL_TAG_CONTENT = ['ind', 'lvl'];

export function StreamingMarkdown({
  content,
  streaming,
}: StreamingMarkdownProps) {
  const normalized = normalizeMathDelimiters(content);
  return (
    <ChartDataProvider>
      <div className="chat-md">
        <Streamdown
          mode={streaming ? 'streaming' : 'static'}
          components={mdComponents}
          allowedTags={ALLOWED_TAGS}
          literalTagContent={LITERAL_TAG_CONTENT}
          plugins={plugins}
          linkSafety={linkSafety}
          isAnimating={streaming}
          caret="block"
        >
          {normalized}
        </Streamdown>
      </div>
    </ChartDataProvider>
  );
}
