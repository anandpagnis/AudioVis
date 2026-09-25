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
