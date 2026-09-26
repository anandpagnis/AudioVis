/**
 * Whole-song NON-causal analyser: the "silver standard" and, in round two, the foresight plan for file playback.
 * Pure TypeScript (no DOM / React / WebAudio): runs in Node (tests, calibration) and later in a worker. Clean-room:
 * standard STFT / mel / chroma / autocorrelation / dynamic-programming ideas only, no third-party analysis code.
 *
 * PIPELINE
 *  1. decimate to ~22 kHz mono, STFT 2048 Hann / hop 512 streamed into per-frame log-mel (40), chroma (12), level,
 *     sub+bass and high-band energy, and log-mel spectral-flux onset envelopes (`dsp.ts`);
 *  2. tempo by autocorrelation of the onset envelope with a log-normal prior; Ellis dynamic-programming beat
 *     tracker; BPM re-derived from the tracked beats (`tempo.ts`);
 *  3. downbeat / bar phase from three cues accumulated over the WHOLE song (per-phase onset / harmony salience,
 *     the boundary-structure vote, and how sharply bars cut at each phase resolve section steps), with a confidence
 *     (`downbeat.ts`, `phaseAlignment` in `structure.ts`);
 *  4. bar-synchronous summaries, bar-level self-similarity on mean-centred features (cosine), symmetric Foote
 *     novelty at 2 / 4 / 8 bars each side (plus a chroma-only 8-bar harmony channel), adaptive peak picking with a
 *     soft 4/8-bar grid prior, an absolute feature-shift floor and a dominance rule (`structure.ts`);
 *  5. segments labelled by repetition (A B A ...), boundaries typed change | drop | buildStart | breakdown, and a
 *     riser's internal steps merged into one build.
 *
 * `SongPlan.events` are `SectionEvent`s with `source: 'plan'`. A plan has no detection latency: `detectedAt*`
 * equals `boundary*` (the plan is known before playback); a consumer that cares about when the plan became
 * available must overwrite them. `strength` is `1 - exp(-z / 5)` of the combined novelty z-score (a typical peak,
 * z ~ 4-6, lands around 0.55-0.7); `confidence` folds in the absolute shift across the boundary, the grid prior and
 * the tempo/beat reliability.
 */
import type { SectionEvent } from '../events/types'
import { aggregate, clamp } from './aggregate'
import { decimate, extractFrames, MEL_BANDS, onsetEnvelopes, toDb } from './dsp'
import { estimateDownbeat } from './downbeat'
import { channelZ, computeNovelty, labelSegments, mergeBuilds, phaseAlignment, pickPeaks, typeBoundary, type Peak } from './structure'
import { estimateTempo, foldPeriod, meanBeatPeriod, trackBeats } from './tempo'
import type { AnalyzeOptions, PlanSegment, SongPlan } from './types'
import { featureVectors, VEC_DIM } from './vectors'

export type { AnalyzeOptions, PlanDiagnostics, PlanSegment, SongPlan } from './types'

/**
 * Weight of the bass-band onset envelope next to the broadband one for tempo / beat tracking. Kicks must outvote
 * off-beat hats when the two compete for the beat (a 1.0 weight still tracked the hats in one synthetic song).
 * Beat times are the frame-centre times of the flux peaks; measured on the synthetic suite they sit a median 1-11 ms
 * EARLY of the true beat, far inside any tolerance, so no correction is applied.
 */
const LOW_ONSET_WEIGHT = 1.5

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

function emptyPlan(durationSec: number, sr: number, fps: number, nFrames: number, warnings: string[], t0: number): SongPlan {
  return {
    bpm: 0,
    beats: [],
    downbeatPhase: 0,
    bars: [],
    events: [],
    segments: [],
    diagnostics: {
      durationSec,
      analysisSampleRate: sr,
      fps,
      nFrames,
      nBars: 0,
      tempo: { initialBpm: 0, acf: 0, confidence: 0, candidates: [] },
      beatOnsetRatio: 0,
      beatless: false,
      downbeat: { confidence: 0, scores: [0, 0, 0, 0], salienceConfidence: 0, structureConfidence: 0, alignmentConfidence: 0, methodsAgree: false },
      grid: { phase4: -1, phase8: -1, share4: 0 },
      novelty: [],
      distance: [],
      barLevelDb: [],
      rejectedByFloor: 0,
      analysisMs: now() - t0,
      warnings,
    },
  }
}

