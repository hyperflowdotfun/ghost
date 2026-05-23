/**
 * Custom UI tag stripping for the Telegram formatter.
 *
 * The web UI renders custom inline tags (<price>, <pnl>, <side>, …) natively;
 * Telegram does not, so we peel them off here. Separated from `telegram-format.ts`
 * to keep each module focused.
 */

import { SENTINEL_I_OPEN, SENTINEL_I_CLOSE, SENTINEL_B_OPEN, SENTINEL_B_CLOSE } from "./markdown.js";
import type { ChartSpec } from "../chart-renderer.js";

// ---------------------------------------------------------------------------
// S/R level formatter — used by the chart caption builder in index.ts.
// ---------------------------------------------------------------------------

/**
 * Format a CSV string of price levels into a human-readable list.
 * Values >= 1000 are shortened to `$Xk` (1 decimal if needed).
 * Non-numeric values are passed through as-is.
 * Returns empty string when input is empty or undefined.
 */
export function formatLevels(csv: string | undefined): string {
  if (!csv) return "";
  const parts = csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(formatOneLevel);
  return parts.length === 0 ? "" : parts.join(", ");
}

function formatOneLevel(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  if (n >= 1000) {
    const k = n / 1000;
    return k % 1 === 0 ? `$${k}k` : `$${k.toFixed(1)}k`;
  }
  return `$${raw}`;
}

// ---------------------------------------------------------------------------
// Chart extraction — runs BEFORE stripCustomTags so the dispatcher can
// send screenshots. Legacy callers that call format() directly still get
// the text hint from stripCustomTags (it finds nothing in happy path).
// ---------------------------------------------------------------------------

const CHART_RE_PAIRED = /<chart\s*([^>]*)>([\s\S]*?)<\/chart>/gi;
const CHART_RE_SELF = /<chart\s+([^>]*?)\/>/gi;

// Indicator codes the backend chart route accepts (see src/gateway/chart-data.ts
// VALID_INDICATORS). EMA is rendered as a base layer (always on) and should
// NOT appear in this list — including it would silently drop on the backend.
const VALID_INDICATOR_CODES = new Set([
  "bb", "rsi", "macd", "ichimoku", "keltner", "adx",
  "stochrsi", "obv", "williamsr", "atr", "cci", "vwap",
]);

// Display-name → canonical code map. LLMs frequently emit display names
// (EMA9, Bollinger Bands) instead of codes, so we normalize defensively
// before passing to the chart route.
const INDICATOR_ALIAS: Record<string, string> = {
  bollinger: "bb", "bollinger bands": "bb", bb: "bb",
  rsi: "rsi",
  macd: "macd",
  ichimoku: "ichimoku", cloud: "ichimoku",
  keltner: "keltner",
  adx: "adx",
  stochrsi: "stochrsi", "stoch rsi": "stochrsi",
  obv: "obv",
  "williams %r": "williamsr", "williams r": "williamsr", williamsr: "williamsr",
  atr: "atr",
  cci: "cci",
  vwap: "vwap",
};

/**
 * Map a raw indicator token (e.g. "EMA9", "Bollinger Bands", "rsi") to a
 * canonical code the backend accepts, or null if the token doesn't map.
 * EMAs are always dropped — they render as a base layer regardless.
 */
function normalizeIndicatorToken(raw: string): string | null {
  const t = raw.trim().toLowerCase().replace(/\d+$/, ""); // strip trailing digits: ema9 → ema
  if (!t) return null;
  if (t === "ema" || t === "emas") return null;           // base layer, not opt-in
  const code = INDICATOR_ALIAS[t];
  return code && VALID_INDICATOR_CODES.has(code) ? code : null;
}

function normalizeIndicators(raw: string): string | undefined {
  const codes = Array.from(new Set(
    raw.split(",")
      .map(normalizeIndicatorToken)
      .filter((c): c is string => c !== null),
  ));
  return codes.length > 0 ? codes.join(",") : undefined;
}

