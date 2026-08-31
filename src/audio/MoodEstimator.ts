import type { AudioFeatures, MoodMomentum, MoodState } from './types'

/** Rolling sample of the slow features the mood read is built from. */
interface Snapshot {
  t: number
  energy: number
  bass: number
  centroid: number
  onsets: number
}

const SAMPLE_EVERY = 0.1 // seconds between history samples
const HISTORY_SEC = 12

/**
 * Mood-scoring thresholds (see {@link MoodEstimator.score}). The energy bands
 * operate on the REMAPPED scale `e = m.level ** ENERGY_SHAPE_EXP`, which undoes
 * `RESPONSE_GAMMA`'s downward compression.
 *
 * First calibration pass (2026-08-30) against `corpus/distributions.json` — 8
 * MTG-Jamendo tracks, 62 k frames. Measured `e` percentiles: p10 0.34, p50
 * 0.50, p90 0.66. `bass` p50 0.21, p90 0.59. `crestFactor` p50 2.57 (the low
 * MTG-Jamendo bitrate compresses dynamics — the code's old "1..15" assumption
 * does not hold on this corpus). The energy bands are placed so `mellow` owns
 * the lower-mid, `groove` the broad middle, `peak`/`aggressive` the top ~15 %;
 * `bass` thresholds are lowered to where real bass actually sits.
 *
 * Still interim — a larger, higher-bitrate corpus run should re-check them, and
 * `crestFactor` normalization especially.
 */
const ENERGY_SHAPE_EXP = 0.6
const E_AMBIENT_HI = 0.36 // above this a passage is no longer "quiet"
const E_MELLOW_LO = 0.16
const E_MELLOW_HI = 0.52
// groove owns the broad middle; peak/aggressive are the genuine top tail
// (corpus `e` p90 ≈ 0.66), NOT just "above average energy".
const E_GROOVE_LO = 0.38
const E_GROOVE_HI = 0.8
const E_PEAK_LO = 0.68
const E_HARD_LO = 0.63 // aggressive
/** Bass at/above this is "carrying" the track (groove); the band ramps in from
 * 0.15 below it. Corpus `bass` p50 is only 0.21, so this sits low. */
const BASS_CARRIES = 0.28
/** Ramp over which rising bass rules a passage OUT of `mellow` and INTO the
 * bass-weighted half of `peak`. Corpus `bass` p90 ≈ 0.59, p95 ≈ 0.71. */
const BASS_HEAVY_LO = 0.45
const BASS_HEAVY_HI = 0.82
/** `groove`'s beat-lock factor never drops below this share, so a weak tempo
 * confidence (F121's octave-flip symptom) can't collapse the whole term or let
 * `peak` edge ahead on a bass-heavy mid-energy passage. */
const CONF_FLOOR = 0.65
/** crestFactor → 0..1 dynamics, calibrated to the corpus (p10 2.19, p90 3.01)
 * rather than the code's old 1..10 assumption. */
const CREST_LO = 1.9
const CREST_RANGE = 1.4

/**
 * How the visuals lean in each mood. Multipliers over the user's tune-panel
 * params, eased slowly so mood shifts feel like weather, not switches.
 */
const VIZ_TARGETS: Record<MoodState, { intensity: number; speed: number; reactivity: number }> = {
  silence: { intensity: 0.8, speed: 0.6, reactivity: 1.0 },
  ambient: { intensity: 0.78, speed: 0.6, reactivity: 0.9 },
  mellow: { intensity: 0.88, speed: 0.72, reactivity: 1.15 },
  groove: { intensity: 1.0, speed: 1.0, reactivity: 1.1 },
  building: { intensity: 1.12, speed: 1.15, reactivity: 1.25 },
  peak: { intensity: 1.32, speed: 1.25, reactivity: 1.4 },
  aggressive: { intensity: 1.28, speed: 1.4, reactivity: 1.25 },
}

/**
 * Live, predictive mood tracking. Reads trends — not just current values —
 * so it can see a build-up coming and flag the peak before it lands.
 *
 * Two layers of state:
 *  - `candidate`: the state scoring highest right now (noisy, per-frame)
 *  - committed `state`: only follows the candidate after it has dominated
 *    for a hold period (hysteresis), so scenes aren't whipsawed.
 */
