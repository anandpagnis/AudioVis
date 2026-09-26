import { describe, expect, it } from 'vitest'
import { LEGACY } from '../../../audio/events/legacyEvents'
import type { EventType, SectionEvent } from '../../../audio/events/types'
import {
  ackCut,
  createShowState,
  pickMicro,
  pressureAt,
  resetShow,
  step,
  type ShowAction,
  type ShowInput,
  type ShowState,
} from '../showDirector'
import { SHOW, ageThreshold, barsBetween, dropCredibility, effectiveThreshold, eventScore } from '../showPolicy'

/** 120 BPM: a beat is 0.5 s, a bar 2 s. Scenes start at beat 0 / time 0 unless a case says otherwise. */
let nextId = 1
function ev(over: Partial<SectionEvent> & { S?: number } = {}): SectionEvent {
  const { S, ...rest } = over
  const type: EventType = rest.type ?? 'change'
  // `S` is a shortcut: strength = S / weight, confidence 1.
  const w = SHOW.typeWeight[type]
  return {
    id: nextId++,
    type,
    strength: S !== undefined && w > 0 ? S / w : 1,
    confidence: 1,
    boundaryBeat: 0,
    boundaryTime: 0,
    detectedAtBeat: 0,
    detectedAtTime: 0,
    source: 'legacy',
    phase: 0,
    feats: { level: 0, low: 0, timbre: 0, harmony: 0, rhythm: 0 },
    ...rest,
  }
}

const BPM = 120
/** A frame `bars` bars into the scene that started at beat 0 (120 BPM). */
function at(bars: number, over: Partial<ShowInput> = {}): ShowInput {
  return {
    beat: Math.round(bars * 4),
    time: bars * 2,
    bpm: BPM,
    sceneStartBeat: 0,
    sceneStartTime: 0,
    event: null,
    barLine: false,
    inBreakdown: false,
    inBuild: false,
    moodChanged: false,
    characterShift: false,
    moodPredicted: false,
    trendRising: false,
    ...over,
  }
}

/** Snapshot of the reused action (the director returns ONE object that the next step overwrites). */
interface Snap {
  kind: ShowAction['kind']
  reason: string
  S: number
  T: number
  age: number
  pressure: number
  credibility: number
  micro: ShowAction['micro']
  immediate: boolean
  forced: boolean
  evaluated: boolean
}
function run(st: ShowState, i: ShowInput): Snap {
  const a = step(st, i)
  return {
    kind: a.kind,
    reason: a.reason,
    S: a.S,
    T: a.T,
    age: a.age,
    pressure: a.pressure,
    credibility: a.credibility,
    micro: a.micro,
    immediate: a.immediate,
    forced: a.forced,
    evaluated: a.evaluated,
  }
}
const fresh = () => createShowState()

