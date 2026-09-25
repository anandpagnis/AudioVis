/**
 * Beat-grid LATENCY measurement. Answers, with numbers, "does the published beat (`f.beat` / `f.beatProgress`,
 * which every scene keys off) fire ON the audible kick, or late?" on synthetic drum tracks whose true beat times
 * are known, pushed through the same per-frame pipeline `AudioEngine` runs (`features.ts`).
 *
 * Three latencies are reported per track, all in ms and signed (positive = LATE relative to the true kick):
 *   onset   the broadband onset the grid is fed (`bpmEstimator.addOnset`) minus the true kick time. The PLL locks
 *           the grid phase to THESE timestamps, so this is the floor of the grid's lateness.
 *   beat    the frame `f.beat` fires minus the nearest true kick (what scenes actually see; adds the PLL's own
 *           smoothing and the up-to-one-frame quantisation of a 60 Hz check).
 *   bass    the frame `f.bass` peaks after the kick minus the kick (how late the band envelopes arrive; the pulse
 *           SHAPE is `pow(1 - beatProgress, 3)`, which peaks on the crossing frame, so the pulse adds no lag of its
 *           own beyond `beat`).
 *
 * Time convention: the harness stamps a frame with the START of its FFT window (`i / 60`); the live engine stamps
 * with `ctx.currentTime`, the END of the newest audio. So a harness time is converted to live time by adding
 * `FFT_SIZE / sampleRate` before it is compared with the true kick time (which lives on the audio clock).
 *
 *   node --max-old-space-size=1536 ./node_modules/vitest/vitest.mjs run --config vitest.calibration.config.ts \
 *        scripts/calibrate/beat-latency.calib.ts
 *
 * Knobs: BLAT_LEAD_MS=x  apply the engine's beat lead of x ms in the harness mirror (default: the engine's value)
 *
 * Output (gitignored, derived): corpus/structure/beat-latency.md
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runTrack } from './features'
import { rng } from './stats'

const ROOT = resolve(__dirname, '../..')
const OUT_DIR = join(ROOT, 'corpus/structure')
const SR = 44100
const FFT_SIZE = 2048
const FRAME_LEAD = FFT_SIZE / SR
/** Beats before this time are warm-up (the PLL and tempo need to settle). */
const WARM_SEC = 12
/** `BLAT_LEAD_MS=x` overrides the published-beat lead (ms); default the engine's built-in lead. 0 = no compensation. */
const LEAD_MS = process.env.BLAT_LEAD_MS === undefined ? undefined : Number(process.env.BLAT_LEAD_MS)

function addKick(buf: Float32Array, at: number, amp: number, attack: number) {
  const n = Math.floor(0.3 * SR)
  const att = Math.floor(attack * SR)
  for (let i = 0; i < n && at + i < buf.length; i++) {
    const t = i / SR
    const env = Math.exp(-t / 0.07) * (att > 0 ? Math.min(1, i / att) : 1)
    const f = 48 + 95 * Math.exp(-t / 0.03)
    buf[at + i] += amp * env * Math.sin(2 * Math.PI * f * t)
  }
}
function addNoise(buf: Float32Array, at: number, amp: number, decay: number, rand: () => number) {
  const n = Math.floor(decay * 3 * SR)
  let prev = 0
  for (let i = 0; i < n && at + i < buf.length; i++) {
    const white = rand() * 2 - 1
    const hp = white - prev * 0.9
    prev = white
    buf[at + i] += amp * Math.exp(-(i / SR) / decay) * hp
  }
}

interface Spec {
  name: string
  bpm: number
  seconds: number
  /** Kick attack ramp, seconds (0 = instant). A soft, sub-heavy kick has a slower rise. */
  attack: number
  snare: number
  hat: number
  t0: number
}

function synth(spec: Spec, seed: number): { pcm: Float32Array; kicks: number[] } {
  const rand = rng(seed)
  const pcm = new Float32Array(Math.floor(spec.seconds * SR))
  const period = 60 / spec.bpm
  const kicks: number[] = []
  const total = Math.floor((spec.seconds - spec.t0 - 0.5) / period)
  for (let n = 0; n < total; n++) {
    const t = spec.t0 + n * period
    kicks.push(t)
    addKick(pcm, Math.floor(t * SR), 1, spec.attack)
    if (spec.snare > 0 && n % 2 === 1) addNoise(pcm, Math.floor(t * SR), spec.snare, 0.06, rand)
    if (spec.hat > 0) {
      addNoise(pcm, Math.floor((t + period / 2) * SR), spec.hat, 0.02, rand)
      addNoise(pcm, Math.floor(t * SR), spec.hat * 0.7, 0.02, rand)
    }
  }
  let peak = 0
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]))
  if (peak > 0) for (let i = 0; i < pcm.length; i++) pcm[i] *= 0.85 / peak
  return { pcm, kicks }
}

const SPECS: Spec[] = [
  ...[80, 100, 120, 128, 140, 150, 170].map<Spec>((bpm, i) => ({
    name: `four-on-the-floor + 8th hats, ${bpm} BPM`,
    bpm,
    seconds: 60,
    attack: 0,
    snare: 0,
    hat: 0.15,
    t0: 1.13 + 0.07 * i,
  })),
  { name: 'soft kick (12 ms attack), 120 BPM', bpm: 120, seconds: 60, attack: 0.012, snare: 0, hat: 0.15, t0: 1.13 },
  { name: 'kick + snare on 2/4 + hats, 110 BPM', bpm: 110, seconds: 60, attack: 0, snare: 0.5, hat: 0.15, t0: 0.9 },
  { name: 'kick only (no hats), 130 BPM', bpm: 130, seconds: 60, attack: 0, snare: 0, hat: 0, t0: 1.31 },
]

