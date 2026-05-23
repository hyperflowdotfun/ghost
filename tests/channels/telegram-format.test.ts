/**
 * telegram-format tests.
 *
 * Covers custom UI tag stripping, markdown table flattening, heading/bold/italic
 * conversion to HTML, safe escaping of stray angle brackets, and graceful
 * handling of partial streamed input.
 */

import { describe, test, expect } from "bun:test";
import { TelegramFormatter } from "../../src/channels/telegram/format/index.js";
import { extractCharts, formatLevels } from "../../src/channels/telegram/format/tags.js";

const formatter = new TelegramFormatter();

describe("formatForTelegram — custom UI tags", () => {
  test("price tag is stripped to inner text", () => {
    expect(formatter.format("<price>$60.23</price>")).toBe("$60.23");
  });

  test("pnl dir=up appends up emoji", () => {
    expect(formatter.format('<pnl dir="up">+2.5%</pnl>')).toBe("+2.5% 📈");
  });

  test("pnl dir=down appends down emoji", () => {
    expect(formatter.format('<pnl dir="down">-1.2%</pnl>')).toBe("-1.2% 📉");
  });

  test("pnl dir=flat has no emoji", () => {
    expect(formatter.format('<pnl dir="flat">0.0%</pnl>')).toBe("0.0%");
  });

  test("side dir=long prepends green circle", () => {
    expect(formatter.format('<side dir="long">BTC</side>')).toBe("🟢 BTC");
  });

  test("side dir=short prepends red circle", () => {
    expect(formatter.format('<side dir="short">BTC</side>')).toBe("🔴 BTC");
  });

  test("pct dir=up appends up emoji", () => {
    expect(formatter.format('<pct dir="up">+5%</pct>')).toBe("+5% 📈");
  });

  test("pct dir=down appends down emoji", () => {
    expect(formatter.format('<pct dir="down">-3%</pct>')).toBe("-3% 📉");
  });

  test("pct with no dir attribute strips wrapper only", () => {
    expect(formatter.format("<pct>0%</pct>")).toBe("0%");
  });

  test("lev tag strips wrapper", () => {
    expect(formatter.format("<lev>10x</lev>")).toBe("10x");
  });

  // SOUL.md mandates the LLM emits the label INSIDE the tag
  // (`<tag type="entry">Entry: 1,950</tag>`). The formatter prepends a visual
  // marker emoji but does not inject a text label — avoiding duplication.
  test("tag type=entry prepends target emoji", () => {
    expect(formatter.format('<tag type="entry">Entry: 1,950</tag>')).toBe("🎯 Entry: 1,950");
  });

  test("tag type=tp prepends money-bag emoji", () => {
    expect(formatter.format('<tag type="tp">TP: 2,100</tag>')).toBe("💰 TP: 2,100");
  });

  test("tag type=sl prepends stop emoji", () => {
    expect(formatter.format('<tag type="sl">SL: 1,900</tag>')).toBe("⛔ SL: 1,900");
  });

  test("tag with no type attribute strips wrapper only", () => {
    expect(formatter.format("<tag>Unknown</tag>")).toBe("Unknown");
  });

  test("unknown custom tag gets generic strip via side-like fallback", () => {
    // An unknown tag name with no special mapping still has its wrapper removed
    // eventually by the escape pass (becomes &lt;foo&gt;...&lt;/foo&gt;). For our
    // known set, inner text survives. Sanity check that at least the inner text
    // is present even for an unknown tag.
    expect(formatter.format('<bogus>inner</bogus>')).toContain("inner");
  });

  test("ind tag strips wrapper, keeps indicator label", () => {
    expect(formatter.format('<ind name="ema">EMA50</ind>')).toBe("EMA50");
  });

  test("lvl tag strips wrapper, keeps visible price text", () => {
    expect(formatter.format('<lvl price="71388">$71,388</lvl>')).toBe("$71,388");
  });

  test("risk level=low prepends green circle", () => {
    expect(formatter.format('<risk level="low">Low Risk</risk>')).toBe("🟢 Low Risk");
  });

  test("risk level=medium prepends yellow circle", () => {
    expect(formatter.format('<risk level="medium">Medium Risk</risk>')).toBe("🟡 Medium Risk");
  });

  test("risk level=high prepends red circle and wraps in bold", () => {
    expect(formatter.format('<risk level="high">High Risk</risk>')).toBe("<b>🔴 High Risk</b>");
  });

  test("verdict tag emits italic emphasis", () => {
    const out = formatter.format("<verdict>bullish</verdict>");
    expect(out).toBe("<i>bullish</i>");
  });

  test("verdict type=bullish prepends bull emoji and wraps in italic", () => {
    expect(formatter.format('<verdict type="bullish">Strong uptrend</verdict>')).toBe(
      "<i>🐂 Strong uptrend</i>",
    );
  });

  test("verdict type=bearish prepends bear emoji and wraps in italic", () => {
    expect(formatter.format('<verdict type="bearish">Down</verdict>')).toBe("<i>🐻 Down</i>");
  });

  test("verdict type=neutral prepends wavy-dash emoji and wraps in italic", () => {
    expect(formatter.format('<verdict type="neutral">Mixed</verdict>')).toBe("<i>〰️ Mixed</i>");
  });

  test("verdict with no type attribute still emits italic only (no emoji)", () => {
    expect(formatter.format("<verdict>Plain</verdict>")).toBe("<i>Plain</i>");
  });

  test("chart self-closing with symbol+interval emits footer hint", () => {
    expect(formatter.format('<chart symbol="BTC" interval="4h" />')).toBe("\n📊 BTC 4h chart");
  });

  test("chart self-closing missing symbol is dropped silently", () => {
    expect(formatter.format('<chart interval="4h" />')).toBe("");
  });

  test("chart self-closing missing interval is dropped silently", () => {
    expect(formatter.format('<chart symbol="BTC" />')).toBe("");
  });

  test("chart paired form with attributes emits footer hint", () => {
    expect(
      formatter.format('<chart symbol="ETH" interval="1h">some content</chart>'),
    ).toBe("\n📊 ETH 1h chart");
  });

  test("chart paired form with no attributes is dropped silently", () => {
    expect(formatter.format("<chart>some content</chart>")).toBe("");
  });

  test("unknown self-closing tag is removed entirely", () => {
    expect(formatter.format('<unknown-foo attr="x" />')).toBe("");
  });

  test("unknown paired tag strips wrapper, keeps inner", () => {
    expect(formatter.format("<unknown-foo>inner</unknown-foo>")).toBe("inner");
  });

  test("nested tags resolve inside-out", () => {
    expect(formatter.format('<side dir="long"><price>$60</price></side>')).toBe("🟢 $60");
  });

  test("real-world TA snippet: indicators + level + chart emits hint footer", () => {
    const input = [
      'LINK is decisively weak — below all four <ind name="ema">EMAs</ind> with the bearish stack, below <ind name="ichimoku">Ichimoku cloud</ind>, and <ind name="vwap">VWAP</ind> overhead at <price>$9.06</price>.',
      "",
      '<chart symbol="LINK" interval="4h" indicators="ema,ichimoku,vwap,stochrsi,williamsr,cci,rsi,adx,obv" levels="8.72,9.06" />',
    ].join("\n");
    const out = formatter.format(input);
    expect(out).toBe(
      "LINK is decisively weak — below all four EMAs with the bearish stack, below Ichimoku cloud, and VWAP overhead at $9.06.\n\n📊 LINK 4h chart",
    );
  });
});

