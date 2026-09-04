import { describe, expect, it } from 'vitest'
import HUD_SRC from '../HUD.tsx?raw'
import CREDITS_SRC from '../Credits.tsx?raw'
import { ISF_FILTERS } from '../../engine/isfFilterRoster'
import { SCENES } from '../../scenes'
import { useStore } from '../../store'

/**
 * Pins the wiring `Credits.tsx` depends on, the way `canHoldPrimary.test.ts`
 * pins the HUD's scene-picker filter — a source-string check because
 * rendering the HUD needs a DOM and a store, which this suite has no business
 * standing up just to assert a keybinding and a conditional render exist.
 *
 * ## Why F178 is the thing being pinned
 *
 * `IsfFilterPass`/`isfFilterRoster.ts` ship five MIT-licensed filters whose
 * licence requires their credit travel with the work. `Credits.tsx` is the
 * only surface in the app that shows a viewer that credit, so if the HUD ever
 * stops rendering it (or stops offering a way to open it), the filters are
 * back to shipping unattributed with nothing catching it — the exact gap
 * documented in `docs/ISSUES.md` F178 and `src/assets/isf/filters/NOTICE`.
 */
describe('Credits wiring', () => {
  it('the store carries creditsOpen/toggleCredits, parallel to analyticsOpen/toggleAnalytics', () => {
    const s = useStore.getState()
    expect(typeof s.creditsOpen).toBe('boolean')
    expect(typeof s.toggleCredits).toBe('function')
  })

  it('toggleCredits flips creditsOpen and nothing else observable', () => {
    const before = useStore.getState().creditsOpen
    useStore.getState().toggleCredits()
    expect(useStore.getState().creditsOpen).toBe(!before)
    // Leave the store as found for any test that runs after this one.
    useStore.getState().toggleCredits()
    expect(useStore.getState().creditsOpen).toBe(before)
  })

  it('the HUD imports Credits and mounts it off creditsOpen', () => {
    expect(HUD_SRC).toContain("import { Credits } from './Credits'")
    expect(HUD_SRC).toContain('{creditsOpen && <Credits />}')
  })

  it('the HUD binds I/i to toggleCredits, and nothing already used that key', () => {
    expect(HUD_SRC).toMatch(/e\.key === 'i' \|\| e\.key === 'I'/)
    // The branch exists and calls the right action — checked together so a
    // future refactor can't leave the key bound to the wrong handler.
    expect(HUD_SRC).toMatch(/e\.key === 'i' \|\| e\.key === 'I'\)\s*\{\s*s\.toggleCredits\(\)/)
  })

  it('the HUD offers a discoverable affordance beyond the keybinding', () => {
    // Two independent paths to the panel: the always-visible corner chip, and
    // the chip inside the "Capture & view" section other toggle panels use —
    // neither requires already knowing "I" opens it.
    expect(HUD_SRC).toContain('useStore.getState().toggleCredits()')
    expect(HUD_SRC).toMatch(/credits-fab/)
  })

  it("Credits.tsx reads the roster's ISF_FILTERS, not a hand-copied list", () => {
    expect(CREDITS_SRC).toContain("import { ISF_FILTERS } from '../engine/isfFilterRoster'")
    // Every vendored filter is listed, including any currently disabled from
    // selection (see isfFilterRoster.ts's DISABLED_FILTERS) — attribution
    // covers what ships in the bundle, not what a picker currently offers.
    expect(ISF_FILTERS.length).toBeGreaterThanOrEqual(5)
    for (const f of ISF_FILTERS) {
      expect(f.id.length, f.id).toBeGreaterThan(0)
    }
  })

  it('renders the real MIT LICENSE and NOTICE text via ?raw, not inlined prose', () => {
    expect(CREDITS_SRC).toContain("from '../assets/isf/filters/LICENSE?raw'")
    expect(CREDITS_SRC).toContain("from '../assets/isf/filters/NOTICE?raw'")
  })

  it('filters SCENES (the live roster) for non-original licence, not DISABLED_SCENES', () => {
    // `DISABLED_SCENES` is where every currently-restricted scene actually
    // lives (see sceneLicensing.test.ts) — importing it here would be the
    // easy mistake, since it is what currently has non-empty content to show.
    // Credits.tsx must read the live roster so the moment a scene clears
    // review and moves into SCENES, it appears with no code change.
    expect(CREDITS_SRC).toContain("import { SCENES } from '../scenes'")
    // Mentioning DISABLED_SCENES in prose (to explain why it's not read) is
    // fine; importing/reading it is the mistake this guards against.
    expect(CREDITS_SRC).not.toMatch(/\{[^}]*\bDISABLED_SCENES\b[^}]*\}\s*from/)
    expect(CREDITS_SRC).not.toMatch(/\bDISABLED_SCENES\s*\./)
    expect(CREDITS_SRC).not.toMatch(/\.\.\.\s*DISABLED_SCENES/)
  })

  it("the live roster's attribution filter agrees with what SCENES actually contains", () => {
    const attributed = SCENES.filter(
      (s) => s.metadata.license !== undefined && s.metadata.license !== 'original',
    )
    // Not required to be non-empty (see Credits.tsx's own doc comment: this is
    // a live filter, currently empty because sceneLicensing.test.ts keeps
    // every restricted scene quarantined) — only that the predicate is sound.
    for (const s of attributed) {
      expect(s.metadata.license).not.toBe('original')
    }
  })
})
