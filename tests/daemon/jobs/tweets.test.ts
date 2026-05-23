/**
 * Tests for daemon/jobs/tweets.ts — tweetFetchJob.
 *
 * Covers the three result paths: success, XRateLimitError, and generic error.
 */

import { describe, test, expect, mock } from "bun:test";
import { tweetFetchJob } from "../../../src/daemon/jobs/tweets.js";
import { XRateLimitError } from "../../../src/services/x-follows.js";
import type { JobContext } from "../../../src/daemon/jobs/types.js";
import type { Logger } from "pino";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  return {
    info: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    child: mock(() => makeLogger()),
    trace: mock(() => {}),
  } as unknown as Logger;
}

interface XFollowServiceMock {
  setFetchState: ReturnType<typeof mock>;
  fetchAll: ReturnType<typeof mock>;
  list: ReturnType<typeof mock>;
  hasAuth: ReturnType<typeof mock>;
}

function makeXFollowService(overrides: Partial<XFollowServiceMock> = {}): XFollowServiceMock {
  return {
    setFetchState: overrides.setFetchState ?? mock(() => {}),
    fetchAll: overrides.fetchAll ?? mock(async () => []),
    list: overrides.list ?? mock(() => []),
    hasAuth: overrides.hasAuth ?? mock(async () => true),
  };
}

interface TweetServiceMock {
  insertTweets: ReturnType<typeof mock>;
}

function makeTweetService(): TweetServiceMock {
  return {
    insertTweets: mock(() => 0),
  };
}

interface EventBusMock {
  publish: ReturnType<typeof mock>;
}

function makeEventBus(): EventBusMock {
  return { publish: mock(() => {}) };
}

