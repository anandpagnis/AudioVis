import { describe, expect, it } from 'vitest'
import { MOOD_STATES } from '../../audio/types'
import { SCENES, getResolvedManifest, getScene, getScenesForMood } from '../index'

/**
 * Registry integrity. Every failure here is the kind that regresses invisibly:
 * a dangling id or an uncovered mood still compiles, still renders, and only
 * shows up as a scene that silently never gets picked — or a crash deep in a
 * lazy import long after the mistake was made.
 */
describe('scene registry', () => {
  it('every compatibleWith id refers to a registered scene', () => {
    const ids = new Set(SCENES.map((s) => s.id))
    for (const scene of SCENES) {
      for (const id of scene.metadata.compatibleWith) {
        expect(ids, `${scene.id}.compatibleWith references unregistered "${id}"`).toContain(id)
      }
    }
  })

  it('no scene lists itself as compatible with itself', () => {
    for (const scene of SCENES) {
      expect(scene.metadata.compatibleWith, scene.id).not.toContain(scene.id)
    }
  })

  it('scene ids are unique', () => {
    const ids = SCENES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every mood a scene claims is a real mood state', () => {
    for (const scene of SCENES) {
      for (const mood of scene.metadata.moods) {
        expect(MOOD_STATES, `${scene.id} claims unknown mood "${mood}"`).toContain(mood)
      }
    }
  })

  it('every non-silence mood has at least one PRIMARY-capable scene', () => {
    // The directors pick a primary per mood. A mood with no primary-capable
    // scene leaves them with an empty pool and the show stuck on whatever was
    // already on screen — which looks like "automation stopped working",
    // nowhere near the roles array that actually caused it.
    for (const mood of MOOD_STATES) {
      if (mood === 'silence') continue
      const primaries = getScenesForMood(mood).filter((s) => s.metadata.roles.includes('primary'))
      expect(primaries.length, `mood "${mood}" has no primary-capable scene`).toBeGreaterThan(0)
    }
  })

  it('moodFit only scores moods the scene actually claims', () => {
    for (const scene of SCENES) {
      for (const mood of Object.keys(scene.metadata.moodFit ?? {})) {
        expect(
          scene.metadata.moods,
          `${scene.id} scores moodFit for "${mood}" but does not list it in moods`,
        ).toContain(mood)
      }
    }
  })

  it('getScene falls back to SCENES[0] for an unknown id', () => {
    // Load-bearing: a stale persisted sceneId, preset, cue or ?scene= param
    // must degrade to a working scene rather than throw.
    expect(getScene('does-not-exist')).toBe(SCENES[0])
    expect(SCENES[0].metadata.roles).toContain('primary')
  })

  it('every scene resolves a streaming manifest', () => {
    for (const scene of SCENES) {
      const manifest = getResolvedManifest(scene.id)
      expect(manifest.cost.vramMB, scene.id).toBeGreaterThan(0)
      expect(manifest.estPreloadMs, scene.id).toBeGreaterThan(0)
    }
  })
})
