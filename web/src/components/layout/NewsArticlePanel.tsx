import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Avatar } from '@/components/ui';
import { useGateway } from '@/hooks/useGateway';
import { PulsingDots } from '@/components/chat/PulsingDots';
import {
  type NewsArticle,
  SOURCE_NAMES,
  timeAgo,
  sourceLogoUrl,
} from './news-utils';

export interface NewsArticlePanelProps {
  article: NewsArticle;
  /** When true, viewport is narrow enough that the drawer is hidden; the panel
   *  takes the right slot. Controlled by NewsWidget via matchMedia. */
  compact: boolean;
  onClose: () => void;
}

type SummaryState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; summary: string; cached: boolean }
  | { kind: 'failed'; error: string };

type View = 'body' | 'summary';

export function NewsArticlePanel({ article, compact, onClose }: NewsArticlePanelProps) {
  const { request } = useGateway();
  const [view, setView] = useState<View>('body');
  const [summary, setSummary] = useState<SummaryState>({ kind: 'idle' });
  // Token bumped on every article switch / unmount. In-flight requests check
  // their captured token against the current ref before applying state — late
  // responses from a previous article get dropped.
  const reqTokenRef = useRef(0);

  // Reset view + cached summary when switching to a different article so the
  // previous article's summary never bleeds into the new panel.
  useEffect(() => {
    reqTokenRef.current++;
    setView('body');
    setSummary({ kind: 'idle' });
  }, [article.id]);

  useEffect(() => {
    // Capture-phase Esc: pop summary view first, only close on second press.
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (view === 'summary') setView('body');
      else onClose();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onClose, view]);

  const sourceName = SOURCE_NAMES[article.sourceId] ?? article.sourceId;
  const publishedDate = new Date(article.publishedAt * 1000).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });

  const bodyText = article.body && article.body.length > 0 ? article.body : null;
  const hasBody = bodyText !== null;
  // Legacy rows (pre-migration v11) have body=null but a cron-generated summary
  // already cached. Render it inline without the toggle — there's nothing to
  // switch to.
  const legacySummary = !hasBody && article.summary && article.summary.length > 0 ? article.summary : null;
  const fallbackText = !hasBody && !legacySummary && article.description.length > 0 ? article.description : null;

  const requestSummary = useCallback(async () => {
    setView('summary');
    // No-op if a result is cached or a fetch is already in flight.
    if (summary.kind === 'ready' || summary.kind === 'loading') return;
    const token = reqTokenRef.current;
    setSummary({ kind: 'loading' });
    try {
      const res = await request<{ ok: boolean; summary?: string; cached?: boolean; error?: string }>(
        'trading.news.summarize',
        { articleId: article.id },
      );
      if (token !== reqTokenRef.current) return;
      if (res.ok && res.summary) {
        setSummary({ kind: 'ready', summary: res.summary, cached: Boolean(res.cached) });
      } else {
        setSummary({ kind: 'failed', error: res.error ?? 'Failed to generate summary' });
      }
    } catch {
      if (token !== reqTokenRef.current) return;
      setSummary({ kind: 'failed', error: 'Network error' });
    }
  }, [article.id, request, summary.kind]);

  return createPortal(
    <aside
      role="dialog"
      aria-label={article.title}
      aria-modal="false"
      className={
        'fixed top-0 h-screen w-[800px] z-[10003] ' +
        'bg-[var(--color-surface-base)] flex flex-col ' +
        'shadow-[-20px_4px_24px_0px_rgba(0,0,0,0.25)] ' +
        'transition-transform duration-base ease-out translate-x-0 ' +
        (compact ? 'right-0' : 'right-[408px]')
      }
    >
      <div className="flex-1 overflow-y-auto w-full">
        <div className="py-4 px-6 flex flex-col items-end gap-[19px] w-[725px] mx-auto">
          <div className="flex items-center justify-between w-full">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className="inline-flex items-center justify-center rounded-full border bg-[#0f1012] shrink-0 overflow-hidden"
                style={{ width: 32, height: 32, borderColor: 'rgba(122,129,128,0.3)' }}
              >
                <Avatar
                  url={sourceLogoUrl(article.sourceId)}
                  seed={article.sourceId}
                  label={sourceName}
                  size={24}
                />
              </span>
              <div className="flex flex-col min-w-0">
                <span className="text-label-lg text-text-primary leading-[1.5] truncate">
                  {sourceName}
                </span>
                <span className="text-body-sm text-text-secondary leading-[1.5]">
                  {timeAgo(article.publishedAt)}
                </span>
              </div>
            </div>
            {hasBody ? (
              <ViewToggle
                view={view}
                onShowBody={() => setView('body')}
                onShowSummary={requestSummary}
              />
            ) : legacySummary ? (
              <span className="inline-flex items-center gap-1.5 text-body-sm text-text-secondary leading-[1.5]">
                <SparklesIcon className="text-[var(--color-brand-default)]" />
                Summary by AI
              </span>
            ) : null}
          </div>

          <div className="flex flex-col items-start gap-2 w-full">
            <h1 className="text-heading-md text-text-primary leading-[1.5] m-0">{article.title}</h1>
            <div className="text-body-md text-text-secondary leading-[1.5]">
              <a
                href={article.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-text-secondary underline hover:text-text-primary"
              >
                {sourceName}
              </a>
              {' · Published '}
              {publishedDate}
            </div>
          </div>

          {article.imageUrl && (!hasBody || view === 'body') && (
            <img
              src={article.imageUrl}
              alt=""
              loading="lazy"
              className="w-full aspect-[1920/1080] object-cover rounded-[2px]"
            />
          )}

          {hasBody ? (
            view === 'body' ? (
              <ArticleBody body={bodyText} fallback={null} />
            ) : (
              <SummaryView state={summary} onRetry={requestSummary} />
            )
          ) : (
            <LegacyContent summary={legacySummary} fallback={fallbackText} />
          )}

          <a
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            className={
              'inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-[4px] ' +
              'bg-[var(--color-surface-overlay)] border border-[var(--color-border-strong)] ' +
              'text-body-md-medium text-text-secondary no-underline cursor-pointer ' +
              'transition-colors duration-fast ease-out btn-press ' +
              'hover:text-text-primary hover:border-[var(--color-text-tertiary)]'
            }
          >
            View original
            <ArrowUpRightIcon />
          </a>
        </div>
      </div>
    </aside>,
    document.body,
  );
}

