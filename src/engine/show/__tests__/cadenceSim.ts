import { LEGACY, sectionStrength } from '../../../audio/events/legacyEvents'
import type { SectionEvent } from '../../../audio/events/types'
import { createShowState, step, type ShowInput } from '../showDirector'

/**
 * Offline cadence simulation for the show director: a long, noisy, realistic `SectionEvent` stream in, the scene-change
 * intervals out, run against an inline model of the LEGACY show for comparison. Shared by `showCadence.test.ts`.
 *
 * Stream (120 BPM by default, one step per beat):
 *  - NOISE: PhraseDetector-style change events arrive as a Poisson process, ~1 per 8 s (`noiseGapSec`), with the
 *    novelty distribution MEASURED on 98 real tracks (1362 edges: p10 0.47, p50 0.58, p90 0.89, p99 1.46, floor 0.45)
 *    pushed through the real legacy mapping (`sectionStrength`, `LEGACY.sectionConfidence`). They carry no musical
 *    meaning for a scene change. (The real detector fires every ~16 s: use `noiseGapSec: 16` for that.)
 *  - TRUE: a strong change every 16-32 bars (novelty 1.1-1.6), through the same mapping. These are the changes a
 *    viewer would expect the scene to follow. (Optimistic: in the real data novelty >= 1.06 is only the top 5% of edges.)
 *  - FALSE DROPS (`dropsPerMin`, default 0): `f.drop` edges as a Poisson process, no build behind them (real tracks:
 *    ~4 per minute overall, median track 2.5, densest 10% over 10, and only ~6% behind a build). Each is a `drop`
 *    event with the real legacy mapping's LONE confidence (`LEGACY.dropConfidence`), and `dropCorroboratedShare` of them
 *    also carry a second signal (`corroborated`, +`LEGACY.corroborationBonus`). This is the input the first version of
 *    this simulation lacked: with it, a drop that scored 0.875 alone cut the scene at nearly every edge after ~5 bars.
 *  - REAL DROPS (`realDropEveryBars`, default 0): a confirmed build (`inBuild` for `buildBars` bars, a `buildStart`
 *    event at its start) that ends in a drop with the build-backed confidence (`LEGACY.dropBuildConfidence`).
 *
 * Commit model (both shows): a scene request commits on the next bar line strictly after it (the SceneManager downbeat
 * gate, which runs before the directors within a frame); a drop CUT of the director's fast lane, and any drop for the
 * legacy show (the only dwell bypass), is immediate.
 */

export interface SimOptions {
  bpm?: number
  beats?: number
  seed?: number
  noiseGapSec?: number
  /** False drops per minute (no build behind them). Default 0. */
  dropsPerMin?: number
  /** Share of the false drops that carry a second signal. Default 0.3. */
  dropCorroboratedShare?: number
  /** A real build + drop every N..1.5N bars (0 = none). Default 0. */
  realDropEveryBars?: number
  /** Length of a real build, bars. Default 8. */
  buildBars?: number
}

