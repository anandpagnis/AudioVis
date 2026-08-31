import { describe, expect, it } from 'vitest'
import {
  MAX_PIXEL_BUDGET,
  MIN_PIXEL_BUDGET,
  NATIVE_PIXEL_BUDGET,
  RENDER_SCALE_FLOOR,
  bufferScale,
  combinePixelBudgets,
  decideTierResize,
  solveRenderScale,
} from '../renderScale'

/**
 * The internal-resolution governor.
 *
 * These pin the two properties the whole mechanism rests on — that the solve is
 * display-independent in the right way, and that budgets COMBINE rather than
 * compete — because both are the kind of thing that keeps working on the
 * developer's monitor while failing on the venue's projector.
 */

/** Full-resolution megapixels for a display, at a given base DPR. */
const mp = (w: number, h: number, dpr = 1) => (w * dpr * h * dpr) / 1e6

const DISPLAYS = {
  /** 1080p monitor, 1x. 2.07 MP. */
  monitor: mp(1920, 1080),
  /** Retina 16" fullscreen, 2x on a 1728x1117 CSS viewport. 7.72 MP. */
  retina: mp(1728, 1117, 2),
  /** 5K panel, 2x. 29.5 MP — deliberately past what any budget can hold. */
  fiveK: mp(2560, 1440, 2),
}

describe('solveRenderScale', () => {
  it('delivers the declared budget rather than a declared resolution', () => {
    // The entire point: the same scene asks for the same MEGAPIXELS on every
    // display, and the scale is whatever that costs there.
    for (const full of Object.values(DISPLAYS)) {
      const scale = solveRenderScale(1.3, full)
      if (scale === 1 || scale === RENDER_SCALE_FLOOR) continue // clamped, see below
      expect(full * scale * scale).toBeCloseTo(1.3, 1)
    }
  })

  it('scales DOWN harder on a denser display, off the same budget', () => {
    const monitor = solveRenderScale(1.3, DISPLAYS.monitor)
    const retina = solveRenderScale(1.3, DISPLAYS.retina)
    const fiveK = solveRenderScale(1.3, DISPLAYS.fiveK)
    expect(monitor).toBeGreaterThan(retina)
    expect(retina).toBeGreaterThan(fiveK)
    // This is the failure a single fixed multiplier could not express. The two
    // displays differ by 3.7x in pixel count off the same GPU, and the solve
    // absorbs almost all of it: the scale differs by ~1.9x, which is ~3.7x in
    // fragments. A number tuned for one of them is wrong for the other by that
    // whole factor.
    expect(monitor / retina).toBeCloseTo(Math.sqrt(DISPLAYS.retina / DISPLAYS.monitor), 1)
    // The 5K panel is past what a 1.3 MP budget can hold even at the floor, so
    // it sits there — resolution has stopped being the lever and the tier
    // ladder's complexity knobs are carrying it from that point on.
    expect(fiveK).toBe(RENDER_SCALE_FLOOR)
  })

  it('never supersamples past native', () => {
    // A cheap scene on a small display would otherwise solve to >1 and render
    // MORE pixels than the canvas has, which is pure waste.
    expect(solveRenderScale(NATIVE_PIXEL_BUDGET, DISPLAYS.monitor)).toBe(1)
    expect(solveRenderScale(4, mp(800, 600))).toBe(1)
  })

  it('floors instead of mushing the picture on an enormous display', () => {
    // 0.9 MP over a 29.5 MP panel solves to 0.17 linear. The honest response
    // past the floor is to give up complexity, not more resolution.
    expect(solveRenderScale(0.9, DISPLAYS.fiveK)).toBe(RENDER_SCALE_FLOOR)
  })

  it('is deterministic — the same inputs always give the same scale', () => {
    // No feedback from frame time, so there is nothing to hunt. This is what
    // stops the sharpness pulsing while the picture holds still.
    const a = solveRenderScale(2.2, DISPLAYS.retina, 0.49)
    for (let i = 0; i < 50; i++) {
      expect(solveRenderScale(2.2, DISPLAYS.retina, 0.49)).toBe(a)
    }
  })

  it('ignores a display change too small to be worth a resize', () => {
    // A resize reallocates the post chain's mip pyramid. One CSS pixel of
    // difference must not buy that.
    const before = solveRenderScale(2, mp(1920, 1080))
    const after = solveRenderScale(2, mp(1921, 1080))
    expect(after).toBe(before)
  })

  it('takes the tier as a multiplier on the BUDGET, not on the scale', () => {
    // Cost is linear in pixel COUNT, and the old ladder's numbers were linear in
    // pixel WIDTH — which is the unit change this whole mechanism rests on. A
    // tier funding 72% of the budget must therefore produce 72% of the pixels,
    // not 72% of the linear scale (which would be 52% of the pixels).
    const full = solveRenderScale(4, DISPLAYS.retina, 1)
    const tier1 = solveRenderScale(4, DISPLAYS.retina, 0.72)
    expect((tier1 * tier1) / (full * full)).toBeCloseTo(0.72, 2)
  })

  it('degrades to native rather than to zero on a garbage input', () => {
    // A stale scene id, a display measured before layout, a NaN from anywhere:
    // every one of these must produce a rendering canvas, not a blank one.
    expect(solveRenderScale(NaN, DISPLAYS.monitor)).toBe(1)
    expect(solveRenderScale(2, 0)).toBe(1)
    expect(solveRenderScale(2, NaN)).toBe(1)
    expect(solveRenderScale(2, DISPLAYS.monitor, NaN)).toBe(
      solveRenderScale(2, DISPLAYS.monitor, 1),
    )
  })
})

