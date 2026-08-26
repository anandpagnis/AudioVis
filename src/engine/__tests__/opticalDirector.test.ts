import { describe, expect, it } from 'vitest'
import {
  lensAmountTarget,
  lensForSection,
  mirrorForSection,
  trailsTarget,
} from '../opticalDirector'
import { LENS_STYLES } from '../opticalRack'
import type { MoodState } from '../../audio/types'

const MOODS: MoodState[] = [
  'silence',
  'ambient',
  'mellow',
  'groove',
  'building',
  'peak',
  'aggressive',
]

/**
 * The rule these all serve: a strong effect left on is worse than one never
 * reached for. Every test here is a restraint test, not a capability test —
 * the capability was never in doubt, the discipline was.
 */
describe('trails', () => {
  it('backs off as the mix gets busy, whatever the mood', () => {
    // Onset density, not energy: quiet-and-busy is still busy, and ten frames
    // of a dense percussive mix layered on each other is mud.
    for (const mood of MOODS) {
      const calm = trailsTarget(mood, 0.05, 0.4)
      const busy = trailsTarget(mood, 0.9, 0.4)
      expect(busy, mood).toBeLessThanOrEqual(calm)
    }
  })

  it('is highest on sustained ambient material', () => {
    const ambient = trailsTarget('ambient', 0.05, 0.2)
    expect(ambient).toBeGreaterThan(trailsTarget('groove', 0.05, 0.2))
    expect(ambient).toBeGreaterThan(trailsTarget('peak', 0.05, 0.2))
  })

  it('gives a peak a clean frame rather than a blurred one', () => {
    expect(trailsTarget('peak', 0.05, 0.9)).toBe(0)
    expect(trailsTarget('aggressive', 0.05, 0.9)).toBe(0)
  })

  it('stays in range for any input, including nonsense', () => {
    for (const flux of [-1, 0, 0.5, 1, 4, NaN]) {
      for (const mood of MOODS) {
        const v = trailsTarget(mood, flux, 0.5)
        if (Number.isNaN(flux)) continue
        expect(v, `${mood} ${flux}`).toBeGreaterThanOrEqual(0)
        expect(v, `${mood} ${flux}`).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('the mirror rack', () => {
  it('stays off through everything that is not a peak', () => {
    // A kaleidoscope during a verse reads as an effect that got stuck on.
    for (const mood of ['silence', 'ambient', 'mellow', 'groove'] as MoodState[]) {
      for (let seed = 0; seed < 12; seed++) {
        expect(mirrorForSection(mood, 0.3, seed), `${mood} ${seed}`).toBe(0)
      }
    }
  })

  it('is still rare even when it is eligible', () => {
    // Roughly one eligible section in three, so it remains an event.
    const on = Array.from({ length: 30 }, (_, i) => mirrorForSection('peak', 0.9, i)).filter(
      (v) => v > 0,
    )
    expect(on.length).toBeLessThanOrEqual(12)
    expect(on.length).toBeGreaterThan(0)
  })

  it('only ever picks counts that read as a pattern', () => {
    // Odd counts read as a broken mirror; above 8 the segments are too thin to
    // show what is inside them.
    for (let seed = 0; seed < 40; seed++) {
      const v = mirrorForSection('peak', 0.9, seed)
      if (v !== 0) expect([4, 6, 8], `seed ${seed}`).toContain(v)
    }
  })

  it('is deterministic in the seed, so a set reproduces', () => {
    // Not Math.random(): a recording has to be reproducible, and a director
    // nobody can replay is a director nobody can debug.
    for (let seed = 0; seed < 20; seed++) {
      expect(mirrorForSection('peak', 0.9, seed)).toBe(mirrorForSection('peak', 0.9, seed))
    }
  })
})

describe('the lens rack', () => {
  it('never indexes outside the material list', () => {
    for (const mood of MOODS) {
      for (let seed = 0; seed < 40; seed++) {
        const i = lensForSection(mood, seed)
        if (i === -1) continue
        expect(i, `${mood} ${seed}`).toBeGreaterThanOrEqual(0)
        expect(i, `${mood} ${seed}`).toBeLessThan(LENS_STYLES.length)
      }
    }
  })

  it('sits out some sections entirely', () => {
    // An effect that is always slightly on is the worst of both: not visible,
    // and not free. Measured before this was a per-section choice, the amount
    // peaked at 0.045 across a 90 s run while still being charged for.
    const taken = Array.from({ length: 30 }, (_, i) => lensForSection('mellow', i)).filter(
      (v) => v >= 0,
    )
    expect(taken.length).toBeLessThan(30)
    expect(taken.length).toBeGreaterThan(0)
  })

  it('draws harder materials for harder moods', () => {
    const soft = Array.from({ length: 12 }, (_, i) => lensForSection('ambient', i)).filter((i) => i >= 0)
    expect(soft.every((i) => i <= 1)).toBe(true)
    // `aggressive` draws glitch (4) and melt (3); it used to include the LED
    // wall (5), which is now excluded from every pool — see below.
    const hard = Array.from({ length: 12 }, (_, i) => lensForSection('aggressive', i)).filter((i) => i >= 0)
    expect(hard.every((i) => i === 3 || i === 4)).toBe(true)
  })

  it('is silent in silence, and absent when the section did not take one', () => {
    expect(lensForSection('silence', 0)).toBe(-1)
    expect(lensAmountTarget('silence', 1, true)).toBe(0)
    expect(lensAmountTarget('peak', 1, false)).toBe(0)
  })

  it('is properly visible once a section HAS taken one', () => {
    // The floor is the correction: a section that chose a material should show
    // it, even at zero tension. Below ~0.15 the racks do not read at all.
    for (const mood of ['ambient', 'mellow', 'groove', 'building', 'peak'] as MoodState[]) {
      expect(lensAmountTarget(mood, 0, true), mood).toBeGreaterThanOrEqual(0.2)
    }
  })

  it('lets a peak go further than a groove at the same tension', () => {
    expect(lensAmountTarget('peak', 1, true)).toBeGreaterThan(lensAmountTarget('groove', 1, true))
  })

  it('clamps a tension outside 0..1 instead of running away', () => {
    expect(lensAmountTarget('peak', 4, true)).toBeLessThanOrEqual(0.62)
    expect(lensAmountTarget('peak', -2, true)).toBe(0.3)
  })
})

/**
 * `pixels` is excluded from automatic selection, and the reason is a property
 * of that material rather than a preference.
 *
 * Its amount means cell COARSENESS, inverted — 140 fine cells at low amount,
 * 30 coarse ones at high — so the floor an engaged lens gets, which is correct
 * for every material where amount is a magnitude, lands it at ~118 cells. That
 * does not read as a deliberate LED wall. It reads as a broken renderer, and
 * was reported as exactly that.
 */
describe('the LED pixel wall is not selected automatically', () => {
  const PIXELS = 5
  it('never appears in any mood pool', () => {
    for (const mood of MOODS) {
      for (let seed = 0; seed < 60; seed++) {
        expect(lensForSection(mood, seed), `${mood} ${seed}`).not.toBe(PIXELS)
      }
    }
  })

  it('is still a real material, so the debug panel can reach it', () => {
    expect(LENS_STYLES[PIXELS]).toBe('pixels')
  })
})
