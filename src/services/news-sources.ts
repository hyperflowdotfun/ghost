/**
 * News source adapters — fetch articles from CryptoPanic, RSS feeds, CoinGecko.
 */

import { COIN_MAP, NEWS_SOURCE_PRESETS } from "./news-types.js";
import { validateUrlSafety } from "../helpers/url-safety.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface RawArticle {
  externalId: string;
  url: string;
  title: string;
  description: string;
  imageUrl?: string;
  coins: string[];
  publishedAt: number;
  importanceSignal?: number;
  body?: string | null;
  metadata?: Record<string, unknown>;
}

export interface SourceAdapter {
  readonly sourceId: string;
  fetch(apiKey?: string, customUrl?: string): Promise<RawArticle[]>;
}

// ---------------------------------------------------------------------------
// Coin tagging
// ---------------------------------------------------------------------------

/** Build a regex for each coin symbol from COIN_MAP aliases. */
const coinPatterns: Array<{ symbol: string; regex: RegExp }> = Object.entries(COIN_MAP).map(
  ([symbol, aliases]) => ({
    symbol,
    regex: new RegExp(`\\b(?:${aliases.map(escapeRegex).join("|")})\\b`, "i"),
  }),
);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function tagCoins(text: string): string[] {
  const matches: string[] = [];
  for (const { symbol, regex } of coinPatterns) {
    if (regex.test(text)) matches.push(symbol);
  }
  return matches;
}

// ---------------------------------------------------------------------------
// CryptoPanic adapter
// ---------------------------------------------------------------------------

export class CryptoPanicAdapter implements SourceAdapter {
  readonly sourceId = "cryptopanic";

  async fetch(apiKey?: string): Promise<RawArticle[]> {
    if (!apiKey) return [];
    const url = `https://cryptopanic.com/api/v1/posts/?auth_token=${apiKey}&filter=hot&public=true`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`CryptoPanic: HTTP ${res.status}`);
    const data = (await res.json()) as {
      results?: Array<{
        id: number;
        url: string;
        title: string;
        body?: string;
        currencies?: Array<{ code: string }>;
        votes?: { important?: number };
        published_at?: string;
      }>;
    };
    return (data.results ?? []).map((item) => {
      const coins = item.currencies?.map((c) => c.code.toUpperCase()) ?? tagCoins(item.title);
      return {
        externalId: String(item.id),
        url: item.url,
        title: item.title,
        description: item.body ?? "",
        coins,
        publishedAt: item.published_at ? Math.floor(new Date(item.published_at).getTime() / 1000) : Math.floor(Date.now() / 1000),
        importanceSignal: item.votes?.important ?? 0,
      };
    });
  }
}

// ---------------------------------------------------------------------------
// RSS adapter (generic, no external library)
// ---------------------------------------------------------------------------

export class RssAdapter implements SourceAdapter {
  constructor(readonly sourceId: string, private readonly defaultUrl?: string) {}

  async fetch(_apiKey?: string, customUrl?: string): Promise<RawArticle[]> {
    const url = customUrl ?? this.defaultUrl;
    if (!url) return [];
    await validateUrlSafety(url);
    // redirect:"manual" prevents SSRF via 3xx to internal addresses.
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "manual" });
    // Redirects are not followed: treat as a fetch failure and return empty.
    if (res.status >= 300 && res.status < 400) return [];
    if (!res.ok) throw new Error(`RSS ${this.sourceId}: HTTP ${res.status}`);
    const xml = await res.text();
    return parseRss(xml, this.sourceId);
  }
}

/**
 * Extract the channel/feed title from an RSS/Atom XML blob.
 * Returns null when the title element is absent or empty.
 */
export function parseFeedTitle(xml: string): string | null {
  // Try <title> immediately inside <channel> or as first <title> in feed
  const match = xml.match(/<(?:channel|feed)[^>]*>[\s\S]*?<title[^>]*>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/title>/i);
  if (!match) return null;
  const raw = (match[1] ?? match[2] ?? "").trim();
  return raw.length > 0 ? raw : null;
}

/**
 * Extract the count of valid items from an RSS/Atom XML blob.
 * Used by RssDiscoveryService to validate candidate feeds without full parsing.
 */
export function parseRssItemCount(xml: string): number {
  // Atom feeds use <entry> instead of <item>
  const itemRegex = /<(?:item|entry)[^>]*>[\s\S]*?<\/(?:item|entry)>/gi;
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[0];
    // Must have a title and link/id to be valid
    const hasTitle = /<title[^>]*>[\s\S]*?<\/title>/i.test(block);
    const hasLink = /<(?:link|id)[^>]*>[\s\S]*?<\/(?:link|id)>/i.test(block) ||
      /<link\s[^>]*href\s*=/i.test(block);
    if (hasTitle && hasLink) count++;
  }
  return count;
}

