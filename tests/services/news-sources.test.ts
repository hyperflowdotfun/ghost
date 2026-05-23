import { describe, test, expect } from "bun:test";
import { parseRss } from "../../src/services/news-sources.js";

/**
 * Build a minimal RSS XML document with a single <item> whose <description>
 * contains the given text. CDATA-wrapped so length is preserved as-is.
 */
function rssDoc(description: string): string {
  return `<?xml version="1.0"?>
<rss><channel>
  <item>
    <title>Test Title</title>
    <link>https://example.com/post</link>
    <description><![CDATA[${description}]]></description>
    <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
  </item>
</channel></rss>`;
}

/** Atom feed with <summary>. */
function atomSummaryDoc(summary: string): string {
  return `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Atom Title</title>
    <link href="https://example.com/atom-post"/>
    <summary><![CDATA[${summary}]]></summary>
    <published>2024-01-01T00:00:00Z</published>
  </entry>
</feed>`;
}

/** Atom feed with <content> (no <summary>). */
function atomContentDoc(content: string): string {
  return `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Atom Content Title</title>
    <link href="https://example.com/atom-content"/>
    <content><![CDATA[${content}]]></content>
    <published>2024-01-01T00:00:00Z</published>
  </entry>
</feed>`;
}

describe("parseRss description length preservation", () => {
  test("RSS description of 1500 chars is preserved (no truncation)", () => {
    const desc = "a".repeat(1500);
    const items = parseRss(rssDoc(desc), "test");
    expect(items).toHaveLength(1);
    expect(items[0].description.length).toBe(1500);
  });

  test("RSS description of 5000 chars is capped at 3000", () => {
    const desc = "b".repeat(5000);
    const items = parseRss(rssDoc(desc), "test");
    expect(items).toHaveLength(1);
    expect(items[0].description.length).toBe(3000);
  });

  test("Atom <summary> preserves length identically to RSS", () => {
    const text = "c".repeat(1500);
    const items = parseRss(atomSummaryDoc(text), "test");
    expect(items).toHaveLength(1);
    expect(items[0].description.length).toBe(1500);
  });

  test("Atom <summary> capped at 3000", () => {
    const text = "d".repeat(5000);
    const items = parseRss(atomSummaryDoc(text), "test");
    expect(items).toHaveLength(1);
    expect(items[0].description.length).toBe(3000);
  });

  test("Atom <content> preserves length identically to RSS", () => {
    const text = "e".repeat(1500);
    const items = parseRss(atomContentDoc(text), "test");
    expect(items).toHaveLength(1);
    expect(items[0].description.length).toBe(1500);
  });

  test("Atom <content> capped at 3000", () => {
    const text = "f".repeat(5000);
    const items = parseRss(atomContentDoc(text), "test");
    expect(items).toHaveLength(1);
    expect(items[0].description.length).toBe(3000);
  });
});
