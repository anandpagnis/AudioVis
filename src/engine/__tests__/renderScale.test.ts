import { describe, expect, it } from 'vitest'
import {
  MAX_PIXEL_BUDGET,
  MIN_PIXEL_BUDGET,
  NATIVE_PIXEL_BUDGET,
  RENDER_SCALE_FLOOR,
  RenderScaleSolver,
  capScaleFor,
  claimsResolution,
  combinePixelBudgets,
  solveRenderScale,
} from '../renderScale'
import { maxResolutionMP } from '../maxResolution'

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

  it('ignores a display change too small to be worth a visible step', () => {
    // A step no longer reallocates anything (F272 stage 5), but it is still a
    // change of sharpness and a session-log event. One CSS pixel of difference
    // must not buy either.
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

  it('adding a claimant costs resolution, and removing it gives it back', () => {
    // A pure function of the current set rather than an accumulator, so a long
    // show's claimants coming and going cannot drift it. (The live frame only
    // hands it the committed primary and the post chain since F272 — see
    // `claimsResolution` — but `/bench` composes arbitrary sets through it.)
    const solo = combinePixelBudgets([1.5])
    const layered = combinePixelBudgets([1.5, 4])
    expect(layered).toBeLessThan(solo)
    expect(combinePixelBudgets([1.5])).toBe(solo)
  })
})

describe('claimsResolution (F272)', () => {
  it('only the committed primary claims the frame resolution', () => {
    expect(claimsResolution({ role: 'primary', dir: 1 })).toBe(true)
  })

  it('layers never do, so the director adding or dropping one cannot step the resolution', () => {
    for (const role of ['background', 'accent', 'overlay']) {
      expect(claimsResolution({ role, dir: 1 })).toBe(false)
    }
  })

  it('effects never do, at any stage of their lifecycle', () => {
    for (const dir of [1, 0, -1]) expect(claimsResolution({ role: 'effect', dir })).toBe(false)
  })

  it('an outgoing or warming primary does not, so a crossfade steps once rather than twice', () => {
    expect(claimsResolution({ role: 'primary', dir: 0 })).toBe(false)
    expect(claimsResolution({ role: 'primary', dir: -1 })).toBe(false)
  })

  it('a frame whose layers change keeps the same combined budget', () => {
    // The whole point: the same primary with and without an accent resolves to
    // the same number, so the scale PerfMonitor applies does not move.
    const budgetOf = (entries: { role: string; dir: number; mp: number }[]) =>
      combinePixelBudgets(entries.filter(claimsResolution).map((e) => e.mp))
    const alone = budgetOf([{ role: 'primary', dir: 1, mp: 12.5 }])
    const layered = budgetOf([
      { role: 'primary', dir: 1, mp: 12.5 },
      { role: 'accent', dir: 1, mp: 16 },
      { role: 'background', dir: 1, mp: 20 },
    ])
    expect(layered).toBe(alone)
  })
})

/**
 * The frame's pixel size (F272 stage 3), and since stage 5 the sub-rect the
 * whole chain renders into. Scenes size their own buffers from this instead of
 * `size * viewport.dpr`. At scale 1 it has to be exactly the pinned canvas
 * three allocates, integer for integer (a rect one pixel past the buffer would
 * scale the frame); below 1 it is floored the same way, so the relationship
 * three would give a canvas at that pixel ratio is the one pinned here.
 */
