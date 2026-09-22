/**
 * Emotion evaluation core: reduces one replayed clip to per-clip predictors, and
 * scores predictors against human valence/arousal ratings. Pure (no I/O), so the
 * runner (`emotion.calib.ts`) stays thin. Internal evaluation only.
 */
import { computeValenceArousal } from '../../src/engine/valenceArousal'
import type { AudioFeatures } from '../../src/audio/types'
import type { FrameSample } from './features'
import { EmotionDimensionEstimator } from '../../src/audio/emotionDimensions'
import { CharacterClassifier } from '../../src/audio/CharacterClassifier'
import { CHARACTER_MOODS } from '../../src/audio/characterTypes'
import { bootstrapCI, mean, spearman } from './stats'

/** Replay stride: 60 Hz frames -> 20 Hz. Shared with the quantile generator. */
export const REPLAY_STRIDE = 3

/** Evaluation folds by the last digit of the numeric clip id. 9 is the quantile-table pool and is never evaluated. */
export type Fold = 'tune' | 'test' | 'pool'
export function foldOf(numericId: number): Fold {
  const d = Math.abs(Math.trunc(numericId)) % 10
  return d === 9 ? 'pool' : d <= 4 ? 'tune' : 'test'
}

/** Seconds skipped at the start so smoothers/normalisers have settled. */
export const WARMUP_SEC = 3
/** Key/tension estimators need longer to become valid (~6-18 s). */
export const KEY_WARMUP_SEC = 8

export const MOOD_STATES = ['silence', 'ambient', 'mellow', 'groove', 'building', 'peak', 'aggressive'] as const

/** Everything one clip contributes; all predictors are clip-level means. */
export interface ClipSummary {
  id: string
  set: string
  fold: Fold
  /** Human ratings, both scaled to 0..1. */
  humanValence: number
  humanArousal: number
  seconds: number
  /** Share of analysed frames in each engine mood state. */
  moodShare: Record<string, number>
  dominantMood: string
  /** Named predictors (see PREDICTORS below). NaN when not computable for this clip. */
  x: Record<string, number>
  /** Fraction of post-warm-up frames with a valid key read. */
  keyValidShare: number
  /** Share of analysed time each of the 14 CHARACTER moods was the committed primary. */
  charShare: Record<string, number>
  dominantChar: string
}

const va = (f: FrameSample) =>
  computeValenceArousal(
    {
      energy: f.energy,
      loudness: f.loudness,
      bpm: f.bpm,
      centroid: f.centroid,
      spectralFlatness: f.spectralFlatness,
      scale: f.scale,
      moodsValid: false,
      moods: { happy: 0, aggressive: 0, party: 0, relaxed: 0 },
    } as unknown as AudioFeatures,
    0,
  )

/** Predictors used for the single-feature table and the ridge diagnostic. */
export const PREDICTORS = [
  'appArousal', // computeValenceArousal().arousal: what the app uses today
  'appValence', // computeValenceArousal().valence (now with the clean-room key)
  'energy',
  'loudness',
  'rms',
  'bass',
  'mid',
  'high',
  'centroid',
  'flatness',
  'rolloff',
  'crest',
  'flux',
  'transient',
  'sparkle',
  'air',
  'bpm',
  'modeStrength',
  'majorShare',
  'tension',
  'tonalness',
  'roughness',
  'dimArousal', // the new estimator (emotionDimensions.ts)
  'dimValence',
  'dimTension',
  'dimPulse',
] as const
export type Predictor = (typeof PREDICTORS)[number]

