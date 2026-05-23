/**
 * Prompt builders for the news relevance evaluation background job.
 *
 * The system prompt (NEWS_EVALUATION_SYSTEM) must be set on
 * taskAgent.state.systemPrompt before each prompt() call because
 * pi-agent-core provides no per-call systemPrompt override.
 */

import { parseLlmJsonArray } from "../../helpers/parse-llm-json.js";

/** System prompt for the background evaluator taskAgent call. */
export const NEWS_EVALUATION_SYSTEM =
  "You are a crypto news curator. Evaluate article relevance for crypto traders. Reply with valid JSON only — no markdown, no explanation.";

interface EvalArticle {
  id: string;
  title: string;
  description: string;
}

/**
 * Default selection criteria injected into the evaluation prompt.
 * Users override this via the "News Filter" modal in the web UI; the override
 * is stored in settings_kv under `news.filter_prompt` and resolved per tick
 * by the newsEvaluateJob. Empty/missing value falls back to this default.
 */
export const DEFAULT_NEWS_FILTER_INSTRUCTION = `You are a crypto news curator. From the articles below, select ALL that are relevant for crypto traders.

Criteria:
- Must directly impact crypto: prices, projects, regulations, exchanges, DeFi, blockchain, trading opinions
- Include breaking news, market moves, regulatory changes, trader commentary
- Skip duplicates of existing articles (same event/story)
- Skip general tech, traditional finance, politics, entertainment unless they directly affect crypto markets
- If multiple articles cover the same story, pick only the best one`;

/** Build the user prompt for evaluating a batch of articles. */
export function buildEvaluationPrompt(
  articles: ReadonlyArray<EvalArticle>,
  existingTitles: ReadonlyArray<{ id: string; title: string }>,
  instruction: string = DEFAULT_NEWS_FILTER_INSTRUCTION,
): string {
  const existingList = existingTitles
    .slice(0, 30)
    .map((e) => `  - [${e.id}] ${e.title}`)
    .join("\n");

  const articleList = articles
    .map((a, i) => `  ${i + 1}. [${a.id}] ${a.title} | ${a.description.slice(0, 100)}`)
    .join("\n");

  return `${instruction}

CANDIDATE ARTICLES (${articles.length} total):
${articleList}

ALREADY SHOWN (skip duplicates of these):
${existingList || "  (none)"}

Respond with ONLY a JSON array of the relevant article IDs:
["id1","id2"]

Output valid JSON only, no markdown, no explanation.`;
}

/**
 * Parse the raw text from taskAgent after an evaluation call.
 *
 * Uses the shared `parseLlmJsonArray` helper which handles known model quirks
 * (Qwen `<think>`, DeepSeek `<thinking>`, markdown fences) via strip-then-scan.
 *
 * Returns the selected article IDs, or an empty array if parsing fails.
 */
export function parseEvaluationOutput(raw: string): string[] {
  const parsed = parseLlmJsonArray(raw);
  if (!parsed) return [];
  return parsed.filter((v): v is string => typeof v === "string");
}
