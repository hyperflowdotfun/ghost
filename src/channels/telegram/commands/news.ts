/**
 * /news — recent crypto news, paginated per-chat so each call drains
 * different articles instead of looping the same top 5.
 *
 * Modes:
 *   /news            → top 5 articles this chat hasn't seen yet (drain mode).
 *   /news latest     → top 20 newest articles regardless of seen state.
 *   /news <SYMBOL>   → top 5 unseen articles tagged with <SYMBOL>.
 *
 * Per-article layout (2 lines/article):
 *   N. **[<Source> · <time ago>] <Title>**
 *   <full summary>
 *
 * Kicker brackets + title are bundled into ONE bold tappable link via
 * `wrapLink` (sentinel-wrapped HTML, bypassing markdown's `[label](url)`
 * syntax which stops at the first `]`).
 */

import { wrapLink } from "../format/markdown.js";
import type { CommandHandler } from "./types.js";
import { escapeMarkdownEmphasis } from "./types.js";

const DRAIN_LIMIT = 5;
const LATEST_LIMIT = 20;

const EMPTY_DRAIN_HINT = "No new articles. Use `/news latest` to browse the 20 most recent.";
const EMPTY_LATEST = "No news available.";

function timeAgo(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function fallbackSourceName(sourceId: string): string {
  if (sourceId.length === 0) return sourceId;
  return sourceId.charAt(0).toUpperCase() + sourceId.slice(1);
}

interface ParsedArgs {
  mode: "drain" | "latest";
  symbol: string | null;
}

function parseArgs(args: readonly string[]): ParsedArgs | string {
  if (args.length === 0) return { mode: "drain", symbol: null };
  if (args.length > 1) {
    return "Usage: `/news`, `/news latest`, or `/news <symbol>` — e.g. `/news BTC`";
  }
  const a = args[0]!.toLowerCase();
  if (a === "latest") return { mode: "latest", symbol: null };
  return { mode: "drain", symbol: args[0]!.toUpperCase() };
}

export const newsHandler: CommandHandler = async ({ chatId, newsService }, args) => {
  const parsed = parseArgs(args);
  if (typeof parsed === "string") return parsed;

  let articles;
  let scope: string | null = null;
  if (parsed.mode === "latest") {
    articles = newsService.getArticles({ limit: LATEST_LIMIT });
    if (articles.length === 0) return EMPTY_LATEST;
  } else {
    scope = parsed.symbol ? `symbol:${parsed.symbol}` : "global";
    articles = newsService.getUnshownArticles(chatId, scope, {
      limit: DRAIN_LIMIT,
      symbol: parsed.symbol ?? undefined,
    });
    if (articles.length === 0) {
      return parsed.symbol
        ? `No new ${parsed.symbol} articles. Use \`/news latest\` to browse.`
        : EMPTY_DRAIN_HINT;
    }
  }

  const sourceNames = newsService.getSourceNames();
  const headerScope = parsed.mode === "latest"
    ? "latest"
    : parsed.symbol ?? "recent";
  const lines: string[] = [`**News · ${headerScope} · ${articles.length} articles**`, ""];

  articles.forEach((a, i) => {
    const title = escapeMarkdownEmphasis(a.title).replace(/[[\]]/g, "");
    const summary = escapeMarkdownEmphasis(a.summary ?? a.description);
    const sourceName = sourceNames.get(a.sourceId) ?? fallbackSourceName(a.sourceId);
    const label = `[${sourceName} · ${timeAgo(a.publishedAt)}] ${title}`;
    lines.push(`${i + 1}. **${wrapLink(a.url, label)}**`);
    lines.push(summary);
    lines.push("");
  });

  if (parsed.mode === "drain" && scope !== null) {
    newsService.markArticlesShown(chatId, scope, articles.map((a) => a.id));
  }

  return lines.join("\n").trimEnd();
};