export function analyzeSong(pcm: Float32Array, sampleRate: number, opts: AnalyzeOptions = {}): SongPlan {
  const t0 = now()
  const warnings: string[] = []
  const durationSec = pcm.length / sampleRate
  const { data, sr } = decimate(pcm, sampleRate, opts.targetSampleRate ?? 22050)
  const frames = extractFrames(data, sr)
  const fps = 1 / frames.hopSec
  if (durationSec < 8 || frames.n < 64) {
    warnings.push('audio too short to analyse')
    return emptyPlan(durationSec, sr, fps, frames.n, warnings, t0)
  }
  const env = onsetEnvelopes(frames)

  // ---- tempo and beats -------------------------------------------------------------------------
  const beatEnv = beatEnvelope(env)
  const tempo = estimateTempo(beatEnv, fps, { priorBpm: opts.priorBpm, priorOctaves: opts.priorOctaves })
  const track = trackBeats(beatEnv, foldPeriod(tempo.periodFrames, fps))
  // active region: drop beats in leading / trailing near-silence
  const lvl = Array.from(frames.levelLin, (e) => toDb(e))
  const sorted = [...lvl].sort((a, b) => a - b)
  const loud = sorted[Math.floor(0.9 * (sorted.length - 1))]
  let first = 0
  while (first < lvl.length - 1 && lvl[first] < loud - 45) first++
  let last = lvl.length - 1
  while (last > first && lvl[last] < loud - 45) last--
  const beatFrames = track.frames.filter((f) => f >= first - 1 && f <= last + 1)
  if (beatFrames.length < 16 || loud < -80) {
    warnings.push(loud < -80 ? 'audio is silent' : 'too few beats tracked')
    const p = emptyPlan(durationSec, sr, fps, frames.n, warnings, t0)
    p.diagnostics.tempo = { initialBpm: tempo.bpm, acf: tempo.acf, confidence: tempo.confidence, candidates: tempo.candidates }
    return p
  }
  const beats = beatFrames.map((f) => f * frames.hopSec)
  const period = meanBeatPeriod(beats)
  const bpm = period > 0 ? 60 / period : tempo.bpm

  // ---- downbeat ------------------------------------------------------------------------------------
  const beatAgg = aggregate(frames, env, beatFrames)
  const beatVec = featureVectors(beatAgg)
  const down = estimateDownbeat(beatFrames, env, beatAgg, beatVec, phaseAlignment(frames, env, beatFrames))
  const phase = down.phase
  const nBars = Math.floor((beats.length - 1 - phase) / 4)
  const bars: number[] = []
  for (let k = 0; phase + 4 * k < beats.length; k++) bars.push(beats[phase + 4 * k])
  if (nBars < 8) {
    warnings.push('fewer than 8 complete bars')
    const p = emptyPlan(durationSec, sr, fps, frames.n, warnings, t0)
    Object.assign(p, { bpm, beats, downbeatPhase: phase, bars })
    p.diagnostics.tempo = { initialBpm: tempo.bpm, acf: tempo.acf, confidence: tempo.confidence, candidates: tempo.candidates }
    p.diagnostics.nBars = nBars
    return p
  }

  // ---- bar-synchronous features, novelty, boundaries ---------------------------------------------------
  const barEdges: number[] = []
  for (let k = 0; k <= nBars; k++) barEdges.push(beatFrames[phase + 4 * k])
  const bar = aggregate(frames, env, barEdges)
  const vec = featureVectors(bar)
  const { vecMain, chromaVec } = splitChannels(vec, nBars)
  const minSpacing = opts.minSectionBars ?? 4
  const floor = opts.distanceFloor ?? 1.6
  const beatless = tempo.confidence < 0.3 && track.onsetRatio < 3.5
  const nov = computeNovelty(vecMain, chromaVec, nBars, {
    distanceFloor: floor,
    harmonyFloor: opts.harmonyFloor ?? 1.5,
    stepRatio: 0.5,
    beatless,
  })
  const picked = pickPeaks(nov, nBars, { minSpacing, threshold: opts.peakThreshold ?? 2.5, dominance: 0.4 })
  const { grid, rejectedByFloor } = picked
  // a riser's internal steps are not sections: merge boundaries between two rising segments
  const merged = mergeBuilds(bar, [0, ...picked.peaks.map((p) => p.bar), nBars])
  const keep = new Set(merged)
  const peaks: Peak[] = picked.peaks.filter((p) => keep.has(p.bar))

  // ---- segments, labels, events ------------------------------------------------------------------------
  const bounds = [0, ...peaks.map((p) => p.bar), nBars]
  const labels = labelSegments(vec, bounds, 0.75, 1.5 * floor)
  const barTime = (k: number) => bars[Math.min(bars.length - 1, k)]
  const segments: PlanSegment[] = []
  for (let s = 0; s + 1 < bounds.length; s++) {
    const a = bounds[s]
    const b = bounds[s + 1]
    const seg: PlanSegment = {
      startSec: s === 0 ? 0 : barTime(a),
      endSec: s + 2 === bounds.length ? durationSec : barTime(b),
      startBar: a,
      endBar: b,
      label: labels.labels[s],
      meanLevelDb: toDb(meanLinear(frames.levelLin, barEdges[a], barEdges[b])),
    }
    const rep = labels.repeatOf[s]
    if (rep !== undefined) seg.repeatOf = rep
    segments.push(seg)
  }

  const feats = channelZ(vec, bar, nBars, peaks.map((p) => p.bar))
  const barTrust = clamp(0.5 * tempo.confidence + 0.5 * clamp((track.onsetRatio - 1) / 1.5, 0, 1), 0, 1)
  const events: SectionEvent[] = peaks.map((p, e) => {
    const seg = bounds.indexOf(p.bar)
    const typing = typeBoundary(bar, p.bar, bounds[seg - 1], bounds[seg + 1])
    const strength = clamp(1 - Math.exp(-Math.max(0, p.z) / 5), 0, 1)
    const shiftScore = clamp(p.dist / (2 * floor), 0, 1)
    const confidence = clamp(Math.sqrt(strength * shiftScore) * (p.onGrid ? 1 : 0.85) * (0.6 + 0.4 * barTrust), 0, 1)
    const boundaryBeat = phase + 4 * p.bar
    const boundaryTime = beats[boundaryBeat]
    const ev: SectionEvent = {
      id: e,
      type: typing.type,
      strength,
      confidence,
      boundaryBeat,
      boundaryTime,
      detectedAtBeat: boundaryBeat,
      detectedAtTime: boundaryTime,
      source: 'plan',
      phase: 0,
      feats: feats[e],
    }
    const rep = labels.repeatOf[seg]
    if (rep !== undefined) ev.sim = { boundaryBeat: phase + 4 * bounds[rep], similarity: clamp(labels.similarity[seg], 0, 1) }
    return ev
  })

  const round = (x: number) => Math.round(x * 1000) / 1000
  const plan: SongPlan = {
    bpm,
    beats,
    downbeatPhase: phase,
    bars,
    events,
    segments,
    diagnostics: {
      durationSec,
      analysisSampleRate: sr,
      fps,
      nFrames: frames.n,
      nBars,
      tempo: { initialBpm: tempo.bpm, acf: tempo.acf, confidence: tempo.confidence, candidates: tempo.candidates },
      beatOnsetRatio: track.onsetRatio,
      beatless,
      downbeat: {
        confidence: down.confidence,
        scores: down.scores,
        salienceConfidence: down.salienceConfidence,
        structureConfidence: down.structureConfidence,
        alignmentConfidence: down.alignmentConfidence,
        methodsAgree: down.methodsAgree,
      },
      grid,
      novelty: Array.from(nov.z, round),
      distance: Array.from(nov.dist, round),
      barLevelDb: Array.from(bar.levelDb, round),
      rejectedByFloor,
      analysisMs: 0,
      warnings,
    },
  }
  plan.diagnostics.analysisMs = now() - t0
  return plan
}

