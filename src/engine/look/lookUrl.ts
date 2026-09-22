/**
 * Which URL switches of the look system follow the console into the output window.
 *
 * The engine (every director, the tracker, the post chain, `characterPick`, `characterLook`) runs in the OUTPUT
 * window, and each of those reads its flags from THAT window's `location.search`. The console opens the output
 * window at a fixed `?output` (`outputLink.openOutput`), so a flag typed on the console's own URL never reached
 * the window that runs the engine: `?scenepick=legacy` on the console did nothing, and neither would
 * `?lookforce=aggressive`. {@link outputWindowUrl} copies the four look switches across, and only those, so
 * nothing else on the console's URL (`?scene=`, `?quality=`, a share hash) leaks into the output window.
 *
 *  - `look`       per-family kill switches, `?look=-grade,-post,-scene,-camera` (repeats accumulate)
 *  - `lookforce`  pin a mood row, `?lookforce=aggressive`
 *  - `lookdebug`  the look overlay
 *  - `scenepick`  `?scenepick=legacy`, the original "mood labels everywhere" switch
 *
 * Pure, so it is tested without a window. The output window is REUSED by name once open, so a flag change
 * takes effect the next time it is opened fresh (close the output window, then reopen it).
 */
export const LOOK_QUERY_KEYS = ['look', 'lookforce', 'lookdebug', 'scenepick'] as const

/** The forwarded switches from a `location.search`-style string, as a query string body (no leading `?`), or `''`. */
export function forwardedLookQuery(search: string): string {
  let src: URLSearchParams
  try {
    src = new URLSearchParams(search)
  } catch {
    return ''
  }
  const out = new URLSearchParams()
  for (const key of LOOK_QUERY_KEYS) {
    for (const value of src.getAll(key)) out.append(key, value)
  }
  return out.toString()
}

/**
 * The URL the output window is opened at: `<pathname>?output`, plus the look switches present on the console's
 * `search`. With none present it is exactly the URL it always was.
 */
export function outputWindowUrl(pathname: string, search: string): string {
  const extra = forwardedLookQuery(search)
  return extra === '' ? `${pathname}?output` : `${pathname}?output&${extra}`
}
