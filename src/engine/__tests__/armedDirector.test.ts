import { beforeEach, describe, expect, it, vi } from 'vitest'

// Only the lazy-chunk fetch is stubbed (it would import a real scene module in node); the real registry still
// answers `getCharacterCandidates` and `canHoldPrimary`.
vi.mock('../../scenes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scenes')>()),
  preloadScene: vi.fn(),
}))

import { createEmptyFeatures, type AudioFeatures } from '../../audio/types'
import { createEmptyCharacterState } from '../../audio/characterTypes'
import { getCharacterCandidates } from '../../scenes'
import { SCENE_CHARACTER } from '../../scenes/character'
import { useStore } from '../../store'
import { ARM, armPlaced, createArmedState } from '../armedChange'
import { armedFitNow, armedRuntime, armReason, pickArmScene, tryCommitArmed } from '../armedDirector'

const st = () => useStore.getState()

function features(over: Partial<AudioFeatures> = {}): AudioFeatures {
  const f = createEmptyFeatures()
  f.beatIndex = 200
  f.time = 100
  f.confidence = 0
  f.character = {
    ...createEmptyCharacterState(),
    valid: true,
    primary: 'groove',
    valence: 0.5,
    arousal: 0.5,
    tension: 0.4,
    pulse: 0.5,
  }
  return Object.assign(f, over)
}

function resetStore() {
  useStore.setState({
    sceneId: 'wireframe',
    pendingSceneId: null,
    pendingImmediate: false,
    heldSceneId: null,
    lastCommitBeat: -Infinity,
    recentSceneIds: [],
  })
}

/** The primary-capable scene that fits `f` best, by the same score the director uses. */
function bestFor(f: AudioFeatures): string {
  let best = ''
  let bestFit = -1
  for (const sc of getCharacterCandidates()) {
    if (sc.id === st().sceneId) continue
    const { armed } = armedFitNow(f, st(), sc.id)
    if (armed > bestFit) {
      bestFit = armed
      best = sc.id
    }
  }
  return best
}

/** Put `id` in the store as the held scene and in the armed state, as `AutoPilot` does after `armScene`. */
function arm(id: string, f: AudioFeatures) {
  expect(st().armScene(id)).toBe(true)
  armedRuntime.state = createArmedState()
  armPlaced(armedRuntime.state, id, null, f.beatIndex - 10, -1, 'test')
}

beforeEach(() => {
  resetStore()
  armedRuntime.state = createArmedState()
})

describe('tryCommitArmed', () => {
  it('does nothing when nothing is armed', () => {
    expect(tryCommitArmed('mood', false, features())).toBe(false)
  })

  it('releases the held scene when it still fits and the dwell has elapsed, and records who released it', () => {
    const f = features()
    const id = bestFor(f)
    arm(id, f)
    expect(tryCommitArmed('mood', false, f)).toBe(true)
    expect(st().heldSceneId).toBeNull()
    expect(st().pendingSceneId).toBe(id) // still pending: SceneManager commits it on the next downbeat
    expect(st().pendingImmediate).toBe(false)
    expect(armedRuntime.state.armed).toBeNull()
    expect(armedRuntime.state.lastOutcome).toBe(`mood@b${f.beatIndex}`)
  })

  it('an immediate release cuts now', () => {
    const f = features()
    const id = bestFor(f)
    arm(id, f)
    expect(tryCommitArmed('boundary', true, f)).toBe(true)
    expect(st().pendingImmediate).toBe(true)
    expect(armedRuntime.state.lastOutcome).toBe(`boundary@b${f.beatIndex}`)
  })

  it('respects the 32-beat dwell for a normal release, but not for an immediate one', () => {
    const f = features()
    const id = bestFor(f)
    arm(id, f)
    useStore.setState({ lastCommitBeat: f.beatIndex - 5 })
    expect(tryCommitArmed('mood', false, f)).toBe(false)
    expect(st().heldSceneId).toBe(id) // still held, still armed
    expect(armedRuntime.state.armed).not.toBeNull()
    expect(tryCommitArmed('mood', true, f)).toBe(true)
  })

  it('refuses a scene that no longer fits the music, so the director picks a fresh one instead', () => {
    // Arm the CALMEST scene, then let the music turn hot.
    const calmest = getCharacterCandidates()
      .map((s) => s.id)
      .sort((a, b) => SCENE_CHARACTER[a].arousal - SCENE_CHARACTER[b].arousal)[0]
    const calmF = features({ character: { ...features().character, arousal: 0.1, tension: 0.1 } })
    arm(calmest, calmF)
    const hot = features({
      buildUp: true,
      character: { ...features().character, arousal: 0.95, tension: 0.85 },
    })
    const fit = armedFitNow(hot, st(), calmest)
    expect(fit.ok).toBe(false)
    expect(fit.armed).toBeLessThan(ARM.refitRatio * fit.best)
    expect(tryCommitArmed('mood', false, hot)).toBe(false)
    expect(st().heldSceneId).toBe(calmest) // untouched: the director's own request will replace it
  })

  it('refuses when the store no longer holds the armed scene (someone replaced it)', () => {
    const f = features()
    const id = bestFor(f)
    arm(id, f)
    useStore.setState({ heldSceneId: null })
    expect(tryCommitArmed('mood', false, f)).toBe(false)
    useStore.setState({ heldSceneId: id, pendingSceneId: 'plasma' })
    expect(tryCommitArmed('mood', false, f)).toBe(false)
  })

  it('can only release once', () => {
    const f = features()
    arm(bestFor(f), f)
    expect(tryCommitArmed('mood', false, f)).toBe(true)
    expect(tryCommitArmed('mood', false, f)).toBe(false)
  })
})

describe('pickArmScene', () => {
  it('always returns a primary-capable scene that is not on screen, whatever the character read', () => {
    const primaries = new Set(getCharacterCandidates().map((s) => s.id))
    for (const valid of [true, false]) {
      const f = features({ character: { ...features().character, valid } })
      for (let i = 0; i < 30; i++) {
        const s = pickArmScene(f, st())
        expect(s, `valid=${valid}`).not.toBeNull()
        expect(primaries.has(s!.id)).toBe(true)
        expect(s!.id).not.toBe(st().sceneId)
      }
    }
  })

  it('skips refused ids', () => {
    const f = features()
    const first = pickArmScene(f, st())!
    for (let i = 0; i < 20; i++) expect(pickArmScene(f, st(), [first.id])!.id).not.toBe(first.id)
  })

  it('a rising DSP trend arms hotter scenes than a falling one', () => {
    const mean = (over: Partial<AudioFeatures>) => {
      let sum = 0
      for (let i = 0; i < 80; i++) sum += SCENE_CHARACTER[pickArmScene(features(over), st())!.id].arousal
      return sum / 80
    }
    const rising = mean({ buildUp: true })
    const falling = mean({ mood: { ...features().mood, isDecaying: true } })
    expect(rising).toBeGreaterThan(falling)
  })

  it('explains itself in a short, NaN-free reason', () => {
    const f = features({ buildUp: true })
    const r = armReason(f, st(), pickArmScene(f, st())!.id)
    expect(r).toMatch(/^rise /)
    expect(r).not.toMatch(/NaN/)
  })
})
