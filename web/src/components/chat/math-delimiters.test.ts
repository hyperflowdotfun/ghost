/**
 * Unit tests for the math-delimiter normalizer.
 *
 * The normalizer runs on every streamed chat chunk before remark-math sees
 * it, so any regression here surfaces as garbled math/currency in the chat
 * stream. We rely on `singleDollarTextMath: false` in StreamingMarkdown.tsx
 * so single-`$` is literal and `$$ ... $$` is the only math delimiter.
 */

import { describe, test, expect } from "bun:test";
import { normalizeMathDelimiters } from "./math-delimiters";

describe("normalizeMathDelimiters — currency passthrough", () => {
  test("plain $50 is unchanged", () => {
    expect(normalizeMathDelimiters("Cost is $50 today")).toBe("Cost is $50 today");
  });

  test("$50,000 with thousands separator is unchanged", () => {
    expect(normalizeMathDelimiters("BTC at $50,000")).toBe("BTC at $50,000");
  });

  test("$2.40 decimal is unchanged", () => {
    expect(normalizeMathDelimiters("Fee: $2.40")).toBe("Fee: $2.40");
  });

  test("$1.5M shorthand is unchanged", () => {
    expect(normalizeMathDelimiters("Volume hit $1.5M")).toBe("Volume hit $1.5M");
  });

  test("multiple currency strings in one line are unchanged", () => {
    const input = "Bought at $42,000, sold at $45,500 for $3,500 profit";
    expect(normalizeMathDelimiters(input)).toBe(input);
  });
});

describe("normalizeMathDelimiters — LaTeX delimiter rewriting", () => {
  test("inline \\( ... \\) is rewritten to $$ ... $$", () => {
    expect(normalizeMathDelimiters("compute \\(R_p\\) per asset")).toBe(
      "compute $$R_p$$ per asset",
    );
  });

  test("block \\[ ... \\] is rewritten to $$ ... $$ with blank lines", () => {
    expect(normalizeMathDelimiters("intro\\[ x + y \\]outro")).toBe(
      "intro\n\n$$\nx + y\n$$\n\noutro",
    );
  });

  test("inner whitespace is trimmed when rewriting inline", () => {
    expect(normalizeMathDelimiters("\\( \\sigma_p \\)")).toBe("$$\\sigma_p$$");
  });

  test("multi-line block expression is preserved", () => {
    const input = "\\[\n  a^2 + b^2 = c^2\n\\]";
    const out = normalizeMathDelimiters(input);
    expect(out).toContain("$$");
    expect(out).toContain("a^2 + b^2 = c^2");
  });
});

describe("normalizeMathDelimiters — code preservation", () => {
  test("fenced code block containing \\(...\\) is left untouched", () => {
    const input = "before\n```\nlet x = \\(unchanged\\);\n```\nafter";
    expect(normalizeMathDelimiters(input)).toBe(input);
  });

  test("inline backtick code containing $ is left untouched", () => {
    const input = "use `$50,000` as the threshold";
    expect(normalizeMathDelimiters(input)).toBe(input);
  });

  test("inline backtick code containing \\(...\\) is left untouched", () => {
    const input = "use `\\(R_p\\)` syntax";
    expect(normalizeMathDelimiters(input)).toBe(input);
  });
});

describe("normalizeMathDelimiters — no-op fast path", () => {
  test("text without \\[ or \\( returns the same reference", () => {
    const input = "just a plain sentence, no math, no currency";
    expect(normalizeMathDelimiters(input)).toBe(input);
  });

  test("text containing only $ (no LaTeX) returns the same reference", () => {
    // singleDollarTextMath is disabled; bare $ is literal — nothing to do.
    const input = "Worth $42 right now";
    expect(normalizeMathDelimiters(input)).toBe(input);
  });
});
