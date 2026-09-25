/**
 * SYNTHETIC-STRUCTURE baseline (plan phase 0B, `so-the-mood-analysis-lively-hickey.md`): scores TODAY's structure
 * detectors against songs whose section changes are known to the sample.
 *
 * Every stimulus in the catalogue (`src/audio/eval/synthSong.ts`: build+drop, breakdown, verse/chorus and key change
 * at equal loudness, a gradual morph, fills, a +6/-6 dB knob, silence gaps, tempo drift, drumless ambient, A B A B',
 * a full mixed song) is synthesised and run through `runTrack` (the offline mirror of `AudioEngine.update()`, so the
 * AGC normaliser, phrase detector, drop heuristics, `StructureAnalyzer` and `SectionTracker` all see it exactly as
 * they see a real decode). What each CURRENT detector reports is then scored against the truth with
 * `src/audio/eval/structureMetrics.ts`:
 *
 *   sectionChange        f.sectionChange rising edges (PhraseDetector; the 21-consumer "fast" section flag)
 *   drop                 f.drop rising edges (broadband ratio test + DropStateMachine), scored against `drop` truth
 *   structure.boundaries StructureAnalyzer boundaries as first PUBLISHED (claimed time = the boundary's beat,
 *                        detected-at = the batch that first reported it)
 *   songSection.boundary SectionTracker `boundaryChanged` (kind-change only: verse->chorus is silent by design)
 *   mood.changed         f.mood.changed (one of the independent scene-switch triggers today; informational)
 *   buildUp / structure.build / songSection.isBuild   build flags, scored per true build window (buildStart -> drop)
 *
 * Point detectors: recall within +-1 bar (claimed time vs truth, one-to-one), a CAUSAL recall (detected-at within
 * [-1, +4] bars of the truth), false alarms per minute (unmatched detections, both windows), detections landing near
 * NEGATIVE events (fills, gain steps, silence gaps, morph steps), and lag = detected-at - truth over the causal pairs.
 * Every truth event is scored, but the aggregate also shows recall for events at or after 25 s (the beat tracker needs
 * ~8 s and `StructureAnalyzer` ~20-25 s before its first batch). Detections in the first second (start-up state
 * initialisation, e.g. the initial `mood.changed`) are ignored.
 *
 * PART B (real timbres, known join): `SYNTH_SPLICE` pairs of corpus tracks are cut at beat lines and joined with
 * `spliceTracks`; the joins are truth, scored by the same detectors.
 *
 *   node --max-old-space-size=3072 ./node_modules/vitest/vitest.mjs run --config vitest.calibration.config.ts scripts/calibrate/synth-structure.calib.ts
 *
 * Knobs: SYNTH_ONLY=a,b      only these catalogue stimuli (default all 12)
 *        SYNTH_SR=n          synthesis sample rate (default 44100, what mp3 decodes arrive at)
 *        SYNTH_SEED=n        synthesis seed and corpus sampling seed (default 1)
 *        SYNTH_SPLICE=n      spliced real-audio pairs from corpus/audio (default 2; 0 = skip part B)
 *        SYNTH_SPLICE_BEATS=n beats per spliced segment (default 32)
 *
 * Output (gitignored; the splice section derives from non-commercial audio): corpus/structure/synth-baseline.md + .json
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { spliceTracks } from '../../src/audio/eval/spliceTracks'
import {
  barsToSec,
  detectionsNearEvents,
  intervalStats,
  lagStats,
  matchEvents,
  percentile,
} from '../../src/audio/eval/structureMetrics'
import { STIMULI, STIMULUS_NAMES, type StimulusName, type TruthEvent, type TruthEventType } from '../../src/audio/eval/synthSong'
import { decodeMp3File } from './decode'
import { runTrack, type TrackRunResult } from './features'
import { rng } from './stats'

const ROOT = resolve(__dirname, '../..')
const AUDIO_DIR = join(ROOT, 'corpus/audio')
const OUT_DIR = join(ROOT, 'corpus/structure')
const OUT_MD = join(OUT_DIR, 'synth-baseline.md')
const OUT_JSON = join(OUT_DIR, 'synth-baseline.json')

const ONLY = (process.env.SYNTH_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const SR = Number(process.env.SYNTH_SR) || 44100
const SEED = Number(process.env.SYNTH_SEED) || 1
const SPLICE_PAIRS = process.env.SYNTH_SPLICE === undefined ? 2 : Math.max(0, Number(process.env.SYNTH_SPLICE) || 0)
const SPLICE_BEATS = Math.max(8, Number(process.env.SYNTH_SPLICE_BEATS) || 32)
/** Events at/after this time are the fair test for the slow detectors (see the header). */
const POST_WARMUP_SEC = 25
/** Detections earlier than this are start-up initialisation, not detections. */
const MIN_DET_SEC = 1
/** `runTrack` reports frame time as the analysis window START; the audio clock is `FFT_SIZE / sampleRate` later. */
const FFT_SIZE = 2048
/** `SectionTracker` is stepped by `runTrack` (phase 0C); `trace` exposes its per-frame output. */
const HOOKS = { dropStateMachine: true, trace: true } as const

