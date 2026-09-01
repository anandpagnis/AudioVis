/**
 * Pure-DSP end-to-end regression (audit item 17 / F172).
 *
 * Runs deterministic procedural audio through the SAME estimator stack the
 * offline calibrate harness uses (`runTrack`, a faithful mirror of
 * `AudioEngine.update()` — real `BandNormalizer` / `BpmEstimator` /
 * `PhraseDetector` / `MoodEstimator` / `PercussionDetector`, no workers, no
 * decoder). It exists so `npm run check` catches a broken *pipeline*: a band
 * silently zeroed, an inverted silence gate, an FFT NaN, a reversed normalizer,
 * the onset feed into the beat tracker severed. None of that has CI coverage
 * otherwise.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ THIS TEST IS NOT AN ACCURACY GATE. Synthetic kicks and pads do not load  │
 * │ MoodEstimator / detectStructure like real music, and the bounds below    │
 * │ are deliberately loose. A GREEN RUN HERE IS NEVER EVIDENCE THAT A         │
 * │ CALIBRATION CONSTANT CHANGE IS SAFE — that is what `npm run calibrate`    │
 * │ over the 1500-track corpus is for. See docs/DSP_AUDIT_CHECKLIST.md.       │
 * └─────────────────────────────────────────────────────────────────────────┘
 */
import { describe, expect, it } from 'vitest'

// Each test steps 9-16 s of audio through the full estimator stack (2048 + 8192
// FFT per frame). That is seconds of real work per test, not ms — well past
// vitest's 5 s default, and more so on a CPU-contended CI box. Not a hang risk:
// runTrack is a bounded loop over a fixed-length buffer.
const TIMEOUT = 45_000
import { makeFixture, type Regime } from '../../../scripts/calibrate/fixtures'
import { runTrack, type FrameSample } from '../../../scripts/calibrate/features'
import { MOOD_STATES } from '../types'

function run(regime: Regime, opts: { seconds?: number; bpm?: number; seed?: number } = {}) {
  const fx = makeFixture({ regime, ...opts })
  return { fx, res: runTrack(fx.pcm, fx.sampleRate) }
}

/** median of a numeric array */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[s.length >> 1] : 0
}

/** Does `bpm` sit near `target`, allowing a one-octave (½× / 2×) error? */
function nearTempo(bpm: number, target: number, tol = 6): boolean {
  return (
    Math.abs(bpm - target) <= tol ||
    Math.abs(bpm - target / 2) <= tol ||
    Math.abs(bpm - target * 2) <= tol
  )
}

const BAND_KEYS = [
  'rms',
  'sub',
  'bass',
  'mid',
  'presence',
  'high',
  'vocal',
  'air',
  'sparkle',
] as const

/** Every per-frame field the pipeline emits must stay finite and in its
 * documented range for EVERY regime — the core plumbing assertion. */
describe('pipeline E2E — every feature finite and in range', () => {
  const regimes: Regime[] = ['four_on_floor', 'half_time', 'sparse_ambient', 'build_drop']
  for (const regime of regimes) {
    it(regime, () => {
      const { res } = run(regime, { seconds: 6 })
      expect(res.frames.length).toBeGreaterThan(300)

      for (const f of res.frames) {
        for (const k of BAND_KEYS) {
          expect(Number.isFinite(f[k]), `${regime} ${k} finite`).toBe(true)
          expect(f[k], `${regime} ${k} >= 0`).toBeGreaterThanOrEqual(0)
          expect(f[k], `${regime} ${k} <= 1.05`).toBeLessThanOrEqual(1.05)
        }
        expect(f.centroid).toBeGreaterThanOrEqual(0)
        expect(f.centroid).toBeLessThanOrEqual(1.01)
        expect(f.spectralFlatness).toBeGreaterThanOrEqual(0)
        expect(f.spectralFlatness).toBeLessThanOrEqual(1.01)
        expect(f.confidence).toBeGreaterThanOrEqual(0)
        expect(f.confidence).toBeLessThanOrEqual(1.01)
        expect(Number.isFinite(f.crestFactor)).toBe(true)
        expect(f.crestFactor).toBeGreaterThan(0)
        expect(Number.isFinite(f.bpm)).toBe(true)
        expect(f.bpm).toBeGreaterThanOrEqual(0)
        expect(f.bpm).toBeLessThan(400)
        expect(Number.isFinite(f.flux)).toBe(true)
        expect(f.moodLevel).toBeGreaterThanOrEqual(0)
        expect(f.moodLevel).toBeLessThanOrEqual(1.01)
        expect(MOOD_STATES).toContain(f.moodState)
      }
    }, TIMEOUT)
  }
})