describe('showPolicy formulas', () => {
  it('S = strength * typeWeight * confidence, with the plan weights', () => {
    expect(eventScore('drop', 1, 1)).toBeCloseTo(1.25)
    expect(eventScore('change', 0.8, 0.5)).toBeCloseTo(0.4)
    expect(eventScore('breakdown', 1, 1)).toBeCloseTo(0.9)
    for (const t of ['fill', 'gain', 'buildStart'] as const) expect(eventScore(t, 1, 1)).toBe(0)
    expect(eventScore('change', NaN, 1)).toBe(0)
    expect(eventScore('change', 5, 5)).toBeCloseTo(1) // factors are clamped to 0..1
  })

  it('the v2 gain scales ONLY live change / breakdown events: legacy events, drops and the weight-0 types are untouched', () => {
    expect(SHOW.liveGain).toBeGreaterThan(1) // tuned in lane W3 (director-vs-silver.md)
    const g = SHOW.liveGain
    expect(eventScore('change', 0.6, 0.7, 'live')).toBeCloseTo(0.42 * g)
    expect(eventScore('breakdown', 0.6, 0.7, 'live')).toBeCloseTo(0.6 * 0.9 * 0.7 * g)
    // no source, or a legacy / plan source: the plain score
    expect(eventScore('change', 0.6, 0.7)).toBeCloseTo(0.42)
    expect(eventScore('change', 0.6, 0.7, 'legacy')).toBeCloseTo(0.42)
    expect(eventScore('change', 0.6, 0.7, 'plan')).toBeCloseTo(0.42)
    // drops keep their own weighting even from the live layer; fills / gains / build starts stay 0
    expect(eventScore('drop', 1, 0.5, 'live')).toBeCloseTo(0.625)
    for (const t of ['fill', 'gain', 'buildStart'] as const) expect(eventScore(t, 1, 1, 'live')).toBe(0)
  })

  it('a live change of typical size (strength 0.6, confidence 0.7) cuts a 9-bar-old scene that the same legacy-source event only tweaks', () => {
    // 9 bars into the scene (120 BPM): T(9) = 0.525; S = 0.42 for a legacy-source event, 0.42 * liveGain for a live one
    const kindOf = (source: SectionEvent['source']): string => run(fresh(), at(9, { event: ev({ strength: 0.6, confidence: 0.7, source }) })).kind
    expect(kindOf('legacy')).toBe('MICRO')
    expect(kindOf('live')).toBe('CUT')
  })

  it('T(a) = 0.30 + 0.60 * clamp((12 - a) / 8, 0, 1): 0.90 at 4 bars, falling to 0.30 at 12 (tuned on the real tracks)', () => {
    expect(ageThreshold(4)).toBeCloseTo(0.9)
    expect(ageThreshold(8)).toBeCloseTo(0.6)
    expect(ageThreshold(10)).toBeCloseTo(0.45)
    expect(ageThreshold(12)).toBeCloseTo(0.3)
    expect(ageThreshold(40)).toBeCloseTo(0.3)
    expect(ageThreshold(0)).toBeCloseTo(0.9) // clamped: never above the 4-bar value
    let prev = Infinity
    for (let a = 0; a <= 20; a += 0.5) {
      const t = ageThreshold(a)
      expect(t).toBeLessThanOrEqual(prev + 1e-12)
      prev = t
    }
  })

  it('pressure lowers the threshold by at most 0.15', () => {
    expect(effectiveThreshold(8, 0)).toBeCloseTo(ageThreshold(8))
    expect(effectiveThreshold(8, 1)).toBeCloseTo(ageThreshold(8) - 0.15)
    expect(effectiveThreshold(8, 5)).toBeCloseTo(ageThreshold(8) - 0.15) // P is clamped to 1
    expect(effectiveThreshold(8, NaN)).toBeCloseTo(ageThreshold(8))
  })

  it('bars <-> seconds: bars from beats, clamped to a bar of 1.5..3 s; -Infinity means "never"', () => {
    expect(barsBetween(0, 0, 32, 16)).toBeCloseTo(8) // 120 BPM
    expect(barsBetween(0, 0, 12, 12)).toBeCloseTo(4) // 60 BPM: 3 bars of beats, but 12 s / 3 s = 4
    expect(barsBetween(0, 0, 16, 5.65)).toBeCloseTo(5.65 / 1.5) // 170 BPM: 4 bars of beats in 5.65 s, clamped down
    expect(barsBetween(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, 10, 5)).toBe(Infinity)
    expect(barsBetween(50, 25, 10, 5)).toBe(0) // clocks restarted
  })
})

describe('showDirector.step: the age-decaying threshold', () => {
  it('holds a marginal event young and cuts on it once the threshold has fallen', () => {
    // S = 0.6: above T(a) only from a = 12 - 8 * (0.6 - 0.3) / 0.6 = 8 bars.
    const young = run(fresh(), at(6, { event: ev({ S: 0.6 }) }))
    expect(young.kind).toBe('MICRO')
    expect(young.reason).toBe('below-T')
    expect(young.T).toBeCloseTo(ageThreshold(6))
    const old = run(fresh(), at(12, { event: ev({ S: 0.6 }) }))
    expect(old.kind).toBe('CUT')
    expect(old.reason).toBe('event')
    expect(old.immediate).toBe(false)
  })

  it('a weaker event needs a longer scene: the age at which each S first cuts is monotone in S', () => {
    const firstCutAge = (S: number) => {
      for (let a = 4; a <= 30; a += 0.25) {
        const r = run(fresh(), at(a, { event: ev({ S }) }))
        if (r.kind === 'CUT' && !r.forced) return a
      }
      return Infinity
    }
    const ages = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.36].map(firstCutAge)
    for (let k = 1; k < ages.length; k++) expect(ages[k]).toBeGreaterThanOrEqual(ages[k - 1])
    expect(ages[0]).toBeCloseTo(4, 1)
    expect(firstCutAge(0.29)).toBe(Infinity) // below the floor T = 0.30: never a cut on its own
  })

  it('a strong, real change is cut on at the first allowed moment', () => {
    const r = run(fresh(), at(4, { event: ev({ S: 0.95 }) }))
    expect(r.kind).toBe('CUT')
  })
})

describe('showDirector.step: minimum age', () => {
  it('never cuts a normal event before 4 bars, however strong: it becomes a MICRO', () => {
    for (const bars of [0.5, 1, 2, 3, 3.75]) {
      const r = run(fresh(), at(bars, { event: ev({ S: 1 }) }))
      expect(r.kind, `age ${bars}`).toBe('MICRO')
      expect(r.reason).toBe('min-age')
    }
    expect(run(fresh(), at(4, { event: ev({ S: 1 }) })).kind).toBe('CUT')
  })
})