describe('RenderScaleSolver.internalW/H', () => {
  /** What three gives a canvas at pixel ratio `baseDpr * scale`: `floor(css * pixelRatio)`. */
  const canvasPx = (css: number, baseDpr: number, scale: number) => Math.floor(css * (baseDpr * scale))

  const solver = (cssW: number, cssH: number, baseDpr: number, applied: number) => {
    const s = new RenderScaleSolver()
    s.setDisplay(cssW, cssH, baseDpr)
    s.applied = applied
    return s
  }

  it('floors the scaled size the way the canvas is floored', () => {
    const s = solver(1440, 900, 2, 0.73)
    expect(s.internalW).toBe(2102) // 2102.4
    expect(s.internalH).toBe(1314)
  })

  it('multiplies the pixel ratio out first, as three does, so it never lands one pixel off', () => {
    // 1440 * 1.25 * 0.41 floors to 738 evaluated left to right; three floors
    // 1440 * (1.25 * 0.41) to 737, and that is the canvas.
    const s = solver(1440, 900, 1.25, 0.41)
    expect(s.internalW).toBe(canvasPx(1440, 1.25, 0.41))
    expect(s.internalW).toBe(737)
  })

  it('equals the canvas across displays, fractional CSS sizes and scales', () => {
    for (const [w, h, dpr] of [
      [1920, 1080, 1],
      [1728, 1117, 2],
      [1440.5, 899.75, 2],
      [2560, 1440, 1.5],
    ]) {
      for (let scale = RENDER_SCALE_FLOOR; scale <= 1; scale = Math.round((scale + 0.01) * 100) / 100) {
        const s = solver(w, h, dpr, scale)
        expect(s.internalW).toBe(canvasPx(w, dpr, scale))
        expect(s.internalH).toBe(canvasPx(h, dpr, scale))
      }
    }
  })

  it('tracks the applied scale, the base DPR and the CSS size', () => {
    const s = solver(1000, 500, 2, 1)
    expect([s.internalW, s.internalH]).toEqual([2000, 1000])
    s.applied = 0.5
    expect([s.internalW, s.internalH]).toEqual([1000, 500])
    s.setDisplay(1000, 500, 1)
    expect([s.internalW, s.internalH]).toEqual([500, 250])
    s.setDisplay(800, 600, 1)
    expect([s.internalW, s.internalH]).toEqual([400, 300])
  })

  it('never exceeds the pinned canvas, at any scale the solver can return (F272 stage 5)', () => {
    // The rect is drawn into buffers allocated at the canvas's drawing buffer;
    // one pixel past it would stretch the frame by that pixel.
    for (const [w, h, dpr] of [
      [1440, 900, 2],
      [1440.5, 899.75, 2],
      [2560, 1440, 1.5],
      [1728, 1117, 2],
    ]) {
      const canvasW = canvasPx(w, dpr, 1)
      const canvasH = canvasPx(h, dpr, 1)
      for (let scale = RENDER_SCALE_FLOOR; scale <= 1; scale = Math.round((scale + 0.01) * 100) / 100) {
        const s = solver(w, h, dpr, scale)
        expect(s.internalW).toBeLessThanOrEqual(canvasW)
        expect(s.internalH).toBeLessThanOrEqual(canvasH)
      }
      expect(solver(w, h, dpr, 1).internalW).toBe(canvasW)
    }
  })

  it('is monotonic in the scale, so a step up never shrinks the rect', () => {
    let prev = 0
    for (let scale = RENDER_SCALE_FLOOR; scale <= 1; scale = Math.round((scale + 0.01) * 100) / 100) {
      const w = solver(1440, 900, 2, scale).internalW
      expect(w).toBeGreaterThanOrEqual(prev)
      prev = w
    }
  })

  it('is at least 1 before any display is known, so no buffer is sized to zero', () => {
    const s = new RenderScaleSolver()
    expect(s.internalW).toBe(1)
    expect(s.internalH).toBe(1)
    expect(solver(0.2, 0.2, 1, 0.4).internalW).toBe(1)
  })

  it('keeps the last good display when handed garbage', () => {
    const s = solver(1000, 500, 2, 1)
    s.setDisplay(0, 500, 2)
    s.setDisplay(NaN, 500, 2)
    s.setDisplay(1000, 500, 0)
    expect([s.internalW, s.internalH]).toEqual([2000, 1000])
  })

  it('fullW/H is the rect at scale 1, whatever scale is applied', () => {
    // What a grow-only buffer sizes its capacity from, so it has to be the
    // largest rect any scale produces and must not follow the applied scale.
    for (const [w, h, dpr] of [
      [1440, 900, 2],
      [1440.5, 899.75, 2],
      [2560, 1440, 1.5],
    ]) {
      const atOne = solver(w, h, dpr, 1)
      for (const scale of [0.25, 0.4, 0.73, 1]) {
        const s = solver(w, h, dpr, scale)
        expect([s.fullW, s.fullH]).toEqual([atOne.internalW, atOne.internalH])
        expect(s.internalW).toBeLessThanOrEqual(s.fullW)
        expect(s.internalH).toBeLessThanOrEqual(s.fullH)
      }
    }
  })
})

/**
 * F272 stage 6: the user's "max render resolution" setting (maxResolution.ts),
 * a ceiling on the frame's megapixels on top of the solve.
 */