/* ------------------------------------------------------------------------------------------------
 * Detector extraction
 * ---------------------------------------------------------------------------------------------- */

interface DetectorTrace {
  id: string
  label: string
  kind: 'point' | 'interval'
  /** Point detectors: truth types scored for recall (default: every positive). */
  recallTypes?: TruthEventType[]
  /** Claimed event times / times the detector reported them (audio clock, seconds). */
  claims: number[]
  ats: number[]
  /** Interval detectors: the per-frame flag. */
  active?: Uint8Array
  available: boolean
  note?: string
}

function risingEdges(n: number, at: (i: number) => boolean, toSec: (i: number) => number): number[] {
  const out: number[] = []
  let prev = false
  for (let i = 0; i < n; i++) {
    const v = at(i)
    if (v && !prev && toSec(i) >= MIN_DET_SEC) out.push(toSec(i))
    prev = v
  }
  return out
}

function extractDetectors(run: TrackRunResult, sr: number): DetectorTrace[] {
  const off = FFT_SIZE / sr
  const frames = run.frames
  const toSec = (i: number) => frames[i].t + off
  const n = frames.length
  const beatT = new Map<number, number>()
  for (const b of run.beats) beatT.set(b.beatIndex, b.t + off)
  const beatIdx = [...beatT.keys()].sort((a, b) => a - b)
  const spb = 60 / Math.max(1, percentile(frames.filter((f) => f.t > 10).map((f) => f.bpm), 0.5) || 120)
  const beatTime = (idx: number): number | null => {
    const direct = beatT.get(idx)
    if (direct !== undefined) return direct
    if (beatIdx.length === 0) return null
    const hi = beatIdx[beatIdx.length - 1]
    return idx > hi ? (beatT.get(hi) as number) + (idx - hi) * spb : null
  }
  const out: DetectorTrace[] = []
  const flag = (id: string, label: string, series: (i: number) => boolean, recallTypes?: TruthEventType[]) => {
    const t = risingEdges(n, series, toSec)
    out.push({ id, label, kind: 'point', recallTypes, claims: t, ats: t, available: true })
  }
  flag('sectionChange', 'f.sectionChange edges', (i) => frames[i].sectionChange)
  flag('drop', 'f.drop edges (vs drop truth)', (i) => frames[i].drop, ['drop'])

  const tr = run.trace
  // StructureAnalyzer boundaries as first published.
  {
    const claims: number[] = []
    const ats: number[] = []
    if (tr) {
      for (const b of tr.analyserBoundaries) {
        const c = beatTime(b.beat)
        if (c === null) continue
        claims.push(c)
        ats.push(toSec(Math.min(n - 1, b.seenFrame)))
      }
    } else {
      // Fallback without the trace: first structureRun containing a boundary >2 beats from every earlier one.
      const seen: number[] = []
      for (const raw of run.structureRuns) {
        const at = beatTime(raw.atBeat)
        for (const b of raw.boundaries) {
          if (seen.some((s) => Math.abs(s - b) <= 2)) continue
          seen.push(b)
          const c = beatTime(b)
          if (c !== null && at !== null) {
            claims.push(c)
            ats.push(at)
          }
        }
      }
    }
    out.push({ id: 'structure.boundaries', label: 'StructureAnalyzer boundaries (claimed = boundary beat)', kind: 'point', claims, ats, available: true })
  }
  if (tr) {
    const bc = tr.cols.boundaryChanged
    const t = risingEdges(tr.n, (i) => bc[i] === 1, toSec)
    out.push({ id: 'songSection.boundary', label: 'songSection.boundaryChanged (SectionTracker)', kind: 'point', claims: t, ats: t, available: true })
    const mc = tr.cols.moodChanged
    const m = risingEdges(tr.n, (i) => mc[i] === 1, toSec)
    out.push({ id: 'mood.changed', label: 'f.mood.changed (informational)', kind: 'point', claims: m, ats: m, available: true })
  } else {
    out.push({
      id: 'songSection.boundary',
      label: 'songSection.boundaryChanged',
      kind: 'point',
      claims: [],
      ats: [],
      available: false,
      note: 'GAP: runTrack returned no `trace` (StepHooks.trace missing), so SectionTracker output is not visible here',
    })
  }
  const interval = (id: string, label: string, series: Uint8Array | null, note?: string) => {
    out.push({ id, label, kind: 'interval', claims: [], ats: [], active: series ?? new Uint8Array(n), available: series !== null, note })
  }
  interval('buildUp', 'f.buildUp (fast broadband climb)', Uint8Array.from(frames, (f) => (f.buildUp ? 1 : 0)))
  interval('structure.build', 'StructureAnalyzer build.active', Uint8Array.from(frames, (f) => (f.structureBuildActive ? 1 : 0)))
  interval('songSection.isBuild', 'songSection.isBuild', tr ? Uint8Array.from(tr.cols.isBuild) : null, tr ? undefined : 'GAP: no trace')
  return out
}

