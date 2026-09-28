import type { AudioFeatures } from './types'

/**
 * Musical phrase / section tracking.
 *
 * Samples a compact spectral profile (bass/mid/high/centroid) ~10× per
 * second. On every downbeat it compares the profile of the last ~1.2 s
 * against the preceding few seconds; a large sustained shift means the music
 * entered a new section (verse → chorus, breakdown, drop...). Section
 * boundaries re-anchor the phrase grid, so `phraseProgress` completes
 * exactly on musically meaningful boundaries instead of drifting.
 *
 * "Downbeat" here is `f.beatInBar === 0`: the real bar line once the engine's
 * downbeat estimator has locked (`f.downbeatLocked`), the legacy arbitrary
 * `beatIndex % 4` phase until then. The public output shape is unchanged.
 */

const SAMPLE_INTERVAL = 0.1
const HISTORY = 7 // seconds
const RECENT_WINDOW = 1.2
// Bass shifts matter most, but the high band is weighted up (was 0.8): on the first tapped songs the scene changes
// were hi-hats and upper layers entering, a small ABSOLUTE move of a quiet band that 0.8 hid.
const WEIGHTS = [1.25, 1.0, 1.0, 1.2]
// Was 0.45. Lowered so quieter section changes (a verse to a chorus at similar loudness) register; a real boundary
// still needs a sustained shift on a downbeat, and the one-per-6-beats cooldown below keeps a noisy passage from
// firing every bar.
const THRESHOLD = 0.3

interface Profile {
  t: number
  v: [number, number, number, number]
}

export class PhraseDetector {
  private profiles: Profile[] = []
  private lastSample = 0
  private phraseStartBeat = 0
  private cooldownUntil = 0

  reset() {
    this.profiles = []
    this.lastSample = 0
    this.phraseStartBeat = 0
    this.cooldownUntil = 0
  }

  update(now: number, f: AudioFeatures) {
    f.sectionChange = false

    if (now - this.lastSample >= SAMPLE_INTERVAL) {
      this.lastSample = now
      this.profiles.push({ t: now, v: [f.bass, f.mid, f.high, f.centroid] })
      while (this.profiles.length > 0 && now - this.profiles[0].t > HISTORY) {
        this.profiles.shift()
      }
    }

    // Only consider boundaries on downbeats — sections change on the grid. `f.beatInBar` is measured from
    // the estimated downbeat when `f.downbeatLocked` (structure/downbeat.ts), so this snaps to the real
    // bar line; when the estimator is not confident it is the legacy `beatIndex % 4` (arbitrary phase),
    // exactly as before. When the offset is adopted or moved (rare) `beatInBar` jumps once, which here
    // just means the next boundary candidate lands on a different beat - `phraseStartBeat` is a raw
    // `beatIndex`, so `phrase` / `phraseProgress` stay continuous across it.
    if (f.beat && f.beatInBar === 0 && now > this.cooldownUntil && !f.silence) {
      const recent = [0, 0, 0, 0]
      const before = [0, 0, 0, 0]
      let recentN = 0
      let beforeN = 0
      for (const p of this.profiles) {
        const age = now - p.t
        if (age < RECENT_WINDOW) {
          for (let i = 0; i < 4; i++) recent[i] += p.v[i]
          recentN++
        } else {
          for (let i = 0; i < 4; i++) before[i] += p.v[i]
          beforeN++
        }
      }
      if (recentN >= 6 && beforeN >= 20) {
        let novelty = 0
        for (let i = 0; i < 4; i++) {
          novelty += Math.abs(recent[i] / recentN - before[i] / beforeN) * WEIGHTS[i]
        }
        f.sectionChangeStrength = novelty
        if (novelty > THRESHOLD) {
          f.sectionChange = true
          this.phraseStartBeat = f.beatIndex
          // At most one boundary per 6 beats (was 8).
          this.cooldownUntil = now + (60 / f.bpm) * 6
        }
      }
    }

    const beatsSince = f.beatIndex - this.phraseStartBeat + f.beatProgress
    f.phrase = Math.floor(beatsSince / 16)
    f.phraseProgress = (beatsSince / 16) % 1
  }
}
