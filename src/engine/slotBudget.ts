import type { ScenePerformanceCost, SceneRole } from '../scenes'
import { sceneCostMs } from './sceneCost'

/**
 * Composition budget: how much simultaneous scene cost the machine can carry,
 * **in milliseconds of frame time**.
 *
 * ## Why the currency is milliseconds
 *
 * It used to be an abstract unit, priced from a hand-written `low`/`medium`/
 * `high` label through `{ 1, 2, 4 }`. The `/bench` sweep showed that label was
 * unrelated to cost — `synthgrid` is labelled `medium` and costs 18.4 ms, while
 * `pointcloud` is labelled `high` and costs 0.12 ms, so the roster's second
 * cheapest scene was charged twice what its most expensive one was. Inside the
 * `medium` label alone the spread is a factor of 650.
 *
 * Milliseconds fix that and bring a second thing for free: the budget is now
 * denominated in the same unit as the thing it is protecting. "Scenes may claim
 * 9 ms of a 16.7 ms frame" is a claim that can be checked. "Scenes may claim 9
 * units" never was. See engine/sceneCost.ts for the table and its provenance.
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


/**
 * TOTAL frame capacity per quality tier in MILLISECONDS, indexed like
 * `quality.tier` (0 richest → 4 survival). **The single ladder** — `quality.ts`
 * builds its `frameBudgetMs` knob from this rather than declaring a second copy.
 *
 * Everything the frame carries counts against it: both primaries during a
 * crossfade, every composition layer, live effects, and the fixed per-frame
 * costs in frameLoad.ts.
 *
 * ## Reading the numbers
 *
 * A 60 Hz frame is 16.67 ms. Tier 0 lets the composition claim 11 of those,
 * leaving ~5.7 ms for the browser's own compositing, R3F's traversal, audio
 * analysis and the UI. That is the whole calibration; it is a division of a real
 * frame rather than a scale someone chose.
 *
 * ## Why it still tapers, now that costs are per-tier measurements
 *
 * The old ladder `[11, 9, 7, 6, 5]` cut capacity by 2.2x across the ladder while
 * scene prices stayed flat, so the tier punished a composition **twice**: once
 * by making every scene genuinely cheaper (pixel scale 1.0 → 0.23, raymarch
 * steps 96 → 28) and again by shrinking the wallet those cheaper scenes had to
 * fit inside. That double count is what made an overlap arithmetically
 * impossible at tier 4 and left three of the six transition styles unreachable
 * (F84). Scene prices are now per-tier measurements, so the first reduction is
 * already in the price and the second is no longer needed.
 *
 * It still tapers, gently, for a different reason: engine/sceneCost.ts is one
 * machine's table, and a device three times slower carries three times those
 * costs while the numbers read the same. The tier is the only evidence available
 * about how far from the bench machine this one is — sitting at tier 4 IS the
 * signal — so the taper is a margin against that unknown, not a second
 * complexity cut. 1.7x across the ladder rather than 2.2x, and for a stated
 * reason.
 */
export const TIER_BUDGET_MS: number[] = [11, 9.5, 8.5, 7.5, 6.5]

/**
 * Fraction of its measured cost a `roleScalable` scene is charged outside the
 * primary slot.
 *
 * Not measured, and honestly labelled: no scene in the roster declares
 * `roleScalable` today, so this multiplier has never been exercised (F89). The
 * old code expressed the same idea as "one step down the 1/2/4 ladder", which is
 * a 0.5 discount for a `high` scene and a 0.5 for a `medium` — so 0.6 is that
 * intent, slightly more conservative, in the new currency.
 */
export const ROLE_SCALED_FRACTION = 0.6

/**
 * Milliseconds a scene costs in a given slot at a given tier.
 *
 * A scene in a non-primary slot is discounted — but ONLY if it declared
 * `roleScalable`, meaning it actually reads `ctx.role` and reduces its own
 * shader work (step counts, iterations, particle counts) when it is not the
 * subject. Discounting a scene that ignores the signal would be budgeting for
 * work it is still doing at full cost, which is how a governor ends up
 * confidently overcommitting the GPU.
 */
export function slotCostMs(
  sceneId: string,
  tier: number,
  slot: SceneRole | 'primary',
  roleScalable = false,
  declared?: ScenePerformanceCost,
): number {
  const ms = sceneCostMs(sceneId, tier, declared)
  if (slot === 'primary' || !roleScalable) return ms
  return ms * ROLE_SCALED_FRACTION
}

export interface SlotRequest {
  slot: SecondarySlot
  /** Milliseconds, from {@link slotCostMs}. */
  ms: number
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
    if (req.ms > remaining) continue
    remaining -= req.ms
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
 * overlay were also live. The measured cost of exactly that composition is
 * 22.4 + 5.9 + 13.1 ms — **over 41 ms of scene work in a 16.7 ms frame**, which
 * the old currency valued at 8 units of 8 and called affordable. That is where
 * the 33-35 ms transition frames came from: not a stall, just far more scene
 * than the frame could hold, for about a second.
 *
 * Callers that cannot fund the overlap hard-cut instead, which costs nothing
 * and is a documented part of the visual language.
 */
export function canFundOverlap(
  budgetMs: number,
  outgoingMs: number,
  incomingMs: number,
  /** Cost of every layer that stays on screen through the fade. */
  layerMs = 0,
): boolean {
  return outgoingMs + incomingMs + layerMs <= budgetMs
}
