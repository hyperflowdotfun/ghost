/**
 * Graceful shutdown on SIGINT / SIGTERM — drain background jobs, stop
 * channels, close gateway, close DB, exit(0).
 */

import type { Runtime } from "../runtime.js";

export interface ShutdownDeps {
  runtime: Runtime;
  /** Return value of gateway — need stopPriceFeed + app.stop */
  gatewayHandle: {
    stopPriceFeed: () => void;
    app: { stop: () => void };
  };
  unsubscribeBus: () => void;
  /** Returns a Promise so the shutdown sequence can await in-flight job completion. */
  stopBackground: () => Promise<void>;
}

/**
 * Install SIGINT and SIGTERM handlers. Runs the cleanup body on first signal,
 * then exits 0. Subsequent signals are ignored (re-entrancy guard).
 *
 * The cleanup is async so it can await BackgroundJobRunner.stop() before
 * tearing down the DB — preventing "database is closed" errors from jobs
 * that are still writing when the signal arrives.
 */
export function installShutdownHandlers(deps: ShutdownDeps): void {
  const {
    runtime,
    gatewayHandle,
    unsubscribeBus,
    stopBackground,
  } = deps;
  const { db, dispatcher, channelManager, cronService, chartRenderer } = runtime;
  const { stopPriceFeed, app } = gatewayHandle;

  let shuttingDown = false;
  // Separate flag guards process.exit — without it a second rapid SIGINT can
  // race past the shuttingDown check (cleanup() returns early) and call
  // process.exit(0) before the first signal's cleanup awaits have resolved.
  let exiting = false;

  const cleanup = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    unsubscribeBus();
    console.log("\nGhost daemon shutting down...");
    // Await in-flight background jobs before touching the DB — jobs may still
    // be writing summaries or news entries; closing the DB under them risks
    // "database is closed" errors and partially-persisted records.
    await stopBackground();
    stopPriceFeed();
    // Stop channels first so outbound bus drains naturally; then halt bus loops.
    // Await the channel stop so the ordering the comment promises actually holds —
    // dispatcher.stop() runs synchronously and would otherwise race the channel stops.
    await channelManager.stopAllChannels().catch(() => {});
    dispatcher.stop();
    cronService.stop();
    await chartRenderer.close().catch(() => {});
    app.stop();
    db.close();
  };

  const shutdownOnSignal = async () => {
    if (exiting) return;
    exiting = true;
    try {
      await cleanup();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", shutdownOnSignal);
  process.on("SIGTERM", shutdownOnSignal);
}