describe('showDirector.step: drops', () => {
  it('a strong drop (S >= 1.0) cuts from 2 bars, immediately (a hard cut)', () => {
    const r = run(fresh(), at(2, { event: ev({ type: 'drop', strength: 1, confidence: 0.9 }) })) // S = 1.125
    expect(r.kind).toBe('CUT')
    expect(r.reason).toBe('drop-fast')
    expect(r.immediate).toBe(true)
    expect(r.S).toBeCloseTo(1.125)
    expect(run(fresh(), at(3, { event: ev({ type: 'drop', strength: 1, confidence: 0.9 }) })).kind).toBe('CUT')
  })

  it('a drop under S = 1.0 does not take the fast lane: it is held to the normal minimum age, then the threshold', () => {
    const lone = ev({ type: 'drop', strength: 1, confidence: 0.7 }) // S = 0.875
    expect(run(fresh(), at(3, { event: lone })).kind).toBe('MICRO')
    const later = run(fresh(), at(6, { event: ev({ type: 'drop', strength: 1, confidence: 0.7 }) }))
    expect(later.kind).toBe('CUT') // S 0.875 >= T(6) = 0.75
    // Changed with the false-drop lane: only the FAST lane is a hard cut. Any other drop that clears the threshold
    // waits for the bar line like an ordinary change (a false drop mid-bar must not cut mid-bar).
    expect(later.immediate).toBe(false)
  })

  it('a drop younger than 2 bars with no build behind it and no second signal downgrades to a MICRO', () => {
    const r = run(fresh(), at(1, { event: ev({ type: 'drop', strength: 1, confidence: 0.9 }) }))
    expect(r.kind).toBe('MICRO')
    expect(r.reason).toBe('drop-gated')
    expect(r.immediate).toBe(false)
  })

  it('a young drop with a build behind it (running, or a buildStart a few bars ago) or corroborated is not gated - but still no cut before 2 bars', () => {
    const drop = () => ev({ type: 'drop', strength: 1, confidence: 0.9 })
    const building = run(fresh(), at(1, { inBuild: true, event: drop() }))
    expect(building.kind).toBe('MICRO')
    expect(building.reason).toBe('min-age') // not 'drop-gated'
    const st = fresh()
    step(st, at(0.5, { event: ev({ type: 'buildStart', strength: 0.6, confidence: 0.8 }) }))
    expect(run(st, at(1, { event: drop() })).reason).toBe('min-age')
    expect(run(fresh(), at(1, { event: ev({ ...drop(), corroborated: true }) })).reason).toBe('min-age')
    // A change event within 2 beats before the drop corroborates it too.
    const c = fresh()
    step(c, at(1, { event: ev({ S: 0.1 }) })) // (weak: a HOLD, so no MICRO cooldown gets in the way)
    expect(run(c, { ...at(1, { event: drop() }), beat: 5, time: 2.5 }).reason).toBe('min-age')
  })

  it('a merged, re-delivered drop (same id, now corroborated and stronger) upgrades a MICRO to a CUT', () => {
    const st = fresh()
    const first = ev({ type: 'drop', strength: 1, confidence: 0.7 }) // S = 0.875: below the fast lane at 3 bars
    expect(run(st, at(3, { event: first })).kind).toBe('MICRO')
    const merged = { ...first, confidence: 0.8, corroborated: true } // S = 1.0
    const r = run(st, { ...at(3, { event: merged }), beat: 13, time: 6.5 })
    expect(r.kind).toBe('CUT')
    expect(r.reason).toBe('drop-fast')
  })
})

describe('showDirector.step: a lone drop (no build, no breakdown, no second signal)', () => {
  const lone = (over: Partial<SectionEvent> = {}) => ev({ type: 'drop', strength: 1, confidence: LEGACY.dropConfidence, ...over }) // S = 0.4375

  it('scores below the age threshold for a long while: a MICRO, however young the scene, until ~10 bars', () => {
    for (const bars of [2, 3, 4, 6, 8, 10]) {
      const r = run(fresh(), at(bars, { event: lone() }))
      expect(r.S, `age ${bars}`).toBeCloseTo(1.25 * LEGACY.dropConfidence)
      expect(r.kind, `age ${bars}`).toBe('MICRO')
      expect(r.immediate).toBe(false)
    }
    expect(run(fresh(), at(10, { event: lone() })).S).toBeLessThan(ageThreshold(10)) // T(10) = 0.45
  })

  it('contributes to a CUT only once the scene is genuinely old, and then on the bar line, not as a hard cut', () => {
    // S = 0.4375 = T(a) at a = 12 - 8 * (0.4375 - 0.3) / 0.6 = 10.2 bars.
    const old = run(fresh(), at(10.5, { event: lone() }))
    expect(old.kind).toBe('CUT')
    expect(old.reason).toBe('event')
    expect(old.immediate).toBe(false)
    expect(old.forced).toBe(false)
  })

  it('never takes the fast lane, whatever the age: only a release (build / breakdown) or a strong source does', () => {
    for (const bars of [2, 5, 9, 20]) {
      const r = run(fresh(), at(bars, { event: lone() }))
      expect(r.reason, `age ${bars}`).not.toBe('drop-fast')
    }
  })

  it('a second signal (corroborated, +0.1 confidence) lets it cut ~2 bars earlier, still not as a hard cut', () => {
    const corr = () => lone({ confidence: LEGACY.dropConfidence + LEGACY.corroborationBonus, corroborated: true }) // S = 0.5625
    expect(run(fresh(), at(8, { event: corr() })).kind).toBe('MICRO') // T(8) = 0.60
    const r = run(fresh(), at(9, { event: corr() })) // T(9) = 0.525
    expect(r.kind).toBe('CUT')
    expect(r.immediate).toBe(false)
  })
})

