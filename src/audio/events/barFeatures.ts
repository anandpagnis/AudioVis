/**
 * Per-beat FEATURE VECTORS for the live change scorer, extracted from the `BeatCell` the slow analyser already folds
 * (`structure/StructureAnalyzer.ts`): no second feature extraction, only a re-arrangement into the eight change
 * channels of the plan and the window arithmetic the scorer needs.
 *
 * ## The eight channels (F = 8)
 *   0 level    raw RMS in dB (SIGNED difference). The only channel a volume knob moves.
 *   1 low      sub+bass dB relative to the RMS (a tilt, so it is gain-invariant; SIGNED).
 *   2 mid      mid+presence dB relative to the RMS (SIGNED).
 *   3 high     high+air dB relative to the RMS (SIGNED).
 *   4 timbre   1 - cos of the mean-centred LOG-mel shapes (13 bands): exactly invariant to a uniform gain.
 *   5 harmony  1 - cos of the mean-centred chroma (12 bins, the analyser's 2 s-tau chroma).
 *   6 rhythm   onset density 0..1 (SIGNED).
 *   7 texture  Euclid distance of (spectral flatness, centroid).
 *
 * A window compares the mean of the newest N beats with the mean of the M before them (`channelDistances`).
 * Everything that is not the level channel is gain-invariant BY CONSTRUCTION: the raw dB bands enter only as tilts, the
 * mel vector is inverted from `log1p` back to a real log and mean-centred, and the chroma is L2-normalised. So a
 * uniform all-band shift moves the level channel and nothing else, which is how `EventLayer` recognises `gain`.
 *
 * Cells from the engine carry `raw` (`rawTap.ts`). A cell without it (an old trace, a test) falls back to the
 * normalised bands on a pseudo-dB scale: still usable for shape channels, but the level channel is then only the
 * front end's loudness and a "louder chorus" is invisible, exactly the defect the tap fixes.
 *
 * Pure and allocation-free after construction.
 */
import type { BeatCell } from '../essentia/structureDsp'

export const MEL_N = 13
export const CHROMA_N = 12

/** Layout of one feature vector. */
export const OFF_LEVEL = 0
export const OFF_LOW = 1
export const OFF_MID = 2
export const OFF_HIGH = 3
export const OFF_ONSET = 4
export const OFF_FLAT = 5
export const OFF_CENT = 6
export const OFF_MEL = 7
export const OFF_CHROMA = OFF_MEL + MEL_N
export const FEATURE_DIM = OFF_CHROMA + CHROMA_N
/** The section-signature slice (everything except the gain-variant level): `[OFF_LOW, FEATURE_DIM)`. */
export const SIG_OFF = OFF_LOW
export const SIG_DIM = FEATURE_DIM - SIG_OFF

/** Channel indices of the scorer. */
export const CH_LEVEL = 0
export const CH_LOW = 1
export const CH_MID = 2
export const CH_HIGH = 3
export const CH_TIMBRE = 4
export const CH_HARMONY = 5
export const CH_RHYTHM = 6
export const CH_TEXTURE = 7
export const CHANNELS = 8
export const CHANNEL_NAMES = ['level', 'low', 'mid', 'high', 'timbre', 'harmony', 'rhythm', 'texture'] as const

const finite = (x: number, fallback = 0): number => (Number.isFinite(x) ? x : fallback)
const DB_LIM = 120

/**
 * Write the feature vector of `cell` into `out[off .. off + FEATURE_DIM)`. Total: any non-finite or missing input
 * reads as a neutral zero, never NaN (a NaN in a window would poison every later distance).
 */
