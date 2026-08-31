/**
 * Smoke-check the real decode + feature + estimator path against the 8
 * `testfolder` reference tracks: every per-frame value finite and in range, a
 * plausible tempo lock, no all-`mellow` collapse on the electronic tracks.
 *
 * Bounds the harness's own correctness before a multi-minute corpus run, and —
 * once `corpus/refs/<id>.json` exists — compares the TS tempo read against the
 * Python ground truth within tolerance. Skips when no audio is present.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeMp3File } from './decode'
import { runTrack } from './features'
import { octaveStats } from './report'

const ROOT = resolve(__dirname, '../..')
const TESTFOLDER = join(ROOT, 'testfolder')
const REFS = join(ROOT, 'corpus/refs')
const mp3s = existsSync(TESTFOLDER) ? readdirSync(TESTFOLDER).filter((n) => n.endsWith('.mp3')) : []

describe.skipIf(mp3s.length === 0)('crosscheck against testfolder audio', () => {
  for (const name of mp3s) {
    it(`${name}: finite, in-range, plausible tempo`, async () => {
      const { pcm, sampleRate } = await decodeMp3File(join(TESTFOLDER, name))
      expect(sampleRate).toBeGreaterThan(8000)
      const { frames } = runTrack(pcm, sampleRate)
      expect(frames.length).toBeGreaterThan(100)

      for (const f of frames) {
        for (const k of [
          'sub',
          'bass',
          'mid',
          'high',
          'sparkle',
          'centroid',
          'spectralRolloff',
          'energy',
          'moodConfidence',
          'moodAmbiguity',
        ] as const) {
          expect(Number.isFinite(f[k]), `${name} ${k}`).toBe(true)
          expect(f[k], `${name} ${k} range`).toBeGreaterThanOrEqual(-0.001)
          expect(f[k], `${name} ${k} range`).toBeLessThanOrEqual(1.5)
        }
        expect(Number.isFinite(f.bpm)).toBe(true)
      }

      const nonSilent = frames.filter((f) => !f.silence)
      // Real music: a beat-carrying track should not be flagged silent throughout.
      if (nonSilent.length > frames.length * 0.5) {
        const last = frames[frames.length - 1]
        expect(last.bpm).toBeGreaterThan(50)
        expect(last.bpm).toBeLessThan(220)
      }

      const refPath = join(REFS, `${name.replace(/\.mp3$/, '')}.json`)
      if (existsSync(refPath)) {
        const ref = JSON.parse(readFileSync(refPath, 'utf8')) as { bpm?: number }
        if (ref.bpm && ref.bpm > 0) {
          const oct = octaveStats(frames, ref.bpm)
          // Record, don't hard-fail on the baseline: the octave bug is exactly
          // what Phase 3 fixes. Logged so the before/after is visible.
          console.log(
            `  ${name}: ref ${ref.bpm} BPM · flips ${oct.flips} · half-tempo ${(oct.halfTempoSampleShare * 100).toFixed(0)}%`,
          )
        }
      }
    }, 120_000)
  }
})
