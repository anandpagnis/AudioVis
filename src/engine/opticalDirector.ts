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

/**
 * Flux at which the busy-penalty bottoms out.
 *
 * Raised from 0.55 along with everything else here. The penalty now removes
 * about half of the base rather than all of it, so a busy mix still trails —
 * the original curve took `groove` down to 0.07 in practice, which is nothing.
 */
const TRAILS_FLUX_CEILING = 0.9

/**
 * Trails: for sustained material, and now for a great deal else.
 *
 * The instrument is history persistence, so it wants something that lasts to
 * persist — a dense percussive mix already fills the frame with new information
 * every beat, and layering ten frames of it produces mud. That reasoning still
 * shapes the curve: flux (onset density) still costs more than energy does, and
 * `ambient` still trails harder than `aggressive`.
 *
 * What changed is the amplitude. The first version measured a maximum of 0.275
 * across a 90-second set, most of it between 0.07 and 0.2, which is a feature
 * nobody would notice was there. Bases roughly doubled, the busy penalty capped
 * at half rather than all, and the energy penalty cut — this is an art-direction
 * call to make trails a visible part of the show rather than a garnish.
 */
export function trailsTarget(mood: MoodState, flux: number, energy: number): number {
  const busy = Math.min(1, Math.max(0, flux) / TRAILS_FLUX_CEILING)
  // Floors at 0.6 rather than 0: the busiest mix keeps most of its trails. The
  // penalty exists because history persistence over a dense percussive mix is
  // mud, and that is still true — but the curve has twice been too shy about it
  // and the correction each time has been the same direction.
  const sustained = 1 - busy * 0.4
  const base =
    mood === 'ambient' || mood === 'mellow'
      ? 1
      : mood === 'groove'
        ? 0.82
        : mood === 'building'
          ? 0.9
          : mood === 'peak'
            ? 0.68
            : mood === 'aggressive'
              ? 0.58
              : 0
  // Still scaled DOWN by energy rather than up — a peak wants a legible frame —
  // but only just, at 0.1. The ordering between moods is what carries the
  // meaning here; the absolute level is art direction and has been raised twice.
  return Math.min(1, Math.max(0, base * sustained * (1 - energy * 0.1)))
}

/** A coherent mirror look. Combining these produces mush, so one is chosen. */
/**
 * `wallpaper` (n x n tiling) and `shear` (alternating slice slabs) are RETIRED
 * as of F108 — kept in the type and in {@link MirrorPass}'s shader, removed
 * from every pool below and gated to zero in `PerformanceStateBridge` so a
 * persisted value cannot resurrect them. Re-enabling is putting them back in
 * the pools and lifting that gate; nothing else was deleted.
 */
export type MirrorMode = 'off' | 'kaleido' | 'wallpaper' | 'vortex' | 'shear'

/** Target for the whole mirror rack, as one section's decision. */
export interface MirrorTarget {
  mode: MirrorMode
  segments: number
  tiles: number
  twist: number
  slice: number
  spin: number
}

export const MIRROR_OFF: MirrorTarget = {
  mode: 'off',
  segments: 0,
  tiles: 0,
  twist: 0,
  slice: 0,
  spin: 0,
}

/**
 * The mirror rack's whole state for a section.
 *
 * ## Why this returns five fields and not one
 *
 * The first version drove `segments` and `spin` only, so `tiles`, `twist` and
 * `slice` were never written by anything but the debug panel — three of the
 * five controls were dead in the running show. That is why the rack "wasn't
 * being shown much": most of it was not being shown at all.
 *
 * ## Why a MODE rather than five independent dials
 *
 * They are not five knobs on one effect, they are four different effects that
 * happen to share a pass. An n-fold kaleidoscope, an n x n wallpaper repeat, a
 * radial vortex and alternating shear slabs each read clearly on their own and
 * turn to mush stacked. So a section picks one and commits to it, and the
 * magnitudes inside it ease.
 *
 * Eligibility is much wider than it was — `groove` and `building` now qualify
 * at moderate tension, where before it was peak-or-aggressive only and fired on
 * one eligible section in three. Across a whole set that meant it essentially
 * never appeared.
 */
