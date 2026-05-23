import type { NewsArticle } from "../../services/news-types.js";
import type { NewsEvent } from "../events.js";

export interface NewsDetectorInput {
  articles: ReadonlyArray<NewsArticle>;
  priorEmittedIds: ReadonlySet<string>;
  nowMs: number;
}

export interface NewsDetectorResult {
  events: NewsEvent[];
  emittedIds: string[];
}

export function detectNews(input: NewsDetectorInput): NewsDetectorResult {
  const events: NewsEvent[] = [];
  const emittedIds: string[] = [];
  const seenThisTick = new Set<string>();

  for (const article of input.articles) {
    if (input.priorEmittedIds.has(article.id)) continue;
    // Defensive — SQL shouldn't return duplicates in one batch, but cheap
    // insurance against future query changes.
    if (seenThisTick.has(article.id)) continue;
    // summary is generated on demand; description is the always-present fallback.
    const summaryText = article.summary ?? article.description;
    if (!summaryText || summaryText.length === 0) continue;

    events.push({
      type: "news",
      detectedAt: input.nowMs,
      articleId: article.id,
      title: article.title,
      summary: summaryText,
      source: article.sourceId,
      url: article.url,
      publishedAt: article.publishedAt * 1000,
      importance: article.importance,
      coins: [...article.coins],
    });
    emittedIds.push(article.id);
    seenThisTick.add(article.id);
  }

  return { events, emittedIds };
}