describe('pipeline E2E — beat tracking responds to the beat', () => {
  it('locks near the fixture tempo on a steady four-on-floor', () => {
    const { fx, res } = run("four_on_floor", { seconds: 14, bpm: 128 })
    const tail = res.frames.slice(-Math.floor(res.frames.length / 3))
    const bpm = median(tail.map((f) => f.bpm))
    expect(nearTempo(bpm, fx.expectedBpm, 7)).toBe(true)
    // stable, not hunting: last-third spread is tight
    const lo = Math.min(...tail.map((f) => f.bpm))
    const hi = Math.max(...tail.map((f) => f.bpm))
    expect(hi - lo).toBeLessThan(12)
  }, TIMEOUT)

  it('locks (allowing an octave) on a half-time groove', () => {
    const { fx, res } = run("half_time", { seconds: 14, bpm: 84 })
    const tail = res.frames.slice(-Math.floor(res.frames.length / 3))
    const bpm = median(tail.map((f) => f.bpm))
    expect(nearTempo(bpm, fx.expectedBpm, 8)).toBe(true)
  }, TIMEOUT)

  it('does NOT lock hard onto a beatless ambient bed', () => {
    const { res } = run('sparse_ambient', { seconds: 15 })
    const half = res.frames.slice(-Math.floor(res.frames.length / 2))
    // no percussive onsets -> beat confidence must stay well below a locked
    // beat. (The mood LABEL is not asserted: the BandNormalizer AGC pulls a
    // sustained pad up to mid energy, so a synthetic bed reads as 'groove'
    // rather than 'ambient' — an artefact of the fixture, not a bug. Only the
    // real corpus can judge the mood mix.)
    expect(median(half.map((f) => f.confidence))).toBeLessThan(0.6)
    // it is mostly producing audio (a slow swell dips near zero at the LFO
    // trough, so a few silence frames are fine — but not the majority)
    const nonSilent = half.filter((f) => f.moodState !== 'silence').length
    expect(nonSilent / half.length).toBeGreaterThan(0.5)
  }, TIMEOUT)
})

describe('pipeline E2E — structure detection', () => {
  it('fires a drop exactly once after the riser, then settles', () => {
    const { fx, res } = run("build_drop", { seconds: 15, bpm: 128 })
    const dropAt = fx.expectedDropSec[0]

    let edges = 0
    let firstEdgeSec = -1
    let prev = false
    for (const f of res.frames) {
      if (f.drop && !prev) {
        edges++
        if (firstEdgeSec < 0) firstEdgeSec = f.t
      }
      prev = f.drop
    }

    expect(edges).toBeGreaterThanOrEqual(1)
    expect(edges).toBeLessThanOrEqual(3) // not stuck firing
    // the drop belongs to the slam, not the groove section before the riser
    expect(firstEdgeSec).toBeGreaterThan(dropAt - 3.5)
    expect(firstEdgeSec).toBeLessThan(dropAt + 4)
  }, TIMEOUT)

  it('mood is not frozen on the first frame across a build+drop', () => {
    const { res } = run("build_drop", { seconds: 13 })
    const distinct = new Set(res.frames.map((f: FrameSample) => f.moodState))
    expect(distinct.size).toBeGreaterThanOrEqual(2)
  }, TIMEOUT)
})

describe('pipeline E2E — determinism', () => {
  it('same fixture spec -> byte-identical PCM -> identical frame stream', () => {
    const a = run('build_drop', { seconds: 8, seed: 123 })
    const b = run('build_drop', { seconds: 8, seed: 123 })
    expect(a.fx.pcm).toEqual(b.fx.pcm)
    expect(a.res.frames.length).toBe(b.res.frames.length)
    const last = a.res.frames.length - 1
    expect(a.res.frames[last].bpm).toBe(b.res.frames[last].bpm)
    expect(a.res.frames[last].moodState).toBe(b.res.frames[last].moodState)
  }, TIMEOUT)
})
