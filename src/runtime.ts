/**
 * Runtime — composition root. Creates all Ghost subsystems from config.
 */

import type { Logger } from "pino";
import { loadConfig, saveConfig, getConfigPath, expandHome } from "./config/index.js";
import {
  getWorkspaceDir,
  getDbPath,
  getSecretKeyPath,
  getCredentialsPath,
  getModelsConfigPath,
} from "./config/paths.js";
import {
  loadCustomModelRegistry,
  shouldForceThinkingOff,
  type CustomModelRegistry,
} from "./providers/models-config.js";
import { CredentialStore } from "./config/credentials.js";
import { SecretStore } from "./config/secrets.js";
import { initDatabase } from "./core/database.js";
import { runDbMigrations } from "./core/migrations/db.js";
import { runConfigMigrations } from "./core/migrations/config.js";
import { DB_MIGRATIONS, CONFIG_MIGRATIONS } from "./core/migrations/registry.js";
import { VersionCheckService, type VersionCheck } from "./update/version-check.js";
import { MemoryStore } from "./memory/store.js";
import { MemoryConsolidator, estimateTokens as estimateTokensTiktoken } from "./memory/consolidator.js";
import { SessionManager } from "./session/manager.js";
import { SecurityPolicy } from "./security/policy.js";
import { LeakDetector } from "./security/leak-detector.js";
import { createToolRegistry } from "./tools/index.js";
import { Agent } from "@earendil-works/pi-agent-core";
import type {
  BeforeToolCallContext,
  BeforeToolCallResult,
  AfterToolCallContext,
  AfterToolCallResult,
  AgentOptions,
  AgentMessage,
} from "@earendil-works/pi-agent-core";
import type { TextContent, Model, Api } from "@earendil-works/pi-ai";
import { getModel, type KnownProvider } from "@earendil-works/pi-ai";
import { ContextBuilder } from "./agent/context-builder.js";
import { SkillsLoader } from "./skills/index.js";
import { SkillService } from "./services/skill-service.js";
import { OAuthManager } from "./auth/oauth.js";
import { CronService } from "./scheduler/service.js";
import { MessageBus } from "./bus/queue.js";
import { Orchestrator } from "./agent/orchestrator.js";
import { MessageDispatcher } from "./channels/dispatcher.js";
import { ChannelManager } from "./channels/manager.js";
import { SecurityError } from "./core/errors.js";
import { READ_TOOLS } from "./security/constants.js";
import { ApprovalManager, type ApprovalPreview } from "./gateway/approval.js";
import { PairingStore } from "./pairing/store.js";
import { PairingService } from "./pairing/service.js";
import {
  DaemonConfirmService,
  type ConfirmService,
} from "./services/trading-confirm.js";
import { isConfirmable, describeConfirm } from "./services/confirm-policy.js";
import { EventBus } from "./bus/events.js";
import { WalletEvents } from "./events/wallet-events.js";
import { ToolEvents } from "./events/tool-events.js";
import { HyperliquidClient } from "./services/live/client.js";
import type { ITradingClient } from "./services/interfaces/trading-client.js";
import { PaperTradingClient } from "./services/paper/client.js";
import { IntelService } from "./services/intel.js";
import { WatchlistService } from "./services/watchlist/service.js";
import { AlertRulesService } from "./services/alert-rules.js";
import { NotificationsService } from "./services/notifications.js";
import { PriceCache, WatchlistPriceCache } from "./services/price-cache.js";
import { BinanceService } from "./services/binance.js";
import { NewsService } from "./services/news.js";
import { RssDiscoveryService } from "./services/rss-discovery.js";
import { TweetService } from "./services/tweets.js";
import { PreferenceStore } from "./services/preferences.js";
import { createTimezoneService, type TimezoneService } from "./services/timezone.js";
import { buildBuiltInJobs } from "./scheduler/defaults.js";
import { XFollowService } from "./services/x-follows.js";
import { XQueryIdCache } from "./services/x-query-ids.js";
import { TaIndicatorService } from "./services/ta-indicators.js";
import { TaLevelsService } from "./services/ta-levels.js";
import { ChartSeriesService } from "./services/chart-series.js";
import { WhaleTrackingService } from "./services/whale-tracking.js";
import { LiquidationMapService } from "./services/liquidation-map.js";
import { TimingRiskService } from "./services/timing-risk.js";
import { CrossExchangeService } from "./services/cross-exchange.js";
import {
  FundingRateCache,
  BinanceFundingProvider,
  BybitFundingProvider,
  OkxFundingProvider,
} from "./services/funding/index.js";
import { createAllTradingTools } from "./tools/trading/index.js";
import { WalletStore } from "./services/live/wallet-store.js";
import type { IWalletStore } from "./services/interfaces/wallet-store.js";
import { PaperWalletStore } from "./services/paper/wallet-store.js";
import { join } from "node:path";
import { existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import type { Database } from "bun:sqlite";
import type { Config, TradingMode } from "./config/schema.js";
import type { ToolRegistry } from "./tools/registry.js";
import { Runner } from "./agent/runner.js";
import { ChartRenderer } from "./channels/telegram/chart-renderer.js";
import { ObserverLoop } from "./observer/loop.js";

// ---------------------------------------------------------------------------
// Runtime interface
// ---------------------------------------------------------------------------

export interface Runtime {
  agent: Agent;
  /**
   * Background task agent — separate Agent instance used by daemon background
   * loops (news summarize, evaluate). Has bypassConfirm=true so it never
   * deadlocks on a user confirm card.
   */
  taskAgent: Agent;
  /**
   * Serializes all calls to `taskAgent` via a single-flight promise chain.
   * Use this instead of mutating taskAgent.state directly — concurrent callers
   * (background loops + gateway endpoints) would otherwise corrupt each other's
   * results silently.
   */
  runner: Runner;
  config: Config;
  logger: Logger;
  db: Database;
  memoryStore: MemoryStore;
  sessionManager: SessionManager;
  consolidator: MemoryConsolidator;
  security: SecurityPolicy;
  leakDetector: LeakDetector;
  tools: ToolRegistry;
  oauthManager: OAuthManager;
  workspaceDir: string;
  contextBuilder: ContextBuilder;
  skillsLoader: SkillsLoader;
  bus: MessageBus;
  orchestrator: Orchestrator;
  dispatcher: MessageDispatcher;
  cronService: CronService;
  credentials: CredentialStore;
  secretStore: SecretStore;
  tradingClient: ITradingClient;
  /** Set only when paper mode is enabled. Exposed so the eval harness can
   *  reset per-persona account state (balance, positions, orders) between
   *  trader journeys without tearing down the whole runtime. */
  paperClient?: PaperTradingClient;
  walletStore: IWalletStore;
  alertRules: AlertRulesService;
  notifications: NotificationsService;
  priceCache: PriceCache;
  watchlistPriceCache: WatchlistPriceCache;
  binance: BinanceService;
  newsService: NewsService;
  rssDiscoveryService: RssDiscoveryService;
  tweetService: TweetService;
  preferenceStore: PreferenceStore;
  timezoneService: TimezoneService;
  xFollowService: XFollowService;
  skillService: SkillService;
  chartSeries: ChartSeriesService;
  taLevels: TaLevelsService;
  watchlistService: WatchlistService;
  intelService: IntelService;
  approvalManager: ApprovalManager;
  confirmService: ConfirmService;
  eventBus: EventBus;
  pairingStore: PairingStore;
  pairingService: PairingService;
  channelManager: ChannelManager;
  walletReady: Promise<void>;
  versionCheck: VersionCheck;
  customModelRegistry: CustomModelRegistry;
  /** Headless WebView screenshot renderer for chart images. */
  chartRenderer: ChartRenderer;
  /**
   * Unified observer loop — the sole proactive/alert scanner. Always
   * constructed; the `observer.enabled` config flag only gates whether
   * the background job ticks it.
   */
  observerLoop: ObserverLoop;
}

// ---------------------------------------------------------------------------
// Composition root
// ---------------------------------------------------------------------------

export interface RuntimeOptions {
  logger: Logger;
  configPath?: string;
  mode?: TradingMode;
  paperBalance?: number;
  /**
   * Confirm-service override. When set, this replaces the default Cli/Daemon
   * confirm implementation. Used by the eval harness to auto-approve trading
   * prompts — without it, the daemon confirm waits for a gateway user that
   * never arrives, times out after 5 minutes, and the trace shows Ghost
   * saying "order cancelled" as if the trader rejected. Auto-approving lets
   * eval scenarios measure "does Ghost call the right write tool with the
   * right params" without hanging on UI.
   */
  confirmServiceOverride?: ConfirmService;
}

export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const configPath = options.configPath ?? getConfigPath();
  const rawConfig = loadConfig(configPath);
  // Run config migrations before any service reads from config. Migration
  // failures throw and surface to the caller — no services constructed,
  // no half-migrated state.
  const migrated = await runConfigMigrations(rawConfig, CONFIG_MIGRATIONS);
  const config = migrated.config;
  if (migrated.dirty) saveConfig(config, configPath);
  if (options.mode) {
    config.mode = options.mode;
    if (options.mode === "paper" && options.paperBalance !== undefined) {
      config.paper = { ...config.paper, initialBalance: options.paperBalance };
    }
  }
  const testnet = config.mode === "testnet";
  const paperMode = config.mode === "paper";
  const logger = options.logger;
  const workspaceDir = getWorkspaceDir();
  seedWorkspaceTemplates(workspaceDir);

  // Custom model registry — loads ~/.ghost/models.json for Ollama / vLLM /
  // LM Studio / any OpenAI-compatible endpoint. Failures are non-fatal; the
  // registry tracks loadErrors so `ghost doctor` can surface them.
  const customModelRegistry = loadCustomModelRegistry(getModelsConfigPath(), {
    logger: logger.child({ module: "models-config" }),
  });
  for (const err of customModelRegistry.loadErrors) {
    logger.warn({ err }, "models.json load error");
  }

  // Infrastructure (single instances, shared across subsystems)
  const db = initDatabase(getDbPath());
  // Apply DB migrations before any service queries the database.
  await runDbMigrations(db, DB_MIGRATIONS);
  const pairingStore = new PairingStore(db, logger.child({ module: "pairing" }));
  const secretStore = new SecretStore(getSecretKeyPath());
  const credentials = new CredentialStore(
    getCredentialsPath(), secretStore,
    logger.child({ module: "credentials" }),
  );
  const bus = new MessageBus();

  // Persistence
  const memoryStore = new MemoryStore(workspaceDir);
  const sessionManager = new SessionManager(workspaceDir);

  // Security
  const security = new SecurityPolicy(config.autonomy.level, {
    allowedCommands: config.security.allowedCommands,
    workspaceDir,
    forbiddenPaths: config.security.blockedPaths,
    blockHighRiskCommands: config.autonomy.blockHighRiskCommands,
    requireApprovalForMediumRisk: config.autonomy.requireApprovalForMediumRisk,
  });
  const leakDetector = new LeakDetector();
  const oauthManager = new OAuthManager(credentials);

  // Skills + context
  const builtinSkillsDir = config.skills.builtinSkillsDir
    ? expandHome(config.skills.builtinSkillsDir)
    : resolveDefaultBuiltinSkillsDir();
  const skillsLoader = new SkillsLoader(workspaceDir, builtinSkillsDir);
  const skillService = new SkillService(db, skillsLoader);
  skillService.syncState();

  // Preference store and timezone service must be created before ContextBuilder
  // so the live TZ getter can be passed in at construction time.
  const preferenceStore = new PreferenceStore(db, logger.child({ module: "prefs" }));
  const timezoneService = createTimezoneService(preferenceStore);

  // contextBuilder is created early — tool list wired after tools are registered
  const contextBuilder = new ContextBuilder(
    { workspaceDir, model: config.model, getTimezone: () => timezoneService.get() },
    memoryStore,
    skillsLoader,
  );
  contextBuilder.setDisabledSkillsProvider(() => skillService.getDisabledNames());

  // Tools (generic + trading)
  const cronService = new CronService(db);
  const tools = createToolRegistry(security, {
    cronService,
    timezoneService,
    memoryStore,
    logger: logger.child({ module: "tool" }),
  });

  const hyperLiquidClient = new HyperliquidClient({ testnet }, logger.child({ module: "hl" }));
  const paperClient = paperMode
    ? new PaperTradingClient(hyperLiquidClient, config.paper)
    : undefined;
  const tradingClient: ITradingClient = paperClient ?? hyperLiquidClient;

  const walletStore: IWalletStore = paperMode
    ? new PaperWalletStore()
    : new WalletStore(db, credentials);
  const watchlistService = new WatchlistService(db);
  const newsService = new NewsService(db, watchlistService, credentials, logger.child({ module: "news" }));
  const tweetService = new TweetService(db, logger.child({ module: "tweets" }));
  const xQueryIdCache = new XQueryIdCache();
  const xFollowService = new XFollowService(db, credentials, xQueryIdCache, logger.child({ module: "x-follows" }));
  const taIndicators = new TaIndicatorService(tradingClient);
  const taLevels = new TaLevelsService(tradingClient);
  const chartSeries = new ChartSeriesService(tradingClient);
  const whaleTracking = new WhaleTrackingService(tradingClient);
  const liquidationMap = new LiquidationMapService(tradingClient);
  const timingRisk = new TimingRiskService(tradingClient, taIndicators);
  // CrossExchangeService — direct REST calls to each CEX, no web search dependency.
  // Single shared cache across all providers avoids duplicate fetches within one agent turn.
  const fundingCache = new FundingRateCache();
  const crossExchange = new CrossExchangeService([
    new BinanceFundingProvider(fundingCache, logger.child({ module: "funding-binance" })),
    new BybitFundingProvider(fundingCache, logger.child({ module: "funding-bybit" })),
    new OkxFundingProvider(fundingCache, logger.child({ module: "funding-okx" })),
  ], logger.child({ module: "cross-exchange" }));

  // Approval + EventBus
  const approvalManager = new ApprovalManager();
  const eventBus = new EventBus(logger.child({ module: "bus" }));
  const pairingService = new PairingService(pairingStore, eventBus, logger.child({ module: "pairing" }));
  // AlertRulesService publishes its own `trading.alert.set` /
  // `trading.alert.removed` events on add/remove via the injected
  // EventBus. No external bridge needed.
  const alertRules = new AlertRulesService(db, eventBus);
  const notifications = new NotificationsService(db);
  const priceCache = new PriceCache();
  const watchlistPriceCache = new WatchlistPriceCache();

  // Binance USDⓈ-M universe + native klines. Boot-only load — perp
  // listings change order of days; restart Ghost to pick up new pairs. Errors
  // swallowed inside load() so daemon boots even if Binance is unreachable.
  const binance = new BinanceService({ logger: logger.child({ module: "binance" }) });
  if (config.priceFeed.binanceEnabled) void binance.load();

  // Provider resolution — returns the LLM model (no module-level state).
  const model = resolveProvider(config, customModelRegistry);
  if (!model)
    throw new Error(`Unknown model: ${config.provider}/${config.model}`);

  // Late-bound confirm service — populated after the Orchestrator (and the
  // DaemonConfirmService it depends on) are constructed below. The orchestrator-
  // level confirm interceptor in `makeBeforeToolCall` reads from this lazily,
  // so `buildAgentOptions` can finish even though the service isn't ready yet.
  let confirmServiceRef: ConfirmService | null = null;

  // Build initial agent — system prompt starts with only generic tools;
  // Orchestrator refreshes the prompt (via contextBuilder.buildFullPrompt) on
  // every prompt() call, so trading tools registered later become visible.
  const agent = createAgent({
    config,
    model,
    security,
    leakDetector,
    oauthManager,
    tools,
    systemPrompt: contextBuilder.buildSystemPrompt(),
    credentials,
    extraReadDirs: builtinSkillsDir ? [builtinSkillsDir] : [],
    approvalManager,
    eventBus,
    logger,
    customModelRegistry,
    confirmDeps: { getConfirmService: () => confirmServiceRef, approvalManager },
  });

  // Background task agent — second Agent instance for daemon background loops.
  // bypassConfirm=true: no user session → never show confirm cards.
  // confirmDeps returns null: background callers never need confirmService.
  const taskAgent = createAgent({
    config,
    model,
    security,
    leakDetector,
    oauthManager,
    tools,
    systemPrompt: "You are a Ghost background task agent. Reply concisely.",
    credentials,
    extraReadDirs: builtinSkillsDir ? [builtinSkillsDir] : [],
    approvalManager,
    eventBus,
    logger: logger.child({ module: "task-agent" }),
    customModelRegistry,
    confirmDeps: { getConfirmService: () => null },
    bypassConfirm: true,
    taskMode: true,
  });

  // Serializes all taskAgent calls — prevents concurrent callers from
  // corrupting each other's systemPrompt/messages state. Registry refreshes
  // the agent tool snapshot per call; logger warns on empty-text outcomes.
  const runner = new Runner(taskAgent, sessionManager, tools, logger.child({ module: "runner" }));

  const rssDiscoveryService = new RssDiscoveryService(runner, logger.child({ module: "rss-discovery" }));

  // Consolidator — uses runner (taskAgent) for LLM-driven consolidation.
  // save_memory tool is already registered in `tools` so the taskAgent can
  // call it when the consolidation prompt fires.
  const consolidator = new MemoryConsolidator({
    store: memoryStore,
    sessionManager,
    runner,
    contextWindowTokens: config.memory.contextWindowTokens,
    maxCompletionTokens: config.memory.maxCompletionTokens,
    maxConsolidationRounds: config.memory.maxConsolidationRounds,
    logger: logger.child({ module: "consolidator" }),
  });

  // Orchestrator
  const orchestrator = new Orchestrator(
    agent,
    sessionManager,
    consolidator,
    contextBuilder,
    tools,
    logger.child({ module: "orchestrator" }),
  );

  // ConfirmService — needs orchestrator for preText snapshot in daemon mode.
  // Eval passes `confirmServiceOverride` to skip the approval wait entirely.
  const confirmService: ConfirmService = options.confirmServiceOverride
    ?? new DaemonConfirmService(approvalManager, eventBus, orchestrator);
  // Bind the late ref so `makeBeforeToolCall` can find it on the next tool call.
  confirmServiceRef = confirmService;

  // IntelService — shared between agent tools (market overview, trending) and
  // the gateway (per-coin stats endpoint feeding the chart drawer header).
  const intelService = new IntelService(
    tradingClient,
    config.priceFeed.binanceEnabled ? binance : undefined,
  );

  // Trading tools — pure executors. Confirm interception happens in
  // `makeBeforeToolCall` so individual tools no longer take a confirm fn.
  for (const t of createAllTradingTools({
    hl: tradingClient,
    walletStore,
    intel: intelService,
    sessionManager,
    watchlist: watchlistService,
    binance: config.priceFeed.binanceEnabled ? binance : undefined,
    alertRules,
    notifications,
    priceCache,
    taIndicators,
    taLevels,
    crossExchange,
    liquidationMap,
    timingRisk,
    whaleTracking,
    cronService,
    news: newsService,
    rssDiscovery: rssDiscoveryService,
    tweets: tweetService,
    xFollows: xFollowService,
    testnet,
    saveWalletConfig: paperMode
      ? async () => {}
      : async (address, privateKey) => {
          await walletStore.save({ address, privateKey, testnet });
          eventBus.publish(WalletEvents.changed({ action: "connect", address }));
        },
    disconnectWallet: paperMode
      ? async () => {
          tradingClient.disconnect();
          return null;
        }
      : async () => {
          const wallets = walletStore.listWallets();
          const defaultWallet = wallets.find((w) => w.isDefault);
          if (!defaultWallet) return null;
          await walletStore.remove(defaultWallet.address);
          const nextDefault = await walletStore.load();
          if (nextDefault) {
            tradingClient.connect(nextDefault);
          } else {
            tradingClient.disconnect();
          }
          eventBus.publish(WalletEvents.changed({
            action: "remove", address: defaultWallet.address,
          }));
          return { address: defaultWallet.address };
        },
    config,
    configPath,
  }))
    tools.register(t);

  // Wire tool summaries into context builder now that all tools are registered
  contextBuilder.setTools(
    tools.all().map((t) => ({ name: t.name, description: t.description })),
  );

  // Refresh agent's tool snapshot now that trading tools are registered.
  // Without this, Agent.state.tools remains the generic-only snapshot from
  // construction and trading tool calls return "Tool not found".
  agent.state.tools = tools.all();
  // Sync taskAgent's tool snapshot — filtered to read-only + save_memory + cron
  // so background loops cannot trigger exec/file-write/trading-write confirms.
  // Runner re-applies the same filter per call (see src/agent/runner.ts).
  taskAgent.state.tools = tools.taskAgentTools();

  const walletReady: Promise<void> = walletStore
    .load()
    .then((w) => { if (w) tradingClient.connect(w); })
    .catch((err: unknown) => { logger.warn({ err }, "wallet failed to load"); });

  const channelManager = new ChannelManager({
    logger: logger.child({ module: "channel-manager" }),
  });

  const dispatcher = new MessageDispatcher(
    bus,
    {
      sendProgress: config.dispatcher.sendProgress,
      sendToolHints: config.dispatcher.sendToolHints,
      sendMaxRetries: config.dispatcher.sendMaxRetries,
      maxConcurrentRequests: config.dispatcher.maxConcurrentRequests,
    },
    orchestrator,
    tools,
    channelManager,
    logger.child({ module: "dispatcher" }),
  );

  // Version-check service — single instance shared by status endpoint and
  // `ghost update`. Lazy: `getLatest()` fetches on first call and caches.
  const versionCheck = new VersionCheckService({
    logger: logger.child({ module: "version-check" }),
  });

  // ChartRenderer — headless WebView for Telegram chart screenshots.
  // Use 127.0.0.1 when gateway binds to 0.0.0.0 so the loopback URL is always
  // reachable from within the same process.
  const gatewayHost = config.gateway.host === "0.0.0.0" ? "127.0.0.1" : config.gateway.host;
  const gatewayBaseUrl = `http://${gatewayHost}:${config.gateway.port}`;
  const chartRenderer = new ChartRenderer(gatewayBaseUrl, logger.child({ module: "chart-renderer" }));

  // Unified observer loop — the sole proactive/alert scanner. Always
  // constructed; the BackgroundJobRunner gates whether `tick()` fires
  // each interval via the `observer.enabled` config flag.
  const observerLoop = new ObserverLoop({
    db,
    config: config.observer,
    tradingClient,
    alertRules,
    newsService,
    notifications,
    priceCache,
    approvalManager,
    sessionManager,
    eventBus,
    channelManager,
    pairingStore,
    runner,
    contextBuilder,
    logger: logger.child({ module: "observer" }),
    getMessageBus: () => bus,
  });

  return {
    agent,
    taskAgent,
    runner,
    config,
    logger,
    db,
    memoryStore,
    sessionManager,
    consolidator,
    security,
    leakDetector,
    tools,
    oauthManager,
    workspaceDir,
    contextBuilder,
    skillsLoader,
    bus,
    orchestrator,
    dispatcher,
    cronService,
    credentials,
    secretStore,
    tradingClient,
    ...(paperClient ? { paperClient } : {}),
    walletStore,
    alertRules,
    notifications,
    priceCache,
    watchlistPriceCache,
    binance,
    newsService,
    rssDiscoveryService,
    tweetService,
    preferenceStore,
    timezoneService,
    xFollowService,
    skillService,
    chartSeries,
    taLevels,
    watchlistService,
    intelService,
    approvalManager,
    confirmService,
    eventBus,
    pairingStore,
    pairingService,
    channelManager,
    walletReady,
    versionCheck,
    customModelRegistry,
    chartRenderer,
    observerLoop,
  };
}

