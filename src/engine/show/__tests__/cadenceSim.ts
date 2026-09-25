import { LEGACY, sectionStrength } from '../../../audio/events/legacyEvents'
import type { SectionEvent } from '../../../audio/events/types'
import { createShowState, step, type ShowInput } from '../showDirector'

/**
 * Offline cadence simulation for the show director: a long, noisy, realistic `SectionEvent` stream in, the scene-change
 * intervals out, run against an inline model of the LEGACY show for comparison. Shared by `showCadence.test.ts`.
 *
 * Stream (120 BPM by default, one step per beat):
 *  - NOISE: PhraseDetector-style change events arrive as a Poisson process, ~1 per 8 s (`noiseGapSec`), with the
 *    measured `sectionChangeStrength` distribution (p10 0.48, p50 0.64, p90 1.11, floor 0.45) pushed through the real
 *    legacy mapping (`sectionStrength`, `LEGACY.sectionConfidence`). They carry no musical meaning for a scene change.
 *  - TRUE: a strong change every 16-32 bars (novelty 1.1-1.6), through the same mapping. These are the changes a
 *    viewer would expect the scene to follow.
 *
 * Commit model (both shows): a scene request commits on the next bar line strictly after it (the SceneManager downbeat
 * gate, which runs before the directors within a frame); a drop is immediate (none appear in this stream).
 */

export interface SimOptions {
  bpm?: number
  beats?: number
  seed?: number
  noiseGapSec?: number
}

export interface SimStream {
  bpm: number
  beats: number
  /** Events by beat (a beat may hold noise and a true event). */
  byBeat: Map<number, SectionEvent[]>
  /** The beats of the TRUE strong events. */
  trueBeats: number[]
}

export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** PhraseDetector novelty quantiles (p, novelty): measured p10 0.48, p50 0.64, p90 1.11; 0.45 is the firing floor. */
const NOVELTY_Q: readonly (readonly [number, number])[] = [
  [0, 0.45],
  [0.1, 0.48],
  [0.5, 0.64],
  [0.9, 1.11],
  [0.99, 1.6],
  [1, 2.2],
]

export function sampleNovelty(u: number): number {
  for (let k = 1; k < NOVELTY_Q.length; k++) {
    const [p1, v1] = NOVELTY_Q[k]
    if (u <= p1) {
      const [p0, v0] = NOVELTY_Q[k - 1]
      return v0 + ((v1 - v0) * (u - p0)) / (p1 - p0)
    }
  }
  return NOVELTY_Q[NOVELTY_Q.length - 1][1]
}

function legacyChange(id: number, beat: number, spb: number, novelty: number): SectionEvent {
  return {
    id,
    type: 'change',
    strength: sectionStrength(novelty),
    confidence: LEGACY.sectionConfidence,
    boundaryBeat: beat,
    boundaryTime: beat * spb,
    detectedAtBeat: beat,
    detectedAtTime: beat * spb,
    source: 'legacy',
    phase: beat % 4,
    feats: { level: 0, low: 0, timbre: 0, harmony: 0, rhythm: 0 },
  }
}

export function makeStream(o: SimOptions = {}): SimStream {
  const bpm = o.bpm ?? 120
  const beats = o.beats ?? 24000
  const spb = 60 / bpm
  const rnd = rng(o.seed ?? 1)
  const noiseP = spb / (o.noiseGapSec ?? 8) // per-beat probability of a noise event (Poisson thinned to beats)
  const byBeat = new Map<number, SectionEvent[]>()
  const trueBeats: number[] = []
  let id = 1
  const add = (beat: number, ev: SectionEvent) => {
    const list = byBeat.get(beat)
    if (list) list.push(ev)
    else byBeat.set(beat, [ev])
  }
  for (let b = 1; b < beats; b++) if (rnd() < noiseP) add(b, legacyChange(id++, b, spb, sampleNovelty(rnd())))
  // True strong changes: every 16-32 bars, on a bar line.
  for (let b = 64 + Math.floor(rnd() * 64); b < beats; b += 4 * (16 + Math.floor(rnd() * 17))) {
    const bar = b - (b % 4)
    trueBeats.push(bar)
    add(bar, legacyChange(id++, bar, spb, 1.1 + rnd() * 0.5))
  }
  return { bpm, beats, byBeat, trueBeats }
}

export interface SimResult {
  /** Beats at which a scene committed (the first scene is not counted). */
  commits: number[]
  /** The director's CUT reasons (or 'legacy'), aligned with `commits`. */
  reasons: string[]
  forced: number
}

/**
 * The bar line a request made on `beat` commits on: strictly AFTER it. SceneManager checks for a pending scene at
 * priority -100, before the directors of the same frame, so a request made on a downbeat frame waits a whole bar.
 */
const nextBar = (beat: number): number => beat + 4 - (beat % 4)

