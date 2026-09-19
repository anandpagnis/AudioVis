import { afterEach, describe, expect, it } from 'vitest'
import type { MoodState } from '../../audio/types'
import { MOOD_STATES } from '../../audio/types'
import {
  FREE_TIER_SCENE_IDS,
  SCENES,
  commerciallyShippableScenes,
  getScenesForMood,
  nonCommercialSceneIds,
  setSceneWhitelist,
} from '../index'

/**
 * getScenesForMood with no whitelist applied, reconstructed independently
 * (not by calling the function with a null whitelist, which is itself under
 * test below) so these tests don't validate the implementation against
 * itself.
 */
function unrestrictedIds(mood: MoodState): string[] {
  return SCENES.filter((s) => s.metadata.moods.includes(mood))
    .sort((a, b) => (b.metadata.moodFit?.[mood] ?? 0.5) - (a.metadata.moodFit?.[mood] ?? 0.5))
    .map((s) => s.id)
}

describe('FREE_TIER_SCENE_IDS', () => {
  it('is a non-empty subset of commerciallyShippableScenes(), never a non-commercial id', () => {
    // The free/anonymous demo must never end up showing a scene the licensing
    // gate (F01, see nonCommercialSceneIds's own doc) would exclude from a
    // commercial build — that gate exists independently of any subscription
    // and this must never be able to override it.
    const shippable = new Set(commerciallyShippableScenes().map((s) => s.id))
    const blocked = new Set(nonCommercialSceneIds())
    expect(FREE_TIER_SCENE_IDS.length).toBeGreaterThan(0)
    for (const id of FREE_TIER_SCENE_IDS) {
      expect(shippable.has(id), id).toBe(true)
      expect(blocked.has(id), id).toBe(false)
    }
  })
})

describe('setSceneWhitelist / getScenesForMood', () => {
  afterEach(() => setSceneWhitelist(null))

  it('is a no-op when null, the default — every existing caller (AutoPilot, PerformanceDirector) is unaffected', () => {
    for (const mood of MOOD_STATES) {
      expect(getScenesForMood(mood).map((s) => s.id)).toEqual(unrestrictedIds(mood))
    }
  })

  it('restricts candidates to the whitelist for a mood the whitelist actually fits', () => {
    const target = MOOD_STATES.find((mood) =>
      unrestrictedIds(mood).some((id) => FREE_TIER_SCENE_IDS.includes(id)),
    )
    expect(target, 'at least one mood must exercise this for the test to mean anything').toBeDefined()
    setSceneWhitelist(FREE_TIER_SCENE_IDS)
    const restricted = getScenesForMood(target as MoodState)
    expect(restricted.length).toBeGreaterThan(0)
    for (const s of restricted) expect(FREE_TIER_SCENE_IDS).toContain(s.id)
  })

  it('falls back to the unfiltered pool, rather than starving the autopilot, when nothing matches', () => {
    setSceneWhitelist(['no-such-scene-id'])
    const moodWithCandidates = MOOD_STATES.find((mood) => unrestrictedIds(mood).length > 0)
    expect(moodWithCandidates).toBeDefined()
    expect(getScenesForMood(moodWithCandidates as MoodState).map((s) => s.id)).toEqual(
      unrestrictedIds(moodWithCandidates as MoodState),
    )
  })
})