describe("formatForTelegram — caller-supplied <pre>", () => {
  test("preserves <pre> wrappers verbatim so monospace blocks survive", () => {
    const input = "<pre>Equity       $10,000.00\nFree margin  $10,000.00\nUsed margin       $0.00</pre>";
    const out = formatter.format(input);
    expect(out).toContain("<pre>");
    expect(out).toContain("</pre>");
    expect(out).toContain("Equity       $10,000.00");
    expect(out).toContain("Used margin       $0.00");
  });

  test("HTML-escapes <pre> content but keeps the wrapper", () => {
    const input = "<pre>a < b > c & d</pre>";
    const out = formatter.format(input);
    expect(out).toContain("<pre>");
    expect(out).toContain("a &lt; b &gt; c &amp; d");
    expect(out).toContain("</pre>");
  });

  // Markdown / bullets / link syntax inside <pre> must NOT be
  // rewritten — Telegram parses <pre> strictly and rejects nested <b>/<a>.
  test("markdown meta inside <pre> is NOT converted", () => {
    const input = "<pre>**not bold**\n- not a bullet\n[not a link](http://x)\n`not code`</pre>";
    const out = formatter.format(input);
    expect(out).toContain("**not bold**");
    expect(out).toContain("- not a bullet");
    expect(out).toContain("[not a link](http://x)");
    expect(out).toContain("`not code`");
    expect(out).not.toContain("<b>");
    expect(out).not.toContain("<i>");
    expect(out).not.toContain("<a ");
    expect(out).not.toContain("<code>");
    expect(out).not.toContain("• ");
  });
});

