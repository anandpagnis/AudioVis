import { describe, expect, it } from 'vitest'
import { CHARACTER_MOODS, type CharacterMood } from '../../../audio/characterTypes'
import { MOOD_PROTOTYPES } from '../../../audio/moodTaxonomy'
import {
  createNeutralRow,
  LENS,
  LENS_STYLE_COUNT,
  LOOK_CAMERA_MODES,
  LOOK_TRANSITIONS,
  MIRROR_MODES,
  ROW_ARRAY_KEYS,
  ROW_SCALAR_KEYS,
  SEGMENT_CHOICES,
  type LookRow,
} from '../lookRow'
import { MOOD_ROWS } from '../moodRows'

/**
 * moodRows — the authored table. The values are art-direction HYPOTHESES (see the header of moodRows.ts), so
 * these tests pin what must stay true however the numbers are retuned: every field is legal, the safety
 * rules hold, the ORDERING between moods tells the intended story, and no two moods look alike.
 */

type ScalarKey = (typeof ROW_SCALAR_KEYS)[number]
type ArrayKey = keyof typeof ROW_ARRAY_KEYS

/** The design ranges documented in lookRow.ts. Not hard clamps in the engine, but every authored value stays inside. */
// prettier-ignore
const RANGES: Record<ScalarKey, readonly [number, number]> = {
  bloomBase: [0.25, 0.8], bloomReact: [0.5, 1.4], caBase: [0, 0.004], caReact: [0.5, 2], vignette: [0.7, 1], fogBase: [0, 0.5],
  trailsBase: [0, 1], trailsZoom: [0, 2], trailsRotate: [0, 2], trailsSwirl: [0, 2], trailsWobble: [0, 2], echoGate: [0, 1],
  lensEngage: [0, 0.7], lensAmountFloor: [0.15, 0.42], lensAmountCeil: [0.15, 0.42],
  mirrorEngage: [0, 0.9], mirrorSpinMin: [0, 0.7], mirrorSpinMax: [0, 0.7], mirrorTwistMax: [0, 1.3], mirrorMix: [0, 1], mirrorBusyGain: [0, 1],
  steerSpeed: [0, 1], steerComplexity: [0, 1], steerDensity: [0, 1], steerFill: [0, 1], steerContrast: [0, 1],
  cameraSpeed: [0.6, 1.6], cameraShake: [0, 1.5], cameraCutRate: [0, 1],
  transitionDurationBias: [0.6, 1.6], transitionSharpness: [1, 8],
  gradeSat: [0.75, 1.3], gradeTemp: [-1, 1], gradeContrast: [0.95, 1.3],
  traitTempo: [0, 1], traitAngular: [0, 1], traitBusy: [0, 1], traitRadial: [0, 1], traitStrength: [0, 1],
  fxShock: [0, 1.5], fxFlare: [0, 1.5], fxSpark: [0, 1.5], fxStrobe: [0, 1.5],
}

const MOODS = CHARACTER_MOODS
const row = (m: CharacterMood): LookRow => MOOD_ROWS[m]
const ARRAY_KEYS = Object.keys(ROW_ARRAY_KEYS) as ArrayKey[]
const sum = (v: readonly number[]): number => v.reduce((a, b) => a + b, 0)
/** Share of a weight vector on one option (rows are normalised, but do not rely on it). */
const share = (v: readonly number[], i: number): number => v[i] / sum(v)
const lensShare = (m: CharacterMood, name: keyof typeof LENS): number =>
  share(row(m).lensWeights, LENS[name])
const cameraShare = (m: CharacterMood, name: (typeof LOOK_CAMERA_MODES)[number]): number =>
  share(row(m).cameraWeights, LOOK_CAMERA_MODES.indexOf(name))
const kaleidoShare = (m: CharacterMood): number =>
  share(row(m).mirrorMode, MIRROR_MODES.indexOf('kaleido'))
const bigSegmentShare = (m: CharacterMood): number =>
  share(row(m).mirrorSegments, SEGMENT_CHOICES.indexOf(6)) +
  share(row(m).mirrorSegments, SEGMENT_CHOICES.indexOf(8))

/** Every (mood, key) that breaks `ok`, as readable strings, so a failure names the culprits. */
function violations(
  keys: readonly ScalarKey[],
  moods: readonly CharacterMood[],
  ok: (v: number, k: ScalarKey) => boolean,
): string[] {
  const bad: string[] = []
  for (const m of moods)
    for (const k of keys) if (!ok(row(m)[k], k)) bad.push(`${m}.${k}=${row(m)[k]}`)
  return bad
}

