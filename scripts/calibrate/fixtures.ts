/**
 * Deterministic procedural audio fixtures for the pure-DSP end-to-end test
 * (`src/audio/__tests__/pipelineE2E.test.ts`, audit item 17 / F170).
 *
 * WHY procedural and not a committed clip: every real track this project has is
 * MTG-Jamendo (CC BY-SA / BY-NC-SA) and cannot be committed — that is the whole
 * `.gitignore corpus/audio` rationale. A seeded synth has no licence, no binary,
 * and is byte-reproducible on any machine.
 *
 * WHAT this is NOT: an accuracy oracle. Synthesised kicks and pads do not load
 * `MoodEstimator` / `detectStructure` the way real music does — the mood mix
 * these produce is an artefact of the `BandNormalizer` AGC reacting to crude
 * envelopes, not a musical judgement. The E2E test asserts only *plumbing*
 * (finite, in-range, a beat locks, a drop fires once, mood isn't frozen). The
 * 1500-track `npm run calibrate` corpus remains the only accuracy gate, and a
 * green E2E run is **never** evidence that a calibration change is safe.
 *
 * All generators are pure: `(spec) -> Float32Array`, mono, 48 kHz, peak ~0.9.
 */

const SR = 48000

/** mulberry32 — tiny deterministic PRNG so noise bursts reproduce exactly. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Add a decaying-sine drum hit (kick/tom) into `buf` at sample `at`. */
function kick(buf: Float32Array, at: number, freq = 55, decay = 0.11, gain = 0.9): void {
  for (let i = 0; i < decay * SR && at + i < buf.length; i++) {
    const env = Math.exp(-i / (decay * SR * 0.33))
    // slight downward pitch sweep, like a real kick
    const f = freq * (1 + 0.6 * Math.exp(-i / (SR * 0.02)))
    buf[at + i] += Math.sin((2 * Math.PI * f * i) / SR) * env * gain
  }
}

/** Add a band-noise burst (snare/clap/hat) into `buf` at sample `at`. */
function noiseHit(
  buf: Float32Array,
  at: number,
  rand: () => number,
  decay = 0.09,
  gain = 0.5,
  hp = 0.4, // 0..1 fraction of a one-pole high-pass (higher = brighter)
): void {
  let prev = 0
  for (let i = 0; i < decay * SR && at + i < buf.length; i++) {
    const env = Math.exp(-i / (decay * SR * 0.4))
    const white = rand() * 2 - 1
    const filtered = hp * (white - prev) + (1 - hp) * white
    prev = white
    buf[at + i] += filtered * env * gain
  }
}

/** Add a sustained saw-ish bass note over `[at, at+len)`. */
function bassNote(buf: Float32Array, at: number, len: number, freq = 55, gain = 0.35): void {
  for (let i = 0; i < len && at + i < buf.length; i++) {
    const phase = ((freq * i) / SR) % 1
    const saw = 2 * phase - 1
    const env = Math.min(1, i / (SR * 0.01)) * Math.min(1, (len - i) / (SR * 0.03))
    buf[at + i] += saw * 0.5 * env * gain
  }
}

/** Add a slow detuned-sine pad across the whole buffer. */
function pad(buf: Float32Array, gain = 0.22, root = 220): void {
  const partials = [1, 1.5, 2.01, 2.99]
  for (let i = 0; i < buf.length; i++) {
    let s = 0
    for (const p of partials) s += Math.sin((2 * Math.PI * root * p * i) / SR)
    const lfo = 0.7 + 0.3 * Math.sin((2 * Math.PI * 0.1 * i) / SR)
    buf[i] += (s / partials.length) * gain * lfo
  }
}

/** Add a rising filtered-noise riser over `[from, to)` seconds. */
function riser(buf: Float32Array, fromSec: number, toSec: number, rand: () => number): void {
  const a = Math.floor(fromSec * SR)
  const b = Math.min(buf.length, Math.floor(toSec * SR))
  let prev = 0
  for (let i = a; i < b; i++) {
    const t = (i - a) / (b - a) // 0..1
    const white = rand() * 2 - 1
    // sweep the one-pole from dark to bright as t rises
    const hp = 0.15 + 0.8 * t
    const filtered = hp * (white - prev) + (1 - hp) * white
    prev = white
    buf[i] += filtered * (0.05 + 0.5 * t * t)
  }
}

/** tanh soft-clip — keeps sustained level high (unlike peak-normalising, which
 * scales the whole buffer down to a transient spike and guts the RMS). */
function softClip(buf: Float32Array, drive = 1): Float32Array {
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * drive)
  return buf
}

export type Regime = 'four_on_floor' | 'half_time' | 'sparse_ambient' | 'build_drop'

export interface FixtureSpec {
  regime: Regime
  seconds?: number
  bpm?: number
  seed?: number
}

