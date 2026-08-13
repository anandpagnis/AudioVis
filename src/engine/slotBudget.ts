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
 * Budget per quality tier, indexed like `quality.tier` (0 richest → 4 survival).
 *
 * Calibrated against the two behaviours worth preserving from `maxHeavyLayers`:
 * two heavy scenes may overlap at tier 0 (`2 × 4 = 8`), and a heavy primary runs
 * strictly solo from tier 2 down (`4 - 4 = 0` left over).
 */
export const TIER_BUDGET: number[] = [8, 6, 4, 3, 2]

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
 * Can the budget fund BOTH primaries through a crossfade?
 *
 * When it cannot, SceneManager hard-cuts instead — the smoothness guard that
 * used to read `maxHeavyLayers < 2`. Note this is separate from the editorial
 * hard cut on drops, which fires regardless of budget.
 */
export function canFundOverlap(budget: number, primaryUnits: number): boolean {
  return primaryUnits * 2 <= budget
}