const HARSH: readonly CharacterMood[] = ['aggressive', 'tense', 'driving']
/** Low-arousal moods: never extra saturation, fast camera or hard effects. */
const CALM: readonly CharacterMood[] = [
  'serene',
  'tender',
  'dreamy',
  'melancholic',
  'brooding',
  'mysterious',
]
const SOFT_THREE: readonly CharacterMood[] = ['serene', 'tender', 'melancholic']

describe('MOOD_ROWS: structure and ranges', () => {
  it('has exactly the 14 character moods', () => {
    expect(Object.keys(MOOD_ROWS).sort()).toEqual([...MOODS].sort())
  })

  it('the range table covers exactly the numeric fields of LookRow', () => {
    const neutral = createNeutralRow()
    const numeric = Object.keys(neutral).filter(
      (k) => typeof neutral[k as keyof LookRow] === 'number',
    )
    expect([...ROW_SCALAR_KEYS].sort()).toEqual(numeric.sort())
    expect(Object.keys(RANGES).sort()).toEqual(numeric.sort())
    expect([...ARRAY_KEYS].sort()).toEqual(
      Object.keys(neutral)
        .filter((k) => Array.isArray(neutral[k as keyof LookRow]))
        .sort(),
    )
  })

  it('every scalar is finite and inside its design range', () => {
    const bad = violations(
      ROW_SCALAR_KEYS,
      MOODS,
      (v, k) => Number.isFinite(v) && v >= RANGES[k][0] && v <= RANGES[k][1],
    )
    expect(bad).toEqual([])
  })

  it('every array has the contract length, finite non-negative entries and a positive sum', () => {
    for (const m of MOODS) {
      for (const k of ARRAY_KEYS) {
        const v = row(m)[k]
        expect(Array.isArray(v), `${m}.${k} is an array`).toBe(true)
        expect(v.length, `${m}.${k} length`).toBe(ROW_ARRAY_KEYS[k])
        for (const x of v) {
          expect(Number.isFinite(x) && x >= 0, `${m}.${k} entry ${x}`).toBe(true)
        }
        expect(sum(v), `${m}.${k} sum`).toBeGreaterThan(0)
      }
    }
  })

  it('weight vectors are normalised to sum 1, so the linear blend of rows is a proper marginal', () => {
    for (const m of MOODS)
      for (const k of ARRAY_KEYS) expect(sum(row(m)[k]), `${m}.${k}`).toBeCloseTo(1, 9)
  })

  it('range pairs are ordered (amount floor <= ceil, spin min <= max)', () => {
    for (const m of MOODS) {
      expect(row(m).lensAmountFloor, m).toBeLessThanOrEqual(row(m).lensAmountCeil)
      expect(row(m).mirrorSpinMin, m).toBeLessThanOrEqual(row(m).mirrorSpinMax)
    }
  })

  it('rows and their arrays are never shared, with each other or with a fresh neutral row', () => {
    const rows = MOODS.map(row)
    expect(new Set(rows).size).toBe(rows.length)
    const arrays: unknown[] = []
    for (const r of [...rows, createNeutralRow(), createNeutralRow()])
      for (const k of ARRAY_KEYS) arrays.push(r[k])
    expect(new Set(arrays).size).toBe(arrays.length)
  })

  it('every mood is authored: it departs from the neutral row on most scalar fields', () => {
    // Groove is deliberately the closest to the neutral row (which is itself groove-like); it still moves 20+ fields.
    const neutral = createNeutralRow()
    for (const m of MOODS) {
      const changed = ROW_SCALAR_KEYS.filter((k) => row(m)[k] !== neutral[k]).length
      expect(changed, `${m} changes only ${changed} fields`).toBeGreaterThanOrEqual(20)
    }
  })
})

