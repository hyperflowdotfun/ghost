/**
 * News source management tool — list, enable, disable, add custom RSS, remove.
 * News search tool — query local articles cache.
 */

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { defineTool } from "./types.js";
import type { NewsService } from "../../services/news.js";
import { NEWS_SOURCE_PRESETS } from "../../services/news-types.js";
import { textResult, errorResult, getErrorMessage } from "../../helpers/result.js";

const presetMap = new Map(NEWS_SOURCE_PRESETS.map((p) => [p.sourceId, p]));

/** Resolve a user-provided name/id to a source in the DB. */
function isPresetSource(sourceId: string): boolean {
  return NEWS_SOURCE_PRESETS.some((p) => p.sourceId === sourceId);
}

function findSource(
  input: string,
  sources: Array<{ sourceId: string; name: string; customUrl: string | null }>,
): { sourceId: string; isCustom: boolean } | null {
  const lower = input.toLowerCase().trim();

  // Exact match by sourceId
  const exact = sources.find((s) => s.sourceId === lower);
  if (exact) return { sourceId: exact.sourceId, isCustom: !isPresetSource(exact.sourceId) };

  // Exact match by name (from DB)
  const byName = sources.find((s) => s.name.toLowerCase() === lower);
  if (byName) return { sourceId: byName.sourceId, isCustom: !isPresetSource(byName.sourceId) };

  // Partial match on sourceId or name
  const partial = sources.find((s) => s.sourceId.includes(lower) || s.name.toLowerCase().includes(lower));
  if (partial) return { sourceId: partial.sourceId, isCustom: !isPresetSource(partial.sourceId) };

  return null;
}

function displayName(sourceId: string): string {
  return presetMap.get(sourceId)?.name ?? sourceId;
}

export function createNewsSourceTools(news: NewsService): AgentTool[] {
  return [
    defineTool({
      name: "ghost_news_sources",
      label: "News Sources",
      description:
        "Manage news sources. Actions: 'list' (show all sources with status), " +
        "'enable'/'disable' (toggle a source by name or ID), " +
        "'add' (add a custom RSS feed — requires url and name), " +
        "'remove' (remove a custom source).",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("list"),
          Type.Literal("enable"),
          Type.Literal("disable"),
          Type.Literal("add"),
          Type.Literal("remove"),
        ]),
        sourceId: Type.Optional(Type.String({ description: "Source name or ID (e.g. 'coindesk', 'Bitcoin Magazine')" })),
        url: Type.Optional(Type.String({ description: "RSS feed URL — only for 'add' action." })),
        name: Type.Optional(Type.String({ description: "Display name — only for 'add' action." })),
      }),
      async execute(_toolCallId: string, params: unknown) {
        try {
          const p = params as { action: string; sourceId?: string; url?: string; name?: string };
          const sources = news.getSources();

          switch (p.action) {
            case "list": {
              if (sources.length === 0) return textResult("No news sources configured.");
              const lines = ["News Sources", "─".repeat(40)];
              for (const src of sources) {
                const name = src.name || displayName(src.sourceId);
                const type = presetMap.get(src.sourceId)?.type ?? (src.customUrl ? "custom" : "rss");
                const status = src.enabled ? "✓ enabled" : "✗ disabled";
                lines.push(`${status}  ${name}  [${type}]`);
              }
              return textResult(lines.join("\n"));
            }

            case "enable": {
              if (!p.sourceId) return errorResult("Which source? Provide a name or ID.");
              const found = findSource(p.sourceId, sources);
              if (!found) {
                return errorResult(
                  `Unknown source "${p.sourceId}". Use 'list' to see available sources, or 'add' with a URL to add a custom RSS feed.`,
                );
              }
              news.toggleSource(found.sourceId, true);
              return textResult(`Enabled ${displayName(found.sourceId)}. News will update within a few minutes.`);
            }

            case "disable": {
              if (!p.sourceId) return errorResult("Which source? Provide a name or ID.");
              const found = findSource(p.sourceId, sources);
              if (!found) {
                return errorResult(`Unknown source "${p.sourceId}". Use 'list' to see available sources.`);
              }
              news.toggleSource(found.sourceId, false);
              const enabledCount = sources.filter((s) => s.sourceId !== found.sourceId && s.enabled).length;
              const warning = enabledCount === 0 ? "\n⚠ No sources enabled — news feed will be empty." : "";
              return textResult(`Disabled ${displayName(found.sourceId)}.${warning}`);
            }

            case "add": {
              if (!p.url) return errorResult("Provide a URL for the RSS feed.");
              const name = p.name ?? p.url;
              const result = news.addCustomRss(p.url, name);
              if (!result.ok) return errorResult(result.error ?? "Failed to add source.");
              return textResult(`Added custom RSS source "${name}". It will start fetching within a few minutes.`);
            }

            case "remove": {
              if (!p.sourceId) return errorResult("Which source to remove? Provide the name or ID.");
              const found = findSource(p.sourceId, sources);
              if (!found) return errorResult(`Source "${p.sourceId}" not found.`);
              if (!found.isCustom) {
                return errorResult(`${displayName(found.sourceId)} is a preset source — you can disable it but not remove it.`);
              }
              news.removeCustomSource(found.sourceId);
              return textResult(`Removed ${displayName(found.sourceId)}.`);
            }

            default:
              return errorResult(`Unknown action "${p.action}". Use: list, enable, disable, add, remove.`);
          }
        } catch (e: unknown) {
          return errorResult(getErrorMessage(e));
        }
      },
    }),
  ];
}

export function createNewsSearchTools(news: NewsService): AgentTool[] {
  return [
    defineTool({
      name: "ghost_news_search",
      label: "News Search",
      description:
        "Search crawled news articles (RSS/API sources). " +
        "Use this BEFORE web_search — it has real-time local data. " +
        "No params returns recent items. Filter by keyword or coins. " +
        "For tweets, use ghost_tweets_search.",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "Keyword to search in title and content" })),
        coins: Type.Optional(Type.Array(Type.String(), { description: "Filter by coin symbols, e.g. ['BTC', 'ETH']" })),
        limit: Type.Optional(Type.Number({ description: "Max results. Default 50, max 100." })),
      }),
      async execute(_toolCallId: string, params: unknown) {
        try {
          const p = params as { query?: string; coins?: string[]; limit?: number };
          const articles = news.searchArticles(p);
          if (articles.length === 0) return textResult("No matching news found.");

          const lines = [`News (${articles.length})`, "─".repeat(50)];
          for (const a of articles) {
            const ago = timeAgo(a.publishedAt);
            const coins = a.coins.length > 0 ? ` [${a.coins.join(", ")}]` : "";
            lines.push(`[${a.sourceId}] ${a.title}${coins} (${ago})`);
            lines.push(a.summary ?? a.description);
            lines.push(`  ${a.url}`);
            lines.push("");
          }
          return textResult(lines.join("\n"));
        } catch (e: unknown) {
          return errorResult(getErrorMessage(e));
        }
      },
    }),
  ];
}

function timeAgo(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
