/* ── Math delimiter normalizer ──
 *
 * LLMs frequently emit LaTeX-source delimiters (`\[ ... \]`,
 * `\( ... \)`) instead of Markdown-math (`$$ ... $$`).
 * `remark-math` only tokenizes byte `36` (`$`), so escaped-LaTeX
 * expressions flow through as literal text. Substitute them.
 *
 * Single-`$` text math is disabled on the math plugin, so only
 * `$$ ... $$` triggers math (inline when used inline, block when
 * it stands alone as a paragraph). That keeps currency strings
 * like `$50,000` rendering verbatim without escaping. Inline
 * `\( ... \)` is rewritten to `$$ ... $$` so it still renders.
 *
 * Fenced code (` ``` `) and inline code (`` ` ``) are preserved
 * verbatim so the substitutions don't corrupt code samples.
 */

const CODE_SEGMENT = /(```[\s\S]*?```|`[^`\n]+`)/g;
const BLOCK_LATEX = /\\\[([\s\S]*?)\\\]/g;
const INLINE_LATEX = /\\\(([\s\S]*?)\\\)/g;

export function normalizeMathDelimiters(text: string): string {
  if (!hasAnyTarget(text)) return text;
  return text
    .split(CODE_SEGMENT)
    .map((segment, i) => (i % 2 === 1 ? segment : convertSegment(segment)))
    .join('');
}

function hasAnyTarget(text: string): boolean {
  return text.includes('\\[') || text.includes('\\(');
}

function convertSegment(segment: string): string {
  return segment
    .replace(BLOCK_LATEX, (_m, inner) => `\n\n$$\n${inner.trim()}\n$$\n\n`)
    .replace(INLINE_LATEX, (_m, inner) => `$$${inner.trim()}$$`);
}
