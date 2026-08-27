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

  it('still gives a peak less than an ambient passage', () => {
    // The shape survives the amplitude change: a peak wants a more legible
    // frame than a held pad does. What changed is that it is no longer ZERO —
    // trails are meant to be a visible part of the show now, and a top of the
    // set with none at all was reading as the effect switching off.
    const peak = trailsTarget('peak', 0.05, 0.9)
    const ambient = trailsTarget('ambient', 0.05, 0.9)
    expect(peak).toBeGreaterThan(0.2)
    expect(peak).toBeLessThan(ambient)
    expect(trailsTarget('aggressive', 0.05, 0.9)).toBeLessThan(peak)
  })

  it('leaves a busy mix with half its trails rather than none', () => {
    // The first curve took `groove` to about 0.07 on a busy passage, which is
    // nothing. The penalty is still there, it just no longer erases the effect.
    const calm = trailsTarget('groove', 0.05, 0.4)
    const busy = trailsTarget('groove', 1.0, 0.4)
    expect(busy).toBeGreaterThan(calm * 0.4)
    expect(busy).toBeLessThan(calm)
  })

  it('reaches values a viewer can actually see', () => {
    // The measured maximum across a 90 s set used to be 0.275, most of it
    // between 0.07 and 0.2.
    expect(trailsTarget('ambient', 0.05, 0.2)).toBeGreaterThan(0.75)
    expect(trailsTarget('groove', 0.3, 0.5)).toBeGreaterThan(0.45)
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
  const on = (t: ReturnType<typeof mirrorForSection>) => t.mode !== 'off'

  it('stays off through silence and ambient, whatever the tension', () => {
    // A kaleidoscope over a held pad is an effect that got stuck on, which is
    // the one failure this rack cannot recover from.
    for (const mood of ['silence', 'ambient'] as MoodState[]) {
      for (let seed = 0; seed < 12; seed++) {
        expect(on(mirrorForSection(mood, 0.4, seed)), `${mood} ${seed}`).toBe(false)
      }
    }
  })

  it('now engages a groove readily, which is the point of the second pass', () => {
    // It used to need tension above 0.25 on a groove and fire on one eligible
    // section in three, which across a whole set meant it essentially never
    // appeared. Silence and ambient are the only restraint kept.
    expect(on(mirrorForSection('groove', 0.1, 0))).toBe(true)
    expect(on(mirrorForSection('groove', 0.6, 0))).toBe(true)
  })

  it('still leaves a dead-calm groove alone', () => {
    // There is a floor, it is just a low one: no tension at all is still no
    // reason to fold the frame.
    expect(on(mirrorForSection('groove', 0, 0))).toBe(false)
  })

  it('still sits out some sections even when eligible', () => {
    // Two in three, not every one. The whole point of the rack is that it
    // arrives rather than being ambient.
    const fired = Array.from({ length: 30 }, (_, i) => mirrorForSection('peak', 0.9, i)).filter(on)
    expect(fired.length).toBeLessThan(30)
    expect(fired.length).toBeGreaterThan(12)
  })

  it('drives every field it still owns, not just the segment count', () => {
    // Was "all five fields", guarding the defect where `tiles`, `twist` and
    // `slice` were written by nothing but the debug panel and three of five
    // controls were dead in the running show.
    //
    // `tiles` and `slice` are retired (F108), so for those two the assertion
    // inverts: they must now be written by nothing at all. The original guard
    // survives intact for the fields that are still live — `twist` and `spin`
    // are driven by the director, which is what the defect was about.
    const all = Array.from({ length: 30 }, (_, i) => mirrorForSection('peak', 0.9, i))
    expect(all.some((t) => t.segments >= 3)).toBe(true)
    expect(all.some((t) => Math.abs(t.twist) > 0.3)).toBe(true)
    expect(all.some((t) => t.spin > 0)).toBe(true)
  })

  it('never selects a retired mode, at any mood or tension', () => {
    // The retirement itself, asserted where it is decided rather than only at
    // the gate in PerformanceStateBridge. Both layers matter: this one keeps
    // the director honest, the gate catches a persisted store value that never
    // came through the director at all.
    for (const mood of MOODS) {
      for (let seed = 0; seed < 40; seed++) {
        for (const t of [0, 0.3, 0.6, 0.9, 1]) {
          const m = mirrorForSection(mood, t, seed)
          expect(m.mode, `${mood} t=${t} seed=${seed}`).not.toBe('wallpaper')
          expect(m.mode, `${mood} t=${t} seed=${seed}`).not.toBe('shear')
          expect(m.tiles, `${mood} t=${t} seed=${seed}`).toBe(0)
          expect(m.slice, `${mood} t=${t} seed=${seed}`).toBe(0)
        }
      }
    }
  })

  it('never combines two mirror looks in one section', () => {
    // Four different effects sharing a pass. Each reads clearly alone and they
    // turn to mush stacked, so a section commits to one.
    for (const mood of MOODS) {
      for (let seed = 0; seed < 30; seed++) {
        const t = mirrorForSection(mood, 0.9, seed)
        const live = [t.segments >= 1, t.tiles >= 2, Math.abs(t.twist) > 0.001, t.slice > 0.001]
        expect(live.filter(Boolean).length, `${mood} ${seed}`).toBeLessThanOrEqual(1)
      }
    }
  })

  it('only ever picks segment counts that read as a pattern', () => {
    for (let seed = 0; seed < 40; seed++) {
      const v = mirrorForSection('peak', 0.9, seed).segments
      if (v !== 0) expect([4, 6, 8], `seed ${seed}`).toContain(v)
    }
  })

  it.skip('keeps the wallpaper coarse enough for the scene to survive inside it', () => {
    // Skipped rather than deleted: `wallpaper` is retired (F108), not removed —
    // the switch case and the shader are both still there — so this is the
    // assertion that comes back with it. Left running it would pass vacuously,
    // which is the worse of the two failure modes.
    for (const mood of MOODS) {
      for (let seed = 0; seed < 30; seed++) {
        const t = mirrorForSection(mood, 0.9, seed)
        if (t.tiles > 0) expect([2, 3], `${mood} ${seed}`).toContain(t.tiles)
      }
    }
  })

  it('winds the vortex both ways across a set', () => {
    const tw = Array.from({ length: 30 }, (_, i) => mirrorForSection('peak', 0.9, i).twist)
    expect(tw.some((v) => v > 0.3)).toBe(true)
    expect(tw.some((v) => v < -0.3)).toBe(true)
  })

  it('is deterministic in the seed, so a set reproduces', () => {
    for (let seed = 0; seed < 20; seed++) {
      expect(mirrorForSection('peak', 0.9, seed)).toEqual(mirrorForSection('peak', 0.9, seed))
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
      // 0.15, not the 0.2 this started at: F109 turned the rack down and the
      // floor came with it, but only as far as the readability threshold the
      // comment above names. That threshold is the bar — a lens quieter than
      // this is one nobody can see attached to a cost everybody pays.
      expect(lensAmountTarget(mood, 0, true), mood).toBeGreaterThanOrEqual(0.15)
    }
  })

  it('lets a peak go further than a groove at the same tension', () => {
    expect(lensAmountTarget('peak', 1, true)).toBeGreaterThan(lensAmountTarget('groove', 1, true))
  })

  it('clamps a tension outside 0..1 instead of running away', () => {
    expect(lensAmountTarget('peak', 4, true)).toBeLessThanOrEqual(0.38)
    expect(lensAmountTarget('peak', -2, true)).toBe(0.2)
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
