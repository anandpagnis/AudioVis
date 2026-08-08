import { describe, expect, it } from 'vitest'
import { MOOD_STATES } from '../../audio/types'
import { SCENES, getScenesForMood } from '../index'

/**
 * A scene's `roles` are a contract about where it may be mounted. The autonomy
 * directors pick primaries out of `getScenesForMood()`, which used to ignore
 * roles entirely — so a layer-only scene could be installed as the subject.
 */
describe('getScenesForMood role filtering', () => {
  it('excludes layer-only scenes when asked for primaries', () => {
    for (const mood of MOOD_STATES) {
      for (const scene of getScenesForMood(mood, 'primary')) {
        expect(scene.metadata.roles).toContain('primary')
      }
    }
  })

  it('still returns layer-only scenes when no role is requested', () => {
    const layerOnly = SCENES.filter((s) => !s.metadata.roles.includes('primary'))
    expect(layerOnly.length).toBeGreaterThan(0)
    const anyMoodOfLayerOnly = layerOnly[0].metadata.moods[0]
    const unfiltered = getScenesForMood(anyMoodOfLayerOnly).map((s) => s.id)
    expect(unfiltered).toContain(layerOnly[0].id)
  })

  it('would have picked a layer-only scene without the filter', () => {
    // Guards the specific regression: ribbons is accent/overlay-only yet holds
    // the top moodFit in several moods, so the unfiltered top pick is invalid.
    const ribbons = SCENES.find((s) => s.id === 'ribbons')
    expect(ribbons).toBeDefined()
    expect(ribbons!.metadata.roles).not.toContain('primary')
    const offending = ribbons!.metadata.moods.filter(
      (m) => getScenesForMood(m)[0]?.id === 'ribbons',
    )
    expect(offending.length).toBeGreaterThan(0)
    // ...and with the filter it is never the top primary for those moods.
    for (const m of offending) {
      expect(getScenesForMood(m, 'primary')[0]?.id).not.toBe('ribbons')
    }
  })

  it('leaves every mood with at least one primary-capable scene', () => {
    // If this ever fails the directors would silently stop switching scenes.
    for (const mood of MOOD_STATES) {
      if (mood === 'silence') continue // no scene declares 'silence'
      expect(getScenesForMood(mood, 'primary').length).toBeGreaterThan(0)
    }
  })

  it('preserves moodFit ordering within the filtered pool', () => {
    for (const mood of MOOD_STATES) {
      const fits = getScenesForMood(mood, 'primary').map((s) => s.metadata.moodFit?.[mood] ?? 0.5)
      for (let i = 1; i < fits.length; i++) expect(fits[i - 1]).toBeGreaterThanOrEqual(fits[i])
    }
  })
})