describe("formatForTelegram — markdown tables", () => {
  test("small 2-col table renders as aligned <pre> block (17-05)", () => {
    const input = [
      "| Field | Value |",
      "|-------|-------|",
      "| Equity | $12,345 |",
      "| PnL | +$20 |",
    ].join("\n");
    const out = formatter.format(input);
    expect(out).not.toContain("|");
    expect(out).toContain("<pre>");
    expect(out).toContain("</pre>");
    expect(out).toContain("Equity");
    expect(out).toContain("$12,345");
    // Columns are padded so "Equity" and "PnL" land in the same column position.
    const block = /<pre>([\s\S]*?)<\/pre>/.exec(out)?.[1] ?? "";
    const rows = block.split("\n");
    expect(rows.length).toBe(3);
    // Last column not padded; first column equal width across rows.
    const firstColLen = rows[0]!.indexOf(" ");
    expect(firstColLen).toBeGreaterThan(0);
  });

  test("small 3-col table renders as aligned <pre> block (17-05)", () => {
    const input = [
      "| Symbol | Side | PnL |",
      "|--------|------|-----|",
      "| BTC | long | +$50 |",
      "| ETH | short | -$10 |",
    ].join("\n");
    const out = formatter.format(input);
    expect(out).toContain("<pre>");
    expect(out).toContain("Symbol");
    expect(out).toContain("BTC");
    expect(out).toContain("ETH");
  });

  test("wide table (>6 cols) falls back to flat key:value lines (17-05)", () => {
    const input = [
      "| A | B | C | D | E | F | G |",
      "|---|---|---|---|---|---|---|",
      "| 1 | 2 | 3 | 4 | 5 | 6 | 7 |",
    ].join("\n");
    const out = formatter.format(input);
    expect(out).not.toContain("<pre>");
    expect(out).toContain("A: 1");
    expect(out).toContain("G: 7");
  });

  test("tall table (>15 rows) falls back to flat key:value lines (17-05)", () => {
    const header = "| K | V |\n|---|---|\n";
    const rows = Array.from({ length: 16 }, (_, i) => `| k${i} | v${i} |`).join("\n");
    const out = formatter.format(header + rows);
    expect(out).not.toContain("<pre>");
    expect(out).toContain("k0: v0");
    expect(out).toContain("k15: v15");
  });

  // Column widths must use display width (CJK/emoji = 2) so mixed
  // CJK + ASCII tables line up visually. Without this, `.length` sizes CJK
  // cells too narrow and columns drift.
  test("CJK cells pad to display width, not UTF-16 code-unit length", () => {
    const input = [
      "| 币种   | 值 |",
      "|--------|----|",
      "| 比特币 | 100 |",
      "| BTC    | 200 |",
    ].join("\n");
    const out = formatter.format(input);
    const block = /<pre>([\s\S]*?)<\/pre>/.exec(out)?.[1] ?? "";
    const rows = block.split("\n");
    expect(rows).toHaveLength(3);

    // Display-width helper: CJK + wide emoji count 2, everything else 1.
    const displayWidth = (s: string): number => {
      let w = 0;
      for (const ch of s) {
        const cp = ch.codePointAt(0)!;
        if ((cp >= 0x3400 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0x2600 && cp <= 0x27bf) || (cp >= 0x1f300 && cp <= 0x1fbff)) w += 2;
        else w += 1;
      }
      return w;
    };

    // The visual column-0 position of the second value must be the same for
    // both rows — i.e. the prefix before "100" has the same display width as
    // the prefix before "200". `.length` sizing would make them differ by 3.
    const idx1 = rows[1]!.indexOf("100");
    const idx2 = rows[2]!.indexOf("200");
    expect(displayWidth(rows[1]!.slice(0, idx1))).toBe(
      displayWidth(rows[2]!.slice(0, idx2)),
    );
  });

  test("blank-header 2-col table renders as <pre> data block (17-05)", () => {
    const input = [
      "|   |   |",
      "|---|---|",
      "| Equity | $100 |",
    ].join("\n");
    const out = formatter.format(input);
    expect(out).toContain("<pre>");
    expect(out).toContain("Equity");
    expect(out).toContain("$100");
  });

  test("incomplete table (no separator yet) is left untouched during streaming", () => {
    const input = "| Equity | $100 |";
    const out = formatter.format(input);
    expect(out).toContain("|");
    expect(out).toContain("Equity");
  });
});