export class MoodEstimator {
  private history: Snapshot[] = []
  private sampleAcc = 0
  private onsetsInWindow = 0
  private lastFluxSpike = 0

  private candidate: MoodState = 'silence'
  private candidateSince = 0
  private committedAt = 0
  private lastDropAt = -100

  reset() {
    this.history = []
    this.sampleAcc = 0
    this.onsetsInWindow = 0
    this.lastFluxSpike = 0
    this.candidate = 'silence'
    this.candidateSince = 0
    this.committedAt = 0
    this.lastDropAt = -100
  }

  /** Hold times (s) a candidate must persist before commit. Hype states cut in fast. */
  private holdFor(next: MoodState, viaDrop: boolean): number {
    if (viaDrop) return 0.05
    if (next === 'peak' || next === 'aggressive') return 0.7
    if (next === 'silence') return 1.2
    return 2.0
  }

  /**
   * Minimum time (s) the committed state must persist before a challenger's
   * hold clock is even allowed to start. Complements holdFor() — that gates
   * how long a candidate must lead before winning; this gates how soon after
   * a commit the race can begin at all, so a fresh state can't be unseated
   * the moment it lands.
   */
  private dwellFor(committed: MoodState): number {
    if (committed === 'silence') return 0.2
    if (committed === 'peak' || committed === 'aggressive') return 2.8
    return 1.8
  }