export function extractFeatures(cell: BeatCell, out: Float64Array, off = 0): void {
  const raw = cell.raw
  if (raw !== undefined && raw.length >= 7) {
    const rms = Math.max(-DB_LIM, Math.min(DB_LIM, finite(raw[6], -DB_LIM)))
    const low = (finite(raw[0], -DB_LIM) + finite(raw[1], -DB_LIM)) * 0.5
    const mid = (finite(raw[2], -DB_LIM) + finite(raw[3], -DB_LIM)) * 0.5
    const high = (finite(raw[4], -DB_LIM) + finite(raw[5], -DB_LIM)) * 0.5
    out[off + OFF_LEVEL] = rms
    out[off + OFF_LOW] = Math.max(-DB_LIM, Math.min(DB_LIM, low - rms))
    out[off + OFF_MID] = Math.max(-DB_LIM, Math.min(DB_LIM, mid - rms))
    out[off + OFF_HIGH] = Math.max(-DB_LIM, Math.min(DB_LIM, high - rms))
  } else {
    // Fallback: the normalised (0..1) front-end values on a pseudo-dB scale. Shape only; level is not trustworthy.
    out[off + OFF_LEVEL] = 20 * finite(cell.logRms)
    out[off + OFF_LOW] = 10 * (finite(cell.sub) + finite(cell.bass)) * 0.5
    out[off + OFF_MID] = 10 * finite(cell.mid)
    out[off + OFF_HIGH] = 10 * (finite(cell.high) + finite(cell.air)) * 0.5
  }
  out[off + OFF_ONSET] = finite(cell.onsetDensity)
  out[off + OFF_FLAT] = finite(cell.flatness)
  out[off + OFF_CENT] = finite(cell.centroid)

  // Mel: `melBands` returns log1p(band sum); invert to the band sum, take a real log (floored 60 dB under the loudest
  // band so a dead band cannot dominate), and centre. A uniform gain is then a constant offset that centring removes.
  const mel = cell.mfcc
  let ref = 0
  for (let i = 0; i < MEL_N; i++) {
    const m = i < mel.length ? finite(mel[i]) : 0
    const s = m > 0 ? Math.expm1(m) : 0
    out[off + OFF_MEL + i] = s
    if (s > ref) ref = s
  }
  const floor = Math.max(1e-9, ref * 1e-3)
  let mean = 0
  for (let i = 0; i < MEL_N; i++) {
    const v = Math.log(Math.max(out[off + OFF_MEL + i], floor))
    out[off + OFF_MEL + i] = v
    mean += v
  }
  mean /= MEL_N
  for (let i = 0; i < MEL_N; i++) out[off + OFF_MEL + i] -= mean

  const hp = cell.hpcp
  let cm = 0
  for (let i = 0; i < CHROMA_N; i++) {
    const v = i < hp.length ? finite(hp[i]) : 0
    out[off + OFF_CHROMA + i] = v
    cm += v
  }
  cm /= CHROMA_N
  for (let i = 0; i < CHROMA_N; i++) out[off + OFF_CHROMA + i] -= cm
}

/** 1 - cosine of two vectors (0 when either has no direction: nothing to compare). */
export function cosDistance(a: Float64Array, oa: number, b: Float64Array, ob: number, n: number): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    const x = a[oa + i]
    const y = b[ob + i]
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na < 1e-12 || nb < 1e-12) return 0
  const c = dot / Math.sqrt(na * nb)
  const d = 1 - (c > 1 ? 1 : c < -1 ? -1 : c)
  return d
}

/** Chroma distance alone (the harmony channel compares longer windows than the fast channels, see the scorer). */
export function harmonyDistance(newMean: Float64Array, oldMean: Float64Array): number {
  return cosDistance(newMean, OFF_CHROMA, oldMean, OFF_CHROMA, CHROMA_N)
}

/**
 * The eight window distances between two mean feature vectors. Scalar channels are SIGNED (`new - old`), the vector
 * channels are non-negative. `out.length >= CHANNELS`.
 */
export function channelDistances(newMean: Float64Array, oldMean: Float64Array, out: Float64Array): void {
  out[CH_LEVEL] = newMean[OFF_LEVEL] - oldMean[OFF_LEVEL]
  out[CH_LOW] = newMean[OFF_LOW] - oldMean[OFF_LOW]
  out[CH_MID] = newMean[OFF_MID] - oldMean[OFF_MID]
  out[CH_HIGH] = newMean[OFF_HIGH] - oldMean[OFF_HIGH]
  out[CH_TIMBRE] = cosDistance(newMean, OFF_MEL, oldMean, OFF_MEL, MEL_N)
  out[CH_HARMONY] = cosDistance(newMean, OFF_CHROMA, oldMean, OFF_CHROMA, CHROMA_N)
  out[CH_RHYTHM] = newMean[OFF_ONSET] - oldMean[OFF_ONSET]
  const df = newMean[OFF_FLAT] - oldMean[OFF_FLAT]
  const dc = newMean[OFF_CENT] - oldMean[OFF_CENT]
  out[CH_TEXTURE] = Math.sqrt(df * df + dc * dc)
}