describe("formatForTelegram — headings & inline markdown", () => {
  test("#### heading becomes <b>heading</b>", () => {
    const out = formatter.format("#### Portfolio Snapshot");
    expect(out).toBe("<b>Portfolio Snapshot</b>");
  });

  test("## heading becomes <b>heading</b>", () => {
    expect(formatter.format("## Summary")).toBe("<b>Summary</b>");
  });

  test("**bold** becomes <b>bold</b>", () => {
    expect(formatter.format("**strong**")).toBe("<b>strong</b>");
  });

  test("*italic* becomes <i>italic</i>", () => {
    expect(formatter.format("*emphasis*")).toBe("<i>emphasis</i>");
  });

  test("inline `code` becomes <code>code</code>", () => {
    expect(formatter.format("`BTC-PERP`")).toBe("<code>BTC-PERP</code>");
  });
});

describe("formatForTelegram — HTML safety", () => {
  test("stray < > & are escaped", () => {
    const out = formatter.format("a < b && c > d");
    expect(out).toBe("a &lt; b &amp;&amp; c &gt; d");
  });

  test("HTML injection inside content is escaped", () => {
    const out = formatter.format("<script>alert('x')</script>");
    // <script> is an unknown tag so inner gets kept; script wrapper is partially
    // stripped (no closing match in our custom set), then escaped. Just verify
    // no raw executable tag survives.
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("</script>");
  });

  test("empty string returns empty string", () => {
    expect(formatter.format("")).toBe("");
  });

  test("plain text unchanged except for escaping", () => {
    expect(formatter.format("hello world")).toBe("hello world");
  });
});

describe("formatForTelegram — streaming edge cases", () => {
  test("partial unclosed tag at end of buffer does not throw and is trimmed", () => {
    const out = formatter.format("BTC price is <pri");
    expect(() => formatter.format("BTC price is <pri")).not.toThrow();
    expect(out).not.toContain("<pri");
    expect(out).toContain("BTC price is");
  });

  test("unclosed bold mid-stream leaves asterisks as literal (escaped-safe)", () => {
    const out = formatter.format("partial **streamed");
    // No crash, and the opening ** isn't promoted into an unclosed <b>.
    expect(out).not.toContain("<b>");
  });
});

describe("formatForTelegram — mixed content", () => {
  // A heading stuck to a sentence (no blank line in between) must still
  // render bold on its own line.
  test("heading stuck to sentence is split onto its own line and bolded", () => {
    const out = formatter.format("... both signal a downside.#### BTC SHORT 5x");
    expect(out).toContain("<b>BTC SHORT 5x</b>");
    expect(out).not.toContain("####");
    // Heading sits on its own line, separated from the prose.
    const lines = out.split("\n");
    expect(lines.some((l) => l === "<b>BTC SHORT 5x</b>")).toBe(true);
  });

  test("portfolio-like message: heading + paragraph + table + tags", () => {
    const input = [
      "#### Portfolio",
      "",
      "Your current holdings:",
      "",
      "| Asset | Value |",
      "|-------|-------|",
      "| BTC | <price>$60,000</price> |",
      "| PnL | <pnl dir=\"up\">+$250</pnl> |",
    ].join("\n");
    const out = formatter.format(input);
    expect(out).toContain("<b>Portfolio</b>");
    expect(out).toContain("Your current holdings");
    // Small table → aligned <pre> monospace block.
    expect(out).toContain("<pre>");
    expect(out).toContain("BTC");
    expect(out).toContain("$60,000");
    expect(out).toContain("+$250 📈");
  });
});

