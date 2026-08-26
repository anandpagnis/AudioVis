import type { MoodState } from '../audio/types'
import { LENS_STYLES } from './opticalRack'

/**
 * When a show should reach for trails, a kaleidoscope, or a lens material.
 *
 * ## Why these were undriven for so long
 *
 * The feedback pass, the mirror rack and the lens rack all shipped as
 * executors: fully wired, budgeted, tested, and moved by nothing except a debug
 * panel (F52, F56). That was the right order — an effect whose *when* is
 * decided before its *what* works is an effect nobody can evaluate — but it
 * left the engine able to do a great deal that no viewer ever saw.
 *
 * ## The rule that shapes all three
 *
 * **These are strong effects, and a director that leaves them on is worse than
 * no director at all.** A kaleidoscope holds attention for about eight bars and
 * then becomes wallpaper; trails on a busy percussive mix are mud. So every
 * decision here is (a) mostly off, (b) chosen at a musical boundary rather than
 * continuously, and (c) held for a musical duration once chosen.
 *
 * That last point is why this module returns *targets* rather than writing
 * state: the caller eases toward them, so a decision taken on a section
 * boundary arrives over a beat rather than as a step.
 *
 * Pure and total. Every function returns a usable number for any input,
 * including the silence at the start of a set where nothing is known yet.
 */

/** Above this, the mix is too busy for trails to read as anything but smear. */
const TRAILS_FLUX_CEILING = 0.55

/**
 * Trails: for sustained, sparse material.
 *
 * The instrument is history persistence, so it needs something that *lasts* to
 * persist. A dense percussive mix already fills the frame with new information
 * every beat, and layering ten frames of it produces mud — which is why this is
 * gated on flux (onset density) rather than on energy. Quiet and busy is still
 * busy.
 */
export function trailsTarget(mood: MoodState, flux: number, energy: number): number {
  const busy = Math.min(1, Math.max(0, flux) / TRAILS_FLUX_CEILING)
  const sustained = 1 - busy
  const base =
    mood === 'ambient' || mood === 'mellow'
      ? 0.55
      : mood === 'groove'
        ? 0.22
        : mood === 'building'
          ? 0.3
          : 0
  // Energy scales it down at the top end rather than up: `peak` and
  // `aggressive` want a clean, legible frame, not a blurred one.
  return Math.min(1, Math.max(0, base * sustained * (1 - energy * 0.35)))
}

/**
 * Kaleidoscope segment count for a section, or 0 for no mirror at all.
 *
 * Returns a WHOLE number and expects to be called once per section, because the
 * count is a choice rather than a magnitude: `segments` is 0 off / 1 mirror-x /
 * 2 quad / >=3 n-fold, and easing between 4 and 6 does not pass through
 * anything that looks like either.
 *
 * Off most of the time by construction. `seed` is the caller's section counter,
 * so the pattern is deterministic across a set and reproducible in a recording,
 * rather than a fresh `Math.random()` nobody can reproduce.
 */
export function mirrorForSection(mood: MoodState, tension: number, seed: number): number {
  // Peaks earn it; nothing else does. A kaleidoscope during a verse reads as an
  // effect that got stuck on.
  const eligible = mood === 'peak' || mood === 'aggressive' || tension > 0.72
  if (!eligible) return 0
  // Roughly one section in three among eligible ones, so it stays an event.
  if (seed % 3 !== 0) return 0
  // 4, 6 and 8 only. Odd counts read as a broken mirror rather than a pattern,
  // and above 8 the segments are too thin to show what is inside them.
  return [4, 6, 8][(seed / 3) % 3 | 0]
}

/**
 * Whether the lens engages at all for a section, and with which material.
 *
 * Returns -1 for "no lens this section", otherwise an index into
 * {@link LENS_STYLES}. Engagement is a per-section CHOICE rather than a
 * continuous magnitude, and that was a correction: driving the amount straight
 * from tension gave a measured peak of 0.045 across a 90-second run, which is a
 * lens nobody can see attached to a cost everybody pays. An effect that is
 * always slightly on is the worst of both — it is not visible, and it is not
 * free.
 *
 * So it is off for most sections and properly present for the ones it takes.
 * The material is held for the whole section: it is the *look* of the frame,
 * and changing it mid-phrase reads as a glitch rather than as a choice.
 */
export function lensForSection(mood: MoodState, seed: number): number {
  // Moods pick a family, not a single material, so a set does not become
  // predictable — but a given mood always draws from materials that suit it.
  const pool: Record<MoodState, readonly number[]> = {
    silence: [],
    ambient: [0, 1], // reeded glass, radial flutes — soft, refractive
    mellow: [0, 1, 6], // + hex fly-eye
    groove: [2, 5], // anamorphic streaks, LED pixel wall
    building: [2, 3], // + melt, which plumes on kicks
    peak: [3, 4], // melt, glitch tears
    aggressive: [4, 5], // glitch, pixels
  }
  const options = pool[mood] ?? []
  if (options.length === 0) return -1
  // Two sections in three. More often than the kaleidoscope, which is a whole
  // reframing of the picture; a lens material is a surface treatment and can
  // carry a longer stretch without becoming wallpaper.
  if (seed % 3 === 2) return -1
  return options[seed % options.length] % LENS_STYLES.length
}

/**
 * How hard an engaged lens is applied.
 *
 * Continuous, unlike the engagement itself — this is a magnitude and easing it
 * is exactly right. It starts from a FLOOR rather than from zero, because a
 * section that has decided to use a material should show it; tension then
 * swells it through a build, which is the shape the racks were built for.
 */
export function lensAmountTarget(mood: MoodState, tension: number, engaged: boolean): number {
  if (!engaged || mood === 'silence') return 0
  const hard = mood === 'peak' || mood === 'aggressive'
  const floor = hard ? 0.3 : 0.2
  const ceiling = hard ? 0.62 : 0.4
  const t = Math.min(1, Math.max(0, tension))
  return floor + (ceiling - floor) * t * t
}
