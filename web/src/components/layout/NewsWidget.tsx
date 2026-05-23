import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { useGateway } from '@/hooks/useGateway';
import { PulsingDots } from '@/components/chat/PulsingDots';
import { useFeedCounts } from '@/components/layout/FeedCountsProvider-internals';
import { NewsRow } from './NewsRow';
import { NewsDetailDrawer } from './NewsDetailDrawer';
import { NewsArticlePanel } from './NewsArticlePanel';
import { NewsSourcesModal } from './NewsSourcesModal';
import { NewsFilterModal } from './FilterPromptModal';
import { WidgetHeaderMenu } from './WidgetHeaderMenu';
import { useNewsArticles } from './use-news-articles';
import { SOURCE_NAMES } from './news-utils';
import newsMicroscope from '@/assets/news-microscope.svg';
import newsFilter from '@/assets/news-filter.svg';
import menuFilter from '@/assets/menu-filter.svg';
import menuSources from '@/assets/menu-sources.svg';

const NEWS_PINK = '#ff61ff';

/** News widget shell — Figma node 305:4037. Bordered card with a
 *  surface-raised header containing the microscope icon, "NEWS" label,
 *  and a filter button. */
interface NewsShellProps {
  onOpenFilter: () => void;
  onOpenSources: () => void;
  children: ReactNode;
}

function NewsShell({ onOpenFilter, onOpenSources, children }: NewsShellProps) {
  return (
    <div className="overflow-clip flex flex-col flex-1 min-h-0 first:pt-8">
      <div className="flex h-10 items-center justify-between py-1 px-4 shrink-0 bg-surface-raised border-y border-border-subtle">
        <div className="flex items-center gap-2">
          <img src={newsMicroscope} alt="" aria-hidden="true" width={22} height={22} className="block" />
          <span className="text-body-md-semibold text-text-primary leading-[1.5]">NEWS</span>
        </div>
        <WidgetHeaderMenu
          triggerLabel="News options"
          menuLabel="News options"
          trigger={<img src={newsFilter} alt="" aria-hidden="true" width={15} height={15} className="block" />}
          items={[
            {
              key: 'filter',
              icon: <img src={menuFilter} alt="" aria-hidden="true" width={16} height={16} className="block" />,
              label: 'News Filter',
              onSelect: onOpenFilter,
            },
            {
              key: 'sources',
              icon: <img src={menuSources} alt="" aria-hidden="true" width={16} height={16} className="block" />,
              label: 'News Sources',
              onSelect: onOpenSources,
            },
          ]}
        />
      </div>
      {children}
    </div>
  );
}