export interface SimStream {
  bpm: number
  beats: number
  /** Events by beat (a beat may hold noise and a true event). */
  byBeat: Map<number, SectionEvent[]>
  /** The beats of the TRUE strong events. */
  trueBeats: number[]
  /** Beats of the false drops and of the real (build-backed) drops. */
  falseDropBeats: number[]
  realDropBeats: number[]
  /** Beat ranges [start, end) during which a confirmed build runs (`inBuild`). */
  buildSpans: Array<[number, number]>
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

/** PhraseDetector novelty quantiles (p, novelty), measured on the 98 real tracks; 0.45 is the firing floor. */
const NOVELTY_Q: readonly (readonly [number, number])[] = [
  [0, 0.45],
  [0.05, 0.46],
  [0.1, 0.47],
  [0.25, 0.5],
  [0.5, 0.58],
  [0.75, 0.71],
  [0.9, 0.89],
  [0.95, 1.06],
  [0.99, 1.46],
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

function legacyDrop(id: number, beat: number, spb: number, confidence: number, corroborated: boolean): SectionEvent {
  return {
    id,
    type: 'drop',
    strength: LEGACY.dropStrength,
    confidence,
    boundaryBeat: beat,
    boundaryTime: beat * spb,
    detectedAtBeat: beat,
    detectedAtTime: beat * spb,
    source: 'legacy',
    phase: beat % 4,
    feats: { level: 0, low: 0, timbre: 0, harmony: 0, rhythm: 0 },
    corroborated,
  }
}

function buildStartEvent(id: number, beat: number, spb: number): SectionEvent {
  return {
    id,
    type: 'buildStart',
    strength: LEGACY.buildStrength,
    confidence: LEGACY.buildConfidence,
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
  // False drops (drawn after everything else, so a stream without them is unchanged for a given seed).
  const falseDropBeats: number[] = []
  const dropP = o.dropsPerMin ? (o.dropsPerMin * spb) / 60 : 0
  const corrShare = o.dropCorroboratedShare ?? 0.3
  if (dropP > 0) {
    for (let b = 1; b < beats; b++) {
      if (rnd() < dropP) {
        const corr = rnd() < corrShare
        const conf = Math.min(1, LEGACY.dropConfidence + (corr ? LEGACY.corroborationBonus : 0))
        add(b, legacyDrop(id++, b, spb, conf, corr))
        falseDropBeats.push(b)
      }
    }
  }
  // Real builds that end in a drop.
  const realDropBeats: number[] = []
  const buildSpans: Array<[number, number]> = []
  const every = o.realDropEveryBars ?? 0
  const buildBeats = 4 * (o.buildBars ?? 8)
  if (every > 0) {
    for (let b = 4 * 40 + Math.floor(rnd() * 64); b < beats; b += 4 * (every + Math.floor(rnd() * (every / 2 + 1)))) {
      const bar = b - (b % 4)
      buildSpans.push([bar - buildBeats, bar])
      add(bar - buildBeats, buildStartEvent(id++, bar - buildBeats, spb))
      add(bar, legacyDrop(id++, bar, spb, LEGACY.dropBuildConfidence, true))
      realDropBeats.push(bar)
    }
    // A false-drop edge inside a real build (or right after it) IS that build's release to the real mapper (it grades
    // the edge by the build behind it), so the generator does not also emit it as a lone drop.
    for (const [from, to] of buildSpans) {
      for (let b = from; b <= to + LEGACY.buildLookbackBeats; b++) {
        const list = byBeat.get(b)
        if (!list) continue
        const keep = list.filter((e) => e.type !== 'drop' || e.confidence >= LEGACY.dropBuildConfidence)
        if (keep.length !== list.length) {
          if (keep.length) byBeat.set(b, keep)
          else byBeat.delete(b)
          const k = falseDropBeats.indexOf(b)
          if (k >= 0) falseDropBeats.splice(k, 1)
        }
      }
    }
  }
  return { bpm, beats, byBeat, trueBeats, falseDropBeats, realDropBeats, buildSpans }
}

export interface SimResult {
  /** Beats at which a scene committed (the first scene is not counted). */
  commits: number[]
  /** The director's CUT reasons (or 'legacy'), aligned with `commits`. */
  reasons: string[]
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
  let sceneStart = Number.NEGATIVE_INFINITY
  let span = 0
  for (let b = 0; b < stream.beats; b++) {
    while (span < stream.buildSpans.length && stream.buildSpans[span][1] <= b) span++
    inp.inBuild = span < stream.buildSpans.length && b >= stream.buildSpans[span][0]
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
        if (pendingCommit === b) {
          sceneStart = b
          commits.push(b)
          reasons.push(pendingReason)
          pendingCommit = -1
        }
      }
    }
  }
  return { commits, reasons }
}

/**
 * The legacy show, reduced to the arithmetic the plan describes (`store.ts:154,259,1163`, `PerformanceDirector.tsx:
 * 249-256`, `AutoPilot.tsx:609-631`): every edge (a noise event or a true one, indistinguishable to it) is a trigger;
 * a trigger is honoured only when the 32-beat dwell since the last commit has elapsed, and is otherwise CONSUMED and
 * discarded. The level-type triggers survive the dwell: the 25 s stale timer (since the last request) and the armed
 * scene's age trigger (48 beats on screen, at a phrase edge = beat % 16 === 0). A honoured trigger commits on the next
 * bar line. A drop is the only dwell bypass: it commits at once, whatever the dwell says.
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
    const evs = stream.byBeat.get(b)
    if (evs && evs.some((e) => e.type === 'drop')) {
      lastTrigger = b
      lastCommit = b
      commits.push(b)
      pendingCommit = -1
      continue
    }
    let trigger = evs !== undefined
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
  return { commits, reasons: commits.map(() => 'legacy') }
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
