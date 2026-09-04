import { describe, expect, it } from 'vitest'
import HUD_SRC from '../HUD.tsx?raw'
import INDICATOR_SRC from '../FilterIndicator.tsx?raw'
import { DISABLED_FILTERS, ISF_FILTERS, isFilterSelectable } from '../../engine/isfFilterRoster'

/**
 * ## Why nothing here asserts against `styles.css`
 *
 * Two rules in that file are load-bearing for this feature —
 * `.filter-indicator[hidden] { display: none }` (without it the indicator's
 * `hidden` write is inert, because the author `display: flex` outranks the UA
 * sheet) and `.chip-disabled.chip-hand-firable { pointer-events: auto }`
 * (without it the off-roster chips are visible but unclickable). Both would be
 * natural to pin here, and neither can be: Vite's CSS pipeline owns the
 * `.css` specifier, and under this project's Vitest config (`environment:
 * 'node'`, CSS processing off) both `?raw` and `?inline` resolve to the empty
 * string — measured, not assumed. An assertion against `''` passes vacuously
 * forever, which is worse than no assertion. Reading the file from disk
 * instead needs `node:fs`, and `@types/node` is not in this program.
 *
 * So the pins below are on the TSX side of each pair, and the CSS side is
 * commented at both call sites to say what it is holding up.
 */

/**
 * Pins the manual half of the ISF filter layer: the HUD chips that fire a
 * filter by hand, and the corner readout that says which one is running.
 *
 * Source-string checks, same convention and same reason as
 * `canHoldPrimary.test.ts` and `credits.test.ts` — rendering the HUD needs a
 * DOM and a live store, which this suite has no business standing up to
 * assert that a click handler and a mount exist.
 *
 * ## Why each of these is worth pinning
 *
 * The filter layer fires autonomously. Before this UI, a filter changing the
 * whole picture for 3.5 s was indistinguishable from a bug, and there was no
 * way to see one on demand. The failure modes that would quietly restore that
 * state are all invisible in review: the chip row surviving but bound to the
 * wrong store action, the indicator surviving but mounted behind a toggle
 * nobody turns on, or the indicator being "simplified" into `useState` and
 * turning a 15 Hz DOM write into a 15 Hz React render of the entire HUD
 * subtree — on exactly the frames where the filter pass is already mounted
 * and drawing.
 */

/** The `section('filters', …)` body, from its id to the start of the next section. */
function filtersSection(): string {
  const start = HUD_SRC.indexOf("'filters',")
  expect(start, "HUD must contain a section('filters', …)").toBeGreaterThan(-1)
  const rest = HUD_SRC.slice(start)
  const end = rest.indexOf('{section(')
  return end === -1 ? rest : rest.slice(0, end)
}

