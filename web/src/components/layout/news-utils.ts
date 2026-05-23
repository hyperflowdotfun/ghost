// Types + constants shared between NewsWidget + NewsRow. Pure helpers
// that don't need React — kept out of NewsRow.tsx so fast-refresh works
// cleanly on the component file.

export interface NewsArticle {
  id: string;
  sourceId: string;
  url: string;
  title: string;
  description: string;
  imageUrl: string | null;
  coins: string[];
  importance: 'urgent' | 'important' | 'reference';
  publishedAt: number;
  body: string | null;
  summary: string | null;
}

export const SOURCE_NAMES: Record<string, string> = {
  cryptopanic: 'CryptoPanic', coindesk: 'CoinDesk', theblock: 'The Block',
  decrypt: 'Decrypt', cointelegraph: 'CoinTelegraph', coingecko: 'CoinGecko',
};

// Public hosts for each known source. Used to derive a favicon URL via
// Google's s2 favicon service so avatars show real brand marks instead
// of an initials disk. Custom/user-added RSS sources aren't in this
// table; they fall back to the initials disk automatically.
export const SOURCE_DOMAINS: Record<string, string> = {
  cryptopanic: 'cryptopanic.com',
  coindesk: 'coindesk.com',
  theblock: 'theblock.co',
  decrypt: 'decrypt.co',
  cointelegraph: 'cointelegraph.com',
  coingecko: 'coingecko.com',
};

export function sourceLogoUrl(sourceId: string): string | null {
  const domain = SOURCE_DOMAINS[sourceId];
  if (!domain) return null;
  return `https://www.google.com/s2/favicons?sz=64&domain=${domain}`;
}

export const COIN_CHIP_CLS =
  'h-[14px] px-[5px] rounded text-footnote leading-none inline-flex items-center bg-[var(--color-brand-subtle)] text-[var(--color-brand-default)] border border-[var(--color-brand-soft)] box-border';

export const MORE_CHIP_CLS =
  'h-[14px] px-[5px] rounded text-footnote leading-none inline-flex items-center text-[var(--color-text-secondary)] bg-white/[0.03] border border-white/[0.06] box-border';

export const MENU_ITEM_CLS =
  'flex items-center gap-2 w-full bg-transparent border-none px-3.5 py-2.5 text-body-sm text-[var(--color-text-primary)] cursor-pointer text-left transition-colors duration-fast ease-out hover:bg-white/[0.05] focus-visible:bg-white/[0.05]';

// Re-export the tweet-utils version (a superset — it accepts an optional
// nowMs). Having two copies of the same function is begging for drift.
export { timeAgo } from './tweet-utils';
