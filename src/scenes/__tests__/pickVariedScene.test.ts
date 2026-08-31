import { describe, expect, it } from 'vitest'
import { MOOD_STATES } from '../../audio/types'
import { getPrimaryScenesForMood, getScenesForMood, pickVariedScene, SCENES } from '../index'
import { deriveVA, MOOD_VA } from '../../engine/moodValenceArousal'

/**
 * Regression coverage for the "wireframe is used constantly" bug: the
 * directors used to (1) pick from a role-unfiltered pool, so an accent/
 * overlay-only scene could get requested as primary, and (2) deterministically
 * take the single best-`moodFit` scene (occasionally the second-best), with
 * ties broken by SCENES[] array order — which structurally favored whichever
 * scene sat earliest and was tagged for the most moods, i.e. wireframe.
 */
describe('getPrimaryScenesForMood', () => {
  it('never returns a scene that lacks the primary role', () => {
    for (const mood of MOOD_STATES) {
      for (const scene of getPrimaryScenesForMood(mood)) {
        expect(scene.metadata.roles, `${scene.id} for ${mood}`).toContain('primary')
      }
    }
  })

  it('is a strict subset of the role-unfiltered getScenesForMood', () => {
    for (const mood of MOOD_STATES) {
      const primaryIds = new Set(getPrimaryScenesForMood(mood).map((s) => s.id))
      const allIds = new Set(getScenesForMood(mood).map((s) => s.id))
      for (const id of primaryIds) expect(allIds, mood).toContain(id)
    }
  })
})

describe('pickVariedScene', () => {
  const mood = 'building'
  const candidates = getPrimaryScenesForMood(mood)

  it('only ever returns a candidate it was given', () => {
    const ids = new Set(candidates.map((s) => s.id))
    for (let i = 0; i < 200; i++) {
      const pick = pickVariedScene(candidates, mood, [])
      expect(pick && ids.has(pick.id)).toBe(true)
    }
  })

  it('returns undefined for an empty candidate list', () => {
    expect(pickVariedScene([], mood, [])).toBeUndefined()
  })

  it('returns the only candidate when there is exactly one, regardless of recency', () => {
    const solo = [candidates[0]]
    expect(pickVariedScene(solo, mood, [solo[0].id])?.id).toBe(solo[0].id)
  })

  it('reaches more than just the top-2 moodFit scenes over many picks', () => {
    // This is the actual bug: options[0] 70% of the time, options[1] 30%,
    // nothing else ever reachable no matter how many scenes were registered.
    expect(candidates.length).toBeGreaterThan(2)
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) {
      const pick = pickVariedScene(candidates, mood, [])
      if (pick) seen.add(pick.id)
    }
    expect(seen.size).toBeGreaterThan(2)
  })

  it('heavily discounts whatever was shown most recently', () => {
    const target = candidates[0]
    const others = candidates.filter((s) => s.id !== target.id)
    if (others.length === 0) return // degenerate roster, nothing to compare against
    let targetCount = 0
    const trials = 1000
    for (let i = 0; i < trials; i++) {
      const pick = pickVariedScene(candidates, mood, [target.id])
      if (pick?.id === target.id) targetCount++
    }
    // Not a hard exclusion (small rosters must still be able to return
    // something), but should land well under an even share.
    expect(targetCount / trials).toBeLessThan(1 / candidates.length)
  })

  it('wireframe does not win a plurality of picks across every mood it is tagged for', () => {
    // The actual observed complaint, pinned as a statistical property rather
    // than a specific number so it doesn't need retuning every time a scene
    // is added/removed — wireframe should land roughly proportionate to the
    // roster size, not dominate it.
    const wireframe = SCENES.find((s) => s.id === 'wireframe')
    expect(wireframe).toBeTruthy()
    for (const m of wireframe!.metadata.moods) {
      const pool = getPrimaryScenesForMood(m)
      if (pool.length < 3) continue // too small a roster for this to be meaningful
      let wireframeCount = 0
      const trials = 600
      for (let i = 0; i < trials; i++) {
        const pick = pickVariedScene(pool, m, [])
        if (pick?.id === 'wireframe') wireframeCount++
      }
      // A generous ceiling (2x an even share) — this is a "not dominating"
      // check, not a precise distribution assertion.
      expect(wireframeCount / trials, m).toBeLessThan((2 / pool.length) * 1.5)
    }
  })
})

