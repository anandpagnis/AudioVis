/**
 * Tempo and beat tracking over a whole-song onset envelope. Clean-room from the published ideas:
 *  - tempo: global autocorrelation of the onset envelope, harmonically enhanced (a beat period is supported by its
 *    2x and 4x multiples), weighted by a log-normal prior on tempo (Ellis 2007; Klapuri et al. 2006);
 *  - beats: Ellis's dynamic-programming tracker. Every frame gets a cumulative score = local onset strength +
 *    the best predecessor's score minus a squared log-interval penalty that pulls consecutive beats towards one
 *    period; the beat sequence is read back from the best final score (backtrace).
 */

export interface TempoCandidate {
  bpm: number
  /** Prior-weighted enhanced autocorrelation at the peak. */
  score: number
  /** Raw normalised autocorrelation at the beat period (0..1). */
  acf: number
}

export interface TempoEstimate {
  /** Chosen tempo (BPM) and its beat period in envelope frames (fractional). */
  bpm: number
  periodFrames: number
  /** Normalised autocorrelation at the chosen period: high (> 0.3) for rhythmic music, near 0 for ambient. */
  acf: number
  /** 0..1 from the peak height relative to the rest of the curve. */
  confidence: number
  candidates: TempoCandidate[]
}

export interface TempoOptions {
  /** Centre of the log-normal tempo prior (BPM). */
  priorBpm?: number
  /** Standard deviation of the prior in octaves. */
  priorOctaves?: number
  minBpm?: number
  maxBpm?: number
}

/** Normalised (unbiased, zero-mean) autocorrelation of `x` for lags `0..maxLag`. */
export function autocorrelation(x: Float32Array | Float64Array, maxLag: number): Float64Array {
  const n = x.length
  let mean = 0
  for (let i = 0; i < n; i++) mean += x[i]
  mean /= Math.max(1, n)
  const z = new Float64Array(n)
  for (let i = 0; i < n; i++) z[i] = x[i] - mean
  const r = new Float64Array(maxLag + 1)
  for (let l = 0; l <= maxLag; l++) {
    if (l >= n) break
    let s = 0
    for (let i = 0; i + l < n; i++) s += z[i] * z[i + l]
    r[l] = s / (n - l)
  }
  const r0 = r[0] > 0 ? r[0] : 1
  for (let l = 0; l <= maxLag; l++) r[l] /= r0
  return r
}

/** Parabolic peak refinement around index `i` of `y`: returns the fractional index. */
export function parabolic(y: ArrayLike<number>, i: number): number {
  if (i <= 0 || i >= y.length - 1) return i
  const a = y[i - 1]
  const b = y[i]
  const c = y[i + 1]
  const d = a - 2 * b + c
  if (d >= 0) return i
  const off = (0.5 * (a - c)) / d
  return off > 1 ? i + 1 : off < -1 ? i - 1 : i + off
}

export function estimateTempo(onset: Float32Array | Float64Array, fps: number, opts: TempoOptions = {}): TempoEstimate {
  const priorBpm = opts.priorBpm ?? 118
  const priorOct = opts.priorOctaves ?? 0.62
  const minBpm = opts.minBpm ?? 55
  const maxBpm = opts.maxBpm ?? 200
  const minLag = Math.max(2, Math.floor((fps * 60) / maxBpm))
  const maxLag = Math.ceil((fps * 60) / minBpm)
  const acf = autocorrelation(onset, Math.min(onset.length - 1, maxLag * 4 + 4))
  const at = (l: number) => (l >= 0 && l < acf.length ? acf[l] : 0)
  // interpolated acf at a fractional lag
  const atf = (l: number) => {
    const i = Math.floor(l)
    const f = l - i
    return at(i) * (1 - f) + at(i + 1) * f
  }
  const lags: number[] = []
  const score = new Float64Array(maxLag + 2)
  for (let l = minLag; l <= maxLag + 1; l++) {
    const bpm = (fps * 60) / l
    const enh = at(l) + 0.5 * atf(2 * l) + 0.25 * atf(4 * l)
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / priorBpm) / priorOct, 2))
    score[l] = enh * prior
    lags.push(l)
  }
  // peaks
  const peaks: number[] = []
  for (let l = minLag + 1; l <= maxLag; l++) {
    if (score[l] > score[l - 1] && score[l] >= score[l + 1] && score[l] > 0) peaks.push(l)
  }
  peaks.sort((a, b) => score[b] - score[a])
  if (peaks.length === 0) {
    const p = Math.round((fps * 60) / priorBpm)
    return { bpm: priorBpm, periodFrames: p, acf: at(p), confidence: 0, candidates: [] }
  }
  const candidates: TempoCandidate[] = []
  for (const l of peaks) {
    const lf = parabolic(score, l)
    const bpm = (fps * 60) / lf
    if (candidates.some((c) => Math.abs(Math.log2(c.bpm / bpm)) < 0.06)) continue
    candidates.push({ bpm, score: score[l], acf: at(l) })
    if (candidates.length >= 4) break
  }
  const best = peaks[0]
  const lf = parabolic(score, best)
  // confidence: peak vs median of the score curve over the searched range
  const vals = Array.from(score.subarray(minLag, maxLag + 1)).sort((a, b) => a - b)
  const med = vals[vals.length >> 1] || 1e-9
  const ratio = score[best] / Math.max(1e-9, Math.abs(med))
  const confidence = Math.max(0, Math.min(1, 1 - Math.exp(-(ratio - 1) / 6))) * Math.max(0, Math.min(1, at(best) / 0.2))
  return { bpm: (fps * 60) / lf, periodFrames: lf, acf: at(best), confidence, candidates }
}