/* ------------------------------------------------------------------------------------------------
 * Scoring
 * ---------------------------------------------------------------------------------------------- */

interface EventOutcome {
  type: TruthEventType
  timeSec: number
  bar: number
  hitStrict: boolean
  hitCausal: boolean
  /** detected-at minus truth for a causal match (positive = late). */
  lagSec: number | null
  /** Claimed time of the strict match minus truth (position error). */
  posErrSec: number | null
}

interface DetResult {
  stimulus: string
  detector: string
  label: string
  kind: 'point' | 'interval'
  available: boolean
  note?: string
  bpm: number
  durationSec: number
  nDet: number
  nTruth: number
  hitsStrict: number
  hitsCausal: number
  /** unmatched detections (point) / rising edges outside every true window (interval) */
  faStrict: number
  faCausal: number
  negNear: number
  negTotal: number
  lags: number[]
  events: EventOutcome[]
  detTimes: number[]
  /** Claimed event times when they differ from `detTimes` (retrospective boundaries). */
  claimTimes?: number[]
  /** interval detectors only */
  coverage?: number
  outsideShare?: number
}

interface Scored {
  stimulus: string
  bpm: number
  estBpm: number
  durationSec: number
  truth: TruthEvent[]
  results: DetResult[]
}

function scoreOne(stimulus: string, truth: TruthEvent[], bpm: number, durationSec: number, det: DetectorTrace): DetResult {
  const strict = barsToSec(1, bpm)
  const causal = { before: strict, after: barsToSec(4, bpm) }
  /** Tighter window for "did it fire because of a fill / gain step / gap": [-0.5, +2.5] bars. */
  const negWin = { before: barsToSec(0.5, bpm), after: barsToSec(2.5, bpm) }
  const base = {
    stimulus,
    detector: det.id,
    label: det.label,
    kind: det.kind,
    available: det.available,
    note: det.note,
    bpm,
    durationSec,
  }
  const neg = truth.filter((t) => !t.shouldTrigger).map((t) => t.timeSec)
  if (det.kind === 'point') {
    const pos = truth.filter((t) => t.shouldTrigger && (!det.recallTypes || det.recallTypes.includes(t.type)))
    const posAll = truth.filter((t) => t.shouldTrigger)
    const P = pos.map((t) => t.timeSec)
    const mS = matchEvents(P, det.claims, strict)
    const mC = matchEvents(P, det.ats, causal)
    const faS = det.claims.length - matchEvents(posAll.map((t) => t.timeSec), det.claims, strict).pairs.length
    const faC = det.ats.length - matchEvents(posAll.map((t) => t.timeSec), det.ats, causal).pairs.length
    const events: EventOutcome[] = pos.map((t, i) => {
      const ps = mS.pairs.find((p) => p.truthIndex === i)
      const pc = mC.pairs.find((p) => p.truthIndex === i)
      return {
        type: t.type,
        timeSec: t.timeSec,
        bar: t.bar,
        hitStrict: !!ps,
        hitCausal: !!pc,
        lagSec: pc ? pc.lag : null,
        posErrSec: ps ? ps.lag : null,
      }
    })
    return {
      ...base,
      nDet: det.claims.length,
      nTruth: pos.length,
      hitsStrict: mS.pairs.length,
      hitsCausal: mC.pairs.length,
      faStrict: faS,
      faCausal: faC,
      negNear: detectionsNearEvents(neg, det.ats, negWin),
      negTotal: neg.length,
      lags: mC.pairs.map((p) => p.lag),
      events,
      detTimes: det.ats,
      ...(det.claims.some((c, i) => Math.abs(c - det.ats[i]) > 1e-9) ? { claimTimes: det.claims } : {}),
    }
  }
  // interval detector: true builds = buildStart -> the next drop (or +16 bars)
  const builds = truth
    .filter((t) => t.type === 'buildStart' && t.shouldTrigger)
    .map((b) => {
      const d = truth.find((t) => t.type === 'drop' && t.timeSec > b.timeSec)
      return { t: b, start: b.timeSec, end: d ? d.timeSec : b.timeSec + barsToSec(16, bpm) }
    })
  const active = det.active as Uint8Array
  const frameSec = (i: number) => i / 60 // `active` was pre-shifted onto the audio clock by scoreRun
  const edges: number[] = []
  for (let i = 0; i < active.length; i++) if (active[i] && !(i > 0 && active[i - 1])) edges.push(frameSec(i))
  const events: EventOutcome[] = builds.map((b) => {
    const e = edges.find((x) => x >= b.start - strict && x <= b.end)
    return {
      type: 'buildStart',
      timeSec: b.start,
      bar: b.t.bar,
      hitStrict: e !== undefined,
      hitCausal: e !== undefined,
      lagSec: e !== undefined ? e - b.start : null,
      posErrSec: null,
    }
  })
  const inWindow = (t: number) => builds.some((b) => t >= b.start - strict && t <= b.end + strict)
  const fa = edges.filter((t) => !inWindow(t)).length
  let inN = 0
  let inAct = 0
  let outN = 0
  let outAct = 0
  for (let i = 0; i < active.length; i++) {
    const t = frameSec(i)
    if (builds.some((b) => t >= b.start && t <= b.end)) {
      inN++
      inAct += active[i]
    } else {
      outN++
      outAct += active[i]
    }
  }
  return {
    ...base,
    nDet: edges.length,
    nTruth: builds.length,
    hitsStrict: events.filter((e) => e.hitStrict).length,
    hitsCausal: events.filter((e) => e.hitCausal).length,
    faStrict: fa,
    faCausal: fa,
    negNear: 0,
    negTotal: neg.length,
    lags: events.filter((e) => e.lagSec !== null).map((e) => e.lagSec as number),
    events,
    detTimes: edges,
    coverage: inN > 0 ? inAct / inN : NaN,
    outsideShare: outN > 0 ? outAct / outN : NaN,
  }
}