describe("showDirector.step: drop credibility (rarity weighting by the detector's own firing rate)", () => {
  const drop = (over: Partial<SectionEvent> = {}) => ev({ type: 'drop', strength: 1, confidence: LEGACY.dropConfidence, ...over })

  it('policy: 1 for the first drop in the window, then 0.9 / 0.75 / 0.5 for the 1st / 2nd / 3rd-or-more other drop', () => {
    expect([0, 1, 2, 3, 4, 40].map(dropCredibility)).toEqual([1, 0.9, 0.75, 0.5, 0.5, 0.5])
    expect(dropCredibility(NaN)).toBe(1)
    expect(dropCredibility(-2)).toBe(1)
  })

  it('discounts later drops as the detector keeps firing: S falls with the number of other drops in the last 32 bars', () => {
    const st = fresh()
    const seen = [4, 5, 6, 7, 8].map((bars) => run(st, at(bars, { event: drop() })))
    expect(seen.map((r) => r.credibility)).toEqual([1, 0.9, 0.75, 0.5, 0.5])
    seen.forEach((r) => expect(r.S).toBeCloseTo(1.25 * LEGACY.dropConfidence * r.credibility, 6))
    // a detector this busy carries little information: the drop is held, with the reason on the record
    const last = seen[4]
    expect(last.kind).toBe('HOLD')
    expect(last.reason).toBe('drop-noisy')
    expect(last.evaluated).toBe(true)
  })

  it('a train of lone drops (one every 2 bars) never cuts a scene before the forced ceiling', () => {
    const st = fresh()
    for (let bars = 4; bars <= 28; bars += 2) {
      // the first one (age 4, S = 0.44) is a MICRO; every later one is discounted below the age threshold
      const r = run(st, at(bars, { event: drop() }))
      expect(r.kind, `bar ${bars}`).not.toBe('CUT')
    }
  })

  it('the window forgets: a drop 33 bars after the last one is credible again', () => {
    const st = fresh()
    const cred = (bars: number) => run(st, at(bars, { event: drop() })).credibility
    expect(cred(40)).toBe(1)
    expect(cred(41)).toBeCloseTo(0.9) // one other drop, 1 bar ago
    expect(cred(74)).toBe(1) // 33 bars after the previous one: outside the window
  })

  it('a re-delivered (merged) drop is one physical drop: it is not counted against itself or against the next one', () => {
    const st = fresh()
    const first = drop()
    const a = run(st, at(5, { event: first }))
    const b = run(st, at(5.25, { event: { ...first, confidence: 0.45, corroborated: true } })) // same id, merged
    expect(a.credibility).toBe(1)
    expect(b.credibility).toBe(1)
    expect(run(st, at(6, { event: drop() })).credibility).toBeCloseTo(0.9) // ONE other drop, not two
  })

  it('a rare drop right after a real build is not discounted, and keeps the fast hard-cut lane', () => {
    const st = fresh()
    run(st, at(9, { event: ev({ type: 'buildStart', strength: 0.6, confidence: 0.8 }) }))
    const r = run(st, at(10, { event: drop({ confidence: LEGACY.dropBuildConfidence }) }))
    expect(r.credibility).toBe(1)
    expect(r).toMatchObject({ kind: 'CUT', reason: 'drop-fast', immediate: true })
  })

  it('a drop that releases a build is never discounted, even inside a train of false drops', () => {
    const st = fresh()
    for (let bars = 4; bars <= 8; bars++) run(st, at(bars, { event: drop() })) // the detector has fired 5 times
    // a confirmed build runs, then the drop
    for (let k = 0; k < 8; k++) step(st, at(9 + k * 0.25, { inBuild: true }))
    const r = run(st, at(11, { inBuild: true, event: drop({ confidence: LEGACY.dropBuildConfidence }) }))
    expect(r.credibility).toBe(1)
    expect(r).toMatchObject({ kind: 'CUT', reason: 'drop-fast', immediate: true })
  })

  it('the build may have ended up to 4 bars ago (and no more): a stale build does not rescue a drop', () => {
    const within = fresh()
    for (let bars = 4; bars <= 8; bars++) run(within, at(bars, { event: drop() }))
    step(within, at(9, { inBuild: true }))
    expect(run(within, at(12.9, { event: drop({ confidence: LEGACY.dropBuildConfidence }) })).credibility).toBe(1) // 3.9 bars later
    const stale = fresh()
    for (let bars = 4; bars <= 8; bars++) run(stale, at(bars, { event: drop() }))
    step(stale, at(9, { inBuild: true }))
    const r = run(stale, at(13.5, { event: drop({ confidence: LEGACY.dropBuildConfidence }) })) // 4.5 bars later
    expect(r.credibility).toBeLessThan(1)
    expect(r.reason).not.toBe('drop-fast')
  })

  it('a drop after a breakdown (the bass return) is a release too', () => {
    const st = fresh()
    for (let bars = 4; bars <= 8; bars++) run(st, at(bars, { event: drop() }))
    step(st, at(9, { inBreakdown: true }))
    const r = run(st, at(10, { event: drop({ confidence: LEGACY.dropReleaseConfidence }) })) // 1 bar after the breakdown
    expect(r.credibility).toBe(1)
    expect(r).toMatchObject({ kind: 'CUT', reason: 'drop-fast' })
  })

  it('only drops are weighted: a change event keeps credibility 1 however many drops came before', () => {
    const st = fresh()
    for (let bars = 4; bars <= 8; bars++) run(st, at(bars, { event: drop() }))
    const c = run(st, at(9, { event: ev({ S: 0.5 }) }))
    expect(c.credibility).toBe(1)
    expect(c.S).toBeCloseTo(0.5)
  })

  it('the credibility state is forgotten with the source (a new track starts with a clean detector history)', () => {
    const st = fresh()
    for (let bars = 20; bars <= 24; bars++) run(st, at(bars, { event: drop() }))
    expect(run(st, at(6, { event: drop() })).credibility).toBe(1) // the clocks went backwards: a new source
  })
})

