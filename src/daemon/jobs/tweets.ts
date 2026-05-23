/**
 * Background X/Twitter follows fetch job — adaptive schedule with Retry-After
 * support and exponential backoff on generic errors.
 *
 *   - Per-batch sink: insertTweets + publish tweetsInserted event immediately
 *   - Rate limit (XRateLimitError): use err.retryAfterMs as nextDelayMs
 *   - Other error: double last delay (exp backoff)
 *   - Success: reset to X_FETCH_INITIAL
 *   - Runner clamps all nextDelayMs to [X_FETCH_MIN, X_FETCH_MAX]
 */

import type { BackgroundJob, JobContext, JobResult } from "./types.js";
import { XRateLimitError } from "../../services/x-follows.js";
import { TradingEvents } from "../../events/trading-events.js";
import {
  TWEET_FILTER_SYSTEM,
  DEFAULT_TWEET_FILTER_INSTRUCTION,
  buildEvaluationPrompt,
} from "../prompts/tweet-evaluation.js";
import { parseLlmJsonArray } from "../../helpers/parse-llm-json.js";

// ---------------------------------------------------------------------------
// Interval constants
// ---------------------------------------------------------------------------

const X_FETCH_INITIAL = 10 * 60 * 1000;  // 10 min base
const X_FETCH_MIN    = 30 * 1000;         // 30 s floor
const X_FETCH_MAX    = 60 * 60 * 1000;    // 60 min ceiling

// ---------------------------------------------------------------------------
// tweetFetchJob
// ---------------------------------------------------------------------------

export const tweetFetchJob: BackgroundJob = {
  name: "tweet-fetch",
  schedule: { type: "adaptive", initialMs: X_FETCH_INITIAL, minMs: X_FETCH_MIN, maxMs: X_FETCH_MAX },
  kickAtStart: true,

  async run({ runtime, eventBus, logger, lastDelayMs, kick }: JobContext): Promise<JobResult> {
    const { xFollowService, tweetService } = runtime;

    let totalInserted = 0;
    let totalBatches = 0;

    // Per-batch sink: persist + broadcast immediately so the UI shows tweets
    // within ~1 s of the first UserTweets response.
    const sink = (
      batch: Parameters<typeof tweetService.insertTweets>[0],
      source: "following" | "manual",
    ) => {
      const inserted = tweetService.insertTweets(batch);
      totalBatches++;
      if (inserted > 0) {
        totalInserted += inserted;
        eventBus.publish(TradingEvents.tweetsInserted({ count: inserted, source }));
        void kick("tweet-evaluate").catch((err: unknown) => {
          logger.warn({ err }, "kick tweet-evaluate failed");
        });
      }
    };

    xFollowService.setFetchState("running");

    try {
      const xPosts = await xFollowService.fetchAll(sink);

      if (xPosts.length > 0) {
        logger.info(
          { total: xPosts.length, inserted: totalInserted, batches: totalBatches },
          "fetched tweets",
        );
      } else {
        const follows = xFollowService.list().length;
        const hasAuth = await xFollowService.hasAuth();
        if (!follows) logger.debug("no accounts followed — skipped");
        else if (!hasAuth) logger.debug("auth not configured — skipped");
        else logger.debug({ follows }, "0 new tweets");
      }

      xFollowService.setFetchState("idle");
      return { nextDelayMs: X_FETCH_INITIAL };
    } catch (err) {
      xFollowService.setFetchState("backoff");

      if (err instanceof XRateLimitError) {
        logger.warn(
          { retryAfterMs: err.retryAfterMs },
          "x rate-limited, honoring Retry-After",
        );
        // Runner clamps to [X_FETCH_MIN, X_FETCH_MAX] automatically
        return { nextDelayMs: err.retryAfterMs };
      }

      // Generic error — exponential backoff from last delay
      const backoff = (lastDelayMs ?? X_FETCH_INITIAL) * 2;
      logger.warn(
        { err, backoffMin: Math.round(backoff / 60_000) },
        "fetch failed, backing off",
      );
      return { nextDelayMs: backoff };
    }
  },
};

// ---------------------------------------------------------------------------
// tweetEvaluateJob — every 20 s, mirrors newsEvaluateJob cadence
// ---------------------------------------------------------------------------

export const tweetEvaluateJob: BackgroundJob = {
  name: "tweet-evaluate",
  schedule: { type: "interval", ms: 20_000 },
  kickAtStart: true,

  async run({ runner, runtime, logger }: JobContext): Promise<void> {
    try {
      const candidates = runtime.tweetService.listPendingEvaluations(20);
      if (candidates.length === 0) return;

      if (!runtime.preferenceStore.getTweetFilterEnabled()) {
        runtime.tweetService.saveEvaluation(candidates, candidates.map((c) => c.id));
        logger.info({ count: candidates.length }, "evaluated tweets (filter off)");
        return;
      }

      const userPrompt = runtime.preferenceStore.getTweetFilterPrompt();
      const instruction =
        userPrompt && userPrompt.trim().length > 0
          ? userPrompt
          : DEFAULT_TWEET_FILTER_INSTRUCTION;

      let raw: string;
      try {
        raw = await runner.call({
          systemPrompt: TWEET_FILTER_SYSTEM,
          message: buildEvaluationPrompt(candidates, instruction),
        });
      } catch (err) {
        logger.warn({ err }, "taskAgent tweet-evaluate failed");
        return;
      }

      const selectedIds = parseLlmJsonArray(raw) ?? [];
      const stringIds = selectedIds.filter((v): v is string => typeof v === "string");
      runtime.tweetService.saveEvaluation(candidates, stringIds);
      logger.info({ count: candidates.length, selected: stringIds.length }, "evaluated tweets");
    } catch (err) {
      logger.warn({ err }, "tweet-evaluate failed");
    }
  },
};