export function mirrorForSection(mood: MoodState, tension: number, seed: number): MirrorTarget {
  const t = Math.min(1, Math.max(0, tension))
  const hot = mood === 'peak' || mood === 'aggressive'
  const warm = mood === 'groove' || mood === 'building'
  // Silence and ambient stay clean, and that is the ONE restraint kept: a
  // kaleidoscope over a held pad is an effect that got stuck on, which is the
  // single failure this rack cannot recover from. Everything else qualifies
  // readily now — `mellow` at any real tension, `groove` and `building` almost
  // always, `peak` and `aggressive` unconditionally.
  const mellowOk = mood === 'mellow' && t > 0.3
  if (!hot && !(warm && t > 0.08) && !mellowOk && !(t > 0.4)) return MIRROR_OFF
  // Three sections in four. Still not every one: an effect present in every
  // section is not an effect, it is the look.
  if (seed % 4 === 3) return MIRROR_OFF

  // Three entries, not four, and the count is load-bearing: `seed % 4 === 3`
  // has already returned above, so `seed % 4` here only ever yields 0, 1 or 2.
  // A fourth entry is unreachable — which is why retiring `shear` costs the hot
  // pool nothing at all (it sat at index 2, and the index-3 `kaleido` behind it
  // had never once been selected) and why the pools are now written at their
  // real length instead of carrying a slot that cannot be reached.
  //
  // With `wallpaper` and `shear` retired the rack is kaleidoscope and vortex.
  // They still read differently by mood — vortex-leaning when the section is
  // hot, kaleido-leaning when it is merely warm — so a set does not collapse
  // into one gesture just because the menu got shorter.
  const modes: MirrorMode[] = hot
    ? ['vortex', 'kaleido', 'vortex']
    : ['kaleido', 'vortex', 'kaleido']
  const mode = modes[seed % modes.length]

  switch (mode) {
    case 'kaleido':
      return {
        mode,
        // Still 4, 6 and 8, and also not raised with the rest — same reason as
        // the tile count. Odd numbers read as a broken mirror rather than a
        // pattern, and above 8 the wedges are too thin to show what is inside
        // them. Turning these up makes the effect louder and worse.
        segments: [4, 6, 8][(seed / 3) % 3 | 0],
        tiles: 0,
        twist: 0,
        slice: 0,
        // Faster than before but still bounded — the pattern is the point, and
        // past about 0.7 the fold stops reading as a mandala and starts reading
        // as a strobe, which is a different effect and not a better one.
        spin: 0.28 + t * 0.34,
        }
    // RETIRED (F108) — unreachable from the pools above, kept so re-enabling is
    // one edit. The tile count stays at 2 and 3 only: at 4 the cells are small
    // enough that the source scene stops being readable inside them, and a
    // wallpaper of unreadable cells is texture, not a mirror.
    case 'wallpaper':
      return { mode, segments: 0, tiles: 2 + (seed % 2), twist: 0, slice: 0, spin: 0 }
    case 'vortex':
      // Signed, so alternate sections wind the opposite way. Radians at the
      // centre, falling off exponentially — 1.1 is a strong but readable swirl.
      return {
        mode,
        segments: 0,
        tiles: 0,
        // Sign from a DIFFERENT bit than the mode selector uses. `seed % 2` was
        // the obvious choice and was always +1: vortex is picked when
        // `seed % 4 === 1`, and every such seed is odd, so the swirl only ever
        // wound one way. Two selectors sharing a bit is a correlation that
        // looks like randomness right up until it does not.
        twist: ((seed >> 2) & 1 ? 1 : -1) * (1 + t * 0.9),
        slice: 0,
        spin: 0,
      }
    // RETIRED (F108) — see `wallpaper`.
    case 'shear':
      return { mode, segments: 0, tiles: 0, twist: 0, slice: 0.55 + t * 0.45, spin: 0 }
    default:
      return MIRROR_OFF
  }
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
    groove: [2, 6], // anamorphic streaks, hex fly-eye
    building: [2, 3], // + melt, which plumes on kicks
    peak: [3, 4], // melt, glitch tears
    aggressive: [4, 3], // glitch, melt
  }
  // `pixels` (index 5) is deliberately absent from every pool.
  //
  // Its amount does not mean intensity, it means cell COARSENESS, inverted:
  // `mix(140.0, 30.0, uAmt)` gives 140 fine cells at low amount and 30 coarse
  // ones at high. So the floor this director applies to an engaged lens — right
  // for every material where amount is a magnitude — puts the LED wall at about
  // 118 cells, which does not read as a deliberate wall. It reads as a broken
  // renderer, and was reported as exactly that.
  //
  // The material is effectively binary and needs a floor of its own (~0.55,
  // where cells are coarse enough to be obviously a choice and the gutter is at
  // full strength) before it can be selected automatically. Still fully
  // available from the Post FX panel.
  //
  // `fly eye` has the same inverted mapping but not the same failure: at low
  // amount it is a 22-bead lattice, which is coarse enough to read as a lens.
  const options = pool[mood] ?? []
  if (options.length === 0) return -1
  // One section in three. Was two in three — "off for most sections" above
  // described the intent, but this ratio did the opposite of that, so the
  // lens read as a fixture rather than a choice. A material is a lighter
  // touch than the kaleidoscope, so it doesn't need to be off as often as the
  // mirror's one-in-four, but it still needs "normal" to be the common case.
  if (seed % 3 !== 0) return -1
  return options[seed % options.length] % LENS_STYLES.length
}

