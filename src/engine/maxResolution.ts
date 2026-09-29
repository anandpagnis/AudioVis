/**
 * The user's "max render resolution" setting (F272 stage 6).
 *
 * A ceiling on the frame's internal resolution, on top of everything the
 * render-scale solve already does (scene budget, post chain, tier). Default
 * Native: no ceiling, the solve alone decides. Picking a lower one is how a
 * machine that is fill-bound on a dense panel — the M1 Air fullscreen at
 * 2880x1800 — trades sharpness for headroom before the tier ladder has to.
 * The canvas is untouched (F272 stage 5 pinned it), so screenshots and
 * recordings stay at the display's full size, upscaled.
 *
 * ## A pixel count, not a size
 *
 * Each option caps the frame's MEGAPIXELS, and the frame keeps the canvas's
 * own shape: "2560x1440" on a 2880x1800 canvas renders about 2429x1518, the
 * same pixel count at 16:10. The render scale is one linear factor on both
 * axes, so a literal 2560x1440 rect would need a second, non-uniform scale
 * nothing downstream has; and cost is per pixel, so the count is the part of
 * the label that means something on any display. A cap at or above the
 * display's own size changes nothing.
 *
 * No imports, so the store, the UI and the renderer can all read it.
 */

export type MaxResolution = 'native' | '3840x2160' | '2560x1600' | '2560x1440' | '1920x1080' | '1280x720'

export interface MaxResolutionOption {
  id: MaxResolution
  label: string
  /** The cap in megapixels; `Infinity` for Native. */
  mp: number
}

const option = (id: MaxResolution, w: number, h: number): MaxResolutionOption => ({
  id,
  label: `${w}×${h}`,
  mp: (w * h) / 1e6,
})

export const MAX_RESOLUTION_OPTIONS: readonly MaxResolutionOption[] = [
  { id: 'native', label: 'Native', mp: Infinity },
  option('3840x2160', 3840, 2160),
  option('2560x1600', 2560, 1600),
  option('2560x1440', 2560, 1440),
  option('1920x1080', 1920, 1080),
  option('1280x720', 1280, 720),
]

export const DEFAULT_MAX_RESOLUTION: MaxResolution = 'native'

export const MAX_RESOLUTION_HINT =
  'Caps the pixels each frame renders (the frame keeps your screen’s shape) and upscales to the ' +
  'screen. Lower is faster and softer. Native lets quality decide alone. Screenshots and ' +
  'recordings stay full size.'

/**
 * A stored or mirrored value as a real option. Anything else — a value from a
 * newer build, a hand-edited `localStorage`, a wrong type — reads as Native,
 * the one choice that cannot make the picture worse than the user asked for.
 */
export function sanitizeMaxResolution(v: unknown): MaxResolution {
  for (const o of MAX_RESOLUTION_OPTIONS) if (o.id === v) return o.id
  return DEFAULT_MAX_RESOLUTION
}

/** The cap in megapixels; `Infinity` for Native or an unknown value. */
export function maxResolutionMP(v: unknown): number {
  const id = sanitizeMaxResolution(v)
  for (const o of MAX_RESOLUTION_OPTIONS) if (o.id === id) return o.mp
  return Infinity
}