describe('MOOD_ROWS: safety rules', () => {
  it('fly-eye stays retired: its lens weight is 0 in every row', () => {
    for (const m of MOODS) expect(row(m).lensWeights[LENS.flyEye], m).toBe(0)
    expect(row('aggressive').lensWeights).toHaveLength(LENS_STYLE_COUNT)
  })

  it('mirror spin never exceeds 0.7', () => {
    for (const m of MOODS) {
      expect(row(m).mirrorSpinMin, m).toBeLessThanOrEqual(0.7)
      expect(row(m).mirrorSpinMax, m).toBeLessThanOrEqual(0.7)
    }
  })

  it('strobe is 0 for every calm mood and never above 0.8 anywhere', () => {
    for (const m of CALM) expect(row(m).fxStrobe, m).toBe(0)
    for (const m of MOODS) expect(row(m).fxStrobe, m).toBeLessThanOrEqual(0.8)
    expect(row('groove').fxStrobe).toBe(0)
  })

  it('low-arousal moods never get extra saturation, a fast camera or hard effects', () => {
    for (const m of CALM) {
      expect(row(m).gradeSat, `${m} gradeSat`).toBeLessThanOrEqual(1)
      expect(row(m).cameraSpeed, `${m} cameraSpeed`).toBeLessThanOrEqual(0.8)
      expect(row(m).cameraShake, `${m} cameraShake`).toBeLessThanOrEqual(0.35)
      expect(row(m).fxShock, `${m} fxShock`).toBeLessThanOrEqual(0.3)
      expect(row(m).fxSpark, `${m} fxSpark`).toBeLessThanOrEqual(0.3)
      expect(row(m).lensEngage, `${m} lensEngage`).toBeLessThanOrEqual(0.35)
      expect(row(m).caBase, `${m} caBase`).toBeLessThanOrEqual(0.0012)
    }
  })

  it('serene, tender and melancholic: long trails, no CA, soft lens only, and melancholic has no mirror', () => {
    for (const m of SOFT_THREE) {
      expect(row(m).trailsBase, `${m} trails`).toBeGreaterThanOrEqual(0.8)
      expect(row(m).caBase, `${m} ca`).toBe(0)
      for (const hard of ['glitch', 'pixels', 'pixelSort'] as const)
        expect(lensShare(m, hard), `${m} ${hard}`).toBe(0)
    }
    expect(row('melancholic').mirrorEngage).toBeLessThanOrEqual(0.05)
  })

  it('cool and dark moods (melancholic, brooding, mysterious, tense) are cool with heavy vignettes', () => {
    for (const m of ['melancholic', 'brooding', 'mysterious', 'tense'] as const) {
      expect(row(m).gradeTemp, `${m} gradeTemp`).toBeLessThanOrEqual(0)
      expect(row(m).vignette, `${m} vignette`).toBeGreaterThanOrEqual(0.9)
    }
  })

  it('aggressive, euphoric, uplifting, playful and tender are warm', () => {
    for (const m of ['aggressive', 'euphoric', 'uplifting', 'playful', 'tender'] as const) {
      expect(row(m).gradeTemp, m).toBeGreaterThan(0)
    }
  })

  it('effect propensities: euphoric, aggressive and epic are the loud ones', () => {
    for (const m of ['euphoric', 'aggressive', 'epic'] as const) {
      expect(row(m).fxShock, `${m} shock`).toBeGreaterThanOrEqual(1.2)
      expect(row(m).fxSpark, `${m} spark`).toBeGreaterThanOrEqual(1.1)
    }
    for (const m of ['euphoric', 'aggressive', 'epic'] as const) {
      expect(row(m).fxStrobe, `${m} strobe`).toBeGreaterThanOrEqual(0.5)
    }
  })
})

