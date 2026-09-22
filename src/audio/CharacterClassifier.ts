import {
  CHARACTER_MOODS,
  createEmptyCharacterState,
  type CharacterInput,
  type CharacterMood,
  type CharacterPoint,
  type CharacterState,
} from './characterTypes'
import { CHARACTER_PRIORS } from './characterPriors'
import { MOOD_PROTOTYPES } from './moodTaxonomy'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Softmax temperature applied to the (summed, diagonal-Gaussian) log-likelihood.
 * A 4-axis Gaussian is razor sharp (one sigma off on every axis costs 2 nats),
 * so T > 1 keeps neighbouring moods in play for `secondary`; T <= 1 would make
 * `dist` nearly one-hot. It does not change the argmax. 1.25 is the largest
 * value at which a worst-case step change (a diffuse mood such as `playful`,
 * whose peak probability is low) still commits in ~10 s; at 2.5 it took 19 s.
 */
export const TEMPERATURE = 1.25

/**
 * Time constant (s) of the EMA over `dist` (and over the reported point). About
 * 3 s: long enough that a fill or a one-bar break does not move the read, short
 * enough that a real change of section shows within a few seconds.
 */
export const SMOOTH_TAU_SEC = 3

/** Longest gap (s) the EMA treats as elapsed time; beyond it alpha is ~1 anyway. */
export const MAX_SMOOTH_DT = 30

/**
 * Lowest valence confidence honoured. Valence sigma is divided by the
 * confidence, so 0.25 widens it at most 4x: low confidence lets arousal and
 * tension decide, but never removes valence from the read entirely.
 */
export const MIN_VALENCE_CONFIDENCE = 0.25

/** A challenger must lead the committed primary's smoothed probability by this much... */
export const SWITCH_MARGIN = 0.08
/** ...for this many (evidence-)seconds before it is committed as the new primary. */
export const SWITCH_HOLD_SEC = 6
/** Evidence drains this many times faster than it builds when the lead lapses. */
export const EVIDENCE_DECAY = 2
/** Valid-read seconds before the very first primary is committed. */
export const FIRST_COMMIT_SEC = 2
/** Per-update cap (s) on time counted as evidence, so a stall cannot fast-forward a commit. */
export const MAX_EVIDENCE_DT = 1

/** Runner-up must hold at least this probability to be reported as `secondary`. */
export const SECONDARY_MIN = 0.15
/** A top-two margin of this much (probability) counts as fully decisive for `confidence`. */
export const CONFIDENCE_MARGIN_FULL = 0.6

/**
 * Per-mood log-prior added to the softmax logit, in CHARACTER_MOODS order.
 * Generated (`characterPriors.ts`) so that over a reference set of unlabelled
 * audio the moods win about equally often; mutable only so tests and the
 * calibration script can override it.
 */
export const PRIORS: number[] = CHARACTER_MOODS.map((_, i) => CHARACTER_PRIORS[i] ?? 0)

// ---------------------------------------------------------------------------
// Precomputed prototype tables (flat, indexed [mood * 4 + axis])
// ---------------------------------------------------------------------------

const N = CHARACTER_MOODS.length
const AXES = 4 // valence, arousal, tension, pulse
const LN_N = Math.log(N)

const CENTER = new Float64Array(N * AXES)
const INV_VAR = new Float64Array(N * AXES)
/**
 * -sum(log sigma): the Gaussian normaliser, so tight moods are not unfairly
 * favoured. Valence-confidence widening scales valence's sigma equally for every
 * mood, so its normaliser shift is mood-independent and cancels in the softmax.
 */
const LOG_NORM = new Float64Array(N)
for (let i = 0; i < N; i++) {
  const proto = MOOD_PROTOTYPES[CHARACTER_MOODS[i]]
  const c = proto.center
  const s = proto.spread
  const cs = [c.valence, c.arousal, c.tension, c.pulse]
  const ss = [s.valence, s.arousal, s.tension, s.pulse]
  let ln = 0
  for (let a = 0; a < AXES; a++) {
    CENTER[i * AXES + a] = cs[a]
    INV_VAR[i * AXES + a] = 1 / (ss[a] * ss[a])
    ln -= Math.log(ss[a])
  }
  LOG_NORM[i] = ln
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)

/** Finite -> clamped to 0..1; NaN/Infinity -> `fallback`. */
function sane(x: number, fallback: number): number {
  return Number.isFinite(x) ? clamp01(x) : fallback
}

/**
 * Writes the instantaneous (unsmoothed) probability of every mood into `out`
 * (length >= CHARACTER_MOODS.length, in CHARACTER_MOODS order). Inputs must
 * already be finite and in 0..1. `valenceConfidence` (0..1) widens the valence
 * sigma by 1/confidence.
 */
