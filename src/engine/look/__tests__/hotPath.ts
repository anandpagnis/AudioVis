/**
 * Test helper: a lightweight source-text pin that the per-frame ("hot path") code of the look system does not
 * allocate. Source files mark their per-frame regions with `// @hot-path:begin` ... `// @hot-path:end`; this
 * extracts those regions (comments removed) and looks for constructs that allocate or invite allocation.
 * Not a proof (a helper it calls could allocate), but it catches the usual regressions in review-free CI.
 */

/** The source text of every marked per-frame region, comments removed. */
export function hotPath(src: string): string {
  const parts: string[] = []
  const re = /\/\/ @hot-path:begin[^\n]*\n([\s\S]*?)\/\/ @hot-path:end/g
  for (let m = re.exec(src); m !== null; m = re.exec(src)) parts.push(m[1])
  return parts
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** Constructs that allocate (or are allocation-prone) and so must not appear in per-frame code. */
export const ALLOCATING: readonly (readonly [string, RegExp])[] = [
  ['new', /\bnew\s/],
  ['spread', /\.\.\./],
  ['arrow function / closure', /=>/],
  ['function expression', /\bfunction\s*\(/],
  ['array literal', /(?:[=(,:?[]|\breturn)\s*\[/],
  ['object literal', /(?:[=(,:?]|\breturn)\s*\{/],
  ['array helper', /\.(?:map|filter|slice|concat|reduce|forEach|flatMap|splice|from|of)\(/],
  ['Object helper', /\bObject\.(?:keys|values|entries|assign|fromEntries)\b/],
  ['template literal', /`/],
]

/** Human-readable findings (empty when clean). */
export function findAllocations(src: string): string[] {
  const out: string[] = []
  for (const [name, re] of ALLOCATING) {
    const m = re.exec(src)
    if (m !== null) out.push(`${name}: ...${src.slice(Math.max(0, m.index - 30), m.index + 40).replace(/\s+/g, ' ')}...`)
  }
  return out
}
