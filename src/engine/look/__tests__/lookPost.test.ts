import { describe, expect, it } from 'vitest'
import { createEmptyCharacterState } from '../../../audio/characterTypes'
import BRIDGE_SRC from '../../PerformanceStateBridge.tsx?raw'
import POST_SRC from '../lookPost.ts?raw'
import { resolveFeedbackKnobs } from '../../feedbackParams'
import { createHabituation, stepHabituation, type Habituation } from '../../habituation'
import { echoTarget, lensAmountTarget, MIRROR_OFF, trailsTarget } from '../../opticalDirector'
import { approach } from '../../performanceState'
import { findAllocations, hotPath } from './hotPath'
import {
  bloomFromProfile,
  createLookInput,
  createLookRuntime,
  echoFromProfile,
  fillLookInput,
  fogFromProfile,
  glitchFromProfile,
  LENS_ENGAGE_MAX,
  LENS_SWAP_BELOW,
  lensAmountFromProfile,
  lensFromProfile,
  MIRROR_ENGAGE_MAX,
  MIRROR_SPIN_CAP,
  mirrorFromProfile,
  mirrorMixFromProfile,
  PIXELS_AMOUNT_FLOOR,
  postLookActive,
  sampleWeighted,
  scaleMirrorSpin,
  stepLensSwap,
  stepTrailsShape,
  trailsFromProfile,
  unit01,
  vignetteFromProfile,
  type LensSwapState,
  type LookInputFeatures,
  type TrailsShape,
} from '../lookPost'
import { createLookProfile, createNeutralRow, LENS, LENS_STYLE_COUNT, type LookProfile } from '../lookRow'
import { MOOD_ROWS } from '../moodRows'

// ---------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------

const sweep = (n: number) => Array.from({ length: n + 1 }, (_, i) => i / n)
const FRESH: Habituation = createHabituation()

/** Comments out of a source string (line and block), so a pin on code is not fooled by prose that names it. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function features(over: Partial<LookInputFeatures> = {}): LookInputFeatures {
  return {
    character: createEmptyCharacterState(),
    timbre: { harsh: 0.5, busy: 0.5, sparse: 0.5 },
    structureValid: false,
    songSection: { isBuild: false, buildProgress: 0, isDrop: false, isBreakdown: false, beatsTillDrop: -1 },
    mood: { isBuilding: false },
    drop: false,
    delta: 1 / 60,
    ...over,
  }
}

/** A tracker run to steady state on a forced mood: the real blended profile the directors would read. */
function settledProfile(mood: string, seconds = 20): LookProfile {
  const rt = createLookRuntime(`?lookforce=${mood}`)
  const out = createLookProfile()
  const f = features()
  for (let i = 0; i < seconds * 60; i++) rt.tracker.update(fillLookInput(rt.input, f, 'groove'), out)
  return out
}

/** Legacy resting values the profile path replaces (each is the number its old table held). */
const LEGACY_ECHO_GATE = { mellow: 0.15, groove: 0.55, building: 0.75, peak: 1, aggressive: 0.9 } as const
const LEGACY_TRAILS_BASE = { ambient: 1, groove: 0.9, building: 0.97, peak: 0.78, aggressive: 0.68 } as const

// ---------------------------------------------------------------------------------------------------------
// Legacy equivalence: at the old table's value the profile formula IS the old formula
// ---------------------------------------------------------------------------------------------------------

describe('legacy equivalence spot checks', () => {
  const neutral = createNeutralRow()

  it('bloom: the neutral row is the groove row of the old table (0.49, react 1), bit for bit', () => {
    expect(neutral.bloomBase).toBe(0.49)
    for (const reactive of sweep(8).map((x) => x * 2.3)) {
      for (const voice of [0, 0.1, 0.45]) {
        for (const intensity of [0.6, 1, 1.4]) {
          expect(bloomFromProfile(neutral, reactive, voice, intensity)).toBe((0.49 + reactive + voice) * intensity)
        }
      }
    }
  })

  it('vignette: the neutral row is the old VIGNETTE_BASE (0.85), bit for bit, drop dip included', () => {
    expect(neutral.vignette).toBe(0.85)
    for (const t of sweep(10)) {
      for (const drop of [false, true]) {
        expect(vignetteFromProfile(neutral, t, drop)).toBe(Math.min(1, 0.85 + t * 0.16 - (drop ? 0.2 : 0)))
      }
    }
  })

  it('chromatic aberration: at the old 0.0006 base and react 1 it is the old sum', () => {
    const row = { caBase: 0.0006, caReact: 1 }
    for (const pulse of [0, 0.4, 1]) {
      for (const t of [0, 0.5, 1]) {
        for (const drop of [false, true]) {
          for (const aggressive of [0, 0.7]) {
            const old = 0.0006 + pulse * 0.0035 + t * 0.002 + (drop ? 0.004 : 0) + aggressive * 0.0015
            expect(glitchFromProfile(row, pulse, t, drop, aggressive)).toBeCloseTo(old, 12)
          }
        }
      }
    }
  })

  it('fog: fogBase 0 is the old non-ambient formula, 0.25 the old ambient one', () => {
    for (const sparse of sweep(10)) {
      for (const relaxed of [0, 0.12, 0.2]) {
        expect(fogFromProfile({ fogBase: 0 }, sparse, relaxed)).toBe(Math.min(1, sparse * 0.6 + relaxed))
        expect(fogFromProfile({ fogBase: 0.25 }, sparse, relaxed)).toBe(Math.min(1, sparse * 0.6 + 0.25 + relaxed))
      }
    }
  })

  it('trails: with each old table value as the base it is trailsTarget, bit for bit', () => {
    for (const [mood, base] of Object.entries(LEGACY_TRAILS_BASE)) {
      for (const flux of [0, 0.05, 0.3, 0.9, 2]) {
        for (const energy of [0, 0.2, 0.9, 1]) {
          expect(trailsFromProfile({ trailsBase: base }, flux, energy), `${mood} f${flux} e${energy}`).toBe(
            trailsTarget(mood as never, flux, energy),
          )
        }
      }
    }
  })

  it('echo: with each old gate as echoGate it is echoTarget, bit for bit', () => {
    expect(neutral.echoGate).toBe(LEGACY_ECHO_GATE.groove)
    for (const [mood, gate] of Object.entries(LEGACY_ECHO_GATE)) {
      for (const pulse of [0, 0.3, 0.7, 1, NaN, -1, 4]) {
        expect(echoFromProfile({ echoGate: gate }, pulse), `${mood} ${pulse}`).toBe(echoTarget(mood as never, pulse))
      }
    }
  })

  it('lens amount: the old soft (0.15..0.24) and hard (0.2..0.38) ranges give lensAmountTarget, pixels floor included', () => {
    for (const t of sweep(10)) {
      for (const style of [undefined, LENS.ribs, LENS.pixels, LENS.pixelSort]) {
        expect(lensAmountFromProfile({ lensAmountFloor: 0.15, lensAmountCeil: 0.24 }, t, true, style)).toBe(
          lensAmountTarget('groove', t, true, style),
        )
        expect(lensAmountFromProfile({ lensAmountFloor: 0.2, lensAmountCeil: 0.38 }, t, true, style)).toBe(
          lensAmountTarget('peak', t, true, style),
        )
      }
    }
    expect(lensAmountFromProfile(neutral, 0.5, false)).toBe(0)
    expect(lensAmountFromProfile(neutral, 0, true, LENS.pixels)).toBe(PIXELS_AMOUNT_FLOOR)
  })
})

