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

  it('never returns a layer-only scene as a primary', () => {
    // The regression this guards was first found via ribbons, which held the
    // top moodFit in five moods while being accent/overlay-only — so the
    // UNFILTERED top pick was an invalid primary.
    //
    // Deliberately no longer asserted through ribbons' scores. Those are art
    // direction and have already moved once (0.92-0.98 -> 0.64-0.72, to stop it
    // dominating the layer slots); a test that depends on a scene staying
    // top-ranked breaks on a tuning change and says nothing about the filter.
    // The invariant is what matters, so it is checked across the whole roster.
    const layerOnly = SCENES.filter(
      (s) => !s.metadata.roles.includes('primary') && s.metadata.roles.length > 0,
    )
    expect(layerOnly.length, 'roster has no layer-only scene to check').toBeGreaterThan(0)
    for (const scene of layerOnly) {
      for (const mood of scene.metadata.moods) {
        expect(
          getScenesForMood(mood, 'primary').map((s) => s.id),
          `${scene.id} @ ${mood}`,
        ).not.toContain(scene.id)
      }
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
