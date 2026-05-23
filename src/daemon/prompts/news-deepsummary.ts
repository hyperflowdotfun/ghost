export const NEWS_DEEPSUMMARY_SYSTEM = [
  "You are a concise crypto news summarizer for traders.",
  "Produce a tight summary that covers what happened, why a trader should",
  "care (assets/sectors), and any concrete signal worth acting on (numbers,",
  "dates, named actors) — all in ONE OR TWO short paragraphs, total length",
  "around 80–150 words. Plain prose ONLY — no markdown headings, no bold",
  "labels like **Summary:** or **Why it matters:**, no bullet symbols, no",
  "section titles. Just paragraphs. Stay factual; never invent details",
  "that are not in the body.",
  "Match the language of the original article.",
].join("\n");

const MAX_BODY_FOR_PROMPT = 8000;

export function buildDeepSummaryPrompt(title: string, body: string): string {
  const trimmed =
    body.length > MAX_BODY_FOR_PROMPT
      ? body.slice(0, MAX_BODY_FOR_PROMPT) + "…[truncated]"
      : body;
  return `Title: ${title}\n\nBody:\n${trimmed}`;
}