// ---------------------------------------------------------------------------
// Agent options
// ---------------------------------------------------------------------------

/**
 * Resolve API key for a provider at call time.
 *
 * Resolution order:
 *   1. Custom registry (models.json) — literal apiKey, if configured.
 *   2. OAuth manager — refreshed token for OAuth providers.
 *   3. Credential store — long-lived user key.
 *
 * `customModelRegistry` is required: making it optional allowed regressions
 * at call sites where omitting the arg silently returned `undefined` for
 * custom-provider keys. Tests that do not need custom providers should pass
 * `EMPTY_CUSTOM_MODEL_REGISTRY` from `providers/models-config.js`.
 */
export function getApiKey(
  oauthManager: OAuthManager,
  credentials: CredentialStore,
  customModelRegistry: CustomModelRegistry,
): (provider: string) => Promise<string | undefined> {
  return async (provider: string) => {
    const customKey = customModelRegistry.getApiKey(provider);
    if (customKey) return customKey;
    const oauthKey = await oauthManager.getApiKey(provider);
    if (oauthKey) return oauthKey;
    const stored = await credentials.get("api_key");
    if (stored) return stored;
    return undefined;
  };
}

export interface ConfirmInterceptionDeps {
  /** Late-bound — set after orchestrator + confirmService are constructed. */
  getConfirmService: () => ConfirmService | null;
  approvalManager?: ApprovalManager;
}

