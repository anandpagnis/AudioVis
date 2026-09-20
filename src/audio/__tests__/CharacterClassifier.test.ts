import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CHARACTER_PRIORS } from '../characterPriors'
import {
  CharacterClassifier,
  computeInstantDist,
  FIRST_COMMIT_SEC,
  PRIORS,
} from '../CharacterClassifier'
import { CHARACTER_MOODS, type CharacterInput, type CharacterMood } from '../characterTypes'
import { LEGACY_MAP, MOOD_PROTOTYPES } from '../moodTaxonomy'

// The shipped priors are balanced on real audio; these tests probe the geometry of the prototypes
// themselves, so they run with a FLAT prior and restore the shipped one afterwards.
let shippedPriors: number[] = []
beforeAll(() => {
  shippedPriors = [...PRIORS]
  PRIORS.fill(0)
})
afterAll(() => {
  shippedPriors.forEach((p, i) => (PRIORS[i] = p))
})

// --- helpers ---------------------------------------------------------------

/** Deterministic PRNG so the coverage numbers are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gaussian(rand: () => number): number {
  const u = Math.max(1e-12, rand())
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x))

function centreInput(mood: CharacterMood): CharacterInput {
  const c = MOOD_PROTOTYPES[mood].center
  return { ...c, valid: true }
}

function argmaxOf(dist: ArrayLike<number>): number {
  let best = 0
  for (let i = 1; i < dist.length; i++) if (dist[i] > dist[best]) best = i
  return best
}

interface RunResult {
  now: number
  changes: number
  lastChangeAt: number
  primaries: (CharacterMood | null)[]
}

/** Feeds `input` (optionally jittered) for `seconds` at a fixed dt. */
function feed(
  cls: CharacterClassifier,
  input: CharacterInput,
  seconds: number,
  startAt: number,
  opts: { dt?: number; jitter?: number; rand?: () => number } = {},
): RunResult {
  const dt = opts.dt ?? 1 / 30
  const jitter = opts.jitter ?? 0
  const rand = opts.rand ?? mulberry32(1)
  const scratch: CharacterInput = { ...input }
  const res: RunResult = { now: startAt, changes: 0, lastChangeAt: -1, primaries: [] }
  const steps = Math.round(seconds / dt)
  for (let i = 0; i < steps; i++) {
    res.now = startAt + (i + 1) * dt
    if (jitter > 0) {
      scratch.valence = clamp01(input.valence + gaussian(rand) * jitter)
      scratch.arousal = clamp01(input.arousal + gaussian(rand) * jitter)
      scratch.tension = clamp01(input.tension + gaussian(rand) * jitter)
      scratch.pulse = clamp01(input.pulse + gaussian(rand) * jitter)
    }
    const s = cls.update(jitter > 0 ? scratch : input, res.now)
    if (s.changed) {
      res.changes++
      res.lastChangeAt = res.now
    }
    res.primaries.push(s.primary)
  }
  return res
}

// --- taxonomy --------------------------------------------------------------

describe('moodTaxonomy', () => {
  it('has a well-formed prototype for every mood', () => {
    for (const m of CHARACTER_MOODS) {
      const p = MOOD_PROTOTYPES[m]
      for (const v of Object.values(p.center)) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
      for (const v of Object.values(p.spread)) expect(v).toBeGreaterThan(0.05)
      expect(p.label.length).toBeGreaterThan(0)
      expect(p.blurb.length).toBeGreaterThan(20)
      expect(['ambient', 'mellow', 'groove', 'building', 'peak', 'aggressive']).toContain(p.legacy)
      expect(LEGACY_MAP[m]).toBe(p.legacy)
    }
  })

  it('keeps centres distinct: close in (V,A,T) only when pulse separates them', () => {
    for (let i = 0; i < CHARACTER_MOODS.length; i++) {
      for (let j = i + 1; j < CHARACTER_MOODS.length; j++) {
        const a = MOOD_PROTOTYPES[CHARACTER_MOODS[i]].center
        const b = MOOD_PROTOTYPES[CHARACTER_MOODS[j]].center
        const d = Math.hypot(a.valence - b.valence, a.arousal - b.arousal, a.tension - b.tension)
        const dp = Math.abs(a.pulse - b.pulse)
        const label = `${CHARACTER_MOODS[i]}/${CHARACTER_MOODS[j]}`
        expect(d, label).toBeGreaterThanOrEqual(0.17)
        if (d < 0.25) expect(dp, label).toBeGreaterThanOrEqual(0.19)
      }
    }
  })
})

// --- instantaneous likelihood ---------------------------------------------

