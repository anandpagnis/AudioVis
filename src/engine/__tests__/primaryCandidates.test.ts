import { describe, expect, it } from 'vitest'
import { MOOD_STATES } from '../../audio/types'
import { getCompatibleScenes, SCENES } from '../../scenes'
import { selectPrimaryCandidates } from '../PerformanceDirector'

const PRIMARIES = SCENES.filter((s) => s.metadata.roles.includes('primary'))
const MOODS = MOOD_STATES.filter((m) => m !== 'silence')

/**
 * Regression coverage for the real "wireframe is always on" cause.
 *
 * The director used to intersect its primary pool with the current scene's
 * `compatibleWith`. Because the four original scenes list only each other,
 * {wireframe, plasma, dissolve, chrome} formed a CLOSED CLIQUE: once the show
 * entered it there was no edge back out, and the six newer primaries were
 * unreachable through this director entirely. 14 of 66 (scene, mood) pools
 * collapsed to exactly one candidate — wireframe — since it is the only
 * primary every other scene lists as compatible.
 */
describe('selectPrimaryCandidates', () => {
  it('reaches every primary scene across the mood range', () => {
    const reachable = new Set<string>()
    for (const mood of MOODS) {
      for (const from of SCENES) {
        for (const c of selectPrimaryCandidates(mood, from.id)) reachable.add(c.id)
      }
    }
    for (const p of PRIMARIES) expect([...reachable], p.id).toContain(p.id)
  })

  it('is not narrowed by the current scene compatibleWith', () => {
    // The specific pools that used to collapse to wireframe alone.
    for (const from of ['inversion', 'foldpath', 'torusfold', 'juliawings']) {
      const compatible = new Set(getCompatibleScenes(from).map((c) => c.id))
      const ids = selectPrimaryCandidates('peak', from).map((c) => c.id)
      expect(ids.length, `${from} @ peak`).toBeGreaterThan(1)
      // At least one candidate the old intersection would have excluded.
      expect(ids.some((id) => !compatible.has(id)), `${from} @ peak`).toBe(true)
    }
  })

  it('never offers the scene already showing, nor a non-primary scene', () => {
    for (const mood of MOODS) {
      for (const from of SCENES) {
        for (const c of selectPrimaryCandidates(mood, from.id)) {
          expect(c.id, `${from.id} @ ${mood}`).not.toBe(from.id)
          expect(c.metadata.roles, `${c.id} @ ${mood}`).toContain('primary')
        }
      }
    }
  })

  it('leaves no mood with a dead-end pool', () => {
    for (const mood of MOODS) {
      for (const from of SCENES) {
        expect(selectPrimaryCandidates(mood, from.id).length, `${from.id} @ ${mood}`).toBeGreaterThan(
          0,
        )
      }
    }
  })
})
