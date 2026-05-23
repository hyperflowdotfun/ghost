// src/gateway/server.ts
import { Elysia, type AnyElysia } from "elysia";
import type { MemoryStore } from "../memory/store.js";
import type { Config } from "../config/schema.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SessionManager } from "../session/manager.js";
import type { CronService } from "../scheduler/service.js";
import type { Orchestrator } from "../agent/orchestrator.js";
import { RateLimiter } from "./rate-limit.js";
import { handleHealth } from "./health.js";
import { resolveWebDist, serveStatic, serveSpaFallback } from "./static.js";
import { MethodRegistry } from "./method-registry.js";
import { ClientManager } from "./client-manager.js";
import { registerWsHandler } from "./ws-handler.js";
import { registerStatusMethods } from "./status.js";
import { registerMemoryMethods } from "./memory.js";
import { registerToolsMethods } from "./tools.js";
import { registerSessionsMethods } from "./sessions.js";
import { registerCronMethods } from "./cron.js";
import { registerConfigMethods } from "./config.js";
import { registerChatMethods } from "./chat.js";
import { registerTradingMethods } from "./trading.js";
import { registerApprovalMethods } from "./approval-handlers.js";
import { registerToolApprovalMethods } from "./tool-approval-handlers.js";
import { registerSkillsMethods } from "./skills.js";
import { registerChannelsMethods } from "./channels.js";
import type { ApprovalManager } from "./approval.js";
import type { ITradingClient } from "../services/interfaces/trading-client.js";
import type { IWalletStore } from "../services/interfaces/wallet-store.js";
import type { AlertRulesService } from "../services/alert-rules.js";
import type { NotificationsService } from "../services/notifications.js";
import type { PriceCache } from "../services/price-cache.js";
import type { NewsService } from "../services/news.js";
import type { RssDiscoveryService } from "../services/rss-discovery.js";
import type { TweetService } from "../services/tweets.js";
import type { XFollowService } from "../services/x-follows.js";
import type { PreferenceStore } from "../services/preferences.js";
import type { TimezoneService } from "../services/timezone.js";
import type { SkillService } from "../services/skill-service.js";
import { handleChartData, type ChartDataDeps } from "./chart-data.js";
import type { WatchlistService } from "../services/watchlist.js";
import type { EventBus } from "../bus/events.js";
import type { MessageDispatcher } from "../channels/dispatcher.js";
import type { MessageBus } from "../bus/queue.js";
import type { PairingStore } from "../pairing/store.js";
import type { PairingService as PairingOrchestrator } from "../pairing/service.js";
import type { CredentialStore } from "../config/credentials.js";
import { ChannelManager } from "../channels/manager.js";
import { WalletEvents } from "../events/wallet-events.js";
import { TradingEvents } from "../events/trading-events.js";
import { CompositePriceFeed } from "../services/price-feed/composite.js";
import { HyperliquidSource } from "../services/price-feed/sources/hyperliquid.js";
import { BinanceSource } from "../services/price-feed/sources/binance.js";
import type { PriceSource } from "../services/price-feed/types.js";
import { TokensSnapshotService } from "../services/tokens-snapshot.js";
import type { VersionCheck } from "../update/version-check.js";
import type { Logger } from "pino";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";

/** Generate a fresh Ethereum keypair for use as a Hyperliquid API wallet. */
function generateApiWallet(): { privateKey: string; address: string } {
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  return { privateKey: pk, address: account.address };
}

/** Infrastructure dependencies. */
export interface GatewayCoreDeps {
  config: Config;
  configPath: string;
  logger: Logger;
}

/** Agent and session dependencies. */
export interface GatewayAgentDeps {
  orchestrator: Orchestrator;
  sessionManager: SessionManager;
  tools: ToolRegistry;
  memoryStore: MemoryStore;
  cronService: CronService;
  /** Live timezone service — used by config.timezone.{get,set} RPCs. */
  timezoneService: TimezoneService;
  skillService: SkillService;
  /** Shared taskAgent runner — exposed so on-demand LLM RPCs (e.g. news.summarize) can call it. */
  runner: import("../agent/runner.js").Runner;
}

/** Trading and market data dependencies. */
export interface GatewayTradingDeps {
  tradingClient: ITradingClient;
  walletStore: IWalletStore;
  alertRules: AlertRulesService;
  notifications: NotificationsService;
  priceCache: PriceCache;
  newsService: NewsService;
  rssDiscoveryService?: RssDiscoveryService;
  tweetService?: TweetService;
  xFollowService?: XFollowService;
  preferenceStore: PreferenceStore;
  watchlistService: WatchlistService;
  chartDataDeps?: ChartDataDeps;
}