describe('the max-resolution cap', () => {
  /** The M1 Air fullscreen: 1440x900 CSS at 2x, 5.18 MP. */
  const m1 = mp(1440, 900, 2)
  const fiveK = mp(2560, 1440, 2)

  it('binds: 2560x1600 on the M1 renders at 0.88 and never more pixels than it names', () => {
    const cap = maxResolutionMP('2560x1600')
    const scale = solveRenderScale(NATIVE_PIXEL_BUDGET, m1, 1, cap)
    expect(scale).toBe(0.88)
    expect(m1 * scale * scale).toBeLessThanOrEqual(cap)
  })

  it('is exactly the uncapped solve at Native', () => {
    for (const full of Object.values(DISPLAYS)) {
      for (const budget of [0.5, 1.3, 4, 12.5, NATIVE_PIXEL_BUDGET]) {
        for (const tier of [1, 0.72, 0.49, 0.3]) {
          expect(solveRenderScale(budget, full, tier, maxResolutionMP('native'))).toBe(
            solveRenderScale(budget, full, tier),
          )
        }
      }
    }
  })

  it('changes nothing when the cap is at or above the display', () => {
    const cap = maxResolutionMP('3840x2160')
    for (const budget of [1.3, 4, NATIVE_PIXEL_BUDGET]) {
      expect(solveRenderScale(budget, DISPLAYS.monitor, 1, cap)).toBe(solveRenderScale(budget, DISPLAYS.monitor))
    }
    expect(capScaleFor(cap, DISPLAYS.monitor)).toBe(1)
  })

  it('may go below the solver’s floor: 1280x720 on a 5K panel is 0.25', () => {
    // The floor protects the picture from the solver's guess, not from a choice.
    expect(solveRenderScale(NATIVE_PIXEL_BUDGET, fiveK, 1, maxResolutionMP('1280x720'))).toBe(0.25)
    expect(0.25).toBeLessThan(RENDER_SCALE_FLOOR)
  })

  it('leaves the tier in charge when the tier asks for less than the cap', () => {
    const cap = maxResolutionMP('2560x1600')
    const tiered = solveRenderScale(1.3, DISPLAYS.retina, 0.72)
    expect(tiered).toBeLessThan(capScaleFor(cap, DISPLAYS.retina))
    expect(solveRenderScale(1.3, DISPLAYS.retina, 0.72, cap)).toBe(tiered)
  })

  it('still applies when the budget is garbage', () => {
    const cap = maxResolutionMP('2560x1600')
    expect(solveRenderScale(NaN, m1, 1, cap)).toBe(0.88)
    expect(solveRenderScale(0, m1, 1, cap)).toBe(0.88)
  })

  it('rounds down on the 1/100 grid, so no cap is ever exceeded', () => {
    for (const full of [m1, fiveK, ...Object.values(DISPLAYS), mp(1512, 982, 2), mp(1280, 800, 1.5)]) {
      for (const id of ['3840x2160', '2560x1600', '2560x1440', '1920x1080', '1280x720']) {
        const cap = maxResolutionMP(id)
        const scale = capScaleFor(cap, full)
        expect(Math.round(scale * 100) / 100).toBe(scale)
        expect(full * scale * scale).toBeLessThanOrEqual(cap * (1 + 1e-6))
        if (scale < 1) expect(full * (scale + 0.01) * (scale + 0.01)).toBeGreaterThan(cap)
      }
    }
  })

  it('reads no usable cap as no cap', () => {
    for (const bad of [Infinity, NaN, 0, -3]) expect(capScaleFor(bad, m1)).toBe(1)
    expect(capScaleFor(1e-9, m1)).toBe(0.01)
  })

  it('flows from the solver’s maxMP into solve()', () => {
    const s = new RenderScaleSolver()
    s.setDisplay(1440, 900, 2)
    s.setSceneBudget(NATIVE_PIXEL_BUDGET)
    expect(s.solve(1)).toBe(1)
    s.setMaxMP(maxResolutionMP('2560x1600'))
    expect(s.solve(1)).toBe(0.88)
    expect(s.internalMP(s.solve(1))).toBeLessThanOrEqual(maxResolutionMP('2560x1600'))
    s.setMaxMP(NaN)
    expect(s.maxMP).toBe(Infinity)
    expect(s.solve(1)).toBe(1)
    s.setMaxMP(0)
    expect(s.solve(1)).toBe(1)
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
