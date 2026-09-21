/**
 * The confirmed-build one-shot scene switch (plan: "Mood-driven look system", risk 5).
 *
 * Design decision: a build ramps EFFECTS always (bloom, trails, mirror, steer: all in `LookProfileTracker`), but the
 * SCENE changes only once, on a confirmed structural build, and only to a fast scene. Everything that decides
 * whether that switch happens lives here as pure functions so it is unit-tested without React or the store;
 * `AutoPilot.tsx` supplies the live inputs and performs the request.
 *
 * ## What it costs, and why that is accepted
 *
 * `store.requestScene` enforces a 32-beat subject dwell for automatic, non-immediate requests, and it is stamped
 * when a scene COMMITS. A build switch therefore consumes the dwell, so the drop pre-arm (a non-immediate request
 * 1-3 beats before the drop) is usually REFUSED afterwards. That is fine: the drop's own request is `immediate`,
 * which bypasses the dwell, so the hard cut on the drop still fires exactly as it does today and the build's
 * scene is replaced on the drop. What the viewer gains is a fast scene for the riser that is about to end in that
 * cut. The rules below exist to keep that trade rare and worthwhile: rising edge only, dwell already elapsed,
 * enough build left, and only when the scene on screen is a poor build scene.
 */

export const BUILD_SWITCH = {
  /** A build known to end sooner than this many beats is not worth consuming the dwell for. */
  minBeatsTillDrop: 12,
  /** A current scene whose `buildFit` is at or above this already carries a build: stay on it. */
  maxCurrentBuildFit: 0.5,
  /** The lift handed to `pickByCharacter`: the pick point is raised to at least this arousal / tension. */
  minArousal: 0.72,
  minTension: 0.3,
  /** Re-picks after a refused request. The first pick plus this many, then stop: bounded, never a loop. */
  maxRepicks: 3,
} as const

/** Edge tracking for one show: the previous frame's sustain flag, and whether this build has had its attempt. */
export interface BuildSwitchState {
  prevSustain: boolean
  /** True once this build has had its one attempt (successful or not); cleared when the build ends. */
  fired: boolean
}

export function createBuildSwitchState(): BuildSwitchState {
  return { prevSustain: false, fired: false }
}

/**
 * Advance the edge tracking by one frame and return whether this frame is the RISING edge of the build
 * (`sustain` true now, false last frame). Also re-arms the once-per-build latch when the build ends.
 *
 * Call it every frame, BEFORE AutoPilot's early returns (manual hold, cutaways, silence), like the drop edge: an
 * edge that lands while automation is suppressed is then consumed rather than firing late, mid-build, when the
 * hold lifts.
 */
export function observeBuild(state: BuildSwitchState, sustain: boolean): boolean {
  const rising = sustain && !state.prevSustain
  if (!sustain) state.fired = false
  state.prevSustain = sustain
  return rising
}

/** `beatsTillDrop` of -1 (unknown / not building), 0, NaN or Infinity all mean "no usable estimate". */
export function beatsTillDropUnknown(beatsTillDrop: number): boolean {
  return !Number.isFinite(beatsTillDrop) || beatsTillDrop <= 0
}

export interface BuildSwitchInput {
  /** The mood-look profile is valid and its scene family is on (the consumer rule). Off: behave as before. */
  lookActive: boolean
  /** From {@link observeBuild} this frame. */
  risingEdge: boolean
  /** This build already had its attempt (`BuildSwitchState.fired`). */
  fired: boolean
  /** `canAutoSwitch(lastCommitBeat)`: the 32-beat dwell has elapsed. */
  canSwitch: boolean
  /** `f.songSection.beatsTillDrop`. */
  beatsTillDrop: number
  /** `getSceneTraits(currentSceneId).buildFit`. */
  currentBuildFit: number
  /** `s.pendingSceneId !== null`: a switch is already in flight. */
  hasPending: boolean
}

/**
 * Should AutoPilot make its one build switch on this frame? True only when ALL hold:
 *  - the look profile is active (otherwise the show behaves exactly as before);
 *  - this is the rising edge of a confirmed build and the build has not already had its attempt;
 *  - the subject dwell has elapsed (the switch must not be refused, and must not eat a dwell it cannot afford);
 *  - the drop is not imminent: `beatsTillDrop` is unknown or at least {@link BUILD_SWITCH.minBeatsTillDrop};
 *  - the scene on screen is a poor build scene (`buildFit` below {@link BUILD_SWITCH.maxCurrentBuildFit});
 *  - nothing is already pending.
 */
export function shouldSwitchOnBuild(i: BuildSwitchInput): boolean {
  return (
    i.lookActive &&
    i.risingEdge &&
    !i.fired &&
    i.canSwitch &&
    !i.hasPending &&
    (beatsTillDropUnknown(i.beatsTillDrop) || i.beatsTillDrop >= BUILD_SWITCH.minBeatsTillDrop) &&
    i.currentBuildFit < BUILD_SWITCH.maxCurrentBuildFit
  )
}

/**
 * Ask `pick` for a scene and `request` it; when the request is refused, exclude that id and re-pick, at most
 * {@link BUILD_SWITCH.maxRepicks} times. A refusal can be id-specific (`canHoldPrimary`) or general (dwell, a
 * pending switch); either way the loop is bounded and stops early when the picker has nothing new to offer (it
 * returned null, or an id that is already excluded, which is how `pickSceneForCharacter` reports an exhausted
 * pool). Returns the scene that was accepted, or null; `requests` counts how many were made.
 */
export function pickAndRequest<T extends { id: string }>(
  baseExclude: readonly string[],
  pick: (exclude: readonly string[], attempt: number) => T | null,
  request: (scene: T) => boolean,
  maxRepicks: number = BUILD_SWITCH.maxRepicks,
): { scene: T | null; requests: number } {
  const exclude = [...baseExclude]
  let requests = 0
  for (let attempt = 0; attempt <= maxRepicks; attempt++) {
    const scene = pick(exclude, attempt)
    if (scene === null || exclude.includes(scene.id)) break
    requests++
    if (request(scene)) return { scene, requests }
    exclude.push(scene.id)
  }
  return { scene: null, requests }
}

/**
 * A deterministic random source for the build switch's pick, seeded from the beat it fires on and the attempt
 * number, so a recorded set replays identically (the picker otherwise defaults to `Math.random`).
 */
export function buildSwitchRng(beatIndex: number, attempt: number): () => number {
  let a = (Math.imul(beatIndex | 0, 0x9e3779b1) ^ Math.imul(attempt + 1, 0x85ebca6b)) >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
