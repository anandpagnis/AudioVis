import { LEGACY, type LegacyInput } from './legacyEvents'
import type { SectionEvent } from './types'

/**
 * How the show adapter combines the two event sources when `?events=v2` is on (`engine/show/showAdapter.tsx`). Pure, so
 * it is tested without React:
 *
 *  - {@link maskLegacyInputForV2}: the legacy mapping is still stepped every frame (its drop / build state must not
 *    freeze), but v2 replaces its sectionChange- and boundary-derived `change` / `breakdown` events, so those signals
 *    are not fed to it: `f.sectionChange` is off (it would otherwise also "corroborate" a drop) and a `boundaryChanged`
 *    only counts when the new section is a drop or a build.
 *  - {@link mergeLiveWithLegacy}: of what the legacy mapping delivered only `buildStart` and (see below) some `drop`s
 *    survive (in place, order kept), then the live events are appended, so a drop is seen before the change that follows it
 *    and the director can corroborate it.
 *
 * ## Drops under v2
 * The live layer now detects the drop itself (`gapDrop.ts`: a dropout of at least a bar in the low band, then its return:
 * on the two tapped songs 5 drops, all at a mark, where the legacy `f.drop` fired 37 times for 12 scene marks). `f.drop` is
 * mostly a loud-transient detector (~250 an hour on the 98 real tracks, 6% behind a build), so with v2 on it is DEMOTED:
 * only a legacy drop the mapper itself graded as the release of a build or a breakdown ({@link MUX.legacyDropMinConfidence},
 * the mapper's `dropBuildConfidence` / `dropReleaseConfidence` grades) still reaches the director; lone and mid-confidence
 * ones are dropped. `legacyDrops: 'all'` restores the old pass-through, `'none'` ignores them all.
 *
 * `?events=legacy` calls neither: today's Phase-1 event source, untouched.
 */

export const MUX = {
  /** Which legacy `drop` events survive under v2: `release` (graded as a build / breakdown release), `all` (the old behaviour), `none`. */
  legacyDrops: 'release' as 'release' | 'all' | 'none',
  /** A legacy drop this confident is a release-backed one (the mapper's 0.85 / 0.90 grades). */
  legacyDropMinConfidence: LEGACY.dropReleaseConfidence as number,
}

/** Feed the legacy mapping only the signals v2 does not replace. Mutates `li`. */
export function maskLegacyInputForV2(li: LegacyInput): void {
  li.sectionChange = false
  li.boundaryChanged = li.boundaryChanged && (li.section === 'drop' || li.section === 'build')
}

/** Does a legacy `drop` event still reach the director under v2 (see the header)? */
export function keepLegacyDrop(e: SectionEvent): boolean {
  if (MUX.legacyDrops === 'all') return true
  if (MUX.legacyDrops === 'none') return false
  return e.confidence >= MUX.legacyDropMinConfidence
}

/** Keep the legacy `buildStart` events and the `drop`s that {@link keepLegacyDrop} lets through (in place), then append `live`. Returns the new length. */
export function mergeLiveWithLegacy(events: SectionEvent[], live: readonly SectionEvent[]): number {
  let w = 0
  for (let k = 0; k < events.length; k++) {
    const e = events[k]
    if (e.type === 'buildStart' || (e.type === 'drop' && keepLegacyDrop(e))) events[w++] = e
  }
  events.length = w
  for (let k = 0; k < live.length; k++) events.push(live[k])
  return events.length
}
