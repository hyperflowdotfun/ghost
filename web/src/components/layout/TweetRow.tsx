import { type ReactElement } from 'react';
import {
  type Tweet,
  COIN_CHIP_CLS,
  MENU_ITEM_CLS,
  TWEET_CONTENT_LIMIT,
  fmtNum,
  parseRetweet,
  timeAgo,
  tokenizeContent,
} from './tweet-utils';

type EngagementKind = 'reply' | 'retweet' | 'heart' | 'views';

const ENGAGEMENT_PATHS: Record<EngagementKind, ReactElement> = {
  reply: (
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
  ),
  retweet: (
    <>
      <path d="M17 1l4 4-4 4" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <path d="M7 23l-4-4 4-4" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </>
  ),
  heart: (
    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
  ),
  views: (
    <>
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </>
  ),
};

function EngagementItem({
  kind, count, showZero = false,
}: { kind: EngagementKind; count?: number; showZero?: boolean }) {
  const shouldShowCount = showZero || (typeof count === 'number' && count > 0);
  return (
    <span className="inline-flex items-center gap-1 text-caption text-[var(--color-text-secondary)]">
      <svg
        width={14} height={14} viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth={1.6}
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      >
        {ENGAGEMENT_PATHS[kind]}
      </svg>
      {shouldShowCount && <span>{fmtNum(count ?? 0)}</span>}
    </span>
  );
}

function TweetContent({ text }: { text: string }) {
  const tokens = tokenizeContent(text);
  return (
    <>
      {tokens.map((tok, i) => {
        if (tok.kind === 'url') {
          return (
            <span
              key={i}
              className="text-[#00b8ff] underline cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                window.open(tok.value, '_blank', 'noopener,noreferrer');
              }}
            >{tok.value}</span>
          );
        }
        if (tok.kind === 'cashtag') {
          return (
            <span key={i} className="text-[var(--color-brand-default)] font-semibold">{tok.value}</span>
          );
        }
        if (tok.kind === 'mention') {
          return (
            <span key={i} className="text-[#1d9bf0]">{tok.value}</span>
          );
        }
        return <span key={i}>{tok.value}</span>;
      })}
    </>
  );
}

function RetweetChip({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-caption text-[var(--color-text-secondary)] mb-1">
      <svg
        width={12} height={12} viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth={1.6}
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      >
        <path d="M17 1l4 4-4 4" />
        <path d="M3 11V9a4 4 0 0 1 4-4h14" />
        <path d="M7 23l-4-4 4-4" />
        <path d="M21 13v2a4 4 0 0 1-4 4H3" />
      </svg>
      <span>{label} Retweeted</span>
    </div>
  );
}

interface TweetRowProps {
  tweet: Tweet;
  now: number;
  isExpanded: boolean;
  menuOpen: boolean;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onToggleExpand: (id: string) => void;
  onToggleMenu: (id: string) => void;
  onDismiss: (id: string) => void;
  onCloseMenu: () => void;
}