function normalizeLevels(raw: string): string | undefined {
  // Drop non-numeric tokens like "support" / "resistance" — the chart route
  // only consumes prices. Empty result = omit the param entirely.
  const nums = raw.split(",")
    .map(s => s.trim())
    .filter(s => Number.isFinite(Number(s)));
  return nums.length > 0 ? nums.join(",") : undefined;
}

/**
 * Parse body-style chart specs the LLM sometimes emits:
 *
 *   <chart>
 *     symbol: BTC
 *     interval: 4h
 *     indicators: EMA9, RSI, MACD
 *     levels: 65000, 68500
 *   </chart>
 *
 * Returns a partial attrs object so the regular attribute parser can merge
 * it as a fallback when attribute-style is empty or incomplete.
 */
function parseChartBody(body: string): Partial<Record<"symbol" | "interval" | "indicators" | "levels", string>> {
  const out: Partial<Record<"symbol" | "interval" | "indicators" | "levels", string>> = {};
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s*(symbol|interval|indicators|levels)\s*:\s*(.+?)\s*$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase() as keyof typeof out;
    if (!out[key]) out[key] = m[2];
  }
  return out;
}

function parseChartAttrs(attrs: string, body?: string): ChartSpec | null {
  let symbol = /\bsymbol\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
  let interval = /\binterval\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
  let indicators = /\bindicators\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
  let levels = /\blevels\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];

  // Body-style fallback — only consult when attribute form is incomplete.
  // LLMs sometimes emit `<chart>\nsymbol: BTC\ninterval: 4h\n...\n</chart>`.
  if (body && (!symbol || !interval)) {
    const bodyAttrs = parseChartBody(body);
    symbol ??= bodyAttrs.symbol;
    interval ??= bodyAttrs.interval;
    indicators ??= bodyAttrs.indicators;
    levels ??= bodyAttrs.levels;
  }

  if (!symbol || !interval) return null;

  const normIndicators = indicators ? normalizeIndicators(indicators) : undefined;
  const normLevels = levels ? normalizeLevels(levels) : undefined;
  return {
    symbol,
    interval,
    ...(normIndicators ? { indicators: normIndicators } : {}),
    ...(normLevels ? { levels: normLevels } : {}),
  };
}

/**
 * Extract all `<chart>` tags from `text`, returning the stripped text and
 * parsed specs. Invalid specs (missing symbol or interval after attribute +
 * body fallback) are skipped silently. Runs BEFORE the rest of the format
 * pipeline so screenshots can be sent alongside prose.
 */
export function extractCharts(text: string): { text: string; charts: ChartSpec[] } {
  const charts: ChartSpec[] = [];
  // Paired form first: <chart ...>...</chart> — pass body for fallback.
  let out = text.replace(CHART_RE_PAIRED, (_m, attrs: string, body: string) => {
    const spec = parseChartAttrs(attrs, body);
    if (spec) charts.push(spec);
    return "";
  });
  // Self-closing form: <chart ... /> — no body to fall back to.
  out = out.replace(CHART_RE_SELF, (_m, attrs: string) => {
    const spec = parseChartAttrs(attrs);
    if (spec) charts.push(spec);
    return "";
  });
  return { text: out, charts };
}