describe('MOOD_ROWS: ordering between moods', () => {
  it('post: aggressive / euphoric / epic bloom brighter than serene / melancholic', () => {
    for (const hot of ['aggressive', 'euphoric', 'epic'] as const) {
      for (const cold of ['serene', 'melancholic'] as const) {
        expect(row(hot).bloomBase, `${hot} > ${cold}`).toBeGreaterThan(row(cold).bloomBase)
      }
    }
  })

  it('post: chromatic aberration and edge darkness rise with harshness / tension', () => {
    expect(row('aggressive').caBase).toBeGreaterThan(row('serene').caBase)
    expect(row('tense').caBase).toBeGreaterThan(row('euphoric').caBase)
    expect(row('driving').caBase).toBeGreaterThan(row('groove').caBase)
    expect(row('tense').vignette).toBeGreaterThan(row('playful').vignette)
    expect(row('brooding').vignette).toBeGreaterThan(row('serene').vignette)
    expect(row('serene').fogBase).toBeGreaterThan(row('aggressive').fogBase)
  })

  it('feedback: serene trails are longer than aggressive, and aggressive echoes harder', () => {
    expect(row('serene').trailsBase).toBeGreaterThan(row('aggressive').trailsBase)
    expect(row('dreamy').trailsBase).toBeGreaterThan(row('driving').trailsBase)
    expect(row('aggressive').echoGate).toBeGreaterThan(row('serene').echoGate)
    expect(row('euphoric').echoGate).toBeGreaterThan(row('melancholic').echoGate)
    // dreamy swirls and wobbles hardest; tense wobbles hardest of the harsh
    expect(row('dreamy').trailsSwirl).toBeGreaterThanOrEqual(1.5)
    expect(row('dreamy').trailsWobble).toBeGreaterThanOrEqual(1.5)
    expect(row('tense').trailsWobble).toBeGreaterThan(row('aggressive').trailsWobble)
  })

  it('lens: aggressive engages more than serene, at a stronger amount range', () => {
    expect(row('aggressive').lensEngage).toBeGreaterThan(row('serene').lensEngage)
    expect(row('aggressive').lensAmountFloor).toBeGreaterThan(row('serene').lensAmountCeil)
  })

  it('lens: pixel sort share aggressive > dreamy and > serene', () => {
    expect(lensShare('aggressive', 'pixelSort')).toBeGreaterThan(lensShare('dreamy', 'pixelSort'))
    expect(lensShare('aggressive', 'pixelSort')).toBeGreaterThan(lensShare('serene', 'pixelSort'))
  })

  it('lens: pixel sort and glitch dominate the harsh moods, and only the harsh moods', () => {
    const hard = (m: CharacterMood): number => lensShare(m, 'pixelSort') + lensShare(m, 'glitch')
    for (const m of HARSH) expect(hard(m), m).toBeGreaterThanOrEqual(0.6)
    for (const m of MOODS.filter((x) => !HARSH.includes(x))) expect(hard(m), m).toBeLessThan(0.5)
    expect(lensShare('aggressive', 'pixelSort')).toBeGreaterThan(lensShare('aggressive', 'glitch'))
  })

  it('mirror: mysterious / euphoric mirror far more than aggressive / driving', () => {
    for (const m of ['mysterious', 'euphoric'] as const) {
      for (const h of ['aggressive', 'driving'] as const) {
        expect(row(m).mirrorEngage, `${m} > ${h}`).toBeGreaterThan(row(h).mirrorEngage + 0.25)
      }
    }
    expect(row('aggressive').mirrorEngage).toBeLessThanOrEqual(0.15)
  })

  it('mirror: dreamy, mysterious, euphoric and epic mirror most, as kaleidoscopes on 6 / 8 segments', () => {
    const most = ['dreamy', 'mysterious', 'euphoric', 'epic'] as const
    const rest = MOODS.filter((m) => !most.includes(m as (typeof most)[number]))
    const floor = Math.min(...most.map((m) => row(m).mirrorEngage))
    for (const m of rest) expect(row(m).mirrorEngage, `${m} < the four`).toBeLessThan(floor)
    for (const m of most) {
      expect(kaleidoShare(m), `${m} kaleido`).toBeGreaterThanOrEqual(0.65)
      expect(bigSegmentShare(m), `${m} 6/8 segments`).toBe(1)
    }
  })

  it('mirror: vortex only on harsh moods (kaleido weight 0), and every gentler mood is mostly kaleido or rare', () => {
    for (const m of HARSH) {
      expect(row(m).mirrorMode[MIRROR_MODES.indexOf('kaleido')], `${m} kaleido`).toBe(0)
      expect(row(m).mirrorMode[MIRROR_MODES.indexOf('vortex')], `${m} vortex`).toBeGreaterThan(0)
    }
    // the only other vortex-leaning mood is the slow, dark brooding one
    for (const m of MOODS.filter((x) => !HARSH.includes(x) && x !== 'brooding')) {
      expect(kaleidoShare(m), `${m} kaleido share`).toBeGreaterThanOrEqual(0.6)
    }
    // vortex twist is highest on the harsh moods
    for (const h of HARSH)
      for (const m of ['serene', 'tender', 'melancholic', 'dreamy', 'euphoric'] as const) {
        expect(row(h).mirrorTwistMax, `${h} twist > ${m}`).toBeGreaterThan(row(m).mirrorTwistMax)
      }
  })

  it('grade: saturation rises with arousal, warmth follows valence', () => {
    expect(row('melancholic').gradeSat).toBeLessThan(row('euphoric').gradeSat)
    expect(row('serene').gradeSat).toBeLessThan(row('aggressive').gradeSat)
    expect(row('melancholic').gradeSat).toBe(Math.min(...MOODS.map((m) => row(m).gradeSat)))
    expect(row('euphoric').gradeSat).toBe(Math.max(...MOODS.map((m) => row(m).gradeSat)))
    expect(row('melancholic').gradeTemp).toBeLessThan(0)
    expect(row('tender').gradeTemp).toBeGreaterThan(0)
    expect(row('melancholic').gradeTemp).toBeLessThan(row('tender').gradeTemp)
    expect(row('aggressive').gradeContrast).toBeGreaterThan(row('serene').gradeContrast)
    expect(row('tense').gradeContrast).toBeGreaterThan(row('dreamy').gradeContrast)
  })

  it('steer: serene is the stillest, euphoric the fastest and densest', () => {
    expect(row('serene').steerSpeed).toBeLessThan(row('euphoric').steerSpeed)
    expect(row('serene').steerSpeed).toBe(Math.min(...MOODS.map((m) => row(m).steerSpeed)))
    expect(row('euphoric').steerDensity).toBe(Math.max(...MOODS.map((m) => row(m).steerDensity)))
    expect(row('aggressive').steerContrast).toBeGreaterThan(row('serene').steerContrast)
    expect(row('epic').steerFill).toBe(Math.max(...MOODS.map((m) => row(m).steerFill)))
  })

  it('camera: aggressive shakes and cuts far more than serene, handheld vs hover', () => {
    expect(row('aggressive').cameraShake).toBeGreaterThan(row('serene').cameraShake)
    expect(row('aggressive').cameraSpeed).toBeGreaterThan(row('serene').cameraSpeed)
    expect(row('aggressive').cameraCutRate).toBeGreaterThan(row('serene').cameraCutRate)
    expect(cameraShare('aggressive', 'handheld')).toBeGreaterThan(cameraShare('serene', 'handheld'))
    expect(cameraShare('serene', 'hover')).toBeGreaterThan(cameraShare('aggressive', 'hover'))
    expect(cameraShare('driving', 'push')).toBeGreaterThan(cameraShare('serene', 'push'))
    expect(cameraShare('epic', 'cinematic')).toBeGreaterThan(cameraShare('aggressive', 'cinematic'))
    // tense is the jitteriest after aggressive
    expect(row('aggressive').cameraShake).toBeGreaterThan(row('tense').cameraShake)
    expect(row('tense').cameraShake).toBeGreaterThan(row('driving').cameraShake)
  })

  it('transitions: calm moods dissolve, the harsh ones collapse', () => {
    const t = (m: CharacterMood, name: (typeof LOOK_TRANSITIONS)[number]): number =>
      share(row(m).transitionWeights, LOOK_TRANSITIONS.indexOf(name))
    expect(t('serene', 'dissolve')).toBeGreaterThan(t('aggressive', 'dissolve'))
    expect(t('melancholic', 'dissolve')).toBeGreaterThan(t('driving', 'dissolve'))
    expect(t('aggressive', 'collapse')).toBeGreaterThan(t('serene', 'collapse'))
    expect(t('driving', 'collapse')).toBeGreaterThan(t('dreamy', 'collapse'))
    expect(t('dreamy', 'smear')).toBeGreaterThan(t('driving', 'smear'))
  })

  it('transitions: mosaic favours the rhythmic moods, sortSlice favours the harsh ones', () => {
    const t = (m: CharacterMood, name: (typeof LOOK_TRANSITIONS)[number]): number =>
      share(row(m).transitionWeights, LOOK_TRANSITIONS.indexOf(name))
    // mosaic (chunky, beat-locked, rides the `pixels` lens material): groove / playful / uplifting lead.
    expect(t('groove', 'mosaic')).toBeGreaterThan(t('serene', 'mosaic'))
    expect(t('playful', 'mosaic')).toBeGreaterThan(t('aggressive', 'mosaic'))
    expect(t('uplifting', 'mosaic')).toBeGreaterThan(t('tense', 'mosaic'))
    for (const calm of ['serene', 'tender', 'dreamy', 'melancholic'] as const) {
      expect(t(calm, 'mosaic'), calm).toBe(0)
    }
    // sortSlice (harsh, directional, rides `pixel-sort`): aggressive / tense / driving lead, carved mostly
    // out of collapse's share on those moods specifically.
    expect(t('aggressive', 'sortSlice')).toBeGreaterThan(t('serene', 'sortSlice'))
    expect(t('tense', 'sortSlice')).toBeGreaterThan(t('dreamy', 'sortSlice'))
    expect(t('driving', 'sortSlice')).toBeGreaterThan(t('groove', 'sortSlice'))
    for (const calm of ['serene', 'tender', 'dreamy', 'melancholic'] as const) {
      expect(t(calm, 'sortSlice'), calm).toBe(0)
    }
  })

  /**
   * The staged-rollout safety gate (plan's Phasing item 3) has been lifted: the two-texture wipe
   * machinery (`transitionWipe.ts`/`TransitionCapture`/`WipeCompositorPass`) was watched running
   * live and confirmed good, so the real per-mood weights recorded in ISSUES.md F257 are now
   * authored below, the same way `mosaic`/`sortSlice` were turned on in the prior phase.
   */
  it('transitions: inkDissolve favours the calm moods, irisWipe the grand ones, datamosh the harsh ones', () => {
    const t = (m: CharacterMood, name: (typeof LOOK_TRANSITIONS)[number]): number =>
      share(row(m).transitionWeights, LOOK_TRANSITIONS.indexOf(name))
    // inkDissolve (soft noise-threshold reveal): the stillest moods lead, and it now co-dominates
    // with plain dissolve on serene/tender/melancholic rather than being a rare accent.
    expect(t('serene', 'inkDissolve')).toBeGreaterThan(t('aggressive', 'inkDissolve'))
    expect(t('melancholic', 'inkDissolve')).toBeGreaterThan(t('driving', 'inkDissolve'))
    for (const harsh of ['aggressive', 'tense', 'driving'] as const) {
      expect(t(harsh, 'inkDissolve'), harsh).toBe(0)
    }
    // irisWipe (radial circle, grand/cinematic): epic leads, dreamy/mysterious/uplifting/euphoric carry it too.
    expect(t('epic', 'irisWipe')).toBeGreaterThan(t('serene', 'irisWipe'))
    expect(t('epic', 'irisWipe')).toBeGreaterThan(t('aggressive', 'irisWipe'))
    expect(t('mysterious', 'irisWipe')).toBeGreaterThan(t('groove', 'irisWipe'))
    // datamosh (spatial block-glitch): the harsh/dark moods lead, never the calm ones.
    expect(t('aggressive', 'datamosh')).toBeGreaterThan(t('serene', 'datamosh'))
    expect(t('driving', 'datamosh')).toBeGreaterThan(t('dreamy', 'datamosh'))
    expect(t('tense', 'datamosh')).toBeGreaterThan(t('playful', 'datamosh'))
    for (const calm of ['serene', 'tender', 'dreamy', 'melancholic', 'mysterious'] as const) {
      expect(t(calm, 'datamosh'), calm).toBe(0)
    }
  })

  it('traits: fast and angular for the driving moods, slow and organic for the calm ones, radial for the grand ones', () => {
    expect(row('driving').traitTempo).toBeGreaterThan(row('serene').traitTempo)
    for (const m of ['driving', 'aggressive', 'tense', 'euphoric', 'uplifting'] as const) {
      expect(row(m).traitTempo, `${m} tempo`).toBeGreaterThanOrEqual(0.7)
    }
    for (const m of ['driving', 'aggressive', 'tense'] as const) {
      expect(row(m).traitAngular, `${m} angular`).toBeGreaterThanOrEqual(0.8)
    }
    for (const m of ['serene', 'tender', 'dreamy', 'melancholic'] as const) {
      expect(row(m).traitTempo, `${m} tempo`).toBeLessThanOrEqual(0.25)
      expect(row(m).traitAngular, `${m} angular`).toBeLessThanOrEqual(0.25)
    }
    for (const m of ['mysterious', 'dreamy', 'epic', 'euphoric'] as const) {
      expect(row(m).traitRadial, `${m} radial`).toBeGreaterThanOrEqual(0.7)
    }
    for (const m of HARSH) expect(row(m).traitRadial, `${m} radial`).toBeLessThanOrEqual(0.25)
  })
})