describe('showDirector.step: refractory', () => {
  it('holds every event for 4 bars after a CUT, then allows the next', () => {
    const st = fresh()
    expect(run(st, at(10, { event: ev({ S: 0.9 }) })).kind).toBe('CUT')
    // The commit has not landed (sceneStart unchanged): a second strong event 2 bars later is refused.
    const r2 = run(st, at(12, { event: ev({ S: 0.9 }) }))
    expect(r2.kind).toBe('HOLD')
    expect(r2.reason).toBe('refractory')
    expect(run(st, at(13.75, { event: ev({ S: 0.9 }) })).reason).toBe('refractory')
    expect(run(st, at(14, { event: ev({ S: 0.9 }) })).kind).toBe('CUT')
  })

  it('a refused CUT (ackCut false) shortens the refractory so the director retries within two beats', () => {
    const st = fresh()
    const cut = at(10, { event: ev({ S: 0.9 }) })
    expect(run(st, cut).kind).toBe('CUT')
    ackCut(st, false, cut.beat, cut.time)
    expect(run(st, { ...at(10, { event: ev({ S: 0.9 }) }), beat: cut.beat + 1, time: cut.time + 0.5 }).reason).toBe('refractory')
    expect(run(st, { ...at(10, { event: ev({ S: 0.9 }) }), beat: cut.beat + 3, time: cut.time + 1.5 }).kind).toBe('CUT')
    // an accepted one changes nothing
    const ok = fresh()
    expect(run(ok, cut).kind).toBe('CUT')
    ackCut(ok, true, cut.beat, cut.time)
    expect(run(ok, { ...at(10, { event: ev({ S: 0.9 }) }), beat: cut.beat + 3, time: cut.time + 1.5 }).reason).toBe('refractory')
  })
})

describe('showDirector.step: the forced-change ceiling', () => {
  it('fires at min(32 bars, 60 s): 60 s (30 bars) at 120 BPM, waiting for the next bar line when nothing scored', () => {
    const st = fresh()
    expect(run(st, at(29.75)).kind).toBe('HOLD')
    const wait = run(st, at(30))
    expect(wait.kind).toBe('HOLD')
    expect(wait.reason).toBe('forced-wait')
    expect(wait.evaluated).toBe(false)
    const cut = run(st, at(30, { barLine: true }))
    expect(cut.kind).toBe('CUT')
    expect(cut.reason).toBe('forced-bar')
    expect(cut.forced).toBe(true)
  })

  it('takes the best-scoring event of the last 4 bars when there is one, cutting at once', () => {
    const st = fresh()
    // Two sub-threshold events at 27 and 28.5 bars (below the floor T = 0.30: a MICRO and a cooldown), the better one first.
    run(st, at(27, { event: ev({ S: 0.29 }) }))
    run(st, at(28.5, { event: ev({ S: 0.26 }) }))
    const cut = run(st, at(30))
    expect(cut.kind).toBe('CUT')
    expect(cut.reason).toBe('forced-best')
    expect(cut.forced).toBe(true)
    expect(cut.S).toBeCloseTo(0.29) // the best S in the window, not the latest
  })

  it('ignores events older than 4 bars: it falls back to the next bar line', () => {
    const st = fresh()
    run(st, at(20, { event: ev({ S: 0.28 }) })) // a MICRO 10 bars before the ceiling
    expect(run(st, at(30)).reason).toBe('forced-wait')
    expect(run(st, at(30, { barLine: true })).reason).toBe('forced-bar')
  })

  it('is lengthened in a breakdown: 48 bars / 90 s (45 bars at 120 BPM)', () => {
    const st = fresh()
    expect(run(st, at(44, { inBreakdown: true, barLine: true })).kind).toBe('HOLD')
    expect(run(st, at(45, { inBreakdown: true, barLine: true })).kind).toBe('CUT')
  })

  it('does not fire again within the refractory', () => {
    const st = fresh()
    expect(run(st, at(30, { barLine: true })).kind).toBe('CUT')
    expect(run(st, at(31, { barLine: true })).kind).toBe('HOLD')
  })
})

