/**
 * Validation of the whole-song analyser against the synthetic suite (`eval/synthSong.ts`, structure known to the
 * sample). All stimuli are rendered at 22.05 kHz to keep the normal test run fast (about 0.3 s per analysis); one
 * 44.1 kHz stimulus exercises the decimation path. Real music is only covered by `scripts/calibrate/silver.calib.ts`.
 *
 * WHAT THE SUITE PINS (numbers measured when the analyser was written, in the comments next to each check):
 *  - recall within +-1 bar of the positive truth events: >= 0.9 on every non-morph, non-ambient stimulus (1.0 in
 *    practice), 2 of 3 on the drumless pad piece (the bar grid there is arbitrary), 23 of 24 overall;
 *  - NO events near fills, gain steps or silence gaps, and no false events at all on the drum stimuli;
 *  - tempo within 1% (octave-correct) and the bar lines on the true bar lines on every drum stimulus, including
 *    with the start of the audio cut at each of the four beats of a bar;
 *  - boundary TYPES (drop / breakdown / buildStart) right on the EDM stimuli; repetition labels on A B A B'.
 *
 * KNOWN, DOCUMENTED DISAGREEMENTS WITH THE SYNTHETIC TRUTH
 *  - `gradualMorph16`: the truth marks the END of a 16-bar filter/level sweep as the change. A smooth ramp has no
 *    discontinuity there, and the analyser (correctly, for a reference) does not report one; it reports one
 *    build-like event inside the ramp, which the truth tolerates ("at most one anywhere inside the morph").
 *  - `slowAmbient`: no drums, so no beat grid to speak of, and its first change (a -> b) shares three of four notes
 *    in each chord; the a -> b boundary is missed (2 of 3).
 */
import { describe, expect, it } from 'vitest'
import type { SectionEvent } from '../../events/types'
import { detectionsNearEvents, matchEvents, negativeTimes, positiveTimes, scoreDetectionsBars } from '../../eval/structureMetrics'
import { STIMULI, STIMULUS_NAMES, type StimulusName, type SynthSong } from '../../eval/synthSong'
import { analyzeSong } from '../analyzeSong'
import type { SongPlan } from '../types'

const SR = 22050
const cache = new Map<StimulusName, { song: SynthSong; plan: SongPlan }>()
function run(name: StimulusName): { song: SynthSong; plan: SongPlan } {
  let r = cache.get(name)
  if (!r) {
    const song = STIMULI[name]({ sampleRate: SR })
    r = { song, plan: analyzeSong(song.pcm, song.sampleRate) }
    cache.set(name, r)
  }
  return r
}

const DRUMLESS: StimulusName = 'slowAmbient'
const MORPH: StimulusName = 'gradualMorph16'
const DRUMS = STIMULUS_NAMES.filter((n) => n !== DRUMLESS)
const WITH_POSITIVES = STIMULUS_NAMES.filter((n) => n !== MORPH && n !== 'fillsOnly' && n !== 'gainStep' && n !== 'silenceGap')
const detTimes = (plan: SongPlan) => plan.events.map((e) => e.boundaryTime)
const T = 120_000

