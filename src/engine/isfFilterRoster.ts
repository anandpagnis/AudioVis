/**
 * The ISF filter roster: compiles the five vendored ISF filters once at
 * module load and curates how they get chosen — which ids exist, which are
 * selectable, and which mood prefers which.
 *
 * This exists for the same reason `transitions.ts` separates the transition
 * VOCABULARY from the picking LOGIC: `IsfFilterPass.setFilter` is a bare
 * `IsfFilter | null` seam (see its header — "Nothing in the app selects one
 * yet"), and something has to own the editorial layer on top of it. This
 * module is that layer for filters, mirroring `transitions.ts` pattern for
 * pattern: `DISABLED_STYLES`/`isStyleSelectable`/`selectableStyles` becomes
 * `DISABLED_FILTERS`/`isFilterSelectable`/`selectableFilters`, and
 * `MOOD_STYLES` becomes `FILTER_MOOD_STYLES`.
 *
 * `ISF_FILTERS` is also the attribution source: `Credits.tsx` reads it to
 * list every vendored filter's `credit`, which is why it holds all 5 —
 * including `Color Invert`, which is compiled and creditable but currently
 * outside the selectable pool. Attribution covers what shipped in the
 * bundle, not just what a director can currently pick.
 */

import type { MoodState } from '../audio/types'
import { compileIsfFilter, type IsfFilter } from './IsfFilterPass'

import BAD_TV_FS from '../assets/isf/filters/Bad TV.fs?raw'
import BROKEN_LCD_FS from '../assets/isf/filters/Broken LCD.fs?raw'
import BUMP_DISTORTION_FS from '../assets/isf/filters/Bump Distortion.fs?raw'
import CMYK_HALFTONE_FS from '../assets/isf/filters/CMYK Halftone.fs?raw'
import COLOR_INVERT_FS from '../assets/isf/filters/Color Invert.fs?raw'
import DITHER_BAYER_FS from '../assets/isf/filters/Dither-Bayer.fs?raw'
import JPEG_BLOCK_CORRUPTION_FS from '../assets/isf/filters/JPEG Block Corruption.fs?raw'
import PIXEL_SHIFTER_FS from '../assets/isf/filters/Pixel Shifter.fs?raw'
import RIPPLES_FS from '../assets/isf/filters/Ripples.fs?raw'

/**
 * Every vendored filter, compiled once at module load and in a fixed order.
 *
 * Ids match the filename minus its extension, same convention
 * `isfFilterPass.test.ts` / `isfFilter.test.ts` already use for the first
 * five (`compileIsfFilter('Color Invert', COLOR_INVERT_FS)` etc.) so the same
 * filter is never known by two different names across the codebase.
 *
 * The last four were added in a second wave, after the roster/budget/
 * trigger/attribution pipeline below was proven end to end against the first
 * five — see `src/assets/isf/filters/NOTICE`'s "WHY THE NEXT FOUR" for the
 * screening criteria (distinct from the mounted post chain AND from each
 * other, confirmed against the real adapter, and — the one that actually
 * ruled a candidate out — a non-degenerate author DEFAULT, since this engine
 * has no per-filter parameter UI yet and renders whatever the header
 * defaults to; `Noise Displace.fs` was passed over for exactly this reason,
 * its `displaceX`/`displaceY` both defaulting to 0).
 */
export const ISF_FILTERS: IsfFilter[] = [
  compileIsfFilter('Bad TV', BAD_TV_FS),
  compileIsfFilter('Broken LCD', BROKEN_LCD_FS),
  compileIsfFilter('Bump Distortion', BUMP_DISTORTION_FS),
  compileIsfFilter('CMYK Halftone', CMYK_HALFTONE_FS),
  compileIsfFilter('Color Invert', COLOR_INVERT_FS),
  compileIsfFilter('Dither-Bayer', DITHER_BAYER_FS),
  compileIsfFilter('JPEG Block Corruption', JPEG_BLOCK_CORRUPTION_FS),
  compileIsfFilter('Pixel Shifter', PIXEL_SHIFTER_FS),
  compileIsfFilter('Ripples', RIPPLES_FS),
]