describe('showDirector.step: pressure', () => {
  it('never cuts on its own: pressure sources with no event only HOLD, at any age', () => {
    const st = fresh()
    for (const bars of [1, 5, 10, 20]) {
      const r = run(st, at(bars, { moodChanged: true, characterShift: true, trendRising: true, moodPredicted: true }))
      expect(r.kind).toBe('HOLD')
      expect(r.pressure).toBeGreaterThan(0.9)
    }
  })

  it('tips a marginal event over the threshold', () => {
    // At 5 bars T = 0.825. S = 0.8 is marginal: a MICRO alone, a CUT with the full 0.15 (T_eff = 0.675).
    const alone = run(fresh(), at(5, { event: ev({ S: 0.8 }) }))
    expect(alone.kind).toBe('MICRO')
    const pressed = run(fresh(), at(5, { moodChanged: true, event: ev({ S: 0.8 }) }))
    expect(pressed.kind).toBe('CUT')
    expect(pressed.pressure).toBeCloseTo(1)
    expect(pressed.T).toBeCloseTo(ageThreshold(5) - 0.15)
  })

  it('cannot rescue a weak event or a young scene', () => {
    expect(run(fresh(), at(5, { moodChanged: true, event: ev({ S: 0.5 }) })).kind).toBe('MICRO')
    expect(run(fresh(), at(2, { moodChanged: true, event: ev({ S: 1 }) })).kind).toBe('MICRO') // still min-age
  })

  it('is the max of the sources and decays to nothing over 8 bars', () => {
    const st = fresh()
    step(st, at(10, { moodChanged: true })) // bump 1.0
    expect(pressureAt(st, 40, 20)).toBeCloseTo(1)
    expect(pressureAt(st, 40 + 16, 20 + 8)).toBeCloseTo(0.5) // 4 bars later
    expect(pressureAt(st, 40 + 32, 20 + 16)).toBe(0) // 8 bars later
    step(st, at(10, { characterShift: true })) // 0.8, refreshed later than the mood bump
    expect(pressureAt(st, 40, 20)).toBeCloseTo(1) // max of the two
    resetShow(st)
    expect(pressureAt(st, 40, 20)).toBe(0)
  })

  it('a trend refreshed every frame holds P up, then decays when the trend ends', () => {
    const st = fresh()
    for (let b = 0; b < 40; b++) step(st, { ...at(0), beat: b, time: b * 0.5, trendRising: true })
    expect(run(st, { ...at(0), beat: 40, time: 20 }).pressure).toBeCloseTo(SHOW.bumpTrend * (1 - 1 / 32), 1)
    expect(run(st, { ...at(0), beat: 72, time: 36 }).pressure).toBe(0)
  })
})

describe('showDirector.step: breakdown', () => {
  it('raises the minimum cut age to 8 bars', () => {
    const r = run(fresh(), at(6, { inBreakdown: true, event: ev({ S: 1 }) }))
    expect(r.kind).toBe('MICRO')
    expect(run(fresh(), at(5, { event: ev({ S: 1 }) })).kind).toBe('CUT') // the same event outside a breakdown
    expect(run(fresh(), at(8, { inBreakdown: true, event: ev({ S: 1 }) })).kind).toBe('CUT')
    expect(run(fresh(), at(7, { inBreakdown: true, event: ev({ S: 1 }) })).reason).toBe('breakdown-min')
  })

  it('a drop still ends a breakdown (fast lane), the release being the point', () => {
    const r = run(fresh(), at(3, { inBreakdown: true, event: ev({ type: 'drop', strength: 1, confidence: 0.9 }) }))
    expect(r.kind).toBe('CUT')
    expect(r.immediate).toBe(true)
  })

  it('a breakdown event itself is weighted 0.9', () => {
    const r = run(fresh(), at(6, { event: ev({ type: 'breakdown', strength: 1, confidence: 1 }) }))
    expect(r.S).toBeCloseTo(0.9)
    expect(r.kind).toBe('CUT') // 0.9 >= T(6) = 0.75
  })
})

describe('showDirector.step: through a build', () => {
  it('holds every discretionary change (cuts and tweaks) until the drop, as the old directors did', () => {
    const cut = run(fresh(), at(10, { inBuild: true, event: ev({ S: 0.95 }) }))
    expect(cut).toMatchObject({ kind: 'HOLD', reason: 'build-hold', evaluated: true })
    expect(run(fresh(), at(10, { inBuild: true, event: ev({ S: 0.3 }) })).kind).toBe('HOLD')
    expect(run(fresh(), at(10, { event: ev({ S: 0.95 }) })).kind).toBe('CUT') // the same event outside a build
  })

  it('the drop is the exception: it still cuts, immediately', () => {
    const r = run(fresh(), at(10, { inBuild: true, event: ev({ type: 'drop', strength: 1, confidence: 0.9 }) }))
    expect(r).toMatchObject({ kind: 'CUT', immediate: true })
  })

  it('the forced ceiling waits for the build to end', () => {
    const st = fresh()
    expect(run(st, at(31, { inBuild: true, barLine: true })).kind).toBe('HOLD')
    expect(run(st, at(32, { barLine: true })).kind).toBe('CUT')
  })
})

