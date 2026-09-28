import { describe, expect, it } from 'vitest'
import {
  commitMirrorDecision,
  createMirrorGate,
  MIRROR_GATE,
  MIRROR_SWAP_MIX,
  mirrorDwellCleared,
  mirrorSeedFor,
  mirrorSwapReady,
  planMirrorInstall,
  resetMirrorGate,
  stepMirrorGate,
  type MirrorGateInput,
  type MirrorGateState,
} from '../mirrorGate'
import { MIRROR_OFF } from '../opticalDirector'

/** A frame that IS a beat; phrase edges every 16 beats; everything else quiet. */
function beatFrame(beat: number, over: Partial<MirrorGateInput> = {}): MirrorGateInput {
  return {
    beat,
    beatEdge: true,
    phraseEdge: beat % 16 === 0,
    fastSectionChange: false,
    structureValid: false,
    sectionCount: 0,
    moodKey: 3,
    ...over,
  }
}

interface Trace {
  beat: number
  seed: number
}

/**
 * Drive the gate beat by beat. `chooser(beat, seed)` says whether the decision engages; the trace lists every beat a
 * decision was taken on (and its seed). `frameOver(beat)` adds per-beat input.
 */
function run(
  st: MirrorGateState,
  from: number,
  to: number,
  chooser: (beat: number, seed: number) => boolean,
  frameOver: (beat: number) => Partial<MirrorGateInput> = () => ({}),
): Trace[] {
  const out: Trace[] = []
  for (let b = from; b <= to; b++) {
    const a = stepMirrorGate(st, beatFrame(b, frameOver(b)))
    if (a.decide) {
      out.push({ beat: b, seed: a.seed })
      commitMirrorDecision(st, chooser(b, a.seed), false, b)
    }
  }
  return out
}

describe('mirrorSeedFor', () => {
  it('is a pure, non-negative integer of (section, mood, re-decision)', () => {
    expect(mirrorSeedFor(3, 5, 1)).toBe(mirrorSeedFor(3, 5, 1))
    for (const [s, m, r] of [[0, 0, 0], [12, 40, 7], [1, 1, 99], [-5, -2, -1], [NaN, NaN, NaN]] as const) {
      const v = mirrorSeedFor(s, m, r)
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
    }
  })

  it('differs across section, mood and re-decision, so they are independent draws', () => {
    const seen = new Set<number>()
    for (let s = 0; s < 10; s++) for (let m = 0; m < 40; m++) for (let r = 0; r <= MIRROR_GATE.redecideCap; r++) seen.add(mirrorSeedFor(s, m, r))
    expect(seen.size).toBe(10 * 40 * (MIRROR_GATE.redecideCap + 1))
  })
})