/**
 * Master switch for AUTONOMOUS filter firing. Off by explicit request
 * ("turn off isf filters for now").
 *
 * Deliberately one flag rather than moving all nine ids into
 * {@link DISABLED_FILTERS}: that list means "a taste call about this
 * particular filter", and stuffing the whole roster into it would destroy
 * the per-filter judgements already recorded there (`Color Invert`) and in
 * {@link UNUSABLE_FILTERS} (`Broken LCD`), which have to survive being
 * switched back on.
 *
 * Scope, precisely: `FilterDirector` folds this into its own `suppressed`
 * term, which only ever zeroes the TRIGGER list. So the director stops
 * choosing filters on its own, an already-running flourish is still allowed
 * to finish rather than being cut mid-fade, and MANUAL firing from the HUD
 * and Console chips keeps working — nothing appears unless someone asks for
 * it, and the roster stays inspectable meanwhile.
 *
 * Re-enable by flipping this to `true`; nothing else has to change.
 */
export const ISF_AUTOFIRE_ENABLED = false

/**
 * Filters that exist (and are credited) but may not currently be CHOSEN.
 *
 * `Color Invert` is disabled: of the five, it is the lowest-differentiation
 * effect — a global RGB invert reads as "something broke" more than "an
 * effect fired" if it fires often, unlike the other four which each have an
 * obvious textural or distortion character. It ships compiled and
 * creditable (see `ISF_FILTERS`) so attribution and the ability to
 * re-enable it are never lost — exactly how `transitions.ts`'s
 * `DISABLED_STYLES` keeps `cut`/`dipToBlack` in the vocabulary while
 * excluding them from the picker.
 */
export const DISABLED_FILTERS: readonly string[] = ['Color Invert']

/**
 * Filters that are in the bundle and credited but must not RUN, mapped to the
 * reason — a stronger state than {@link DISABLED_FILTERS}, and a different one.
 *
 * A disabled filter is a taste call: the director will not choose it, but a
 * person still can, and it looks like what its author intended when they do.
 * An entry here is broken on this platform, so hand-firing it is not a
 * legitimate override — it is just the bug, on demand. Both UIs render these
 * as genuinely un-clickable and show the reason, and `FilterDirector` refuses
 * them on the manual path as well as the autonomous one.
 *
 * `Broken LCD` — its `hash()` returns a SIGNED value (`-1.0 + 2.0*fract(...)`),
 * so the 4-octave `fbm` sums built from it are negative for roughly half the
 * frame. That value is then raised to a power:
 *
 *     f = 1.0 - pow(f, (5.0 - glitchBrightnessCurve)) * glitchBrightness;
 *
 * and **`pow()` is undefined for a negative base in GLSL** (ANGLE evaluates it
 * as `exp2(y * log2(x))`, so it yields NaN). The NaN then collapses in one
 * direction rather than flickering, which is why the failure is total instead
 * of patchy: `f = (f > 0.9) ? 1.0 : 0.0` is false for NaN, giving `f = 0.0`,
 * and `mix(returnMe, bgColor, 1.0 - f)` at `f = 0` replaces the pixel with the
 * pattern outright. `patternForType` then does the same thing again with
 * `pow(f, 0.5)`, and its default `patternStyle` resolves to line patterns whose
 * channels are `1.0` only inside narrow `mod()` bands — so the replacement is
 * mostly black. Net effect: the filter blacks out the show.
 *
 * This is NOT fixable from the uniform side, which is why it is a hard block
 * rather than a set of tamer defaults: `glitchBrightnessCurve` is clamped to
 * `[1, 4]`, so the exponent is `[1, 4]`, and `pow` is undefined for a negative
 * base at every one of them. Fixing it means either editing the shader — which
 * `NOTICE` forbids for good reason, a vendored file that has been "tidied up"
 * no longer proves the adapter reads the real format — or teaching the
 * transpiler to emit a domain-safe `pow`, which is a real compatibility
 * feature for the wider corpus and wants doing deliberately rather than as a
 * bugfix for one file. Logged as F185.
 */