/** Run the show director over the stream. */
export function runDirector(stream: SimStream): SimResult {
  const spb = 60 / stream.bpm
  const st = createShowState()
  const inp: ShowInput = {
    beat: 0,
    time: 0,
    bpm: stream.bpm,
    sceneStartBeat: Number.NEGATIVE_INFINITY,
    sceneStartTime: Number.NEGATIVE_INFINITY,
    event: null,
    barLine: false,
    inBreakdown: false,
    inBuild: false,
    moodChanged: false,
    characterShift: false,
    moodPredicted: false,
    trendRising: false,
  }
  const commits: number[] = []
  const reasons: string[] = []
  let pendingCommit = -1
  let pendingReason = ''
  let forced = 0
  let sceneStart = Number.NEGATIVE_INFINITY
  for (let b = 0; b < stream.beats; b++) {
    if (pendingCommit === b) {
      sceneStart = b
      commits.push(b)
      reasons.push(pendingReason)
      pendingCommit = -1
    }
    inp.beat = b
    inp.time = b * spb
    inp.sceneStartBeat = sceneStart
    inp.sceneStartTime = sceneStart * spb
    inp.barLine = b % 4 === 3 // the last beat of a bar: a request now commits on the next bar line
    const evs = stream.byBeat.get(b)
    const n = evs ? evs.length : 0
    for (let k = 0; k < Math.max(1, n); k++) {
      inp.event = evs && k < n ? evs[k] : null
      const a = step(st, inp)
      if (a.kind === 'CUT' && pendingCommit < 0) {
        pendingCommit = a.immediate ? b : nextBar(b)
        pendingReason = a.reason
        if (a.forced) forced++
        if (pendingCommit === b) {
          sceneStart = b
          commits.push(b)
          reasons.push(pendingReason)
          pendingCommit = -1
        }
      }
    }
  }
  return { commits, reasons, forced }
}

/**
 * The legacy show, reduced to the arithmetic the plan describes (`store.ts:154,259,1163`, `PerformanceDirector.tsx:
 * 249-256`, `AutoPilot.tsx:609-631`): every edge (a noise event or a true one, indistinguishable to it) is a trigger;
 * a trigger is honoured only when the 32-beat dwell since the last commit has elapsed, and is otherwise CONSUMED and
 * discarded. The level-type triggers survive the dwell: the 25 s stale timer (since the last request) and the armed
 * scene's age trigger (48 beats on screen, at a phrase edge = beat % 16 === 0). A honoured trigger commits on the next
 * bar line.
 */
export function runLegacy(stream: SimStream): SimResult {
  const spb = 60 / stream.bpm
  const staleBeats = 25 / spb
  const commits: number[] = []
  let lastCommit = Number.NEGATIVE_INFINITY
  let lastTrigger = 0
  let pendingCommit = -1
  for (let b = 0; b < stream.beats; b++) {
    if (pendingCommit === b) {
      lastCommit = b
      commits.push(b)
      pendingCommit = -1
    }
    let trigger = stream.byBeat.has(b)
    if (!trigger && b - lastTrigger >= staleBeats) trigger = true
    if (!trigger && b % 16 === 0 && b - lastCommit >= 48) trigger = true
    if (!trigger) continue
    lastTrigger = b
    if (pendingCommit >= 0) continue
    if (b - lastCommit >= 32 || lastCommit === Number.NEGATIVE_INFINITY) {
      pendingCommit = nextBar(b)
      if (pendingCommit === b) {
        lastCommit = b
        commits.push(b)
        pendingCommit = -1
      }
    }
  }
  return { commits, reasons: commits.map(() => 'legacy'), forced: 0 }
}

/** Median of the gaps between consecutive commits, in bars. */
export function medianBars(commits: readonly number[]): number {
  const gaps: number[] = []
  for (let k = 1; k < commits.length; k++) gaps.push((commits[k] - commits[k - 1]) / 4)
  gaps.sort((a, b) => a - b)
  return gaps.length === 0 ? 0 : gaps[Math.floor(gaps.length / 2)]
}

export function gapPercentile(commits: readonly number[], p: number): number {
  const gaps: number[] = []
  for (let k = 1; k < commits.length; k++) gaps.push((commits[k] - commits[k - 1]) / 4)
  gaps.sort((a, b) => a - b)
  return gaps.length === 0 ? 0 : gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))]
}

/** Share of TRUE events answered by a commit within one bar (0..4 beats) of the event. */
export function hitRate(commits: readonly number[], trueBeats: readonly number[]): number {
  if (trueBeats.length === 0) return 0
  const set = new Set(commits)
  let hits = 0
  for (const e of trueBeats) {
    for (let d = 0; d <= 4; d++) {
      if (set.has(e + d)) {
        hits++
        break
      }
    }
  }
  return hits / trueBeats.length
}