function scoreRun(stimulus: string, truth: TruthEvent[], bpm: number, run: TrackRunResult, sr: number, durationSec: number): Scored {
  const dets = extractDetectors(run, sr)
  // Interval detectors work on frame time; shift frame index -> audio clock inside scoreOne via a shifted copy.
  const shifted = dets.map((d) => {
    if (d.kind !== 'interval' || !d.active) return d
    // Prepend zero frames so index/60 lands on the audio clock (FFT_SIZE / sr later than the frame start).
    const lead = Math.round((FFT_SIZE / sr) * 60)
    const a = new Uint8Array(d.active.length + lead)
    a.set(d.active, lead)
    return { ...d, active: a }
  })
  const late = run.frames.filter((f) => f.t > 15).map((f) => f.bpm)
  return {
    stimulus,
    bpm,
    estBpm: late.length ? percentile(late, 0.5) : NaN,
    durationSec,
    truth,
    results: shifted.map((d) => scoreOne(stimulus, truth, bpm, durationSec, d)),
  }
}

/* ------------------------------------------------------------------------------------------------
 * Report
 * ---------------------------------------------------------------------------------------------- */

const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '-')
const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '-')
const pct = (num: number, den: number) => (den > 0 ? `${((100 * num) / den).toFixed(0)}% (${num}/${den})` : '-')

