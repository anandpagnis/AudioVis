/**
 * Deterministic synthetic songs of KNOWN structure (plan phase 0B,
 * `so-the-mood-analysis-lively-hickey.md`).
 *
 * WHY: there is no structure ground truth anywhere in this repo (the Jamendo corpus is unlabeled), so a
 * bar-synchronous section-change detector cannot be unit-tested or lag-measured on real music. These songs are
 * synthesised from a small structure-spec DSL, so every section change, drop, fill, gain step and silence gap
 * is known to the sample. The same songs feed (a) fast feature-level unit tests, (b) `runTrack` audio-level
 * calibration scripts (`scripts/calibrate/synth-structure.calib.ts`) and (c) `structureMetrics.ts`.
 *
 * WHAT IT IS NOT: real music. No vocals, no reverb, no stereo, no mastering, perfect (or smoothly drifting)
 * timing, exact repetition of loops. A detector that scores well here has cleared a necessary bar, not a
 * sufficient one; the taps and the silver standard are what say whether it works on songs.
 *
 * Pure TypeScript (no node imports; `src` is typechecked without @types/node). Mono Float32, 44.1 kHz by
 * default (the rate mp3 decodes arrive at; pass `sampleRate: 22050` for cheap unit tests). Memory: the output
 * buffer plus ONE scratch bus, regardless of song length. A 2-minute song synthesises in well under 2 s.
 *
 * VOICES: kick (sine sweep + click), snare / clap (noise burst + body), hats (closed / open filtered noise),
 * bass (saw + sub square through an enveloped low-pass), chord pad (detuned saws through a MOVING state-variable
 * low-pass, chords are real note sets so key / chord changes are real harmonic changes), lead (arp or seeded
 * melody), riser (band-passed noise sweep + rising sine), impact + crash, and silence gates.
 *
 * DSL: `SongSpec` = bpm + an ordered list of `SectionSpec` (bar counts, instrument set, chord progression, key,
 * pad brightness, level ramps, ...). Truth is derived from the spec: a section's `event` marks the change at its
 * first downbeat, `fillEvery` adds fill NEGATIVES, and `gainSteps` / `silences` / `extraTruth` add more.
 *
 * TRUTH: `TruthEvent.shouldTrigger` is true for events a detector should report (change, drop, buildStart,
 * breakdown) and false for the NEGATIVE cases a good detector must NOT treat as a scene change (fills, gain
 * steps, silence gaps, the intermediate steps of a gradual morph). `type` says what the event is; `shouldTrigger`
 * says whether it is a legitimate trigger. Times are on the audio clock (sample 0 = 0 s).
 *
 * LEVEL CONTROL: `rmsDb` per section normalises that section to a target RMS (equal-loudness stimuli); `level`
 * is a dB ramp across a section; `gainSteps` are whole-mix knob turns. The final mix is peak-normalised to
 * `peak` (default 0.89), which scales every section identically so relative levels survive.
 */

export type TruthEventType = 'change' | 'drop' | 'buildStart' | 'breakdown' | 'fill' | 'gain' | 'silence'

export interface TruthEvent {
  type: TruthEventType
  /** Seconds on the audio clock. */
  timeSec: number
  /** Global integer beat index (0-based, beat 0 = the song's first beat). */
  beat: number
  /** Global bar index (0-based) containing `beat` (4 beats per bar). */
  bar: number
  /** True: a detector should report this. False: a NEGATIVE the detector must not treat as a scene change. */
  shouldTrigger: boolean
  note?: string
  /** Index into `SynthSong.sections` of the section starting at this event (section-boundary events only). */
  sectionIndex?: number
  /** Section boundary whose material returns an earlier section's exact material (`SynthSection.repeatOf`). */
  repeatOf?: number
}

export type KickPattern = 'four' | 'oneAndThree' | 'off'
export type SnarePattern = 'backbeat' | 'halftime' | 'off'
export type HatPattern = 'off' | 'eighth' | 'sixteenth' | 'offbeat'
export type BassPattern = 'off' | 'root' | 'eighth' | 'offbeat' | 'sustain'
export type LeadPattern = 'off' | 'arp' | 'melody'
export type VoiceName = 'kick' | 'snare' | 'hats' | 'bass' | 'pad' | 'lead' | 'riser'

export type ChordQuality = 'maj' | 'min' | 'maj7' | 'min7' | 'dom7' | 'sus2' | 'sus4'
export interface Chord {
  /** Pitch class of the root, 0 = C. */
  root: number
  quality: ChordQuality
}

/** Pitch classes, for readable progressions. */
export const PC = { C: 0, Db: 1, D: 2, Eb: 3, E: 4, F: 5, Gb: 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 } as const

const CHORD_INTERVALS: Record<ChordQuality, readonly number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  dom7: [0, 4, 7, 10],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
}

export const chord = (root: number, quality: ChordQuality = 'maj'): Chord => ({ root, quality })

export interface SectionSpec {
  label: string
  bars: number
  /** Key for repetition: sections sharing a `material` are exact repeats (same notes, same seeded phases and
   *  melody). Defaults to `label`. */
  material?: string
  /** Names the `material` this section is a VARIATION of (recorded in the truth; does not change the audio). */
  variantOf?: string
  /** Progression, cycled across the section; each chord lasts `chordBars` bars (default 1). */
  chords: Chord[]
  chordBars?: number
  /** Semitone transposition of every chord root in this section (key change). */
  key?: number
  kick?: KickPattern
  snare?: SnarePattern
  snareVoice?: 'snare' | 'clap'
  hats?: HatPattern
  bass?: BassPattern
  /** Chord pad on/off. Default TRUE. */
  pad?: boolean
  lead?: LeadPattern
  /** Per-voice gain multipliers for this section. */
  levels?: Partial<Record<VoiceName, number>>
  /** Pad low-pass cutoff in Hz, `[start, end]` log-interpolated across the section (default 2000 flat). A slow
   *  +-10% LFO is always added, so the filter is "moving" even when flat. */
  padCutoff?: [number, number]
  padAttackSec?: number
  padReleaseSec?: number
  bassCutoff?: number
  leadCutoff?: number
  /** dB ramp `[start, end]` across the section, relative to the section's own level. */
  level?: [number, number]
  /** Normalise this section's RMS (of the raw synth, measured over the section) to this dBFS target. */
  rmsDb?: number
  /** Voices silenced for section-relative bar ranges `[fromBar, toBar)`. */
  mute?: Partial<Record<VoiceName, [number, number]>>
  /** Filtered-noise + rising-sine riser across the whole section. */
  riser?: boolean
  /** Snare roll over the last N bars of the section (accelerating 8ths -> 16ths -> 32nds). */
  snareRoll?: number
  /** A snare fill in the last beat (every 4 bars) or last two beats (every 8+ bars) of every Nth bar, followed
   *  by a crash for the longer fills. Each fill is a NEGATIVE truth event. Skipped in the section's last bar
   *  when the next section starts a real trigger event. */
  fillEvery?: number
  /** Impact + crash on the section's first downbeat. */
  impact?: boolean
  /** The truth event at this section's first downbeat. */
  event?: { type: TruthEventType; shouldTrigger?: boolean; note?: string }
}

