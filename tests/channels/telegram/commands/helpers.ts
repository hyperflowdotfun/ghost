/**
 * Shared stubs for slash-command handler tests.
 *
 * Each helper builds the minimal surface a handler touches; unrelated methods
 * are intentionally absent so a handler that strays past its contract throws.
 */

import { mock } from "bun:test";
import type { Logger } from "pino";
import type { ITradingClient } from "../../../../src/services/interfaces/trading-client.js";
import type { IWalletStore, WalletInfo } from "../../../../src/services/interfaces/wallet-store.js";
import type { NewsService } from "../../../../src/services/news.js";
import type {
  Balance, Position, OpenOrder, Ticker,
} from "../../../../src/services/interfaces/trading-types.js";
import type { NewsArticle } from "../../../../src/services/news-types.js";
import type { CommandCtx } from "../../../../src/channels/telegram/commands/types.js";

export const noopLogger: Logger = {
  warn: mock(() => {}), info: mock(() => {}),
  debug: mock(() => {}), error: mock(() => {}), trace: mock(() => {}),
  child: () => noopLogger,
} as unknown as Logger;

export function makeWalletInfo(address: string, overrides: Partial<WalletInfo> = {}): WalletInfo {
  return {
    address,
    testnet: false,
    isDefault: overrides.isDefault ?? false,
    source: "chat",
    status: "trading",
    apiWalletAddress: null,
    addedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

export function makeBalance(overrides: Partial<Balance> = {}): Balance {
  return {
    totalEquity: 10_000,
    availableBalance: 8_000,
    usedMargin: 2_000,
    unrealizedPnl: 0,
    ...overrides,
  };
}

export function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    symbol: "BTC",
    side: "long",
    size: 0.5,
    entryPrice: 50_000,
    markPrice: 51_000,
    liquidationPrice: 30_000,
    unrealizedPnl: 500,
    unrealizedPnlPct: 1,
    leverage: 5,
    marginMode: "cross",
    margin: 5_000,
    ...overrides,
  };
}

export function makeOrder(overrides: Partial<OpenOrder> = {}): OpenOrder {
  return {
    orderId: "1001",
    symbol: "BTC",
    side: "buy",
    orderType: "limit",
    price: 49_000,
    triggerPrice: null,
    size: 0.1,
    filled: 0,
    reduceOnly: false,
    timestamp: 0,
    ...overrides,
  };
}

export function makeTicker(symbol: string, overrides: Partial<Ticker> = {}): Ticker {
  return {
    symbol,
    markPrice: 100,
    midPrice: 100,
    oraclePrice: 100,
    volume24h: 1_000_000,
    prevDayPrice: 95,
    priceChangePct24h: 5.26,
    openInterest: 100_000,
    fundingRate: 0.0001,
    ...overrides,
  };
}

export function makeArticle(overrides: Partial<NewsArticle> = {}): NewsArticle {
  return {
    id: "a1",
    sourceId: "coindesk",
    externalId: "ext-1",
    url: "https://example.com/a",
    title: "Sample headline",
    description: "snip",
    imageUrl: null,
    coins: [],
    importance: "reference",
    publishedAt: Math.floor(Date.now() / 1000),
    fetchedAt: Math.floor(Date.now() / 1000),
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
    body: null,
    summary: null,
    aiRelevant: true,
    aiDuplicateOf: null,
    ...overrides,
  };
}

export interface CtxOverrides {
  chatId?: string;
  wallets?: WalletInfo[];
  getBalance?: ITradingClient["getBalance"];
  getPositions?: ITradingClient["getPositions"];
  getOpenOrders?: ITradingClient["getOpenOrders"];
  getTicker?: ITradingClient["getTicker"];
  getArticles?: NewsService["getArticles"];
  getUnshownArticles?: NewsService["getUnshownArticles"];
  markArticlesShown?: NewsService["markArticlesShown"];
  getSourceNames?: NewsService["getSourceNames"];
}

/** Build a minimal CommandCtx with just the surface the test exercises. */
export function makeCtx(overrides: CtxOverrides = {}): CommandCtx {
  const tradingClient = {
    getBalance: overrides.getBalance ?? (async () => makeBalance()),
    getPositions: overrides.getPositions ?? (async () => []),
    getOpenOrders: overrides.getOpenOrders ?? (async () => []),
    getTicker: overrides.getTicker ?? (async (sym: string) => makeTicker(sym)),
  } as unknown as ITradingClient;

  const walletStore = {
    listWallets: () => overrides.wallets ?? [],
  } as unknown as IWalletStore;

  const newsService = {
    getArticles: overrides.getArticles ?? (() => []),
    getUnshownArticles: overrides.getUnshownArticles ?? (() => []),
    markArticlesShown: overrides.markArticlesShown ?? (() => {}),
    getSourceNames: overrides.getSourceNames ?? (() => new Map<string, string>()),
  } as unknown as NewsService;

  // Use the narrowed interfaces from commands/types — keeps the stub
  // surface aligned with what slash handlers actually consume.
  const alertRules: import("../../../../src/channels/telegram/commands/types.js").CommandAlertRulesService = {
    list: () => [],
    remove: () => false,
  };

  const priceCache: import("../../../../src/channels/telegram/commands/types.js").CommandPriceCache = {
    get: () => undefined,
  };

  return {
    chatId: overrides.chatId ?? "test-chat",
    tradingClient,
    walletStore,
    newsService,
    alertRules,
    priceCache,
    log: noopLogger,
  };
}
