import type { LegacyInput } from './legacyEvents'
import type { SectionEvent } from './types'

/**
 * How the show adapter combines the two event sources when `?events=v2` is on (`engine/show/showAdapter.tsx`). Pure, so
 * it is tested without React:
 *
 *  - {@link maskLegacyInputForV2}: the legacy mapping is still stepped every frame (its drop / build state must not
 *    freeze), but v2 replaces its sectionChange- and boundary-derived `change` / `breakdown` events, so those signals
 *    are not fed to it: `f.sectionChange` is off (it would otherwise also "corroborate" a drop) and a `boundaryChanged`
 *    only counts when the new section is a drop or a build.
 *  - {@link mergeLiveWithLegacy}: of what the legacy mapping delivered only `drop` and `buildStart` survive (in place,
 *    order kept), then the live events are appended, so a drop is seen before the change that follows it and the
 *    director can corroborate it.
 *
 * `?events=legacy` calls neither: today's Phase-1 event source, untouched.
 */

/** Feed the legacy mapping only the signals v2 does not replace. Mutates `li`. */
export function maskLegacyInputForV2(li: LegacyInput): void {
  li.sectionChange = false
  li.boundaryChanged = li.boundaryChanged && (li.section === 'drop' || li.section === 'build')
}

/** Keep the legacy `drop` / `buildStart` events of `events` (in place), then append `live`. Returns the new length. */
export function mergeLiveWithLegacy(events: SectionEvent[], live: readonly SectionEvent[]): number {
  let w = 0
  for (let k = 0; k < events.length; k++) {
    const e = events[k]
    if (e.type === 'drop' || e.type === 'buildStart') events[w++] = e
  }
  events.length = w
  for (let k = 0; k < live.length; k++) events.push(live[k])
  return events.length
}
