/**
 * Register all default background jobs with the runner.
 *
 * Called once during daemon startup, before runner.start().
 */

import type { BackgroundJobRunner } from "./runner.js";
import type { Config } from "../../config/schema.js";
import { newsFetchJob, newsEvaluateJob } from "./news.js";
import { tweetFetchJob, tweetEvaluateJob } from "./tweets.js";
import { buildObserverJob } from "./observer.js";

export function registerDefaultJobs(runner: BackgroundJobRunner, config: Config): void {
  runner.register(newsFetchJob);
  runner.register(newsEvaluateJob);
  runner.register(tweetFetchJob);
  runner.register(tweetEvaluateJob);
  // Single unified job — observer is the ONLY proactive/alert scanner. It
  // detects position/order/fill events and feeds every tick's buffer to the
  // event-judge skill, which decides body + notification flag.
  // tickMs is config-driven so ops / eval harnesses can tune cadence.
  runner.register(buildObserverJob(config.observer.tickMs));
}

export { BackgroundJobRunner } from "./runner.js";
export type { BackgroundJob, JobContext, JobResult, JobStatus, Schedule } from "./types.js";