/** Custom inline tag replacements. Inner text is emitted raw (escaping handled later). */
export function stripCustomTags(text: string): string {
  let out = text;

  // <pnl dir="up|down|flat">X</pnl> — add emoji based on direction.
  out = out.replace(/<pnl\s+dir="up"\s*>([\s\S]*?)<\/pnl>/gi, "$1 📈");
  out = out.replace(/<pnl\s+dir="down"\s*>([\s\S]*?)<\/pnl>/gi, "$1 📉");
  out = out.replace(/<pnl\s+dir="flat"\s*>([\s\S]*?)<\/pnl>/gi, "$1");
  out = out.replace(/<pnl\s*>([\s\S]*?)<\/pnl>/gi, "$1");

  // <side dir="long|short">X</side>
  out = out.replace(/<side\s+dir="long"\s*>([\s\S]*?)<\/side>/gi, "🟢 $1");
  out = out.replace(/<side\s+dir="short"\s*>([\s\S]*?)<\/side>/gi, "🔴 $1");
  out = out.replace(/<side\s*[^>]*>([\s\S]*?)<\/side>/gi, "$1");

  // <tag type="entry|tp|sl">X</tag> — marker emoji prepended; label already
  // lives inside per SOUL.md contract so we only add a visual prefix.
  out = out.replace(/<tag\s+type="entry"\s*>([\s\S]*?)<\/tag>/gi, "🎯 $1");
  out = out.replace(/<tag\s+type="tp"\s*>([\s\S]*?)<\/tag>/gi, "💰 $1");
  out = out.replace(/<tag\s+type="sl"\s*>([\s\S]*?)<\/tag>/gi, "⛔ $1");
  out = out.replace(/<tag\s*[^>]*>([\s\S]*?)<\/tag>/gi, "$1");

  // <price>, <lev> — strip wrapper, keep inner.
  out = out.replace(/<price\s*>([\s\S]*?)<\/price>/gi, "$1");
  out = out.replace(/<lev\s*>([\s\S]*?)<\/lev>/gi, "$1");

  // <pct dir="up|down">X</pct> — directional emoji, consistent with <pnl>.
  out = out.replace(/<pct\s+dir="up"\s*>([\s\S]*?)<\/pct>/gi, "$1 📈");
  out = out.replace(/<pct\s+dir="down"\s*>([\s\S]*?)<\/pct>/gi, "$1 📉");
  out = out.replace(/<pct\s*[^>]*>([\s\S]*?)<\/pct>/gi, "$1");

  // <ind name="...">X</ind> — indicator hover; strip wrapper, keep inner.
  out = out.replace(/<ind\s*[^>]*>([\s\S]*?)<\/ind>/gi, "$1");

  // <lvl price="...">X</lvl> — price-level hover; keep visible price text.
  out = out.replace(/<lvl\s*[^>]*>([\s\S]*?)<\/lvl>/gi, "$1");

  // <risk level="low|medium|high">X</risk> — badge emoji by level.
  // High risk is wrapped in bold sentinels for extra visual weight in Telegram.
  out = out.replace(/<risk\s+level="low"\s*>([\s\S]*?)<\/risk>/gi, "🟢 $1");
  out = out.replace(/<risk\s+level="medium"\s*>([\s\S]*?)<\/risk>/gi, "🟡 $1");
  out = out.replace(
    /<risk\s+level="high"\s*>([\s\S]*?)<\/risk>/gi,
    `${SENTINEL_B_OPEN}🔴 $1${SENTINEL_B_CLOSE}`,
  );
  out = out.replace(/<risk\s*[^>]*>([\s\S]*?)<\/risk>/gi, "$1");

  // <verdict type="bullish|bearish|neutral">X</verdict> — directional emoji + italic.
  out = out.replace(
    /<verdict\s+type="bullish"\s*>([\s\S]*?)<\/verdict>/gi,
    `${SENTINEL_I_OPEN}🐂 $1${SENTINEL_I_CLOSE}`,
  );
  out = out.replace(
    /<verdict\s+type="bearish"\s*>([\s\S]*?)<\/verdict>/gi,
    `${SENTINEL_I_OPEN}🐻 $1${SENTINEL_I_CLOSE}`,
  );
  out = out.replace(
    /<verdict\s+type="neutral"\s*>([\s\S]*?)<\/verdict>/gi,
    `${SENTINEL_I_OPEN}〰️ $1${SENTINEL_I_CLOSE}`,
  );
  out = out.replace(
    /<verdict\s*[^>]*>([\s\S]*?)<\/verdict>/gi,
    `${SENTINEL_I_OPEN}$1${SENTINEL_I_CLOSE}`,
  );

  // Insert a blank line before a standalone <verdict> block (one that starts on
  // its own line). Restricted to italic-sentinel + verdict emoji prefix to avoid
  // inserting extra newlines before other italic content. Inline verdicts
  // mid-paragraph (no preceding newline) are intentionally left unchanged.
  out = out.replace(/(\n)(\x00I_OPEN\x00(?:🐂 |🐻 |〰️ )?)/g, "$1\n$2");

  // <asks>…</asks> — wizard ask block. Web renders this as an interactive
  // card; Telegram has no inline card affordance, so we flatten it into a
  // numbered question list with a hint about the expected reply shape.
  // The trade-executor skill commits the agent to plain `<title> = <answer>`
  // lines, one per question, on either channel.
  //
  // Legacy `<ask_user_question>` is still accepted — CommonMark raw-HTML
  // disallows underscores so the web markdown parser couldn't tokenize it,
  // but Telegram strips tags directly and older streams or model
  // hallucinations can still emit this form.
  out = out.replace(
    /<(asks|ask_user_question)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi,
    (_full, _tag: string, inner: string) => formatAskFallback(inner),
  );

  // <chart symbol="X" interval="Y" ... /> — emit a footer hint instead of
  // dropping silently. The paired form <chart ...>...</chart> also emits the
  // same hint (rare LLM variant). Both must be handled BEFORE the generic
  // self-closing and paired-fallback passes below.
  const chartHint = (attrs: string): string => {
    const symMatch = /\bsymbol\s*=\s*"([^"]+)"/i.exec(attrs);
    const intMatch = /\binterval\s*=\s*"([^"]+)"/i.exec(attrs);
    if (!symMatch || !intMatch) return "";
    return `\n📊 ${symMatch[1]} ${intMatch[1]} chart`;
  };
  // Paired form first: <chart ...>...</chart> — must precede self-closing pass.
  out = out.replace(/<chart\s*([^>]*)>([\s\S]*?)<\/chart>/gi, (_m, attrs: string) =>
    chartHint(attrs),
  );
  // Self-closing form: <chart ... /> (requires closing slash).
  out = out.replace(/<chart\s+([^>]*?)\/>/gi, (_m, attrs: string) => chartHint(attrs));

  // Unknown self-closing tag → drop entirely.
  out = out.replace(/<[a-zA-Z][\w-]*\b[^/>]*\/>/g, "");

  // Generic paired fallback. We loop because the agent may nest unknown wrappers
  // around known ones (e.g. <side><price>X</price></side>). Each pass peels one
  // layer; capped to avoid pathological input.
  for (let i = 0; i < 5; i++) {
    const before = out;
    out = out.replace(/<([a-zA-Z][\w-]*)\b[^>]*>([\s\S]*?)<\/\1>/g, "$2");
    if (out === before) break;
  }

  // Strip any unclosed trailing tag that might be streaming mid-token — prevents
  // a partial `<pri` from poisoning the HTML-escape pass.
  out = out.replace(/<[a-zA-Z][^>]*$/g, "");

  return out;
}

/**
 * Render the inner of an `<asks>…</asks>` block as a numbered Q list for
 * Telegram. Only titles are shown — options are intentionally omitted to
 * keep the chat output compact.
 */
function formatAskFallback(inner: string): string {
  const questionRe = /<question>([\s\S]*?)<\/question>/gi;
  const titleRe = /<title>([\s\S]*?)<\/title>/i;

  const lines: string[] = [];
  let m: RegExpExecArray | null;
  let i = 1;
  while ((m = questionRe.exec(inner)) !== null) {
    const title = titleRe.exec(m[1])?.[1]?.trim();
    if (!title) continue;
    lines.push(`${i}. ${title}`);
    i++;
  }
  if (lines.length === 0) return "";
  return `\n${lines.join("\n")}`;
}