describe("formatForTelegram — bullets, links, blank lines (17-05)", () => {
  test("`- item` becomes `• item`", () => {
    expect(formatter.format("- buy the dip")).toBe("• buy the dip");
  });

  test("`* item` becomes `• item`", () => {
    expect(formatter.format("* watch funding")).toBe("• watch funding");
  });

  test("indented bullet preserves indent", () => {
    expect(formatter.format("  - nested")).toBe("  • nested");
  });

  test("bullet inside a list block converts every line", () => {
    const out = formatter.format(["- one", "- two", "- three"].join("\n"));
    expect(out).toBe(["• one", "• two", "• three"].join("\n"));
  });

  test("`**bold**` is not eaten by the bullet pass", () => {
    // bullet conversion must not see `**` as a list marker.
    expect(formatter.format("**bold**")).toBe("<b>bold</b>");
  });

  // Bullets inside fenced code blocks must survive verbatim so CLI
  // snippets / JSON with leading `-` flags round-trip.
  test("bullets inside ```fenced code``` are NOT rewritten", () => {
    const input = ["```", "- item", "```"].join("\n");
    const out = formatter.format(input);
    expect(out).toContain("- item");
    expect(out).not.toContain("• item");
  });

  test("bullets outside fenced code still convert", () => {
    const input = ["- outside", "```", "- inside", "```", "- outside2"].join("\n");
    const out = formatter.format(input);
    expect(out).toContain("• outside");
    expect(out).toContain("• outside2");
    expect(out).toContain("- inside");
  });

  test("[text](url) becomes <a href=\"url\">text</a>", () => {
    expect(formatter.format("See [CoinDesk](https://example.com).")).toBe(
      "See <a href=\"https://example.com\">CoinDesk</a>.",
    );
  });

  // URLs with inner balanced parens (Wikipedia disambiguation pages,
  // MDN sections, etc.) must not truncate at the first `)`.
  test("link URL with inner parens is preserved", () => {
    const out = formatter.format(
      "[foo](https://en.wikipedia.org/wiki/Foo_(disambiguation))",
    );
    expect(out).toBe(
      "<a href=\"https://en.wikipedia.org/wiki/Foo_(disambiguation)\">foo</a>",
    );
  });

  test("link URL with `&` is HTML-escaped in the href attribute", () => {
    const out = formatter.format("[X](https://example.com/?a=1&b=2)");
    expect(out).toBe("<a href=\"https://example.com/?a=1&amp;b=2\">X</a>");
  });

  test("link text with `&` is escaped in the visible label", () => {
    const out = formatter.format("[Foo & Bar](https://example.com)");
    expect(out).toBe("<a href=\"https://example.com\">Foo &amp; Bar</a>");
  });

  test("3+ blank lines collapse to a single paragraph break", () => {
    expect(formatter.format("a\n\n\n\nb")).toBe("a\n\nb");
  });

  test("2 blank lines (single paragraph break) is preserved", () => {
    expect(formatter.format("a\n\nb")).toBe("a\n\nb");
  });
});