export interface Fixture {
  pcm: Float32Array
  sampleRate: number
  /** The tempo the beat tracker should lock to (0 for beatless regimes). */
  expectedBpm: number
  /** Seconds at which a `drop` is expected to fire (empty if none). */
  expectedDropSec: number[]
  label: string
}

/**
 * Build one deterministic fixture. Same spec -> byte-identical PCM.
 */
export function makeFixture(spec: FixtureSpec): Fixture {
  const seconds = spec.seconds ?? 18
  const seed = spec.seed ?? 0x51ca1
  const rand = rng(seed)
  const n = seconds * SR
  const buf = new Float32Array(n)

  /** A sustained sub-bass sine bed over `[at, at+len)` — steady RMS, unlike the
   * saw `bassNote`, so it drives the band normalizer to a real level. */
  const subBed = (at: number, len: number, freq: number, gain: number) => {
    for (let i = 0; i < len && at + i < buf.length; i++) {
      const env = Math.min(1, i / (SR * 0.02)) * Math.min(1, (len - i) / (SR * 0.05))
      buf[at + i] += Math.sin((2 * Math.PI * freq * i) / SR) * gain * env
    }
  }

  const groove = (bpm: number, fromSec: number, toSec: number, heavy = false) => {
    const beat = 60 / bpm
    if (heavy) subBed(Math.floor(fromSec * SR), Math.floor((toSec - fromSec) * SR), 46, 0.6)
    for (let t = fromSec; t < toSec; t += beat) {
      const at = Math.floor(t * SR)
      kick(buf, at, 52, 0.12, heavy ? 1.3 : 0.85)
      bassNote(buf, at, Math.floor(beat * SR * 0.9), 52, heavy ? 0.6 : 0.32)
      // hats on the eighths
      noiseHit(buf, at + Math.floor(beat * SR * 0.5), rand, 0.04, heavy ? 0.35 : 0.22, 0.85)
      noiseHit(buf, at, rand, 0.03, 0.12, 0.9)
    }
  }

  let expectedBpm = 0
  const expectedDropSec: number[] = []

  switch (spec.regime) {
    case 'four_on_floor': {
      expectedBpm = spec.bpm ?? 128
      pad(buf, 0.12, 165)
      groove(expectedBpm, 0.25, seconds)
      break
    }
    case 'half_time': {
      // kick on 1 and 3 of a 4/4 bar at 2x — reads as the half tempo
      expectedBpm = spec.bpm ?? 84
      pad(buf, 0.16, 130)
      const beat = 60 / expectedBpm
      for (let bar = 0; bar * beat * 2 < seconds; bar++) {
        const t0 = bar * beat * 2
        kick(buf, Math.floor(t0 * SR), 48, 0.16, 0.95)
        noiseHit(buf, Math.floor((t0 + beat) * SR), rand, 0.14, 0.5, 0.35) // snare on 2
        bassNote(buf, Math.floor(t0 * SR), Math.floor(beat * 1.5 * SR), 44, 0.35)
      }
      break
    }
    case 'sparse_ambient': {
      // no transients at all — pad + very slow swell. Beat tracker should NOT lock.
      expectedBpm = 0
      pad(buf, 0.3, 196)
      for (let i = 0; i < n; i++) {
        const swell = 0.5 + 0.5 * Math.sin((2 * Math.PI * 0.03 * i) / SR)
        buf[i] *= swell
      }
      break
    }
    case 'build_drop': {
      // The pipeline's drop gate wants a sharp energy + bass contrast: a ~2.2 s
      // trailing window that is quiet, then a 0.35 s window that slams. Build it
      // literally — groove, riser, a real silence gap, then a heavy sustained
      // slam — because a synthetic bed can't imply the contrast the way a mix
      // does. (This is exactly why the E2E asserts stay loose; see the header.)
      expectedBpm = spec.bpm ?? 128
      const dropAt = Math.min(seconds - 5, 11)
      pad(buf, 0.08, 165)
      groove(expectedBpm, 0.25, dropAt - 4) // groove section
      riser(buf, dropAt - 4, dropAt - 1.4, rand) // riser, kick drops out
      // ~1.4 s of near silence
      for (let i = Math.floor((dropAt - 1.4) * SR); i < Math.floor(dropAt * SR); i++) buf[i] = 0
      // the slam: heavy kick + a loud sustained sub-bass bed + a big noise hit
      kick(buf, Math.floor(dropAt * SR), 44, 0.3, 1.4)
      subBed(Math.floor(dropAt * SR), Math.floor(2.2 * SR), 44, 1.1)
      noiseHit(buf, Math.floor(dropAt * SR), rand, 0.3, 0.9, 0.5)
      groove(expectedBpm, dropAt + 0.5, seconds, true) // heavier groove after
      expectedDropSec.push(dropAt)
      break
    }
  }

  return {
    pcm: softClip(buf),
    sampleRate: SR,
    expectedBpm,
    expectedDropSec,
    label: `${spec.regime}${expectedBpm ? ` @ ${expectedBpm}bpm` : ''}`,
  }
}
