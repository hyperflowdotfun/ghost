/**
 * Ghost daemon boot sequence.
 *
 * Reads top-to-bottom as a boot log:
 *    1. Guard against duplicate instances (TTY-only OS service check).
 *    2. Create runtime (config, DB, all services).
 *    3. Boot guard: refuse non-loopback bind without explicit opt-in.
 *    4. Auth display string.
 *    5. Activate Telegram channel (construct + register).
 *    6. Create gateway (ElysiaJS app + WebSocket + REST).
 *    7. EventBus → web broadcast (fired price alerts flow through observer).
 *    8. Cron delivery handler.
 *    9. Start channels + scheduler.
 *   10. Start background jobs.
 *   11. Await wallet readiness → listen on gateway port.
 *   12. Print startup banner.
 *   13. Install signal handlers.
 */

import { createRuntime } from "../runtime.js";
import { createGateway } from "../gateway/server.js";
import { getConfigPath } from "../config/index.js";
import { createCronDeliveryHandler } from "../scheduler/delivery.js";
import { printDaemonStartupBanner } from "../helpers/banner.js";
import { BackgroundJobRunner, registerDefaultJobs } from "./jobs/index.js";
import { installShutdownHandlers } from "./shutdown.js";
import { telegramPlugin } from "../channels/telegram/plugin.js";
import { ChannelId } from "../channels/types.js";
import { ChannelEvents } from "../events/pairing-events.js";
import { buildBuiltInJobs } from "../scheduler/defaults.js";
import { EXIT_UNCAUGHT_EXCEPTION, EXIT_UNHANDLED_REJECTION } from "../helpers/exit-codes.js";

import type { TradingMode } from "../config/schema.js";
import type { Logger } from "pino";

// ---------------------------------------------------------------------------
// TTY guard — prompts user when OS service is already running.
// Only active in interactive terminals (stdin.isTTY). Service managers
// (systemd, launchd, schtasks) never attach a TTY, so this is skipped
// in non-interactive contexts.
// ---------------------------------------------------------------------------