/** All gateway dependencies. */
export interface GatewayDeps extends GatewayCoreDeps, GatewayAgentDeps, GatewayTradingDeps {
  approvalManager: ApprovalManager;
  eventBus: EventBus;
  channels?: Array<{ name: string; healthCheck?(): Promise<boolean> }>;
  /**
   * Version-check service for reporting latest registry version in the
   * status payload. Optional — omitted during tests that don't care.
   */
  versionCheck?: VersionCheck;
  /**
   * Wired so the gateway can live-register/unregister channels (story 17-03).
   * Optional for legacy callers / tests that don't exercise the
   * `channels.*` RPC surface.
   */
  dispatcher?: MessageDispatcher;
  bus?: MessageBus;
  pairingStore?: PairingStore;
  pairingService?: PairingOrchestrator;
  credentials?: CredentialStore;
  channelManager: ChannelManager;
}

export interface GatewayHandle {
  app: AnyElysia;
  clientManager: ClientManager;
  stopPriceFeed: () => void;
}

/** TTL for pending agent keys. */
const PENDING_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** EIP-712 types for Hyperliquid ApproveAgent — shared between generate and confirm. */
const approveAgentDomain = {
  name: "HyperliquidSignTransaction",
  version: "1",
  chainId: 42161,
  verifyingContract: "0x0000000000000000000000000000000000000000" as `0x${string}`,
} as const;

