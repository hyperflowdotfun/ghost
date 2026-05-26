/**
 * Trading tools — creates all trading-specific AgentTools.
 *
 * Tools that mutate state (orders, risk) are pure executors; the
 * orchestrator (`runtime.ts > makeBeforeToolCall`) intercepts confirmable
 * calls before they execute and runs a single combined confirm card per
 * assistant message.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ITradingClient } from "../../services/interfaces/trading-client.js";
import type { IntelService } from "../../services/intel.js";
import type { WatchlistService } from "../../services/watchlist/service.js";
import type { AlertRulesService } from "../../services/alert-rules.js";
import type { NotificationsService } from "../../services/notifications.js";
import type { PriceCache } from "../../services/price-cache.js";
import type { TaIndicatorService } from "../../services/ta-indicators.js";
import type { TaLevelsService } from "../../services/ta-levels.js";
import type { IWalletStore } from "../../services/interfaces/wallet-store.js";
import type { CrossExchangeService } from "../../services/cross-exchange.js";
import type { LiquidationMapService } from "../../services/liquidation-map.js";
import type { TimingRiskService } from "../../services/timing-risk.js";
import type { WhaleTrackingService } from "../../services/whale-tracking.js";
import type { CronService } from "../../scheduler/service.js";
import type { Config } from "../../config/schema.js";
import { createAccountTools } from "./account.js";
import { createTradingTools as createOrderTools } from "./orders.js";
import { createRiskTools } from "./risk.js";
import { createMarketTools } from "./market.js";
import { createIntelTools } from "./intel.js";
import { createHistoryTools } from "./history.js";
import { createRecentOrdersTools } from "./recent-orders.js";
import { createAdvancedTradingTools } from "./advanced.js";
import { createTechnicalTools } from "./technical.js";
import { createNewsSourceTools, createNewsSearchTools } from "./news.js";
import { createNewsTools } from "./news-discover.js";
import { createTweetsTools } from "./tweets.js";
import { createXFollowTools } from "./x-follows.js";
import type { NewsService } from "../../services/news.js";
import type { RssDiscoveryService } from "../../services/rss-discovery.js";
import type { BinanceService } from "../../services/binance.js";
import type { TweetService } from "../../services/tweets.js";
import type { XFollowService } from "../../services/x-follows.js";
import type { SessionManager } from "../../session/manager.js";

export interface TradingToolsDeps {
  hl: ITradingClient;
  walletStore: IWalletStore;
  intel: IntelService;
  /** Required for ghost_session_info (idle-gate). */
  sessionManager: SessionManager;
  watchlist: WatchlistService;
  /** Binance universe — undefined when Binance feed disabled. Watchlist
   *  add validation uses `.has()` for Binance pairs. */
  binance: BinanceService | undefined;
  alertRules: AlertRulesService;
  notifications: NotificationsService;
  priceCache: PriceCache;
  taIndicators: TaIndicatorService;
  taLevels: TaLevelsService;
  /** Required for ghost_cross_exchange_funding. */
  crossExchange: CrossExchangeService;
  /** Required for ghost_liquidation_map. */
  liquidationMap: LiquidationMapService;
  /** Required for ghost_timing_risk. */
  timingRisk: TimingRiskService;
  /** Required for ghost_get_whale_activity (service-backed). */
  whaleTracking: WhaleTrackingService;
  /** Required for ghost_morning_briefing. */
  cronService: CronService;
  news?: NewsService;
  rssDiscovery?: RssDiscoveryService;
  tweets?: TweetService;
  xFollows?: XFollowService;
  testnet: boolean;
  saveWalletConfig?: (address: string, privateKey: string) => Promise<void>;
  disconnectWallet?: () => Promise<{ address: string } | null>;
  config: Config;
  configPath: string;
}

export function createAllTradingTools(deps: TradingToolsDeps): AgentTool[] {
  return [
    ...createAccountTools({
      hl: deps.hl,
      walletStore: deps.walletStore,
      testnet: deps.testnet,
      saveWalletConfig: deps.saveWalletConfig,
      disconnectWallet: deps.disconnectWallet,
    }),
    ...createOrderTools(deps.hl, deps.walletStore),
    ...createRiskTools(deps.hl, deps.walletStore),
    ...createMarketTools(deps.hl, deps.priceCache),
    ...createIntelTools({
      hl: deps.hl,
      intel: deps.intel,
      sessionManager: deps.sessionManager,
      crossExchange: deps.crossExchange,
      liquidationMap: deps.liquidationMap,
      timingRisk: deps.timingRisk,
      whaleTracking: deps.whaleTracking,
      cronService: deps.cronService,
    }),
    ...createHistoryTools(deps.hl),
    ...createRecentOrdersTools(deps.hl),
    ...createAdvancedTradingTools(deps.hl, deps.watchlist, deps.alertRules, deps.binance, deps.priceCache),
    ...createTechnicalTools(deps.taIndicators, deps.taLevels),
    ...(deps.news ? createNewsSourceTools(deps.news) : []),
    ...(deps.news ? createNewsSearchTools(deps.news) : []),
    ...(deps.news && deps.rssDiscovery ? createNewsTools(deps.news, deps.rssDiscovery) : []),
    ...(deps.tweets ? createTweetsTools(deps.tweets) : []),
    ...(deps.xFollows ? createXFollowTools(deps.xFollows) : []),
  ];
}
