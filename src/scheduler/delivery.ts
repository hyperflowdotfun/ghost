/** Cron delivery handler — runs the agent and dispatches the response to outbound channels. */

import type { Logger } from "pino";
import type { CronJob } from "./types.js";
import type { Runner } from "../agent/runner.js";
import type { ContextBuilder } from "../agent/context-builder.js";
import type { MessageBus } from "../bus/queue.js";
import type { EventBus } from "../bus/events.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { PairingStore } from "../pairing/store.js";
import type { ChannelManager } from "../channels/manager.js";
import type { ITradingClient } from "../services/interfaces/trading-client.js";
import { getOutboundChannels, dispatchOutbound } from "../channels/index.js";
import { isCronAware } from "../tools/context-aware.js";

/**
 * Prefixed before every cron task message. Disciplines the agent response shape:
 * speak naturally in the user's language, no meta-commentary, no status chatter.
 */
const REMINDER_NOTE_PREFIX =
  "The scheduled time has arrived. Deliver this task to the user now " +
  "as a brief, natural message in their language. Speak directly — " +
  "no narration, no status chatter like \"Done\" or \"Reminded\", " +
  "no meta-reasoning about the task itself.";

export interface CronDeliveryDeps {
  runner: Runner;
  contextBuilder: ContextBuilder;
  bus: MessageBus;
  eventBus: EventBus;
  tools: ToolRegistry;
  channelManager: ChannelManager;
  pairingStore: PairingStore;
  tradingClient: ITradingClient;
  logger: Logger;
}

/**
 * Job names that strictly require a connected wallet — they review the user's
 * trades and positions, so without an address there's nothing to summarize.
 * Briefings (news + market signals + watchlist) fire even without a wallet
 * because they're still useful to a not-yet-onboarded user.
 *
 * Hardcoded set rather than a payload flag to avoid a schema migration in
 * `scheduler/storage.ts` for the only portfolio-centric job we ship today.
 * Generalize to `payload.requiresWallet` if more recap-style jobs land.
 */
const WALLET_REQUIRED_JOBS = new Set(["evening-recap"]);

export function createCronDeliveryHandler(
  deps: CronDeliveryDeps,
): (job: CronJob) => Promise<string | null> {
  return async (job: CronJob): Promise<string | null> => {
    const { runner, contextBuilder, bus, eventBus, tools, channelManager, pairingStore, tradingClient, logger } = deps;

    // Wallet gate for portfolio-centric jobs (e.g. recap). Without an
    // address those jobs have nothing to summarize. Briefings still run —
    // news, market signals, and watchlist work fine without a wallet.
    if (WALLET_REQUIRED_JOBS.has(job.name) && !tradingClient.address) {
      logger.debug({ job: job.name }, "cron: no wallet connected, skipping");
      return null;
    }

    const cronTool = tools.get("cron");
    if (isCronAware(cronTool)) {
      cronTool.enterCron();
    }

    try {
      const activeChannels = getOutboundChannels({ channelManager, pairingStore, logger });

      // Language anchor + chat context live inside the task prompt
      // itself — both BRIEFING_PROMPT and RECAP_PROMPT instruct the agent
      // to call ghost_chat_history first, which returns timestamped user
      // and assistant pairs. The LLM picks the trader's language and
      // recent topics from there.
      const text = (await runner.call({
        systemPrompt: contextBuilder.buildFullPrompt("internal", `cron-${job.name}`),
        message: `${REMINDER_NOTE_PREFIX}\n\nTask: ${job.payload.message}`,
        persist: true,
      })).trim();

      if (!text) {
        logger.warn({ job: job.name }, "cron: empty response, skipping");
        return null;
      }

      await dispatchOutbound(activeChannels, text, {
        eventBus,
        bus,
        source: job.name,
        logger,
      });

      logger.info({ job: job.name, channels: activeChannels.length }, "cron: dispatched");
      return text;
    } finally {
      if (isCronAware(cronTool)) {
        cronTool.exitCron();
      }
    }
  };
}
