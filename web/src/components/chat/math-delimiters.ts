/* ── Math delimiter + currency normalizer ──
 *
 * Two responsibilities, single pass:
 *
 * 1. LLMs frequently emit LaTeX-source delimiters (`\[ ... \]`,
 *    `\( ... \)`) instead of Markdown-math (`$$ ... $$`, `$ ... $`).
 *    `remark-math` only tokenizes byte `36` (`$`), so escaped-LaTeX
 *    expressions flow through as literal text. Substitute them.
 *
 * 2. With `singleDollarTextMath: true` enabled on the math plugin,
 *    `$...$` becomes inline math. That lets `$R_p$` render in tables
 *    and prose — but also exposes currency strings like `$50,000` to
 *    accidental math tokenization. Escape clearly-currency patterns
 *    (`$50,000`, `$1.5`, `$5K`, `$1.5M`) to `\$...` so they stay
 *    literal. Plain `$50` standalone is too ambiguous to escape
 *    safely; SOUL.md mandates the `<price>` tag for currency, so
 *    bare numeric `$NN` slip-through is rare.
 *
 * Fenced code (` ``` `) and inline code (`` ` ``) are preserved
 * verbatim so the substitutions don't corrupt code samples.
 */

const CODE_SEGMENT = /(```[\s\S]*?```|`[^`\n]+`)/g;
const BLOCK_LATEX = /\\\[([\s\S]*?)\\\]/g;
const INLINE_LATEX = /\\\(([\s\S]*?)\\\)/g;
// Currency patterns: $50,000 / $1,234.56 / $1.5 / $0.001 / $5K / $1.5M
const CURRENCY = /\$(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+|\d+[KMBkmb])/g;

export function normalizeMathDelimiters(text: string): string {
  if (!hasAnyTarget(text)) return text;
  return text
    .split(CODE_SEGMENT)
    .map((segment, i) => (i % 2 === 1 ? segment : convertSegment(segment)))
    .join('');
}

function hasAnyTarget(text: string): boolean {
  return text.includes('\\[') || text.includes('\\(') || text.includes('$');
}

function convertSegment(segment: string): string {
  return segment
    .replace(CURRENCY, '\\$$$1')
    .replace(BLOCK_LATEX, (_m, inner) => `\n\n$$\n${inner.trim()}\n$$\n\n`)
    .replace(INLINE_LATEX, (_m, inner) => `$${inner.trim()}$`);
}