export interface SongSpec {
  name: string
  description?: string
  bpm: number
  seed?: number
  /** Default 44100. */
  sampleRate?: number
  /** Audio-clock time of beat 0 (leading digital silence). Default 0. */
  startOffsetSec?: number
  sections: SectionSpec[]
  /** Smooth tempo wobble: beat length divided by `1 + depth * sin(2 pi k / periodBeats)`. */
  tempoDrift?: { depth: number; periodBeats: number }
  /** Whole-mix gain steps (a volume knob): +db from `bar` onward (10 ms ramp). Each is a NEGATIVE truth event. */
  gainSteps?: Array<{ bar: number; db: number }>
  /** Digital-silence gaps (2 ms fades). Each is a NEGATIVE truth event. */
  silences?: Array<{ bar: number; beat: number; beats: number }>
  /** Extra hand-placed truth events. */
  extraTruth?: Array<{ bar: number; beat?: number; type: TruthEventType; shouldTrigger: boolean; note?: string }>
  /** Final peak target (default 0.89). */
  peak?: number
}

export interface SynthSection {
  index: number
  label: string
  material: string
  startBar: number
  endBar: number
  startBeat: number
  startSec: number
  endSec: number
  /** Index of the earliest section with exactly the same material, or null. */
  repeatOf: number | null
  /** Index of the section this one is a variation of, or null. */
  variantOf: number | null
  /** True when a truth event is anchored at this section's start. */
  isEventBoundary: boolean
}

export interface SynthSong {
  name: string
  description: string
  pcm: Float32Array
  sampleRate: number
  bpm: number
  /** Time of every beat (seconds), one per beat of the song. */
  beatTimes: number[]
  /** Time of every downbeat (seconds); `barTimes[i] === beatTimes[4 * i]`. */
  barTimes: number[]
  truth: TruthEvent[]
  sections: SynthSection[]
  /** End of the last bar in seconds (the pcm additionally carries a ~1 s decay tail). */
  songEndSec: number
  beatsPerBar: 4
}

/* ------------------------------------------------------------------------------------------------
 * Small utilities
 * ---------------------------------------------------------------------------------------------- */

const BPB = 4
const TWO_PI = Math.PI * 2

/** mulberry32: tiny deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a 32-bit over a string. */
function hashStr(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h >>> 0
}

/** FNV-1a over the raw 32-bit words of a PCM buffer: a cheap, exact fingerprint for determinism tests. */
export function hashPcm(pcm: Float32Array): string {
  const words = new Uint32Array(pcm.buffer, pcm.byteOffset, pcm.length)
  let h = 0x811c9dc5
  for (let i = 0; i < words.length; i++) h = Math.imul(h ^ words[i], 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)
const dbToLin = (db: number) => Math.pow(10, db / 20)
const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12)

/* ------------------------------------------------------------------------------------------------
 * Percussion templates (rendered once per song, mixed at each hit)
 * ---------------------------------------------------------------------------------------------- */

function fadeTail(buf: Float32Array, frac = 0.06): Float32Array {
  const n = Math.max(1, Math.floor(buf.length * frac))
  for (let i = 0; i < n; i++) buf[buf.length - 1 - i] *= i / n
  return buf
}

/** White noise through a one-pole high-pass at `fc`. */
function hpNoise(n: number, sr: number, fc: number, rnd: () => number): Float32Array {
  const a = Math.exp((-TWO_PI * fc) / sr)
  const out = new Float32Array(n)
  let px = 0
  let py = 0
  for (let i = 0; i < n; i++) {
    const x = rnd() * 2 - 1
    py = a * (py + x - px)
    px = x
    out[i] = py
  }
  return out
}

interface Templates {
  kick: Float32Array
  snare: Float32Array
  clap: Float32Array
  hatClosed: Float32Array[]
  hatOpen: Float32Array
  crash: Float32Array
  impact: Float32Array
}

function makeKick(sr: number, rnd: () => number): Float32Array {
  const n = Math.floor(0.45 * sr)
  const out = new Float32Array(n)
  let ph = 0
  for (let i = 0; i < n; i++) {
    const t = i / sr
    ph += (TWO_PI * (44 + 120 * Math.exp(-t / 0.03))) / sr
    let s = Math.sin(ph) * Math.exp(-t / 0.13) * Math.min(1, t / 0.0015)
    if (t < 0.005) s += (rnd() * 2 - 1) * 0.25 * (1 - t / 0.005)
    out[i] = s
  }
  return fadeTail(out)
}

function makeSnare(sr: number, rnd: () => number): Float32Array {
  const n = Math.floor(0.35 * sr)
  const noise = hpNoise(n, sr, 1400, rnd)
  const out = new Float32Array(n)
  let ph = 0
  for (let i = 0; i < n; i++) {
    const t = i / sr
    ph += (TWO_PI * (170 + 60 * Math.exp(-t / 0.02))) / sr
    out[i] = noise[i] * Math.exp(-t / 0.07) * 0.75 + Math.sin(ph) * Math.exp(-t / 0.05) * 0.5
  }
  return fadeTail(out)
}

function makeClap(sr: number, rnd: () => number): Float32Array {
  const n = Math.floor(0.3 * sr)
  const noise = hpNoise(n, sr, 900, rnd)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / sr
    let env = Math.exp(-Math.max(0, t - 0.033) / 0.07) * (t >= 0.033 ? 1 : 0)
    for (const b of [0, 0.011, 0.022]) if (t >= b && t < b + 0.011) env = Math.max(env, Math.exp(-(t - b) / 0.006))
    out[i] = noise[i] * env * 0.9
  }
  return fadeTail(out)
}

function makeHat(sr: number, rnd: () => number, open: boolean): Float32Array {
  const n = Math.floor((open ? 0.6 : 0.15) * sr)
  const noise = hpNoise(n, sr, open ? 6000 : 7000, rnd)
  const tau = open ? 0.13 : 0.02
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = noise[i] * Math.exp(-i / sr / tau) * Math.min(1, i / (sr * 0.0005))
  return fadeTail(out)
}

function makeCrash(sr: number, rnd: () => number): Float32Array {
  const n = Math.floor(2.2 * sr)
  const noise = hpNoise(n, sr, 4000, rnd)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = noise[i] * Math.exp(-i / sr / 0.7) * Math.min(1, i / (sr * 0.002))
  return fadeTail(out)
}

function makeImpact(sr: number, rnd: () => number): Float32Array {
  const n = Math.floor(2.5 * sr)
  const out = new Float32Array(n)
  let ph = 0
  let lp = 0
  const a = 1 - Math.exp((-TWO_PI * 1500) / sr)
  for (let i = 0; i < n; i++) {
    const t = i / sr
    ph += (TWO_PI * (27 + 40 * Math.exp(-t / 0.25))) / sr
    lp += a * (rnd() * 2 - 1 - lp)
    out[i] = (Math.sin(ph) * 0.9 * Math.exp(-t / 0.5) + lp * 1.4 * Math.exp(-t / 0.4)) * Math.min(1, t / 0.002)
  }
  return fadeTail(out)
}

function buildTemplates(sr: number, seed: number): Templates {
  const rnd = mulberry32(seed ^ 0x9e3779b9)
  return {
    kick: makeKick(sr, rnd),
    snare: makeSnare(sr, rnd),
    clap: makeClap(sr, rnd),
    hatClosed: [makeHat(sr, rnd, false), makeHat(sr, rnd, false), makeHat(sr, rnd, false)],
    hatOpen: makeHat(sr, rnd, true),
    crash: makeCrash(sr, rnd),
    impact: makeImpact(sr, rnd),
  }
}

function mixTemplate(out: Float32Array, tpl: Float32Array, at: number, gain: number): void {
  const lo = Math.max(0, at)
  const hi = Math.min(out.length, at + tpl.length)
  for (let i = lo; i < hi; i++) out[i] += tpl[i - at] * gain
}