describe("splitIntoSegments (17-05)", () => {
  test("single text with no breaks → 1 segment", () => {
    const segs = formatter.splitIntoSegments("Just a quick reply.");
    expect(segs).toHaveLength(1);
    expect(segs[0]!.content).toBe("Just a quick reply.");
  });

  test("text + #### heading + text → 2 segments, heading lives in 2nd", () => {
    const segs = formatter.splitIntoSegments("Lead-in line.\n\n#### Title\nBody.");
    expect(segs).toHaveLength(2);
    expect(segs[0]!.content).toBe("Lead-in line.");
    expect(segs[1]!.content.startsWith("#### Title")).toBe(true);
    expect(segs[1]!.content).toContain("Body.");
  });

  test("text + <chart/> + text → chart tag is inline narrative, stripped at format time", () => {
    const segs = formatter.splitIntoSegments(
      [
        "BTC trending up.",
        '<chart symbol="BTC" interval="4h" />',
        "Watch the EMA.",
      ].join("\n"),
    );
    // Chart tag is treated as narrative — no longer hoisted into its own segment.
    expect(segs).toHaveLength(1);
    expect(segs[0]!.content).toContain("BTC trending up.");
    expect(segs[0]!.content).toContain("Watch the EMA.");
  });

  test("`---` rule is dropped and forces a split", () => {
    const segs = formatter.splitIntoSegments("part one\n---\npart two");
    expect(segs).toHaveLength(2);
    expect(segs[0]!.content).toBe("part one");
    expect(segs[1]!.content).toBe("part two");
    expect(segs.some((s) => s.content.includes("---"))).toBe(false);
  });

  test("long text + paragraph break → split when current segment ≥ 400 chars", () => {
    const long = "x".repeat(420);
    const segs = formatter.splitIntoSegments(`${long}\n\nfollow-up paragraph`);
    expect(segs).toHaveLength(2);
    expect(segs[0]!.content.length).toBeGreaterThanOrEqual(400);
    expect(segs[1]!.content).toBe("follow-up paragraph");
  });

  test("short text + paragraph break stays as 1 segment (below 400 char threshold)", () => {
    const segs = formatter.splitIntoSegments("alpha\n\nbeta");
    expect(segs).toHaveLength(1);
    expect(segs[0]!.content).toContain("alpha");
    expect(segs[0]!.content).toContain("beta");
  });

  test("multi-section TA: chart tags collapse into surrounding narrative", () => {
    const segs = formatter.splitIntoSegments(
      [
        "BTC analysis here.",
        '<chart symbol="BTC" interval="4h" />',
        "ETH analysis here.",
        '<chart symbol="ETH" interval="4h" />',
      ].join("\n"),
    );
    // Chart tags are no longer hoisted into their own segments — they flow as
    // narrative text that formatForTelegram strips at render time.
    expect(segs).toHaveLength(1);
    expect(segs[0]!.content).toContain("BTC analysis here.");
    expect(segs[0]!.content).toContain("ETH analysis here.");
  });

  test("empty trim segments are dropped", () => {
    const segs = formatter.splitIntoSegments("\n\n\n   \n");
    expect(segs).toHaveLength(0);
  });

  test("heading at top of input stays in its own segment, not split off", () => {
    const segs = formatter.splitIntoSegments("#### Only Heading\nBody.");
    expect(segs).toHaveLength(1);
    expect(segs[0]!.content.startsWith("#### Only Heading")).toBe(true);
  });
});

