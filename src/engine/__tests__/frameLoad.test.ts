import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyFrameLoad,
  committedUnits,
  frameLoad,
  remainingUnits,
  GENERATIVE_UNITS,
  POST_CHAIN_UNITS,
  type FrameLoadEntry,
} from '../frameLoad'
import { TIER_BUDGET } from '../slotBudget'

/** The load a quiet frame carries before any scene is counted. */
const FIXED = POST_CHAIN_UNITS + GENERATIVE_UNITS

beforeEach(() => {
  frameLoad.primary = 0
  frameLoad.incoming = 0
  frameLoad.layers = 0
  frameLoad.effects = 0
  frameLoad.fixed = POST_CHAIN_UNITS
})

describe('committedUnits', () => {
  it('sums every contributor, not just the subject', () => {
    frameLoad.primary = 4
    frameLoad.layers = 3
    frameLoad.effects = 1
    frameLoad.fixed = FIXED
    expect(committedUnits()).toBe(11)
  })

  it('counts the second primary during a crossfade', () => {
    // The frame really is carrying two subjects mid-fade — a fade is a multiply
    // at the end of the fragment shader, so neither one is cheaper for it. That
    // is precisely the moment an extra layer or effect must not be admitted.
    frameLoad.primary = 4
    frameLoad.incoming = 4
    expect(committedUnits()).toBe(8 + POST_CHAIN_UNITS)
  })

  it('never reports an empty frame as free', () => {
    // The post chain runs whatever else is on screen, and used to be reserved
    // at exactly zero.
    expect(committedUnits()).toBeGreaterThan(0)
  })
})

describe('remainingUnits', () => {
  it('reports what is genuinely left', () => {
    frameLoad.primary = 2
    frameLoad.fixed = FIXED
    expect(remainingUnits(TIER_BUDGET[0])).toBe(TIER_BUDGET[0] - 2 - FIXED)
  })

  it('floors at zero rather than wrapping into phantom headroom', () => {
    frameLoad.primary = 4
    frameLoad.incoming = 4
    frameLoad.layers = 4
    frameLoad.fixed = FIXED
    expect(committedUnits()).toBeGreaterThan(TIER_BUDGET[0])
    expect(remainingUnits(TIER_BUDGET[0])).toBe(0)
  })
})

/**
 * The fixed costs are new claimants on a budget ladder that predates them, so
 * the ladder has to still be usable with them subtracted. If it were not, the
 * honest accounting would simply refuse every layer at every tier — correct
 * arithmetic, useless product.
 */
describe('the tier ladder survives honest accounting', () => {
  it('leaves room for a cheap primary plus a layer at the top tier', () => {
    frameLoad.fixed = FIXED
    frameLoad.primary = 1
    expect(remainingUnits(TIER_BUDGET[0])).toBeGreaterThanOrEqual(1)
  })

  it('still runs a heavy primary solo at the bottom tier', () => {
    // Tier 4's budget is 2 and the fixed cost alone is 3, so a heavy subject is
    // already over — which is the correct reading: at survival quality the
    // frame has nothing spare, and layers should be refused.
    frameLoad.fixed = FIXED
    frameLoad.primary = 4
    expect(remainingUnits(TIER_BUDGET[4])).toBe(0)
  })

  it('treats the generative overlay as a real cost', () => {
    // `generative` defaults to true and Stage keeps the layer mounted for the
    // session once ever enabled, so for most users this is always present —
    // and it was previously invisible to the budget entirely.
    frameLoad.fixed = POST_CHAIN_UNITS
    const withoutGen = committedUnits()
    frameLoad.fixed = FIXED
    expect(committedUnits()).toBe(withoutGen + GENERATIVE_UNITS)
  })
})

/**
 * Attribution — the part that answers "is it actually tracking the layers?".
 *
 * This logic used to live inline in SceneManager's `useFrame`, where it could
 * not be tested at all. The interesting mistakes are all here: charging for a
 * hidden warm entry, filing the outgoing primary as the subject, or missing
 * layers entirely, which is the bug the whole module exists to fix.
 */
describe('applyFrameLoad — attribution', () => {
  const entry = (over: Partial<FrameLoadEntry>): FrameLoadEntry => ({
    role: 'primary',
    dir: 1,
    drawing: true,
    units: 1,
    ...over,
  })

  it('counts all three layer slots', () => {
    applyFrameLoad(
      [
        entry({ role: 'primary', units: 4 }),
        entry({ role: 'background', units: 1 }),
        entry({ role: 'accent', units: 2 }),
        entry({ role: 'overlay', units: 2 }),
      ],
      0,
    )
    expect(frameLoad.primary).toBe(4)
    expect(frameLoad.layers).toBe(5)
  })

  it('files the outgoing primary as overlap, not as the subject', () => {
    applyFrameLoad(
      [entry({ dir: 1, units: 4 }), entry({ dir: -1, units: 2 })],
      0,
    )
    expect(frameLoad.primary).toBe(4)
    expect(frameLoad.incoming).toBe(2)
  })

  it('counts a warming candidate that is still drawing', () => {
    applyFrameLoad([entry({ dir: 1, units: 4 }), entry({ dir: 0, units: 4 })], 0)
    expect(frameLoad.incoming).toBe(4)
  })

  it('does NOT count a warm entry that has gone quiet', () => {
    // Once compiled it is hidden and costs nothing. Charging for it would make
    // the budget refuse layers for the whole time a switch sits pending — which
    // can be a full bar under the warm-gate commit rule.
    applyFrameLoad(
      [entry({ dir: 1, units: 4 }), entry({ dir: 0, units: 4, drawing: false })],
      0,
    )
    expect(frameLoad.incoming).toBe(0)
  })

  it('separates effects from layers', () => {
    applyFrameLoad([entry({ role: 'effect', units: 2 }), entry({ role: 'accent', units: 1 })], 0)
    expect(frameLoad.effects).toBe(2)
    expect(frameLoad.layers).toBe(1)
  })

  it('clears stale buckets between frames', () => {
    applyFrameLoad([entry({ role: 'accent', units: 2 })], 0)
    expect(frameLoad.layers).toBe(2)
    // A frame with no layers must report zero, not last frame's value.
    applyFrameLoad([entry({ role: 'primary', units: 1 })], 0)
    expect(frameLoad.layers).toBe(0)
    expect(frameLoad.effects).toBe(0)
    expect(frameLoad.incoming).toBe(0)
  })

  it('reports a realistic worst case honestly', () => {
    // A heavy subject crossfading to another heavy one, over two layers, with
    // post and generative live. This is the composition the old accounting
    // valued at 4 units.
    applyFrameLoad(
      [
        entry({ role: 'primary', dir: 1, units: 4 }),
        entry({ role: 'primary', dir: -1, units: 4 }),
        entry({ role: 'accent', units: 2 }),
        entry({ role: 'overlay', units: 1 }),
      ],
      FIXED,
    )
    expect(committedUnits()).toBe(14)
    expect(remainingUnits(TIER_BUDGET[0])).toBe(0)
  })
})