function makeCtx(opts: {
  xFollowService?: XFollowServiceMock;
  tweetService?: TweetServiceMock;
  eventBus?: EventBusMock;
  logger?: Logger;
  lastDelayMs?: number;
}): JobContext {
  const xFollowService = opts.xFollowService ?? makeXFollowService();
  const tweetService = opts.tweetService ?? makeTweetService();
  const eventBus = opts.eventBus ?? makeEventBus();

  return {
    taskAgent: {} as never,
    runner: {} as never,
    runtime: { xFollowService, tweetService } as never,
    eventBus: eventBus as never,
    logger: opts.logger ?? makeLogger(),
    kick: mock(async () => {}),
    lastDelayMs: opts.lastDelayMs,
  };
}

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe("tweetFetchJob — success", () => {
  test("returns nextDelayMs = X_FETCH_INITIAL (10 min) on success", async () => {
    const xFollowService = makeXFollowService({
      fetchAll: mock(async () => [{ id: "t1" }]),
    });
    const ctx = makeCtx({ xFollowService });

    const result = await tweetFetchJob.run(ctx);

    expect(result).toEqual({ nextDelayMs: 10 * 60 * 1000 });
  });

  test("sets fetch state running then idle on success", async () => {
    const xFollowService = makeXFollowService({ fetchAll: mock(async () => []) });
    const ctx = makeCtx({ xFollowService });

    await tweetFetchJob.run(ctx);

    const calls = (xFollowService.setFetchState as ReturnType<typeof mock>).mock.calls;
    expect(calls[0][0]).toBe("running");
    expect(calls[1][0]).toBe("idle");
  });

  test("calls tweetService.insertTweets and publishes event via sink", async () => {
    // fetchAll calls the sink with a batch then returns all tweets
    const xFollowService = makeXFollowService({
      fetchAll: mock(async (sink: (batch: unknown[], source: "following") => void) => {
        sink([{ id: "t1" }, { id: "t2" }], "following");
        return [{ id: "t1" }, { id: "t2" }];
      }),
    });
    const tweetService = makeTweetService();
    (tweetService.insertTweets as ReturnType<typeof mock>).mockImplementation(() => 2);
    const eventBus = makeEventBus();
    const ctx = makeCtx({ xFollowService, tweetService, eventBus });

    await tweetFetchJob.run(ctx);

    expect(tweetService.insertTweets).toHaveBeenCalledTimes(1);
    expect(eventBus.publish).toHaveBeenCalledTimes(1);
  });

  test("kickAtStart is true — runner will kick this job at daemon start", () => {
    expect(tweetFetchJob.kickAtStart).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// XRateLimitError path
// ---------------------------------------------------------------------------

describe("tweetFetchJob — XRateLimitError", () => {
  test("returns nextDelayMs = err.retryAfterMs on XRateLimitError", async () => {
    const retryAfterMs = 5 * 60 * 1000; // 5 min
    const xFollowService = makeXFollowService({
      fetchAll: mock(async () => {
        throw new XRateLimitError("rate limited", retryAfterMs);
      }),
    });
    const ctx = makeCtx({ xFollowService });

    const result = await tweetFetchJob.run(ctx);

    expect(result).toEqual({ nextDelayMs: retryAfterMs });
  });

  test("sets fetch state to backoff on XRateLimitError", async () => {
    const xFollowService = makeXFollowService({
      fetchAll: mock(async () => {
        throw new XRateLimitError("rate limited", 60_000);
      }),
    });
    const ctx = makeCtx({ xFollowService });

    await tweetFetchJob.run(ctx);

    const calls = (xFollowService.setFetchState as ReturnType<typeof mock>).mock.calls;
    expect(calls[0][0]).toBe("running");
    expect(calls[1][0]).toBe("backoff");
  });

  test("logs warn with retryAfterMs on XRateLimitError", async () => {
    const xFollowService = makeXFollowService({
      fetchAll: mock(async () => {
        throw new XRateLimitError("rate limited", 120_000);
      }),
    });
    const logger = makeLogger();
    const ctx = makeCtx({ xFollowService, logger });

    await tweetFetchJob.run(ctx);

    expect(logger.warn).toHaveBeenCalledWith(
      { retryAfterMs: 120_000 },
      "x rate-limited, honoring Retry-After",
    );
  });

  test("runner clamps retryAfterMs > maxMs to maxMs (3600s)", async () => {
    // The job returns the raw retryAfterMs — runner clamps.
    // We verify the raw value is passed through correctly.
    const hugeRetry = 10 * 60 * 60 * 1000; // 10 hours
    const xFollowService = makeXFollowService({
      fetchAll: mock(async () => {
        throw new XRateLimitError("rate limited", hugeRetry);
      }),
    });
    const ctx = makeCtx({ xFollowService });

    const result = await tweetFetchJob.run(ctx);

    // Job returns the raw value; runner is responsible for clamping.
    expect(result).toEqual({ nextDelayMs: hugeRetry });
  });
});

// ---------------------------------------------------------------------------
// Generic error / exponential backoff path
// ---------------------------------------------------------------------------

describe("tweetFetchJob — generic error", () => {
  test("returns nextDelayMs = lastDelayMs * 2 on generic error", async () => {
    const xFollowService = makeXFollowService({
      fetchAll: mock(async () => { throw new Error("network timeout"); }),
    });
    const ctx = makeCtx({ xFollowService, lastDelayMs: 5 * 60 * 1000 }); // 5 min

    const result = await tweetFetchJob.run(ctx);

    expect(result).toEqual({ nextDelayMs: 10 * 60 * 1000 }); // doubled to 10 min
  });

  test("uses X_FETCH_INITIAL as base when lastDelayMs is undefined", async () => {
    const xFollowService = makeXFollowService({
      fetchAll: mock(async () => { throw new Error("oops"); }),
    });
    const ctx = makeCtx({ xFollowService, lastDelayMs: undefined });

    const result = await tweetFetchJob.run(ctx);

    // lastDelayMs undefined → base is X_FETCH_INITIAL (10 min), doubled = 20 min
    expect(result).toEqual({ nextDelayMs: 20 * 60 * 1000 });
  });

  test("sets fetch state to backoff on generic error", async () => {
    const xFollowService = makeXFollowService({
      fetchAll: mock(async () => { throw new Error("failure"); }),
    });
    const ctx = makeCtx({ xFollowService });

    await tweetFetchJob.run(ctx);

    const calls = (xFollowService.setFetchState as ReturnType<typeof mock>).mock.calls;
    expect(calls[1][0]).toBe("backoff");
  });

  test("logs warn with backoff minutes on generic error", async () => {
    const xFollowService = makeXFollowService({
      fetchAll: mock(async () => { throw new Error("boom"); }),
    });
    const logger = makeLogger();
    const ctx = makeCtx({ xFollowService, logger, lastDelayMs: 10 * 60 * 1000 });

    await tweetFetchJob.run(ctx);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ backoffMin: expect.any(Number) }),
      "fetch failed, backing off",
    );
  });
});

// ---------------------------------------------------------------------------
// tweetEvaluateJob — filter toggle
// ---------------------------------------------------------------------------

import { tweetEvaluateJob } from "../../../src/daemon/jobs/tweets.js";

describe("tweetEvaluateJob — filter toggle", () => {
  function makeEvalCtx(opts: {
    filterEnabled: boolean;
    candidates: Array<{ id: string; content: string; username: string; coins: string[] }>;
    runnerReturn?: string;
  }): JobContext {
    const runnerCall = mock(async () => opts.runnerReturn ?? "[]");
    const saveEvaluation = mock(() => {});
    const tweetService = {
      listPendingEvaluations: mock(() => opts.candidates),
      saveEvaluation,
    };
    const preferenceStore = {
      getTweetFilterEnabled: mock(() => opts.filterEnabled),
      getTweetFilterPrompt: mock(() => null),
    };
    return {
      taskAgent: {} as never,
      runner: { call: runnerCall } as never,
      runtime: { tweetService, preferenceStore } as never,
      eventBus: makeEventBus() as never,
      logger: makeLogger(),
      kick: mock(async () => {}),
      lastDelayMs: undefined,
    };
  }

  test("filter OFF — admits every candidate without calling the LLM", async () => {
    const candidates = [
      { id: "t1", username: "alice", content: "hi", coins: [] },
      { id: "t2", username: "bob", content: "bye", coins: [] },
    ];
    const ctx = makeEvalCtx({ filterEnabled: false, candidates });

    await tweetEvaluateJob.run(ctx);

    const runtime = ctx.runtime as unknown as {
      tweetService: { saveEvaluation: ReturnType<typeof mock> };
    };
    expect(runtime.tweetService.saveEvaluation).toHaveBeenCalledWith(candidates, ["t1", "t2"]);
    expect((ctx.runner as unknown as { call: ReturnType<typeof mock> }).call).not.toHaveBeenCalled();
  });

  test("filter ON — runs LLM evaluation as before", async () => {
    const candidates = [{ id: "t1", username: "alice", content: "hi", coins: [] }];
    const ctx = makeEvalCtx({ filterEnabled: true, candidates, runnerReturn: '["t1"]' });

    await tweetEvaluateJob.run(ctx);

    expect((ctx.runner as unknown as { call: ReturnType<typeof mock> }).call).toHaveBeenCalledTimes(1);
  });
});