function ViewToggle({
  view, onShowBody, onShowSummary,
}: {
  view: View;
  onShowBody: () => void;
  onShowSummary: () => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Article view"
      className="inline-flex items-center gap-0.5 p-0.5 rounded-[6px] bg-[var(--color-surface-overlay)] border border-[var(--color-border-subtle)]"
    >
      <button
        type="button"
        role="tab"
        aria-selected={view === 'body'}
        onClick={onShowBody}
        className={
          'inline-flex items-center gap-1.5 h-7 px-3 rounded-[4px] border-0 cursor-pointer ' +
          'text-body-sm-medium transition-colors duration-fast ease-out btn-press ' +
          (view === 'body'
            ? 'bg-[var(--color-surface-raised)] text-text-primary'
            : 'bg-transparent text-text-secondary hover:text-text-primary')
        }
      >
        Article
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={view === 'summary'}
        onClick={onShowSummary}
        title="Generate AI summary"
        className={
          'inline-flex items-center gap-1.5 h-7 px-3 rounded-[4px] border-0 cursor-pointer ' +
          'text-body-sm-medium transition-colors duration-fast ease-out btn-press ' +
          (view === 'summary'
            ? 'bg-[var(--color-surface-raised)] text-text-primary'
            : 'bg-transparent text-text-secondary hover:text-text-primary')
        }
      >
        <SparklesIcon className="text-[var(--color-brand-default)]" />
        AI Summary
      </button>
    </div>
  );
}