  update(f: AudioFeatures): void {
    const m = f.mood
    const now = f.time
    m.changed = false

    // --- Sample history at ~10 Hz ---
    this.sampleAcc += f.delta
    if (f.flux > 0.6 && now - this.lastFluxSpike > 0.12) {
      this.onsetsInWindow++
      this.lastFluxSpike = now
    }
    if (this.sampleAcc >= SAMPLE_EVERY) {
      this.sampleAcc = 0
      this.history.push({
        t: now,
        energy: f.energy,
        bass: f.bass,
        centroid: f.centroid,
        onsets: this.onsetsInWindow,
      })
      this.onsetsInWindow = 0
      while (this.history.length > 0 && now - this.history[0].t > HISTORY_SEC) {
        this.history.shift()
      }
    }

    // --- Slow-smoothed level + brightness ---
    const k = Math.min(1, f.delta * 0.7)
    m.level += (f.energy - m.level) * k
    m.brightness += (f.centroid - m.brightness) * k

    // --- Trend velocities over ~2.5 s, clamped to roughly -1..1 ---
    m.energyVel = this.velocity('energy', now, 2.5, 0.3)
    m.bassVel = this.velocity('bass', now, 2.5, 0.3)
    m.brightVel = this.velocity('centroid', now, 3.5, 0.2)

    // Onset density: hits per second over the last ~3 s (busy vs sparse).
    const density = this.onsetDensity(now, 3)

    // --- Flags ---
    if (f.drop) this.lastDropAt = now
    m.isBuilding = f.buildUp || (m.energyVel > 0.25 && m.bassVel > 0.15)
    // Thresholds re-derived against the post-fix normalized ranges - each set
    // so it fires on the same share of frames as before across the eight
    // reference tracks (level>0.72 fired 0.11%, bass>0.55 fired 19.84%). They
    // land close to the originals because `bass` and `level` were never the
    // badly-broken part; see bandNormalizer.ts.
    m.isPeaking = m.level > 0.742 && f.bass > 0.446 && now - this.lastDropAt < 6
    m.isDecaying = m.energyVel < -0.2
    // `level < 0.55` fired on 80.09% of frames; 0.465 preserves that share.
    m.isMelting = m.energyVel < -0.12 && m.brightVel > 0.1 && m.level < 0.465

    // --- Score every state, pick the winner ---
    const scores = this.score(f, m, density)
    let best: MoodState = 'ambient'
    let bestScore = -1
    let second = 0
    for (const s of Object.keys(scores) as MoodState[]) {
      const v = scores[s]
      if (v > bestScore) {
        second = bestScore
        bestScore = v
        best = s
      } else if (v > second) {
        second = v
      }
    }
    const margin = Math.max(0, bestScore - Math.max(0, second))
    m.scores = scores
    m.ambiguity = bestScore > 1e-6 ? Math.max(0, 1 - margin / bestScore) : 1

    // --- Hysteresis: commit only after the candidate holds ---
    if (best !== this.candidate) {
      this.candidate = best
      // Post-commit dwell lock: a new challenger's hold clock doesn't start
      // until the committed state has dwelt long enough. Silence and
      // drop-cued hype jumps bypass it — those must stay near-instant.
      const bypassDwell =
        best === 'silence' || (f.drop && (best === 'peak' || best === 'aggressive'))
      this.candidateSince = bypassDwell
        ? now
        : Math.max(now, this.committedAt + this.dwellFor(m.state))
    }
    const viaDrop = f.drop && (best === 'peak' || best === 'aggressive')
    if (
      this.candidate !== m.state &&
      now - this.candidateSince >= this.holdFor(this.candidate, viaDrop)
    ) {
      m.state = this.candidate
      m.changed = true
      m.changeCount++
      this.committedAt = now
    }
    // Confidence is built from the SAME normalized separation `ambiguity` uses,
    // not the raw `margin`. `score()` outputs sit in a compressed ~0.1..0.8
    // band, so on real material `margin` is a few hundredths and `margin*2`
    // could never carry `confidence` past ~0.4 no matter how decisive the read
    // (F121: peak 0.392, mean 0.259). `1 - m.ambiguity` is already the winner's
    // lead as a fraction of its own score, so a genuinely decisive read reaches
    // ~0.9 and a near-tie stays low — which is what the AutoPilot gate needs.
    const separation = 1 - m.ambiguity
    const dwellBonus = Math.min(0.5, (now - this.committedAt) * 0.05) / 0.5
    const winnerHeld = best === m.state ? 1 : 0
    m.confidence = Math.min(1, 0.65 * separation + 0.2 * dwellBonus + 0.15 * winnerHeld)

    // --- Prediction ---
    this.predict(f, m)

    // --- Visual multipliers ease toward the committed state's targets ---
    const target = VIZ_TARGETS[m.state]
    // Building leans harder the closer the predicted peak gets.
    let ti = target.intensity
    if (m.state === 'building' && m.beatsTillTransition >= 0) {
      ti += Math.max(0, 1 - m.beatsTillTransition / 16) * 0.15
    }
    const vk = Math.min(1, f.delta * 0.8)
    m.viz.intensity += (ti - m.viz.intensity) * vk
    m.viz.speed += (target.speed - m.viz.speed) * vk
    m.viz.reactivity += (target.reactivity - m.viz.reactivity) * vk
  }