describe("extractCharts — tag extraction helper", () => {
  test("self-closing tag with symbol+interval is extracted and text is stripped", () => {
    const { text, charts } = extractCharts('prose\n<chart symbol="BTC" interval="4h" />');
    expect(text.trim()).toBe("prose");
    expect(charts).toHaveLength(1);
    expect(charts[0]).toMatchObject({ symbol: "BTC", interval: "4h" });
  });

  test("paired form is extracted and text is stripped", () => {
    const { text, charts } = extractCharts('<chart symbol="ETH" interval="1h">some content</chart>');
    expect(text.trim()).toBe("");
    expect(charts).toHaveLength(1);
    expect(charts[0]).toMatchObject({ symbol: "ETH", interval: "1h" });
  });

  test("optional indicators and levels are captured; ema is dropped as base layer", () => {
    const { charts } = extractCharts(
      '<chart symbol="BTC" interval="4h" indicators="ema,rsi" levels="70000,65000" />',
    );
    expect(charts[0]).toMatchObject({
      symbol: "BTC",
      interval: "4h",
      indicators: "rsi",
      levels: "70000,65000",
    });
  });

  test("indicator normalization: display names mapped to canonical codes, unknowns dropped", () => {
    const { charts } = extractCharts(
      '<chart symbol="BTC" interval="4h" indicators="EMA9, RSI, MACD, Bollinger Bands, GIBBERISH" />',
    );
    expect(charts[0]?.indicators).toBe("rsi,macd,bb");
  });

  test("levels normalization: non-numeric tokens are dropped", () => {
    const { charts } = extractCharts(
      '<chart symbol="BTC" interval="4h" levels="support, 65000, resistance, 68500" />',
    );
    expect(charts[0]?.levels).toBe("65000,68500");
  });

  test("levels normalization: all non-numeric -> levels omitted", () => {
    const { charts } = extractCharts(
      '<chart symbol="BTC" interval="4h" levels="support, resistance" />',
    );
    expect(charts[0]?.levels).toBeUndefined();
  });

  test("body-style fallback: <chart>\\nsymbol: BTC\\n…</chart> is parsed", () => {
    const { charts } = extractCharts(
      '<chart>\nsymbol: BTC\ninterval: 4h\nindicators: RSI, MACD\nlevels: 65000, 68500\n</chart>',
    );
    expect(charts[0]).toMatchObject({
      symbol: "BTC",
      interval: "4h",
      indicators: "rsi,macd",
      levels: "65000,68500",
    });
  });

  test("body-style fallback: full LLM drift output (display names + word levels) still extracts what it can", () => {
    const { charts } = extractCharts(
      '<chart>\nsymbol: BTC\ninterval: 4h\nindicators: EMA9, EMA21, EMA50, EMA200, RSI, MACD, Bollinger\nlevels: support, resistance\n</chart>',
    );
    expect(charts).toHaveLength(1);
    expect(charts[0]).toMatchObject({ symbol: "BTC", interval: "4h", indicators: "rsi,macd,bb" });
    expect(charts[0]?.levels).toBeUndefined();
  });

  test("attribute form wins over body when both present", () => {
    const { charts } = extractCharts(
      '<chart symbol="ETH" interval="1h">\nsymbol: BTC\ninterval: 4h\n</chart>',
    );
    expect(charts[0]).toMatchObject({ symbol: "ETH", interval: "1h" });
  });

  test("multiple self-closing tags return specs in order", () => {
    const { charts } = extractCharts(
      '<chart symbol="BTC" interval="4h" />\n<chart symbol="ETH" interval="1h" />',
    );
    expect(charts).toHaveLength(2);
    expect(charts[0]!.symbol).toBe("BTC");
    expect(charts[1]!.symbol).toBe("ETH");
  });

  test("tag missing symbol is skipped silently — no spec returned", () => {
    const { text, charts } = extractCharts('<chart interval="4h" />');
    expect(charts).toHaveLength(0);
    // Tag is still stripped from text even if spec is invalid.
    expect(text).not.toContain("<chart");
  });

  test("tag missing interval is skipped silently — no spec returned", () => {
    const { charts } = extractCharts('<chart symbol="BTC" />');
    expect(charts).toHaveLength(0);
  });

  test("text with no chart tags is returned unchanged", () => {
    const input = "just some prose";
    const { text, charts } = extractCharts(input);
    expect(text).toBe(input);
    expect(charts).toHaveLength(0);
  });
});

describe("formatLevels — S/R level CSV formatter", () => {
  test("two k-values: 65000,68500 → $65k, $68.5k", () => {
    expect(formatLevels("65000,68500")).toBe("$65k, $68.5k");
  });

  test("sub-1000 value: 180 → $180 (passthrough with dollar prefix)", () => {
    expect(formatLevels("180")).toBe("$180");
  });

  test("decimal sub-1000 value: 1.234 → $1.234 (passthrough with dollar prefix)", () => {
    expect(formatLevels("1.234")).toBe("$1.234");
  });

  test("undefined → empty string", () => {
    expect(formatLevels(undefined)).toBe("");
  });

  test("empty string → empty string", () => {
    expect(formatLevels("")).toBe("");
  });

  test("non-numeric value: passthrough as-is", () => {
    expect(formatLevels("not-a-number")).toBe("not-a-number");
  });
});