describe('stepMirrorGate: when a decision is taken', () => {
  it('the first phrase edge decides (an effect can arrive without any section boundary), and only on a beat', () => {
    const st = createMirrorGate()
    for (let b = 1; b < 16; b++) expect(stepMirrorGate(st, beatFrame(b)).decide).toBe(false)
    // A phrase edge that is NOT a beat crossing never decides.
    expect(stepMirrorGate(st, beatFrame(16, { beatEdge: false })).decide).toBe(false)
    expect(stepMirrorGate(st, beatFrame(16)).decide).toBe(true)
  })

  it('an off mirror is re-decided every maxOffBeats at phrase edges, no faster', () => {
    const st = createMirrorGate()
    const t = run(st, 0, 200, () => false)
    const gaps = t.slice(1).map((d, i) => d.beat - t[i].beat)
    expect(t.length).toBeGreaterThan(3)
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(MIRROR_GATE.maxOffBeats)
    for (const d of t) expect(d.beat % 16).toBe(0) // staleness decisions land on phrase edges
  })

  it('an engaged mirror is never taken down inside minOnBeats, however many section boundaries arrive', () => {
    const st = createMirrorGate()
    let engagedAt = -1
    // Engage on the first decision, then vote OFF on every later one.
    const t = run(
      st,
      0,
      200,
      (b) => {
        if (engagedAt < 0) {
          engagedAt = b
          return true
        }
        return false
      },
      (b) => ({ structureValid: true, sectionCount: Math.floor(b / 3) }), // a "section" every 3 beats
    )
    expect(t.length).toBeGreaterThan(1)
    expect(t[1].beat - t[0].beat).toBeGreaterThanOrEqual(MIRROR_GATE.minOnBeats)
  })

  it('decisions are never closer than minChangeBeats, even under a stream of section boundaries', () => {
    const st = createMirrorGate()
    const t = run(st, 0, 300, () => true, (b) => ({ structureValid: true, sectionCount: b })) // a boundary EVERY beat
    expect(t.length).toBeGreaterThan(3)
    for (let i = 1; i < t.length; i++) expect(t[i].beat - t[i - 1].beat).toBeGreaterThanOrEqual(MIRROR_GATE.minChangeBeats)
  })

  it('a section change inside the dwell is remembered and acted on the moment the dwell clears', () => {
    const st = createMirrorGate()
    // Engage at beat 16 (first phrase edge).
    const first = stepMirrorGate(st, beatFrame(16))
    expect(first.decide).toBe(true)
    commitMirrorDecision(st, true, false, 16)
    // A committed section boundary lands at beat 20, well inside the 32-beat hold.
    for (let b = 17; b < 20; b++) expect(stepMirrorGate(st, beatFrame(b, { structureValid: true, sectionCount: 0 })).decide).toBe(false)
    let decided = -1
    for (let b = 20; b <= 60 && decided < 0; b++) {
      if (stepMirrorGate(st, beatFrame(b, { structureValid: true, sectionCount: 1 })).decide) decided = b
    }
    expect(decided).toBe(16 + MIRROR_GATE.minOnBeats) // NOT at a phrase edge: the pending boundary fires on the first cleared beat
  })

  it('a mood change alone never triggers a decision (it only seeds one)', () => {
    const st = createMirrorGate()
    const t = run(st, 0, 100, () => true, (b) => ({ moodKey: 1 + (b % 14) })) // primary mood flapping every beat
    // Only staleness decisions: engaged, so >= maxOnBeats apart after the first.
    for (let i = 2; i < t.length; i++) expect(t[i].beat - t[i - 1].beat).toBeGreaterThanOrEqual(MIRROR_GATE.maxOnBeats)
  })

  it('a burst of fast phrase-change events is ONE boundary (debounced) while the structure read is invalid', () => {
    const st = createMirrorGate()
    commitMirrorDecision(st, false, false, 0)
    st.lastChangeBeat = -Infinity
    const before = st.sections
    for (let b = 1; b <= 12; b++) {
      stepMirrorGate(st, beatFrame(b, { fastSectionChange: true, phraseEdge: false }))
    }
    expect(st.sections - before).toBe(1)
    // ... and a second one only after the debounce window.
    stepMirrorGate(st, beatFrame(1 + MIRROR_GATE.sectionDebounceBeats, { fastSectionChange: true, phraseEdge: false }))
    expect(st.sections - before).toBe(2)
  })

  it('the fast flag is ignored once the structure read is valid; committed boundaries drive it', () => {
    const st = createMirrorGate()
    stepMirrorGate(st, beatFrame(1, { structureValid: true, sectionCount: 4, phraseEdge: false }))
    const s0 = st.sections
    for (let b = 2; b < 30; b++) stepMirrorGate(st, beatFrame(b, { structureValid: true, sectionCount: 4, fastSectionChange: true, phraseEdge: false }))
    expect(st.sections).toBe(s0) // baseline read is not a boundary, and the fast flag is not consulted
    stepMirrorGate(st, beatFrame(30, { structureValid: true, sectionCount: 5, phraseEdge: false }))
    expect(st.sections).toBe(s0 + 1)
  })

  it('no two changes are ever closer than minChangeBeats, even for a tiny minOff', () => {
    const st = createMirrorGate()
    commitMirrorDecision(st, false, false, 100) // off, decided at 100
    st.engaged = true
    commitMirrorDecision(st, false, false, 100) // engaged -> off at 100: a change
    expect(st.lastChangeBeat).toBe(100)
    for (let b = 101; b < 100 + MIRROR_GATE.minChangeBeats; b++) expect(mirrorDwellCleared(st, b)).toBe(false)
    expect(mirrorDwellCleared(st, 100 + MIRROR_GATE.minChangeBeats)).toBe(true)
  })

  it('same section + mood gives the same seed on a replay; a new section gives a different one', () => {
    const a = createMirrorGate()
    const b = createMirrorGate()
    const frames = (beat: number) => ({ structureValid: true, sectionCount: beat >= 40 ? 1 : 0 })
    const ta = run(a, 0, 120, () => true, frames)
    const tb = run(b, 0, 120, () => true, frames)
    expect(ta).toEqual(tb)
    expect(new Set(ta.map((d) => d.seed)).size).toBe(ta.length)
  })

  it('a re-decision inside the SAME section draws a different seed (no fixed repeat), but deterministically', () => {
    const st = createMirrorGate()
    const t = run(st, 0, 130, () => false)
    expect(t.length).toBeGreaterThan(2)
    expect(new Set(t.map((d) => d.seed)).size).toBe(t.length)
  })
})

