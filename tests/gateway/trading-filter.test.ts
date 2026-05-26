/**
 * Tests for the trading.{news,tweets}.filter.{get,set} gateway methods.
 *
 * Behaviour matrix:
 * - get on an unset key returns the empty string.
 * - set with a non-empty trimmed prompt persists; subsequent get returns it.
 * - set with the empty string deletes the key (default selector reactivates).
 * - set with > 2000 chars is rejected with an error message.
 * - set with a missing prompt field is rejected.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { MethodRegistry, type MethodContext } from "../../src/gateway/method-registry.js";
import { registerTradingMethods } from "../../src/gateway/trading.js";
import {
  PreferenceStore,
  NEWS_FILTER_PROMPT_KEY,
  TWEET_FILTER_PROMPT_KEY,
} from "../../src/services/preferences.js";
import { DEFAULT_NEWS_FILTER_INSTRUCTION } from "../../src/daemon/prompts/news-evaluation.js";
import { DEFAULT_TWEET_FILTER_INSTRUCTION } from "../../src/daemon/prompts/tweet-evaluation.js";

function makeCtx(): MethodContext {
  return { clientId: "c1", sessionId: "s1", broadcast: () => {}, emit: () => {} };
}

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => noopLogger,
} as any;

function makeRegistry(): { reg: MethodRegistry; preferenceStore: PreferenceStore; db: Database } {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE settings_kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const preferenceStore = new PreferenceStore(db, noopLogger);
  const reg = new MethodRegistry();
  registerTradingMethods(reg.register.bind(reg), {
    tradingClient: {} as any,
    walletStore: {} as any,
    alertRules: {} as any,
    notifications: {} as any,
    newsService: {} as any,
    preferenceStore,
    watchlist: {} as any,
    intel: {} as any,
    binance: undefined,
    logger: noopLogger,
    tokensSnapshot: { build: () => ({ tokens: [], prices: {}, prevDayPrices: {}, maxLeverages: {} }) } as any,
    priceCache: { get: () => undefined, set: () => {} } as any,
    runner: { call: async () => "" } as any,
  });
  return { reg, preferenceStore, db };
}

interface GetResp { prompt: string }
interface SetResp { ok: boolean; error?: string }

describe.each([
  {
    kind: "news" as const,
    key: NEWS_FILTER_PROMPT_KEY,
    getter: "trading.news.filter.get",
    setter: "trading.news.filter.set",
    defaultPrompt: DEFAULT_NEWS_FILTER_INSTRUCTION,
  },
  {
    kind: "tweets" as const,
    key: TWEET_FILTER_PROMPT_KEY,
    getter: "trading.tweets.filter.get",
    setter: "trading.tweets.filter.set",
    defaultPrompt: DEFAULT_TWEET_FILTER_INSTRUCTION,
  },
])("$getter / $setter", ({ key, getter, setter, defaultPrompt }) => {
  let reg: MethodRegistry;
  let preferenceStore: PreferenceStore;
  let db: Database;

  beforeEach(() => {
    ({ reg, preferenceStore, db } = makeRegistry());
  });

  it("returns the built-in default when no override is set", async () => {
    const res = (await reg.dispatch(getter, makeCtx(), {})) as GetResp;
    expect(res.prompt).toBe(defaultPrompt);
    expect(preferenceStore.get(key)).toBeNull();
  });

  it("persists a trimmed prompt and round-trips through get", async () => {
    const setRes = (await reg.dispatch(setter, makeCtx(), { prompt: "  only macro  " })) as SetResp;
    expect(setRes.ok).toBe(true);

    const getRes = (await reg.dispatch(getter, makeCtx(), {})) as GetResp;
    expect(getRes.prompt).toBe("only macro");
    expect(preferenceStore.get(key)).toBe("only macro");
  });

  it("clears the pref when the prompt is empty so get falls back to the default", async () => {
    await reg.dispatch(setter, makeCtx(), { prompt: "stub" });
    expect(preferenceStore.get(key)).toBe("stub");

    const clearRes = (await reg.dispatch(setter, makeCtx(), { prompt: "" })) as SetResp;
    expect(clearRes.ok).toBe(true);

    const getRes = (await reg.dispatch(getter, makeCtx(), {})) as GetResp;
    expect(getRes.prompt).toBe(defaultPrompt);
    expect(preferenceStore.get(key)).toBeNull();
    db.close();
  });

  it("rejects prompts over 2000 characters", async () => {
    const tooLong = "x".repeat(2001);
    const res = (await reg.dispatch(setter, makeCtx(), { prompt: tooLong })) as SetResp;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/2000/);
    expect(preferenceStore.get(key)).toBeNull();
  });

  it("rejects payloads without a prompt field", async () => {
    const res = (await reg.dispatch(setter, makeCtx(), {})) as SetResp;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Missing prompt/i);
  });
});

interface EnabledGetResp { enabled: boolean }

describe.each([
  {
    kind: "news" as const,
    getter: "trading.news.filter.enabled.get",
    setter: "trading.news.filter.enabled.set",
  },
  {
    kind: "tweets" as const,
    getter: "trading.tweets.filter.enabled.get",
    setter: "trading.tweets.filter.enabled.set",
  },
])("$getter / $setter", ({ getter, setter }) => {
  let reg: MethodRegistry;

  beforeEach(() => {
    ({ reg } = makeRegistry());
  });

  it("defaults to false when the key has never been set", async () => {
    const res = (await reg.dispatch(getter, makeCtx(), {})) as EnabledGetResp;
    expect(res.enabled).toBe(false);
  });

  it("set true → get true (round-trip)", async () => {
    const setRes = (await reg.dispatch(setter, makeCtx(), { enabled: true })) as SetResp;
    expect(setRes.ok).toBe(true);

    const getRes = (await reg.dispatch(getter, makeCtx(), {})) as EnabledGetResp;
    expect(getRes.enabled).toBe(true);
  });

  it("set false after set true clears the key (default re-enters)", async () => {
    await reg.dispatch(setter, makeCtx(), { enabled: true });
    await reg.dispatch(setter, makeCtx(), { enabled: false });
    const res = (await reg.dispatch(getter, makeCtx(), {})) as EnabledGetResp;
    expect(res.enabled).toBe(false);
  });

  it("rejects payloads without an enabled flag", async () => {
    const res = (await reg.dispatch(setter, makeCtx(), {})) as SetResp;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Missing enabled/i);
  });

  it("rejects non-boolean enabled values", async () => {
    const res = (await reg.dispatch(setter, makeCtx(), { enabled: "true" })) as SetResp;
    expect(res.ok).toBe(false);
  });
});