export function NewsWidget() {
  const { request } = useGateway();
  const { newsCount, setNewsCount } = useFeedCounts();
  const {
    articles,
    total,
    hasFetched,
    hasMore,
    loadingMore,
    loadMore,
    setArticlesDirect,
    setTotal,
  } = useNewsArticles(newsCount);

  const [detailArticleId, setDetailArticleId] = useState<string | null>(null);
  const [panelArticleId, setPanelArticleId] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [sourcesModalOpen, setSourcesModalOpen] = useState(false);
  const [filterModalOpen, setFilterModalOpen] = useState(false);
  const [narrowViewport, setNarrowViewport] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(max-width: 1207px)').matches;
  });
  const menuRef = useRef<HTMLDivElement>(null);

  // <1208px: compact mode — panel hides the drawer and takes its slot.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 1207px)');
    const handler = (e: MediaQueryListEvent) => setNarrowViewport(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Mirror the article total into the shared FeedCounts context so the
  // sidebar pill stays in sync as articles arrive/dismiss.
  useEffect(() => {
    setNewsCount(total);
  }, [total, setNewsCount]);

  // Row click owns both the drawer-open state (so closing the panel later
  // returns the user to the list) and the panel article. Clicking the same
  // row again is a no-op so the panel doesn't re-mount and re-fetch.
  const openPanel = useCallback((id: string) => {
    setDetailArticleId(id);
    setPanelArticleId((prev) => (prev === id ? prev : id));
  }, []);
  const closeBoth = useCallback(() => {
    setPanelArticleId(null);
    setDetailArticleId(null);
  }, []);

  const dismissArticle = useCallback((articleId: string) => {
    request('trading.news.dismiss', { articleId }).catch(() => {});
    setArticlesDirect((prev) => prev.filter((a) => a.id !== articleId));
    setTotal((t) => Math.max(0, t - 1));
    if (detailArticleId === articleId) setDetailArticleId(null);
    if (panelArticleId === articleId) setPanelArticleId(null);
  }, [request, detailArticleId, panelArticleId, setArticlesDirect, setTotal]);

  // Close article menu on click outside
  useEffect(() => {
    if (!menuOpenId) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpenId(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpenId]);

  const visible = sourceFilter
    ? articles.filter((a) => a.sourceId === sourceFilter)
    : articles;

  const showInitialLoading = !hasFetched && articles.length === 0;
  const detailArticle = detailArticleId
    ? articles.find((a) => a.id === detailArticleId) ?? null
    : null;
  const panelArticle = panelArticleId
    ? articles.find((a) => a.id === panelArticleId) ?? null
    : null;

  const newsIcon = (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={NEWS_PINK} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2" />
      <path d="M18 14h-8" /><path d="M15 18h-5" /><path d="M10 6h8v4h-8V6Z" />
    </svg>
  );

  return (
    <>
      <NewsShell
        onOpenFilter={() => setFilterModalOpen(true)}
        onOpenSources={() => setSourcesModalOpen(true)}
      >
        {showInitialLoading ? (
          <div className="px-4 py-6 flex flex-col items-center gap-2.5">
            <div className="size-[38px] rounded-[4px] bg-[rgba(255,97,255,0.08)] border border-[rgba(255,97,255,0.2)] flex items-center justify-center">
              {newsIcon}
            </div>
            <div className="flex flex-col items-center gap-1 leading-[1.5]">
              <span className="text-body-md-semibold text-text-primary">
                {articles.length === 0 ? 'Fetching latest news…' : 'Summarizing with AI…'}
              </span>
              <span className="text-body-sm text-text-secondary text-center">AI is scanning and summarizing crypto news for you</span>
            </div>
            <PulsingDots color={NEWS_PINK} />
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto pb-2">
            {sourceFilter && (
              <div className="px-4 pt-2 pb-1 flex gap-1">
                <button
                  className="bg-transparent border border-border-subtle rounded px-2 py-0.5 text-label-sm text-text-secondary cursor-pointer hover:border-border-default"
                  onClick={() => setSourceFilter(null)}
                >{SOURCE_NAMES[sourceFilter] ?? sourceFilter} ×</button>
              </div>
            )}
            {visible.length === 0 ? (
              <div className="px-4 py-6 flex flex-col items-center gap-2.5">
                <div className="size-[38px] rounded-[4px] bg-[rgba(255,97,255,0.08)] border border-[rgba(255,97,255,0.2)] flex items-center justify-center">
                  {newsIcon}
                </div>
                <div className="flex flex-col items-center gap-1 leading-[1.5]">
                  <span className="text-body-md-semibold text-text-primary">{sourceFilter ? `No ${SOURCE_NAMES[sourceFilter] ?? sourceFilter} news` : 'No news available'}</span>
                  <span className="text-body-sm text-text-secondary text-center">New articles will appear here automatically</span>
                </div>
              </div>
            ) : (
              visible.map((article, idx) => (
                <NewsRow
                  key={article.id}
                  article={article}
                  menuOpen={menuOpenId === article.id}
                  isLast={idx === visible.length - 1 && !hasMore}
                  menuRef={menuRef}
                  onOpen={openPanel}
                  onToggleMenu={(id) => setMenuOpenId((prev) => prev === id ? null : id)}
                  onDismiss={dismissArticle}
                  onFilterSource={setSourceFilter}
                  onCloseMenu={() => setMenuOpenId(null)}
                />
              ))
            )}
            {!showInitialLoading && hasMore && visible.length > 0 && (
              <div className="h-11 flex items-center justify-center py-3">
                <button
                  type="button"
                  disabled={loadingMore}
                  className={
                    'bg-transparent border-none p-0 text-body-sm text-text-secondary inline-flex items-center gap-2 transition-colors duration-fast ease-out '
                    + (loadingMore
                      ? 'text-[#ff61ff] cursor-default'
                      : 'cursor-pointer hover:text-text-primary focus-visible:text-text-primary')
                  }
                  onClick={loadMore}
                >
                  {loadingMore ? (
                    <><span>Loading</span><PulsingDots color={NEWS_PINK} /></>
                  ) : 'Load more'}
                </button>
              </div>
            )}
          </div>
        )}
      </NewsShell>
      <NewsSourcesModal open={sourcesModalOpen} onClose={() => setSourcesModalOpen(false)} />
      <NewsFilterModal open={filterModalOpen} onClose={() => setFilterModalOpen(false)} />
      <NewsDetailDrawer
        open={detailArticle !== null && !(narrowViewport && panelArticleId !== null)}
        articles={visible}
        selectedId={panelArticleId}
        onClose={closeBoth}
        onOpenPanel={openPanel}
        onDismiss={dismissArticle}
        onFilterSource={setSourceFilter}
        onOpenFilter={() => setSourcesModalOpen(true)}
      />
      {panelArticle && (
        <NewsArticlePanel
          key={panelArticle.id}
          article={panelArticle}
          compact={narrowViewport}
          onClose={closeBoth}
        />
      )}
    </>
  );
}