describe('CharacterClassifier instantaneous distribution', () => {
  it('classifies every prototype centre as itself', () => {
    const out = new Float64Array(CHARACTER_MOODS.length)
    for (let i = 0; i < CHARACTER_MOODS.length; i++) {
      computeInstantDist(MOOD_PROTOTYPES[CHARACTER_MOODS[i]].center, out)
      expect(CHARACTER_MOODS[argmaxOf(out)]).toBe(CHARACTER_MOODS[i])
    }
  })

  it('gives every mood a 2-15 % share of a uniform sweep of the cube', () => {
    const rand = mulberry32(20260920)
    const out = new Float64Array(CHARACTER_MOODS.length)
    const wins = new Array<number>(CHARACTER_MOODS.length).fill(0)
    const n = 5000
    for (let k = 0; k < n; k++) {
      computeInstantDist(
        { valence: rand(), arousal: rand(), tension: rand(), pulse: rand() },
        out,
      )
      wins[argmaxOf(out)]++
    }
    const shares: Record<string, string> = {}
    CHARACTER_MOODS.forEach((m, i) => {
      shares[m] = `${((100 * wins[i]) / n).toFixed(1)}%`
    })
    // Kept in the failure message so a regression shows the whole split.
    const msg = JSON.stringify(shares)
    CHARACTER_MOODS.forEach((m, i) => {
      expect(wins[i] / n, `${m} in ${msg}`).toBeGreaterThanOrEqual(0.02)
      expect(wins[i] / n, `${m} in ${msg}`).toBeLessThanOrEqual(0.15)
    })
  })

  it('shipped priors are finite and bounded, and match the generated file', () => {
    expect(shippedPriors).toHaveLength(CHARACTER_MOODS.length)
    shippedPriors.forEach((p, i) => {
      expect(Number.isFinite(p)).toBe(true)
      expect(Math.abs(p)).toBeLessThanOrEqual(3)
      expect(p).toBe(CHARACTER_PRIORS[i] ?? 0)
    })
  })

  it('priors bias the argmax when set (tests run with a flat prior)', () => {
    expect(PRIORS.every((p) => p === 0)).toBe(true)
    const out = new Float64Array(CHARACTER_MOODS.length)
    // A point midway between serene and dreamy; a big prior decides it.
    const a = MOOD_PROTOTYPES.serene.center
    const b = MOOD_PROTOTYPES.dreamy.center
    const mid = {
      valence: (a.valence + b.valence) / 2,
      arousal: (a.arousal + b.arousal) / 2,
      tension: (a.tension + b.tension) / 2,
      pulse: (a.pulse + b.pulse) / 2,
    }
    const iSerene = CHARACTER_MOODS.indexOf('serene')
    const iDreamy = CHARACTER_MOODS.indexOf('dreamy')
    try {
      PRIORS[iSerene] = 5
      computeInstantDist(mid, out)
      expect(argmaxOf(out)).toBe(iSerene)
      PRIORS[iSerene] = 0
      PRIORS[iDreamy] = 5
      computeInstantDist(mid, out)
      expect(argmaxOf(out)).toBe(iDreamy)
    } finally {
      PRIORS[iSerene] = 0
      PRIORS[iDreamy] = 0
    }
  })

  it('low valence confidence lets arousal and tension decide', () => {
    // Aggressive arousal/tension but a (wrongly) bright valence.
    const p = { valence: 0.85, arousal: 0.92, tension: 0.75, pulse: 0.65 }
    const out = new Float64Array(CHARACTER_MOODS.length)
    computeInstantDist({ ...p, valenceConfidence: 1 }, out)
    expect(CHARACTER_MOODS[argmaxOf(out)]).not.toBe('aggressive')
    computeInstantDist({ ...p, valenceConfidence: 0.25 }, out)
    expect(CHARACTER_MOODS[argmaxOf(out)]).toBe('aggressive')
  })
})

// --- stateful behaviour ----------------------------------------------------