const NEG_ONLY = new Set<string>(['fillsOnly', 'gainStep', 'silenceGap'])

function aggregate(rows: Scored[], title: string, L: string[]): unknown {
  const detectors = rows.length ? rows[0].results.map((r) => r.detector) : []
  L.push(`### ${title}`, '')
  L.push(
    '| detector | truth | recall +-1 bar | recall causal | recall +-1 bar, >=25 s | recall causal, >=25 s | FA/min (+-1 bar) | FA/min (causal) | FA/min on negative-only stimuli | dets near negatives / negatives | lag median s (p90) [n] |',
  )
  L.push('|---|---|---|---|---|---|---|---|---|---|---|')
  const json: Record<string, unknown> = {}
  for (const id of detectors) {
    const rs = rows.map((r) => r.results.find((x) => x.detector === id) as DetResult)
    const first = rs[0]
    if (!first.available) {
      L.push(`| ${id} | ${first.note ?? 'unavailable'} | | | | | | | | | |`)
      continue
    }
    const nTruth = rs.reduce((s, r) => s + r.nTruth, 0)
    const hs = rs.reduce((s, r) => s + r.hitsStrict, 0)
    const hc = rs.reduce((s, r) => s + r.hitsCausal, 0)
    const ev = rs.flatMap((r) => r.events).filter((e) => e.timeSec >= POST_WARMUP_SEC)
    const evS = ev.filter((e) => e.hitStrict).length
    const evC = ev.filter((e) => e.hitCausal).length
    const minutes = rs.reduce((s, r) => s + r.durationSec / 60, 0)
    const faS = rs.reduce((s, r) => s + r.faStrict, 0)
    const faC = rs.reduce((s, r) => s + r.faCausal, 0)
    const negRs = rs.filter((r) => NEG_ONLY.has(r.stimulus))
    const negMin = negRs.reduce((s, r) => s + r.durationSec / 60, 0)
    const negDets = negRs.reduce((s, r) => s + r.nDet, 0)
    const negNear = rs.reduce((s, r) => s + r.negNear, 0)
    const negTotal = rs.reduce((s, r) => s + r.negTotal, 0)
    const lag = lagStats(rs.flatMap((r) => r.lags).map((lag) => ({ lag })))
    L.push(
      `| ${id} | ${nTruth} | ${pct(hs, nTruth)} | ${pct(hc, nTruth)} | ${pct(evS, ev.length)} | ${pct(evC, ev.length)} | ${f2(faS / minutes)} | ${f2(faC / minutes)} | ${negMin > 0 ? f2(negDets / negMin) : '-'} | ${first.kind === 'interval' ? '-' : `${negNear}/${negTotal}`} | ${f1(lag.median)} (${f1(lag.p90)}) [${lag.n}] |`,
    )
    json[id] = { nTruth, hitsStrict: hs, hitsCausal: hc, postWarmup: { n: ev.length, strict: evS, causal: evC }, faPerMinStrict: faS / minutes, faPerMinCausal: faC / minutes, negOnlyDetsPerMin: negMin > 0 ? negDets / negMin : null, negNear, negTotal, lag }
  }
  L.push('')
  return json
}

