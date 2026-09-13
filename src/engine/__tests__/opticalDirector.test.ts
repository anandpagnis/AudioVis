import { describe, expect, it } from 'vitest'
import {
  echoTarget,
  lensAmountTarget,
  lensForSection,
  mirrorForSection,
  MIRROR_TENSION_FLOOR_WEIGHT,
  shouldRepickMirror,
  trailsTarget,
  visualTensionFloor,
} from '../opticalDirector'
import { LENS_STYLES } from '../opticalRack'
import type { MoodState } from '../../audio/types'
import type { Habituation } from '../habituation'

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

/**
 * Echo is the opposite emphasis from trails: a rhythmic/percussive device
 * that wants a transient to repeat, not sustained material to persist. See
 * echoTarget's own doc for the fuller argument and for why this is a simple
 * continuous target for v1 rather than the section-scoped choice mirror/lens
 * use below.
 */
/**
 * F232 rewrite: `echoTarget`'s second argument is now the current beat-pulse
 * STRENGTH (`beatPulse()`'s own output, already 0..1 and already
 * sharply-shaped), not a slow-moving tension reading — see the function's own
 * doc in opticalDirector.ts for the full diagnosis of why v1's
 * continuous/tension-driven shape read as "always on" rather than as a
 * repeat. Every case below uses `pulse` in its name/comments accordingly.
 */
