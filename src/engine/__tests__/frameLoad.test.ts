import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyFrameLoad,
  committedMs,
  frameLoad,
  remainingMs,
  FEEDBACK_MS,
  feedbackMsFor,
  POST_CHAIN_MS,
  type FrameLoadEntry,
} from '../frameLoad'
import { TIER_BUDGET_MS } from '../slotBudget'
import { isFeedbackActive } from '../feedbackParams'

/** The load a quiet frame carries before any scene is counted. */
const FIXED = POST_CHAIN_MS + FEEDBACK_MS

describe('feedbackMsFor', () => {
  it('reserves nothing while the pass is bypassed', () => {
    // The default, and the overwhelmingly common case. FeedbackPass disables
    // itself at rest and EffectComposer skips a disabled pass entirely, so
    // reserving for it held 1 of only 5 units at the survival tier for work that
    // was not happening — and that was the unit deciding whether any crossfade
    // overlap was possible at all. See F84/F85.
    expect(feedbackMsFor(0)).toBe(0)
  })

  it('reserves a full unit once trails are actually running', () => {
    expect(feedbackMsFor(0.6)).toBe(FEEDBACK_MS)
  })

  it('agrees with the pass about where the boundary is', () => {
    // The two used to disagree, which is the whole bug. One predicate now.
    for (const t of [0, 0.005, 0.02, 0.05, 0.5, 1]) {
      expect(feedbackMsFor(t) > 0).toBe(isFeedbackActive(t))
    }
  })

  it('reserves nothing for a garbage value rather than over-reserving', () => {
    expect(feedbackMsFor(NaN)).toBe(0)
  })
})


beforeEach(() => {
  frameLoad.primary = 0
  frameLoad.incoming = 0
  frameLoad.layers = 0
  frameLoad.effects = 0
  frameLoad.fixed = POST_CHAIN_MS
})

describe('committedMs', () => {
  it('sums every contributor, not just the subject', () => {
    frameLoad.primary = 4
    frameLoad.layers = 3
    frameLoad.effects = 1
    frameLoad.fixed = FIXED
    // Written against FIXED rather than a bare literal (matches the pattern
    // already used below at "8 + POST_CHAIN_MS") so this stays correct across
    // whatever the fixed-cost constants are calibrated to next — see F182.
    expect(committedMs()).toBe(4 + 3 + 1 + FIXED)
  })

  it('counts the second primary during a crossfade', () => {
    // The frame really is carrying two subjects mid-fade — a fade is a multiply
    // at the end of the fragment shader, so neither one is cheaper for it. That
    // is precisely the moment an extra layer or effect must not be admitted.
    frameLoad.primary = 4
    frameLoad.incoming = 4
    expect(committedMs()).toBe(8 + POST_CHAIN_MS)
  })

  it('never reports an empty frame as free', () => {
    // The post chain runs whatever else is on screen, and used to be reserved
    // at exactly zero.
    expect(committedMs()).toBeGreaterThan(0)
  })
})