/** Options for the createAgent() factory. */
export interface CreateAgentOptions {
  config: Config;
  model: Model<Api>;
  security: SecurityPolicy;
  leakDetector: LeakDetector;
  oauthManager: OAuthManager;
  tools: ToolRegistry;
  systemPrompt: string;
  credentials: CredentialStore;
  extraReadDirs: string[];
  approvalManager: ApprovalManager;
  eventBus: EventBus;
  logger: Logger;
  customModelRegistry: CustomModelRegistry;
  confirmDeps: ConfirmInterceptionDeps;
  /**
   * When true, the beforeToolCall hook skips the batched-confirm path
   * entirely. Use for taskAgent (background loops) where there is no
   * user session to present a confirm card to. Defaults to false.
   */
  bypassConfirm?: boolean;
  /**
   * When true, the agent's initial tool snapshot is filtered to the
   * taskAgent-safe subset (`tools.taskAgentTools()`). Pair with
   * `bypassConfirm: true` for background agents. Runner re-applies the same
   * filter per call, so this flag is defense-in-depth for the construction
   * window before the post-registration sync runs.
   */
  taskMode?: boolean;
}

/**
 * Factory: create an Agent from structured options. Extracted so the taskAgent
 * can construct a second agent instance without duplicating the
 * buildAgentOptions call pattern.
 */
