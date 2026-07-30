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
    m.isPeaking = m.level > 0.72 && f.bass > 0.55 && now - this.lastDropAt < 6
    m.isDecaying = m.energyVel < -0.2
    m.isMelting = m.energyVel < -0.12 && m.brightVel > 0.1 && m.level < 0.55

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

    // --- Hysteresis: commit only after the candidate holds ---
    if (best !== this.candidate) {
      this.candidate = best
      this.candidateSince = now
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
    m.confidence = Math.min(
      1,
      margin * 2 + Math.min(0.5, (now - this.committedAt) * 0.05) + (best === m.state ? 0.25 : 0),
    )

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

  /** Per-state score, 0..~1.5. Deliberately hand-tuned and readable. */
  private score(
    f: AudioFeatures,
    m: MoodMomentum,
    density: number,
  ): Record<MoodState, number> {
    const e = m.level
    const stable = 1 - Math.min(1, Math.abs(m.energyVel) * 2)
    const fastTempo = f.bpm >= 138 ? Math.min(1, (f.bpm - 138) / 30) : 0

    return {
      silence: f.silence ? 1.5 : 0,
      ambient: band(e, 0, 0.32) * (1 - density) * 0.9 + (f.silence ? 0 : 0.05),
      mellow:
        band(e, 0.18, 0.55) *
        (0.4 + m.brightness * 0.5) *
        (1 - f.bass * 0.5) *
        (0.5 + stable * 0.5) *
        1.1,
      groove:
        band(e, 0.4, 0.78) *
        (0.35 + f.bass * 0.65) *
        (0.4 + f.confidence * 0.6) *
        (0.55 + stable * 0.45),
      building:
        (f.buildUp ? 0.55 : 0) +
        Math.max(0, m.energyVel) * 0.8 +
        Math.max(0, m.bassVel) * 0.4,
      peak:
        band(e, 0.68, 1.01) *
        (0.3 + f.bass * 0.7) *
        (f.time - this.lastDropAt < 8 ? 1.25 : 0.85),
      aggressive:
        band(e, 0.62, 1.01) *
        (0.3 + density * 0.7) *
        (0.5 + m.brightness * 0.3 + fastTempo * 0.4) *
        (0.6 + f.flux * 0.4),
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

  private velocity(key: 'energy' | 'bass' | 'centroid', now: number, windowSec: number, scale: number): number {
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

/** Smooth 0..1 membership of x inside [lo, hi] with soft edges. */
function band(x: number, lo: number, hi: number): number {
  const w = (hi - lo) * 0.25
  const up = smooth((x - lo) / w)
  const down = 1 - smooth((x - hi) / w)
  return Math.max(0, Math.min(1, Math.min(up, down)))
}

function smooth(t: number): number {
  const c = Math.max(0, Math.min(1, t))
  return c * c * (3 - 2 * c)
}