// ---------------------------------------------------------------------------------------------------------
// Continuous targets
// ---------------------------------------------------------------------------------------------------------

describe('post targets from a profile', () => {
  it('bloomReact scales only the reactive sum; the resting level and the vocal lift are untouched', () => {
    const at = (bloomReact: number) => bloomFromProfile({ bloomBase: 0.5, bloomReact }, 1, 0.2, 1)
    expect(at(0.5)).toBeCloseTo(0.5 + 0.5 + 0.2, 12)
    expect(at(1.4)).toBeCloseTo(0.5 + 1.4 + 0.2, 12)
    expect(bloomFromProfile({ bloomBase: 0.5, bloomReact: 1.4 }, 0, 0, 1)).toBe(0.5)
    expect(bloomFromProfile({ bloomBase: 0.5, bloomReact: 1 }, 1, 0, 0)).toBe(0)
  })

  it('caReact scales only the reactive terms: with no pulse / tension / drop the aberration is its base', () => {
    for (const caReact of [0, 0.5, 2]) {
      expect(glitchFromProfile({ caBase: 0.003, caReact }, 0, 0, false, 0)).toBe(0.003)
    }
    const lo = glitchFromProfile({ caBase: 0.001, caReact: 0.5 }, 1, 1, true, 1)
    const hi = glitchFromProfile({ caBase: 0.001, caReact: 2 }, 1, 1, true, 1)
    expect(hi).toBeGreaterThan(lo)
  })

  it('vignette holds its ceiling and floor', () => {
    expect(vignetteFromProfile({ vignette: 0.98 }, 1, false)).toBe(1)
    expect(vignetteFromProfile({ vignette: 0.7 }, 0, true)).toBeCloseTo(0.5, 12)
    expect(vignetteFromProfile({ vignette: 0.1 }, 0, true)).toBe(0)
  })

  it('fog is capped at 1 and never negative', () => {
    expect(fogFromProfile({ fogBase: 0.5 }, 1, 0.2)).toBe(1)
    expect(fogFromProfile({ fogBase: 0 }, 0, 0)).toBe(0)
  })

  it('trails back off as the mix gets busy, and stay in 0..1', () => {
    for (const base of [0, 0.3, 1]) {
      expect(trailsFromProfile({ trailsBase: base }, 0.9, 0.3)).toBeLessThanOrEqual(trailsFromProfile({ trailsBase: base }, 0, 0.3))
    }
    expect(trailsFromProfile({ trailsBase: 1.5 }, 0, 0)).toBe(1)
    expect(trailsFromProfile({ trailsBase: 1 }, 0.9, 0)).toBeCloseTo(0.68, 12) // a busy mix keeps most of its trails, like the old curve
  })

  it('echo is the gate times the beat pulse, not eased, and 0 for a closed gate', () => {
    expect(echoFromProfile({ echoGate: 0.6 }, 0.5)).toBeCloseTo(0.3, 12)
    expect(echoFromProfile({ echoGate: 0 }, 1)).toBe(0)
    expect(echoFromProfile({ echoGate: 1 }, 1)).toBe(1)
    expect(echoFromProfile({ echoGate: 5 }, 1)).toBe(1) // a gate above 1 (should not happen) cannot exceed the pulse
  })

  it('every target is finite and in range for nonsense input, and never NaN', () => {
    const row = createNeutralRow()
    const weird = [NaN, Infinity, -Infinity, -3, 0, 7]
    for (const x of weird) {
      for (const y of weird) {
        expect(Number.isNaN(glitchFromProfile(row, x, y, false, 0))).toBe(false)
        expect(Number.isNaN(bloomFromProfile(row, x, y, 1))).toBe(false)
        const t = trailsFromProfile(row, x, y)
        expect(t >= 0 && t <= 1, `trails(${x}, ${y})`).toBe(true)
        const v = vignetteFromProfile(row, x, false)
        expect(v >= 0 && v <= 1).toBe(true)
        const e = echoFromProfile(row, x)
        expect(e >= 0 && e <= 1).toBe(true)
      }
    }
    expect(mirrorMixFromProfile({ mirrorMix: NaN })).toBe(0)
    expect(mirrorMixFromProfile({ mirrorMix: 3 })).toBe(1)
  })

  it('the real rows keep the moods legibly apart through the wiring (calm and long vs harsh and crisp)', () => {
    const serene = settledProfile('serene')
    const aggressive = settledProfile('aggressive')
    const euphoric = settledProfile('euphoric')
    const melancholic = settledProfile('melancholic')
    // Same audio for both, so the difference is the profile alone.
    const bloom = (p: LookProfile) => bloomFromProfile(p, 0.6, 0, 1)
    const ca = (p: LookProfile) => glitchFromProfile(p, 0.6, 0.4, false, 0)
    const trails = (p: LookProfile) => trailsFromProfile(p, 0.3, 0.5)
    expect(bloom(euphoric)).toBeGreaterThan(bloom(melancholic))
    expect(ca(aggressive)).toBeGreaterThan(ca(serene) * 3)
    expect(trails(serene)).toBeGreaterThan(trails(aggressive) * 2)
    expect(fogFromProfile(serene, 0.2, 0)).toBeGreaterThan(fogFromProfile(aggressive, 0.2, 0))
    expect(vignetteFromProfile(melancholic, 0.2, false)).toBeGreaterThan(vignetteFromProfile(euphoric, 0.2, false))
  })
})