describe('showDirector.step: MICRO', () => {
  it('is a tweak for 0.25 <= S < T_eff, with a 4-bar cooldown', () => {
    const st = fresh()
    expect(run(st, at(8, { event: ev({ S: 0.28 }) })).kind).toBe('MICRO')
    const again = run(st, at(9, { event: ev({ S: 0.28 }) }))
    expect(again.kind).toBe('HOLD')
    expect(again.reason).toBe('micro-cooldown')
    expect(run(st, at(11.75, { event: ev({ S: 0.28 }) })).reason).toBe('micro-cooldown')
    expect(run(st, at(12, { event: ev({ S: 0.28 }) })).kind).toBe('MICRO') // still under T = 0.30
  })

  it('needs S >= 0.25', () => {
    const r = run(fresh(), at(8, { event: ev({ S: 0.24 }) }))
    expect(r.kind).toBe('HOLD')
    expect(r.reason).toBe('weak')
    expect(run(fresh(), at(8, { event: ev({ S: 0.25 }) })).kind).toBe('MICRO')
  })

  it('picks WHAT to vary from the event: timbre -> mode/layer, harmony -> palette, rhythm -> effect', () => {
    const feats = (o: Partial<SectionEvent['feats']>) => ({ level: 0, low: 0, timbre: 0, harmony: 0, rhythm: 0, ...o })
    const st = fresh()
    expect(pickMicro(st, ev({ feats: feats({ harmony: 2, timbre: 1 }) }))).toBe('palette')
    expect(pickMicro(st, ev({ feats: feats({ rhythm: 3, harmony: 1 }) }))).toBe('effect')
    const timbre = new Set([
      pickMicro(st, ev({ feats: feats({ timbre: 2 }) })),
      pickMicro(st, ev({ feats: feats({ timbre: 2 }) })),
    ])
    expect(timbre).toEqual(new Set(['mode', 'layer'])) // alternates
    expect(pickMicro(st, ev({ feats: feats({ level: 2 }) }))).toBe('layer')
    expect(pickMicro(st, ev({ feats: feats({ low: 2 }) }))).toBe('effect')
    expect(pickMicro(st, ev({ type: 'fill' }))).toBe('effect')
  })

  it('rotates palette, layer, mode, effect when the event carries no per-channel feats (legacy)', () => {
    const st = fresh()
    const picks = [0, 1, 2, 3, 4].map(() => pickMicro(st, ev()))
    expect(picks).toEqual(['palette', 'layer', 'mode', 'effect', 'palette'])
  })

  it('a real MICRO action carries the pick', () => {
    const r = run(fresh(), at(8, { event: ev({ S: 0.3, feats: { level: 0, low: 0, timbre: 0, harmony: 2, rhythm: 0 } }) }))
    expect(r.kind).toBe('MICRO')
    expect(r.micro).toBe('palette')
  })
})

describe('showDirector.step: HOLD is a decision with a reason', () => {
  it('reports a reason and the numbers for every held event', () => {
    const weak = run(fresh(), at(8, { event: ev({ S: 0.1 }) }))
    expect(weak).toMatchObject({ kind: 'HOLD', reason: 'weak', evaluated: true })
    expect(weak.T).toBeCloseTo(ageThreshold(8))
    expect(weak.age).toBeCloseTo(8)
    expect(weak.S).toBeCloseTo(0.1)
  })

  it('an idle frame is a HOLD too, marked not evaluated (so it is not counted)', () => {
    const st = fresh()
    const idle = run(st, at(8))
    expect(idle).toMatchObject({ kind: 'HOLD', reason: 'idle', evaluated: false })
    expect(st.stats).toEqual({ hold: 0, micro: 0, cut: 0, forced: 0 })
  })

  it('counts HOLD, MICRO and CUT decisions and the forced share', () => {
    const st = fresh()
    run(st, at(8, { event: ev({ S: 0.1 }) })) // HOLD
    run(st, at(8.5, { event: ev({ S: 0.3 }) })) // MICRO
    run(st, at(12, { event: ev({ S: 0.9 }) })) // CUT
    expect(st.stats).toEqual({ hold: 1, micro: 1, cut: 1, forced: 0 })
    run(st, at(30, { barLine: true })) // forced (the first cut left the refractory long ago; scene never committed)
    expect(st.stats.cut).toBe(2)
    expect(st.stats.forced).toBe(1)
  })

  it('build starts, gain steps and fills never cut', () => {
    const start = run(fresh(), at(20, { event: ev({ type: 'buildStart', strength: 1, confidence: 1 }) }))
    expect(start).toMatchObject({ kind: 'HOLD', reason: 'build-start' })
    const gain = run(fresh(), at(20, { event: ev({ type: 'gain', strength: 1, confidence: 1 }) }))
    expect(gain).toMatchObject({ kind: 'HOLD', reason: 'gain' })
    const fill = run(fresh(), at(20, { event: ev({ type: 'fill', strength: 1, confidence: 1 }) }))
    expect(fill.kind).toBe('MICRO') // punctuation only
    expect(fill.micro).toBe('effect')
    expect(run(fresh(), at(20, { event: ev({ type: 'fill', strength: 0.2, confidence: 1 }) })).kind).toBe('HOLD')
  })

  it('a build start feeds pressure and counts as the build behind a following drop', () => {
    const st = fresh()
    const r = run(st, at(2, { event: ev({ type: 'buildStart', strength: 0.6, confidence: 0.8 }) }))
    expect(r.kind).toBe('HOLD')
    expect(run(st, at(2.5)).pressure).toBeGreaterThan(0.5)
  })
})