/**
 * A fixed-capacity ring of per-beat feature vectors with the beat index and the audio time each was folded at.
 * "Age" 0 is the newest cell. Nothing allocates after construction.
 */
export class FeatureRing {
  readonly cap: number
  readonly data: Float64Array
  readonly beats: Float64Array
  /** The GRID-domain sequence number of each cell: consecutive cells differ by exactly 1 even when the engine's beat
   *  index jumps (see `EventLayer`). Bar phase is learned in this domain. */
  readonly seqs: Float64Array
  readonly times: Float64Array
  private head = 0
  private n = 0

  constructor(cap: number) {
    this.cap = cap
    this.data = new Float64Array(cap * FEATURE_DIM)
    this.beats = new Float64Array(cap)
    this.seqs = new Float64Array(cap)
    this.times = new Float64Array(cap)
  }

  get count(): number {
    return this.n
  }

  clear(): void {
    this.head = 0
    this.n = 0
  }

  /** Offset (into `data`) where the NEXT cell's vector is to be written; call `commit` after writing it. */
  writeOffset(): number {
    return this.head * FEATURE_DIM
  }

  commit(beat: number, time: number, seq: number = beat): void {
    this.beats[this.head] = beat
    this.seqs[this.head] = seq
    this.times[this.head] = time
    this.head = (this.head + 1) % this.cap
    if (this.n < this.cap) this.n++
  }

  /** Forget the newest `k` cells (a tainted beat that must not enter any window). */
  dropNewest(k: number): void {
    const d = Math.min(k, this.n)
    this.head = (this.head - d + this.cap * 2) % this.cap
    this.n -= d
  }

  private slot(age: number): number {
    return (this.head - 1 - age + this.cap * 2) % this.cap
  }

  offsetAt(age: number): number {
    return this.slot(age) * FEATURE_DIM
  }

  beatAt(age: number): number {
    return this.beats[this.slot(age)]
  }

  seqAt(age: number): number {
    return this.seqs[this.slot(age)]
  }

  timeAt(age: number): number {
    return this.times[this.slot(age)]
  }

  /** Age of the cell with grid sequence `seq` (scanning back), or -1 when it is not in the ring. */
  ageOfSeq(seq: number): number {
    for (let a = 0; a < this.n; a++) if (this.seqs[this.slot(a)] === seq) return a
    return -1
  }

  /** Mean of the `len` cells starting at `fromAge` (newest = 0) into `out` (length FEATURE_DIM); false when too few cells. */
  meanWindow(fromAge: number, len: number, out: Float64Array): boolean {
    if (len <= 0 || fromAge < 0 || fromAge + len > this.n) return false
    out.fill(0)
    for (let a = fromAge; a < fromAge + len; a++) {
      const o = this.offsetAt(a)
      for (let i = 0; i < FEATURE_DIM; i++) out[i] += this.data[o + i]
    }
    const inv = 1 / len
    for (let i = 0; i < FEATURE_DIM; i++) out[i] *= inv
    return true
  }
}

/** Welford running mean / variance per dimension, with an exponential cap on the memory (`maxN`). */
export class RunningMoments {
  readonly mean: Float64Array
  readonly m2: Float64Array
  n = 0

  constructor(
    readonly dim: number,
    private readonly maxN = 512,
  ) {
    this.mean = new Float64Array(dim)
    this.m2 = new Float64Array(dim)
  }

  reset(): void {
    this.mean.fill(0)
    this.m2.fill(0)
    this.n = 0
  }

  add(v: Float64Array, off: number): void {
    if (this.n < this.maxN) this.n++
    const inv = 1 / this.n
    for (let i = 0; i < this.dim; i++) {
      const x = v[off + i]
      const d = x - this.mean[i]
      this.mean[i] += d * inv
      this.m2[i] += (d * (x - this.mean[i]) - this.m2[i]) * inv
    }
  }

  /** Standard deviation of dimension `i` (m2 holds the running variance). */
  std(i: number): number {
    return this.n > 1 ? Math.sqrt(Math.max(0, this.m2[i])) : 0
  }
}