describe('combinePixelBudgets', () => {
  it('gives a lone scene exactly its own budget', () => {
    expect(combinePixelBudgets([1.3])).toBeCloseTo(1.3, 6)
  })

  it('splits the frame between two scenes rather than picking one', () => {
    // Two scenes that each want 2 MP cannot both have 2 MP — they render into
    // the same framebuffer at the same resolution and each pays for every pixel
    // of it. `Math.min` would hand them 2 apiece and overcommit the frame by 2x.
    expect(combinePixelBudgets([2, 2])).toBeCloseTo(1, 6)
    expect(combinePixelBudgets([4, 4, 4, 4])).toBeCloseTo(1, 6)
  })

  it('is always at or below the smallest declared budget', () => {
    const combined = combinePixelBudgets([1.5, NATIVE_PIXEL_BUDGET])
    expect(combined).toBeLessThan(1.5)
    // ...but a cheap layer only costs a little: 1.5 with a native-budget scene
    // over it is 1.37, not 0.75.
    expect(combined).toBeGreaterThan(1.3)
  })

  it('is order-independent', () => {
    // Layers arrive in whatever order SceneManager walks its entries, and the
    // resolution must not depend on that.
    expect(combinePixelBudgets([1.5, 4, 16])).toBeCloseTo(combinePixelBudgets([16, 1.5, 4]), 9)
  })

  it('skips nonsense entries instead of poisoning the whole frame', () => {
    // One malformed third-party scene must not be able to take the resolution
    // of every other scene on screen down with it.
    expect(combinePixelBudgets([2, NaN, 0, -1, Infinity])).toBeCloseTo(2, 6)
  })

  it('returns the native budget for an empty frame', () => {
    expect(combinePixelBudgets([])).toBe(NATIVE_PIXEL_BUDGET)
  })

  it('admitting a layer costs resolution, and dropping it gives it back', () => {
    // The composition case the engine actually feeds this: a subject alone, then
    // the same subject with an accent over it, then alone again. Reversible,
    // because the combine is a pure function of the current set rather than an
    // accumulator that drifts as layers come and go across a long show.
    const solo = combinePixelBudgets([1.5])
    const layered = combinePixelBudgets([1.5, 4])
    expect(layered).toBeLessThan(solo)
    expect(combinePixelBudgets([1.5])).toBe(solo)
  })
})

describe('bufferScale', () => {
  it('quantises to quarters so feedback buffers are not wiped on every wobble', () => {
    expect(bufferScale(0.97)).toBe(1)
    expect(bufferScale(0.79)).toBe(0.75)
    expect(bufferScale(0.72)).toBe(0.75)
    expect(bufferScale(0.61)).toBe(0.5)
  })

  it('never goes below the solver floor or above native', () => {
    expect(bufferScale(0.1)).toBe(RENDER_SCALE_FLOOR)
    expect(bufferScale(2)).toBe(1)
  })
})

