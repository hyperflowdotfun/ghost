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
import type { SessionManager } from "../session/manager.js";
import type { ITradingClient } from "../services/interfaces/trading-client.js";
import { MAIN_SESSION_KEY } from "../session/session.js";
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

/**
 * How many recent user messages to surface as a language-reference block.
 * Runner clears state.messages on every cron call so without an explicit
 * anchor the model has zero chat context and defaults to the English task
 * prompt — same mechanism event-judge already uses to keep TP-fill
 * notifications in the user's language. Three lines is enough to disambiguate
 * vi/en/zh without bloating the prompt.
 */
const LANG_REFERENCE_MAX_MESSAGES = 3;

export interface CronDeliveryDeps {
  runner: Runner;
  contextBuilder: ContextBuilder;
  bus: MessageBus;
  eventBus: EventBus;
  tools: ToolRegistry;
  channelManager: ChannelManager;
  pairingStore: PairingStore;
  sessionManager: SessionManager;
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

/**
 * Pull up to N most recent user-authored text snippets from the main session.
 * Tool calls, assistant turns, and synthetic markers are excluded — we only
 * want substance the user actually typed, since that is the language signal.
 *
 * `content` may be either a string (Orchestrator's inbound path appends user
 * messages as `{role:"user", content: "<text>"}`) or an array of content blocks
 * (some channel paths and pi-ai's canonical Message shape). Handle both so we
 * surface a language signal after restart, when the session was rehydrated from
 * JSONL where most user lines are string-form.
 *
 * Empty session returns an empty array; caller omits the reference block.
 */
function snapshotRecentUserMessages(
  sessionManager: SessionManager,
  limit: number,
): string[] {
  const session = sessionManager.getOrCreate(MAIN_SESSION_KEY);
  const out: string[] = [];
  for (const msg of session.messages) {
    const m = msg as { role?: string; content?: unknown };
    if (m.role !== "user") continue;
    let text = "";
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      for (const block of m.content as Array<{ type?: string; text?: unknown }>) {
        if (block?.type === "text" && typeof block.text === "string") {
          text += block.text;
        }
      }
    }
    const trimmed = text.trim();
    if (trimmed.length === 0) continue;
    out.push(trimmed);
  }
  return out.slice(-limit);
}

export function createCronDeliveryHandler(
  deps: CronDeliveryDeps,
): (job: CronJob) => Promise<string | null> {
  return async (job: CronJob): Promise<string | null> => {
    const { runner, contextBuilder, bus, eventBus, tools, channelManager, pairingStore, sessionManager, tradingClient, logger } = deps;

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

      // Language anchor. Runner.call clears state.messages, so without an
      // explicit signal the model falls back to inferring language from
      // runtime context (UTC offset) — and lands on whatever language the
      // offset's region speaks. Two modes:
      //   - Have recent user messages → use them verbatim as the reference
      //     for language + tone.
      //   - Session is empty → emit an explicit English fallback directive.
      //     Once the user chats in any other language, the reference block
      //     populates and overrides this default.
      const recentUser = snapshotRecentUserMessages(sessionManager, LANG_REFERENCE_MAX_MESSAGES);
      const langRefBlock = recentUser.length === 0
        ? "Respond in English (no recent chat history to infer the trader's language from).\n\n"
        : "Recent user messages (language reference only — do NOT reply to these, " +
          "use them only to match the trader's language and tone):\n" +
          recentUser.map((t) => `- ${t}`).join("\n") +
          "\n\n";

      const text = (await runner.call({
        systemPrompt: contextBuilder.buildFullPrompt("internal", `cron-${job.name}`),
        message: `${langRefBlock}${REMINDER_NOTE_PREFIX}\n\nTask: ${job.payload.message}`,
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
