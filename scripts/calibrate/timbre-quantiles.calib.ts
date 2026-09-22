/**
 * Generates `src/audio/timbreQuantiles.ts`: reference-population percentile
 * tables for the timbre descriptors (harsh / busy / sparse). Uses audio FEATURES
 * only, never human or Gemini labels, so it trains on nothing non-commercial.
 *
 *   npm run calibrate:timbre
 *
 * Population: the unlabelled pool, i.e. the per-clip feature caches in
 * corpus/emotion/cache-pool (Jamendo + testfolder tracks, and the PMEmo clips whose
 * numeric id ends in 9). It is the same population `emotion-quantiles.calib.ts`
 * builds (run `npm run calibrate:quantiles` once to create the caches). This script only
 * reads cached JSON, no audio is decoded, so it takes seconds.
 *
 * Three passes, each replaying `TimbreDescriptors` over the pool:
 *   1. per-input percentiles (over non-silent frames);
 *   2. tables for the smoothed `harsh` and `busy` composites (spread over 0..1);
 *   3. the table for the smoothed `sparse` composite (it is built from the mapped busy).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPLAY_STRIDE, framesFromCache, type FeatureCache } from './emotion'
import type { FrameSample } from './features'
import { TimbreDescriptors } from '../../src/audio/TimbreDescriptors'
import type { TimbreCalibration } from '../../src/audio/timbreQuantiles'

const ROOT = resolve(__dirname, '../..')
const OUT = join(ROOT, 'src/audio/timbreQuantiles.ts')
const POOL = join(ROOT, 'corpus/emotion/cache-pool')
const KNOTS = 21
/** Seconds skipped at the start (smoothers/normalisers settling), the same as the emotion tables. */
const SKIP_SEC = 3
/** Composite tables are sampled once per second, and only after the descriptors have settled. */
const COMPOSITE_FROM_SEC = 8

const files = existsSync(POOL) ? readdirSync(POOL).filter((n) => n.endsWith('.json')) : []

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

describe.skipIf(files.length < 20)('timbre quantile tables', () => {
  it(
    `builds percentile tables from ${files.length} pool caches`,
    () => {
      const series: FrameSample[][] = []
      for (const name of files) {
        const cache = JSON.parse(readFileSync(join(POOL, name), 'utf8')) as FeatureCache
        series.push(framesFromCache(cache).filter((f) => f.t >= SKIP_SEC))
      }
      expect(series.length).toBeGreaterThan(20)

      // Pass 1: per-input percentiles over non-silent frames.
      const pick: Record<string, (f: FrameSample) => number> = {
        loudness: (f) => f.loudness,
        flux: (f) => f.flux,
        roughness: (f) => f.harmonicRoughness,
        tonalness: (f) => f.harmonicTonalness,
        modeAmbiguity: (f) => 1 - Math.abs(f.keyModeStrength),
      }
      const features: Record<string, number[]> = {}
      let nFrames = 0
      for (const [name, get] of Object.entries(pick)) {
        const vals: number[] = []
        for (const s of series) {
          for (const f of s) {
            if (f.silence) continue
            if ((name === 'roughness' || name === 'tonalness') && !f.harmonicTensionValid) continue
            if (name === 'modeAmbiguity' && !f.keyValid) continue
            vals.push(get(f))
          }
        }
        features[name] = quantiles(vals)
        nFrames = Math.max(nFrames, vals.length)
      }

      const dt = REPLAY_STRIDE / 60
      const replay = (cal: TimbreCalibration, sink: (d: TimbreDescriptors) => void) => {
        for (const s of series) {
          const d = new TimbreDescriptors(cal)
          let next = COMPOSITE_FROM_SEC
          for (const f of s) {
            d.update(f, dt)
            if (f.t >= next && !f.silence) {
              sink(d)
              next = f.t + 1
            }
          }
        }
      }

      // Pass 2: harsh + busy composites (feature tables only).
      const harsh: number[] = []
      const busy: number[] = []
      replay({ features, composites: {}, source: 'pass 1' }, (d) => {
        harsh.push(d.raw.harsh)
        busy.push(d.raw.busy)
      })
      const cal2: TimbreCalibration = { features, composites: { harsh: quantiles(harsh), busy: quantiles(busy) }, source: 'pass 2' }

      // Pass 3: sparse composite (uses the mapped busy, so it needs the busy table).
      const sparse: number[] = []
      replay(cal2, (d) => sparse.push(d.raw.sparse))
      const composites = { harsh: cal2.composites.harsh!, busy: cal2.composites.busy!, sparse: quantiles(sparse) }

      const source = `${series.length} unlabelled tracks (Jamendo + PMEmo pool fold, first 90 s each), ${nFrames} frames, generated ${new Date().toISOString().slice(0, 10)}`
      const fmt = (a: readonly number[]) => `[${a.join(', ')}]`
      const body = [
        '/**',
        ' * Reference-population percentile tables for `TimbreDescriptors.ts`.',
        ' *',
        ' * GENERATED by `scripts/calibrate/timbre-quantiles.calib.ts` (npm run',
        ' * calibrate:timbre). Do not edit by hand.',
        ' *',
        ' * Each array holds a value at equally spaced probabilities 0, 1/(n-1), ..., 1.',
        ' * Built from audio FEATURES only, never from human or LLM labels.',
        ' */',
        'export interface TimbreCalibration {',
        '  /** Per input feature: value at each probability knot (equally spaced probabilities 0..1). */',
        '  features: Record<string, readonly number[]>',
        '  /** Per output composite: value at each probability knot. */',
        '  composites: {',
        '    harsh?: readonly number[]',
        '    busy?: readonly number[]',
        '    sparse?: readonly number[]',
        '  }',
        '  /** Provenance of the tables, for humans. */',
        '  source: string',
        '}',
        '',
        'export const TIMBRE_CALIBRATION: TimbreCalibration = {',
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
    10 * 60 * 1000,
  )
})
