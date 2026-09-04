import { describe, expect, it } from 'vitest'
import { MOOD_STATES } from '../../audio/types'
import {
  DISABLED_FILTERS,
  FILTER_COOLDOWN_SEC,
  FILTER_MOOD_STYLES,
  filterUnusableReason,
  ISF_FILTERS,
  isFilterSelectable,
  selectableFilters,
} from '../isfFilterRoster'

const EXPECTED_IDS = [
  'Bad TV',
  'Broken LCD',
  'Bump Distortion',
  'CMYK Halftone',
  'Color Invert',
  'Dither-Bayer',
  'JPEG Block Corruption',
  'Pixel Shifter',
  'Ripples',
]

describe('ISF_FILTERS', () => {
  it('compiles exactly the nine vendored filters, with the expected ids', () => {
    expect(ISF_FILTERS).toHaveLength(9)
    expect(ISF_FILTERS.map((f) => f.id).sort()).toEqual([...EXPECTED_IDS].sort())
  })

  it('carries every filter’s CREDIT through, since Credits.tsx reads this array for attribution', () => {
    for (const filter of ISF_FILTERS) {
      expect(filter.credit, `${filter.id} should have a credit`).toBeTruthy()
    }
  })
})

/**
 * Two different reasons a filter can be out of the rotation, and they are not
 * interchangeable — see the roster's own notes on each.
 *
 * `Color Invert` is DISABLED: a taste call, still firable by hand, and it
 * looks like what its author intended when it is.
 *
 * `Broken LCD` is UNUSABLE: negative fbm sums reach `pow()`, which is
 * undefined for a negative base in GLSL, and the resulting NaN collapses to
 * "replace this pixel with a mostly-black pattern" — it blacks out the show.
 * Nobody may fire it, by hand or otherwise, so it fails `isFilterSelectable`
 * for a reason the predicate alone cannot express.
 */
const OUT_OF_ROTATION = ['Color Invert', 'Broken LCD']

describe('DISABLED_FILTERS / isFilterSelectable', () => {
  it('disables Color Invert on taste, and says so with DISABLED_FILTERS', () => {
    expect(isFilterSelectable('Color Invert')).toBe(false)
    expect(DISABLED_FILTERS).toContain('Color Invert')
    // Not a platform failure — nothing should claim it is.
    expect(filterUnusableReason('Color Invert')).toBeUndefined()
  })

  it('refuses Broken LCD as UNUSABLE, which is a different state from disabled', () => {
    expect(isFilterSelectable('Broken LCD')).toBe(false)
    // The distinction is load-bearing: the pickers offer a hand fire for a
    // disabled filter and must not for this one, and they tell them apart by
    // asking for a reason rather than by name.
    expect(DISABLED_FILTERS).not.toContain('Broken LCD')
    expect(filterUnusableReason('Broken LCD')).toBeTruthy()
  })

  it('leaves every other filter selectable', () => {
    for (const id of EXPECTED_IDS.filter((id) => !OUT_OF_ROTATION.includes(id))) {
      expect(isFilterSelectable(id), id).toBe(true)
      expect(filterUnusableReason(id), id).toBeUndefined()
    }
  })
})

describe('selectableFilters', () => {
  it('excludes both out-of-rotation filters but keeps the rest', () => {
    const ids = selectableFilters().map((f) => f.id)
    for (const id of OUT_OF_ROTATION) expect(ids).not.toContain(id)
    expect(ids.sort()).toEqual(EXPECTED_IDS.filter((id) => !OUT_OF_ROTATION.includes(id)).sort())
  })
})

describe('FILTER_MOOD_STYLES', () => {
  it('has an entry for every MoodState', () => {
    for (const mood of MOOD_STATES) {
      expect(FILTER_MOOD_STYLES[mood], mood).toBeDefined()
    }
  })

  it('only ever references ids that exist in ISF_FILTERS', () => {
    const knownIds = new Set(ISF_FILTERS.map((f) => f.id))
    for (const mood of MOOD_STATES) {
      for (const id of FILTER_MOOD_STYLES[mood]) {
        expect(knownIds.has(id), `${mood} -> ${id}`).toBe(true)
      }
    }
  })

  it('maps silence to no filters, matching EffectDirector’s silence posture', () => {
    expect(FILTER_MOOD_STYLES.silence).toEqual([])
  })

  it('lists Color Invert only under peak and aggressive', () => {
    for (const mood of MOOD_STATES) {
      const hasInvert = FILTER_MOOD_STYLES[mood].includes('Color Invert')
      if (mood === 'peak' || mood === 'aggressive') {
        expect(hasInvert, mood).toBe(true)
      } else {
        expect(hasInvert, mood).toBe(false)
      }
    }
  })

  it('caps every mood at four entries, so the rotation pool stays curated', () => {
    for (const mood of MOOD_STATES) {
      expect(FILTER_MOOD_STYLES[mood].length, mood).toBeLessThanOrEqual(4)
    }
  })

  it('gives every second-wave filter real presence — at least two moods each', () => {
    const secondWave = ['Dither-Bayer', 'JPEG Block Corruption', 'Pixel Shifter', 'Ripples']
    for (const id of secondWave) {
      const moodCount = MOOD_STATES.filter((mood) => FILTER_MOOD_STYLES[mood].includes(id)).length
      expect(moodCount, id).toBeGreaterThanOrEqual(2)
    }
  })

  it('never places a warp/movement filter in ambient, mellow or silence except the ones judged gentle enough', () => {
    // Bump Distortion and Pixel Shifter are punchier movement than Ripples'
    // sinusoidal ease — see the doc comment above for why Ripples alone
    // crosses into `mellow`.
    for (const mood of ['silence', 'ambient'] as const) {
      expect(FILTER_MOOD_STYLES[mood]).not.toContain('Bump Distortion')
      expect(FILTER_MOOD_STYLES[mood]).not.toContain('Pixel Shifter')
      expect(FILTER_MOOD_STYLES[mood]).not.toContain('Ripples')
    }
    expect(FILTER_MOOD_STYLES.mellow).not.toContain('Bump Distortion')
    expect(FILTER_MOOD_STYLES.mellow).not.toContain('Pixel Shifter')
  })
})

describe('FILTER_COOLDOWN_SEC', () => {
  it('is a single positive constant in a sane range for a flourish cooldown', () => {
    expect(FILTER_COOLDOWN_SEC).toBeGreaterThan(0)
    expect(FILTER_COOLDOWN_SEC).toBeLessThanOrEqual(30)
  })
})