const approveAgentTypes = {
  "HyperliquidTransaction:ApproveAgent": [
    { name: "hyperliquidChain", type: "string" },
    { name: "agentAddress", type: "address" },
    { name: "agentName", type: "string" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

export function createGateway(gatewayConfig: Config["gateway"], deps: GatewayDeps): GatewayHandle {
  /** Temporary storage for generated API wallet keys pending ApproveAgent confirmation. */
  const pendingAgentKeys = new Map<string, { privateKey: string; agentAddress: string; nonce: number; createdAt: number }>();

  const rateLimiter = new RateLimiter(gatewayConfig.rateLimitRpm);
  const webDistDir = resolveWebDist();
  const channels = deps.channels ?? [];

  // -- Build method registry --------------------------------------------------
  const registry = new MethodRegistry();
  const clientManager = new ClientManager(deps.logger.child({ module: "client-manager" }));

  registerStatusMethods(registry.register.bind(registry), {
    config: deps.config, memoryStore: deps.memoryStore,
    channels, manager: deps.channelManager,
    clientManager, versionCheck: deps.versionCheck,
  });
  registerMemoryMethods(registry.register.bind(registry), { memoryStore: deps.memoryStore });
  registerToolsMethods(registry.register.bind(registry), { tools: deps.tools });
  registerSessionsMethods(registry.register.bind(registry), { sessionManager: deps.sessionManager });
  registerCronMethods(registry.register.bind(registry), { cronService: deps.cronService });
  registerConfigMethods(registry.register.bind(registry), {
    timezoneService: deps.timezoneService,
    cronService: deps.cronService,
  });
  const tokensSnapshot = new TokensSnapshotService(deps.tradingClient, deps.priceCache);
  registerTradingMethods(registry.register.bind(registry), { tradingClient: deps.tradingClient, walletStore: deps.walletStore, alertRules: deps.alertRules, notifications: deps.notifications, newsService: deps.newsService, rssDiscovery: deps.rssDiscoveryService, tweetService: deps.tweetService, xFollowService: deps.xFollowService, preferenceStore: deps.preferenceStore, watchlist: deps.watchlistService, logger: deps.logger, tokensSnapshot, priceCache: deps.priceCache, runner: deps.runner });
  registerApprovalMethods(registry.register.bind(registry), { approvalManager: deps.approvalManager });
  registerToolApprovalMethods(registry.register.bind(registry), { approvalManager: deps.approvalManager });
  registerSkillsMethods(registry.register.bind(registry), { skillService: deps.skillService });

  if (deps.dispatcher && deps.bus && deps.pairingStore && deps.pairingService && deps.credentials) {
    registerChannelsMethods(registry.register.bind(registry), {
      config: deps.config,
      credentials: deps.credentials,
      pairingStore: deps.pairingStore,
      pairingService: deps.pairingService,
      dispatcher: deps.dispatcher,
      bus: deps.bus,
      eventBus: deps.eventBus,
      approvalManager: deps.approvalManager,
      manager: deps.channelManager,
      commandServices: {
        tradingClient: deps.tradingClient,
        walletStore: deps.walletStore,
        newsService: deps.newsService,
        alertRules: deps.alertRules,
        priceCache: deps.priceCache,
      },
      logger: deps.logger,
    });
  }

  // Broadcast watchlist changes (from agent tools or RPC) to all connected clients
  deps.watchlistService.onChanged((action, symbol) => {
    deps.eventBus.publish(TradingEvents.watchlistChanged({ action, symbol }));
  });

  // -- Price broadcasting: composite feed with priority-based failover ---
  // Sources are started on first client connect and stopped on last disconnect.
  // Frontend sees the same `trading.price.update` topic regardless of which
  // underlying source is primary at any given moment (failover is transparent).
  const lastPrices = new Map<string, number>();

  const priceFeedConfig = deps.config.priceFeed;
  const priceFeedLogger = deps.logger.child({ module: "price-feed" });

  function buildPriceSources(): PriceSource[] {
    const sources: PriceSource[] = [
      new HyperliquidSource({
        testnet: false,
        tradingClient: deps.tradingClient,
        restIntervalMs: priceFeedConfig.hlRestIntervalMs,
        logger: priceFeedLogger.child({ source: "hyperliquid" }),
      }),
    ];
    if (priceFeedConfig.binanceEnabled) {
      sources.push(new BinanceSource({
        logger: priceFeedLogger.child({ source: "binance" }),
      }));
    }
    return sources;
  }

  const compositeFeed = new CompositePriceFeed(
    buildPriceSources(),
    {
      staleThresholdMs: priceFeedConfig.staleThresholdMs,
      stabilityWindowMs: priceFeedConfig.stabilityWindowMs,
    },
    priceFeedLogger,
  );

  function broadcastPrice(symbol: string, price: number, prevDayPrice?: number) {
    // Update cache unconditionally so prevDayPrice always reaches consumers,
    // even when the mark price hasn't changed between ticks (flat markets,
    // daily rollover updating prevDayPx while mark is pinned).
    deps.priceCache.set(symbol, price, prevDayPrice);
    const prev = lastPrices.get(symbol);
    // Skip re-broadcast only when price is flat AND there is no prevDayPrice
    // to propagate. When prevDayPrice is defined (daily rollover scenario) we
    // always emit so the FE gets the updated 24h baseline.
    if (prev === price && prevDayPrice === undefined) return;
    lastPrices.set(symbol, price);
    // Broadcast ALL price updates to FE — the token picker UI renders symbols
    // outside the watchlist and needs live ticks for them too. Per-tick payload
    // is ~50 bytes; HL push rate ~10-100 ticks/sec aggregate = <5 KB/s. FE
    // subscribers filter by symbol on the client side.
    // eventBus.publish is the single emit path — the daemon's generic
    // bus->broadcast forwarder (`eventBus.subscribe(clientManager.broadcast)`)
    // fans out to all WS clients under the event.type topic. Calling
    // clientManager.broadcast here would double-emit each tick.
    deps.eventBus.publish(TradingEvents.priceUpdate({ symbol, price, prevDayPrice }));
  }

  async function startPriceFeed() {
    if (!priceFeedConfig.enabled) {
      priceFeedLogger.info("price feed disabled by config");
      return;
    }
    lastPrices.clear();
    try {
      await compositeFeed.start((symbol, price, prevDayPrice) =>
        broadcastPrice(symbol, price, prevDayPrice));
    } catch (err) {
      priceFeedLogger.warn({ err }, "composite price feed failed to start");
    }
  }

  async function stopPriceFeed() {
    await compositeFeed.stop();
    lastPrices.clear();
    // Drop the shared cache too — its entries would silently grow stale
    // without a fresh tick source to refresh them, and stale data into
    // ghost_get_price would surprise the trader. Cache is rebuilt on
    // the next start.
    deps.priceCache.clear();
  }

  // Keep the feed running whenever WS clients OR active alert rules exist —
  // a Telegram-only trader needs the feed even with zero web clients.
  function shouldRunPriceFeed(): boolean {
    return clientManager.count > 0 || deps.alertRules.getActiveSymbols().size > 0;
  }

  // Serialize start/stop toggles at the gateway layer as well:
  // rapid connect/disconnect (hot reload, page refresh) must not allow a
  // second start() to run before the previous stop() has returned. The
  // composite feed already serializes internally, but chaining here keeps
  // lifecycle errors observable (otherwise unawaited rejections would be
  // swallowed).
  let priceFeedLifecycle: Promise<void> = Promise.resolve();
  function evaluateLifecycle(reason: string) {
    priceFeedLifecycle = priceFeedLifecycle
      .then(() => (shouldRunPriceFeed() ? startPriceFeed() : stopPriceFeed()))
      .catch((err) => {
        priceFeedLogger.error({ err, reason }, "price feed lifecycle transition failed");
      });
  }
  clientManager.onCountChange(() => evaluateLifecycle("client-count"));
  // Re-evaluate when an alert rule is added or removed — the feed stays
  // up exactly as long as needed. AlertRulesService publishes these
  // events itself; no internal subscription path needed.
  deps.eventBus.subscribe((e) => {
    if (e.type === "trading.alert.set" || e.type === "trading.alert.removed") {
      evaluateLifecycle(`rule-${e.type}`);
    }
  });

  const chatHandle = registerChatMethods(registry.register.bind(registry), {
    orchestrator: deps.orchestrator,
    sessionManager: deps.sessionManager,
    logger: deps.logger,
  });

  // -- Build Elysia app -------------------------------------------------------
  let app: AnyElysia = new Elysia()
    // Public REST endpoints
    .get("/health", () => handleHealth())

    // Wallet API — REST endpoints for MetaMask/Rabby flow (01-02)
    // Wallet endpoints are unauthenticated. Deployment must restrict access
    // via gateway.host=127.0.0.1 (default) or an external ACL / tunnel.
    .post("/api/wallet/connect", async ({ body, set }) => {
      const { address, testnet, source } = body as { address?: string; testnet?: boolean; source?: string };
      if (!address || typeof address !== "string" || !address.startsWith("0x")) {
        set.status = 400; return { error: "Valid address required (0x...)" };
      }
      const walletSource = typeof source === "string" && source.length > 0 ? source : "unknown";
      const isNew = await deps.walletStore.addWatch(address, testnet ?? false, walletSource);
      if (isNew) {
        deps.eventBus.publish(WalletEvents.changed({ action: "connect", address }));
      }
      return { ok: true, address, status: "watch", isNew };
    })
    .post("/api/wallet/generate-agent", async ({ body, set }) => {
      const { address } = body as { address?: string };
      if (!address || typeof address !== "string") {
        set.status = 400; return { error: "Wallet address required" };
      }
      const addr = address.toLowerCase();
      const wallet = deps.walletStore.getWallet(addr);
      if (!wallet) { set.status = 404; return { error: "Wallet not found. Connect wallet first." }; }
      const { privateKey, address: agentAddress } = generateApiWallet();
      const nonce = Date.now();
      pendingAgentKeys.set(addr, { privateKey, agentAddress, nonce, createdAt: Date.now() });
      return { ok: true, agentAddress, nonce };
    })
    .post("/api/wallet/confirm-agent", async ({ body, set }) => {
      const { address, signature } = body as { address?: string; signature?: string };
      if (!address) { set.status = 400; return { error: "address required" }; }
      const addr = address.toLowerCase();
      const pending = pendingAgentKeys.get(addr);
      if (!pending) { set.status = 400; return { error: "No pending agent wallet for this address" }; }
      // TTL check
      if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
        pendingAgentKeys.delete(addr);
        set.status = 400; return { error: "Pending agent expired. Please retry." };
      }
      // No signature = user cancelled
      if (!signature) {
        pendingAgentKeys.delete(addr);
        return { ok: true, reverted: true };
      }
      // Verify the EIP-712 signature matches the wallet address
      const valid = await verifyTypedData({
        address: address as `0x${string}`,
        domain: approveAgentDomain,
        types: approveAgentTypes,
        primaryType: "HyperliquidTransaction:ApproveAgent",
        message: {
          hyperliquidChain: "Mainnet",
          agentAddress: pending.agentAddress as `0x${string}`,
          agentName: "ghost",
          nonce: BigInt(pending.nonce),
        },
        signature: signature as `0x${string}`,
      });
      pendingAgentKeys.delete(addr);
      if (!valid) {
        set.status = 403; return { error: "Signature verification failed" };
      }
      const wallet = deps.walletStore.getWallet(addr);
      if (!wallet) { set.status = 400; return { error: "Wallet not found. Connect wallet again." }; }
      await deps.walletStore.enableTrading(addr, pending.agentAddress, pending.privateKey);
      deps.tradingClient.connect({ address: addr, privateKey: pending.privateKey, testnet: wallet.testnet });
      deps.eventBus.publish(WalletEvents.changed({ action: "trading-enabled", address: addr }));
      return { ok: true };
    })
    .get("/api/wallets", () => {
      return deps.walletStore.listWallets();
    })
    .post("/api/wallet/remove", async ({ body, set }) => {
      const { address } = body as { address?: string };
      if (!address) { set.status = 400; return { error: "address required" }; }
      const wallet = deps.walletStore.getWallet(address);
      if (!wallet) { set.status = 404; return { error: "Wallet not found" }; }
      await deps.walletStore.remove(address);
      const nextDefault = await deps.walletStore.load();
      if (nextDefault) { deps.tradingClient.connect(nextDefault); }
      else { deps.tradingClient.disconnect(); }
      deps.eventBus.publish(WalletEvents.changed({ action: "remove", address }));
      return { ok: true, address };
    })
    .post("/api/wallet/set-default", async ({ body, set }) => {
      const { address } = body as { address?: string };
      if (!address) { set.status = 400; return { error: "address required" }; }
      const wallet = deps.walletStore.getWallet(address);
      if (!wallet) { set.status = 404; return { error: "Wallet not found" }; }
      if (wallet.status !== "trading") { set.status = 400; return { error: "Only trading-enabled wallets can be set as default" }; }
      deps.walletStore.setDefault(address);
      const data = await deps.walletStore.load();
      if (data) deps.tradingClient.connect(data);
      deps.eventBus.publish(WalletEvents.changed({ action: "set-default", address }));
      return { ok: true, address };
    })
    .post("/api/wallet/disconnect-source", async ({ body }) => {
      const { source } = body as { source?: string };
      if (typeof source !== "string" || source.length === 0) return { ok: true, removed: [] };
      const removed = await deps.walletStore.removeBySource(source);
      if (removed.length > 0) {
        const nextDefault = await deps.walletStore.load();
        if (nextDefault) {
          deps.tradingClient.connect(nextDefault);
        } else {
          deps.tradingClient.disconnect();
        }
        deps.eventBus.publish(WalletEvents.changed({ action: "disconnect-source", source, removed }));
      }
      return { ok: true, removed };
    })
    // Chart data REST endpoint
    .get("/api/chart-data", async ({ query, set }) => {
      if (!deps.chartDataDeps) { set.status = 503; return { error: "Chart data service not available" }; }
      const result = await handleChartData(query as Record<string, string | undefined>, deps.chartDataDeps);
      set.status = result.status;
      return result.body;
    })

    // Skill file upload (multipart form)
    .post("/skills/upload", async ({ request, set }) => {
      const formData = await request.formData();
      const file = formData.get("file") as File | null;
      const overwrite = formData.get("overwrite") === "true";
      if (!file) { set.status = 400; return { ok: false, errors: ["No file provided"] }; }
      const buffer = Buffer.from(await file.arrayBuffer());
      const result = deps.skillService.uploadSkill(buffer, file.name, overwrite);
      if (!result.ok) { set.status = result.conflict ? 409 : 400; }
      return result;
    })

    // SPA root
    .get("/", async () => {
      if (!webDistDir) return new Response("Ghost gateway running. Build the web dashboard with `bun run web:build`.", { headers: { "Content-Type": "text/plain" } });
      return serveSpaFallback(webDistDir);
    })

    // Static assets
    .get("/_app/*", async ({ request }) => {
      if (!webDistDir) return new Response("Not Found", { status: 404 });
      const url = new URL(request.url);
      return (await serveStatic(webDistDir, url.pathname)) ?? new Response("Not Found", { status: 404 });
    })

    // SPA fallback
    .onError(({ code, request, set }) => {
      if (code === "NOT_FOUND" && request.method === "GET" && !request.url.includes("/_app/") && !request.url.includes("/api/")) {
        if (!webDistDir) return new Response("Ghost gateway running. Build the web dashboard: bun run web:build", { headers: { "Content-Type": "text/plain" } });
        return serveSpaFallback(webDistDir);
      }
      set.status = 404;
      return { error: "Not Found" };
    });

  // Mount WebSocket handler
  app = registerWsHandler(app, {
    registry, clientManager,
    eventBus: deps.eventBus,
    rateLimitRpm: gatewayConfig.rateLimitRpm,
    onClientDisconnect: (clientId) => chatHandle.abortRunsForClient(clientId),
  });

  return { app, clientManager, stopPriceFeed };
}