// ---------------------------------------------------------------------------------------------------------
// Gating and the tracker feed
// ---------------------------------------------------------------------------------------------------------

describe('postLookActive', () => {
  const look = (valid: boolean, post: boolean, source: 'legacy' | 'character' | 'forced' = 'character') => ({
    valid,
    source,
    families: { grade: true, post, scene: true, camera: true },
  })

  it('needs a valid profile with the post family on', () => {
    expect(postLookActive(look(true, true), 'groove')).toBe(true)
    expect(postLookActive(look(false, true), 'groove')).toBe(false)
    expect(postLookActive(look(true, false), 'groove')).toBe(false)
  })

  it('stays on the legacy path in silence, whatever the character read holds', () => {
    expect(postLookActive(look(true, true), 'silence')).toBe(false)
    for (const m of ['ambient', 'mellow', 'groove', 'building', 'peak', 'aggressive'] as const) {
      expect(postLookActive(look(true, true), m)).toBe(true)
    }
  })

  it('a pinned row (?lookforce) stays on through silence (pausing the player must not drop the look being tuned), but still honours -post', () => {
    expect(postLookActive(look(true, true, 'forced'), 'silence')).toBe(true)
    expect(postLookActive(look(true, false, 'forced'), 'silence')).toBe(false)
    expect(postLookActive(look(true, false, 'forced'), 'groove')).toBe(false)
  })
})