function perStimulus(s: Scored, L: string[]): void {
  L.push(`### ${s.stimulus}`, '')
  const pos = s.truth.filter((t) => t.shouldTrigger).length
  L.push(
    `bpm ${f1(s.bpm)} (tracker median ${f1(s.estBpm)}), ${f1(s.durationSec)} s, ${pos} positive / ${s.truth.length - pos} negative truth events.`,
    '',
  )
  L.push('| detector | dets | recall +-1 bar | recall causal | FA +-1 bar | FA causal | near negatives | lag median s (p90) | detection times (s) |')
  L.push('|---|---|---|---|---|---|---|---|---|')
  for (const r of s.results) {
    if (!r.available) {
      L.push(`| ${r.detector} | ${r.note ?? 'unavailable'} | | | | | | | |`)
      continue
    }
    const lag = lagStats(r.lags.map((lag) => ({ lag })))
    const shown = r.detTimes.map((t, i) => (r.claimTimes ? `${f1(r.claimTimes[i])}@${f1(t)}` : f1(t)))
    const times = shown.length > 24 ? `${shown.slice(0, 24).join(' ')} ... (+${shown.length - 24})` : shown.join(' ')
    const share = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : '-')
    const cov = r.kind === 'interval' ? ` cov ${share(r.coverage)} / outside ${share(r.outsideShare)}` : ''
    L.push(
      `| ${r.detector} | ${r.nDet} | ${r.nTruth ? `${r.hitsStrict}/${r.nTruth}` : '-'} | ${r.nTruth ? `${r.hitsCausal}/${r.nTruth}` : '-'} | ${r.faStrict} | ${r.faCausal} | ${r.kind === 'interval' ? '-' : `${r.negNear}/${r.negTotal}`} | ${f1(lag.median)} (${f1(lag.p90)}) | ${times}${cov} |`,
    )
  }
  L.push('')
  // truth events with the per-detector outcome
  const tags = s.results.filter((r) => r.available)
  L.push(`| truth event | s | bar | ${tags.map((r) => r.detector).join(' | ')} |`)
  L.push(`|---|---|---|${tags.map(() => '---').join('|')}|`)
  for (const t of s.truth) {
    const cells = tags.map((r) => {
      const e = r.events.find((x) => Math.abs(x.timeSec - t.timeSec) < 1e-9 && (r.kind === 'point' ? x.type === t.type : true))
      if (!t.shouldTrigger) {
        const near = r.kind === 'point' ? r.detTimes.filter((d) => d >= t.timeSec - barsToSec(0.5, s.bpm) && d <= t.timeSec + barsToSec(2.5, s.bpm)).length : 0
        return r.kind === 'point' ? (near ? `FIRED x${near}` : 'quiet') : '-'
      }
      if (!e) return '-'
      return e.hitCausal ? `${e.hitStrict ? 'hit' : 'late'} ${e.lagSec !== null ? `${e.lagSec >= 0 ? '+' : ''}${e.lagSec.toFixed(1)}s` : ''}` : 'MISS'
    })
    L.push(`| ${t.type}${t.shouldTrigger ? '' : ' (neg)'}${t.note ? ` [${t.note}]` : ''} | ${f1(t.timeSec)} | ${t.bar} | ${cells.join(' | ')} |`)
  }
  L.push('')
}

/* ------------------------------------------------------------------------------------------------
 * Tests
 * ---------------------------------------------------------------------------------------------- */

const synthScored: Scored[] = []
const spliceScored: Scored[] = []
const t0 = Date.now()