/** Average ranks (ties share the mean rank), so the correlation is well defined on tied authored values. */
function ranks(xs: readonly number[]): number[] {
  const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0])
  const out = new Array<number>(xs.length).fill(0)
  for (let i = 0; i < order.length;) {
    let j = i
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++
    const mean = (i + j) / 2
    for (let k = i; k <= j; k++) out[order[k][1]] = mean
    i = j + 1
  }
  return out
}

function spearman(xs: readonly number[], ys: readonly number[]): number {
  const rx = ranks(xs)
  const ry = ranks(ys)
  const n = xs.length
  const mx = sum(rx) / n
  const my = sum(ry) / n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    sxy += (rx[i] - mx) * (ry[i] - my)
    sxx += (rx[i] - mx) ** 2
    syy += (ry[i] - my) ** 2
  }
  return sxy / Math.sqrt(sxx * syy)
}

describe('MOOD_ROWS: the rows follow the mood geometry (moodTaxonomy centres)', () => {
  const arousal = MOODS.map((m) => MOOD_PROTOTYPES[m].center.arousal)
  const valence = MOODS.map((m) => MOOD_PROTOTYPES[m].center.valence)
  const tension = MOODS.map((m) => MOOD_PROTOTYPES[m].center.tension)
  const col = (k: ScalarKey): number[] => MOODS.map((m) => row(m)[k])

  // Floors sit ~0.1 under the measured Spearman rho, so retuning has room but a reordered family fails.
  it('arousal drives the pace and force of the look', () => {
    const positive: [ScalarKey, number][] = [
      ['steerSpeed', 0.85],
      ['cameraSpeed', 0.8],
      ['traitTempo', 0.85],
      ['echoGate', 0.8],
      ['bloomReact', 0.85],
      ['bloomBase', 0.75],
      ['cameraShake', 0.7],
      ['lensEngage', 0.65],
      ['caBase', 0.65],
      ['gradeContrast', 0.6],
      // saturation also follows valence (tense and brooding are deliberately desaturated), so the floor is lower
      ['gradeSat', 0.55],
    ]
    for (const [k, floor] of positive) {
      expect(spearman(arousal, col(k)), `arousal ~ ${k}`).toBeGreaterThanOrEqual(floor)
    }
    // still, low-arousal moods are the hazy, long-trailed ones
    expect(spearman(arousal, col('trailsBase')), 'arousal ~ trailsBase').toBeLessThanOrEqual(-0.65)
    expect(spearman(arousal, col('fogBase')), 'arousal ~ fogBase').toBeLessThanOrEqual(-0.7)
  })

  it('valence and tension drive the dark, heavy-edged look', () => {
    expect(spearman(valence, col('vignette')), 'valence ~ vignette').toBeLessThanOrEqual(-0.6)
    expect(spearman(tension, col('vignette')), 'tension ~ vignette').toBeGreaterThanOrEqual(0.75)
    expect(spearman(valence, col('gradeSat')), 'valence ~ gradeSat').toBeGreaterThan(0.3)
  })
})