export const UNUSABLE_FILTERS: Readonly<Record<string, string>> = {
  'Broken LCD':
    'blacks out the frame on WebGL — its noise sums go negative into pow(), which is undefined for a negative base (NaN), and the NaN collapses to "replace this pixel with the pattern". See F185.',
}

/** Why this filter cannot run, or undefined if it can. */
export function filterUnusableReason(id: string): string | undefined {
  return UNUSABLE_FILTERS[id]
}

/**
 * May a director or a human pick this filter?
 *
 * False for both states, because both mean "not in the rotation" — but they
 * are not interchangeable: {@link DISABLED_FILTERS} is a taste call a person
 * may still override by hand, {@link UNUSABLE_FILTERS} is a platform bug
 * nobody may. Callers that offer a manual fire must check
 * {@link filterUnusableReason} too; this predicate alone does not distinguish
 * them.
 */
export function isFilterSelectable(id: string): boolean {
  return !DISABLED_FILTERS.includes(id) && filterUnusableReason(id) === undefined
}

/** The filters a picker should offer. */
export function selectableFilters(): IsfFilter[] {
  return ISF_FILTERS.filter((f) => isFilterSelectable(f.id))
}

/**
 * Filters each mood prefers, best first — modeled directly on
 * `transitions.ts`'s `MOOD_STYLES`. Editorial, from reading each filter's
 * actual GLSL body (`src/assets/isf/filters/*.fs`) rather than guessed from
 * its name:
 *
 *  - `Bad TV` (VIDVOX) distorts the frame with scrolling simplex-noise
 *    warp, scanlines and static — broadcast interference. `Broken LCD`
 *    (VIDVOX) goes further: row glitches, flicker patterns and tinted
 *    noise blocks standing in for whole regions of the frame. Both read as
 *    "signal breaking up," which is the `aggressive`/`peak`/`building`
 *    register — a look that suits rising or maxed-out tension, not a
 *    resting one.
 *  - `Bump Distortion` (carter rosenberg) is a smooth radial lens
 *    bulge/pinch around a center point — no noise, no corruption, just
 *    displacement. That reads as movement/pulse rather than damage, so it
 *    sits with `groove` (rhythmic, not chaotic) as well as the escalating
 *    `building`/`peak` moods, but never with `ambient`/`mellow`/`silence`,
 *    where any warp at all would fight the calm.
 *  - `CMYK Halftone` (zoidberg) replaces the frame with rotated CMYK dot
 *    grids — a print/graphic texture, closer to "photograph" than
 *    "malfunction." That is the contemplative/graphic end of the roster,
 *    so it leads `ambient` and `mellow` and still fits `groove` before the
 *    energy escalates into distortion or glitch territory.
 *  - `Color Invert` (zoidberg) is disabled by default (see
 *    `DISABLED_FILTERS`) so its placement matters less, but it is listed
 *    anyway for when it is re-enabled: a stark full-frame invert reads best
 *    as a maximum-intensity flourish, so it sits only in `peak` and
 *    `aggressive`, last in both lists.
 *  - `silence` maps to an empty array. `EffectDirector` already refuses to
 *    fire effect scenes during silence (`f.silence` suppresses triggers —
 *    see its `governed`/`suppressed` gate), and a filter flourish is the
 *    same kind of "something is happening" cue that near-silence should
 *    not be making.
 *
 * Second wave (see `NOTICE`'s "WHY THE NEXT FOUR"), placed against the same
 * two families the first five already established:
 *
 *  - `Dither-Bayer` (Hugh Kennedy / David Lublin) joins `CMYK Halftone` in
 *    the graphic/contemplative family — an ordered dither grid is a print
 *    texture, not damage. `CMYK Halftone` alone keeps `ambient` (it stays
 *    the single calmest pick — see below), and `Dither-Bayer` enters
 *    alongside it from `mellow` up through `groove`.
 *  - `Ripples` (carter rosenberg — the same author as `Bump Distortion`,
 *    already vendored here) is smooth and centred like that filter, but its
 *    sinusoidal ease reads gentler — a lily-pond ripple, not a bulge/pinch —
 *    so unlike `Bump Distortion` it is calm enough for `mellow` too, then
 *    spans `groove`/`building` the same way.
 *  - `Pixel Shifter` (VIDVOX) is, at its shipped ISF `DEFAULT`s, a smooth
 *    periodic row-shear (`hRandom`/`vRandom` default to 0, so nothing about
 *    the default look is chaotic) — movement, not corruption, so it joins
 *    the `Bump Distortion`/`Ripples` family in `groove`/`building` rather
 *    than the noise-glitch family, despite its name suggesting otherwise.
 *  - `JPEG Block Corruption` (VIDVOX) reads as compression damage — a third,
 *    genuinely distinct flavour of "signal breaking up" from `Bad TV`'s
 *    noise and `Broken LCD`'s row-glitch — so it joins them in `peak`/
 *    `aggressive`. `Bump Distortion` steps out of `peak` to make room for it
 *    (it keeps `building`, its stronger home) rather than pushing `peak`
 *    past the four-entry cap or displacing `Color Invert`, whose whole
 *    reason for existing here is being the maximum-intensity capstone.
 *
 * `ambient` deliberately stays a single-entry list — `CMYK Halftone` alone —
 * rather than folding `Dither-Bayer` in alongside it: one of the two graphic
 * filters should read as the calmest, uncontested choice, and it also keeps
 * a real single-choice mood in the roster for `pickFilter`'s anti-repeat
 * fallback (excluding `lastId` would empty the pool, so it falls back to
 * repeating it) to exercise against real data rather than a synthetic case.
 *
 * Every list here contains only ids present in `ISF_FILTERS` — enforced by
 * a test, not just by convention. Capped at four entries per mood, matching
 * the first wave's own convention, so the rotation pool stays curated rather
 * than becoming "everything that could plausibly fit."
 */