describe('budget bounds', () => {
  it('bracket the native declaration, so a scene can always opt into full res', () => {
    expect(NATIVE_PIXEL_BUDGET).toBeGreaterThanOrEqual(MIN_PIXEL_BUDGET)
    expect(NATIVE_PIXEL_BUDGET).toBeLessThanOrEqual(MAX_PIXEL_BUDGET)
  })

  it('cover a 5K panel at native, so NATIVE really means native', () => {
    // 5120x2880 is 14.7 MP. If the native budget did not cover it, the scenes
    // that declare "not fill-bound" would still be downscaled on the largest
    // display anyone runs a show on.
    expect(NATIVE_PIXEL_BUDGET).toBeGreaterThanOrEqual(mp(5120, 2880))
  })
})

/**
 * The directional hold (F157).
 *
 * Before this, a demote waited out `RENDER_SCALE_HOLD_SEC` exactly like a
 * promote, so the frame kept paying the failed tier's resolution for up to
 * seven seconds after the governor had already given up on it. Across three
 * sessions, 22 of 26 and then 35 of 41 of the frames over 33 ms sat in that
 * gap. The asymmetry these tests pin is the same one `MAX_RENDER_SCALE_STEP_UP`
 * already states for its own case: shedding load must land immediately.
 */
describe('decideTierResize', () => {
  const base = {
    applied: 0.75,
    solved: 0.75,
    p95Ms: 17,
    refreshMs: 16.67,
    txActive: false,
    heldForThisTier: false,
    heldForSec: 0,
    emergencyRatio: 3,
    holdSec: 3,
  }

  it('applies a SHED immediately — no hold at all', () => {
    expect(decideTierResize({ ...base, solved: 0.63 })).toBe('apply')
  })

  it('still holds a CLIMB', () => {
    expect(decideTierResize({ ...base, solved: 0.91 })).toBe('restart-hold')
    expect(
      decideTierResize({ ...base, solved: 0.91, heldForThisTier: true, heldForSec: 1 }),
    ).toBe('wait')
    expect(
      decideTierResize({ ...base, solved: 0.91, heldForThisTier: true, heldForSec: 3 }),
    ).toBe('apply')
  })

  it('never lets a cascade of demotes restart the hold clock', () => {
    // The 7.03 s case: three demotes ~2 s apart, each previously failing
    // `heldForThisTier` and resetting the clock while the frame kept paying the
    // top rung's resolution. Every step of that cascade now sheds on sight, so
    // there is no clock to reset.
    for (const solved of [0.63, 0.52, 0.48]) {
      expect(decideTierResize({ ...base, solved, heldForThisTier: false })).toBe('apply')
    }
  })

  it('defers a shed while a crossfade is in flight, and resolves right after', () => {
    // The one case where waiting beats shedding: the commit has already
    // reallocated, and a second realloc stacked on it was the biggest cluster
    // of 50-250 ms frames in the older logs.
    expect(decideTierResize({ ...base, solved: 0.63, txActive: true })).toBe('restart-hold')
    // Same inputs one frame later with the fade finished — no clock consulted.
    expect(decideTierResize({ ...base, solved: 0.63, txActive: false })).toBe('apply')
  })

  it('the emergency overrides everything, including a crossfade', () => {
    // p95 past 3x the refresh interval is three dropped frames in a row. At
    // that point one reallocation is unarguably cheaper than what the frame is
    // already paying.
    expect(
      decideTierResize({ ...base, solved: 0.91, p95Ms: 51, txActive: true }),
    ).toBe('apply')
  })

  it('treats a sub-quantum move as no move', () => {
    // 0.005 is half the 0.01 grid `solveRenderScale` rounds to, so this asks
    // "did the solve actually change", not "is it slightly smaller".
    expect(decideTierResize({ ...base, applied: 0.75, solved: 0.748 })).toBe('restart-hold')
  })

  it('a climb is not a shed even when the hold has long expired', () => {
    // Guards the obvious inversion: reading the direction backwards would make
    // every promote instant and every demote wait, which is the bug with its
    // sign flipped.
    expect(
      decideTierResize({ ...base, solved: 1.0, heldForThisTier: true, heldForSec: 0.1 }),
    ).toBe('wait')
  })
})
