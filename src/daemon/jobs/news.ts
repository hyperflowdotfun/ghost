import type { BackgroundJob, JobContext } from "./types.js";
import {
  buildEvaluationPrompt,
  DEFAULT_NEWS_FILTER_INSTRUCTION,
  NEWS_EVALUATION_SYSTEM,
  parseEvaluationOutput,
} from "../prompts/news-evaluation.js";
import { NEWS_FILTER_PROMPT_KEY } from "../../services/preferences.js";

export const newsFetchJob: BackgroundJob = {
  name: "news-fetch",
  schedule: { type: "interval", ms: 30 * 60 * 1000 },
  kickAtStart: true,

  async run({ runtime, logger }: JobContext): Promise<void> {
    try {
      const inserted = await runtime.newsService.fetchAll();
      if (inserted > 0) logger.info({ count: inserted }, "fetched new articles");
      else logger.debug("no new articles (all sources up to date)");
    } catch (err) {
      logger.warn({ err }, "fetch failed");
    }
  },
};

export const newsEvaluateJob: BackgroundJob = {
  name: "news-evaluate",
  schedule: { type: "interval", ms: 20 * 1000 },
  kickAtStart: true,

  async run({ runner, runtime, logger }: JobContext): Promise<void> {
    try {
      const { candidates, existingTitles, total } = runtime.newsService.listPendingEvaluations(20);
      if (total === 0) return;
      if (candidates.length === 0) return;

      // Bypass writes ai_relevant=1 anyway — early-return would leave rows in
      // the pending pool forever.
      if (!runtime.preferenceStore.getNewsFilterEnabled()) {
        runtime.newsService.saveEvaluation(candidates, candidates.map((c) => c.id));
        logger.info({ count: candidates.length }, "evaluated articles (filter off)");
        return;
      }

      const userPrompt = runtime.preferenceStore.get(NEWS_FILTER_PROMPT_KEY);
      const instruction =
        userPrompt && userPrompt.trim().length > 0 ? userPrompt : DEFAULT_NEWS_FILTER_INSTRUCTION;

      let raw: string;
      try {
        raw = await runner.call({
          systemPrompt: NEWS_EVALUATION_SYSTEM,
          message: buildEvaluationPrompt(candidates, existingTitles, instruction),
        });
      } catch (err) {
        logger.warn({ err }, "taskAgent evaluate failed");
        return;
      }

      const selectedIds = parseEvaluationOutput(raw);
      runtime.newsService.saveEvaluation(candidates, selectedIds);
      logger.info({ count: total }, "evaluated articles");
    } catch (err) {
      logger.warn({ err }, "evaluate failed");
    }
  },
};
