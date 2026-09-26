/**
 * URL switch of the show director (`engine/show/`), following `engine/look/lookFlags.ts`: the reader takes an
 * INJECTABLE search string (tests), defaults to `location.search`, and with no `location` (node, workers) or a throwing
 * one answers "flag absent", so it can never break boot.
 *
 *  - `?director=legacy`  run the OLD scene triggers bit-for-bit: mood change, predicted transition, character shift,
 *                        the 25 s stale timer, the build one-shot, the drop pick, the armed-scene confirms and
 *                        PerformanceDirector's `sectionChange` / 16-beat-phrase recompose each switch the scene on
 *                        their own, behind the 32-beat dwell. (`0|false|off|no` count as legacy too.)
 *
 * Absent (the default) the show director owns WHEN the primary scene changes. The flag is read ONCE, at module load,
 * exactly like `ARM_ENABLED`, so the whole session runs one policy.
 */

const OFF_VALUES: readonly string[] = ['0', 'false', 'off', 'no']

function readSearch(search?: string): string {
  if (search !== undefined) return search
  try {
    return typeof location === 'undefined' ? '' : location.search
  } catch {
    return ''
  }
}

/** `?director=legacy` (or 0 / false / off / no): the legacy trigger blocks run and the director stays out of the way. */
export function directorLegacy(search?: string): boolean {
  let raw: string | null
  try {
    raw = new URLSearchParams(readSearch(search)).get('director')
  } catch {
    return false
  }
  if (raw === null) return false
  const v = raw.trim().toLowerCase()
  return v === 'legacy' || OFF_VALUES.includes(v)
}

/** The show director owns scene timing this session (read once). */
export const DIRECTOR_ON: boolean = !directorLegacy()

/**
 * `?events=v2|legacy`: which source feeds the director's `change` / `fill` / `gain` / `breakdown` events.
 *
 *  - `v2` (the DEFAULT): the bar-synchronous live change scorer (`audio/events/EventLayer.ts`) supplies them; the legacy
 *    mapping keeps only its `drop` and `buildStart` events (the sectionChange- and boundary-derived `change` events are
 *    dropped: v2 replaces them). Made the default after `corpus/structure/director-vs-silver.md`: on the synthetic suite
 *    v2 finds 84% of real changes within a bar against 24% for `f.sectionChange`, with 0.30 vs 2.11 false alarms/min and 0
 *    events near fills, volume steps or silence; against the whole-song reference its F3 is .386 vs .287 and its coverage
 *    of strong boundaries has a chance-corrected lift of .28 vs .17. The one criterion that failed as first written
 *    (cuts within +-1 bar of a reference boundary) cannot be met by a causal show (it cuts ~1.7 bars after the change);
 *    in the lag-aware window [0,+2] bars v2 cuts land 21% vs the old show's 10% (2.1x). Relative evidence only: the
 *    reference is unvalidated by human labels, so `?events=legacy` stays as the fallback.
 *  - `legacy`: today's Phase-1 mapping. `f.sectionChange` and the analyser's kind-change boundaries become `change`
 *    events (`audio/events/legacyEvents.ts`), exactly as before. `0|false|off|no` count as legacy too.
 *
 * Read ONCE at module load like `DIRECTOR_ON`, so the whole session runs one source. Only an explicit legacy value selects
 * legacy: anything else, including a typo, is v2.
 */
const LEGACY_VALUES: readonly string[] = ['legacy', ...OFF_VALUES]

export type EventsSource = 'v2' | 'legacy'

export function eventsSource(search?: string): EventsSource {
  let raw: string | null
  try {
    raw = new URLSearchParams(readSearch(search)).get('events')
  } catch {
    return 'v2'
  }
  if (raw === null) return 'v2'
  return LEGACY_VALUES.includes(raw.trim().toLowerCase()) ? 'legacy' : 'v2'
}

/** The v2 event layer feeds the director this session (read once). */
export const EVENTS_V2: boolean = eventsSource() === 'v2'