/* ------------------------------------------------------------------------------------------------
 * Pitched voices
 * ---------------------------------------------------------------------------------------------- */

/** Sum of naive saws (later low-passed) with a linear attack and a squared-ramp release. */
function addSawStack(
  buf: Float32Array,
  start: number,
  len: number,
  incs: Float64Array,
  phases: Float64Array,
  attackN: number,
  releaseN: number,
  gain: number,
): void {
  const total = len + releaseN
  const lo = Math.max(0, start)
  const hi = Math.min(buf.length, start + total)
  const nOsc = incs.length
  const ph = Float64Array.from(phases)
  for (let i = lo; i < hi; i++) {
    const k = i - start
    let env = k < attackN ? k / attackN : 1
    if (k >= len) {
      const r = 1 - (k - len) / releaseN
      env *= r * r
    }
    let s = 0
    for (let o = 0; o < nOsc; o++) {
      let p = ph[o] + incs[o]
      if (p >= 1) p -= 1
      ph[o] = p
      s += p * 2 - 1
    }
    buf[i] += s * env * gain
  }
}

/** Bass note: saw + sub-octave square through a two-pole low-pass whose cutoff decays from `cutoff*(1+envAmt)`. */
function addBassNote(
  out: Float32Array,
  sr: number,
  start: number,
  len: number,
  freq: number,
  gain: number,
  cutoff: number,
  envAmt: number,
): void {
  const releaseN = Math.floor(0.03 * sr)
  const attackN = Math.floor(0.004 * sr)
  const total = len + releaseN
  const inc = freq / sr
  let p = 0
  let flip = false
  let s1 = 0
  let s2 = 0
  let a = 0
  for (let k = 0; k < total; k++) {
    const i = start + k
    if (i >= out.length) break
    if ((k & 31) === 0) a = 1 - Math.exp((-TWO_PI * cutoff * (1 + envAmt * Math.exp(-k / (sr * 0.12)))) / sr)
    p += inc
    if (p >= 1) {
      p -= 1
      flip = !flip
    }
    const osc = (p * 2 - 1) * 0.7 + (flip ? 0.4 : -0.4)
    s1 += a * (osc - s1)
    s2 += a * (s1 - s2)
    let env = k < attackN ? k / attackN : 1
    if (k >= len) {
      const r = 1 - (k - len) / releaseN
      env *= r * r
    }
    if (i >= 0) out[i] += s2 * env * gain
  }
}

/** Lead note: two detuned saws through a one-pole low-pass, mild pluck decay. */
function addLeadNote(
  out: Float32Array,
  sr: number,
  start: number,
  len: number,
  freq: number,
  gain: number,
  cutoff: number,
): void {
  const releaseN = Math.floor(0.06 * sr)
  const attackN = Math.floor(0.005 * sr)
  const total = len + releaseN
  const inc1 = (freq * 0.997) / sr
  const inc2 = (freq * 1.003) / sr
  const a = 1 - Math.exp((-TWO_PI * cutoff) / sr)
  let p1 = 0.13
  let p2 = 0.57
  let lp = 0
  for (let k = 0; k < total; k++) {
    const i = start + k
    if (i >= out.length) break
    p1 += inc1
    if (p1 >= 1) p1 -= 1
    p2 += inc2
    if (p2 >= 1) p2 -= 1
    lp += a * (p1 + p2 - 1 - lp)
    let env = (k < attackN ? k / attackN : 1) * (0.6 + 0.4 * Math.exp(-k / (sr * 0.25)))
    if (k >= len) {
      const r = 1 - (k - len) / releaseN
      env *= r * r
    }
    if (i >= 0) out[i] += lp * env * gain
  }
}

/** Band-passed noise sweep (250 -> 9000 Hz, exponential) + rising sine (200 -> 1600 Hz), both growing. */
function addRiser(out: Float32Array, sr: number, start: number, end: number, gain: number, rnd: () => number): void {
  const n = end - start
  if (n <= 0) return
  const q = 2.2
  const k = 1 / q
  let ic1 = 0
  let ic2 = 0
  let ph = 0
  let a1 = 0
  let a2 = 0
  let a3 = 0
  for (let j = 0; j < n; j++) {
    const i = start + j
    if (i >= out.length) break
    const p = j / n
    if ((j & 31) === 0) {
      const fc = 250 * Math.pow(9000 / 250, p)
      const g = Math.tan((Math.PI * Math.min(fc, sr * 0.45)) / sr)
      a1 = 1 / (1 + g * (g + k))
      a2 = g * a1
      a3 = g * a2
    }
    const x = rnd() * 2 - 1
    // TPT state-variable filter, band-pass tap (v1)
    const v3 = x - ic2
    const v1 = a1 * ic1 + a2 * v3
    const v2 = ic2 + a2 * ic1 + a3 * v3
    ic1 = 2 * v1 - ic1
    ic2 = 2 * v2 - ic2
    ph += (TWO_PI * 200 * Math.pow(8, p)) / sr
    out[i] += gain * (v1 * 0.55 * Math.pow(p, 1.5) + Math.sin(ph) * 0.11 * p * p)
  }
}

/** Moving 2-pole low-pass over `buf` (TPT state-variable). `cutoffAt(sample)` is sampled every 32 samples. */
function svfLowpass(buf: Float32Array, sr: number, cutoffAt: (i: number) => number, q: number): void {
  const k = 1 / q
  let ic1 = 0
  let ic2 = 0
  const n = buf.length
  for (let b = 0; b < n; b += 32) {
    const fc = clamp(cutoffAt(b + 16), 40, sr * 0.45)
    const g = Math.tan((Math.PI * fc) / sr)
    const a1 = 1 / (1 + g * (g + k))
    const a2 = g * a1
    const a3 = g * a2
    const end = Math.min(n, b + 32)
    for (let i = b; i < end; i++) {
      const v3 = buf[i] - ic2
      const v1 = a1 * ic1 + a2 * v3
      const v2 = ic2 + a2 * ic1 + a3 * v3
      ic1 = 2 * v1 - ic1
      ic2 = 2 * v2 - ic2
      buf[i] = v2
    }
  }
}

/** Piecewise-linear gain curve applied in place: flat before the first knot and after the last. */
function applyKnots(buf: Float32Array, knots: ReadonlyArray<readonly [number, number]>): void {
  if (knots.length === 0) return
  const n = buf.length
  const first = clamp(Math.round(knots[0][0]), 0, n)
  for (let i = 0; i < first; i++) buf[i] *= knots[0][1]
  for (let j = 0; j + 1 < knots.length; j++) {
    const s0 = Math.round(knots[j][0])
    const s1 = Math.round(knots[j + 1][0])
    if (s1 <= s0) continue
    const g0 = knots[j][1]
    const g1 = knots[j + 1][1]
    const lo = clamp(s0, 0, n)
    const hi = clamp(s1, 0, n)
    for (let i = lo; i < hi; i++) buf[i] *= g0 + ((g1 - g0) * (i - s0)) / (s1 - s0)
  }
  const last = knots[knots.length - 1]
  for (let i = clamp(Math.round(last[0]), 0, n); i < n; i++) buf[i] *= last[1]
}

/* ------------------------------------------------------------------------------------------------
 * The synthesiser
 * ---------------------------------------------------------------------------------------------- */