describe('analyzeSong on the synthetic suite', () => {
  it.each(WITH_POSITIVES)('%s: every designed change lands within +-1 bar', (name) => {
    const { song, plan } = run(name)
    const truth = positiveTimes(song.truth)
    const s = scoreDetectionsBars(truth, detTimes(plan), 1, song.bpm)
    // 1.0 on every stimulus but the drumless pads (2/3)
    expect(s.recall).toBeGreaterThanOrEqual(name === DRUMLESS ? 0.6 : 0.9)
    // and nothing spurious beyond one extra event per song (none in practice)
    expect(s.nDet - s.hits).toBeLessThanOrEqual(1)
  }, T)

  it('overall recall on the non-morph stimuli is >= 0.9 (23 of 24 truth events)', () => {
    let hits = 0
    let total = 0
    for (const name of WITH_POSITIVES) {
      const { song, plan } = run(name)
      const s = scoreDetectionsBars(positiveTimes(song.truth), detTimes(plan), 1, song.bpm)
      hits += s.hits
      total += s.nTruth
    }
    expect(total).toBe(24)
    expect(hits / total).toBeGreaterThanOrEqual(0.9)
  }, T)

  it.each(STIMULUS_NAMES)('%s: no event on a fill, a gain step or a silence gap', (name) => {
    const { song, plan } = run(name)
    const neg = negativeTimes(song.truth, ['fill', 'gain', 'silence'])
    const tol = (0.75 * 240) / song.bpm
    expect(detectionsNearEvents(neg, detTimes(plan), tol)).toBe(0)
  }, T)

  it.each(['fillsOnly', 'gainStep', 'silenceGap'] as const)('%s (negatives only): no events at all', (name) => {
    expect(run(name).plan.events).toHaveLength(0)
    expect(run(name).plan.segments).toHaveLength(1)
  }, T)

  it('gradualMorph16: at most one event inside the 16-bar morph', () => {
    const { song, plan } = run(MORPH)
    const bar = 240 / song.bpm
    const inside = plan.events.filter((e) => e.boundaryTime >= 16 * bar - bar && e.boundaryTime <= 33 * bar)
    expect(inside.length).toBeLessThanOrEqual(1)
    // and nothing outside it: the steady states are flat
    expect(plan.events.length - inside.length).toBe(0)
  }, T)

  it.each(DRUMS)('%s: tempo within 1%% of the truth (octave-correct)', (name) => {
    const { song, plan } = run(name)
    expect(Math.abs(plan.bpm / song.bpm - 1)).toBeLessThan(0.01)
  }, T)

  it.each(DRUMS)('%s: bar lines fall on the true bar lines (downbeat phase correct)', (name) => {
    const { song, plan } = run(name)
    // the last bar line is the end of the audio, past the last true bar line: allow one miss
    const onTrue = plan.bars.filter((t) => song.barTimes.some((b) => Math.abs(b - t) < 0.08)).length
    expect(onTrue).toBeGreaterThanOrEqual(plan.bars.length - 1)
    expect(plan.diagnostics.downbeat.confidence).toBeGreaterThan(0.5)
    expect(plan.diagnostics.downbeat.methodsAgree).toBe(true)
  }, T)

  it.each(['mixed', 'buildThenDrop', 'fourSections'] as const)('%s: the bar phase follows when the audio starts 1, 2 or 3 beats late', (name) => {
    const { song } = run(name)
    for (const k of [1, 2, 3]) {
      const trimSec = (k * 60) / song.bpm
      const plan = analyzeSong(song.pcm.subarray(Math.round(trimSec * SR)), SR)
      const trueBars = song.barTimes.map((t) => t - trimSec)
      const onTrue = plan.bars.filter((t) => trueBars.some((b) => Math.abs(b - t) < 0.08)).length
      expect(onTrue).toBeGreaterThanOrEqual(plan.bars.length - 1)
    }
  }, T)

  it('the beats sit on the true beats (median error under 20 ms) including under tempo drift', () => {
    for (const name of ['mixed', 'tempoDrift', 'verseChorusEqualLoudness'] as const) {
      const { song, plan } = run(name)
      const errs = plan.beats.map((t) => {
        let best = Infinity
        for (const b of song.beatTimes) if (Math.abs(b - t) < Math.abs(best)) best = t - b
        return Math.abs(best)
      })
      errs.sort((a, b) => a - b)
      expect(errs[errs.length >> 1]).toBeLessThan(0.02)
      expect(errs[Math.floor(errs.length * 0.9)]).toBeLessThan(0.06)
    }
  }, T)

  it('types the EDM events: buildStart, drop and breakdown match the truth type', () => {
    let right = 0
    let total = 0
    for (const name of ['buildThenDrop', 'breakdown', 'mixed'] as const) {
      const { song, plan } = run(name)
      const truth = song.truth.filter((t) => t.shouldTrigger && (t.type === 'buildStart' || t.type === 'drop' || t.type === 'breakdown'))
      const m = matchEvents(
        truth.map((t) => t.timeSec),
        detTimes(plan),
        240 / song.bpm,
      )
      for (const p of m.pairs) {
        total++
        if (plan.events[p.detIndex].type === truth[p.truthIndex].type) right++
      }
    }
    expect(total).toBe(9)
    expect(right / total).toBeGreaterThanOrEqual(0.85)
  }, T)

  it('labels repetition: A B A B on fourSections, and the two builds / two drops of `mixed` share labels', () => {
    const four = run('fourSections').plan
    expect(four.segments.map((s) => s.label)).toEqual(['A', 'B', 'A', 'B'])
    expect(four.segments.map((s) => s.repeatOf)).toEqual([undefined, undefined, 0, 1])
    expect(four.events[1].sim?.boundaryBeat).toBe(four.downbeatPhase) // the return to A points back at the start of A
    const { song, plan } = run('mixed')
    const labelAt = (bar: number) => plan.segments.find((s) => Math.abs(s.startSec - bar * (240 / song.bpm)) < 240 / song.bpm)?.label
    expect(labelAt(24)).toBeDefined()
    expect(labelAt(24)).toBe(labelAt(56))
    expect(labelAt(32)).toBe(labelAt(64))
    expect(labelAt(24)).not.toBe(labelAt(32))
  }, T)

  it('a 4-bar riser is one build, not a pile of section changes', () => {
    const { plan } = run('buildThenDrop')
    expect(plan.segments).toHaveLength(3)
    expect(plan.events.map((e) => e.type)).toEqual(['buildStart', 'drop'])
  }, T)

  it.each(STIMULUS_NAMES)('%s: the plan is well formed and JSON-safe', (name) => {
    const { plan } = run(name)
    expect(plan.bars.length).toBeGreaterThan(8)
    for (let k = 0; k < plan.bars.length; k++) expect(plan.bars[k]).toBeCloseTo(plan.beats[plan.downbeatPhase + 4 * k], 9)
    for (let k = 1; k < plan.beats.length; k++) expect(plan.beats[k]).toBeGreaterThan(plan.beats[k - 1])
    const ids = new Set<number>()
    let prev = -Infinity
    for (const e of plan.events as SectionEvent[]) {
      expect(e.source).toBe('plan')
      expect(ids.has(e.id)).toBe(false)
      ids.add(e.id)
      expect(e.boundaryTime).toBeGreaterThan(prev)
      prev = e.boundaryTime
      expect(e.boundaryTime).toBeCloseTo(plan.beats[e.boundaryBeat], 9)
      expect((e.boundaryBeat - plan.downbeatPhase) % 4).toBe(0)
      expect(e.phase).toBe(0)
      expect(e.detectedAtTime).toBe(e.boundaryTime)
      for (const v of [e.strength, e.confidence]) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
      for (const v of Object.values(e.feats)) expect(Number.isFinite(v)).toBe(true)
    }
    // segments tile the song
    expect(plan.segments[0].startBar).toBe(0)
    expect(plan.segments[0].startSec).toBe(0)
    for (let k = 1; k < plan.segments.length; k++) {
      expect(plan.segments[k].startBar).toBe(plan.segments[k - 1].endBar)
      expect(plan.segments[k].startSec).toBeCloseTo(plan.segments[k - 1].endSec, 9)
    }
    expect(plan.segments.length).toBe(plan.events.length + 1)
    // a serialise / parse round trip loses nothing (no NaN / Infinity anywhere)
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan)
  }, T)

  it('a 44.1 kHz stimulus (decimation path) gives the same events within a bar and the same tempo', () => {
    const song = STIMULI.verseChorusEqualLoudness({ sampleRate: 44100 })
    const plan = analyzeSong(song.pcm, song.sampleRate)
    expect(plan.diagnostics.analysisSampleRate).toBe(22050)
    expect(Math.abs(plan.bpm / song.bpm - 1)).toBeLessThan(0.01)
    expect(scoreDetectionsBars(positiveTimes(song.truth), detTimes(plan), 1, song.bpm).recall).toBeGreaterThanOrEqual(0.9)
    const ref = run('verseChorusEqualLoudness').plan
    expect(plan.events.length).toBe(ref.events.length)
  }, T)

  it('drumless pads are flagged beatless (arbitrary bar grid), drum stimuli are not', () => {
    expect(run(DRUMLESS).plan.diagnostics.beatless).toBe(true)
    for (const name of DRUMS) expect(run(name).plan.diagnostics.beatless).toBe(false)
    const bpm = run(DRUMLESS).plan.bpm
    expect(bpm).toBeGreaterThanOrEqual(70)
    expect(bpm).toBeLessThan(155)
  }, T)

  it('analysis is fast: a 90 s stimulus well under 3 s', () => {
    const { plan } = run('buildThenDrop')
    expect(plan.diagnostics.analysisMs).toBeLessThan(3000)
  }, T)

  it('is deterministic', () => {
    const song = run('mixed').song
    const a = analyzeSong(song.pcm, song.sampleRate)
    const b = analyzeSong(song.pcm, song.sampleRate)
    a.diagnostics.analysisMs = 0
    b.diagnostics.analysisMs = 0
    expect(a).toEqual(b)
  }, T)
})

describe('analyzeSong on degenerate input', () => {
  it('too-short audio returns an empty plan with a warning, not an exception', () => {
    const p = analyzeSong(new Float32Array(SR * 4), SR)
    expect(p.events).toHaveLength(0)
    expect(p.beats).toHaveLength(0)
    expect(p.diagnostics.warnings.length).toBeGreaterThan(0)
  })

  it('digital silence is reported as silent', () => {
    const p = analyzeSong(new Float32Array(SR * 30), SR)
    expect(p.events).toHaveLength(0)
    expect(p.diagnostics.warnings.join(' ')).toMatch(/silent|few beats/)
  })

  it('white noise runs to completion, finds no pulse to trust and stays JSON-safe', () => {
    let seed = 99
    const x = Float32Array.from({ length: SR * 40 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return (seed / 4294967296 - 0.5) * 0.5
    })
    const p = analyzeSong(x, SR)
    expect(p.diagnostics.tempo.confidence).toBeLessThan(0.5)
    expect(JSON.parse(JSON.stringify(p))).toEqual(p)
  }, T)
})