/** Replays the new dimension estimator over the clip and returns its mean read after warm-up. */
export function replayDimensions(frames: readonly FrameSample[], stride = REPLAY_STRIDE): {
  arousal: number
  valence: number
  tension: number
  pulse: number
  charShare: Record<string, number>
  dominantChar: string
} | null {
  const est = new EmotionDimensionEstimator()
  const cls = new CharacterClassifier()
  const charCount: Record<string, number> = {}
  for (const m of CHARACTER_MOODS) charCount[m] = 0
  let charN = 0
  const dt = REPLAY_STRIDE / 60
  const a: number[] = []
  const v: number[] = []
  const t: number[] = []
  const p: number[] = []
  for (let i = 0; i < frames.length; i += stride) {
    const f = frames[i]
    if (f.t < WARMUP_SEC) continue
    est.update(f, dt)
    const r = est.read()
    const cs = cls.update(r, f.t)
    if (cs.primary && f.t >= KEY_WARMUP_SEC) {
      charCount[cs.primary]++
      charN++
    }
    if (r.valid && f.t >= KEY_WARMUP_SEC) {
      a.push(r.arousal)
      v.push(r.valence)
      t.push(r.tension)
      p.push(r.pulse)
    }
  }
  if (a.length < 5) return null
  const charShare: Record<string, number> = {}
  let dominantChar: string = CHARACTER_MOODS[0]
  let best = -1
  for (const m of CHARACTER_MOODS) {
    charShare[m] = charN ? charCount[m] / charN : 0
    if (charCount[m] > best) {
      best = charCount[m]
      dominantChar = m
    }
  }
  return { arousal: mean(a), valence: mean(v), tension: mean(t), pulse: mean(p), charShare, dominantChar }
}

/** Compact per-clip feature series (stride REPLAY_STRIDE) cached to disk so the estimator can be re-scored without re-decoding audio. */
export interface FeatureCache {
  t: number[]
  cols: Record<string, number[]>
}
const CACHE_COLS = [
  'loudness', 'centroid', 'spectralFlatness', 'spectralRolloff', 'flux', 'energy', 'keyValid', 'keyModeStrength',
  'harmonicTensionValid', 'harmonicRoughness', 'harmonicTonalness', 'confidence', 'silence',
] as const
export function toFeatureCache(frames: readonly FrameSample[]): FeatureCache {
  const t: number[] = []
  const cols: Record<string, number[]> = {}
  for (const c of CACHE_COLS) cols[c] = []
  for (let i = 0; i < frames.length; i += REPLAY_STRIDE) {
    const f = frames[i] as unknown as Record<string, number | boolean>
    t.push(Number((f.t as number).toFixed(3)))
    for (const c of CACHE_COLS) cols[c].push(typeof f[c] === 'boolean' ? (f[c] ? 1 : 0) : Number((f[c] as number).toFixed(5)))
  }
  return { t, cols }
}
/** Rebuild FrameSample-shaped frames (only the replay fields) from a cache. */
export function framesFromCache(c: FeatureCache): FrameSample[] {
  const out: FrameSample[] = []
  for (let i = 0; i < c.t.length; i++) {
    out.push({
      t: c.t[i],
      loudness: c.cols.loudness[i],
      centroid: c.cols.centroid[i],
      spectralFlatness: c.cols.spectralFlatness[i],
      spectralRolloff: c.cols.spectralRolloff[i],
      flux: c.cols.flux[i],
      energy: c.cols.energy[i],
      keyValid: c.cols.keyValid[i] === 1,
      keyModeStrength: c.cols.keyModeStrength[i],
      harmonicTensionValid: c.cols.harmonicTensionValid[i] === 1,
      harmonicRoughness: c.cols.harmonicRoughness[i],
      harmonicTonalness: c.cols.harmonicTonalness[i],
      confidence: c.cols.confidence[i],
      silence: c.cols.silence[i] === 1,
    } as unknown as FrameSample)
  }
  return out
}