/** Minimal RSS/Atom parser using regex — extracts <item> (RSS) and <entry> (Atom) blocks. */
export function parseRss(xml: string, sourceId: string): RawArticle[] {
  const items: RawArticle[] = [];
  // Match both RSS <item> and Atom <entry>
  const itemRegex = /<(item|entry)[^>]*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(xml)) !== null) {
    const isAtom = match[1].toLowerCase() === "entry";
    const block = match[2];
    const title = extractTag(block, "title");
    // Atom: link is <link href="..."/> self-closing; RSS: <link>url</link>
    const link = isAtom ? extractAtomLink(block) : extractTag(block, "link");
    // Atom: <summary> or <content>; RSS: <description>
    const desc = isAtom
      ? (extractTag(block, "summary") ?? extractTag(block, "content"))
      : extractTag(block, "description");
    // Atom: <published> or <updated>; RSS: <pubDate>
    const pubDate = isAtom
      ? (extractTag(block, "published") ?? extractTag(block, "updated"))
      : extractTag(block, "pubDate");
    if (!title || !link) continue;

    const text = `${title} ${stripHtml(desc ?? "")}`;
    // Extract image from enclosure, media:content, or media:thumbnail
    const imageUrl = extractImageUrl(block);
    items.push({
      externalId: `${sourceId}:${link}`,
      url: link,
      title: stripHtml(title),
      description: stripHtml(desc ?? "").slice(0, 3000),
      imageUrl,
      coins: tagCoins(text),
      publishedAt: pubDate ? Math.floor(new Date(pubDate).getTime() / 1000) : Math.floor(Date.now() / 1000),
    });
  }
  return items;
}

/** Extract href from Atom <link href="..." /> self-closing tag. Falls back to tag text content. */
function extractAtomLink(block: string): string | null {
  // Prefer <link rel="alternate" href="..."> or plain <link href="...">
  const hrefMatch = block.match(/<link[^>]+href\s*=\s*["']([^"']+)["'][^>]*(?:\/?>|>)/i);
  if (hrefMatch) return hrefMatch[1].trim();
  // Fallback: treat tag body as URL (some non-standard Atom)
  return extractTag(block, "link");
}

function extractTag(xml: string, tag: string): string | null {
  // Handle CDATA
  const cdataRegex = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, "i");
  const cdataMatch = cdataRegex.exec(xml);
  if (cdataMatch) return cdataMatch[1].trim();

  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const match = regex.exec(xml);
  return match ? match[1].trim() : null;
}

function extractImageUrl(block: string): string | undefined {
  // <enclosure url="..." type="image/...">
  const enclosure = block.match(/<enclosure[^>]+url="([^"]+)"[^>]*type="image\/[^"]*"/i);
  if (enclosure) return enclosure[1];
  // <media:content url="..." medium="image">
  const media = block.match(/<media:content[^>]+url="([^"]+)"/i);
  if (media) return media[1];
  // <media:thumbnail url="...">
  const thumb = block.match(/<media:thumbnail[^>]+url="([^"]+)"/i);
  if (thumb) return thumb[1];
  return undefined;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").trim();
}

// ---------------------------------------------------------------------------
// CoinGecko news adapter
// ---------------------------------------------------------------------------

export class CoinGeckoAdapter implements SourceAdapter {
  readonly sourceId = "coingecko";

  async fetch(): Promise<RawArticle[]> {
    const res = await fetch("https://api.coingecko.com/api/v3/news?page=1", {
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`CoinGecko news: HTTP ${res.status}`);
    const data = (await res.json()) as {
      data?: Array<{
        id: string;
        title: string;
        description?: string;
        url: string;
        thumb_2x?: string;
        created_at?: number;
      }>;
    };
    return (data.data ?? []).map((item) => ({
      externalId: item.id ?? item.url,
      url: item.url,
      title: item.title,
      description: item.description ?? "",
      imageUrl: item.thumb_2x,
      coins: tagCoins(`${item.title} ${item.description ?? ""}`),
      publishedAt: item.created_at ?? Math.floor(Date.now() / 1000),
    }));
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAdapter(sourceId: string, customUrl?: string): SourceAdapter | null {
  // Custom RSS source — has a custom_url
  if (customUrl) {
    return new RssAdapter(sourceId, customUrl);
  }

  const preset = NEWS_SOURCE_PRESETS.find((p) => p.sourceId === sourceId);
  if (!preset) return null;

  switch (sourceId) {
    case "cryptopanic":
      return new CryptoPanicAdapter();
    case "coingecko":
      return new CoinGeckoAdapter();
    default:
      // RSS-based presets
      return new RssAdapter(sourceId, preset.defaultUrl);
  }
}
