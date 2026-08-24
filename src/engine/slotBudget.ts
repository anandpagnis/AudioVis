import type { ScenePerformanceCost, SceneRole } from '../scenes'

/**
 * Composition budget: how much simultaneous scene cost the machine can carry.
 *
 * ## Why this replaced `maxHeavyLayers`
 *
 * The old knob counted *heavy scenes* (1 or 2), which cannot express "one high
 * plus two lows" — the exact shape a background/primary/accent composition
 * takes. Worse, the rule it implemented was not cost-based at all: it read
 * "if the primary is heavy and the tier is low, allow no layer; otherwise allow
 * ANY layer regardless of its cost". So a medium primary at the second-lowest
 * tier could legally pull in a `high` layer, while a heavy primary at a
 * comfortable tier could not pull in a trivial one.
 *
 * That means **exact parity with the old rule is not achievable** by any cost
 * budget, because the old rule was not a budget. Every difference below is in
 * the stricter direction (fewer simultaneous heavy fragments), which is the
 * safe direction — see `slotBudget.test.ts`, which pins each one.
 *
 * ## Why cost and not slot count
 *
 * The roster is dominated by fullscreen-quad shader scenes, and those are
 * fill-rate bound with no culling relief: every one covers every pixel. At
 * 1080p/DPR 1.5 a fullscreen pass is ~4.7M fragments, and a raymarcher runs up
 * to `raymarchSteps` field evaluations on each. Two heavy fullscreen scenes
 * roughly double the frame's dominant cost. Draw calls are irrelevant here;
 * fragments are everything.
 */

/** Slots that can hold a scene, in the order they are offered budget. */
export type SecondarySlot = 'background' | 'accent' | 'overlay' | 'effect'

/**
 * Allocation order. The primary always reserves first (it is the subject and is
 * never dropped); everything else competes for what is left, most structural
 * first. Effects are last because they are punctuation — the frame still reads
 * without them.
 */
export const SLOT_PRIORITY: SecondarySlot[] = ['background', 'accent', 'overlay', 'effect']

/** Cost in budget units per declared `performanceCost`. */
const COST_UNITS: Record<ScenePerformanceCost, number> = { low: 1, medium: 2, high: 4 }

/**
 * TOTAL frame capacity per quality tier, indexed like `quality.tier`
 * (0 richest → 4 survival). **The single ladder** — `quality.ts` builds its
 * `layerBudget` knob from this rather than declaring a second copy.
 *
 * Calibrated against the two behaviours worth preserving from `maxHeavyLayers`:
 * two heavy scenes may overlap at tier 0, and a heavy primary runs strictly solo
 * from tier 2 down.
 *
 * ## Why these are 3 higher than they used to be
 *
 * The ladder was `[8, 6, 4, 3, 2]` back when the post chain and the generative
 * overlay were reserved at ZERO — so their cost was always implicitly baked
 * into these numbers. Now that frameLoad.ts reserves them explicitly, keeping
 * the old figures would charge for them twice: the effective budget for scenes
 * would have fallen to `[5, 3, 1, 0, 0]`, which strips layers from the show
 * entirely at tier 2 and below. Correct arithmetic, wrong product.
 *
 * Rebased by exactly `POST_CHAIN_UNITS + GENERATIVE_UNITS` so the numbers now
 * mean what the name says — everything the frame carries, fixed costs included
 * — and the change is behaviour-neutral for the composition it already
 * produced, while the previously-blind claimants finally see the truth.
 */
export const TIER_BUDGET: number[] = [11, 9, 7, 6, 5]

/**
 * Budget units a scene costs in a given slot.
 *
 * A scene in a non-primary slot may be discounted one step — but ONLY if it
 * declared `roleScalable`, meaning it actually reads `ctx.role` and reduces its
 * own shader work (step counts, iterations, particle counts) when it is not the
 * subject. Discounting a scene that ignores the signal would be budgeting for
 * work it is still doing at full cost, which is how a governor ends up
 * confidently overcommitting the GPU.
 */
export function slotCost(
  cost: ScenePerformanceCost,
  slot: SceneRole | 'primary',
  roleScalable = false,
): number {
  const units = COST_UNITS[cost]
  if (slot === 'primary' || !roleScalable) return units
  return Math.max(1, units === 4 ? 2 : units === 2 ? 1 : 1)
}

export interface SlotRequest {
  slot: SecondarySlot
  units: number
}

/**
 * Which requested slots fit alongside the primary, in {@link SLOT_PRIORITY}
 * order.
 *
 * Greedy by priority rather than optimal packing: a background that fits should
 * never be displaced by two cheaper accents, because the slots are not
 * interchangeable — losing the ground layer changes the composition more than
 * losing an accent does.
 *
 * Pure, and exported for tests: this decides what renders, and it fails
 * silently in the expensive direction (an overcommitted frame still draws, it
 * just stutters).
 */
export function admitSlots(
  budget: number,
  reserved: number,
  requests: SlotRequest[],
  /**
   * Admission order. Defaults to {@link SLOT_PRIORITY}. Callers override it to
   * give one of accent/overlay first refusal when the material favours it —
   * without an override the earlier entry would always win a tight budget,
   * which is a bias rather than a decision.
   */
  priority: readonly SecondarySlot[] = SLOT_PRIORITY,
): SecondarySlot[] {
  let remaining = budget - reserved
  const admitted: SecondarySlot[] = []
  for (const slot of priority) {
    const req = requests.find((r) => r.slot === slot)
    if (!req) continue
    if (req.units > remaining) continue
    remaining -= req.units
    admitted.push(slot)
  }
  return admitted
}

/**
 * Can the budget carry everything that is on screen during a crossfade?
 *
 * A crossfade renders BOTH primaries at full shader cost for its whole
 * duration — the fade is a multiply at the end of the fragment shader, so a
 * scene at 5% opacity costs exactly what it costs at 100%. And the composition
 * layers keep rendering throughout, because they have their own lifetime and
 * deliberately survive a primary switch unchanged.
 *
 * The previous version took only the incoming primary and asked
 * `primaryUnits * 2 <= budget`, which ignored the layers entirely. At tier 0
 * that let `network` + `heap` (4 + 4 = 8 of 8) crossfade while `ribbons` and an
 * overlay were also live — 11 units of real load against a budget of 8, or
 * ~14 ms of scene work before the post chain. That is where the 33-35 ms
 * transition frames came from: not a stall, just more scene than the frame
 * could hold, for about a second.
 *
 * Callers that cannot fund the overlap hard-cut instead, which costs nothing
 * and is a documented part of the visual language.
 */
export function canFundOverlap(
  budget: number,
  outgoingUnits: number,
  incomingUnits: number,
  /** Cost of every layer that stays on screen through the fade. */
  layerUnits = 0,
): boolean {
  return outgoingUnits + incomingUnits + layerUnits <= budget
}
