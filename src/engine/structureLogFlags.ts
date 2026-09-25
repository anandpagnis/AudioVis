/**
 * URL switch of the structure / event logger (`?structurelog`, see `engine/structureLog.ts` and
 * `ui/StructureLog.tsx`). Same conventions as `engine/look/lookFlags.ts`: every reader takes an INJECTABLE search
 * string (tests, or a caller that already has one) and defaults to `location.search`; with no `location` (node,
 * workers) or a throwing one it falls back to the "flag absent" answer, so the flag can never break boot.
 *
 *  - `?structurelog`          on. Bare, or with any value except `0 | false | off | no` (case-insensitive).
 *  - `?structurelog=off`      off (as is any of the other off spellings).
 *
 * The overlay lives in the OUTPUT window (the one that runs the engine), but the console opens that window at a
 * fixed `?output` and only forwards the look switches (`look/lookUrl.ts`). {@link structureLogRequested} therefore
 * also looks at the OPENER's URL (same origin, so it is readable), which means typing `?structurelog` on the
 * console's own URL is enough. Opening the output window directly at `?output&structurelog` works too.
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

function paramsOf(search?: string): URLSearchParams | null {
  try {
    return new URLSearchParams(readSearch(search))
  } catch {
    return null
  }
}

/** `?structurelog`: bare or with any value except 0 / false / off / no. */
export function structureLogEnabled(search?: string): boolean {
  const p = paramsOf(search)
  if (p === null || !p.has('structurelog')) return false
  const v = (p.get('structurelog') ?? '').trim().toLowerCase()
  return !OFF_VALUES.includes(v)
}

/** The bits of a `Window` that {@link structureLogRequested} reads (structural, so tests can pass a plain object). */
export interface WindowLikeForFlags {
  location?: { search?: string } | null
  opener?: WindowLikeForFlags | null
}

/**
 * Is the logger asked for by THIS window's URL or by the window that opened it? Never throws: reading a
 * cross-origin opener's `location` throws and counts as "not requested". An explicit off value on this window's
 * own URL wins over an opener that asks for it.
 */
export function structureLogRequested(win?: WindowLikeForFlags | null): boolean {
  let w: WindowLikeForFlags | null | undefined = win
  if (w === undefined) {
    try {
      w = typeof window === 'undefined' ? null : (window as unknown as WindowLikeForFlags)
    } catch {
      w = null
    }
  }
  if (!w) return false
  try {
    const own = w.location?.search ?? ''
    if (new URLSearchParams(own).has('structurelog')) return structureLogEnabled(own)
  } catch {
    // unreadable own location: fall through to the opener
  }
  try {
    const opener = w.opener
    if (opener) return structureLogEnabled(opener.location?.search ?? '')
  } catch {
    // cross-origin or closed opener
  }
  return false
}