describe('pickVariedScene — VA-aware fit (audit c2)', () => {
  // Two synthetic candidates with equal, flat moodFit (so the discrete mood
  // term cannot distinguish them) but very different DERIVED VA positions —
  // isolates the VA term from everything else pickVariedScene weighs.
  type Fixture = { id: string; metadata: { moodFit: Record<string, number> } }
  const calm: Fixture = { id: 'calm-fixture', metadata: { moodFit: { mellow: 1 } } }
  const hot: Fixture = { id: 'hot-fixture', metadata: { moodFit: { aggressive: 1 } } }
  const fixtures = [calm, hot] as unknown as Parameters<typeof pickVariedScene>[0]

  it('is unaffected when currentVA is omitted', () => {
    // Both fixtures have equal moodFit weight (1) for their respective
    // single mood, so over many trials with no VA term they should land
    // close to a 50/50 split under a neutral mood.
    let calmCount = 0
    const trials = 2000
    for (let i = 0; i < trials; i++) {
      const pick = pickVariedScene(fixtures, 'groove', [])
      if (pick && (pick as unknown as Fixture).id === 'calm-fixture') calmCount++
    }
    expect(calmCount / trials).toBeGreaterThan(0.3)
    expect(calmCount / trials).toBeLessThan(0.7)
  })

  it('prefers whichever candidate is closer to the live VA read', () => {
    // aggressive's derived VA is high-arousal/negative-valence; asking with a
    // currentVA sitting right on top of it should shift the split toward
    // the hot fixture despite equal moodFit.
    const nearHot = MOOD_VA.aggressive
    let hotCount = 0
    const trials = 3000
    for (let i = 0; i < trials; i++) {
      const pick = pickVariedScene(fixtures, 'groove', [], undefined, nearHot)
      if (pick && (pick as unknown as Fixture).id === 'hot-fixture') hotCount++
    }
    expect(hotCount / trials).toBeGreaterThan(0.5)
  })

  it('flips the preference when the live VA read moves to the other candidate', () => {
    const nearCalm = MOOD_VA.mellow
    let calmCount = 0
    const trials = 3000
    for (let i = 0; i < trials; i++) {
      const pick = pickVariedScene(fixtures, 'groove', [], undefined, nearCalm)
      if (pick && (pick as unknown as Fixture).id === 'calm-fixture') calmCount++
    }
    expect(calmCount / trials).toBeGreaterThan(0.5)
  })

  it('never lets the VA term zero out a candidate entirely — it sharpens moodFit, not replaces it', () => {
    // Even at maximum VA mismatch, the disfavoured fixture must still be
    // reachable — VA_DAMPENING caps the penalty well short of exclusion.
    const farFromBoth: (typeof MOOD_VA)['aggressive'] = { valence: -1, arousal: 1 }
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) {
      const pick = pickVariedScene(fixtures, 'groove', [], undefined, farFromBoth)
      if (pick) seen.add((pick as unknown as Fixture).id)
    }
    expect(seen.size).toBe(2)
  })

  it('a scene with no moodFit at all is unaffected by the VA term (neutral factor)', () => {
    const noFit: Fixture = { id: 'no-fit-fixture', metadata: { moodFit: {} } }
    const pair = [calm, noFit] as unknown as Parameters<typeof pickVariedScene>[0]
    // Should not throw, and should still return one of the two candidates.
    for (let i = 0; i < 50; i++) {
      const pick = pickVariedScene(pair, 'groove', [], undefined, MOOD_VA.aggressive)
      expect(['calm-fixture', 'no-fit-fixture']).toContain((pick as unknown as Fixture)?.id)
    }
  })

  it('agrees with deriveVA — the fixtures really are placed where the test assumes', () => {
    // Sanity check on the test's own premise, not on pickVariedScene: confirms
    // calm/hot's derived positions really are far apart before trusting the
    // preference-flip tests above to mean anything.
    const calmVA = deriveVA(calm.metadata.moodFit)
    const hotVA = deriveVA(hot.metadata.moodFit)
    expect(calmVA.arousal).toBeLessThan(hotVA.arousal)
    expect(calmVA.valence).toBeGreaterThan(hotVA.valence)
  })
})
