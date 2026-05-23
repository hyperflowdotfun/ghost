import { describe, it, expect } from "bun:test";
import { newsHandler } from "../../../../src/channels/telegram/commands/news.js";
import { makeCtx, makeArticle } from "./helpers.js";

function s(reply: string | string[]): string {
  if (typeof reply !== "string") throw new Error("expected single-string reply");
  return reply;
}

describe("/news handler — drain mode (default)", () => {
  it("returns empty hint pointing at /news latest when nothing unseen", async () => {
    const out = s(await newsHandler(makeCtx({ getUnshownArticles: () => [] }), []));
    expect(out).toContain("No new articles");
    expect(out).toContain("/news latest");
  });

  it("renders title-as-link + source/time on its own line + full summary below", async () => {
    const calls: Array<{ chatId: string; scope: string; opts: unknown }> = [];
    const out = s(await newsHandler(makeCtx({
      chatId: "tg:42",
      getSourceNames: () => new Map([["coindesk", "CoinDesk"]]),
      getUnshownArticles: (chatId, scope, opts) => {
        calls.push({ chatId, scope, opts });
        return [
          makeArticle({
            id: "a1",
            sourceId: "coindesk",
            title: "BTC hits new high",
            url: "https://example.com/btc",
            description: "Bitcoin reached a new ATH on heavy spot volume.",
            publishedAt: Math.floor(Date.now() / 1000) - 120,
          }),
        ];
      },
    }), []));

    // Header reflects scope (default = `recent`) + count
    expect(out).toContain("**News · recent · 1 articles**");
    // Bracketed kicker + title bundled into ONE bold tappable link via
    // sentinel-wrapped HTML (the wrapLink helper sidesteps markdown's
    // bracket-nesting limit). Raw output contains sentinel chars; the
    // pipeline materializes them into <b><a>…</a></b> downstream.
    expect(out).toContain("[CoinDesk · 2m ago] BTC hits new high");
    expect(out).toContain("https://example.com/btc");
    // Summary on the next line
    expect(out).toContain("Bitcoin reached a new ATH on heavy spot volume.");
    // Source name uses display name from preset (CoinDesk, not coindesk)
    expect(out).not.toContain("[coindesk ·");
    // No 🔗 line — title is the link
    expect(out).not.toContain("🔗");
    // Service was called with this chat's drain scope + limit 5
    expect(calls.length).toBe(1);
    expect(calls[0]!.chatId).toBe("tg:42");
    expect(calls[0]!.scope).toBe("global");
  });

  it("falls back to capitalized sourceId when preset has no display name", async () => {
    const out = s(await newsHandler(makeCtx({
      getSourceNames: () => new Map(),
      getUnshownArticles: () => [
        makeArticle({ sourceId: "myrss", url: "https://x/y" }),
      ],
    }), []));
    expect(out).toContain("[Myrss · ");
  });

  it("advances the shown-set after a successful drain build", async () => {
    let markedWith: { chatId: string; scope: string; ids: ReadonlyArray<string> } | null = null;
    await newsHandler(makeCtx({
      chatId: "tg:42",
      getUnshownArticles: () => [
        makeArticle({ id: "a1", url: "https://x/1" }),
        makeArticle({ id: "a2", url: "https://x/2" }),
      ],
      markArticlesShown: (chatId, scope, ids) => {
        markedWith = { chatId, scope, ids };
      },
    }), []);
    expect(markedWith).not.toBeNull();
    expect(markedWith!.chatId).toBe("tg:42");
    expect(markedWith!.scope).toBe("global");
    expect(markedWith!.ids).toEqual(["a1", "a2"]);
  });

  it("does NOT advance the shown-set when drain returns nothing", async () => {
    let marked = false;
    await newsHandler(makeCtx({
      getUnshownArticles: () => [],
      markArticlesShown: () => { marked = true; },
    }), []);
    expect(marked).toBe(false);
  });

  it("uses per-symbol scope for /news <SYM> and passes the symbol filter", async () => {
    const calls: Array<{ chatId: string; scope: string; opts: { symbol?: string } }> = [];
    await newsHandler(makeCtx({
      chatId: "tg:42",
      getUnshownArticles: (chatId, scope, opts) => {
        calls.push({ chatId, scope, opts: opts ?? {} });
        return [];
      },
    }), ["btc"]);
    expect(calls[0]!.scope).toBe("symbol:BTC");
    expect(calls[0]!.opts.symbol).toBe("BTC");
  });

  it("symbol-empty hint mentions the symbol", async () => {
    const out = s(await newsHandler(makeCtx({ getUnshownArticles: () => [] }), ["BTC"]));
    expect(out).toContain("BTC");
    expect(out).toContain("/news latest");
  });

  it("prefers summary over description when available", async () => {
    const out = s(await newsHandler(makeCtx({
      getUnshownArticles: () => [
        makeArticle({
          summary: "LLM full summary text.",
          description: "raw RSS description",
          url: "https://x/y",
        }),
      ],
    }), []));
    expect(out).toContain("LLM full summary text.");
    expect(out).not.toContain("raw RSS description");
  });

  it("falls back to description when summary is null", async () => {
    const out = s(await newsHandler(makeCtx({
      getUnshownArticles: () => [
        makeArticle({ summary: null, description: "raw RSS description", url: "https://x/y" }),
      ],
    }), []));
    expect(out).toContain("raw RSS description");
  });

  it("does NOT truncate the summary — LLM has already trimmed it server-side", async () => {
    const longSnippet = "A".repeat(250);
    const out = s(await newsHandler(makeCtx({
      getUnshownArticles: () => [makeArticle({ description: longSnippet, url: "https://x/y" })],
    }), []));
    expect(out).toContain(longSnippet);
    expect(out).not.toContain("…");
  });

  it("escapes markdown emphasis in title + summary so * and ` don't bleed", async () => {
    const out = s(await newsHandler(makeCtx({
      getUnshownArticles: () => [
        makeArticle({
          title: "**ETH** rallies",
          description: "**BTC** *rallies* on `news` flow",
          url: "https://x/y",
        }),
      ],
    }), []));
    expect(out).toContain("ETH rallies"); // title sans markdown markers
    expect(out).toContain("BTC rallies on news flow");
    expect(out).not.toContain("`news`");
  });

  it("numbers articles sequentially", async () => {
    const out = s(await newsHandler(makeCtx({
      getUnshownArticles: () => [
        makeArticle({ id: "1", title: "First", description: "Snippet 1.", url: "https://x/1", sourceId: "src1" }),
        makeArticle({ id: "2", title: "Second", description: "Snippet 2.", url: "https://x/2", sourceId: "src2" }),
      ],
    }), []));
    expect(out).toContain("1. ");
    expect(out).toContain("First");
    expect(out).toContain("https://x/1");
    expect(out).toContain("2. ");
    expect(out).toContain("Second");
    expect(out).toContain("https://x/2");
  });
});

describe("/news handler — latest mode (browse)", () => {
  it("returns 'No news available.' when latest has nothing", async () => {
    const out = s(await newsHandler(makeCtx({ getArticles: () => [] }), ["latest"]));
    expect(out).toBe("No news available.");
  });

  it("calls getArticles with limit 20 and never advances the shown-set", async () => {
    let receivedLimit: number | undefined;
    let marked = false;
    await newsHandler(makeCtx({
      getArticles: (opts) => {
        receivedLimit = opts?.limit;
        return [makeArticle({ id: "x", url: "https://x/x" })];
      },
      markArticlesShown: () => { marked = true; },
    }), ["latest"]);
    expect(receivedLimit).toBe(20);
    expect(marked).toBe(false);
  });

  it("header tags 'latest' scope", async () => {
    const out = s(await newsHandler(makeCtx({
      getArticles: () => [makeArticle({ id: "x", url: "https://x/x" })],
    }), ["latest"]));
    expect(out).toContain("**News · latest · 1 articles**");
  });
});

describe("/news handler — usage", () => {
  it("rejects > 1 arg with a usage hint", async () => {
    const out = s(await newsHandler(makeCtx(), ["BTC", "ETH"]));
    expect(out.toLowerCase()).toContain("usage");
  });
});
