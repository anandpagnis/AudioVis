/**
 * The show director's two runtime singletons (plain objects, no imports, so the pure director and the overlay can both
 * see them without pulling in React, the store or three).
 *
 *  - {@link showRuntime}: a ONE-FRAME mailbox from the adapter to the frame hooks that still own the machinery a MICRO
 *    or a CUT drives. The adapter (`showAdapter.tsx`, priority -92) clears it at the start of every frame and sets the
 *    flags for this frame's action; `AutoPilot` (-90, palette and mode: it owns their refs and cadence floors) and
 *    `PerformanceDirector` (-85, layers) read it later in the SAME frame. A flag nobody consumed simply dies next
 *    frame, so a request can never fire late.
 *  - {@link showProbe}: what `?lookdebug` prints, like `armedProbe`. Numbers and short constant strings, written by the
 *    adapter each frame without allocating.
 */

/** Layer recompose request: none, a MICRO (accent / overlay only), or a CUT (also the background, like a section). */
export const LAYERS_NONE = 0
export const LAYERS_MICRO = 1
export const LAYERS_CUT = 2

export const showRuntime = {
  /** Recolour: a MICRO(palette) or a CUT. AutoPilot applies its own `PALETTE_MIN_SEC` floor and pick. */
  palette: false,
  /** Vary the current scene's mode: a MICRO(mode). AutoPilot applies its own `MODE_VARY_MIN_SEC` floor. */
  mode: false,
  /** `LAYERS_*`: PerformanceDirector recomposes the layers against the landing primary. */
  layers: LAYERS_NONE as number,
}

export function clearShowRuntime(): void {
  showRuntime.palette = false
  showRuntime.mode = false
  showRuntime.layers = LAYERS_NONE
}

/** The overlay's view of the director. `on` false = `?director=legacy` (the line then says so). */
export const showProbe = {
  on: false,
  /** Last decided action (`HOLD` / `MICRO` / `CUT`) and its reason, with the numbers behind it. */
  kind: '-',
  reason: '-',
  /** What a MICRO varied, or '' . */
  micro: '',
  S: 0,
  T: 0,
  /** Scene age in bars, pressure 0..1, and bars until the forced-change ceiling. */
  age: 0,
  pressure: 0,
  etaBars: 0,
  hold: 0,
  microCount: 0,
  cut: 0,
  forced: 0,
  /** The last CUT: how it was performed (`armed`, `pick`, `refused`) - for "why did it (not) change". */
  cutHow: '-',
}