export function summarizeClip(
  id: string,
  set: string,
  fold: Fold,
  humanValence01: number,
  humanArousal01: number,
  frames: readonly FrameSample[],
): ClipSummary | null {
  const body = frames.filter((f) => f.t >= WARMUP_SEC && !f.silence)
  if (body.length < 60) return null // under ~1 s of usable audio
  const keyBody = body.filter((f) => f.t >= KEY_WARMUP_SEC)
  const m = (sel: (f: FrameSample) => number, from: readonly FrameSample[] = body) =>
    from.length ? mean(from.map(sel)) : NaN

  const counts: Record<string, number> = {}
  for (const s of MOOD_STATES) counts[s] = 0
  for (const f of frames) if (f.t >= WARMUP_SEC) counts[f.moodState] = (counts[f.moodState] ?? 0) + 1
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1
  const moodShare: Record<string, number> = {}
  let dominantMood = 'silence'
  let best = -1
  for (const s of MOOD_STATES) {
    moodShare[s] = counts[s] / total
    if (counts[s] > best) {
      best = counts[s]
      dominantMood = s
    }
  }

  const dims = replayDimensions(frames)
  const validKey = keyBody.filter((f) => f.keyValid)
  const validTension = keyBody.filter((f) => f.harmonicTensionValid)
  const x: Record<string, number> = {
    appArousal: m((f) => va(f).arousal),
    appValence: m((f) => va(f).valence),
    energy: m((f) => f.energy),
    loudness: m((f) => f.loudness),
    rms: m((f) => f.rms),
    bass: m((f) => f.bass),
    mid: m((f) => f.mid),
    high: m((f) => f.high),
    centroid: m((f) => f.centroid),
    flatness: m((f) => f.spectralFlatness),
    rolloff: m((f) => f.spectralRolloff),
    crest: m((f) => f.crestFactor),
    flux: m((f) => f.flux),
    transient: m((f) => f.transient),
    sparkle: m((f) => f.sparkle),
    air: m((f) => f.air),
    bpm: m((f) => f.bpm),
    modeStrength: validKey.length >= 30 ? m((f) => f.keyModeStrength, validKey) : NaN,
    majorShare: validKey.length >= 30 ? validKey.filter((f) => f.scale === 'major').length / validKey.length : NaN,
    tension: validTension.length >= 30 ? m((f) => f.harmonicTension, validTension) : NaN,
    tonalness: validTension.length >= 30 ? m((f) => f.harmonicTonalness, validTension) : NaN,
    roughness: validTension.length >= 30 ? m((f) => f.harmonicRoughness, validTension) : NaN,
    dimArousal: dims ? dims.arousal : NaN,
    dimValence: dims ? dims.valence : NaN,
    dimTension: dims ? dims.tension : NaN,
    dimPulse: dims ? dims.pulse : NaN,
  }
  return {
    id,
    set,
    fold,
    humanValence: humanValence01,
    humanArousal: humanArousal01,
    seconds: frames.length ? frames[frames.length - 1].t : 0,
    moodShare,
    dominantMood,
    x,
    keyValidShare: keyBody.length ? validKey.length / keyBody.length : 0,
    charShare: dims ? dims.charShare : {},
    dominantChar: dims ? dims.dominantChar : '',
  }
}

export interface Score {
  name: string
  n: number
  rho: number
  lo: number
  hi: number
}

/** Spearman of one predictor against a human axis, over clips where it exists. */
export function scorePredictor(clips: readonly ClipSummary[], name: Predictor, axis: 'humanValence' | 'humanArousal'): Score {
  const pairs = clips.filter((c) => Number.isFinite(c.x[name]))
  const xs = pairs.map((c) => c.x[name])
  const ys = pairs.map((c) => c[axis])
  const rho = spearman(xs, ys)
  const [lo, hi] = bootstrapCI(xs, ys)
  return { name, n: pairs.length, rho, lo, hi }
}

/** Fraction of clips whose (median-split) quadrant matches the human quadrant. */
export function quadrantAgreement(clips: readonly ClipSummary[]): { accuracy: number; valenceAcc: number; arousalAcc: number; n: number } {
  const ok = clips.filter((c) => Number.isFinite(c.x.appValence) && Number.isFinite(c.x.appArousal))
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
  const pv = med(ok.map((c) => c.x.appValence))
  const pa = med(ok.map((c) => c.x.appArousal))
  const hv = med(ok.map((c) => c.humanValence))
  const ha = med(ok.map((c) => c.humanArousal))
  let q = 0
  let v = 0
  let a = 0
  for (const c of ok) {
    const vOk = c.x.appValence >= pv === c.humanValence >= hv
    const aOk = c.x.appArousal >= pa === c.humanArousal >= ha
    if (vOk) v++
    if (aOk) a++
    if (vOk && aOk) q++
  }
  const n = ok.length || 1
  return { accuracy: q / n, valenceAcc: v / n, arousalAcc: a / n, n: ok.length }
}

/** Human ratings normalised to 0..1 from a dataset's native range. */
export const toUnit = (v: number, lo: number, hi: number) => (v - lo) / (hi - lo)