describe('stepMirrorGate: robustness', () => {
  it('a rewound beat counter (new source) resets everything, nothing leaks', () => {
    const st = createMirrorGate()
    run(st, 0, 100, () => true)
    expect(st.engaged).toBe(true)
    const a = stepMirrorGate(st, beatFrame(3))
    expect(a.decide).toBe(false)
    expect(st.engaged).toBe(false)
    expect(st.sections).toBe(0)
    expect(st.lastChangeBeat).toBe(-Infinity)
    // The new track's first phrase edge decides again.
    expect(stepMirrorGate(st, beatFrame(16)).decide).toBe(true)
  })

  it('NaN and non-finite inputs never throw, never decide, never poison the state', () => {
    const st = createMirrorGate()
    expect(stepMirrorGate(st, beatFrame(NaN)).decide).toBe(false)
    expect(stepMirrorGate(st, beatFrame(Infinity)).decide).toBe(false)
    expect(() => stepMirrorGate(st, beatFrame(5, { sectionCount: NaN, moodKey: NaN, structureValid: true }))).not.toThrow()
    expect(st.lastBeat).toBe(5)
    commitMirrorDecision(st, true, false, NaN)
    expect(Number.isFinite(st.lastDecisionBeat)).toBe(true)
  })

  it('a decision requested while structure flips valid -> invalid -> valid re-baselines instead of counting a boundary', () => {
    const st = createMirrorGate()
    stepMirrorGate(st, beatFrame(1, { structureValid: true, sectionCount: 7, phraseEdge: false }))
    stepMirrorGate(st, beatFrame(2, { structureValid: false, phraseEdge: false }))
    const s = st.sections
    stepMirrorGate(st, beatFrame(3, { structureValid: true, sectionCount: 9, phraseEdge: false }))
    expect(st.sections).toBe(s) // 9 is a fresh baseline, not "section 7 -> 9"
  })

  it('resetMirrorGate restores a fresh gate', () => {
    const st = createMirrorGate()
    run(st, 0, 60, () => true)
    resetMirrorGate(st)
    expect(st).toEqual(createMirrorGate())
  })
})

describe('the flicker regression: how often does the fold change', () => {
  it('over a long stretch with a noisy section flag, a mood flapping every beat and 50% coin flips, changes stay >= 16 beats apart and engaged spells >= 32', () => {
    const st = createMirrorGate()
    const changes: number[] = []
    let engaged = false
    const onSpells: number[] = []
    let onSince = -1
    for (let b = 0; b <= 1200; b++) {
      const a = stepMirrorGate(
        st,
        beatFrame(b, { fastSectionChange: b % 5 === 0, moodKey: 1 + (b % 14) }), // the OLD code re-rolled on every one of these
      )
      if (a.decide) {
        const now = (a.seed * 2654435761) % 100 < 50 // a deterministic 50% coin
        if (now !== engaged) {
          changes.push(b)
          if (now) onSince = b
          else onSpells.push(b - onSince)
        }
        engaged = now
        commitMirrorDecision(st, now, false, b)
      }
    }
    expect(changes.length).toBeGreaterThan(4) // it still moves: a mirror that never changes is not the goal
    for (let i = 1; i < changes.length; i++) expect(changes[i] - changes[i - 1]).toBeGreaterThanOrEqual(MIRROR_GATE.minChangeBeats)
    for (const s of onSpells) expect(s).toBeGreaterThanOrEqual(MIRROR_GATE.minOnBeats)
  })
})