  /**
   * Per-state score, 0..~1.5. Each mood is a short checklist of NAMED,
   * documented conditions over normalized features — a loud bass-heavy mix
   * that satisfies "groove" cannot also satisfy "mellow", and you can read off
   * why. Whichever mood scores highest wins (subject to the hysteresis above).
   *
   * ## Why the energy remap
   *
   * The conditions test `e`, which is `m.level` (slow-smoothed energy) raised
   * to {@link ENERGY_SHAPE_EXP}. `m.level` is measured AFTER `RESPONSE_GAMMA`
   * (see bandNormalizer.ts) compresses every band toward the bottom of its
   * range — `bandNormalizer` records `level < 0.55` on ~80 % of frames and
   * `level > 0.742` on 0.11 %. The energy bands below were drawn for a signal
   * that actually uses the 0..1 range, so on real music `mellow`'s window sat
   * exactly where the music lives while `groove`/`peak` barely opened (F121:
   * 139 of 155 s stuck on `mellow`). The remap restores the scale the windows
   * assume; it does NOT touch the deliberate time-smoothing in `update()`.
   *
   * The band edges and weights here are interim — the final values come from
   * `corpus/distributions.json` (`npm run calibrate`), which measures the
   * post-remap `m.level` percentiles over a real song corpus.
   */
  private score(f: AudioFeatures, m: MoodMomentum, density: number): Record<MoodState, number> {
    // --- Named observations, each 0..1 -------------------------------------
    const e = Math.pow(Math.max(0, m.level), ENERGY_SHAPE_EXP) // energy on a restored 0..1 scale
    const busy = density // onset density, 0 sparse .. 1 wall-to-wall
    const calm = 1 - density
    const steady = 1 - Math.min(1, Math.abs(m.energyVel) * 2) // 1 = level, 0 = lurching
    const rising = Math.max(0, m.energyVel)
    const bassRising = Math.max(0, m.bassVel)
    const fastTempo = f.bpm >= 138 ? Math.min(1, (f.bpm - 138) / 30) : 0
    const dynamics = clamp01((f.crestFactor - CREST_LO) / CREST_RANGE) // 1 = headroomy, 0 = brickwalled
    const pushed = 1 - dynamics
    // "Pushed loudness reads as peak/aggressive" — but only when energy is
    // already high. Without this gate the additive `pushed` terms fire on quiet
    // low-bitrate ambient (which reads as brickwalled), pulling it toward peak.
    const loud = band(e, E_HARD_LO - 0.15, 1.01)
    const tonal = 1 - clamp01(f.spectralFlatness) // 1 = pitched, 0 = noisy/distorted
    const noisy = clamp01(f.spectralFlatness)
    const bright = m.brightness
    const beatLock = f.confidence
    const bassCarries = band(f.bass, BASS_CARRIES - 0.15, 1.01) // bass is doing the work
    const bassHeavy = smoothStep(f.bass, BASS_HEAVY_LO, BASS_HEAVY_HI) // enough to rule OUT mellow
    const justDropped = f.time - this.lastDropAt < 8

    /**
     * MusiCNN's `party` head as a groove bonus. Separates club material from
     * ambient far better than the DFA `danceability` it stands in for. ADDITIVE
     * and zero whenever the classifier has no real read (gitignored weights,
     * first ~18 s, worker failure) — so an absent signal costs nothing rather
     * than silently suppressing groove. Capped low: it biases the race, it
     * doesn't decide it.
     */
    const partyBonus = f.moodsValid ? f.moods.party * 0.18 * band(e, 0.35, 1.01) : 0

    return {
      // The engine's own call — nothing to add.
      silence: f.silence ? 1.5 : 0,

      // Quiet AND sparse AND not silent. Breath/air and dynamic headroom lean
      // this way, but only while the passage is already sparse.
      //
      // `f.sparkle` (16 kHz+) is a natural fit here and in `aggressive`, but it
      // is deliberately NOT wired yet: the calibration corpus is 96 kbps and
      // has nothing above ~15.5 kHz, so a weight tuned against it is meaningless
      // and one set by reasoning measurably shifted the mood mix on the 8-track
      // set. It stays a computed, tested, contract-level cue until it can be
      // A/B'd on lossless material. See {@link AudioFeatures.sparkle}.
      ambient:
        band(e, 0, E_AMBIENT_HI) * calm * 0.9 +
        (f.silence ? 0 : 0.05) +
        f.air * 0.15 * calm +
        dynamics * 0.1 * calm,

      // Soft energy AND bright-ish AND NOT bass-heavy AND holding steady.
      // `(1 - 0.85·bassHeavy)` is a real suppressor — a bass-forward mix drops
      // to ~15 % here — where the old `(1 - bass·0.5)` only ever halved it.
      mellow:
        band(e, E_MELLOW_LO, E_MELLOW_HI) *
        (0.4 + bright * 0.5) *
        (1 - 0.85 * bassHeavy) *
        (0.5 + steady * 0.5) *
        1.1,

      // Mid-to-high energy AND bass carrying it AND a locked beat AND not
      // lurching. `beatLock`'s factor is floored at CONF_FLOOR so a weak tempo
      // read (F121's other half) can't collapse groove the way it used to.
      groove:
        band(e, E_GROOVE_LO, E_GROOVE_HI) *
          (0.35 + bassCarries * 0.65) *
          (CONF_FLOOR + (1 - CONF_FLOOR) * beatLock) *
          (0.55 + steady * 0.45) +
        tonal * 0.12 * beatLock +
        partyBonus,

      // Energy actively climbing — a slope, not a level.
      building: (f.buildUp ? 0.55 : 0) + rising * 0.8 + bassRising * 0.4,

      // Near the top of the energy range AND bass-heavy AND close behind a drop.
      peak:
        band(e, E_PEAK_LO, 1.01) * (0.3 + bassHeavy * 0.7) * (justDropped ? 1.25 : 0.85) +
        pushed * 0.08 * loud,

      // High energy AND busy AND (bright OR fast) AND fluxy — the harshness
      // cluster. Noisy texture, a top-heavy spectrum and pushed loudness each
      // add on top — but all energy-gated, so a quiet noisy pad isn't
      // "aggressive". (`f.sparkle` belongs here too but is not wired yet — see
      // the ambient term.)
      aggressive:
        band(e, E_HARD_LO, 1.01) *
          (0.3 + busy * 0.7) *
          (0.5 + bright * 0.3 + fastTempo * 0.4) *
          (0.6 + f.flux * 0.4) +
        noisy * 0.28 * band(e, E_HARD_LO - 0.15, 1.01) +
        f.spectralRolloff * 0.12 * loud +
        pushed * 0.1 * loud,
    }
  }

