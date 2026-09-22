/**
 * Generates `src/audio/emotionQuantiles.ts`: reference-population percentile
 * tables for the emotion dimension estimator. Uses audio FEATURES only, never
 * human labels, so it does not train on the non-commercial rating data.
 *
 *   npm run calibrate:quantiles
 *
 * Population (deliberately mixed, and disjoint from the evaluation folds):
 *   - the Jamendo tracks in corpus/audio + testfolder (first 90 s of each)
 *   - PMEmo clips whose numeric id ends in 9 (fold "pool"; eval uses other digits)
 * Two passes: (1) per-feature percentiles; (2) replay the estimator with those
 * tables and take percentiles of its smoothed composites, so the final outputs
 * spread over 0..1.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeMp3File } from './decode'
import { runTrack, type FrameSample } from './features'
import { REPLAY_STRIDE, framesFromCache, toFeatureCache, type FeatureCache } from './emotion'
import { EmotionDimensionEstimator, type EmotionFeatureFrame } from '../../src/audio/emotionDimensions'
import type { EmotionCalibration } from '../../src/audio/emotionQuantiles'

const ROOT = resolve(__dirname, '../..')
const OUT = join(ROOT, 'src/audio/emotionQuantiles.ts')
const KNOTS = 21
/** Feature cache for the reference population, so re-tabulating after an estimator change takes seconds. */
const CACHE = join(ROOT, 'corpus/emotion/cache-pool')
const cacheFile = (path: string) => join(CACHE, `${basename(dirname(path))}__${basename(path)}.json`)
const MAX_SEC = 90

function mp3s(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => /\.mp3$/i.test(f)).map((f) => join(dir, f)) : []
}

function pmemoPool(): string[] {
  const dir = join(ROOT, 'corpus/emotion/pmemo/extracted/PMEmo2019/chorus')
  return mp3s(dir).filter((p) => /9\.mp3$/i.test(p))
}

function quantiles(values: number[], n = KNOTS): number[] {
  const s = Float64Array.from(values).sort()
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const pos = (i / (n - 1)) * (s.length - 1)
    const lo = Math.floor(pos)
    const hi = Math.min(s.length - 1, lo + 1)
    out.push(Number((s[lo] + (s[hi] - s[lo]) * (pos - lo)).toFixed(5)))
  }
  return out
}

const toFrame = (f: FrameSample): EmotionFeatureFrame => f as unknown as EmotionFeatureFrame

const files = [...mp3s(join(ROOT, 'corpus/audio')), ...mp3s(join(ROOT, 'testfolder')), ...pmemoPool()]

describe.skipIf(files.length < 20)('emotion quantile tables', () => {
  it(
    `builds percentile tables from ${files.length} unlabelled tracks`,
    async () => {
      const series: FrameSample[][] = []
      for (const path of files) {
        try {
          let cache: FeatureCache
          const cf = cacheFile(path)
          if (existsSync(cf)) cache = JSON.parse(readFileSync(cf, 'utf8')) as FeatureCache
          else {
            const audio = await decodeMp3File(path)
            const pcm = audio.pcm.subarray(0, Math.floor(audio.sampleRate * MAX_SEC))
            cache = toFeatureCache(runTrack(pcm, audio.sampleRate).frames)
            mkdirSync(CACHE, { recursive: true })
            writeFileSync(cf, JSON.stringify(cache))
          }
          series.push(framesFromCache(cache).filter((f) => f.t >= 3))
        } catch (e) {
          console.log(`skip ${path}: ${(e as Error).message}`)
        }
      }
      expect(series.length).toBeGreaterThan(20)

      // Pass 1: per-feature percentiles over non-silent frames.
      const pick: Record<string, (f: FrameSample) => number> = {
        loudness: (f) => f.loudness,
        centroid: (f) => f.centroid,
        flatness: (f) => f.spectralFlatness,
        rolloff: (f) => f.spectralRolloff,
        flux: (f) => f.flux,
        energy: (f) => f.energy,
        roughness: (f) => f.harmonicRoughness,
        tonalness: (f) => f.harmonicTonalness,
        beat: (f) => f.confidence,
      }
      const features: Record<string, number[]> = {}
      let nFrames = 0
      for (const [name, get] of Object.entries(pick)) {
        const vals: number[] = []
        for (const s of series) {
          for (const f of s) {
            if (f.silence) continue
            if ((name === 'roughness' || name === 'tonalness') && !f.harmonicTensionValid) continue
            vals.push(get(f))
          }
        }
        features[name] = quantiles(vals)
        nFrames = Math.max(nFrames, vals.length)
      }

      // Pass 2: replay the estimator (feature tables, no composite tables) and tabulate its raw composites.
      const cal1: EmotionCalibration = { features, composites: {}, source: 'pass 1' }
      const comp = { arousal: [] as number[], valence: [] as number[], tension: [] as number[] }
      const dt = REPLAY_STRIDE / 60
      for (const s of series) {
        const est = new EmotionDimensionEstimator(cal1)
        let next = 8
        for (const f of s) {
          est.update(toFrame(f), dt)
          if (f.t >= next && !f.silence) {
            comp.arousal.push(est.raw.arousal)
            comp.valence.push(est.raw.valence)
            comp.tension.push(est.raw.tension)
            next = f.t + 1
          }
        }
      }
      const composites = {
        arousal: quantiles(comp.arousal),
        valence: quantiles(comp.valence),
        tension: quantiles(comp.tension),
      }

      const source = `${series.length} unlabelled tracks (Jamendo + PMEmo pool fold, first ${MAX_SEC} s each), ${nFrames} frames, generated ${new Date().toISOString().slice(0, 10)}`
      const fmt = (a: readonly number[]) => `[${a.join(', ')}]`
      const body = [
        '/**',
        ' * Reference-population percentile tables for `emotionDimensions.ts`.',
        ' *',
        ' * GENERATED by `scripts/calibrate/emotion-quantiles.calib.ts` (npm run',
        ' * calibrate:quantiles). Do not edit by hand.',
        ' *',
        ' * Each array holds a value at equally spaced probabilities 0, 1/(n-1), ..., 1.',
        ' * Built from audio FEATURES only, never from human labels.',
        ' */',
        'export interface EmotionCalibration {',
        '  /** Per input feature: value at each probability knot. */',
        '  features: Record<string, readonly number[]>',
        '  /** Per output composite: value at each probability knot. */',
        '  composites: {',
        '    arousal?: readonly number[]',
        '    valence?: readonly number[]',
        '    tension?: readonly number[]',
        '  }',
        '  /** Provenance of the tables, for humans. */',
        '  source: string',
        '}',
        '',
        'export const EMOTION_CALIBRATION: EmotionCalibration = {',
        '  features: {',
        ...Object.entries(features).map(([k, v]) => `    ${k}: ${fmt(v)},`),
        '  },',
        '  composites: {',
        ...Object.entries(composites).map(([k, v]) => `    ${k}: ${fmt(v)},`),
        '  },',
        `  source: ${JSON.stringify(source)},`,
        '}',
        '',
      ].join('\n')
      writeFileSync(OUT, body)
      console.log(`wrote ${OUT}: ${source}`)
    },
    2 * 60 * 60 * 1000,
  )
})