const KICK_BEATS: Record<KickPattern, readonly number[]> = { four: [0, 1, 2, 3], oneAndThree: [0, 2], off: [] }
const SNARE_BEATS: Record<SnarePattern, readonly number[]> = { backbeat: [1, 3], halftime: [2], off: [] }
const DEFAULT_LEVELS: Record<VoiceName, number> = { kick: 1, snare: 0.55, hats: 0.22, bass: 0.55, pad: 0.22, lead: 0.28, riser: 1 }
const ARP_STEPS = [0, 1, 2, 3, 2, 1, 2, 1]

/** Bass MIDI note for a pitch class, folded into 31..42 (49-92 Hz). */
function bassMidi(pc: number): number {
  return 31 + ((((pc % 12) - 31) % 12) + 12) % 12
}

function chordNotes(c: Chord, keyOffset: number, baseMidi: number): number[] {
  const root = (((c.root + keyOffset) % 12) + 12) % 12
  return CHORD_INTERVALS[c.quality].map((i) => baseMidi + root + i)
}

interface ResolvedSection {
  spec: SectionSpec
  index: number
  startBar: number
  endBar: number
  material: string
}

/** Render a `SongSpec`. Deterministic: the same spec (including `seed`) gives bit-identical PCM. */
export function synthSong(spec: SongSpec): SynthSong {
  const sr = spec.sampleRate ?? 44100
  const seed = (spec.seed ?? 1) >>> 0
  const startOffset = spec.startOffsetSec ?? 0
  const peakTarget = spec.peak ?? 0.89

  // --- sections and the beat map -------------------------------------------------------------
  let barCursor = 0
  const secs: ResolvedSection[] = spec.sections.map((s, index) => {
    const r = { spec: s, index, startBar: barCursor, endBar: barCursor + s.bars, material: s.material ?? s.label }
    barCursor += s.bars
    return r
  })
  const totalBars = barCursor
  const totalBeats = totalBars * BPB
  const baseBeat = 60 / spec.bpm
  const beatSec = new Float64Array(totalBeats + 1)
  beatSec[0] = startOffset
  for (let k = 0; k < totalBeats; k++) {
    const d = spec.tempoDrift ? spec.tempoDrift.depth * Math.sin((TWO_PI * (k + 0.5)) / spec.tempoDrift.periodBeats) : 0
    beatSec[k + 1] = beatSec[k] + baseBeat / (1 + d)
  }
  const lastBeatDur = beatSec[totalBeats] - beatSec[totalBeats - 1]
  const timeAtBeat = (b: number): number => {
    const i = Math.floor(b)
    if (i >= totalBeats) return beatSec[totalBeats] + (b - totalBeats) * lastBeatDur
    if (i < 0) return beatSec[0] + b * baseBeat
    return beatSec[i] + (b - i) * (beatSec[i + 1] - beatSec[i])
  }
  const sampleAt = (b: number) => Math.round(timeAtBeat(b) * sr)

  const tailSec = 1.2
  const N = Math.ceil((beatSec[totalBeats] + tailSec) * sr)
  const master = new Float32Array(N)
  const T = buildTemplates(sr, seed)
  const barRng = (mat: string, voice: string, bi: number) => mulberry32(hashStr(`${mat}:${voice}:${bi}`) ^ seed)

  // --- which bars carry fills -----------------------------------------------------------------
  /** global bar -> fill length in beats */
  const fillBars = new Map<number, number>()
  for (const sec of secs) {
    const every = sec.spec.fillEvery
    if (!every) continue
    const next = secs[sec.index + 1]
    const nextIsTrigger = !!next && !!next.spec.event && next.spec.event.shouldTrigger !== false
    for (let bi = 0; bi < sec.spec.bars; bi++) {
      if ((bi + 1) % every !== 0) continue
      if (bi === sec.spec.bars - 1 && nextIsTrigger) continue
      fillBars.set(sec.startBar + bi, every >= 8 ? 2 : 1)
    }
  }

  // --- percussion, bass, lead, riser, impact (all mixed straight into `master`) ------------------
  const hit = (tpl: Float32Array, beatPos: number, gain: number) => mixTemplate(master, tpl, sampleAt(beatPos), gain)
  for (const sec of secs) {
    const sp = sec.spec
    const lv = { ...DEFAULT_LEVELS, ...sp.levels }
    const mat = sec.material
    const muted = (v: VoiceName, bi: number) => {
      const m = sp.mute?.[v]
      return !!m && bi >= m[0] && bi < m[1]
    }
    const snareTpl = sp.snareVoice === 'clap' ? T.clap : T.snare
    const secStartSample = sampleAt(sec.startBar * BPB)

    if (sp.impact) {
      mixTemplate(master, T.impact, secStartSample, 0.9)
      mixTemplate(master, T.crash, secStartSample, 0.45)
    }
    if (sp.riser) addRiser(master, sr, secStartSample, sampleAt(sec.endBar * BPB), lv.riser, mulberry32(hashStr(`${mat}:riser`) ^ seed))

    for (let bi = 0; bi < sp.bars; bi++) {
      const bar = sec.startBar + bi
      const b0 = bar * BPB
      const rnd = barRng(mat, 'bar', bi)
      const fillLen = fillBars.get(bar) ?? 0
      const rollBars = sp.snareRoll ?? 0
      const inRoll = rollBars > 0 && bi >= sp.bars - rollBars && !muted('snare', bi)

      if (!muted('kick', bi)) for (const b of KICK_BEATS[sp.kick ?? 'off']) hit(T.kick, b0 + b, lv.kick)

      if (inRoll) {
        const r = bi - (sp.bars - rollBars)
        const frac = r / rollBars
        const perBeat = frac < 0.5 ? 2 : frac < 0.85 ? 4 : 8
        for (let beat = 0; beat < BPB; beat++) {
          for (let j = 0; j < perBeat; j++) {
            const prog = (r * BPB + beat + j / perBeat) / (rollBars * BPB)
            hit(snareTpl, b0 + beat + j / perBeat, lv.snare * (0.25 + 0.75 * prog))
          }
        }
      } else if (!muted('snare', bi)) {
        for (const b of SNARE_BEATS[sp.snare ?? 'off']) if (b < BPB - fillLen) hit(snareTpl, b0 + b, lv.snare)
      }
      if (fillLen > 0) {
        const startBeat = BPB - fillLen
        const hits = fillLen * 4
        for (let j = 0; j < hits; j++) hit(T.snare, b0 + startBeat + j / 4, lv.snare * (0.5 + (0.5 * j) / hits))
        if (fillLen >= 2) mixTemplate(master, T.crash, sampleAt(b0 + BPB), 0.4)
      }

      if (!muted('hats', bi)) {
        const hatPat = sp.hats ?? 'off'
        if (hatPat === 'eighth') {
          for (let beat = 0; beat < BPB; beat++) {
            hit(T.hatClosed[(beat * 2) % 3], b0 + beat, lv.hats * (0.6 + 0.1 * rnd()))
            hit(T.hatClosed[(beat * 2 + 1) % 3], b0 + beat + 0.5, lv.hats * (0.95 + 0.1 * rnd()))
          }
        } else if (hatPat === 'sixteenth') {
          const vel = [0.85, 0.35, 0.6, 0.35]
          for (let j = 0; j < 16; j++) hit(T.hatClosed[j % 3], b0 + j / 4, lv.hats * vel[j % 4] * (0.9 + 0.2 * rnd()))
        } else if (hatPat === 'offbeat') {
          for (let beat = 0; beat < BPB; beat++) hit(T.hatOpen, b0 + beat + 0.5, lv.hats * 0.75)
        }
      }

      const chordBars = sp.chordBars ?? 1
      const chordIdx = Math.floor(bi / chordBars) % sp.chords.length
      const ch = sp.chords[chordIdx]
      const keyOff = sp.key ?? 0

      if (!muted('bass', bi) && (sp.bass ?? 'off') !== 'off') {
        const f0 = midiToHz(bassMidi(ch.root + keyOff))
        const cutoff = sp.bassCutoff ?? 450
        const note = (beatPos: number, lenBeats: number, g: number) =>
          addBassNote(master, sr, sampleAt(b0 + beatPos), sampleAt(b0 + beatPos + lenBeats) - sampleAt(b0 + beatPos), f0, lv.bass * g, cutoff, 2.5)
        const pat = sp.bass as BassPattern
        if (pat === 'root') {
          note(0, 1.8, 1)
          note(2, 1.8, 0.85)
        } else if (pat === 'eighth') {
          for (let j = 0; j < 8; j++) note(j * 0.5, 0.42, j % 2 === 0 ? 1 : 0.75)
        } else if (pat === 'offbeat') {
          for (let beat = 0; beat < BPB; beat++) note(beat + 0.5, 0.4, 1)
        } else {
          note(0, 3.9, 1)
        }
      }

      const leadPat = sp.lead ?? 'off'
      if (!muted('lead', bi) && leadPat !== 'off') {
        const tones = chordNotes(ch, keyOff, 72)
        const n = tones.length
        const cutoff = sp.leadCutoff ?? 3000
        const note = (beatPos: number, lenBeats: number, idx: number, g: number) => {
          const midi = tones[idx % n] + 12 * Math.floor(idx / n)
          addLeadNote(master, sr, sampleAt(b0 + beatPos), sampleAt(b0 + beatPos + lenBeats) - sampleAt(b0 + beatPos), midiToHz(midi), lv.lead * g, cutoff)
        }
        if (leadPat === 'arp') {
          for (let j = 0; j < 8; j++) note(j * 0.5, 0.45, ARP_STEPS[j], j % 2 === 0 ? 1 : 0.8)
        } else {
          const mr = barRng(mat, 'lead', bi)
          for (let beat = 0; beat < BPB; beat++) {
            if (mr() < 0.15) continue
            if (mr() < 0.35) {
              note(beat, 0.45, Math.floor(mr() * (n + 2)), 1)
              note(beat + 0.5, 0.45, Math.floor(mr() * (n + 2)), 0.85)
            } else {
              note(beat, 0.9, Math.floor(mr() * (n + 2)), 1)
            }
          }
        }
      }
    }
  }

  // --- pad bus: chord notes (detuned saws) through a moving low-pass, then into the mix -------------
  {
    const scratch = new Float32Array(N)
    for (const sec of secs) {
      const sp = sec.spec
      if (sp.pad === false) continue
      const lv = { ...DEFAULT_LEVELS, ...sp.levels }
      const chordBars = sp.chordBars ?? 1
      const attackN = Math.floor((sp.padAttackSec ?? 0.05) * sr)
      const releaseN = Math.max(1, Math.floor((sp.padReleaseSec ?? 0.3) * sr))
      for (let bi = 0; bi < sp.bars; bi += chordBars) {
        const m = sp.mute?.pad
        if (m && bi >= m[0] && bi < m[1]) continue
        const chordIdx = Math.floor(bi / chordBars) % sp.chords.length
        const notes = chordNotes(sp.chords[chordIdx], sp.key ?? 0, 48)
        const segBars = Math.min(chordBars, sp.bars - bi)
        const start = sampleAt((sec.startBar + bi) * BPB)
        const len = sampleAt((sec.startBar + bi + segBars) * BPB) - start
        for (let ni = 0; ni < notes.length; ni++) {
          const f = midiToHz(notes[ni])
          const incs = Float64Array.of((f * Math.pow(2, -6 / 1200)) / sr, (f * Math.pow(2, 6 / 1200)) / sr)
          const pr = mulberry32(hashStr(`${sec.material}:pad:${chordIdx}:${ni}`) ^ seed)
          addSawStack(scratch, start, len, incs, Float64Array.of(pr(), pr()), attackN, releaseN, lv.pad)
        }
      }
    }
    // cutoff curve: log-interpolated per section, +-10% slow LFO
    const segs = secs.map((sec) => {
      const c = sec.spec.padCutoff ?? [2000, 2000]
      return { a: sampleAt(sec.startBar * BPB), b: sampleAt(sec.endBar * BPB), c0: c[0], c1: c[1] }
    })
    let cursor = 0
    const cutoffAt = (i: number) => {
      while (cursor + 1 < segs.length && i >= segs[cursor].b) cursor++
      const s = segs[cursor]
      const p = clamp((i - s.a) / Math.max(1, s.b - s.a), 0, 1)
      return s.c0 * Math.pow(s.c1 / s.c0, p) * (1 + 0.1 * Math.sin((TWO_PI * 0.11 * i) / sr))
    }
    svfLowpass(scratch, sr, cutoffAt, 0.9)
    for (let i = 0; i < N; i++) master[i] += scratch[i]
  }

  // --- section RMS normalisation + level ramps ------------------------------------------------------
  {
    const h = Math.max(1, Math.round(0.005 * sr))
    const knots: Array<[number, number]> = []
    for (const sec of secs) {
      const sp = sec.spec
      const a = sampleAt(sec.startBar * BPB)
      const b = Math.min(N, sampleAt(sec.endBar * BPB))
      let norm = 1
      if (sp.rmsDb !== undefined) {
        let sq = 0
        for (let i = a; i < b; i++) sq += master[i] * master[i]
        const rms = Math.sqrt(sq / Math.max(1, b - a))
        if (rms > 1e-9) norm = dbToLin(sp.rmsDb) / rms
      }
      const [db0, db1] = sp.level ?? [0, 0]
      const nSeg = Math.max(1, Math.ceil((b - a) / (0.5 * sr)))
      for (let j = 0; j <= nSeg; j++) {
        let s = a + ((b - a) * j) / nSeg
        if (j === 0) s = a + h
        if (j === nSeg) s = b - h
        knots.push([s, norm * dbToLin(db0 + ((db1 - db0) * j) / nSeg)])
      }
    }
    applyKnots(master, knots)
  }

  // --- whole-mix gain steps (a volume knob) ----------------------------------------------------------
  const steps = [...(spec.gainSteps ?? [])].sort((x, y) => x.bar - y.bar)
  if (steps.length > 0) {
    const h = Math.max(1, Math.round(0.005 * sr))
    const knots: Array<[number, number]> = [[0, 1]]
    let g = 1
    for (const st of steps) {
      const t = sampleAt(st.bar * BPB)
      knots.push([t - h, g])
      g *= dbToLin(st.db)
      knots.push([t + h, g])
    }
    applyKnots(master, knots)
  }

  // --- silence gaps ---------------------------------------------------------------------------------------
  const silenceRanges = (spec.silences ?? []).map((s) => {
    const b = s.bar * BPB + s.beat
    return { startBeat: b, a: sampleAt(b), b: sampleAt(b + s.beats), bar: s.bar, beat: s.beat }
  })
  {
    const f = Math.max(1, Math.round(0.002 * sr))
    for (const g of silenceRanges) {
      for (let i = g.a; i < Math.min(N, g.b); i++) master[i] = 0
      for (let j = 0; j < f; j++) {
        const w = j / f
        if (g.a - f + j >= 0) master[g.a - f + j] *= 1 - w
        if (g.b + j < N) master[g.b + j] *= w
      }
    }
  }

  // --- end fade, peak normalisation ---------------------------------------------------------------------
  {
    const f = Math.min(N, Math.floor(0.3 * sr))
    for (let j = 0; j < f; j++) master[N - 1 - j] *= j / f
    let peak = 0
    for (let i = 0; i < N; i++) {
      const v = Math.abs(master[i])
      if (v > peak) peak = v
    }
    if (peak > 0) {
      const s = peakTarget / peak
      for (let i = 0; i < N; i++) master[i] *= s
    }
  }

  // --- truth, sections, beat lists --------------------------------------------------------------------
  const firstOf = new Map<string, number>()
  const sections: SynthSection[] = secs.map((sec) => {
    const repeat = firstOf.get(sec.material)
    if (repeat === undefined) firstOf.set(sec.material, sec.index)
    const variant = sec.spec.variantOf !== undefined ? firstOf.get(sec.spec.variantOf) : undefined
    return {
      index: sec.index,
      label: sec.spec.label,
      material: sec.material,
      startBar: sec.startBar,
      endBar: sec.endBar,
      startBeat: sec.startBar * BPB,
      startSec: timeAtBeat(sec.startBar * BPB),
      endSec: timeAtBeat(sec.endBar * BPB),
      repeatOf: repeat ?? null,
      variantOf: variant ?? null,
      isEventBoundary: !!sec.spec.event,
    }
  })

  const truth: TruthEvent[] = []
  const at = (beat: number, type: TruthEventType, shouldTrigger: boolean, extra: Partial<TruthEvent> = {}) => {
    truth.push({ type, timeSec: timeAtBeat(beat), beat, bar: Math.floor(beat / BPB), shouldTrigger, ...extra })
  }
  for (const sec of secs) {
    const ev = sec.spec.event
    if (!ev) continue
    const s = sections[sec.index]
    at(s.startBeat, ev.type, ev.shouldTrigger ?? true, {
      note: ev.note,
      sectionIndex: sec.index,
      ...(s.repeatOf !== null ? { repeatOf: s.repeatOf } : {}),
    })
  }
  for (const [bar, len] of fillBars) at(bar * BPB + BPB - len, 'fill', false, { note: len >= 2 ? 'long fill' : 'short fill' })
  for (const st of steps) at(st.bar * BPB, 'gain', false, { note: `${st.db > 0 ? '+' : ''}${st.db} dB step` })
  for (const g of silenceRanges) at(g.startBeat, 'silence', false, { note: 'silence gap' })
  for (const x of spec.extraTruth ?? []) at(x.bar * BPB + (x.beat ?? 0), x.type, x.shouldTrigger, { note: x.note })
  truth.sort((a, b) => a.timeSec - b.timeSec || a.beat - b.beat)

  const beatTimes = Array.from(beatSec.subarray(0, totalBeats))
  const barTimes: number[] = []
  for (let i = 0; i < totalBars; i++) barTimes.push(beatTimes[i * BPB])

  return {
    name: spec.name,
    description: spec.description ?? '',
    pcm: master,
    sampleRate: sr,
    bpm: spec.bpm,
    beatTimes,
    barTimes,
    truth,
    sections,
    songEndSec: beatSec[totalBeats],
    beatsPerBar: 4,
  }
}