export function createAgent(opts: CreateAgentOptions): Agent {
  const initialOptions = buildAgentOptions(
    opts.config,
    opts.model,
    opts.security,
    opts.leakDetector,
    opts.oauthManager,
    opts.tools,
    opts.systemPrompt,
    opts.credentials,
    opts.extraReadDirs,
    opts.approvalManager,
    opts.eventBus,
    opts.logger,
    opts.customModelRegistry,
    opts.confirmDeps,
    opts.bypassConfirm ?? false,
    opts.taskMode ?? false,
  );
  return new Agent(initialOptions);
}

export function buildAgentOptions(
  config: Config,
  model: Model<Api>,
  security: SecurityPolicy,
  leakDetector: LeakDetector,
  oauthManager: OAuthManager,
  tools: ToolRegistry,
  systemPrompt: string,
  credentials: CredentialStore,
  extraReadDirs: string[],
  approvalManager: ApprovalManager,
  eventBus: EventBus,
  logger: Logger,
  customModelRegistry: CustomModelRegistry,
  confirmDeps: ConfirmInterceptionDeps,
  bypassConfirm = false,
  taskMode = false,
): AgentOptions {
  // Qwen-on-Ollama needs `thinkingLevel: "off"` end-to-end so that
  // pi-agent forwards no `reasoningEffort`, which lets pi-ai's
  // `!!options?.reasoningEffort` coerce to `false` and ship
  // `chat_template_kwargs: { enable_thinking: false }` to Ollama. Ghost's
  // default `config.agent.thinkingLevel` is `"low"` — without this local
  // override, the entire Qwen auto-opt-in neutralizes itself. We compute an
  // effective value here and leave `config.agent.thinkingLevel` untouched,
  // so non-Qwen selections continue to honor the user's preference.
  const effectiveThinkingLevel =
    shouldForceThinkingOff({ id: model.id, baseUrl: model.baseUrl ?? "" })
      ? "off"
      : config.agent.thinkingLevel;

  return {
    initialState: {
      systemPrompt,
      model,
      tools: taskMode ? tools.taskAgentTools() : tools.all(),
      thinkingLevel: effectiveThinkingLevel,
    },
    getApiKey: getApiKey(oauthManager, credentials, customModelRegistry),
    beforeToolCall: makeBeforeToolCall(
      security,
      config.agent.maxToolIterations,
      extraReadDirs,
      approvalManager,
      eventBus,
      logger,
      confirmDeps,
      bypassConfirm,
    ),
    afterToolCall: makeAfterToolCall(leakDetector, logger),
    toolExecution: config.agent.parallelTools ? "parallel" : "sequential",
    thinkingBudgets: config.agent.thinkingBudgets,
    transformContext: makeTransformContext(config.agent.maxContextTokens),
  };
}