describe('planMirrorInstall / mirrorSwapReady: reshapes dip, they never snap', () => {
  const kaleido6 = { mode: 'kaleido', segments: 6 }
  const kaleido8 = { mode: 'kaleido', segments: 8 }
  const vortex = { mode: 'vortex', segments: 0 }
  const off = MIRROR_OFF

  it('a fresh engage from nothing installs directly', () => {
    const p = planMirrorInstall(off, kaleido6, off, 0)
    expect(p).toEqual({ target: kaleido6, pending: null, reshaped: false })
  })

  it('going off installs directly (mix fades the fold out while its shape is held)', () => {
    const p = planMirrorInstall(kaleido6, off, off, 1)
    expect(p).toEqual({ target: off, pending: null, reshaped: false })
  })

  it('an engaged fold given a different segment count or mode dips: target off now, the new look pending', () => {
    for (const next of [kaleido8, vortex]) {
      const p = planMirrorInstall(kaleido6, next, off, 0.9)
      expect(p.reshaped).toBe(true)
      expect(p.target).toBe(off)
      expect(p.pending).toBe(next)
    }
  })

  it('the same shape (only twist / spin differ) installs directly, so it just eases', () => {
    const a = { mode: 'kaleido', segments: 6, spin: 0.2 }
    const b = { mode: 'kaleido', segments: 6, spin: 0.5 }
    expect(planMirrorInstall(a, b, { ...off, spin: 0 }, 1)).toEqual({ target: b, pending: null, reshaped: false })
  })

  it('an engage while the previous fold is still visibly fading out waits for it; once it is gone it installs directly', () => {
    expect(planMirrorInstall(off, kaleido6, off, MIRROR_SWAP_MIX).pending).toBe(kaleido6)
    expect(planMirrorInstall(off, kaleido6, off, MIRROR_SWAP_MIX - 0.001).pending).toBeNull()
  })

  it('a pending look is installed only when the mix is nearly gone, or the scene suppresses the mirror', () => {
    expect(mirrorSwapReady(0.9, false)).toBe(false)
    expect(mirrorSwapReady(MIRROR_SWAP_MIX, false)).toBe(false)
    expect(mirrorSwapReady(MIRROR_SWAP_MIX - 0.001, false)).toBe(true)
    expect(mirrorSwapReady(0.9, true)).toBe(true)
    expect(mirrorSwapReady(NaN, false)).toBe(true) // a garbage mix must not wedge a pending look forever
  })
})

describe('commitMirrorDecision: what starts the dwell clocks', () => {
  it('off -> on and on -> off are changes; a same-state decision is not (but restarts the staleness clock)', () => {
    const st = createMirrorGate()
    commitMirrorDecision(st, false, false, 10) // off -> off
    expect(st.lastChangeBeat).toBe(-Infinity)
    expect(st.lastDecisionBeat).toBe(10)
    commitMirrorDecision(st, true, false, 20) // off -> on
    expect(st.lastChangeBeat).toBe(20)
    commitMirrorDecision(st, true, false, 60) // on -> on, same shape
    expect(st.lastChangeBeat).toBe(20)
    expect(st.lastDecisionBeat).toBe(60)
    commitMirrorDecision(st, true, true, 100) // on -> on, reshaped
    expect(st.lastChangeBeat).toBe(100)
    commitMirrorDecision(st, false, false, 140) // on -> off
    expect(st.lastChangeBeat).toBe(140)
    expect(st.engaged).toBe(false)
  })

  it('clears pending, so one boundary buys exactly one decision', () => {
    const st = createMirrorGate()
    st.pending = true
    commitMirrorDecision(st, false, false, 5)
    expect(st.pending).toBe(false)
  })
})