/* ------------------------------------------------------------------------------------------------
 * The stimulus catalogue
 * ---------------------------------------------------------------------------------------------- */

export interface StimulusOptions {
  seed?: number
  /** Default 44100. */
  sampleRate?: number
  /** Override the tempo (default per stimulus). */
  bpm?: number
}

const C = PC
const PROG_AM_F_C_G: Chord[] = [chord(C.A, 'min'), chord(C.F), chord(C.C), chord(C.G)]
const PROG_C_G_AM_F: Chord[] = [chord(C.C), chord(C.G), chord(C.A, 'min'), chord(C.F)]
const PROG_D_A_BM_G: Chord[] = [chord(C.D), chord(C.A), chord(C.B, 'min'), chord(C.G)]
const PROG_AM7_FMAJ7: Chord[] = [chord(C.A, 'min7'), chord(C.F, 'maj7'), chord(C.A, 'min7'), chord(C.E, 'min7')]

const finish = (o: StimulusOptions, spec: SongSpec): SynthSong =>
  synthSong({ ...spec, seed: o.seed ?? spec.seed ?? 1, sampleRate: o.sampleRate ?? spec.sampleRate ?? 44100, bpm: o.bpm ?? spec.bpm })

/** A plain groove used by the negative-only stimuli (one steady section). */
const GROOVE: Omit<SectionSpec, 'label' | 'bars' | 'chords'> = {
  kick: 'four',
  snare: 'backbeat',
  hats: 'eighth',
  bass: 'root',
  padCutoff: [1600, 1600],
}