describe('the HUD filter chips', () => {
  it('offers one chip per filter and fires it through requestFilter', () => {
    const body = filtersSection()
    expect(body).toContain('ISF_FILTERS.map(')
    expect(body).toMatch(/useStore\.getState\(\)\.requestFilter\(f\.id\)/)
    expect(HUD_SRC).toContain("from '../engine/isfFilterRoster'")
  })

  it('lists every filter, not just the selectable ones', () => {
    // `selectableFilters()` is the DIRECTOR's list. Using it here would hide
    // the off-roster filters from the one surface that is still allowed to
    // fire them — the roster has at least one, so this is a live distinction.
    expect(DISABLED_FILTERS.length).toBeGreaterThan(0)
    expect(ISF_FILTERS.filter((f) => isFilterSelectable(f.id)).length).toBeLessThan(
      ISF_FILTERS.length,
    )
    expect(filtersSection()).not.toContain('selectableFilters(')
  })

  it('greys the off-roster filters but leaves them clickable', () => {
    const body = filtersSection()
    // Greyed via the shared class...
    expect(body).toMatch(/isFilterSelectable\(f\.id\)\s*\n?\s*\?\s*''/)
    // `chip-hand-firable` is the modifier that takes back `.chip-disabled`'s
    // `pointer-events: none` (styles.css). Losing it makes every off-roster
    // chip look present and do nothing when clicked.
    expect(body).toContain('chip-hand-firable')
  })

  it('hard-disables an UNUSABLE filter, which an off-roster one must never be', () => {
    const body = filtersSection()
    // The two states are easy to collapse into one on a later edit, and doing
    // so breaks in opposite directions: hard-disabling an off-roster filter
    // removes a legitimate manual override, while merely greying an unusable
    // one leaves a chip that blacks out the show when clicked.
    //
    // `disabled` is keyed off the REASON, never off `isFilterSelectable` —
    // that predicate is false for both states and cannot tell them apart.
    expect(body).toMatch(/disabled=\{broken !== undefined\}/)
    expect(body).not.toMatch(/disabled=\{[^}]*isFilterSelectable/)
    expect(body).toContain('filterUnusableReason(f.id)')
    // And the reason is surfaced, not swallowed: a dead control with no
    // explanation is the thing this whole state exists to avoid.
    expect(body).toMatch(/unavailable: \$\{broken\}/)
  })

  it('is not gated behind the Post FX debug override', () => {
    // Manual triggering is a performance feature. If it ends up inside the
    // `postfx` section's `debugPostFx.enabled` fence, every chip goes inert
    // for anyone who has not first flipped a debug switch.
    expect(filtersSection()).not.toContain('debugPostFx')
  })

  it('carries the filter credit into the chip title', () => {
    const body = filtersSection()
    expect(body).toContain('f.credit')
    expect(body).toContain('f.description')
    // The credits are only useful if they are actually there to carry.
    expect(ISF_FILTERS.some((f) => f.credit)).toBe(true)
  })
})

describe('the FilterIndicator mount', () => {
  it('is imported and mounted unconditionally, unlike the fps meter', () => {
    expect(HUD_SRC).toContain("import { FilterIndicator } from './FilterIndicator'")
    expect(HUD_SRC).toContain('<FilterIndicator />')
    // No `x && <FilterIndicator />`: it gates itself on whether a filter is
    // firing, so a store toggle in front of it would only add a way to miss
    // the one thing it exists to show.
    expect(HUD_SRC).not.toMatch(/&&\s*<FilterIndicator/)
  })
})

describe('FilterIndicator DOM discipline', () => {
  it('reads performanceState directly rather than subscribing', () => {
    expect(INDICATOR_SRC).toContain("from '../engine/performanceState'")
    expect(INDICATOR_SRC).toContain('performanceState.filter')
    expect(INDICATOR_SRC).not.toContain('useStore')
  })

  it('drives the DOM from refs inside one rAF loop, and never re-renders', () => {
    expect(INDICATOR_SRC).toContain('useRef')
    expect(INDICATOR_SRC).toContain('requestAnimationFrame')
    expect(INDICATOR_SRC).toContain('cancelAnimationFrame')
    // The whole point: no React state, so nothing here can schedule a render
    // after mount.
    // Matched against CODE — the react import and a call site — rather than
    // the bare word, which also appears in the header explaining the rule.
    expect(INDICATOR_SRC).not.toMatch(/^import .*\buseState\b.*from 'react'/m)
    expect(INDICATOR_SRC).not.toMatch(/\buseState\s*[(<]/)
  })

  it('throttles the loop and diffs every write', () => {
    expect(INDICATOR_SRC).toMatch(/const HZ = \d+/)
    expect(INDICATOR_SRC).toMatch(/now - lastAt < INTERVAL_MS/)
    // Each of the three writes — visibility, name, mix — is behind a compare
    // against the last value written.
    expect(INDICATOR_SRC).toMatch(/hide !== lastHidden/)
    expect(INDICATOR_SRC).toMatch(/id !== lastName/)
    expect(INDICATOR_SRC).toMatch(/pct !== lastPct/)
  })

  it('hides itself when no filter is firing', () => {
    expect(INDICATOR_SRC).toMatch(/const hide = id === null/)
    expect(INDICATOR_SRC).toMatch(/\.hidden = hide/)
    // The matching `.filter-indicator[hidden] { display: none }` in styles.css
    // is what makes this write actually hide anything — see the header note on
    // why that half cannot be asserted from here.
  })
})
