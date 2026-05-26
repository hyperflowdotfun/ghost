/**
 * Daemon startup banner — pure presentation layer.
 * Snapshot-testable: all inputs arrive via parameters, no side-effects.
 */

import type { Runtime } from "../runtime.js";

// ANSI helpers
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

export interface BannerDeps {
  runtime: Runtime;
  gateway: { port: number; host: string };
  /** Auth string already formatted for display (e.g. "OAuth (anthropic)", "API Key"). */
  authDisplay: string;
  /** Enabled channel names from dispatcher. */
  enabledChannels: string[];
}

/**
 * Print the Ghost daemon startup banner to stdout.
 * Called once after app.listen() — ordering matters for readability.
 */
export function printDaemonStartupBanner(deps: BannerDeps): void {
  const { runtime, gateway, authDisplay, enabledChannels } = deps;
  const { config } = runtime;

  const gatewayUrl = `http://${gateway.host}:${gateway.port}`;
  const channelDisplay = enabledChannels.length > 0 ? enabledChannels.join(", ") : dim("none");
  const schedulerDisplay = config.cron.enableScheduler ? green("on") : dim("off");
  const tradingMode = config.mode;

  const heading = tradingMode === "paper"
    ? "Ghost Paper Trading"
    : tradingMode === "testnet"
    ? "Ghost Testnet Trading"
    : "Ghost daemon ready";
  console.log("");
  console.log(`  ${bold(heading)}`);
  console.log(`  ${dim("─────────────────────────────────────")}`);
  if (tradingMode === "paper") {
    console.log(`  Mode        ${yellow("PAPER (simulated)")}`);
    console.log(`  Balance     ${green(config.paper.initialBalance.toLocaleString() + " USDC")}`);
    console.log(`  Fee         ${(config.paper.takerFee * 100).toFixed(3)}%`);
  } else if (tradingMode === "testnet") {
    console.log(`  Mode        ${yellow("TESTNET (real exchange, testnet USDC)")}`);
  }
  console.log(`  Provider    ${config.provider}/${config.model}`);
  console.log(`  Gateway     ${cyan(gatewayUrl)}`);
  console.log(`  Auth        ${authDisplay}`);
  console.log(`  Channels    ${channelDisplay}`);
  console.log(`  Scheduler   ${schedulerDisplay}`);
  console.log(`  ${dim("─────────────────────────────────────")}`);
  console.log("");
}