export const FILTER_MOOD_STYLES: Record<MoodState, string[]> = {
  silence: [],
  ambient: ['CMYK Halftone'],
  mellow: ['CMYK Halftone', 'Dither-Bayer', 'Ripples'],
  groove: ['Bump Distortion', 'Ripples', 'Pixel Shifter', 'Dither-Bayer'],
  building: ['Pixel Shifter', 'Bump Distortion', 'Ripples', 'Broken LCD'],
  peak: ['Broken LCD', 'Bad TV', 'JPEG Block Corruption', 'Color Invert'],
  aggressive: ['Bad TV', 'Broken LCD', 'JPEG Block Corruption', 'Color Invert'],
}

/**
 * Shared cooldown (seconds) between filter flourishes, for a future trigger
 * director to rate-limit against — a single flat constant rather than a
 * per-filter map, since nothing yet distinguishes one filter's fatigue
 * curve from another's; split it out if that changes.
 *
 * Sized against `scenes/index.ts`'s existing effect-scene cooldowns, which
 * are the same kind of "how often can this flourish happen" decision:
 * `cooldownSec: 12` on the drop trigger (the single biggest flourish),
 * `6` on section-change/build-peak, `2.5` on plain transients. A filter is
 * a sustained full-frame treatment — closer in weight to the drop flourish
 * than to a quick transient hit — so its cooldown sits at the upper end of
 * that range rather than the lower: long enough that it still reads as an
 * event rather than becoming wallpaper.
 */
export const FILTER_COOLDOWN_SEC = 15
