import { describe, expect, it } from 'vitest'
import { MOOD_PALETTES } from '../AutoPilot'
import { PALETTES } from '../palettes'

/**
 * The wiring between `palettes.ts` and the mood table that indexes it.
 *
 * This exists because that link silently rotted: 30 palettes were defined and
 * 6 were named, so 24 of them — 80% of the file — could never be selected by
 * the running show (F125). Nothing failed, nothing warned; the auto-pilot just
 * quietly drew from a fifth of the available colour.
 */
describe('palette coverage', () => {
  const named = new Set(Object.values(MOOD_PALETTES).flat())

  it('every defined palette is reachable from at least one mood', () => {
    // The guarantee that stops palette 31 being stranded the way these were.
    const stranded = PALETTES.filter((p) => !named.has(p.id)).map((p) => p.id)
    expect(stranded).toEqual([])
  })

  it('every mood names only palettes that exist', () => {
    // The other direction: a typo or a renamed palette would be filtered out
    // silently by pickPalette's `valid` guard, shrinking a pool with no signal.
    const ids = new Set(PALETTES.map((p) => p.id))
    const bogus = [...named].filter((id) => !ids.has(id))
    expect(bogus).toEqual([])
  })

  it('gives every audible mood a pool wide enough to rotate', () => {
    // `silence` is empty on purpose — nothing is playing, so nothing recolours.
    // Every other mood needs enough that excluding `current` and `lastPick`
    // still leaves a real choice rather than a forced alternation.
    for (const [mood, pool] of Object.entries(MOOD_PALETTES)) {
      if (mood === 'silence') continue
      expect(pool.length, `${mood} pool`).toBeGreaterThanOrEqual(4)
    }
  })

  it('keeps the rainbow family out of the quiet moods', () => {
    // A palette whose lit slots span distant hues reads as busy. Letting one
    // into `ambient` or `mellow` would undo the mood distinction the table is
    // for — the pools would differ in name only.
    const rainbow = PALETTES.filter((p) => p.family === 'rainbow').map((p) => p.id)
    for (const quiet of ['ambient', 'mellow'] as const) {
      for (const id of rainbow) expect(MOOD_PALETTES[quiet]).not.toContain(id)
    }
  })
})