function ArticleBody({ body, fallback }: { body: string | null; fallback: string | null }) {
  if (body) {
    // Backend sanitizes the body (allowlist tags/attrs, https URLs, target=_blank).
    return <div className="article-html w-full" dangerouslySetInnerHTML={{ __html: body }} />;
  }

  if (fallback) {
    return (
      <div className="flex flex-col gap-2 w-full">
        <p className="text-body-lg text-text-primary leading-[1.5] m-0 whitespace-pre-wrap">
          {fallback}
        </p>
        <p className="text-footnote text-text-tertiary leading-[1.5] m-0 italic">
          Full article body unavailable — view original for the full story.
        </p>
      </div>
    );
  }

  return null;
}

// Pre-v11 articles never had `body` fetched, but the old cron already
// populated `summary`. Render that cached summary inline with no toggle —
// matches the panel's behaviour before the on-demand summarize PR landed.
function LegacyContent({ summary, fallback }: { summary: string | null; fallback: string | null }) {
  if (summary) {
    const paragraphs = splitParagraphs(summary);
    return (
      <div className="flex flex-col gap-3 w-full">
        {paragraphs.map((para, i) => (
          <p key={i} className="text-body-lg text-text-primary leading-[1.5] m-0">
            {para}
          </p>
        ))}
      </div>
    );
  }
  if (fallback) {
    return (
      <div className="flex flex-col gap-2 w-full">
        <p className="text-body-lg text-text-primary leading-[1.5] m-0 whitespace-pre-wrap">
          {fallback}
        </p>
        <p className="text-footnote text-text-tertiary leading-[1.5] m-0 italic">
          Full article body unavailable — view original for the full story.
        </p>
      </div>
    );
  }
  return null;
}

function SummaryView({ state, onRetry }: { state: SummaryState; onRetry: () => void }) {
  if (state.kind === 'loading' || state.kind === 'idle') {
    return (
      <div className="w-full min-h-[180px] flex flex-col items-center justify-center gap-3">
        <PulsingDots />
        <span className="text-body-sm text-text-tertiary leading-[1.5]">Generating AI summary…</span>
      </div>
    );
  }

  if (state.kind === 'failed') {
    return (
      <div className="w-full flex flex-col items-start gap-2">
        <p className="text-body-md text-[var(--color-error-default)] leading-[1.5] m-0">
          {state.error}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="text-body-sm text-text-secondary underline hover:text-text-primary cursor-pointer bg-transparent border-0 p-0"
        >
          Try again
        </button>
      </div>
    );
  }

  const paragraphs = splitParagraphs(state.summary);
  return (
    <div className="flex flex-col gap-3 w-full">
      {paragraphs.map((para, i) => (
        <p key={i} className="text-body-lg text-text-primary leading-[1.5] m-0">
          {para}
        </p>
      ))}
    </div>
  );
}

function ArrowUpRightIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M5 11L11 5M11 5H6M11 5V10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SparklesIcon({ className }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 17 17" fill="none" aria-hidden="true" className={className}>
      <path
        d="M8.5 2L9.7 5.8L13.5 7L9.7 8.2L8.5 12L7.3 8.2L3.5 7L7.3 5.8L8.5 2Z"
        fill="currentColor"
      />
      <path
        d="M13.5 10L14 11.5L15.5 12L14 12.5L13.5 14L13 12.5L11.5 12L13 11.5L13.5 10Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** Split a body or summary blob into paragraphs.
 *  Primary split: blank lines. Fallback: group sentences into ~3-sentence
 *  paragraphs so a single-blob response is still readable. */
function splitParagraphs(text: string): string[] {
  const blocks = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  if (blocks.length > 1) return blocks;

  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length <= 3) return [text.trim()];
  const groups: string[] = [];
  for (let i = 0; i < sentences.length; i += 3) {
    groups.push(sentences.slice(i, i + 3).join(' '));
  }
  return groups;
}