/**
 * 16 steady bars, a 16-bar riser build (filter sweep, crescendo, snare roll over the last 4 bars, kick dropout
 * for the last 4 bars, hats only from bar 8), then a 16-bar drop with impact. 128 BPM, ~90 s.
 * Truth: buildStart @ bar 16 (+), drop @ bar 32 (+), one fill in the drop @ bar 39 (-).
 */
export function buildThenDrop(o: StimulusOptions = {}): SynthSong {
  return finish(o, {
    name: 'buildThenDrop',
    description: '16-bar groove, 16-bar riser build with snare roll and kick dropout, 16-bar drop',
    bpm: 128,
    sections: [
      { ...GROOVE, label: 'groove', bars: 16, chords: PROG_AM_F_C_G, levels: { kick: 0.85 } },
      {
        label: 'build',
        bars: 16,
        chords: [chord(C.A, 'min')],
        chordBars: 4,
        kick: 'four',
        mute: { kick: [12, 16], hats: [0, 8] },
        hats: 'sixteenth',
        snareRoll: 4,
        riser: true,
        padCutoff: [700, 9000],
        level: [-4, 3],
        event: { type: 'buildStart' },
      },
      {
        label: 'drop',
        bars: 16,
        chords: PROG_AM_F_C_G,
        kick: 'four',
        snare: 'backbeat',
        hats: 'sixteenth',
        bass: 'eighth',
        lead: 'arp',
        padCutoff: [6000, 6000],
        impact: true,
        fillEvery: 8,
        event: { type: 'drop' },
      },
    ],
  })
}

/**
 * Full groove 16 bars, an 8-bar breakdown (kick, snare and bass drop out; pad, offbeat hats and a melody
 * remain), then the full groove returns for 16 bars. 124 BPM, ~77 s.
 * Truth: breakdown @ bar 16 (+), drop @ bar 24 (+, the kick/bass return), a fill @ bar 7 (-).
 */
export function breakdown(o: StimulusOptions = {}): SynthSong {
  const full: Omit<SectionSpec, 'label' | 'bars'> = {
    chords: PROG_AM_F_C_G,
    kick: 'four',
    snare: 'backbeat',
    hats: 'eighth',
    bass: 'eighth',
    lead: 'arp',
    padCutoff: [2600, 2600],
    material: 'full',
  }
  return finish(o, {
    name: 'breakdown',
    description: '16 full bars, 8-bar breakdown without kick/snare/bass, 16 full bars',
    bpm: 124,
    sections: [
      { ...full, label: 'full', bars: 16, fillEvery: 8 },
      {
        label: 'breakdown',
        bars: 8,
        chords: PROG_AM_F_C_G,
        chordBars: 2,
        hats: 'offbeat',
        lead: 'melody',
        padCutoff: [1400, 2200],
        level: [-6, -6],
        event: { type: 'breakdown' },
      },
      { ...full, label: 'full', bars: 16, impact: true, event: { type: 'drop', note: 'return of kick and bass' } },
    ],
  })
}

