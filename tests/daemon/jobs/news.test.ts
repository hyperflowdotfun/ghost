/**
 * Tests for daemon/jobs/news.ts — newsFetchJob + newsEvaluateJob.
 *
 * All tests use lightweight mocks; no real DB, network, or LLM calls.
 */

import { describe, test, expect, mock } from "bun:test";
import { newsFetchJob, newsEvaluateJob } from "../../../src/daemon/jobs/news.js";
import { NEWS_EVALUATION_SYSTEM } from "../../../src/daemon/prompts/news-evaluation.js";
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

interface NewsServiceMock {
  fetchAll: ReturnType<typeof mock>;
  listPendingEvaluations: ReturnType<typeof mock>;
  saveEvaluation: ReturnType<typeof mock>;
}

function makeNewsService(overrides: Partial<NewsServiceMock> = {}): NewsServiceMock {
  return {
    fetchAll: overrides.fetchAll ?? mock(async () => 0),
    listPendingEvaluations: overrides.listPendingEvaluations ?? mock(() => ({
      candidates: [],
      existingTitles: [],
      total: 0,
    })),
    saveEvaluation: overrides.saveEvaluation ?? mock(() => {}),
  };
}

interface PreferenceStoreMock {
  getNewsFilterEnabled: ReturnType<typeof mock>;
  get: ReturnType<typeof mock>;
}

function makePreferenceStore(opts: { filterEnabled?: boolean; userPrompt?: string | null } = {}): PreferenceStoreMock {
  return {
    getNewsFilterEnabled: mock(() => opts.filterEnabled ?? true),
    get: mock(() => opts.userPrompt ?? null),
  };
}

function makeRunner(returnText?: string) {
  return {
    call: mock(async () => returnText ?? "summary text"),
  };
}