describe('remainingMs', () => {
  it('reports what is genuinely left', () => {
    frameLoad.primary = 2
    frameLoad.fixed = FIXED
    expect(remainingMs(TIER_BUDGET_MS[0])).toBe(TIER_BUDGET_MS[0] - 2 - FIXED)
  })

  it('floors at zero rather than wrapping into phantom headroom', () => {
    frameLoad.primary = 4
    frameLoad.incoming = 4
    frameLoad.layers = 4
    frameLoad.fixed = FIXED
    expect(committedMs()).toBeGreaterThan(TIER_BUDGET_MS[0])
    expect(remainingMs(TIER_BUDGET_MS[0])).toBe(0)
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
    expect(remainingMs(TIER_BUDGET_MS[0])).toBeGreaterThanOrEqual(1)
  })

  it('leaves a little real headroom for a heavy primary at the bottom tier', () => {
    // Before F182 this asserted `toBe(0)` — the fixed reservation alone (3 ms,
    // POST_CHAIN_MS=2 + FEEDBACK_MS=1) already exceeded what a heavy primary
    // left of tier 4's 6.5 ms budget, so this test *enshrined* the bug the rest
    // of that investigation fixed: a scene never got to spend a single ms of
    // tier 4's wallet on a layer or effect, no matter how cheap. F182
    // recalibrated the fixed reservation against two real sessions' measured
    // whole-frame GPU cost (never more than ~1.7 ms mean, chain included) down
    // to POST_CHAIN_MS=0.6 + FEEDBACK_MS=0.3, so a 4 ms primary now genuinely
    // leaves ~1.6 ms rather than reporting a budget that was never real.
    frameLoad.fixed = FIXED
    frameLoad.primary = 4
    expect(remainingMs(TIER_BUDGET_MS[4])).toBe(TIER_BUDGET_MS[4] - (4 + FIXED))
    expect(remainingMs(TIER_BUDGET_MS[4])).toBeGreaterThan(0)
  })

  it('treats a running feedback pass as a real cost', () => {
    // The post chain is always present; the feedback pass is charged only when
    // trails are actually running, and then it must genuinely show up.
    frameLoad.fixed = POST_CHAIN_MS
    const quiet = committedMs()
    frameLoad.fixed = FIXED
    expect(committedMs()).toBe(quiet + FEEDBACK_MS)
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
    ms: 1,
    ...over,
  })

  it('counts all three layer slots', () => {
    applyFrameLoad(
      [
        entry({ role: 'primary', ms: 4 }),
        entry({ role: 'background', ms: 1 }),
        entry({ role: 'accent', ms: 2 }),
        entry({ role: 'overlay', ms: 2 }),
      ],
      0,
    )
    expect(frameLoad.primary).toBe(4)
    expect(frameLoad.layers).toBe(5)
  })

  it('files the outgoing primary as overlap, not as the subject', () => {
    applyFrameLoad(
      [entry({ dir: 1, ms: 4 }), entry({ dir: -1, ms: 2 })],
      0,
    )
    expect(frameLoad.primary).toBe(4)
    expect(frameLoad.incoming).toBe(2)
  })

  it('counts a warming candidate that is still drawing', () => {
    applyFrameLoad([entry({ dir: 1, ms: 4 }), entry({ dir: 0, ms: 4 })], 0)
    expect(frameLoad.incoming).toBe(4)
  })

  it('does NOT count a warm entry that has gone quiet', () => {
    // Once compiled it is hidden and costs nothing. Charging for it would make
    // the budget refuse layers for the whole time a switch sits pending — which
    // can be a full bar under the warm-gate commit rule.
    applyFrameLoad(
      [entry({ dir: 1, ms: 4 }), entry({ dir: 0, ms: 4, drawing: false })],
      0,
    )
    expect(frameLoad.incoming).toBe(0)
  })

  it('separates effects from layers', () => {
    applyFrameLoad([entry({ role: 'effect', ms: 2 }), entry({ role: 'accent', ms: 1 })], 0)
    expect(frameLoad.effects).toBe(2)
    expect(frameLoad.layers).toBe(1)
  })

  it('clears stale buckets between frames', () => {
    applyFrameLoad([entry({ role: 'accent', ms: 2 })], 0)
    expect(frameLoad.layers).toBe(2)
    // A frame with no layers must report zero, not last frame's value.
    applyFrameLoad([entry({ role: 'primary', ms: 1 })], 0)
    expect(frameLoad.layers).toBe(0)
    expect(frameLoad.effects).toBe(0)
    expect(frameLoad.incoming).toBe(0)
  })

  it('reports a realistic worst case honestly', () => {
    // A heavy subject crossfading to another heavy one, over two layers, with
    // post and feedback live. This is the composition the old accounting
    // valued at 4 units.
    applyFrameLoad(
      [
        entry({ role: 'primary', dir: 1, ms: 4 }),
        entry({ role: 'primary', dir: -1, ms: 4 }),
        entry({ role: 'accent', ms: 2 }),
        entry({ role: 'overlay', ms: 1 }),
      ],
      FIXED,
    )
    // Written against FIXED (see the note above) rather than the literal 14
    // this summed to under the pre-F182 constants.
    expect(committedMs()).toBe(4 + 4 + 3 + FIXED)
    expect(remainingMs(TIER_BUDGET_MS[0])).toBe(0)
  })
})