describe('fillLookInput / createLookRuntime', () => {
  it('overwrites one reusable input in place (same object, same song object)', () => {
    const input = createLookInput(null, { grade: true, post: true, scene: true, camera: true })
    const song = input.song
    const f = features({
      structureValid: true,
      songSection: { isBuild: true, buildProgress: 0.6, isDrop: false, isBreakdown: false, beatsTillDrop: 24 },
      drop: true,
      delta: 0.02,
    })
    const out = fillLookInput(input, f, 'peak')
    expect(out).toBe(input)
    expect(out.song).toBe(song)
    expect(out.character).toBe(f.character)
    expect(out.timbre).toBe(f.timbre)
    expect(out.legacyLook).toBe('peak')
    expect(out.song).toEqual({ structureValid: true, isBuild: true, buildProgress: 0.6, isDrop: false, isBreakdown: false, beatsTillDrop: 24 })
    expect(out.drop).toBe(true)
    expect(out.dt).toBe(0.02)
  })

  it('re-points timbre every frame (resetAnalysis replaces features.timbre, so it must never be cached)', () => {
    const input = createLookInput(null, { grade: true, post: true, scene: true, camera: true })
    const a = features({ timbre: { harsh: 0.1, busy: 0.2, sparse: 0.3 } })
    const b = features({ timbre: { harsh: 0.9, busy: 0.8, sparse: 0.7 } })
    fillLookInput(input, a, 'groove')
    expect(input.timbre).toBe(a.timbre)
    fillLookInput(input, b, 'groove')
    expect(input.timbre).toBe(b.timbre)
  })

  it('legacyBuilding is the mood engine\'s isBuilding OR the fast look being `building`', () => {
    const input = createLookInput(null, { grade: true, post: true, scene: true, camera: true })
    expect(fillLookInput(input, features(), 'groove').legacyBuilding).toBe(false)
    expect(fillLookInput(input, features({ mood: { isBuilding: true } }), 'groove').legacyBuilding).toBe(true)
    expect(fillLookInput(input, features(), 'building').legacyBuilding).toBe(true)
  })

  it('reads the URL flags once, from the string it is given', () => {
    const rt = createLookRuntime('?lookforce=tense&look=-post,-camera')
    expect(rt.force).toBe('tense')
    expect(rt.families).toEqual({ grade: true, post: false, scene: true, camera: false })
    expect(rt.input.force).toBe('tense')
    expect(rt.input.families).toBe(rt.families)
    const legacy = createLookRuntime('?scenepick=legacy')
    expect(legacy.families).toEqual({ grade: false, post: false, scene: false, camera: false })
    expect(createLookRuntime('').force).toBeNull()
  })

  it('drives the tracker to a valid, post-active profile; -post and silence keep the legacy path', () => {
    const forced = createLookRuntime('?lookforce=driving')
    const out = createLookProfile()
    forced.tracker.update(fillLookInput(forced.input, features(), 'peak'), out)
    expect(out.valid).toBe(true)
    expect(out.source).toBe('forced')
    expect(out.primary).toBe('driving')
    expect(postLookActive(out, 'peak')).toBe(true)
    expect(postLookActive(out, 'silence')).toBe(true) // pinned rows stay on through silence

    const off = createLookRuntime('?lookforce=driving&look=-post')
    const out2 = createLookProfile()
    off.tracker.update(fillLookInput(off.input, features(), 'peak'), out2)
    expect(out2.valid).toBe(true)
    expect(postLookActive(out2, 'peak')).toBe(false)

    const none = createLookRuntime('')
    const out3 = createLookProfile()
    none.tracker.update(fillLookInput(none.input, features(), 'peak'), out3) // character not valid, nothing forced
    expect(out3.valid).toBe(false)
    expect(postLookActive(out3, 'peak')).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------------------
// Deterministic sampling
// ---------------------------------------------------------------------------------------------------------

describe('unit01', () => {
  it('is deterministic and in [0, 1)', () => {
    for (let s = 0; s < 500; s++) {
      const a = unit01(s, 7)
      expect(a).toBe(unit01(s, 7))
      expect(a >= 0 && a < 1).toBe(true)
    }
  })

  it('is roughly uniform over consecutive seeds (decisions are numbered 0, 1, 2, ...)', () => {
    const N = 8000
    const bins = new Array<number>(10).fill(0)
    for (let s = 0; s < N; s++) bins[Math.floor(unit01(s, 0x1e4a) * 10)]++
    for (const b of bins) expect(Math.abs(b / N - 0.1)).toBeLessThan(0.02)
  })

  it('different salts give independent draws (no shared bit between the questions a decision asks)', () => {
    const N = 6000
    let agree = 0
    for (let s = 0; s < N; s++) if ((unit01(s, 1) < 0.5) === (unit01(s, 2) < 0.5)) agree++
    expect(Math.abs(agree / N - 0.5)).toBeLessThan(0.03)
  })

  it('is total: non-finite seeds hash like 0', () => {
    expect(unit01(NaN, 3)).toBe(unit01(0, 3))
    expect(unit01(Infinity, 3)).toBe(unit01(0, 3))
  })
})

describe('sampleWeighted', () => {
  it('converges to the normalised weights, and does not need them to sum to 1', () => {
    const w = [3, 1, 0, 6]
    const N = 20000
    const counts = [0, 0, 0, 0]
    for (let s = 0; s < N; s++) counts[sampleWeighted(w, unit01(s, 9))]++
    expect(counts[2]).toBe(0)
    expect(Math.abs(counts[0] / N - 0.3)).toBeLessThan(0.015)
    expect(Math.abs(counts[1] / N - 0.1)).toBeLessThan(0.015)
    expect(Math.abs(counts[3] / N - 0.6)).toBeLessThan(0.015)
  })

  it('skips excluded indices and renormalises over the rest', () => {
    const w = [1, 1, 1, 1]
    const N = 12000
    const counts = [0, 0, 0, 0]
    for (let s = 0; s < N; s++) counts[sampleWeighted(w, unit01(s, 4), 1, 3)]++
    expect(counts[1] + counts[3]).toBe(0)
    expect(Math.abs(counts[0] / N - 0.5)).toBeLessThan(0.02)
  })

  it('returns -1 when nothing has weight, ignores NaN / negative weights, and never returns a zero-weight index', () => {
    expect(sampleWeighted([0, 0, 0], 0.5)).toBe(-1)
    expect(sampleWeighted([], 0.5)).toBe(-1)
    expect(sampleWeighted([1, 2], 0.5, 0, 1)).toBe(-1)
    expect(sampleWeighted([NaN, -2, Infinity, 0, 1], 0.99)).toBe(4)
    for (const u of [0, 0.25, 0.5, 0.999999999, 1, 2, NaN]) {
      expect([1, 3]).toContain(sampleWeighted([0, 1, 0, 2, 0], u))
    }
  })
})

describe('lensFromProfile', () => {
  const look = (over: Partial<Pick<LookProfile, 'lensEngage' | 'lensWeights'>> = {}) => ({
    lensEngage: 0.5,
    lensWeights: [0.2, 0.3, 0, 0.1, 0, 0.25, 0, 0.15],
    ...over,
  })

  it('never engages a lens whose engage probability is 0 (the intensity gate in silence), however many seeds', () => {
    for (let s = 0; s < 3000; s++) expect(lensFromProfile(look({ lensEngage: 0 }), s, FRESH)).toBe(-1)
    for (let s = 0; s < 500; s++) expect(lensFromProfile(look({ lensEngage: NaN }), s, FRESH)).toBe(-1)
  })

  it('engages at about lensEngage when fresh, whatever the probability', () => {
    const N = 6000
    for (const p of [0.15, 0.3, 0.5, 0.65, LENS_ENGAGE_MAX]) {
      let n = 0
      for (let s = 0; s < N; s++) if (lensFromProfile(look({ lensEngage: p }), s, FRESH) >= 0) n++
      expect(Math.abs(n / N - p), `p=${p}`).toBeLessThan(0.03)
    }
  })

  it('a probability above the cap engages at the cap, not with certainty', () => {
    const N = 4000
    let n = 0
    for (let s = 0; s < N; s++) if (lensFromProfile(look({ lensEngage: 5 }), s, FRESH) >= 0) n++
    expect(Math.abs(n / N - LENS_ENGAGE_MAX)).toBeLessThan(0.03)
  })

  it('habituation dampens it: a lens that just fired engages less often, but a low base is never RAISED by the floor', () => {
    let hot = createHabituation()
    for (let i = 0; i < 10; i++) hot = stepHabituation(hot, true)
    const N = 6000
    let fresh = 0
    let tired = 0
    for (let s = 0; s < N; s++) {
      if (lensFromProfile(look({ lensEngage: 0.5 }), s, FRESH) >= 0) fresh++
      if (lensFromProfile(look({ lensEngage: 0.5 }), s, hot) >= 0) tired++
    }
    expect(tired).toBeLessThan(fresh * 0.6)
    let low = 0
    for (let s = 0; s < N; s++) if (lensFromProfile(look({ lensEngage: 0.04 }), s, hot) >= 0) low++
    expect(low / N).toBeLessThan(0.04) // the flat 10% floor of habituatedGate must not lift a 4% row
  })

  it('samples the material in proportion to the weights (fly eye, at index 6, is never chosen even when it carries weight)', () => {
    const weights = [0.2, 0.3, 0, 0.1, 0, 0.25, 0.9, 0.15]
    const N = 24000
    const counts = new Array<number>(LENS_STYLE_COUNT).fill(0)
    let engaged = 0
    for (let s = 0; s < N; s++) {
      const style = lensFromProfile(look({ lensEngage: 0.85, lensWeights: weights }), s, FRESH)
      if (style >= 0) {
        counts[style]++
        engaged++
      }
    }
    expect(engaged).toBeGreaterThan(N * 0.8)
    expect(counts[LENS.flyEye]).toBe(0)
    const total = 0.2 + 0.3 + 0.1 + 0.25 + 0.15
    weights.forEach((w, i) => {
      if (i === LENS.flyEye) return
      expect(Math.abs(counts[i] / engaged - w / total), `style ${i}`).toBeLessThan(0.02)
    })
  })

  it('never returns the held material, and never a style with no weight', () => {
    for (let held = 0; held < LENS_STYLE_COUNT; held++) {
      for (let s = 0; s < 800; s++) {
        const style = lensFromProfile(look({ lensEngage: 0.85 }), s, FRESH, held)
        if (style < 0) continue
        expect(style).not.toBe(held)
        expect([0, 1, 3, 5, 7]).toContain(style)
      }
    }
  })

  it('falls back to the held material only when it is the ONLY one with weight (the legacy pool does too)', () => {
    const only = look({ lensEngage: 0.85, lensWeights: [0, 0, 0, 0, 0, 1, 0, 0] })
    let seen = 0
    for (let s = 0; s < 400; s++) {
      const style = lensFromProfile(only, s, FRESH, LENS.pixels)
      if (style >= 0) {
        expect(style).toBe(LENS.pixels)
        seen++
      }
    }
    expect(seen).toBeGreaterThan(0)
    // Fly eye alone: nothing to pick, ever.
    for (let s = 0; s < 400; s++) expect(lensFromProfile(look({ lensEngage: 0.85, lensWeights: [0, 0, 0, 0, 0, 0, 1, 0] }), s, FRESH)).toBe(-1)
  })

  it('is deterministic: the same (profile, seed, habituation, held) always decides the same', () => {
    for (let s = 0; s < 300; s++) {
      expect(lensFromProfile(look(), s, FRESH, 3)).toBe(lensFromProfile(look(), s, FRESH, 3))
    }
  })

  it('the real rows pick the corruption family for harsh moods and glass for calm ones', () => {
    const hard = new Set<number>([LENS.pixelSort, LENS.glitch])
    const soft = new Set<number>([LENS.ribs, LENS.fan, LENS.anamorphic, LENS.melt])
    const tally = (row: (typeof MOOD_ROWS)['serene']) => {
      const counts = { hard: 0, soft: 0, other: 0 }
      for (let s = 0; s < 4000; s++) {
        const style = lensFromProfile({ lensEngage: 0.85, lensWeights: row.lensWeights }, s, FRESH)
        if (style < 0) continue
        if (hard.has(style)) counts.hard++
        else if (soft.has(style)) counts.soft++
        else counts.other++
      }
      return counts
    }
    const aggressive = tally(MOOD_ROWS.aggressive)
    expect(aggressive.hard).toBeGreaterThan(aggressive.soft * 4)
    const serene = tally(MOOD_ROWS.serene)
    expect(serene.hard + serene.other).toBe(0)
  })
})

describe('mirrorFromProfile', () => {
  const rowLook = (mood: keyof typeof MOOD_ROWS, over: Partial<LookProfile> = {}) => ({ ...MOOD_ROWS[mood], ...over })

  it('is MIRROR_OFF (the shared constant) when the engage probability is 0 or not a number', () => {
    for (let s = 0; s < 500; s++) {
      expect(mirrorFromProfile(rowLook('serene', { mirrorEngage: 0 }), 0.5, s, FRESH)).toBe(MIRROR_OFF)
      expect(mirrorFromProfile(rowLook('serene', { mirrorEngage: NaN }), 0.5, s, FRESH)).toBe(MIRROR_OFF)
    }
  })

  it('engages at about mirrorEngage when fresh (capped at 0.9, so never a sure thing)', () => {
    const N = 6000
    for (const p of [0.15, 0.35, 0.6, MIRROR_ENGAGE_MAX]) {
      let n = 0
      for (let s = 0; s < N; s++) if (mirrorFromProfile(rowLook('mysterious', { mirrorEngage: p }), 0.5, s, FRESH) !== MIRROR_OFF) n++
      expect(Math.abs(n / N - p), `p=${p}`).toBeLessThan(0.03)
    }
    let n = 0
    for (let s = 0; s < N; s++) if (mirrorFromProfile(rowLook('mysterious', { mirrorEngage: 3 }), 0.5, s, FRESH) !== MIRROR_OFF) n++
    expect(Math.abs(n / N - MIRROR_ENGAGE_MAX)).toBeLessThan(0.03)
  })

  it('harsh rows are vortex only: never a kaleidoscope, twist within the row ceiling, both directions, no spin', () => {
    for (const mood of ['aggressive', 'tense', 'driving'] as const) {
      const row = MOOD_ROWS[mood]
      const signs = new Set<number>()
      for (let s = 0; s < 3000; s++) {
        for (const t of [0, 0.5, 1]) {
          const m = mirrorFromProfile({ ...row, mirrorEngage: 0.9 }, t, s, FRESH)
          if (m === MIRROR_OFF) continue
          expect(m.mode, mood).toBe('vortex')
          expect(m.segments).toBe(0)
          expect(m.spin).toBe(0)
          expect(Math.abs(m.twist)).toBeLessThanOrEqual(row.mirrorTwistMax + 1e-12)
          expect(Math.abs(m.twist)).toBeGreaterThan(0)
          signs.add(Math.sign(m.twist))
        }
      }
      expect(signs.size, `${mood} winds both ways`).toBe(2)
    }
  })

  it('twist rises with tension but never past the ceiling', () => {
    const row = { ...MOOD_ROWS.tense, mirrorEngage: 0.9, mirrorTwistMax: 1.2 }
    let calm = 0
    let tense = 0
    let n = 0
    for (let s = 0; s < 400; s++) {
      const a = mirrorFromProfile(row, 0, s, FRESH)
      const b = mirrorFromProfile(row, 1, s, FRESH)
      if (a === MIRROR_OFF) continue
      calm += Math.abs(a.twist)
      tense += Math.abs(b.twist)
      n++
      expect(Math.abs(b.twist)).toBeLessThanOrEqual(1.2 + 1e-12)
    }
    expect(n).toBeGreaterThan(0)
    expect(tense).toBeGreaterThan(calm)
  })

  it('kaleidoscopes sample segments from the weights, keep spin inside [min, max] capped at 0.7, and carry no twist', () => {
    const row = rowLook('serene', { mirrorEngage: 0.9, mirrorSegments: [0.1, 0.7, 0.2], mirrorSpinMin: 0.1, mirrorSpinMax: 0.5 })
    const counts: Record<number, number> = { 4: 0, 6: 0, 8: 0 }
    let n = 0
    for (let s = 0; s < 20000; s++) {
      const t = (s % 11) / 10
      const m = mirrorFromProfile(row, t, s, FRESH)
      if (m === MIRROR_OFF) continue
      expect(m.mode).toBe('kaleido')
      expect(m.twist).toBe(0)
      expect(m.tiles).toBe(0)
      expect(m.slice).toBe(0)
      expect(m.spin).toBeGreaterThanOrEqual(0.1 - 1e-12)
      expect(m.spin).toBeLessThanOrEqual(0.5 + 1e-12)
      counts[m.segments]++
      n++
    }
    expect(counts[4] + counts[6] + counts[8]).toBe(n)
    expect(Math.abs(counts[4] / n - 0.1)).toBeLessThan(0.02)
    expect(Math.abs(counts[6] / n - 0.7)).toBeLessThan(0.02)
    expect(Math.abs(counts[8] / n - 0.2)).toBeLessThan(0.02)
    // A ceiling above the cap is held to it.
    const fast = rowLook('serene', { mirrorEngage: 0.9, mirrorSpinMin: 0.9, mirrorSpinMax: 2 })
    for (let s = 0; s < 200; s++) {
      const m = mirrorFromProfile(fast, 1, s, FRESH)
      if (m !== MIRROR_OFF) expect(m.spin).toBeLessThanOrEqual(MIRROR_SPIN_CAP)
    }
  })

  it('samples the mode in proportion to the mode weights', () => {
    const row = rowLook('dreamy', { mirrorEngage: 0.9, mirrorMode: [0.7, 0.3] })
    let k = 0
    let v = 0
    for (let s = 0; s < 20000; s++) {
      const m = mirrorFromProfile(row, 0.5, s, FRESH)
      if (m.mode === 'kaleido') k++
      else if (m.mode === 'vortex') v++
    }
    expect(Math.abs(k / (k + v) - 0.7)).toBeLessThan(0.02)
  })

  it('is deterministic per (profile, tension, seed, habituation)', () => {
    for (let s = 0; s < 300; s++) {
      expect(mirrorFromProfile(MOOD_ROWS.euphoric, 0.4, s, FRESH)).toEqual(mirrorFromProfile(MOOD_ROWS.euphoric, 0.4, s, FRESH))
    }
  })

  it('an engaged decision is never a dead one (a segment count or a twist is always set)', () => {
    for (const mood of Object.keys(MOOD_ROWS) as (keyof typeof MOOD_ROWS)[]) {
      for (let s = 0; s < 300; s++) {
        const m = mirrorFromProfile({ ...MOOD_ROWS[mood], mirrorEngage: 0.9 }, 0.5, s, FRESH)
        if (m === MIRROR_OFF) continue
        expect(m.segments >= 4 || Math.abs(m.twist) > 0).toBe(true)
      }
    }
  })
})

describe('scaleMirrorSpin', () => {
  it('is the legacy breathing scale (0.6 + level * 0.7) under the cap', () => {
    for (const level of sweep(10)) expect(scaleMirrorSpin(0.3, level)).toBe(0.3 * (0.6 + level * 0.7))
  })

  it('never exceeds 0.7 after scaling, for any base spin and level', () => {
    for (const spin of sweep(14).map((x) => x * 0.7)) {
      for (const level of sweep(10)) expect(scaleMirrorSpin(spin, level)).toBeLessThanOrEqual(MIRROR_SPIN_CAP)
    }
    expect(scaleMirrorSpin(0.65, 1)).toBe(MIRROR_SPIN_CAP) // the legacy path would give 0.845 here
  })
})

// ---------------------------------------------------------------------------------------------------------
// Lens dip-and-swap
// ---------------------------------------------------------------------------------------------------------

describe('stepLensSwap', () => {
  const DT = 1 / 60
  const st = (style: number, amount: number): LensSwapState => ({ style, amount })

  it('never changes the material while the amount is at or above 0.05 (and only on a frame where it is below)', () => {
    const state = st(2, 0.3)
    let desired = 4
    let engaged = true
    let target = 0.28
    let swaps = 0
    for (let i = 0; i < 40000; i++) {
      // A deterministic, restless director: new materials, disengage / re-engage, swings of the target.
      if (i % 397 === 0) desired = Math.floor(unit01(i, 11) * 8)
      if (i % 911 === 0) engaged = unit01(i, 12) < 0.7
      if (i % 61 === 0) target = 0.15 + unit01(i, 13) * 0.4
      const before = { style: state.style, amount: state.amount }
      stepLensSwap(state, desired, target, engaged, DT)
      if (state.style !== before.style) {
        swaps++
        expect(before.amount, `frame ${i}`).toBeLessThan(LENS_SWAP_BELOW)
        expect(state.amount, `frame ${i}`).toBeLessThan(LENS_SWAP_BELOW)
        expect(state.amount).toBe(before.amount) // the swap frame holds the amount; it rises on the next
      }
    }
    expect(swaps).toBeGreaterThan(5)
  })

  it('dips an engaged lens toward 0, swaps, then eases back up to the new target: no step in the amount', () => {
    const state = st(2, 0.3)
    const amounts: number[] = []
    let swappedAt = -1
    for (let i = 0; i < 60 * 12; i++) {
      const before = state.style
      stepLensSwap(state, 4, 0.3, true, DT)
      amounts.push(state.amount)
      if (state.style !== before && swappedAt < 0) swappedAt = i
    }
    expect(swappedAt).toBeGreaterThan(30) // it takes a moment to dip: not a hard swap
    expect(state.style).toBe(4)
    expect(amounts[swappedAt]).toBeLessThan(LENS_SWAP_BELOW)
    // Falls monotonically to the swap, rises monotonically after it.
    for (let i = 1; i <= swappedAt; i++) expect(amounts[i]).toBeLessThanOrEqual(amounts[i - 1] + 1e-12)
    for (let i = swappedAt + 2; i < amounts.length; i++) expect(amounts[i]).toBeGreaterThanOrEqual(amounts[i - 1] - 1e-12)
    // The biggest single-frame move is small (an eased amount, never a step).
    let maxStep = 0
    for (let i = 1; i < amounts.length; i++) maxStep = Math.max(maxStep, Math.abs(amounts[i] - amounts[i - 1]))
    expect(maxStep).toBeLessThan(0.01)
    expect(state.amount).toBeGreaterThan(0.25) // back near the target after twelve seconds
  })

  it('swaps at once (holding the amount) when nothing is visible, then eases up', () => {
    const state = st(1, 0.02)
    stepLensSwap(state, 5, 0.3, true, DT)
    expect(state).toEqual({ style: 5, amount: 0.02 })
    stepLensSwap(state, 5, 0.3, true, DT)
    expect(state.amount).toBeGreaterThan(0.02)
  })

  it('a disengaged lens keeps its material and eases out (like the legacy rack), and a pending swap waits for the next engagement', () => {
    const state = st(3, 0.25)
    for (let i = 0; i < 60 * 30; i++) stepLensSwap(state, 5, 0.3, false, DT)
    expect(state.style).toBe(3)
    expect(state.amount).toBeLessThan(0.001)
    stepLensSwap(state, 5, 0.3, true, DT)
    expect(state.style).toBe(5) // invisible now, so it swaps on the first engaged frame
  })

  it('with no change of material it is the plain legacy ease (rate 0.5) toward the target', () => {
    const state = st(4, 0.1)
    let ref = 0.1
    for (let i = 0; i < 300; i++) {
      stepLensSwap(state, 4, 0.31, true, DT)
      ref = approach(ref, 0.31, 0.5, DT)
      expect(state.amount).toBeCloseTo(ref, 12)
    }
    expect(state.style).toBe(4)
  })

  it('holds through a bad dt and a bad target instead of poisoning the state', () => {
    const state = st(4, 0.2)
    for (const dt of [NaN, 0, -1, Infinity]) {
      stepLensSwap(state, 4, 0.3, true, dt)
      stepLensSwap(state, 5, 0.3, true, dt)
      expect(state).toEqual({ style: 4, amount: 0.2 })
    }
    stepLensSwap(state, 4, NaN, true, DT)
    expect(Number.isNaN(state.amount)).toBe(false)
    expect(state.amount).toBeLessThan(0.2) // a NaN target reads as 0
  })

  it('a long frame (a resumed tab) cannot skip the dip: it goes invisible first, swaps on the following frame', () => {
    const state = st(2, 0.3)
    stepLensSwap(state, 6, 0.3, true, 5)
    expect(state.style).toBe(2)
    expect(state.amount).toBeLessThan(LENS_SWAP_BELOW)
    stepLensSwap(state, 6, 0.3, true, 5)
    expect(state.style).toBe(6)
  })
})

// ---------------------------------------------------------------------------------------------------------
// Trails shape
// ---------------------------------------------------------------------------------------------------------

describe('trails shape', () => {
  const look = (over: Partial<LookProfile> = {}) => ({ ...createLookProfile(), ...over })
  const neutralShape = (): TrailsShape => ({ zoom: 1, rotate: 1, swirl: 1, wobble: 1 })

  it('eases toward the profile multipliers while the post family is on, and settles on them', () => {
    const s = neutralShape()
    const l = look({ valid: true, trailsZoom: 1.6, trailsRotate: 0.4, trailsSwirl: 1.5, trailsWobble: 0.3 })
    let prev = s.zoom
    for (let i = 0; i < 60 * 12; i++) {
      stepTrailsShape(s, l, 1 / 60)
      expect(s.zoom).toBeGreaterThanOrEqual(prev - 1e-12)
      prev = s.zoom
    }
    expect(s.zoom).toBeCloseTo(1.6, 3)
    expect(s.rotate).toBeCloseTo(0.4, 3)
    expect(s.swirl).toBeCloseTo(1.5, 3)
    expect(s.wobble).toBeCloseTo(0.3, 3)
  })

  it('does not step: one 60 Hz frame moves a small fraction of the way', () => {
    const s = neutralShape()
    stepTrailsShape(s, look({ valid: true, trailsZoom: 2 }), 1 / 60)
    expect(s.zoom).toBeGreaterThan(1)
    expect(s.zoom).toBeLessThan(1.03)
  })

  it('eases back to 1 when the post family is off or the profile is not valid (kill switch, lost read)', () => {
    for (const l of [
      look({ valid: true, families: { grade: true, post: false, scene: true, camera: true }, trailsZoom: 1.8 }),
      look({ valid: false, trailsZoom: 1.8 }),
    ]) {
      const s: TrailsShape = { zoom: 1.8, rotate: 0.3, swirl: 1.9, wobble: 0.1 }
      for (let i = 0; i < 60 * 12; i++) stepTrailsShape(s, l, 1 / 60)
      expect(s.zoom).toBeCloseTo(1, 3)
      expect(s.rotate).toBeCloseTo(1, 3)
      expect(s.swirl).toBeCloseTo(1, 3)
      expect(s.wobble).toBeCloseTo(1, 3)
    }
  })

  it('clamps to 0..2, reads a non-finite multiplier as 1, and holds through a bad dt', () => {
    const s = neutralShape()
    for (let i = 0; i < 60 * 20; i++) stepTrailsShape(s, look({ valid: true, trailsZoom: 9, trailsRotate: -4, trailsSwirl: NaN, trailsWobble: Infinity }), 1 / 60)
    expect(s.zoom).toBeCloseTo(2, 3)
    expect(s.rotate).toBeCloseTo(0, 3)
    expect(s.swirl).toBeCloseTo(1, 3)
    expect(s.wobble).toBeCloseTo(1, 3)
    const before = { ...s }
    for (const dt of [NaN, 0, -2, Infinity]) stepTrailsShape(s, look({ valid: true, trailsZoom: 0 }), dt)
    expect(s).toEqual(before)
  })

  it('feeds resolveFeedbackKnobs: omitted or neutral is the unchanged mapping, a multiplier scales only its own knob', () => {
    for (const t of [0, 0.02, 0.3, 0.8, 1, NaN, 2]) {
      const base = resolveFeedbackKnobs(t)
      expect(resolveFeedbackKnobs(t, undefined)).toEqual(base)
      expect(resolveFeedbackKnobs(t, {})).toEqual(base)
      expect(resolveFeedbackKnobs(t, { zoom: 1, rotate: 1, swirl: 1, wobble: 1 })).toEqual(base)
    }
    const base = resolveFeedbackKnobs(0.6)
    const k = resolveFeedbackKnobs(0.6, { zoom: 2, rotate: 0, swirl: 0.5 })
    expect(k.persist).toBe(base.persist) // the anti-washout ceiling is never a shape
    expect(k.zoomRatePerSec).toBeCloseTo(base.zoomRatePerSec * 2, 12)
    expect(k.rotateRatePerSec).toBe(0)
    expect(k.swirl).toBeCloseTo(base.swirl * 0.5, 12)
    expect(k.wobble).toBe(base.wobble)
  })

  it('a shape multiplier is clamped and NaN-safe, and cannot turn a stopped pass on', () => {
    expect(resolveFeedbackKnobs(0.6, { zoom: 50 }).zoomRatePerSec).toBeCloseTo(resolveFeedbackKnobs(0.6).zoomRatePerSec * 2, 12)
    expect(resolveFeedbackKnobs(0.6, { zoom: -3 }).zoomRatePerSec).toBe(0)
    expect(resolveFeedbackKnobs(0.6, { zoom: NaN, wobble: Infinity })).toEqual(resolveFeedbackKnobs(0.6)) // non-finite reads as 1
    expect(resolveFeedbackKnobs(0, { zoom: 2 })).toEqual(resolveFeedbackKnobs(0))
    expect(resolveFeedbackKnobs(0.6, { zoom: 2 }).persist).toBeLessThan(1)
  })
})

// ---------------------------------------------------------------------------------------------------------
// Source pins: the properties that live in the bridge, not in a pure function
// ---------------------------------------------------------------------------------------------------------

describe('bridge wiring (source pins)', () => {
  const bridge = code(BRIDGE_SRC)

  it('the scene exclusions are unchanged: kifs / maze / wingfold sit out mirror AND trails, djcam sits out the mirror', () => {
    expect(bridge).toMatch(/MIRROR_TRAILS_EXCLUDED_SCENES\s*=\s*new Set\(\['kifs', 'maze', 'wingfold'\]\)/)
    expect(bridge).toMatch(/MIRROR_ONLY_EXCLUDED_SCENES\s*=\s*new Set\(\['djcam'\]\)/)
    expect(bridge).toMatch(/rackSuppressed\s*=\s*MIRROR_TRAILS_EXCLUDED_SCENES\.has\(p\.activeScene\)/)
    expect(bridge).toMatch(/mirrorSuppressed\s*=\s*rackSuppressed\s*\|\|\s*MIRROR_ONLY_EXCLUDED_SCENES\.has\(p\.activeScene\)/)
    // Trails: suppression wins over BOTH the profile and the legacy target.
    expect(bridge).toMatch(/rackSuppressed\s*\?\s*0\s*:\s*postOn\s*\?\s*trailsFromProfile\(/)
    // Mirror: the suppressed scene zeroes counts, twist, spin and mix regardless of which path picked the look.
    expect(bridge).toMatch(/approach\(p\.mirror\.twist,\s*mirrorSuppressed \? 0 : mt\.twist/)
    expect(bridge).toMatch(/approach\(p\.mirror\.slice,\s*mirrorSuppressed \? 0 : mt\.slice/)
    expect(bridge).toMatch(/if \(mirrorSuppressed\) \{\s*p\.mirror\.segments = 0\s*p\.mirror\.tiles = 0/)
    expect(bridge).toMatch(/p\.mirror\.mix = mirrorSuppressed\s*\? 0/)
  })

  it('every family is gated on valid && its family flag, and the legacy formula is still there for each', () => {
    expect(bridge).toMatch(/L\.valid && L\.families\.camera \? L : undefined/)
    expect(bridge).toMatch(/L\.valid && L\.families\.scene \? L : undefined/)
    expect(bridge).toMatch(/L\.valid && L\.families\.post \? L : undefined/)
    expect(bridge).toMatch(/postOn = postLookActive\(L, look\)/)
    for (const legacy of [
      /BLOOM_BASE\[look\]/,
      /VIGNETTE_BASE \+ p\.visualTension \* 0\.16/,
      /0\.0006 \+/,
      /look === 'ambient' \? 0\.25 : 0/,
      /trailsTarget\(look, f\.flux, m\.level\)/,
      /echoTarget\(look, pulse\)/,
      /lensAmountTarget\(look, p\.visualTension/,
      /lensForSection\(look, seed/,
      /mirrorForSection\(look, p\.visualTension/,
    ]) {
      expect(bridge).toMatch(legacy)
    }
  })

  it('the tracker runs once per frame BEFORE any reader (steer, camera, post, transition)', () => {
    const at = (needle: string) => {
      const i = bridge.indexOf(needle)
      expect(i, needle).toBeGreaterThan(-1)
      return i
    }
    const update = at('rt.tracker.update(')
    for (const reader of ['advanceSteer(p.sceneParams', 'pickCameraMode(', 'bloomFromProfile(', 'pickTransitionStyle(', 'mirrorFromProfile(', 'lensFromProfile(']) {
      expect(update, reader).toBeLessThan(at(reader))
    }
    expect(bridge.split('rt.tracker.update(').length - 1).toBe(1)
    // Flags are read once, in createLookRuntime, never per frame.
    expect(bridge).not.toMatch(/lookForceMood\(|lookFamilies\(|lookDebugEnabled\(/)
  })

  it('the lens keeps its decision-edge conditions; the mirror decides through the gate, never by re-rolling', () => {
    expect(bridge).toMatch(/f\.sectionChange \|\| \(phraseEdge && lensPhrasesHeld\.current >= LENS_MAX_PHRASES\)/)
    // The mirror: one gated decision (mirrorGate.ts), on a beat, with a deterministic per-section seed. The old
    // per-sectionChange / per-phrase re-roll (shouldRepickMirror, a fresh `mirrorSeed++` coin flip, a mood-moved
    // bypass of every hold) made an engaged fold flip on and off at random and must not come back.
    expect(bridge).toMatch(/stepMirrorGate\(mirrorGateState\.current,/)
    expect(bridge).toMatch(/beatEdge:\s*f\.beat,/)
    expect(bridge).toMatch(/mirrorFromProfile\(L, p\.visualTension, gate\.seed,/)
    expect(bridge).toMatch(/commitMirrorDecision\(/)
    expect(bridge).not.toMatch(/shouldRepickMirror/)
    expect(bridge).not.toMatch(/mirrorSeed\.current\+\+/)
    expect(bridge).not.toMatch(/mirrorPrimaryAtPick/)
  })

  it('no wall-clock or unseeded randomness in the look system', () => {
    expect(code(POST_SRC)).not.toMatch(/Math\.random\s*\(/)
    expect(bridge).not.toMatch(/Math\.random\s*\(/)
    expect(code(POST_SRC)).not.toMatch(/Date\.now|performance\.now/)
  })

  it('the per-frame functions of lookPost.ts allocate nothing', () => {
    const region = hotPath(POST_SRC)
    expect(region.length).toBeGreaterThan(500)
    expect(findAllocations(region)).toEqual([])
  })
})

// A last guard on the constants the wiring leans on.
describe('constants', () => {
  it('the caps are what the tests above assume', () => {
    expect(LENS.flyEye).toBe(6)
    expect(LENS_ENGAGE_MAX).toBeLessThanOrEqual(0.9)
    expect(MIRROR_ENGAGE_MAX).toBeLessThanOrEqual(0.9)
    expect(MIRROR_SPIN_CAP).toBe(0.7)
  })
})