/**
 * LEGIBILITY. Two moods must not look alike. Each row becomes a normalised feature vector, grouped into the
 * eight families a viewer reads: scalars are scaled to 0..1 by their design range, weight vectors are
 * normalised to sum 1. The distance between two rows in a family is the mean over that family's components of
 * (|difference| for a scalar, total-variation distance for a weight vector), so 0 = identical, 1 = opposite
 * ends of the range on every component. A pair "differs" in a family when that distance reaches THRESHOLD.
 */
type Component = ScalarKey | ArrayKey
// prettier-ignore
const FAMILIES: Record<string, readonly Component[]> = {
  post: ['bloomBase', 'bloomReact', 'caBase', 'caReact', 'vignette', 'fogBase'],
  feedback: ['trailsBase', 'trailsZoom', 'trailsRotate', 'trailsSwirl', 'trailsWobble', 'echoGate'],
  lens: ['lensEngage', 'lensAmountFloor', 'lensAmountCeil', 'lensWeights'],
  mirror: ['mirrorEngage', 'mirrorMode', 'mirrorSegments', 'mirrorSpinMin', 'mirrorSpinMax', 'mirrorTwistMax', 'mirrorMix'],
  steer: ['steerSpeed', 'steerComplexity', 'steerDensity', 'steerFill', 'steerContrast'],
  camera: [
    'cameraWeights', 'cameraSpeed', 'cameraShake', 'cameraCutRate',
    'transitionWeights', 'transitionDurationBias', 'transitionSharpness',
  ],
  grade: ['gradeSat', 'gradeTemp', 'gradeContrast'],
  traits: ['traitTempo', 'traitAngular', 'traitBusy', 'traitRadial'],
}
const isArrayKey = (c: Component): c is ArrayKey => c in ROW_ARRAY_KEYS