/**
 * Onset envelope for tempo and beat tracking: broadband flux plus a share of the bass-band flux, each scaled by its
 * own standard deviation. The bass emphasis makes kicks outvote off-beat hats when the two compete for the beat.
 */
function beatEnvelope(env: { flux: Float32Array; lowFlux: Float32Array }): Float32Array {
  const n = env.flux.length
  const sd = (x: Float32Array) => {
    let m = 0
    for (let i = 0; i < n; i++) m += x[i]
    m /= Math.max(1, n)
    let v = 0
    for (let i = 0; i < n; i++) v += (x[i] - m) * (x[i] - m)
    return Math.sqrt(v / Math.max(1, n)) || 1
  }
  const a = 1 / sd(env.flux)
  const b = LOW_ONSET_WEIGHT / sd(env.lowFlux)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = env.flux[i] * a + env.lowFlux[i] * b
  return out
}

/** Split the full bar vectors into the timbre / rhythm / bass vectors (chroma zeroed) and the chroma-only vectors. */
function splitChannels(vec: Float32Array, n: number): { vecMain: Float32Array; chromaVec: Float32Array } {
  const vecMain = Float32Array.from(vec)
  const chromaVec = new Float32Array(n * VEC_DIM)
  for (let k = 0; k < n; k++) {
    for (let d = MEL_BANDS; d < MEL_BANDS + 12; d++) {
      chromaVec[k * VEC_DIM + d] = vec[k * VEC_DIM + d]
      vecMain[k * VEC_DIM + d] = 0
    }
  }
  return { vecMain, chromaVec }
}

function meanLinear(x: Float32Array, a: number, b: number): number {
  const lo = Math.max(0, Math.round(a))
  const hi = Math.min(x.length, Math.round(b))
  let s = 0
  for (let i = lo; i < hi; i++) s += x[i]
  return hi > lo ? s / (hi - lo) : 0
}