/** Resolve the LLM model. No module-level side effects. */
function resolveProvider(
  config: Config,
  customModelRegistry: CustomModelRegistry,
): Model<Api> | null {
  // Try the custom registry first — users can define Ollama / vLLM / LM Studio
  // endpoints in ~/.ghost/models.json without modifying Ghost code.
  const custom = customModelRegistry.find(config.provider, config.model);
  if (custom) return custom;
  return getModel(config.provider as KnownProvider, config.model as never) ?? null;
}

// ---------------------------------------------------------------------------
// Hook factories
// ---------------------------------------------------------------------------

const FILE_TOOLS = new Set(["read_file", "write_file", "edit_file"]);

const TOOL_ACTION_LABELS: Record<string, string> = {
  exec: "Execute Command",
  write_file: "Write File",
  edit_file: "Edit File",
  read_file: "Read File",
};

export async function requestToolApproval(
  approvalManager: ApprovalManager,
  eventBus: EventBus,
  toolName: string,
  summary: string,
  riskLevel: string,
): Promise<boolean> {
  // Broadcast via eventBus, await decision via approval promise.
  // `lines` carries tool-author content only (no chrome). Risk and
  // tool labels live on `riskAssessment` and `action`/`actionLabel` so that
  // renderers (web card, Telegram) can localize their own header chrome
  // instead of inheriting hardcoded English strings.
  const preview: ApprovalPreview = {
    action: toolName,
    actionLabel: TOOL_ACTION_LABELS[toolName] ?? toolName,
    lines: [summary],
    summary,
    details: { risk: riskLevel, tool: toolName },
    riskAssessment: riskLevel,
  };

  const sessionKey = `tool:${approvalManager.nextSeq()}`;
  const { approvalId, promise, createdAtMs } =
    approvalManager.create(sessionKey, preview);
  eventBus.publish(ToolEvents.approvalRequested({
    approvalId, preview, createdAtMs,
  }));

  const decision = await promise;
  eventBus.publish(ToolEvents.approvalResolved({
    approvalId, decision, ts: Date.now(),
  }));
  return decision === "approved";
}

