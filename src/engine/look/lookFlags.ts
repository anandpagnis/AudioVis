import { CHARACTER_MOODS, type CharacterMood } from '../../audio/characterTypes'
import type { LookFamilies } from './lookRow'

/**
 * URL switches of the look system (plan P0 "seams": the tuning workflow is to watch real footage, so these are
 * first-class). Every reader takes an INJECTABLE search string (tests, or a caller that already has one) and
 * defaults to `location.search`; with no `location` (node, workers) or a throwing one they fall back to the
 * "flag absent" answer, so a flag can never break boot.
 *
 *  - `?lookforce=<mood>`  pin ANY of the 14 character rows on any audio (`CHARACTER_MOODS` ids, case-insensitive).
 *  - `?lookdebug`         show the look overlay (`?lookdebug=0|false|off|no` counts as off).
 *  - `?look=-grade,-post,-scene,-camera`  per-family kill switches: a leading '-' disables that family, anything
 *    else (unknown names, tokens without '-') is ignored. Repeated `look=` params accumulate.
 *  - `?scenepick=legacy`  the pre-existing "original mood labels everywhere" switch: ALL families off.
 *  - `?tempo=off`         turn the BPM -> motion-speed coupling off (`0|false|off|no` all count); motion speed is then
 *                         exactly what it was before the coupling existed.
 *  - `?arm=off`           turn the armed drop scene off (`0|false|off|no` all count): AutoPilot then runs its original
 *                         1-3-beat drop pre-arm and nothing is held warm through a build (`engine/armedChange.ts`).
 */

function readSearch(search?: string): string {
  if (search !== undefined) return search
  try {
    return typeof location === 'undefined' ? '' : location.search
  } catch {
    return ''
  }
}

function paramsOf(search?: string): URLSearchParams | null {
  try {
    return new URLSearchParams(readSearch(search))
  } catch {
    return null
  }
}

const MOOD_IDS: readonly string[] = CHARACTER_MOODS

/** `?lookforce=<mood>`: the pinned mood, or null when absent or not one of `CHARACTER_MOODS`. */
export function lookForceMood(search?: string): CharacterMood | null {
  const raw = paramsOf(search)?.get('lookforce')
  if (raw === null || raw === undefined) return null
  const v = raw.trim().toLowerCase()
  return MOOD_IDS.includes(v) ? (v as CharacterMood) : null
}

const OFF_VALUES: readonly string[] = ['0', 'false', 'off', 'no']

/** `?lookdebug`: bare or with any value except 0 / false / off / no. */
export function lookDebugEnabled(search?: string): boolean {
  const p = paramsOf(search)
  if (p === null || !p.has('lookdebug')) return false
  const v = (p.get('lookdebug') ?? '').trim().toLowerCase()
  return !OFF_VALUES.includes(v)
}

/** `?tempo=off` (or 0 / false / no): the BPM -> motion-speed coupling is disabled. Absent or any other value: on. */
export function tempoCouplingOff(search?: string): boolean {
  const raw = paramsOf(search)?.get('tempo')
  if (raw === null || raw === undefined) return false
  return OFF_VALUES.includes(raw.trim().toLowerCase())
}

/** `?arm=off` (or 0 / false / no): the armed drop scene is disabled. Absent or any other value: on. */
export function armOff(search?: string): boolean {
  const raw = paramsOf(search)?.get('arm')
  if (raw === null || raw === undefined) return false
  return OFF_VALUES.includes(raw.trim().toLowerCase())
}

/**
 * Per-family switches. A fresh object each call (read once at startup, not per frame). All four are false under
 * `?scenepick=legacy`, which wins over `?look=`.
 */
export function lookFamilies(search?: string): LookFamilies {
  const out: LookFamilies = { grade: true, post: true, scene: true, camera: true }
  const p = paramsOf(search)
  if (p === null) return out
  if (p.get('scenepick') === 'legacy') {
    out.grade = false
    out.post = false
    out.scene = false
    out.camera = false
    return out
  }
  for (const value of p.getAll('look')) {
    for (const token of value.split(',')) {
      const t = token.trim().toLowerCase()
      if (!t.startsWith('-')) continue
      switch (t.slice(1).trim()) {
        case 'grade':
          out.grade = false
          break
        case 'post':
          out.post = false
          break
        case 'scene':
          out.scene = false
          break
        case 'camera':
          out.camera = false
          break
        default:
          break // unknown family: ignored
      }
    }
  }
  return out
}