describe("formatForTelegram — verdict spacing (G4)", () => {
  test("standalone verdict on its own line gets blank line above", () => {
    const input = 'Some prose.\n<verdict type="bullish">Strong</verdict>';
    const out = formatter.format(input);
    expect(out).toContain("Some prose.\n\n<i>🐂 Strong</i>");
  });

  test("inline verdict mid-paragraph does not get extra newline", () => {
    const input = "prose <verdict>quick</verdict> continues";
    const out = formatter.format(input);
    expect(out).toContain("prose <i>quick</i> continues");
    // No double-newline introduced before the inline verdict.
    expect(out).not.toContain("\n\n<i>quick</i>");
  });

  test("bearish verdict on own line also gets blank line above", () => {
    const input = 'Analysis done.\n<verdict type="bearish">Weak</verdict>';
    const out = formatter.format(input);
    expect(out).toContain("Analysis done.\n\n<i>🐻 Weak</i>");
  });
});

describe("formatWithCharts — formatter method", () => {
  test("strips chart tag and returns spec alongside formatted prose", () => {
    const { text, charts } = formatter.formatWithCharts(
      'prose\n<chart symbol="BTC" interval="4h" />',
    );
    // Text should be rendered HTML of just the prose, no chart hint footer.
    expect(text).not.toContain("📊");
    expect(text).toContain("prose");
    expect(charts).toHaveLength(1);
    expect(charts[0]).toMatchObject({ symbol: "BTC", interval: "4h" });
  });

  test("handles multiple chart tags and returns specs in order", () => {
    const { text, charts } = formatter.formatWithCharts(
      'BTC prose\n<chart symbol="BTC" interval="4h" />\nETH prose\n<chart symbol="ETH" interval="1h" />',
    );
    expect(charts).toHaveLength(2);
    expect(charts[0]!.symbol).toBe("BTC");
    expect(charts[1]!.symbol).toBe("ETH");
    expect(text).toContain("BTC prose");
    expect(text).toContain("ETH prose");
    // No footer hints in the happy path.
    expect(text).not.toContain("📊");
  });

  test("chart tag missing symbol/interval: not in charts, stripped from text", () => {
    const { text, charts } = formatter.formatWithCharts('<chart interval="4h" /> some prose');
    expect(charts).toHaveLength(0);
    expect(text).not.toContain("<chart");
  });

  test("preserves prose formatting (bold, italic) from format() pipeline", () => {
    const { text } = formatter.formatWithCharts(
      '**bold** prose\n<chart symbol="BTC" interval="4h" />',
    );
    expect(text).toContain("<b>bold</b>");
  });

  test("empty input returns empty text and no charts", () => {
    const { text, charts } = formatter.formatWithCharts("");
    expect(text).toBe("");
    expect(charts).toHaveLength(0);
  });

  test("legacy format() callers still get text hint footer (stripCustomTags unchanged)", () => {
    // format() is called directly without extractCharts, so stripCustomTags runs
    // and emits the text hint.
    const out = formatter.format('<chart symbol="BTC" interval="4h" />');
    expect(out).toBe("\n📊 BTC 4h chart");
  });
});

describe("formatForTelegram — <asks> wizard block fallback", () => {
  const askBlock = [
    "<asks>",
    "  <question><title>Long or short?</title></question>",
    "  <question><title>Size (USDC)?</title></question>",
    "</asks>",
  ].join("\n");

  const legacyBlock = [
    "<ask_user_question>",
    "  <question><title>Long or short?</title></question>",
    "  <question><title>Size (USDC)?</title></question>",
    "</ask_user_question>",
  ].join("\n");

  test("current <asks> tag flattens into a numbered question list", () => {
    const out = formatter.format(askBlock);
    expect(out).toContain("1. Long or short?");
    expect(out).toContain("2. Size (USDC)?");
    expect(out).not.toContain("<asks");
    expect(out).not.toContain("<question>");
  });

  test("legacy <ask_user_question> tag flattens identically", () => {
    const out = formatter.format(legacyBlock);
    expect(out).toContain("1. Long or short?");
    expect(out).toContain("2. Size (USDC)?");
    expect(out).not.toContain("ask_user_question");
    expect(out).not.toContain("<question>");
  });

  test("mismatched open/close tags do not match (backref keeps them symmetric)", () => {
    const mismatched = "<asks><question><title>X</title></question></ask_user_question>";
    const out = formatter.format(mismatched);
    expect(out).not.toContain("1. X");
  });
});