function instantDist(
  valence: number,
  arousal: number,
  tension: number,
  pulse: number,
  valenceConfidence: number,
  out: ArrayLike<number> & { [i: number]: number },
): void {
  const vc = Math.max(MIN_VALENCE_CONFIDENCE, Math.min(1, valenceConfidence))
  const vw = vc * vc // 1 / (sigma / vc)^2 = invVar * vc^2
  let max = -Infinity
  for (let i = 0; i < N; i++) {
    const o = i * AXES
    const dv = valence - CENTER[o]
    const da = arousal - CENTER[o + 1]
    const dt = tension - CENTER[o + 2]
    const dp = pulse - CENTER[o + 3]
    const logL =
      LOG_NORM[i] -
      0.5 *
        (dv * dv * INV_VAR[o] * vw +
          da * da * INV_VAR[o + 1] +
          dt * dt * INV_VAR[o + 2] +
          dp * dp * INV_VAR[o + 3])
    const logit = logL / TEMPERATURE + PRIORS[i]
    out[i] = logit
    if (logit > max) max = logit
  }
  let sum = 0
  for (let i = 0; i < N; i++) {
    const e = Math.exp(out[i] - max)
    out[i] = e
    sum += e
  }
  const inv = 1 / sum
  for (let i = 0; i < N; i++) out[i] *= inv
}

/**
 * Instantaneous mood distribution for a single point, no smoothing or state.
 * Non-finite components are treated as 0.5 (neutral). Allocation-free when `out`
 * is supplied; intended for tests and offline calibration.
 */
export function computeInstantDist(
  input: CharacterPoint & { valenceConfidence?: number },
  out: Float64Array | number[],
): void {
  const vc = input.valenceConfidence
  instantDist(
    sane(input.valence, 0.5),
    sane(input.arousal, 0.5),
    sane(input.tension, 0.5),
    sane(input.pulse, 0.5),
    vc !== undefined && Number.isFinite(vc) ? vc : 1,
    out,
  )
}

/**
 * Turns the continuous (valence, arousal, tension, pulse) read into a slowly
 * moving, hysteresis-held NAMED mood plus a probability distribution.
 *
 * Pipeline per update: diagonal-Gaussian likelihood under every prototype ->
 * tempered softmax -> EMA over time -> committed `primary` that only changes
 * after a challenger has led by {@link SWITCH_MARGIN} for {@link SWITCH_HOLD_SEC}.
 * Owns one reused {@link CharacterState}; `update` allocates nothing.
 */
export class CharacterClassifier {
  readonly state: CharacterState = createEmptyCharacterState()

  /** Instantaneous distribution scratch. */
  private readonly inst = new Float64Array(N)
  /** Smoothed distribution, kept across invalid gaps. */
  private readonly sm = new Float64Array(N)
  /** Per-mood accumulated evidence (s) toward unseating the primary. */
  private readonly evidence = new Float64Array(N)
  private smValence = 0.5
  private smArousal = 0.5
  private smTension = 0.5
  private smPulse = 0.5
  private hasSmooth = false
  private hasTime = false
  private lastNow = 0
  private validTime = 0
  private committedAt = 0
  private primaryIdx = -1

  reset(): void {
    const s = this.state
    const fresh = createEmptyCharacterState()
    s.valence = fresh.valence
    s.arousal = fresh.arousal
    s.tension = fresh.tension
    s.pulse = fresh.pulse
    for (const m of CHARACTER_MOODS) s.dist[m] = 0
    s.primary = null
    s.secondary = null
    s.secondaryWeight = 0
    s.confidence = 0
    s.entropy = 1
    s.changed = false
    s.heldFor = 0
    s.valid = false
    this.inst.fill(0)
    this.sm.fill(0)
    this.evidence.fill(0)
    this.smValence = 0.5
    this.smArousal = 0.5
    this.smTension = 0.5
    this.smPulse = 0.5
    this.hasSmooth = false
    this.hasTime = false
    this.lastNow = 0
    this.validTime = 0
    this.committedAt = 0
    this.primaryIdx = -1
  }