/** Cached confirm decision per assistant message — set by the first
 *  confirmable call in that message, read by subsequent ones. */
interface BatchedConfirm {
  decision: "approved" | "rejected";
  reason?: string;
}

/**
 * Gather every confirmable tool call in `assistantMessage`, run one combined
 * confirm card, and cache the decision under the message identity. The cache
 * stores either the resolved decision OR the in-flight promise — every tool
 * call in the same assistant turn awaits the same promise so the user sees
 * exactly one card, even when calls arrive in parallel.
 *
 * Returns `null` when `toolCall.name` is non-confirmable AND no other call in
 * the same message is confirmable — in that case the loop should pass through
 * with no confirm card. Non-confirmable calls in a message that DOES contain
 * confirmable peers still wait on the batch decision so a rejected confirm
 * doesn't allow read-only-looking siblings to execute mid-batch.
 */
export async function runBatchedConfirm(
  assistantMessage: object,
  callName: string,
  callArgs: unknown,
  batchCache: WeakMap<object, BatchedConfirm | Promise<BatchedConfirm>>,
  confirmDeps: ConfirmInterceptionDeps,
  logger: Logger,
): Promise<BatchedConfirm | null> {
  const cached = batchCache.get(assistantMessage);
  if (cached) {
    return await cached;
  }

  const calls = collectToolCalls(assistantMessage);
  const confirmable = calls.filter((c) => isConfirmable(c.name));
  if (confirmable.length === 0) return null;

  const confirmService = confirmDeps.getConfirmService();
  if (!confirmService) {
    // Confirm service not yet wired (extremely early call). Default to
    // approve so we don't deadlock — but log it loudly.
    logger.warn({ tool: callName }, "confirm service not yet bound; allowing tool through");
    const decision: BatchedConfirm = { decision: "approved" };
    batchCache.set(assistantMessage, decision);
    return decision;
  }

  // Build the combined confirm card. Card content (title + bullets) is
  // generated mechanically per tool call by `describeConfirm` — the agent
  // does NOT author this string. For multi-step batches, each step's label
  // is the mechanical title (trailing "?" stripped) plus its bullets
  // inlined as a `" — bullet1, bullet2"` suffix, so safety data (SL/TP
  // levels, side/leverage, etc.) survives even though there's no separate
  // bullet area in the numbered-step UI.
  const isMulti = confirmable.length > 1;
  const promise = (async (): Promise<BatchedConfirm> => {
    let title: string;
    const lines: string[] = [];
    let steps: string[] | undefined;
    let extras: {
      wizard?: import("./services/wizard-data.js").WizardCardData;
      suggestedValue?: string;
      toolName?: string;
      symbol?: string;
    } | undefined;
    if (isMulti) {
      title = `Confirm ${confirmable.length} actions?`;
      const stepList: string[] = [];
      for (const c of confirmable) {
        // `ctx` intentionally omitted — multi-step bullets today are pure
        // params (Side / SL / TP / etc.) and don't read from the trading
        // context. If a future bullet needs free margin or mark price,
        // pre-fetch per unique symbol via Promise.all + Map<symbol, ctx>
        // and pass the corresponding entry here.
        const desc = describeConfirm(c.name, c.args);
        // Strip the trailing "?" from titles when used as a numbered
        // step label — multiple "?"s in a numbered list reads cluttered.
        // Strip trailing ASCII or full-width question mark — the latter is
        // common in CJK locales (the frontend `headerTitle` accepts both).
        const head = desc.title.replace(/[?？]\s*$/, "");
        const tail = desc.bullets.length > 0 ? ` — ${desc.bullets.join(", ")}` : "";
        stepList.push(`${head}${tail}`);
      }
      steps = stepList;
      // Multi-call batched cards intentionally drop the wizard payload —
      // rendering multiple wizards in a single card is confusing and the
      // numbered-step list already carries the safety data inline. Frontend
      // (Plan 2) skips wizard rendering when `preview.wizard` is undefined.
      extras = undefined;
    } else {
      const only = confirmable[0];
      const args = (only.args ?? {}) as Record<string, unknown>;
      const symbol = typeof args.symbol === "string" ? args.symbol : undefined;
      const desc = describeConfirm(only.name, only.args);
      // Title kept raw ("Place bracket: …"). Per-channel renderers add their
      // own prefix when desired — web's ActionCard prepends "Confirm "; the
      // Telegram channel renders the raw title as the bold header.
      title = desc.title;
      lines.push(...desc.bullets);
      extras = {
        wizard: desc.wizard,
        suggestedValue: desc.suggestedValue,
        symbol,
      };
    }
    try {
      const res = await confirmService.confirm(title, { lines, steps }, extras);
      return { decision: res.decision, reason: res.reason };
    } catch (err) {
      logger.warn({ err }, "confirm service threw; treating as rejected");
      return { decision: "rejected" };
    }
  })();

  batchCache.set(assistantMessage, promise);
  const settled = await promise;
  batchCache.set(assistantMessage, settled);
  return settled;
}