async function guardAgainstRunningService(logger: Logger): Promise<void> {
  if (!process.stdin.isTTY) return;

  let controller: import("../services/os/controller.js").ServiceController;
  try {
    const { resolveServiceController } = await import("../services/os/controller.js");
    controller = resolveServiceController(logger);
  } catch {
    return;
  }

  const status = await controller.status();
  if (status !== "running") return;

  const { select, isCancel } = await import("@clack/prompts");
  console.log("");
  const action = await select({
    message: "Ghost is already running as a background service",
    options: [
      { value: "logs",    label: "View logs (ghost logs -f)" },
      { value: "restart", label: "Restart service" },
      { value: "stop",    label: "Stop service and start foreground daemon" },
      { value: "abort",   label: "Exit" },
    ],
  });
  if (isCancel(action) || action === "abort") {
    process.exit(0);
  }

  if (action === "logs") {
    const { runLogs } = await import("../commands/logs/index.js");
    await runLogs({ follow: true, json: false, plain: false, noColor: false });
    process.exit(0);
  }

  const { log } = await import("@clack/prompts");

  if (action === "restart") {
    log.info("Restarting Ghost service...");
    await controller.restart();
    log.success("Ghost service restarted. Streaming logs...\n");
    const { runLogs } = await import("../commands/logs/index.js");
    await runLogs({ follow: true, json: false, plain: false, noColor: false });
    process.exit(0);
  }

  if (action === "stop") {
    log.info("Stopping Ghost service...");
    await controller.stop();
    log.info("Service stopped. Starting foreground daemon...\n");
    return;
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DaemonOptions {
  logger: Logger;
  configPath?: string;
  mode?: TradingMode;
  paperBalance?: number;
}

// ---------------------------------------------------------------------------
// broadcastEventToWeb — EventBus → web fan-out with per-event-type isolation.
// ---------------------------------------------------------------------------

interface TradingApprovalEventPayload {
  origin?: { channel: string; chatId: string } | null;
}

/**
 * Isolates trading.approval.* events to the origin channel — telegram-origin
 * approvals must not leak to the web UI (and vice-versa). Other events,
 * including tool.approval.*, broadcast unchanged.
 */
export function broadcastEventToWeb(
  event: { type: string; payload: unknown },
  clientManager: { broadcast: (type: string, payload: unknown) => void },
): void {
  if (
    event.type === "trading.approval.requested" ||
    event.type === "trading.approval.resolved"
  ) {
    const origin = (event.payload as TradingApprovalEventPayload).origin;
    if (origin && origin.channel !== "web") return;
  }
  clientManager.broadcast(event.type, event.payload);
}

// ---------------------------------------------------------------------------
// startDaemon
// ---------------------------------------------------------------------------

export async function startDaemon(options: DaemonOptions): Promise<void> {
  const logger = options.logger;

  // 0. Handle uncaught errors — supervisor needs exit 100 / 101 to respawn.
  process.on("uncaughtException", (error) => {
    console.error("[ghost] Uncaught exception:", error);
    process.exit(EXIT_UNCAUGHT_EXCEPTION);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[ghost] Unhandled rejection:", reason);
    process.exit(EXIT_UNHANDLED_REJECTION);
  });

  // 1. Guard against duplicate instances (TTY-only OS service check).
  await guardAgainstRunningService(logger);

  // 2. Create runtime (config, DB migrations, all services wired).
  const configPath = options.configPath ?? getConfigPath();
  const runtime = await createRuntime({
    logger,
    configPath,
    mode: options.mode,
    paperBalance: options.paperBalance,
  });
  const {
    config,
    bus,
    dispatcher,
    orchestrator,
    cronService,
    sessionManager,
    credentials,
    tradingClient,
    walletStore,
    alertRules,
    notifications,
    priceCache,
    watchlistPriceCache,
    binance,
    newsService,
    rssDiscoveryService,
    tweetService,
    xFollowService,
    preferenceStore,
    timezoneService,
    security,
    leakDetector,
    skillService,
    chartSeries,
    taLevels,
    watchlistService,
    tools,
    memoryStore,
    contextBuilder,
  } = runtime;

  // 3. Boot guard: refuse to bind a non-loopback host without explicit opt-in.
  // Gateway has no in-app auth — the only safe defaults are loopback bind OR
  // an explicit acknowledgement of the exposure via allowPublicBind=true.
  const host = config.gateway.host;
  const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!isLoopback && !config.gateway.allowPublicBind) {
    throw new Error(
      `Gateway host "${host}" is not loopback and gateway.allowPublicBind is false. ` +
      `Set gateway.host to 127.0.0.1 OR set gateway.allowPublicBind=true to acknowledge the exposure.`,
    );
  }

  // 4. Auth display string (banner + status).
  await runtime.oauthManager.ensureLoaded();
  const hasApiKey = await credentials.has("api_key");
  const hasOAuth = runtime.oauthManager.listAuthenticated().length > 0;
  const authDisplay = hasOAuth
    ? `OAuth (${runtime.oauthManager.listAuthenticated().join(", ")})`
    : hasApiKey ? "API Key" : "\x1b[33m⚠ Not configured\x1b[0m";

  // 5. Activate Telegram channel if the bot token is present.
  // config.telegram is always defaulted by the schema — credentials are the
  // real signal for whether Telegram is connected.
  if (await credentials.has(`${ChannelId.Telegram}_token`)) {
    await runtime.channelManager.activateExisting(telegramPlugin, {
      config,
      credentials,
      bus,
      eventBus: runtime.eventBus,
      approvalManager: runtime.approvalManager,
      pairingStore: runtime.pairingStore,
      pairingService: runtime.pairingService,
      commandServices: { tradingClient, walletStore, newsService, alertRules, priceCache },
      logger: logger.child({ module: ChannelId.Telegram }),
      chartRenderer: runtime.chartRenderer,
    });
    dispatcher.ensureLoopsRunning();
    runtime.eventBus.publish(ChannelEvents.stateChanged({
      channel: ChannelId.Telegram,
      state: "connected",
    }));
    // Channel is started later by startAllChannels() — see step 10.
  }

  // 6. Create gateway (ElysiaJS app + WebSocket + REST).
  const gateway = createGateway(config.gateway, {
    config,
    orchestrator,
    memoryStore,
    tools,
    sessionManager,
    cronService,
    timezoneService,
    configPath,
    channels: runtime.channelManager.listChannels().map((ch) => ({ name: ch.name })),
    tradingClient,
    walletStore,
    alertRules,
    notifications,
    priceCache,
    watchlistPriceCache,
    binance,
    newsService,
    rssDiscoveryService,
    tweetService,
    xFollowService,
    preferenceStore,
    watchlistService,
    intelService: runtime.intelService,
    approvalManager: runtime.approvalManager,
    eventBus: runtime.eventBus,
    skillService,
    chartDataDeps: { chartSeries, taLevels, binance },
    versionCheck: runtime.versionCheck,
    dispatcher,
    bus,
    pairingStore: runtime.pairingStore,
    pairingService: runtime.pairingService,
    credentials,
    channelManager: runtime.channelManager,
    runner: runtime.runner,
    logger: logger.child({ module: "gateway" }),
  });
  const { app, clientManager, stopPriceFeed } = gateway;

  // 7. EventBus → web broadcast (event.type IS the WebSocket event name on
  //     the wire — renaming any type string is a breaking frontend change).
  //     Fired price alerts flow through the unified observer
  //     (scan → judge → dispatch) — no separate delivery service.
  const unsubscribeBus = runtime.eventBus.subscribe(
    (e) => broadcastEventToWeb(e, clientManager),
  );

  // 8. Cron delivery handler.
  cronService.setOnJob(createCronDeliveryHandler({
    runner: runtime.runner,
    contextBuilder,
    bus,
    eventBus: runtime.eventBus,
    tools,
    channelManager: runtime.channelManager,
    pairingStore: runtime.pairingStore,
    tradingClient: runtime.tradingClient,
    logger: logger.child({ module: "cron-delivery" }),
  }));

  // 9. Start channels + scheduler AFTER all deps are wired.
  void runtime.channelManager.startAllChannels();
  if (config.cron.enableScheduler) {
    // Seed built-in jobs with the stored TZ (snapshot is intentional — subsequent
    // changes go through cronService.updateBuiltinJobsTimezone(tz) via the gateway RPC).
    cronService.start({ defaults: buildBuiltInJobs(timezoneService.get()) });
  }

  // 10. Start background jobs BEFORE walletReady so news/X initial kicks run
  //    in parallel with the wallet probe. Fixes a cold-start feed delay and
  //    an onEnable race window.
  const runner = new BackgroundJobRunner({
    taskAgent: runtime.taskAgent,
    runner: runtime.runner,
    runtime,
    eventBus: runtime.eventBus,
    logger: logger.child({ module: "jobs" }),
    config,
  });
  registerDefaultJobs(runner, config);
  void runner.start();

  // Wire xFollowService.onEnable to kick tweet-fetch immediately when a
  // settings toggle or new follow lands — drives an immediate fetch cycle
  // instead of waiting for the next scheduled tick.
  runtime.xFollowService.onEnable(() => runner.kick("tweet-fetch"));

  // 11. Await wallet readiness, then bind the gateway listener. ensureMeta
  //     is best-effort — first-use retry handles a cold Hyperliquid endpoint.
  await runtime.walletReady;
  await tradingClient.ensureMeta().catch((err) => {
    logger.warn({ err }, "ensureMeta on startup failed — will retry on first use");
  });

  app.listen({ port: config.gateway.port, hostname: config.gateway.host });

  // 12. Print startup banner (after listen so port is confirmed bound).
  printDaemonStartupBanner({
    runtime,
    gateway: { host: config.gateway.host, port: config.gateway.port },
    authDisplay,
    enabledChannels: runtime.channelManager.listChannels().map((ch) => ch.name),
  });

  const gatewayUrl = `http://${config.gateway.host}:${config.gateway.port}`;
  logger.info({ module: "daemon" }, `Gateway listening on ${gatewayUrl}`);

  // 13. Install signal handlers (SIGINT + SIGTERM → clean shutdown).
  //     Crash path skips cleanup entirely — supervisor restart heals state
  //     via WAL replay, Telegram offset re-sync, and idempotent jobs.
  installShutdownHandlers({
    runtime,
    gatewayHandle: { stopPriceFeed, app },
    unsubscribeBus,
    stopBackground: () => runner.stop(),
  });
}