function componentDistance(a: LookRow, b: LookRow, c: Component): number {
  if (isArrayKey(c)) {
    const pa = a[c]
    const pb = b[c]
    const sa = sum(pa)
    const sb = sum(pb)
    let l1 = 0
    for (let i = 0; i < pa.length; i++) l1 += Math.abs(pa[i] / sa - pb[i] / sb)
    return l1 / 2
  }
  const [lo, hi] = RANGES[c]
  return Math.abs(a[c] - b[c]) / (hi - lo)
}

function familyDistances(a: LookRow, b: LookRow): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [name, comps] of Object.entries(FAMILIES)) {
    out[name] = sum(comps.map((c) => componentDistance(a, b, c))) / comps.length
  }
  return out
}

/**
 * A family "differs" at >= 0.10: on average the two moods sit a tenth of the design range apart across that
 * family's dials, roughly where two settings stop reading as the same look. Chosen from the measured table
 * (91 pairs x 8 families): the tightest pair (serene vs melancholic, two calm moods) has its 4th-largest
 * family distance at 0.124, the median pair at 0.284, and 95% of all pair-family cells clear 0.10. So 0.10
 * leaves the tightest pair ~20% of headroom for retuning by eye, yet fails as soon as a mood drifts to within
 * a tenth of another on more than four families. Four of eight is deliberate: neighbours in mood space
 * (serene / tender, groove / uplifting) legitimately share their steer, traits or camera.
 */