  /** Where the momentum points, and roughly how many beats away it is. */
  private predict(f: AudioFeatures, m: MoodMomentum): void {
    m.predictedState = m.state
    m.beatsTillTransition = -1
    const beatsPerSec = f.bpm / 60

    if (m.state === 'building' || (m.isBuilding && m.state !== 'peak')) {
      // Project current energy slope to the peak threshold (~0.8).
      m.predictedState = 'peak'
      if (m.energyVel > 0.04) {
        const secs = Math.max(0, (0.8 - m.level) / (m.energyVel * 0.35))
        m.beatsTillTransition = Math.min(32, secs * beatsPerSec)
      } else {
        m.beatsTillTransition = 16
      }
    } else if (m.state === 'peak' && m.isDecaying) {
      m.predictedState = m.brightVel > 0.05 ? 'mellow' : 'groove'
      m.beatsTillTransition = 8
    } else if (m.isMelting && m.state !== 'mellow' && m.state !== 'ambient') {
      m.predictedState = 'mellow'
      m.beatsTillTransition = 8
    }
  }

  private velocity(
    key: 'energy' | 'bass' | 'centroid',
    now: number,
    windowSec: number,
    scale: number,
  ): number {
    if (this.history.length < 3) return 0
    const latest = this.history[this.history.length - 1]
    let past: Snapshot | null = null
    for (const s of this.history) {
      if (now - s.t <= windowSec) {
        past = s
        break
      }
    }
    if (!past || latest.t - past.t < 0.4) return 0
    const v = (latest[key] - past[key]) / (latest.t - past.t)
    return Math.max(-1, Math.min(1, v / scale))
  }

  private onsetDensity(now: number, windowSec: number): number {
    let hits = 0
    for (let i = this.history.length - 1; i >= 0; i--) {
      const s = this.history[i]
      if (now - s.t > windowSec) break
      hits += s.onsets
    }
    // ~4 hits/sec reads as fully busy.
    return Math.min(1, hits / (windowSec * 4))
  }
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x))

/** Smooth 0..1 membership of x inside [lo, hi] with soft edges. */
function band(x: number, lo: number, hi: number): number {
  const w = (hi - lo) * 0.25
  const up = smooth((x - lo) / w)
  const down = 1 - smooth((x - hi) / w)
  return Math.max(0, Math.min(1, Math.min(up, down)))
}

/** Smooth 0→1 ramp: 0 at or below `lo`, 1 at or above `hi`. */
function smoothStep(x: number, lo: number, hi: number): number {
  return smooth((x - lo) / (hi - lo))
}

function smooth(t: number): number {
  const c = Math.max(0, Math.min(1, t))
  return c * c * (3 - 2 * c)
}
