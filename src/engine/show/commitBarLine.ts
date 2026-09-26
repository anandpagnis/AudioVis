/**
 * WHERE SceneManager commits a pending (non-drop) scene: the bar line.
 *
 * Until now that was `f.beat && f.beatInBar === 0`, the ARBITRARY-phase bar line (`beatIndex % 4`: the beat tracker
 * counts from wherever it locked, and the downbeat estimator locks on 0 of 60 real clips). With `?events=v2` the live
 * event layer learns a bar grid anchored on the music's own section changes (`audio/events/barGrid.ts`, exposed as
 * `audioEngine.events.beatsToBarLine`), and the show adapter already requests its cuts against it (it asks on the last
 * beat of an anchored bar, so a request lands on the anchored downbeat). The commit must use the SAME grid or the two
 * disagree and a cut waits for the wrong line (up to a further bar, or the 2.5 s backstop).
 *
 * {@link isCommitBarLine} is the one pure decision:
 *  - no grid handed over (`null`: `?events=legacy`, or anything that does not run the v2 layer) -> EXACTLY today's
 *    `f.beat && f.beatInBar === 0`, bit for bit;
 *  - a grid whose `beatsToBarLine` is `>= 0` (it is confident: the layer answers -1 when it is not, see
 *    `BarGrid.beatsToBarLine`) -> the beat IS an anchored bar line when that distance is 0;
 *  - a grid that is not confident -> the same `f.beatInBar === 0` fallback, so an unlearned grid never changes anything.
 *
 * Pure (no imports): the caller decides whether v2 is on by what it passes.
 */

/** The part of the event layer the commit needs (`EventLayer.beatsToBarLine`): beats to the next anchored bar line, 0 = this beat, -1 = not confident. */
export interface AnchoredBarGrid {
  beatsToBarLine(beat: number): number
}

/** The `AudioFeatures` fields the decision reads. */
export interface CommitFrame {
  beat: boolean
  beatInBar: number
  beatIndex: number
}

/**
 * Is this frame a bar line to commit a pending scene on? `grid` is `audioEngine.events` when `?events=v2` is on, else `null`.
 */
export function isCommitBarLine(f: CommitFrame, grid: AnchoredBarGrid | null): boolean {
  if (!f.beat) return false
  if (grid !== null) {
    const toLine = grid.beatsToBarLine(f.beatIndex)
    if (toLine >= 0) return toLine === 0
  }
  return f.beatInBar === 0
}