describe('showDirector.step: tempo robustness', () => {
  const cutAt = (bpm: number, beats: number): ShowAction['kind'] => {
    const spb = 60 / bpm
    const st = fresh()
    return run(st, {
      ...at(0, { bpm, event: ev({ S: 0.95 }) }),
      beat: beats,
      time: beats * spb,
    }).kind
  }

  it('60 BPM: the seconds clamp ages the scene (a bar counts as 3 s), so 4 bars need 12 s, not 16', () => {
    expect(cutAt(60, 11)).toBe('MICRO') // 11 s
    expect(cutAt(60, 12)).toBe('CUT') // 12 s = 4 clamped bars, though the beats say 3 bars
  })

  it('170 BPM: 4 bars of beats is only 5.6 s; the clamp holds the scene to ~6 s', () => {
    expect(cutAt(170, 16)).toBe('MICRO') // 16 beats = 5.65 s
    expect(cutAt(170, 18)).toBe('CUT') // 6.35 s
  })

  it('the forced ceiling is min(32 bars, 60 s): 60 s at 60 BPM, 45 s (32 bars) at 170 BPM', () => {
    const forcedAt = (bpm: number, seconds: number) => {
      const st = fresh()
      const spb = 60 / bpm
      return run(st, { ...at(0, { bpm, barLine: true }), beat: Math.round(seconds / spb), time: seconds }).kind
    }
    expect(forcedAt(60, 59)).toBe('HOLD')
    expect(forcedAt(60, 60)).toBe('CUT')
    expect(forcedAt(170, 44)).toBe('HOLD')
    expect(forcedAt(170, 46)).toBe('CUT')
  })

  it('a frozen beat counter still ages the scene by the clock', () => {
    const r = run(fresh(), { ...at(0, { event: ev({ S: 0.95 }) }), beat: 0, time: 12 })
    expect(r.age).toBeCloseTo(4)
    expect(r.kind).toBe('CUT')
  })
})

describe('showDirector.step: robustness', () => {
  it('returns one reused action object (allocation-light) valid until the next step', () => {
    const st = fresh()
    const a = step(st, at(1))
    const b = step(st, at(2))
    expect(a).toBe(b)
  })

  it('a new source (the clocks go backwards) forgets the old one: no stale refractory, pressure or ring', () => {
    const st = fresh()
    step(st, at(40, { moodChanged: true }))
    expect(run(st, at(40, { event: ev({ S: 0.9 }) })).kind).toBe('CUT')
    const r = run(st, at(10, { event: ev({ S: 0.95 }) })) // 10 bars into a NEW track
    expect(r.kind).toBe('CUT') // not 'refractory'
    expect(r.pressure).toBe(0)
  })

  it('before the first commit (scene start unknown) the show ages from its first frame, and never forces at frame one', () => {
    const st = fresh()
    const first = run(st, { ...at(0), sceneStartBeat: Number.NEGATIVE_INFINITY, sceneStartTime: Number.NEGATIVE_INFINITY, beat: 500, time: 250 })
    expect(first.age).toBe(0)
    expect(first.kind).toBe('HOLD')
    const later = run(st, { ...at(0), sceneStartBeat: Number.NEGATIVE_INFINITY, sceneStartTime: Number.NEGATIVE_INFINITY, beat: 516, time: 258 })
    expect(later.age).toBeCloseTo(4)
  })

  it('never throws and never returns a non-finite number for garbage events', () => {
    const st = fresh()
    const bad = ev({ strength: NaN, confidence: Infinity, feats: { level: NaN, low: NaN, timbre: NaN, harmony: NaN, rhythm: NaN } })
    for (const type of ['change', 'drop', 'breakdown', 'fill', 'gain', 'buildStart'] as const) {
      const r = run(st, at(9, { event: { ...bad, type } }))
      for (const v of [r.S, r.T, r.age, r.pressure]) expect(Number.isFinite(v)).toBe(true)
    }
    const nanInput = run(st, { ...at(9), beat: NaN, time: NaN })
    expect(nanInput.kind).toBe('HOLD')
  })
})