const THRESHOLD = 0.1
const MIN_FAMILIES = 4

describe('MOOD_ROWS: legibility (no two moods look alike)', () => {
  const pairs: [CharacterMood, CharacterMood][] = []
  for (let i = 0; i < MOODS.length; i++)
    for (let j = i + 1; j < MOODS.length; j++) pairs.push([MOODS[i], MOODS[j]])

  it('the families cover every visible field of the row', () => {
    const covered = new Set<Component>(Object.values(FAMILIES).flat())
    // busyGain, traitStrength and the fx propensities are gains / rare events, not continuously visible looks
    const skipped: Component[] = [
      'mirrorBusyGain',
      'traitStrength',
      'fxShock',
      'fxFlare',
      'fxSpark',
      'fxStrobe',
    ]
    for (const k of [...ROW_SCALAR_KEYS, ...ARRAY_KEYS]) {
      expect(
        covered.has(k) || skipped.includes(k),
        `${k} belongs to a family or is deliberately skipped`,
      ).toBe(true)
    }
  })

  it(`every pair of the 14 moods differs by >= ${THRESHOLD} in at least ${MIN_FAMILIES} of ${Object.keys(FAMILIES).length} families`, () => {
    expect(pairs).toHaveLength(91)
    const failures: string[] = []
    for (const [a, b] of pairs) {
      const d = familyDistances(row(a), row(b))
      const differing = Object.entries(d).filter(([, v]) => v >= THRESHOLD)
      if (differing.length < MIN_FAMILIES) {
        failures.push(
          `${a} vs ${b}: ${differing.length} (${Object.entries(d)
            .map(([k, v]) => `${k} ${v.toFixed(3)}`)
            .join(', ')})`,
        )
      }
    }
    expect(failures).toEqual([])
  })

  it('every pair also has a signature family: one family that differs by >= 0.15', () => {
    for (const [a, b] of pairs) {
      const best = Math.max(...Object.values(familyDistances(row(a), row(b))))
      expect(best, `${a} vs ${b}`).toBeGreaterThanOrEqual(0.15)
    }
  })

  it('the table is bold overall: the median pair differs by >= 0.2 in four families, 90% by >= 0.15', () => {
    const fourth = pairs
      .map(
        ([a, b]) =>
          Object.values(familyDistances(row(a), row(b))).sort((x, y) => y - x)[MIN_FAMILIES - 1],
      )
      .sort((x, y) => x - y)
    expect(fourth[Math.floor(0.5 * (fourth.length - 1))]).toBeGreaterThanOrEqual(0.2)
    expect(fourth[Math.floor(0.1 * (fourth.length - 1))]).toBeGreaterThanOrEqual(0.15)
  })

  it('the distance is a metric on rows (0 to itself, symmetric), so the test cannot pass vacuously', () => {
    const a = row('serene')
    const b = row('aggressive')
    for (const v of Object.values(familyDistances(a, a))) expect(v).toBe(0)
    const ab = familyDistances(a, b)
    const ba = familyDistances(b, a)
    for (const k of Object.keys(ab)) expect(ab[k]).toBeCloseTo(ba[k], 12)
    // the two most different moods differ strongly in every family that matters
    expect(Object.values(ab).filter((v) => v >= 0.25).length).toBeGreaterThanOrEqual(6)
  })

  it('negative control: a near-twin of a mood (a few dials nudged) is flagged as too alike', () => {
    const twin: LookRow = {
      ...row('tender'),
      bloomBase: 0.5,
      echoGate: 0.2,
      gradeTemp: 0.35,
      steerSpeed: 0.4,
      cameraSpeed: 0.75,
    }
    const d = familyDistances(row('tender'), twin)
    expect(Object.values(d).filter((v) => v >= THRESHOLD).length).toBeLessThan(MIN_FAMILIES)
  })
})