interface CollectedCall {
  name: string;
  args: unknown;
}

function collectToolCalls(assistantMessage: object): CollectedCall[] {
  const out: CollectedCall[] = [];
  const content = (assistantMessage as { content?: unknown }).content;
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; name?: unknown; arguments?: unknown };
    if (b.type === "toolCall" && typeof b.name === "string") {
      out.push({ name: b.name, args: b.arguments });
    }
  }
  return out;
}

function makeBeforeToolCall(
  security: SecurityPolicy,
  maxIterations: number,
  extraReadDirs: string[],
  approvalManager: ApprovalManager,
  eventBus: EventBus,
  logger: Logger,
  confirmDeps: ConfirmInterceptionDeps,
  bypassConfirm = false,
) {
  // Keyed by assistant message identity — every BeforeToolCallContext for
  // tool calls in the same assistant turn carries the same `assistantMessage`
  // object reference. Using a WeakMap means the cache is freed automatically
  // once the message is no longer referenced.
  const batchCache = new WeakMap<object, BatchedConfirm | Promise<BatchedConfirm>>();

  return async ({
    assistantMessage,
    toolCall,
    args,
    context,
  }: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
    let toolCalls = 0;
    for (let i = context.messages.length - 1; i >= 0; i--) {
      const role = (context.messages[i] as { role: string }).role;
      if (role === "user") break;
      if (role === "toolResult") toolCalls++;
    }
    if (toolCalls >= maxIterations) {
      logger.warn({ tool: toolCall.name, maxIterations, toolCalls }, "blocked tool: max iterations reached");
      return {
        block: true,
        reason: `Maximum tool iterations (${maxIterations}) reached.`,
      };
    }

    // ----- Orchestrator-level confirm interception -----
    // bypassConfirm=true: background taskAgent — no user session to confirm
    // with. Skip entirely so background loops never deadlock waiting for a
    // confirm card that no one will ever click.
    if (!bypassConfirm && assistantMessage) {
      const batched = await runBatchedConfirm(
        assistantMessage,
        toolCall.name,
        args,
        batchCache,
        confirmDeps,
        logger,
      );
      if (batched && batched.decision === "rejected") {
        const reasonMsg = batched.reason && batched.reason.length > 0
          ? `User declined. Reason: ${batched.reason}`
          : "User declined. Do not retry.";
        return { block: true, reason: reasonMsg };
      }
    }

    const op: "read" | "act" = READ_TOOLS.has(toolCall.name) ? "read" : "act";
    try {
      security.enforceToolOperation(op, toolCall.name);
    } catch (err) {
      if (err instanceof SecurityError) {
        logger.warn({ tool: toolCall.name, err }, "blocked tool: security policy");
        return { block: true, reason: err.message };
      }
      throw err;
    }
    const a = args as Record<string, unknown>;
    if (
      FILE_TOOLS.has(toolCall.name) &&
      typeof a.path === "string" &&
      !security.isPathAllowed(a.path)
    ) {
      // Allow read_file on extra directories (e.g. builtin skills)
      const resolvedPath = expandHome(a.path as string);
      const inExtra = toolCall.name === "read_file" &&
        extraReadDirs.some((dir) => resolvedPath === dir || resolvedPath.startsWith(dir + "/"));
      if (!inExtra) {
        // Request approval for file operations outside allowed paths
        logger.debug({ tool: toolCall.name, path: a.path }, "requesting approval for path");
        const approved = await requestToolApproval(
          approvalManager, eventBus, toolCall.name, a.path as string, "path_restricted",
        );
        if (!approved) {
          logger.warn({ tool: toolCall.name, path: a.path }, "blocked tool: user rejected path");
          return { block: true, reason: `User rejected: ${a.path}` };
        }
      }
    }
    if (toolCall.name === "exec" && typeof a.command === "string") {
      try {
        security.validateCommandExecution(a.command, false);
      } catch (err) {
        if (err instanceof SecurityError) {
          // Request approval for medium-risk commands instead of blocking
          if (err.code === "APPROVAL_REQUIRED") {
            const risk = security.classifyCommandRisk(a.command);
            logger.debug({ tool: toolCall.name, command: String(a.command).slice(0, 500), risk }, "requesting approval for exec");
            const approved = await requestToolApproval(
              approvalManager, eventBus, "exec", a.command, risk,
            );
            if (approved) {
              // Re-validate with approved=true
              try {
                security.validateCommandExecution(a.command, true);
                return undefined;
              } catch (retryErr) {
                if (retryErr instanceof SecurityError) {
                  logger.warn({ tool: toolCall.name, err: retryErr }, "blocked exec after approval");
                  return { block: true, reason: retryErr.message };
                }
                throw retryErr;
              }
            }
            logger.warn({ tool: toolCall.name, command: String(a.command).slice(0, 500) }, "blocked exec: user rejected");
            return { block: true, reason: "User rejected command execution" };
          }
          logger.warn({ tool: toolCall.name, command: String(a.command).slice(0, 500), err }, "blocked exec: security policy");
          return { block: true, reason: err.message };
        }
        throw err;
      }
    }
    return undefined;
  };
}