const median = (xs: number[]): number => {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const meanOf = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
const stdOf = (xs: number[]) => {
  if (xs.length < 2) return NaN
  const m = meanOf(xs)
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length)
}
const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : 'n/a')

/** Signed offset (s) of `t` from the nearest true kick, and that kick's index. */
function nearest(kicks: readonly number[], t: number): number {
  let best = Infinity
  for (const k of kicks) {
    const d = t - k
    if (Math.abs(d) < Math.abs(best)) best = d
  }
  return best
}

describe('beat-grid latency on synthetic drums', () => {
  it('measures onset, published-beat and bass-envelope latency', () => {
    const rows: string[] = []
    const summary: Array<{ onset: number; beat: number; bass: number; spread: number }> = []
    const lockTimes: number[] = []
    for (const spec of SPECS) {
      const { pcm, kicks } = synth(spec, 7)
      const period = 60 / spec.bpm
      const onsets: number[] = []
      const run = runTrack(pcm, SR, {
        skipStructure: true,
        onOnset: (t) => onsets.push(t + FRAME_LEAD),
        beatLeadSec: LEAD_MS === undefined ? undefined : LEAD_MS / 1000,
      })

      const onsetLag = onsets
        .filter((t) => t > WARM_SEC)
        .map((t) => nearest(kicks, t))
        .filter((d) => Math.abs(d) < period * 0.25)
        .map((d) => d * 1000)

      const beatLag: number[] = []
      let offBeat = 0
      let fired = 0
      for (const fr of run.frames) {
        if (!fr.beat || fr.t < WARM_SEC) continue
        fired++
        const d = nearest(kicks, fr.t + FRAME_LEAD)
        if (Math.abs(d) < period * 0.25) beatLag.push(d * 1000)
        else offBeat++
      }

      // Band envelope: time of the peak of f.bass within [kick - 20 ms, kick + 250 ms].
      const bassLag: number[] = []
      for (const k of kicks) {
        if (k < WARM_SEC) continue
        let bestV = -1
        let bestT = NaN
        for (const fr of run.frames) {
          const t = fr.t + FRAME_LEAD
          if (t < k - 0.02) continue
          if (t > k + 0.25) break
          if (fr.bass > bestV) {
            bestV = fr.bass
            bestT = t
          }
        }
        if (Number.isFinite(bestT)) bassLag.push((bestT - k) * 1000)
      }

      // Time to lock: the first fired beat from which the next 5 all land within a quarter period of a kick.
      let lockAt = NaN
      const fires = run.frames.filter((fr) => fr.beat).map((fr) => fr.t)
      for (let i = 0; i + 5 <= fires.length; i++) {
        let ok = true
        for (let j = i; j < i + 5; j++) if (Math.abs(nearest(kicks, fires[j] + FRAME_LEAD)) >= period * 0.25) ok = false
        if (ok) {
          lockAt = fires[i]
          break
        }
      }
      lockTimes.push(lockAt)

      // Drift: median offset in the first vs the second half of the analysed span.
      const half = beatLag.length >> 1
      const drift = median(beatLag.slice(half)) - median(beatLag.slice(0, half))
      rows.push(
        `| ${spec.name} | ${f1(median(onsetLag))} (${onsetLag.length}) | ${f1(median(beatLag))} | ${f1(stdOf(beatLag))} | ${f1(drift)} | ${offBeat}/${fired} | ${f1(median(bassLag))} | ${f1(lockAt)} |`,
      )
      summary.push({ onset: median(onsetLag), beat: median(beatLag), bass: median(bassLag), spread: stdOf(beatLag) })
    }

    const md = [
      '# Beat-grid latency (synthetic drums)',
      '',
      `Generated ${new Date().toISOString()}. ms, signed, positive = LATE vs the true kick. Live time convention (frame time + ${(FRAME_LEAD * 1000).toFixed(1)} ms).`,
      '',
      '| track | onset lag ms (n) | f.beat lag ms (median) | f.beat spread (std) | drift (2nd half - 1st) | beats off the kick / fired | f.bass peak lag ms | time to lock s |',
      '|---|---|---|---|---|---|---|---|',
      ...rows,
      '',
      `Time to lock (median / worst): ${f1(median(lockTimes))} s / ${f1(Math.max(...lockTimes.filter(Number.isFinite)))} s.`,
      '',
      `Median across tracks: onset ${f1(median(summary.map((s) => s.onset)))} ms, f.beat ${f1(median(summary.map((s) => s.beat)))} ms, f.bass peak ${f1(median(summary.map((s) => s.bass)))} ms.`,
      '',
    ].join('\n')
    mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(join(OUT_DIR, 'beat-latency.md'), md)
    console.log(md)
    // Sanity only: the harness produced a finite beat lag for most tracks (this is a measurement, not a gate).
    expect(summary.filter((s) => Number.isFinite(s.beat)).length).toBeGreaterThan(SPECS.length / 2)
  })
})