/**
 * How hard an engaged lens is applied.
 *
 * Continuous, unlike the engagement itself — this is a magnitude and easing it
 * is exactly right. It starts from a FLOOR rather than from zero, because a
 * section that has decided to use a material should show it; tension then
 * swells it through a build, which is the shape the racks were built for.
 *
 * ## Turned down (F109)
 *
 * Was 0.2 -> 0.4 soft and 0.3 -> 0.62 hard. Those came from a correction in the
 * other direction — the amount had been driving straight off tension and peaked
 * at 0.045 across a 90-second run, i.e. invisible — and the correction
 * overshot. A lens is a MATERIAL the frame is seen through, not an event in it,
 * and past roughly a third the material stops modifying the image and starts
 * replacing it: the anamorphic streaks smear the subject away, the melt plumes
 * detach from what spawned them, and the glitch tears read as a dropped frame
 * rather than as a choice.
 *
 * Cut ~40% at the CEILING and only ~25% at the floor, which is deliberately
 * asymmetric. The floor cannot follow the ceiling down: an engaged lens below
 * about 0.15 stops reading at all, and a material that is applied, paid for and
 * invisible is the exact defect the previous correction was written to fix. So
 * the loud end comes down and the quiet end stays legible — which is also what
 * "less sensitive" means for a magnitude that swells with tension, since the
 * thing being complained about lives at the top of the swell.
 *
 * The shape is intact — still a floor rather than zero, still quadratic in
 * tension, and the hard/soft split still separates a peak from a groove.
 * Engagement frequency is untouched at one section in three; if the lens should
 * appear less OFTEN rather than less strongly, the dial for that is the
 * `seed % 3` in {@link lensForSection}.
 */
export function lensAmountTarget(mood: MoodState, tension: number, engaged: boolean): number {
  if (!engaged || mood === 'silence') return 0
  const hard = mood === 'peak' || mood === 'aggressive'
  const floor = hard ? 0.2 : 0.15
  const ceiling = hard ? 0.38 : 0.24
  const t = Math.min(1, Math.max(0, tension))
  return floor + (ceiling - floor) * t * t
}