function indexMp3(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((n) => /\.mp3$/i.test(n)).sort().map((n) => join(dir, n)) : []
}

function shuffled<T>(items: T[], seed: number): T[] {
  const idx = items.map((_, i) => i)
  const r = rng(seed)
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[idx[i], idx[j]] = [idx[j], idx[i]]
  }
  return idx.map((i) => items[i])
}

const names = STIMULUS_NAMES.filter((n) => ONLY.length === 0 || ONLY.includes(n))

describe('synthetic structure baseline', () => {
  for (const name of names) {
    it(
      `${name}: run through runTrack and score the current detectors`,
      () => {
        const s = STIMULI[name as StimulusName]({ sampleRate: SR, seed: SEED })
        const run = runTrack(s.pcm, s.sampleRate, HOOKS)
        const scored = scoreRun(name, s.truth, s.bpm, run, s.sampleRate, s.songEndSec)
        synthScored.push(scored)
        console.log(`  ${name}: ${s.songEndSec.toFixed(0)} s, ${((Date.now() - t0) / 1000).toFixed(0)} s elapsed`)
        expect(run.frames.length).toBeGreaterThan(1000)
      },
      15 * 60 * 1000,
    )
  }

  const files = SPLICE_PAIRS > 0 ? indexMp3(AUDIO_DIR) : []
  it.skipIf(SPLICE_PAIRS === 0 || files.length < 2)(
    `B. spliced real audio: ${SPLICE_PAIRS} pair(s) joined at beat lines`,
    async () => {
      const order = shuffled(files, SEED)
      for (let p = 0; p < SPLICE_PAIRS && 2 * p + 1 < order.length; p++) {
        const grid = async (path: string) => {
          const audio = await decodeMp3File(path)
          const start = Math.min(30 * audio.sampleRate, Math.max(0, audio.pcm.length - 60 * audio.sampleRate))
          const pcm = audio.pcm.slice(start, start + 60 * audio.sampleRate)
          // A beat grid from the tracker itself (structure off: only the grid matters here).
          const g = runTrack(pcm, audio.sampleRate, { skipStructure: true })
          const off = FFT_SIZE / audio.sampleRate
          const beatTimes = g.beats.filter((b) => b.t >= 8).map((b) => b.t + off)
          const bpm = percentile(g.frames.filter((f) => f.t > 10).map((f) => f.bpm), 0.5)
          return { pcm, sampleRate: audio.sampleRate, beatTimes, bpm, id: path.replace(/^.*[\\/]/, '').replace(/\.mp3$/i, '') }
        }
        try {
          const a = await grid(order[2 * p])
          const b = await grid(order[2 * p + 1])
          const per = Math.min(SPLICE_BEATS, Math.floor((Math.min(a.beatTimes.length, b.beatTimes.length) - 1) / 2))
          if (per < 8) {
            console.log(`  skip pair ${a.id}+${b.id}: only ${a.beatTimes.length}/${b.beatTimes.length} tracked beats`)
            continue
          }
          const st = spliceTracks(a, b, { beatsPerSegment: per, segmentCount: 4 })
          const run = runTrack(st.pcm, st.sampleRate, HOOKS)
          const bpm = (a.bpm + b.bpm) / 2
          const scored = scoreRun(`splice ${a.id}+${b.id}`, st.truth, bpm, run, st.sampleRate, st.durationSec)
          spliceScored.push(scored)
          console.log(`  splice ${a.id}(${f1(a.bpm)} bpm)+${b.id}(${f1(b.bpm)} bpm): ${per} beats/segment, ${st.durationSec.toFixed(0)} s`)
        } catch (e) {
          console.log(`  splice pair ${p} failed: ${(e as Error).message}`)
        }
      }
      expect(spliceScored.length).toBeGreaterThanOrEqual(0)
    },
    30 * 60 * 1000,
  )

  it('writes corpus/structure/synth-baseline.md', () => {
    expect(synthScored.length).toBeGreaterThan(0)
    const L: string[] = []
    L.push('# Synthetic-structure baseline of the CURRENT detectors (phase 0B)', '')
    L.push(
      `Generated ${new Date().toISOString()} | ${synthScored.length} synthetic stimuli @ ${SR} Hz, seed ${SEED} | ${spliceScored.length} spliced real pair(s) | ${((Date.now() - t0) / 60000).toFixed(1)} min`,
      '',
    )
    L.push(
      'Every stimulus has KNOWN section changes (`src/audio/eval/synthSong.ts`). Detections are scored one-to-one against the',
      'truth (`src/audio/eval/structureMetrics.ts`): "+-1 bar" compares the time a detector CLAIMS the change happened, "causal"',
      'compares when it REPORTED it against the window [-1, +4] bars (what a live director could act on). FA = unmatched',
      'detections (a second detection of an already-matched change is a false alarm). "near negatives" = detections within [-0.5, +2.5] bars',
      'of a fill / gain step / silence gap / morph step. Lag = detected-at minus truth (positive = late). In the event tables "hit" = claimed',
      'within +-1 bar, "late" = reported inside the causal window but not within +-1 bar, "MISS" = neither, "FIRED xN" = N detections near a negative,',
      '"quiet" = none. See the caveats at the end.',
      '',
    )
    const json: Record<string, unknown> = { generated: new Date().toISOString(), sampleRate: SR, seed: SEED }
    json.synthetic = aggregate(synthScored, 'Aggregate over the synthetic catalogue', L)
    for (const s of synthScored) perStimulus(s, L)
    if (spliceScored.length) {
      L.push('## Part B: spliced real audio (known join times, real timbres)', '')
      json.splice = aggregate(spliceScored, 'Aggregate over spliced pairs', L)
      for (const s of spliceScored) perStimulus(s, L)
      const ivs = spliceScored.map((s) => intervalStats(s.truth.map((t) => t.timeSec), s.bpm))
      L.push(`Join spacing (bars): ${ivs.map((v) => f1(v.medianBars)).join(', ')}.`, '')
    }
    const gaps = synthScored[0].results.filter((r) => !r.available)
    L.push('## Caveats and gaps', '')
    if (gaps.length) for (const g of gaps) L.push(`- ${g.detector}: ${g.note}`)
    L.push(
      '- Spliced pairs: the bar length for the +-1 bar tolerance comes from the tracker\'s own tempo read of each excerpt (mean of the two), which can be an octave off, so treat those windows as approximate.',
      '- Synthetic songs are clean: perfect kicks, exact loops, no vocals or reverb, tempo drift only where stated. They set a necessary bar, not a sufficient one.',
      '- The plan expects the current detectors to be blind to equal-loudness timbre/harmony changes (`verseChorusEqualLoudness`, `keyChangeEqualLoudness`) and to fire on fills and gain steps: read those rows first.',
      '- The first truth event of most stimuli is 14-33 s in; the beat tracker needs ~8 s and `StructureAnalyzer` ~20-25 s to warm up, hence the ">= 25 s" columns.',
      '- `structure.boundaries` claimed times come from the tracker\'s own beat list (published beats lead the audio by the engine\'s beat lead, ~0.1 s), so position errors below ~0.2 s are noise.',
      '- `songSection.boundary` fires only when the section KIND changes (SectionTracker), so section->section changes (verse->chorus) are silent by design (`SectionTracker.test.ts:298-320`).',
      '- Build windows for the build flags run from the true `buildStart` to the next `drop`; `cov` = share of true-build frames the flag was on, `outside` = share of all other frames it was on.',
      '',
    )
    mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(OUT_MD, L.join('\n') + '\n')
    writeFileSync(OUT_JSON, JSON.stringify({ ...json, stimuli: synthScored.map((s) => ({ stimulus: s.stimulus, bpm: s.bpm, estBpm: s.estBpm, results: s.results })) }, null, 2))
    console.log(L.slice(0, 40).join('\n'))
    console.log(`wrote ${OUT_MD}`)
  })
})