/**
 * Verse (dark saw pad, root bass, soft 1&3 kick, quiet 8th hats) against chorus (bright pad, arp lead, 8th-note
 * bass, 16th hats, four-on-the-floor) with DIFFERENT chords, both normalised to the SAME RMS (-20 dBFS raw).
 * 126 BPM, V16 C16 V8 C8 = 48 bars, ~91 s. Truth: change @ bars 16, 32, 40 (+).
 */
export function verseChorusEqualLoudness(o: StimulusOptions = {}): SynthSong {
  const verse: Omit<SectionSpec, 'bars'> = {
    label: 'verse',
    chords: PROG_AM7_FMAJ7,
    chordBars: 2,
    kick: 'oneAndThree',
    hats: 'eighth',
    bass: 'root',
    padCutoff: [800, 800],
    levels: { kick: 0.6, hats: 0.5 },
    rmsDb: -20,
  }
  const chorus: Omit<SectionSpec, 'bars'> = {
    label: 'chorus',
    chords: PROG_D_A_BM_G,
    kick: 'four',
    hats: 'sixteenth',
    bass: 'eighth',
    lead: 'arp',
    padCutoff: [4200, 4200],
    rmsDb: -20,
  }
  return finish(o, {
    name: 'verseChorusEqualLoudness',
    description: 'verse vs chorus at equal RMS: different timbre, chord set and hat pattern',
    bpm: 126,
    sections: [
      { ...verse, bars: 16 },
      { ...chorus, bars: 16, event: { type: 'change' } },
      { ...verse, bars: 8, event: { type: 'change' } },
      { ...chorus, bars: 8, event: { type: 'change' } },
    ],
  })
}

/**
 * The same loop (pad, bass, kick, hats, arp) in C major, then modulated +2 semitones, then +2 again, every
 * section normalised to the same RMS: only the harmony moves. 116 BPM, 48 bars, ~99 s.
 * Truth: change @ bars 16 and 32 (+).
 */
export function keyChangeEqualLoudness(o: StimulusOptions = {}): SynthSong {
  const loop = (key: number, extra: Partial<SectionSpec> = {}): SectionSpec => ({
    label: `key+${key}`,
    material: `key+${key}`,
    bars: 16,
    chords: PROG_C_G_AM_F,
    key,
    kick: 'four',
    snare: 'backbeat',
    hats: 'eighth',
    bass: 'root',
    lead: 'arp',
    padCutoff: [2200, 2200],
    rmsDb: -20,
    ...extra,
  })
  return finish(o, {
    name: 'keyChangeEqualLoudness',
    description: 'identical loop transposed +2 then +2 semitones at equal RMS',
    bpm: 116,
    sections: [loop(0), loop(2, { event: { type: 'change', note: '+2 semitones' } }), loop(4, { event: { type: 'change', note: '+2 semitones' } })],
  })
}

/**
 * 16 steady bars (dark, quiet), a 16-bar morph (pad cutoff 500 -> 5000 Hz and +6 dB, nothing else changes),
 * then 16 steady bars (bright, loud). 120 BPM, ~96 s.
 * Truth: ONE positive change at the morph END (bar 32; the state has finished arriving, an at-most-one event is
 * tolerated anywhere inside the morph); three NEGATIVE morph-step events at bars 20, 24, 28 (shouldTrigger false)
 * marking the intermediate steps a detector must not fire on.
 */
export function gradualMorph16(o: StimulusOptions = {}): SynthSong {
  const base: Omit<SectionSpec, 'label' | 'bars'> = {
    chords: PROG_AM_F_C_G,
    kick: 'four',
    snare: 'backbeat',
    hats: 'eighth',
    bass: 'root',
    material: 'morph',
  }
  return finish(o, {
    name: 'gradualMorph16',
    description: '16-bar filter/level morph between two steady states',
    bpm: 120,
    sections: [
      { ...base, label: 'A', bars: 16, padCutoff: [500, 500], level: [-6, -6], material: 'A' },
      { ...base, label: 'morph', bars: 16, padCutoff: [500, 5000], level: [-6, 0], material: 'morph' },
      { ...base, label: 'B', bars: 16, padCutoff: [5000, 5000], level: [0, 0], material: 'B', event: { type: 'change', note: 'morph end' } },
    ],
    extraTruth: [20, 24, 28].map((bar) => ({ bar, type: 'change' as const, shouldTrigger: false, note: 'morph step' })),
  })
}

/**
 * One steady groove with snare fills every 4 bars for 24 bars, then every 8 bars (with a crash) for 24 bars.
 * 124 BPM, 48 bars, ~93 s. Truth: fills only, all NEGATIVE (shouldTrigger false); no positives.
 */
export function fillsOnly(o: StimulusOptions = {}): SynthSong {
  const g = (fillEvery: number): SectionSpec => ({ ...GROOVE, label: 'groove', bars: 24, chords: PROG_AM_F_C_G, lead: 'arp', fillEvery })
  return finish(o, {
    name: 'fillsOnly',
    description: 'a steady groove with snare fills every 4 then every 8 bars: none may trigger',
    bpm: 124,
    sections: [g(4), g(8)],
  })
}

/**
 * A steady groove with a whole-mix +6 dB step at bar 16 and a -6 dB step at bar 32 (a volume knob). 120 BPM,
 * 48 bars, ~96 s. Truth: two gain events, both NEGATIVE.
 */
export function gainStep(o: StimulusOptions = {}): SynthSong {
  return finish(o, {
    name: 'gainStep',
    description: 'steady groove, +6 dB then -6 dB whole-mix steps (volume knob)',
    bpm: 120,
    sections: [{ ...GROOVE, label: 'groove', bars: 48, chords: PROG_AM_F_C_G, lead: 'arp', level: [-6, -6] }],
    gainSteps: [
      { bar: 16, db: 6 },
      { bar: 32, db: -6 },
    ],
  })
}

/**
 * A steady groove with two 2-beat digital-silence gaps (bar 16 beat 2, bar 28 beat 0). 120 BPM, 40 bars,
 * ~80 s. Truth: two silence events, both NEGATIVE.
 */
export function silenceGap(o: StimulusOptions = {}): SynthSong {
  return finish(o, {
    name: 'silenceGap',
    description: 'steady groove with two 2-beat silence gaps mid-section',
    bpm: 120,
    sections: [{ ...GROOVE, label: 'groove', bars: 40, chords: PROG_AM_F_C_G, lead: 'arp' }],
    silences: [
      { bar: 16, beat: 2, beats: 2 },
      { bar: 28, beat: 0, beats: 2 },
    ],
  })
}

/**
 * Verse / chorus / verse with real changes at bars 16 and 32 while the tempo wobbles +-2% (period 64 beats).
 * 120 BPM nominal, 48 bars, ~96 s. Truth: change @ bars 16, 32 (+); beat/bar times follow the drift.
 */
