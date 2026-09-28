/**
 * URL kill switch for the always-on, non-Essentia structure analyzer
 * (`StructureAnalyzer.ts`). Mirrors `engine/look/lookFlags.ts`'s pattern
 * exactly: every reader takes an INJECTABLE search string (tests, or a caller
 * that already has one) and defaults to `location.search`; with no `location`
 * (node, workers) or a throwing one it falls back to the "flag absent" answer,
 * so the flag can never break boot.
 *
 *  - `?structure=off` disables the analyzer entirely: `StructureAnalyzer`
 *    constructed with `{ disabled: true }` makes `update()` always return
 *    `null` and skip all per-frame work, reproducing exactly the pre-this-
 *    feature (Essentia-only) behaviour where `structureValid` never goes
 *    true — the plan's documented escape hatch.
 *
 * DESIGN: unlike `?lookdebug` (meaningfully different when bare vs. off),
 * `?structure` has exactly one useful non-default state — "disable it" — so
 * this treats PRESENCE of the param alone as off, whatever its value (bare,
 * `=off`, `=0`, anything). There is no "on" spelling to reserve: the analyzer
 * is on by default and this is a one-way kill switch. `?structure=off` is the
 * documented, expected spelling; the tolerant presence check just means a
 * typo'd value still disables rather than silently doing nothing.
 */

function readSearch(search?: string): string {
  if (search !== undefined) return search
  try {
    return typeof location === 'undefined' ? '' : location.search
  } catch {
    return ''
  }
}

function paramsOf(search?: string): URLSearchParams | null {
  try {
    return new URLSearchParams(readSearch(search))
  } catch {
    return null
  }
}

/** `?structure=off` (or bare `?structure`, or any other value) disables `StructureAnalyzer`. */
export function structureOff(search?: string): boolean {
  const p = paramsOf(search)
  return p !== null && p.has('structure')
}