describe('CharacterClassifier state machine', () => {
  it('returns the same state object every time (no per-frame allocation)', () => {
    const cls = new CharacterClassifier()
    const first = cls.update(centreInput('groove'), 0)
    const second = cls.update(centreInput('groove'), 0.033)
    const third = cls.update({ ...centreInput('groove'), valid: false }, 0.066)
    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(cls.state).toBe(first)
    const dist = first.dist
    cls.update(centreInput('serene'), 0.1)
    expect(cls.state.dist).toBe(dist)
  })

  it('starts null, commits the first primary after ~2 s, and reports changed once', () => {
    const cls = new CharacterClassifier()
    const early = feed(cls, centreInput('melancholic'), FIRST_COMMIT_SEC - 0.3, 0)
    expect(early.primaries.every((p) => p === null)).toBe(true)
    const later = feed(cls, centreInput('melancholic'), 1, early.now)
    expect(cls.state.primary).toBe('melancholic')
    expect(later.changes).toBe(1)
    const after = feed(cls, centreInput('melancholic'), 10, later.now)
    expect(after.changes).toBe(0)
    expect(cls.state.heldFor).toBeGreaterThan(9)
  })

  it('dist sums to 1 and is non-negative whenever the read is valid', () => {
    const cls = new CharacterClassifier()
    const rand = mulberry32(7)
    for (let i = 0; i < 2000; i++) {
      const s = cls.update(
        {
          valence: rand(),
          arousal: rand(),
          tension: rand(),
          pulse: rand(),
          valenceConfidence: rand(),
          valid: true,
        },
        i * 0.05,
      )
      let sum = 0
      for (const m of CHARACTER_MOODS) {
        expect(s.dist[m]).toBeGreaterThanOrEqual(0)
        sum += s.dist[m]
      }
      expect(sum).toBeCloseTo(1, 9)
      expect(s.valid).toBe(true)
      expect(s.confidence).toBeGreaterThanOrEqual(0)
      expect(s.confidence).toBeLessThanOrEqual(1)
      expect(s.entropy).toBeGreaterThanOrEqual(0)
      expect(s.entropy).toBeLessThanOrEqual(1)
      expect(s.secondaryWeight).toBeGreaterThanOrEqual(0)
      expect(s.secondaryWeight).toBeLessThanOrEqual(0.5)
    }
  })

  it('never changes primary under small jitter around any centre for 60 s', () => {
    for (const m of CHARACTER_MOODS) {
      const cls = new CharacterClassifier()
      const rand = mulberry32(99)
      const r = feed(cls, centreInput(m), 60, 0, { jitter: 0.03, rand })
      expect(cls.state.primary, m).toBe(m)
      expect(r.changes, m).toBe(1) // only the initial commit
    }
  })

  it('commits a step change to another mood within ~10 s, changed firing once', () => {
    const pairs: [CharacterMood, CharacterMood][] = [
      ['serene', 'aggressive'],
      ['melancholic', 'euphoric'],
      ['groove', 'brooding'],
      ['driving', 'dreamy'],
      ['tense', 'playful'],
      ['epic', 'tender'],
      ['mysterious', 'uplifting'],
      ['aggressive', 'serene'],
      ['euphoric', 'melancholic'],
    ]
    for (const [from, to] of pairs) {
      const cls = new CharacterClassifier()
      const rand = mulberry32(5)
      const warm = feed(cls, centreInput(from), 15, 0, { jitter: 0.02, rand })
      expect(cls.state.primary, `${from} warm-up`).toBe(from)
      expect(warm.changes).toBe(1)
      const step = feed(cls, centreInput(to), 12, warm.now, { jitter: 0.02, rand })
      expect(step.changes, `${from}->${to} changes`).toBe(1)
      expect(cls.state.primary, `${from}->${to}`).toBe(to)
      expect(step.lastChangeAt - warm.now, `${from}->${to} latency`).toBeLessThanOrEqual(11)
      // ...and it is not instant: a brief blip must not move the primary.
      expect(step.lastChangeAt - warm.now).toBeGreaterThan(4)
    }
  })

  it('ignores a 3 s blip of another mood', () => {
    const cls = new CharacterClassifier()
    const warm = feed(cls, centreInput('groove'), 15, 0)
    const blip = feed(cls, centreInput('aggressive'), 3, warm.now)
    const back = feed(cls, centreInput('groove'), 15, blip.now)
    expect(blip.changes + back.changes).toBe(0)
    expect(cls.state.primary).toBe('groove')
  })

  it('keeps the primary through invalid reads (confidence 0, dist zeros)', () => {
    const cls = new CharacterClassifier()
    const warm = feed(cls, centreInput('tender'), 6, 0)
    expect(cls.state.primary).toBe('tender')
    const gap = feed(cls, { ...centreInput('aggressive'), valid: false }, 8, warm.now)
    expect(gap.changes).toBe(0)
    const s = cls.state
    expect(s.valid).toBe(false)
    expect(s.primary).toBe('tender')
    expect(s.confidence).toBe(0)
    expect(s.secondary).toBeNull()
    expect(s.secondaryWeight).toBe(0)
    for (const m of CHARACTER_MOODS) expect(s.dist[m]).toBe(0)
    // Recovery: valid again, same mood, no spurious change.
    const back = feed(cls, centreInput('tender'), 3, gap.now)
    expect(back.changes).toBe(0)
    expect(cls.state.valid).toBe(true)
    expect(cls.state.primary).toBe('tender')
  })

  it('stays null (and quiet) if it only ever sees invalid input', () => {
    const cls = new CharacterClassifier()
    const r = feed(cls, { ...centreInput('groove'), valid: false }, 10, 0)
    expect(r.changes).toBe(0)
    expect(cls.state.primary).toBeNull()
    expect(cls.state.valid).toBe(false)
  })

  it('is safe for NaN / Infinity in every field and in `now`', () => {
    const bad = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e300, -5, 7]
    const fields = ['valence', 'arousal', 'tension', 'pulse', 'valenceConfidence'] as const
    const cls = new CharacterClassifier()
    feed(cls, centreInput('groove'), 3, 0)
    let now = 3
    const assertFinite = (): void => {
      const s = cls.state
      for (const v of [
        s.valence,
        s.arousal,
        s.tension,
        s.pulse,
        s.secondaryWeight,
        s.confidence,
        s.entropy,
        s.heldFor,
      ]) {
        expect(Number.isFinite(v)).toBe(true)
      }
      for (const m of CHARACTER_MOODS) expect(Number.isFinite(s.dist[m])).toBe(true)
      if (s.valid) {
        let sum = 0
        for (const m of CHARACTER_MOODS) sum += s.dist[m]
        expect(sum).toBeCloseTo(1, 9)
      }
    }
    for (const f of fields) {
      for (const b of bad) {
        const input: CharacterInput = { ...centreInput('brooding') }
        ;(input as unknown as Record<string, number>)[f] = b
        now += 0.05
        cls.update(input, now)
        assertFinite()
      }
    }
    for (const b of bad) {
      cls.update(centreInput('groove'), b)
      assertFinite()
    }
    // Everything bad at once, and on the very first call of a fresh instance.
    const allBad: CharacterInput = {
      valence: Number.NaN,
      arousal: Number.POSITIVE_INFINITY,
      tension: Number.NEGATIVE_INFINITY,
      pulse: Number.NaN,
      valenceConfidence: Number.NaN,
      valid: true,
    }
    const fresh = new CharacterClassifier()
    fresh.update(allBad, Number.NaN)
    for (const m of CHARACTER_MOODS) expect(Number.isFinite(fresh.state.dist[m])).toBe(true)
    for (let i = 0; i < 200; i++) fresh.update(allBad, i * 0.1)
    expect(fresh.state.primary).not.toBeUndefined()
    expect(Number.isFinite(fresh.state.confidence)).toBe(true)
    const out = new Float64Array(CHARACTER_MOODS.length)
    computeInstantDist(allBad, out)
    for (const v of out) expect(Number.isFinite(v)).toBe(true)
  })

  it('handles irregular dt, a huge first timestamp, repeated and reversed time', () => {
    const cls = new CharacterClassifier()
    const rand = mulberry32(3)
    let now = 1e6
    for (let i = 0; i < 600; i++) {
      now += rand() < 0.1 ? 0 : rand() < 0.05 ? -0.5 : rand() * 0.2
      const s = cls.update(centreInput('euphoric'), now)
      expect(Number.isFinite(s.confidence)).toBe(true)
    }
    expect(cls.state.primary).toBe('euphoric')
    // A long stall must not fast-forward a switch: 60 s gap then one frame.
    cls.update(centreInput('serene'), now + 60)
    expect(cls.state.primary).toBe('euphoric')
    expect(cls.state.changed).toBe(false)
  })

  it('reports a secondary for a blend and none for a clean centre; weight is capped at 0.5', () => {
    const a = MOOD_PROTOTYPES.uplifting.center
    const b = MOOD_PROTOTYPES.euphoric.center
    const mid: CharacterInput = {
      valence: (a.valence + b.valence) / 2,
      arousal: (a.arousal + b.arousal) / 2,
      tension: (a.tension + b.tension) / 2,
      pulse: (a.pulse + b.pulse) / 2,
      valid: true,
    }
    const blend = new CharacterClassifier()
    feed(blend, centreInput('uplifting'), 12, 0)
    feed(blend, mid, 12, 12)
    const sb = blend.state
    expect(sb.secondary).not.toBeNull()
    expect(sb.secondaryWeight).toBeGreaterThan(0)
    expect(sb.secondaryWeight).toBeLessThanOrEqual(0.5)
    expect(sb.confidence).toBeLessThan(0.6)

    const clean = new CharacterClassifier()
    feed(clean, centreInput('driving'), 12, 0)
    expect(clean.state.primary).toBe('driving')
    expect(clean.state.confidence).toBeGreaterThan(sb.confidence)
  })

  it('reset() forgets everything', () => {
    const cls = new CharacterClassifier()
    feed(cls, centreInput('tense'), 10, 0)
    expect(cls.state.primary).toBe('tense')
    cls.reset()
    expect(cls.state.primary).toBeNull()
    expect(cls.state.valid).toBe(false)
    expect(cls.state.changed).toBe(false)
    const r = feed(cls, centreInput('serene'), 4, 0)
    expect(cls.state.primary).toBe('serene')
    expect(r.changes).toBe(1)
  })
})
