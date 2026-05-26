/**
 * Built-in default cron jobs seeded on daemon start.
 *
 * Placing defaults here — rather than in onboard or daemon — keeps seeding
 * idempotent across daemon restarts and avoids coupling the onboard wizard
 * to scheduler internals.
 */

import type { CronSchedule } from "./types.js";

/** The long-form prompt that drives the morning briefing agent turn.
 *  Exported so intel-briefing tool and delivery handler stay in sync. */
export const BRIEFING_PROMPT =
  "Start by calling ghost_chat_history to ground your reply in the trader's " +
  "recent conversation. Pick the message count based on what you need — " +
  "enough to detect the trader's chat language and reference relevant topics " +
  "they discussed. If the tool returns no messages, reply in English. " +
  "Then run the morning briefing: call tools to fetch the latest data — open " +
  "positions, recent fills / trade history, watchlist, news, and market " +
  "signals (funding, whale activity, fear & greed). Summarize in under 15 " +
  "sentences in the trader's language.";

/** The long-form prompt that drives the end-of-day recap agent turn.
 *  Exported alongside BRIEFING_PROMPT so consumers (e.g. tools, tests) stay in sync. */
export const RECAP_PROMPT =
  "Start by calling ghost_chat_history to ground your reply in the trader's " +
  "recent conversation. Pick the message count based on what you need — " +
  "enough to detect the trader's chat language and reference relevant topics " +
  "they discussed. If the tool returns no messages, reply in English. " +
  "Then run the end-of-day recap: call tools to fetch today's trade history " +
  "and current open positions. Summarize today's PnL, position changes " +
  "(opened, closed, scaled), and one notable market note. Brief one-liner if " +
  "I had no activity. Reply in the trader's language.";

export interface DefaultJobSpec {
  /** Unique name — used as idempotency key; must match the job's `name` field. */
  name: string;
  schedule: CronSchedule;
  message: string;
  /** Whether the cron delivery handler should forward the result to a channel. */
  deliver: boolean;
}

/** Detect the host's IANA timezone with a UTC fallback.
 *  Wrapped in try/catch so exotic environments (no Intl support) don't crash. */
export function detectUserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Build the list of default cron jobs for the given timezone.
 *
 * Called once per daemon start — the TZ snapshot is intentional here because
 * seeding is one-shot. Subsequent timezone changes are applied via
 * CronService.updateBuiltinJobsTimezone(tz) rather than by restarting.
 */
export function buildBuiltInJobs(tz: string): ReadonlyArray<DefaultJobSpec> {
  return [
    {
      name: "morning-briefing",
      schedule: { kind: "cron", expr: "0 8 * * *", tz },
      message: BRIEFING_PROMPT,
      deliver: true,
    },
    {
      name: "evening-recap",
      schedule: { kind: "cron", expr: "0 21 * * *", tz },
      message: RECAP_PROMPT,
      deliver: true,
    },
  ];
}