export function tempoDrift(o: StimulusOptions = {}): SynthSong {
  const verse: SectionSpec = {
    label: 'verse',
    bars: 16,
    chords: PROG_AM7_FMAJ7,
    chordBars: 2,
    kick: 'oneAndThree',
    snare: 'backbeat',
    hats: 'eighth',
    bass: 'root',
    padCutoff: [900, 900],
  }
  return finish(o, {
    name: 'tempoDrift',
    description: 'verse/chorus/verse under a +-2% tempo drift',
    bpm: 120,
    tempoDrift: { depth: 0.02, periodBeats: 64 },
    sections: [
      verse,
      {
        label: 'chorus',
        bars: 16,
        chords: PROG_D_A_BM_G,
        kick: 'four',
        snare: 'backbeat',
        hats: 'sixteenth',
        bass: 'eighth',
        lead: 'arp',
        padCutoff: [4000, 4000],
        event: { type: 'change' },
      },
      { ...verse, event: { type: 'change' } },
    ],
  })
}

/**
 * No drums: four 10-bar pad sections at 90 BPM with slow attacks/releases, different chord sets and a drifting
 * filter; the changes are harmonic and timbral only. 40 bars, ~107 s. Truth: change @ bars 10, 20, 30 (+).
 */
export function slowAmbient(o: StimulusOptions = {}): SynthSong {
  const pad = (label: string, chords: Chord[], cutoff: [number, number], event?: SectionSpec['event']): SectionSpec => ({
    label,
    bars: 10,
    chords,
    chordBars: 2,
    padCutoff: cutoff,
    padAttackSec: 1.2,
    padReleaseSec: 1.5,
    levels: { pad: 1 },
    event,
  })
  return finish(o, {
    name: 'slowAmbient',
    description: 'drumless pad morphs: slow attacks, changing chord sets and filter movement',
    bpm: 90,
    sections: [
      pad('a', [chord(C.C, 'maj7'), chord(C.A, 'min7')], [600, 1100]),
      pad('b', [chord(C.F, 'maj7'), chord(C.E, 'min7')], [1800, 900], { type: 'change' }),
      pad('c', [chord(C.D, 'min7'), chord(C.G, 'sus4')], [900, 2500], { type: 'change' }),
      pad('d', [chord(C.Bb, 'maj7'), chord(C.G, 'min7')], [2500, 700], { type: 'change' }),
    ],
  })
}

/**
 * A B A B': 16 bars each at 128 BPM (~120 s). A is sparse (Am F C G), B is full (D A Bm G). The third section is an EXACT repeat of A
 * (same material: same notes, phases, melody) and the fourth is a VARIATION of B (same chords and drums, a
 * different lead melody). Truth: change @ bars 16, 32 (repeatOf 0), 48 (variation of section 1) (+).
 */
export function fourSections(o: StimulusOptions = {}): SynthSong {
  const A: SectionSpec = {
    label: 'A',
    bars: 16,
    chords: PROG_AM_F_C_G,
    chordBars: 2,
    kick: 'oneAndThree',
    hats: 'offbeat',
    bass: 'root',
    lead: 'off',
    padCutoff: [900, 900],
  }
  const B: SectionSpec = {
    label: 'B',
    bars: 16,
    chords: PROG_D_A_BM_G,
    kick: 'four',
    snare: 'backbeat',
    hats: 'sixteenth',
    bass: 'eighth',
    lead: 'arp',
    padCutoff: [3800, 3800],
  }
  return finish(o, {
    name: 'fourSections',
    description: "A B A B' with an exact repeat of A and a lead-melody variation of B",
    bpm: 128,
    sections: [
      A,
      { ...B, event: { type: 'change' } },
      { ...A, event: { type: 'change', note: 'exact repeat of section 0' } },
      { ...B, label: "B'", material: "B'", variantOf: 'B', lead: 'melody', event: { type: 'change', note: 'variation of section 1' } },
    ],
  })
}

/**
 * A whole song: intro 8, verse 16, build 8, drop 16, breakdown 8, build 8, drop 16, outro 8 (88 bars) at 140 BPM
 * (~151 s: the specified structure cannot fit 120 s at <= 140 BPM). The two drops (and the two builds) are exact
 * repeats. Truth: change @ 8, buildStart @ 24, drop @ 32, breakdown @ 48, buildStart @ 56, drop @ 64, change @ 80
 * (all +); fills @ bars 15, 39, 71 (-).
 */
export function mixed(o: StimulusOptions = {}): SynthSong {
  const build = (): SectionSpec => ({
    label: 'build',
    bars: 8,
    chords: [chord(C.A, 'min')],
    chordBars: 4,
    kick: 'four',
    mute: { kick: [6, 8], hats: [0, 3] },
    hats: 'sixteenth',
    snareRoll: 4,
    riser: true,
    padCutoff: [800, 8000],
    level: [-3, 3],
  })
  const drop = (): SectionSpec => ({
    label: 'drop',
    bars: 16,
    chords: PROG_AM_F_C_G,
    kick: 'four',
    snare: 'backbeat',
    hats: 'sixteenth',
    bass: 'eighth',
    lead: 'arp',
    padCutoff: [5500, 5500],
    impact: true,
    fillEvery: 8,
  })
  return finish(o, {
    name: 'mixed',
    description: 'intro, verse, build, drop, breakdown, build, drop, outro',
    bpm: 140,
    sections: [
      {
        label: 'intro',
        bars: 8,
        chords: PROG_AM_F_C_G,
        chordBars: 2,
        kick: 'oneAndThree',
        hats: 'eighth',
        padCutoff: [700, 700],
        level: [-9, -9],
        levels: { kick: 0.6, hats: 0.5 },
      },
      {
        label: 'verse',
        bars: 16,
        chords: PROG_AM_F_C_G,
        kick: 'oneAndThree',
        snare: 'backbeat',
        hats: 'eighth',
        bass: 'root',
        padCutoff: [1500, 1500],
        level: [-3, -3],
        fillEvery: 8,
        event: { type: 'change' },
      },
      { ...build(), event: { type: 'buildStart' } },
      { ...drop(), event: { type: 'drop' } },
      {
        label: 'breakdown',
        bars: 8,
        chords: PROG_AM_F_C_G,
        chordBars: 2,
        hats: 'offbeat',
        lead: 'melody',
        padCutoff: [1300, 2200],
        level: [-6, -6],
        event: { type: 'breakdown' },
      },
      { ...build(), event: { type: 'buildStart' } },
      { ...drop(), event: { type: 'drop' } },
      {
        label: 'outro',
        bars: 8,
        chords: PROG_AM_F_C_G,
        chordBars: 2,
        kick: 'oneAndThree',
        hats: 'eighth',
        padCutoff: [900, 900],
        level: [-6, -14],
        levels: { kick: 0.6, hats: 0.5 },
        event: { type: 'change' },
      },
    ],
  })
}

export const STIMULUS_NAMES = [
  'buildThenDrop',
  'breakdown',
  'verseChorusEqualLoudness',
  'keyChangeEqualLoudness',
  'gradualMorph16',
  'fillsOnly',
  'gainStep',
  'silenceGap',
  'tempoDrift',
  'slowAmbient',
  'fourSections',
  'mixed',
] as const
export type StimulusName = (typeof STIMULUS_NAMES)[number]

export const STIMULI: Record<StimulusName, (o?: StimulusOptions) => SynthSong> = {
  buildThenDrop,
  breakdown,
  verseChorusEqualLoudness,
  keyChangeEqualLoudness,
  gradualMorph16,
  fillsOnly,
  gainStep,
  silenceGap,
  tempoDrift,
  slowAmbient,
  fourSections,
  mixed,
}