export function TweetRow({
  tweet: t, now, isExpanded, menuOpen, menuRef,
  onToggleExpand, onToggleMenu, onDismiss, onCloseMenu,
}: TweetRowProps) {
  const retweet = parseRetweet(t.content);
  const contentSource = retweet ? retweet.content : t.content;
  const isLong = contentSource.length > TWEET_CONTENT_LIMIT;
  const shown = (isLong && !isExpanded)
    ? contentSource.slice(0, TWEET_CONTENT_LIMIT).trimEnd() + '…'
    : contentSource;
  const displayName = t.displayName || t.username;
  const retweetLabel = retweet
    ? (displayName || `@${t.username}`)
    : null;

  const openOriginal = () => {
    if (t.url) window.open(t.url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div
      role={t.url ? 'link' : undefined}
      tabIndex={t.url ? 0 : -1}
      onClick={t.url ? openOriginal : undefined}
      onKeyDown={(e) => {
        if (!t.url) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openOriginal();
        }
      }}
      className={
        'relative px-4 py-3 border-b border-[rgba(32,36,54,0.6)] transition-colors duration-fast ease-out hover:bg-white/[0.02] '
        + (t.url ? 'cursor-pointer focus-visible:bg-white/[0.03] focus-visible:outline-none' : '')
      }
      style={{ backgroundImage: 'linear-gradient(180deg, rgba(1,1,1,0) 21.552%, var(--color-surface-canvas, #0a0a0b) 88.233%)' }}
    >
      {retweetLabel && <RetweetChip label={retweetLabel} />}
      <div className="flex items-center gap-2 mb-1.5">
        <div className="flex flex-col min-w-0 flex-1">
          <span
            className="text-body-sm-medium text-[var(--color-text-primary)] leading-[1.2] whitespace-nowrap overflow-hidden text-ellipsis"
            title={displayName}
          >{displayName}</span>
          <span className="text-caption text-[var(--color-text-secondary)] leading-[1.3] whitespace-nowrap overflow-hidden text-ellipsis">
            @{t.username} · {timeAgo(t.publishedAt, now)}
          </span>
        </div>
        <button
          className="ml-auto bg-transparent border-none text-[var(--color-text-secondary)] text-label-lg cursor-pointer leading-none flex-shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-[4px] -mr-1 transition-colors duration-fast ease-out hover:text-[var(--color-text-primary)] hover:bg-white/[0.05] focus-visible:text-[var(--color-text-primary)]"
          title="More"
          onClick={(e) => { e.stopPropagation(); onToggleMenu(t.id); }}
        >⋯</button>
      </div>
      {menuOpen && (
        <div
          ref={menuRef}
          className="absolute right-2 top-10 z-50 bg-[var(--color-surface-base)] border border-[var(--color-border-default)] rounded-[6px] shadow-[0_4px_16px_rgba(0,0,0,0.6)] min-w-[170px] py-1"
        >
          <button
            className={MENU_ITEM_CLS}
            onClick={() => { onDismiss(t.id); onCloseMenu(); }}
          >Dismiss</button>
          {t.url && (
            <button
              className={MENU_ITEM_CLS}
              onClick={() => { window.open(t.url!, '_blank', 'noopener,noreferrer'); onCloseMenu(); }}
            >Open on X ↗</button>
          )}
        </div>
      )}
      <div className="text-body-sm text-[var(--color-text-primary)] whitespace-pre-wrap break-words"><TweetContent text={shown} /></div>
      {isLong && (
        <button
          className="bg-transparent border-none p-0 mt-1 text-footnote text-[#00b8ff] cursor-pointer transition-colors duration-fast ease-out hover:text-[var(--color-brand-hover)] focus-visible:text-[var(--color-brand-hover)]"
          onClick={(e) => { e.stopPropagation(); onToggleExpand(t.id); }}
        >{isExpanded ? 'Read less' : 'Read more'}</button>
      )}
      {t.coins.length > 0 && (
        <div className="flex gap-1.5 flex-wrap mt-1.5">
          {t.coins.slice(0, 5).map((coin) => (
            <span key={coin} className={COIN_CHIP_CLS}>{coin}</span>
          ))}
        </div>
      )}
      <div className="flex gap-5 mt-2">
        <EngagementItem kind="reply" count={t.stats?.replies} />
        <EngagementItem kind="retweet" count={t.stats?.retweets} />
        <EngagementItem kind="heart" count={t.stats?.likes} />
        <EngagementItem kind="views" count={t.stats?.views ?? 0} showZero />
        {t.url && (
          <button
            onClick={(e) => { e.stopPropagation(); window.open(t.url!, '_blank', 'noopener,noreferrer'); }}
            title="View on X"
            aria-label="View on X"
            className="ml-auto bg-transparent border-none p-0 text-[var(--color-text-secondary)] cursor-pointer inline-flex items-center transition-colors duration-fast ease-out hover:text-[var(--color-text-primary)] focus-visible:text-[var(--color-text-primary)]"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
