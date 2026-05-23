/**
 * News helper utilities — text processing, dedup tokenization, HTML stripping.
 */

import { STOPWORDS } from "./news-types.js";
import type { NewsArticle, NewsSource, Importance } from "./news-types.js";

/** Map a raw SQLite row to a typed NewsSource. */
export function mapSource(row: Record<string, unknown>): NewsSource {
  return {
    sourceId: row.source_id as string,
    name: (row.name as string) || (row.source_id as string),
    enabled: row.enabled as number,
    apiKey: (row.api_key as string) ?? null,
    customUrl: (row.custom_url as string) ?? null,
    addedAt: row.added_at as number,
  };
}

/** Map a raw SQLite row to a typed NewsArticle. */
export function mapRow(row: Record<string, unknown>): NewsArticle {
  return {
    id: row.id as string,
    sourceId: row.source_id as string,
    externalId: row.external_id as string,
    url: row.url as string,
    title: row.title as string,
    description: row.description as string,
    imageUrl: (row.image_url as string) ?? null,
    coins: JSON.parse((row.coins as string) || "[]") as string[],
    importance: row.importance as Importance,
    publishedAt: row.published_at as number,
    fetchedAt: row.fetched_at as number,
    expiresAt: row.expires_at as number,
    body: (row.body as string) ?? null,
    summary: (row.summary as string) ?? null,
    aiRelevant: row.ai_relevant === null || row.ai_relevant === undefined ? null : (row.ai_relevant as number) === 1,
    aiDuplicateOf: (row.ai_duplicate_of as string) ?? null,
  };
}

/** Tokenize text for dedup comparison — lowercase, strip punctuation, remove stopwords. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/** Compute overlap ratio between two token sets (Jaccard-like on smaller set). */
export function tokenOverlap(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const t of setA) {
    if (setB.has(t)) shared++;
  }
  const smaller = Math.min(setA.size, setB.size);
  return smaller === 0 ? 0 : shared / smaller;
}

/** Strip HTML to plain text — removes scripts, styles, tags, decodes entities. */
export function stripHtmlToText(html: string): string {
  // Remove script/style blocks
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  // Remove tags
  text = text.replace(/<[^>]+>/g, " ");
  // Decode common entities
  text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  // Collapse whitespace
  text = text.replace(/\s+/g, " ").trim();
  return text;
}