export interface BeatTrack {
  /** Beat positions in envelope frames (fractional, refined). */
  frames: number[]
  /** Mean local onset strength at the beats over the mean over all frames (>1 = beats sit on onsets). */
  onsetRatio: number
}

/**
 * Ellis-style DP beat tracker. `onset` is the (unnormalised) onset envelope; `period` the beat period in frames;
 * `tightness` scales the interval penalty (larger = more metronomic).
 */
export function trackBeats(onset: Float32Array | Float64Array, period: number, tightness = 200): BeatTrack {
  const n = onset.length
  if (n < 4 || !(period >= 2)) return { frames: [], onsetRatio: 0 }
  let sd = 0
  let mean = 0
  for (let i = 0; i < n; i++) mean += onset[i]
  mean /= n
  for (let i = 0; i < n; i++) sd += (onset[i] - mean) * (onset[i] - mean)
  sd = Math.sqrt(sd / n) || 1
  // local score: onset / std smoothed with a narrow Gaussian
  const sigma = Math.max(0.5, period / 32)
  const kr = Math.ceil(3 * sigma)
  const kern = new Float64Array(2 * kr + 1)
  for (let i = -kr; i <= kr; i++) kern[i + kr] = Math.exp(-0.5 * (i / sigma) * (i / sigma))
  const local = new Float64Array(n)
  for (let t = 0; t < n; t++) {
    let s = 0
    for (let i = -kr; i <= kr; i++) {
      const j = t + i
      if (j >= 0 && j < n) s += (onset[j] / sd) * kern[i + kr]
    }
    local[t] = s
  }
  const lo = Math.max(1, Math.round(period / 2))
  const hi = Math.max(lo + 1, Math.round(2 * period))
  // penalty table for interval d in [lo, hi]
  const pen = new Float64Array(hi + 1)
  for (let d = lo; d <= hi; d++) pen[d] = tightness * Math.pow(Math.log(d / period), 2)
  const cum = new Float64Array(n)
  const back = new Int32Array(n).fill(-1)
  for (let t = 0; t < n; t++) {
    let best = -Infinity
    let bi = -1
    for (let d = lo; d <= hi; d++) {
      const p = t - d
      if (p < 0) break
      const v = cum[p] - pen[d]
      if (v > best) {
        best = v
        bi = p
      }
    }
    if (bi >= 0 && best > 0) {
      cum[t] = local[t] + best
      back[t] = bi
    } else {
      cum[t] = local[t]
      back[t] = -1
    }
  }
  // end: the best final score within the last period
  let end = n - 1
  let bestEnd = -Infinity
  for (let t = Math.max(0, n - Math.ceil(period)); t < n; t++) {
    if (cum[t] > bestEnd) {
      bestEnd = cum[t]
      end = t
    }
  }
  const chain: number[] = []
  for (let t = end; t >= 0; t = back[t]) {
    chain.push(t)
    if (back[t] < 0) break
  }
  chain.reverse()
  // parabolic refinement on the raw envelope
  const frames = chain.map((t) => {
    if (t <= 0 || t >= n - 1) return t
    const a = onset[t - 1]
    const b = onset[t]
    const c = onset[t + 1]
    const d = a - 2 * b + c
    if (d >= 0) return t
    const off = (0.5 * (a - c)) / d
    return t + Math.max(-0.5, Math.min(0.5, off))
  })
  let onBeats = 0
  for (const t of chain) onBeats += onset[t]
  onBeats /= Math.max(1, chain.length)
  return { frames, onsetRatio: mean > 1e-9 ? onBeats / mean : 0 }
}

/** Least-squares slope of beat time against beat index with one outlier-rejection pass. Returns seconds per beat. */
export function meanBeatPeriod(times: number[]): number {
  const n = times.length
  if (n < 2) return 0
  const fit = (idx: number[]) => {
    let sx = 0
    let sy = 0
    let sxx = 0
    let sxy = 0
    for (const i of idx) {
      sx += i
      sy += times[i]
      sxx += i * i
      sxy += i * times[i]
    }
    const m = idx.length
    const den = m * sxx - sx * sx
    const slope = den !== 0 ? (m * sxy - sx * sy) / den : 0
    const icpt = (sy - slope * sx) / m
    return { slope, icpt }
  }
  const all = Array.from({ length: n }, (_, i) => i)
  const f0 = fit(all)
  const inl = all.filter((i) => Math.abs(times[i] - (f0.icpt + f0.slope * i)) < 0.35 * f0.slope)
  if (inl.length < 2) return f0.slope
  return fit(inl).slope
}

/**
 * Fold a beat period (frames) into a working tempo range by whole octaves: a bar grid of 4 beats at 74-152 BPM gives
 * sections of 8-32 bars, and the autocorrelation cannot tell 70 from 140 on its own. Slow (< 74) tempi are doubled,
 * fast (>= 152) ones halved.
 */
export function foldPeriod(periodFrames: number, fps: number, lowBpm = 74, highBpm = 152): number {
  let p = periodFrames
  let guard = 0
  while ((fps * 60) / p < lowBpm && guard++ < 4) p /= 2
  while ((fps * 60) / p >= highBpm && guard++ < 8) p *= 2
  return p
}