describe('echo', () => {
  it('is exactly zero through silence, whatever the pulse', () => {
    for (const pulse of [0, 0.3, 0.7, 1, NaN, -1, 4]) {
      expect(echoTarget('silence', pulse)).toBe(0)
    }
  })

  it('is exactly zero through ambient too, whatever the pulse', () => {
    // Unlike v1's tension-scaled shape, ambient's gate is a hard 0 now — see
    // ECHO_MOOD_GATE's own doc: a slapback with nothing urgent to repeat
    // reads as a stutter, not an effect, at any pulse strength.
    for (const pulse of [0, 0.3, 0.7, 1]) {
      expect(echoTarget('ambient', pulse)).toBe(0)
    }
  })

  it('is higher for peak/aggressive than for ambient at the same pulse', () => {
    for (const pulse of [0.3, 0.7, 1]) {
      const ambient = echoTarget('ambient', pulse)
      expect(echoTarget('peak', pulse)).toBeGreaterThan(ambient)
      expect(echoTarget('aggressive', pulse)).toBeGreaterThan(ambient)
    }
  })

  it('rises with the pulse at a fixed mood', () => {
    expect(echoTarget('groove', 1)).toBeGreaterThan(echoTarget('groove', 0.2))
    expect(echoTarget('groove', 0.2)).toBeGreaterThan(echoTarget('groove', 0))
  })

  it('scales linearly with the pulse — a mood gate, not a curve', () => {
    // The whole shape is `pulse * gate`; halving the pulse must exactly halve
    // the output at any fixed mood, which is what makes the beat's own decay
    // curve reach the screen unmodified rather than being reshaped twice.
    const full = echoTarget('peak', 1)
    const half = echoTarget('peak', 0.5)
    expect(half).toBeCloseTo(full / 2, 10)
  })

  it('stays in [0, 1] for any mood/pulse, including nonsense pulse input', () => {
    for (const mood of MOODS) {
      for (const pulse of [-1, 0, 0.5, 1, 4, NaN, Infinity, -Infinity]) {
        const v = echoTarget(mood, pulse)
        expect(v, `${mood} ${pulse}`).toBeGreaterThanOrEqual(0)
        expect(v, `${mood} ${pulse}`).toBeLessThanOrEqual(1)
      }
    }
  })

  it('is a pure function of its input', () => {
    expect(echoTarget('building', 0.42)).toBe(echoTarget('building', 0.42))
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

  it('engages a groove at a real tension, which is the point of the second pass', () => {
    // It used to need tension above 0.25 on a groove and fire on one eligible
    // section in three, which across a whole set meant it essentially never
    // appeared. Silence and ambient are the only restraint kept.
    //
    // The bar (0.2, raised from 0.08 by F229) is deliberately above what
    // `visualTensionFloor`'s resting-mood term can clear alone (ceiling
    // 0.25) — see that test group below — so 0.1 no longer qualifies on its
    // own. 0.25 is a real, if modest, contribution beyond just "the mood is
    // warm".
    expect(on(mirrorForSection('groove', 0.25, 0))).toBe(true)
    expect(on(mirrorForSection('groove', 0.6, 0))).toBe(true)
  })

  it('no longer engages on resting warmth alone (F229)', () => {
    // Before: 0.08 was low enough that `visualTensionFloor(level)` alone
    // (ceiling 0.25) cleared it whenever a groove/building passage was even
    // moderately energised — nothing to do with an actual build. That made
    // "warm" effectively always-eligible, which is the root of "mirrors
    // trigger a bit too much". 0.1 is comfortably below the new 0.2 bar.
    expect(on(mirrorForSection('groove', 0.1, 0))).toBe(false)
    expect(on(mirrorForSection('building', 0.1, 0))).toBe(false)
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
    // `ambient` gained `fly eye` (6) in F229 — see the pool-rebalance note
    // above `lensForSection`'s pool table — so "soft" is no longer just the
    // two glass materials.
    const soft = Array.from({ length: 30 }, (_, i) => lensForSection('ambient', i)).filter((i) => i >= 0)
    expect(soft.every((i) => i === 0 || i === 1 || i === 6)).toBe(true)
    // `aggressive` draws glitch (4), melt (3) and, since F230, pixel sort
    // (7); it used to include the LED wall (5), which is excluded from
    // every pool — see below.
    const hard = Array.from({ length: 30 }, (_, i) => lensForSection('aggressive', i)).filter((i) => i >= 0)
    expect(hard.every((i) => i === 3 || i === 4 || i === 7)).toBe(true)
  })

  it('actually rotates within a pool instead of collapsing to one entry (F229)', () => {
    // Regression guard for the correlation bug found while widening `ambient`
    // to a 3-item pool: the omitted-habituation engage check (`seed % 3 ===
    // 0`) shares its modulus with a 3-item pool's index, so indexing straight
    // off `seed` always landed on `choices[0]` — every engaged `mellow`
    // section, silently, forever. A real fix has to show variety, not just
    // "returns a valid index" (the existing range test would pass either
    // way).
    const picks = Array.from({ length: 60 }, (_, i) => lensForSection('mellow', i)).filter((i) => i >= 0)
    expect(new Set(picks).size).toBeGreaterThan(1)
  })

  it('excludes the currently-held material when an alternative exists (F229 anti-repeat)', () => {
    // `ambient`'s pool is [0, 1, 6]. Excluding whichever one is already
    // showing must never produce that same index again.
    for (let seed = 0; seed < 60; seed++) {
      for (const avoid of [0, 1, 6]) {
        const picked = lensForSection('ambient', seed, undefined, avoid)
        if (picked >= 0) expect(picked, `seed ${seed} avoid ${avoid}`).not.toBe(avoid)
      }
    }
  })

  it('falls back to the full pool when excluding the current pick would leave nothing', () => {
    // `groove`'s pool is [2, 6]. If the held style is neither, exclusion
    // removes nothing and the normal pick stands — this is really just
    // confirming avoidStyle values outside the pool are inert, not a special
    // case.
    const withoutAvoid = Array.from({ length: 20 }, (_, i) => lensForSection('groove', i))
    const withIrrelevantAvoid = Array.from({ length: 20 }, (_, i) => lensForSection('groove', i, undefined, 99))
    expect(withIrrelevantAvoid).toEqual(withoutAvoid)
  })

  it('is unaffected by avoidStyle when omitted — every existing call site unchanged', () => {
    for (let seed = 0; seed < 30; seed++) {
      expect(lensForSection('groove', seed)).toBe(lensForSection('groove', seed, undefined, undefined))
    }
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

describe('the mirror rack — habituation (audit c1)', () => {
  const FRESH: Habituation = { exposure: 0 }
  const SATURATED: Habituation = { exposure: 1 }
  const on = (t: ReturnType<typeof mirrorForSection>) => t.mode !== 'off'

  it('is unaffected when habituation is omitted — original modulo, unchanged', () => {
    for (let seed = 0; seed < 30; seed++) {
      expect(mirrorForSection('peak', 0.9, seed)).toEqual(
        mirrorForSection('peak', 0.9, seed, undefined),
      )
    }
  })

  it('reproduces the current base rate when habituation is omitted', () => {
    // The literal rule as of F229: off exactly at seed % 3 === 2 (2/3
    // engaged). Was seed % 6 === 5 (5/6) before F229 lowered the base rate —
    // the 5/6 figure combined with the wide-open eligibility gate above to
    // make the rack read as constant rather than as a choice.
    for (let seed = 0; seed < 30; seed++) {
      const engaged = on(mirrorForSection('peak', 0.9, seed))
      expect(engaged, `seed ${seed}`).toBe(seed % 3 !== 2)
    }
  })

  it('engages less often at high habituation than at zero, over many seeds', () => {
    const N = 3000
    let freshOn = 0
    let saturatedOn = 0
    for (let seed = 0; seed < N; seed++) {
      if (on(mirrorForSection('peak', 0.9, seed, FRESH))) freshOn++
      if (on(mirrorForSection('peak', 0.9, seed, SATURATED))) saturatedOn++
    }
    expect(saturatedOn).toBeLessThan(freshOn)
  })

  it('still returns a fully-formed, coherent target when it does engage', () => {
    // Habituation only gates WHETHER it engages, never corrupts the shape of
    // what comes back when it does.
    for (let seed = 0; seed < 40; seed++) {
      const t = mirrorForSection('peak', 0.9, seed, FRESH)
      if (t.mode !== 'off') {
        expect(['kaleido', 'vortex']).toContain(t.mode)
      }
    }
  })

  it('the eligibility gates (mood/tension) still apply before habituation is even consulted', () => {
    // ambient/silence must stay off regardless of how fresh the habituation
    // state is — habituation dampens an eligible gate, it does not make an
    // ineligible one eligible.
    for (let seed = 0; seed < 20; seed++) {
      expect(on(mirrorForSection('silence', 0, seed, FRESH))).toBe(false)
      expect(on(mirrorForSection('ambient', 0.1, seed, FRESH))).toBe(false)
    }
  })

  it('can actually go quiet at full habituation now (F229 — tighter dampening/floor)', () => {
    // Before F229, the mirror's habituatedGate call used the general-purpose
    // defaults (dampening 0.7, floor 0.1), which floor-clamped a 5/6 base
    // rate at max(0.1, 5/6*0.3) = 0.25 — still "1 in 4" at FULL habituation,
    // never a real rest. Tightened to 0.85/0.05 specifically for this call,
    // on a base rate now itself lowered to 2/3: max(0.05, 2/3*0.15) ≈ 0.1.
    // Measuring the empirical rate over many seeds, not asserting the exact
    // constant, so this survives a future retune of the base rate itself.
    const N = 4000
    let saturatedOn = 0
    for (let seed = 0; seed < N; seed++) {
      if (on(mirrorForSection('peak', 0.9, seed, SATURATED))) saturatedOn++
    }
    expect(saturatedOn / N).toBeLessThan(0.2)
  })
})

describe('the lens rack — habituation (audit c1)', () => {
  const FRESH: Habituation = { exposure: 0 }
  const SATURATED: Habituation = { exposure: 1 }

  it('is unaffected when habituation is omitted — original modulo, unchanged', () => {
    for (let seed = 0; seed < 30; seed++) {
      expect(lensForSection('groove', seed)).toBe(lensForSection('groove', seed, undefined))
    }
  })

  it('reproduces the exact original engagement pattern when omitted', () => {
    for (let seed = 0; seed < 30; seed++) {
      const engaged = lensForSection('groove', seed) >= 0
      expect(engaged, `seed ${seed}`).toBe(seed % 3 === 0)
    }
  })

  it('engages less often at high habituation than at zero, over many seeds', () => {
    const N = 3000
    let freshOn = 0
    let saturatedOn = 0
    for (let seed = 0; seed < N; seed++) {
      if (lensForSection('groove', seed, FRESH) >= 0) freshOn++
      if (lensForSection('groove', seed, SATURATED) >= 0) saturatedOn++
    }
    expect(saturatedOn).toBeLessThan(freshOn)
  })

  it('a mood with no pool stays off regardless of habituation', () => {
    for (let seed = 0; seed < 20; seed++) {
      expect(lensForSection('silence', seed, FRESH)).toBe(-1)
    }
  })
})

/**
 * The mirror/lens gates read `p.visualTension`, and the build/predict/
 * structure terms feeding it are all GATED — a session that never reaches
 * `building` mood sat at visualTension ~0 for its whole runtime, and the
 * mirror's mood gate (mellow > 0.3, warm > 0.08, everything else > 0.4)
 * essentially never opened outside `hot` moods. This floor is the fix; these
 * tests are about its SHAPE, not just its existence — it has to help without
 * trivializing.
 */
describe('visualTensionFloor', () => {
  it('is zero at zero level', () => {
    expect(visualTensionFloor(0)).toBe(0)
  })

  it('rises with level', () => {
    expect(visualTensionFloor(1)).toBeGreaterThan(visualTensionFloor(0.5))
    expect(visualTensionFloor(0.5)).toBeGreaterThan(visualTensionFloor(0))
  })

  it('clears the warm gate (0.08) on its own once level is meaningfully up', () => {
    // groove/building at a real, if unremarkable, intensity — not a quiet passage.
    expect(visualTensionFloor(0.5)).toBeGreaterThan(0.08)
  })

  it('never clears the mellow gate (0.3) on its own, even at maximum level', () => {
    // The whole point: this term widens `warm`'s low bar without making
    // `mellow` or the catch-all "everything else" gate (0.4) trivially true —
    // those still need a real build/prediction/structure signal alongside it.
    expect(visualTensionFloor(1)).toBeLessThan(0.3)
  })

  it('stays in range for any input, including nonsense', () => {
    for (const level of [-1, 0, 0.5, 1, 4, NaN, Infinity, -Infinity]) {
      const v = visualTensionFloor(level)
      expect(v, `level ${level}`).toBeGreaterThanOrEqual(0)
      expect(v, `level ${level}`).toBeLessThanOrEqual(MIRROR_TENSION_FLOOR_WEIGHT)
    }
  })
})

/**
 * The min-hold guard on the mirror's phrase-edge re-decision (F134 already
 * gated the re-decision itself on sectionChange/moodMoved/tensionMoved/stale;
 * this is a narrower gate on `tensionMoved` alone). User complaint this
 * exists to fix: the mirror "doesn't hold — it disappears fast", traced to a
 * drop's brief `+0.5` visualTension spike (0.6s) decaying well before the
 * NEXT phrase edge, so `tensionMoved` fires again there and tears the
 * engagement the drop just caused right back down one phrase later.
 */
describe('shouldRepickMirror', () => {
  const base = {
    sectionChange: false,
    nothingToInterrupt: false,
    moodMoved: false,
    tensionMoved: false,
    stale: false,
    currentlyEngaged: true,
    phrasesHeld: 2,
    minHoldPhrases: 1,
  }

  it('sectionChange always repicks, even mid-hold', () => {
    expect(shouldRepickMirror({ ...base, sectionChange: true, phrasesHeld: 1 })).toBe(true)
  })

  it('stale always repicks, even mid-hold', () => {
    expect(shouldRepickMirror({ ...base, stale: true, phrasesHeld: 1 })).toBe(true)
  })

  it('moodMoved always repicks, even mid-hold', () => {
    expect(shouldRepickMirror({ ...base, moodMoved: true, phrasesHeld: 1 })).toBe(true)
  })

  it('nothingToInterrupt (off -> on) always repicks', () => {
    expect(
      shouldRepickMirror({ ...base, nothingToInterrupt: true, currentlyEngaged: false, phrasesHeld: 0 }),
    ).toBe(true)
  })

  it('the exact drop-tearing-down case: tensionMoved alone, one phrase after engaging, is held', () => {
    // phrasesHeld is post-increment: 1 means "this is the first phrase edge
    // since the pick that just engaged" — exactly the edge a drop's spike
    // decays before.
    expect(shouldRepickMirror({ ...base, tensionMoved: true, phrasesHeld: 1 })).toBe(false)
  })

  it('tensionMoved alone repicks once the minimum hold has actually passed', () => {
    expect(shouldRepickMirror({ ...base, tensionMoved: true, phrasesHeld: 2 })).toBe(true)
  })

  it('does not hold back tensionMoved when nothing is currently engaged', () => {
    // No live look to protect — this mirrors nothingToInterrupt's own carve-out.
    expect(
      shouldRepickMirror({
        ...base,
        tensionMoved: true,
        currentlyEngaged: false,
        phrasesHeld: 1,
      }),
    ).toBe(true)
  })

  it('with nothing moved and not stale, holds', () => {
    expect(shouldRepickMirror({ ...base, phrasesHeld: 1 })).toBe(false)
  })

  describe('the off-cooldown rest period (F229)', () => {
    it('is unaffected when omitted — nothingToInterrupt commits unconditionally, as before', () => {
      expect(
        shouldRepickMirror({ ...base, nothingToInterrupt: true, currentlyEngaged: false, phrasesHeld: 0 }),
      ).toBe(true)
    })

    it('blocks nothingToInterrupt alone until the rest period clears', () => {
      expect(
        shouldRepickMirror({
          ...base,
          nothingToInterrupt: true,
          currentlyEngaged: false,
          phrasesHeld: 0,
          offPhrasesHeld: 1,
          minOffPhrases: 2,
        }),
      ).toBe(false)
    })

    it('allows nothingToInterrupt again once the rest period has cleared', () => {
      expect(
        shouldRepickMirror({
          ...base,
          nothingToInterrupt: true,
          currentlyEngaged: false,
          phrasesHeld: 0,
          offPhrasesHeld: 2,
          minOffPhrases: 2,
        }),
      ).toBe(true)
    })

    it('never holds back sectionChange or moodMoved, even mid-rest', () => {
      // The rest period is specifically about the autopilot reflex
      // (nothingToInterrupt); a genuine "the music changed" signal still
      // bypasses it entirely, same as it always has.
      expect(
        shouldRepickMirror({
          ...base,
          sectionChange: true,
          nothingToInterrupt: true,
          currentlyEngaged: false,
          phrasesHeld: 0,
          offPhrasesHeld: 0,
          minOffPhrases: 2,
        }),
      ).toBe(true)
      expect(
        shouldRepickMirror({
          ...base,
          moodMoved: true,
          nothingToInterrupt: true,
          currentlyEngaged: false,
          phrasesHeld: 0,
          offPhrasesHeld: 0,
          minOffPhrases: 2,
        }),
      ).toBe(true)
    })
  })
})