function makeAfterToolCall(leakDetector: LeakDetector, logger: Logger) {
  return async ({
    result,
  }: AfterToolCallContext): Promise<AfterToolCallResult | undefined> => {
    const text = result.content
      .filter(
        (c: TextContent | { type: string }): c is TextContent =>
          c.type === "text",
      )
      .map((c: TextContent) => c.text)
      .join("");
    const scrubbed = leakDetector.scrub(text);
    if (scrubbed.clean) return undefined;
    logger.warn("credential scrubbed from tool output");
    return { content: [{ type: "text", text: scrubbed.redacted }] };
  };
}

function makeTransformContext(maxTokens: number) {
  const estimate = (msgs: unknown[]) =>
    estimateTokensTiktoken(JSON.stringify(msgs));
  return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    if (estimate(messages) <= maxTokens) return messages;
    const target = Math.floor(maxTokens * 0.8);
    let pruned = messages;
    while (estimate(pruned) > target && pruned.length > 2) {
      const nextUser = pruned.findIndex(
        (m, i) => i > 0 && (m as { role: string }).role === "user",
      );
      if (nextUser <= 0) break;
      pruned = pruned.slice(nextUser);
    }
    const headRole = (pruned[0] as { role: string } | undefined)?.role;
    if (headRole && headRole !== "user" && pruned.length > 1) {
      const firstUser = pruned.findIndex(
        (m) => (m as { role: string }).role === "user",
      );
      if (firstUser > 0) pruned = pruned.slice(firstUser);
    }
    return pruned;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveDefaultBuiltinSkillsDir(): string | undefined {
  const candidate = join(import.meta.dir, "skills", "builtin");
  return existsSync(candidate) ? candidate : undefined;
}

function seedWorkspaceTemplates(workspaceDir: string): void {
  const templatesDir = join(import.meta.dir, "templates");
  if (!existsSync(templatesDir)) return;
  try {
    mkdirSync(workspaceDir, { recursive: true });
    for (const entry of readdirSync(templatesDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const target = join(workspaceDir, entry.name);
      if (!existsSync(target))
        copyFileSync(join(templatesDir, entry.name), target);
    }
  } catch {
    /* non-fatal */
  }
}
