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
 */

const SAMPLE_INTERVAL = 0.1
const HISTORY = 7 // seconds
const RECENT_WINDOW = 1.2
const WEIGHTS = [1.25, 1.0, 1.0, 0.8] // bass shifts matter most
const THRESHOLD = 0.45

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

    // Only consider boundaries on downbeats — sections change on the grid.
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
          // At most one boundary per 8 beats.
          this.cooldownUntil = now + (60 / f.bpm) * 8
        }
      }
    }

    const beatsSince = f.beatIndex - this.phraseStartBeat + f.beatProgress
    f.phrase = Math.floor(beatsSince / 16)
    f.phraseProgress = (beatsSince / 16) % 1
  }
}