  /** Feed one read; returns the (reused) state. `now` is in seconds. */
  update(input: CharacterInput, now: number): CharacterState {
    const s = this.state
    s.changed = false

    // --- Time base: robust to irregular, zero, negative and non-finite dt ---
    const t = Number.isFinite(now) ? now : this.lastNow
    let dt = this.hasTime ? t - this.lastNow : 0
    if (!(dt > 0)) dt = 0
    else if (dt > MAX_SMOOTH_DT) dt = MAX_SMOOTH_DT
    this.lastNow = t
    this.hasTime = true

    if (this.primaryIdx >= 0) s.heldFor = Math.max(0, t - this.committedAt)

    // --- Invalid read: report nothing, but hold the primary ---
    if (!input.valid) {
      s.valid = false
      for (let i = 0; i < N; i++) s.dist[CHARACTER_MOODS[i]] = 0
      s.secondary = null
      s.secondaryWeight = 0
      s.confidence = 0
      s.entropy = 1
      return s
    }

    // --- Sanitise (a bad component falls back to the last smoothed value) ---
    const v = sane(input.valence, this.smValence)
    const a = sane(input.arousal, this.smArousal)
    const te = sane(input.tension, this.smTension)
    const pu = sane(input.pulse, this.smPulse)
    const vcIn = input.valenceConfidence
    const vc = vcIn !== undefined && Number.isFinite(vcIn) ? vcIn : 1

    instantDist(v, a, te, pu, vc, this.inst)

    // --- Temporal smoothing (first valid read jumps straight to the estimate) ---
    const sm = this.sm
    if (!this.hasSmooth) {
      for (let i = 0; i < N; i++) sm[i] = this.inst[i]
      this.smValence = v
      this.smArousal = a
      this.smTension = te
      this.smPulse = pu
      this.hasSmooth = true
    } else {
      const alpha = 1 - Math.exp(-dt / SMOOTH_TAU_SEC)
      let sum = 0
      for (let i = 0; i < N; i++) {
        sm[i] += (this.inst[i] - sm[i]) * alpha
        sum += sm[i]
      }
      if (sum > 0) {
        const inv = 1 / sum
        for (let i = 0; i < N; i++) sm[i] *= inv
      }
      this.smValence += (v - this.smValence) * alpha
      this.smArousal += (a - this.smArousal) * alpha
      this.smTension += (te - this.smTension) * alpha
      this.smPulse += (pu - this.smPulse) * alpha
    }
    s.valence = this.smValence
    s.arousal = this.smArousal
    s.tension = this.smTension
    s.pulse = this.smPulse
    s.valid = true

    // --- Leader, entropy ---
    let lead = 0
    let entropy = 0
    for (let i = 0; i < N; i++) {
      const p = sm[i]
      if (p > sm[lead]) lead = i
      if (p > 1e-12) entropy -= p * Math.log(p)
      s.dist[CHARACTER_MOODS[i]] = p
    }
    entropy = clamp01(entropy / LN_N)

    // --- Hysteresis on the committed primary ---
    const evDt = Math.min(dt, MAX_EVIDENCE_DT)
    if (this.primaryIdx < 0) {
      this.validTime += evDt
      if (this.validTime >= FIRST_COMMIT_SEC) this.commit(lead, t)
    } else {
      const pIdx = this.primaryIdx
      const pProb = sm[pIdx]
      let best = -1
      let bestEv = 0
      for (let i = 0; i < N; i++) {
        if (i === pIdx) continue
        if (sm[i] - pProb >= SWITCH_MARGIN) {
          this.evidence[i] += evDt
        } else {
          const e = this.evidence[i] - EVIDENCE_DECAY * evDt
          this.evidence[i] = e > 0 ? e : 0
        }
        if (this.evidence[i] >= SWITCH_HOLD_SEC && this.evidence[i] > bestEv) {
          best = i
          bestEv = this.evidence[i]
        }
      }
      if (best >= 0) this.commit(best, t)
    }

    // --- Secondary: best mood other than the committed primary ---
    const pIdx = this.primaryIdx
    if (pIdx < 0) {
      s.secondary = null
      s.secondaryWeight = 0
    } else {
      let second = -1
      for (let i = 0; i < N; i++) {
        if (i === pIdx) continue
        if (second < 0 || sm[i] > sm[second]) second = i
      }
      if (second >= 0 && sm[second] >= SECONDARY_MIN) {
        const denom = sm[pIdx] + sm[second]
        s.secondary = CHARACTER_MOODS[second]
        s.secondaryWeight = denom > 0 ? Math.min(0.5, Math.max(0, sm[second] / denom)) : 0.5
      } else {
        s.secondary = null
        s.secondaryWeight = 0
      }
    }

    // --- Confidence: top-two margin and (1 - entropy) ---
    let top2 = 0
    for (let i = 0; i < N; i++) if (i !== lead && sm[i] > top2) top2 = sm[i]
    const margin = clamp01((sm[lead] - top2) / CONFIDENCE_MARGIN_FULL)
    s.entropy = entropy
    s.confidence = clamp01(0.5 * margin + 0.5 * (1 - entropy))

    return s
  }

  private commit(idx: number, t: number): void {
    const s = this.state
    this.primaryIdx = idx
    s.primary = CHARACTER_MOODS[idx] as CharacterMood
    s.changed = true
    this.committedAt = t
    s.heldFor = 0
    this.evidence.fill(0)
  }
}