function makeCtx(overrides: Partial<JobContext> & { preferenceStore?: PreferenceStoreMock } = {}): JobContext {
  const newsService = makeNewsService();
  const preferenceStore = overrides.preferenceStore ?? makePreferenceStore();
  const runner = makeRunner();

  return {
    taskAgent: {} as never,
    runner: runner as never,
    runtime: { newsService, preferenceStore } as never,
    eventBus: {} as never,
    logger: makeLogger(),
    kick: mock(async () => {}),
    lastDelayMs: undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// newsFetchJob
// ---------------------------------------------------------------------------

describe("newsFetchJob", () => {
  test("run() calls newsService.fetchAll()", async () => {
    const newsService = makeNewsService({
      fetchAll: mock(async () => 5),
    });
    const ctx = makeCtx({ runtime: { newsService, preferenceStore: makePreferenceStore() } as never });

    await newsFetchJob.run(ctx);

    expect(newsService.fetchAll).toHaveBeenCalledTimes(1);
  });

  test("run() logs inserted count when > 0", async () => {
    const newsService = makeNewsService({ fetchAll: mock(async () => 3) });
    const logger = makeLogger();
    const ctx = makeCtx({
      runtime: { newsService, preferenceStore: makePreferenceStore() } as never,
      logger,
    });

    await newsFetchJob.run(ctx);

    expect(logger.info).toHaveBeenCalledWith({ count: 3 }, "fetched new articles");
  });

  test("run() logs debug when 0 new articles", async () => {
    const newsService = makeNewsService({ fetchAll: mock(async () => 0) });
    const logger = makeLogger();
    const ctx = makeCtx({
      runtime: { newsService, preferenceStore: makePreferenceStore() } as never,
      logger,
    });

    await newsFetchJob.run(ctx);

    expect(logger.debug).toHaveBeenCalledWith("no new articles (all sources up to date)");
  });

  test("run() catches and logs errors from fetchAll()", async () => {
    const newsService = makeNewsService({
      fetchAll: mock(async () => { throw new Error("network error"); }),
    });
    const logger = makeLogger();
    const ctx = makeCtx({ runtime: { newsService, preferenceStore: makePreferenceStore() } as never, logger });

    // Should not throw
    await expect(newsFetchJob.run(ctx)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "fetch failed",
    );
  });

  test("kickAtStart is true — runner will kick this job at daemon start", () => {
    expect(newsFetchJob.kickAtStart).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// newsEvaluateJob
// ---------------------------------------------------------------------------

describe("newsEvaluateJob", () => {
  test("run() calls runner.call with NEWS_EVALUATION_SYSTEM when filter is enabled", async () => {
    const candidates = [{ id: "e1", title: "T1", description: "S1" }];
    const newsService = makeNewsService({
      listPendingEvaluations: mock(() => ({
        candidates,
        existingTitles: [],
        total: 1,
      })),
      saveEvaluation: mock(() => {}),
    });
    const preferenceStore = makePreferenceStore({ filterEnabled: true });
    const runner = makeRunner('["e1"]');
    const ctx = makeCtx({
      runtime: { newsService, preferenceStore } as never,
      runner: runner as never,
    });

    await newsEvaluateJob.run(ctx);

    expect(runner.call).toHaveBeenCalledTimes(1);
    const callArg = (runner.call as ReturnType<typeof mock>).mock.calls[0][0];
    expect(callArg.systemPrompt).toBe(NEWS_EVALUATION_SYSTEM);
  });

  test("run() saves evaluation results from the LLM response", async () => {
    const candidates = [
      { id: "e1", title: "T1", description: "S1" },
      { id: "e2", title: "T2", description: "S2" },
    ];
    const saveEvaluation = mock(() => {});
    const newsService = makeNewsService({
      listPendingEvaluations: mock(() => ({ candidates, existingTitles: [], total: 2 })),
      saveEvaluation,
    });
    const preferenceStore = makePreferenceStore({ filterEnabled: true });
    const runner = makeRunner('["e1"]');
    const ctx = makeCtx({
      runtime: { newsService, preferenceStore } as never,
      runner: runner as never,
    });

    await newsEvaluateJob.run(ctx);

    expect(saveEvaluation).toHaveBeenCalledWith(candidates, ["e1"]);
  });

  test("filter OFF — bypasses LLM and marks every candidate relevant", async () => {
    const candidates = [
      { id: "e1", title: "T1", description: "S1" },
      { id: "e2", title: "T2", description: "S2" },
    ];
    const saveEvaluation = mock(() => {});
    const newsService = makeNewsService({
      listPendingEvaluations: mock(() => ({ candidates, existingTitles: [], total: 2 })),
      saveEvaluation,
    });
    const preferenceStore = makePreferenceStore({ filterEnabled: false });
    const runner = makeRunner();
    const ctx = makeCtx({
      runtime: { newsService, preferenceStore } as never,
      runner: runner as never,
    });

    await newsEvaluateJob.run(ctx);

    // Runner must NOT be called when the filter is off.
    expect(runner.call).not.toHaveBeenCalled();
    // Every candidate must be admitted (ai_relevant=1).
    expect(saveEvaluation).toHaveBeenCalledWith(candidates, ["e1", "e2"]);
  });

  test("run() is a no-op when total === 0", async () => {
    const newsService = makeNewsService({
      listPendingEvaluations: mock(() => ({ candidates: [], existingTitles: [], total: 0 })),
      saveEvaluation: mock(() => {}),
    });
    const runner = makeRunner();
    const ctx = makeCtx({
      runtime: { newsService, preferenceStore: makePreferenceStore() } as never,
      runner: runner as never,
    });

    await newsEvaluateJob.run(ctx);

    expect(runner.call).not.toHaveBeenCalled();
  });

  test("run() skips AI call when candidates array is empty", async () => {
    const newsService = makeNewsService({
      listPendingEvaluations: mock(() => ({ candidates: [], existingTitles: [], total: 5 })),
      saveEvaluation: mock(() => {}),
    });
    const runner = makeRunner();
    const ctx = makeCtx({
      runtime: { newsService, preferenceStore: makePreferenceStore() } as never,
      runner: runner as never,
    });

    await newsEvaluateJob.run(ctx);

    expect(runner.call).not.toHaveBeenCalled();
  });

  test("run() catches and logs error when runner throws", async () => {
    const candidates = [{ id: "e1", title: "T1", description: "S1" }];
    const newsService = makeNewsService({
      listPendingEvaluations: mock(() => ({ candidates, existingTitles: [], total: 1 })),
      saveEvaluation: mock(() => {}),
    });
    const preferenceStore = makePreferenceStore({ filterEnabled: true });
    const runner = { call: mock(async () => { throw new Error("LLM down"); }) };
    const logger = makeLogger();
    const ctx = makeCtx({
      runtime: { newsService, preferenceStore } as never,
      runner: runner as never,
      logger,
    });

    await expect(newsEvaluateJob.run(ctx)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "taskAgent evaluate failed",
    );
  });

  test("kickAtStart is true — runner will kick this job at daemon start", () => {
    expect(newsEvaluateJob.kickAtStart).toBe(true);
  });
});
