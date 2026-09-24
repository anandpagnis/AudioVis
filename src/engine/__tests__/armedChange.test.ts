import { describe, expect, it } from 'vitest'
import {
  ARM,
  armPlaced,
  armRefused,
  createArmedState,
  dropPickSuppressed,
  stepArmed,
  type ArmedAction,
  type ArmedInput,
  type ArmedState,
} from '../armedChange'

/** A quiet, valid mid-build frame with nothing armed; override what a case cares about. */
function inp(over: Partial<ArmedInput> = {}): ArmedInput {
  return {
    enabled: true,
    suppressed: false,
    silent: false,
    tier: 0,
    beat: 100,
    sustain: true,
    buildEdge: false,
    dropEdge: false,
    beatsTillDrop: -1,
    pendingSceneId: null,
    heldSceneId: null,
    sceneId: 'wireframe',
    canDwell: true,
    ...over,
  }
}

/** The store's view of a scene held for the drop, for the frames after `armPlaced`. */
const held = (id = 'kifs'): Partial<ArmedInput> => ({ pendingSceneId: id, heldSceneId: id })

/** Step to an armed state at `beat`: the arm action, then the caller placing the scene. */
function armedAt(beat = 100, beatsTillDrop = -1, id = 'kifs'): ArmedState {
  const st = createArmedState()
  expect(stepArmed(st, inp({ beat, beatsTillDrop }))).toEqual({ type: 'arm' })
  armPlaced(st, id, null, beat, beatsTillDrop)
  return st
}

const types = (actions: ArmedAction[]) => actions.map((a) => a.type)

describe('stepArmed: arming', () => {
  it('arms on a sustained build, but never on the rising-edge frame (that frame belongs to the build switch)', () => {
    const st = createArmedState()
    expect(stepArmed(st, inp({ buildEdge: true })).type).toBe('none')
    expect(stepArmed(st, inp({ beat: 101 }))).toEqual({ type: 'arm' })
  })

  it.each([
    ['the feature is off', { enabled: false }],
    ['automation is suppressed', { suppressed: true }],
    ['the music is silent', { silent: true }],
    ['the quality tier is too high', { tier: ARM.maxTier + 1 }],
    ['there is no confirmed build', { sustain: false }],
    ['a scene is already pending', { pendingSceneId: 'plasma' }],
    ['a drop lands this very frame', { dropEdge: true }],
  ] as [string, Partial<ArmedInput>][])('does not arm when %s', (_why, over) => {
    const st = createArmedState()
    expect(stepArmed(st, inp(over)).type).toBe('none')
  })

  it('arms at the highest tier that is still allowed, and not one above it', () => {
    expect(stepArmed(createArmedState(), inp({ tier: ARM.maxTier })).type).toBe('arm')
    expect(stepArmed(createArmedState(), inp({ tier: ARM.maxTier + 1 })).type).toBe('none')
  })

  it('does not require the dwell floor: arming is only a hold', () => {
    expect(stepArmed(createArmedState(), inp({ canDwell: false })).type).toBe('arm')
  })

  it('never double-arms: once armed, no frame returns another arm', () => {
    const st = armedAt(100)
    const seen: ArmedAction[] = []
    for (let b = 101; b < 100 + ARM.expiryBeats - 1; b++) seen.push(stepArmed(st, inp({ beat: b, ...held() })))
    expect(seen.some((a) => a.type === 'arm')).toBe(false)
  })

  it('attempts a build once: a refused arm is not retried every frame', () => {
    const st = createArmedState()
    expect(stepArmed(st, inp()).type).toBe('arm')
    armRefused(st, 100)
    for (let b = 101; b < 140; b++) expect(stepArmed(st, inp({ beat: b })).type).toBe('none')
    expect(st.lastOutcome).toBe('refused@b100')
  })

  it('re-arms only for a NEW build: the old one must end first', () => {
    const st = armedAt(100)
    expect(stepArmed(st, inp({ beat: 104, dropEdge: true, ...held() })).type).toBe('confirm')
    // The build is still reported as sustained for a few frames after the drop: no re-arm.
    for (let b = 105; b < 110; b++) expect(stepArmed(st, inp({ beat: b })).type).toBe('none')
    // The build ends, then a new one starts.
    expect(stepArmed(st, inp({ beat: 110, sustain: false })).type).toBe('none')
    expect(stepArmed(st, inp({ beat: 150, buildEdge: true })).type).toBe('none')
    expect(stepArmed(st, inp({ beat: 151 })).type).toBe('arm')
  })

  it('records where the drop is projected when the arm is placed', () => {
    const st = armedAt(100, 12)
    expect(st.armed?.expectedBeat).toBe(112)
    expect(st.armed?.expiresAtBeat).toBe(100 + ARM.expiryBeats)
    expect(st.armed?.gate).toBe('hold')
    expect(armedAt(100, -1).armed?.expectedBeat).toBe(-1)
    expect(armedAt(100, NaN).armed?.expectedBeat).toBe(-1)
  })
})

describe('stepArmed: confirming on a drop', () => {
  it('a drop edge cuts to the armed scene NOW (immediate), and clears the record', () => {
    const st = armedAt(100)
    const a = stepArmed(st, inp({ beat: 110, dropEdge: true, ...held() }))
    expect(a).toEqual({ type: 'confirm', trigger: 'drop', immediate: true })
    expect(st.armed).toBeNull()
    expect(st.lastOutcome).toBe('drop@b110')
  })

  it('accepts a drop even the beat after arming, ignoring the minimum hold and the dwell floor', () => {
    const st = armedAt(100)
    const a = stepArmed(st, inp({ beat: 100, dropEdge: true, canDwell: false, ...held() }))
    expect(a).toMatchObject({ type: 'confirm', trigger: 'drop', immediate: true })
  })

  it('accepts a drop during silence (the pre-drop gap) and after the build flag has already dropped', () => {
    const st = armedAt(100)
    expect(stepArmed(st, inp({ beat: 108, dropEdge: true, silent: true, sustain: false, ...held() })).type).toBe('confirm')
  })

  it('does not suppress the normal drop pick after a real drop confirm (the caller handles that frame itself)', () => {
    const st = armedAt(100)
    stepArmed(st, inp({ beat: 108, dropEdge: true, ...held() }))
    expect(dropPickSuppressed(st, 108)).toBe(false)
  })
})

describe('stepArmed: confirming on the predicted drop', () => {
  const projectedAt = (beat: number) => ({ beat, beatsTillDrop: 112 - beat, ...held() })

  it('waits until one beat before the projected drop, then releases as a normal crossfade (not a hard cut)', () => {
    const st = armedAt(100, 12)
    const actions: ArmedAction[] = []
    for (let b = 101; b <= 111; b++) actions.push(stepArmed(st, inp(projectedAt(b))))
    expect(types(actions).slice(0, 9)).toEqual(Array(9).fill('none')) // beats 101..109
    expect(actions[10]).toEqual({ type: 'confirm', trigger: 'predicted', immediate: false }) // beat 111 = 112 - lead
    expect(st.lastOutcome).toBe('predicted@b111')
  })

  it('follows a re-projected drop: a later projection postpones the release', () => {
    const st = armedAt(100, 12)
    expect(stepArmed(st, inp({ beat: 105, beatsTillDrop: 20, ...held() })).type).toBe('none') // now b125
    expect(stepArmed(st, inp({ beat: 111, beatsTillDrop: 14, ...held() })).type).toBe('none') // now b125
    expect(stepArmed(st, inp({ beat: 124, beatsTillDrop: 1, ...held() })).type).toBe('confirm')
  })

  it('is refused inside the minimum hold after arming', () => {
    const st = armedAt(100, 2) // projected b102, lead reaches b101, but the arm is 1 beat old
    expect(stepArmed(st, inp({ beat: 101, beatsTillDrop: 1, ...held() })).type).toBe('none')
    expect(stepArmed(st, inp({ beat: 102, beatsTillDrop: -1, ...held() })).type).toBe('confirm')
  })

  it('is refused while the 32-beat dwell has not elapsed (enforced at confirm), yet a real drop still lands', () => {
    const st = armedAt(100, 12)
    for (let b = 101; b < 118; b++) {
      expect(stepArmed(st, inp({ ...projectedAt(b), canDwell: false })).type).toBe('none')
    }
    expect(stepArmed(st, inp({ beat: 118, dropEdge: true, canDwell: false, ...held() })).type).toBe('confirm')
  })

  it('is refused during silence and without a sustained build', () => {
    const st = armedAt(100, 12)
    expect(stepArmed(st, inp({ ...projectedAt(111), silent: true })).type).toBe('none')
    expect(stepArmed(st, inp({ ...projectedAt(111), sustain: false })).type).toBe('none') // build ended: no veto-free guess
  })

  it('needs a known projection: an unknown drop beat never releases on prediction', () => {
    const st = armedAt(100, -1)
    for (let b = 101; b < 125; b++) expect(stepArmed(st, inp({ beat: b, ...held() })).type).toBe('none')
  })

  it('suppresses the normal drop pick for a few beats afterwards, so a late real drop does not switch twice', () => {
    const st = armedAt(100, 12)
    stepArmed(st, inp(projectedAt(111)))
    expect(dropPickSuppressed(st, 111)).toBe(true)
    expect(dropPickSuppressed(st, 111 + ARM.dropSuppressBeats - 1)).toBe(true)
    expect(dropPickSuppressed(st, 111 + ARM.dropSuppressBeats)).toBe(false)
    expect(dropPickSuppressed(st, 105)).toBe(false) // before the commit
  })
})

describe('stepArmed: disarming', () => {
  it('expires after ARM.expiryBeats and gives the slot back', () => {
    const st = armedAt(100)
    expect(stepArmed(st, inp({ beat: 100 + ARM.expiryBeats - 1, ...held() })).type).toBe('none')
    expect(stepArmed(st, inp({ beat: 100 + ARM.expiryBeats, ...held() }))).toEqual({ type: 'disarm', reason: 'expired' })
    expect(st.armed).toBeNull()
  })

  it('gives up when the build ends without a drop, after the grace, but not for a one-beat flicker', () => {
    const st = armedAt(100)
    expect(stepArmed(st, inp({ beat: 110, sustain: false, ...held() })).type).toBe('none')
    expect(stepArmed(st, inp({ beat: 111, sustain: true, ...held() })).type).toBe('none') // flicker over
    expect(stepArmed(st, inp({ beat: 112, sustain: false, ...held() })).type).toBe('none')
    expect(stepArmed(st, inp({ beat: 113, sustain: false, ...held() })).type).toBe('none')
    expect(stepArmed(st, inp({ beat: 114, sustain: false, ...held() }))).toEqual({ type: 'disarm', reason: 'fizzle' })
  })

  it('a drop right after the build flag fell (inside the grace) still confirms instead of fizzling', () => {
    const st = armedAt(100)
    stepArmed(st, inp({ beat: 110, sustain: false, ...held() }))
    expect(stepArmed(st, inp({ beat: 111, sustain: false, dropEdge: true, ...held() })).type).toBe('confirm')
  })

  it.each([
    ['the feature is switched off', { enabled: false }, 'off'],
    ['automation becomes suppressed (manual hold, cue, cutaway)', { suppressed: true }, 'suppressed'],
    ['the quality tier climbs past the limit', { tier: ARM.maxTier + 1 }, 'tier'],
  ] as [string, Partial<ArmedInput>, string][])('disarms when %s', (_why, over, reason) => {
    const st = armedAt(100)
    expect(stepArmed(st, inp({ beat: 105, ...held(), ...over }))).toEqual({ type: 'disarm', reason })
  })

  it('does NOT disarm for silence alone: a pre-drop gap must not lose the arm', () => {
    const st = armedAt(100)
    expect(stepArmed(st, inp({ beat: 105, silent: true, ...held() })).type).toBe('none')
    expect(st.armed).not.toBeNull()
  })

  it.each([
    ['another request replaced the pending scene (a manual pick)', { pendingSceneId: 'plasma', heldSceneId: null }],
    ['the pending scene was cleared behind its back', { pendingSceneId: null, heldSceneId: 'kifs' }],
    ['the hold was released by someone else', { pendingSceneId: 'kifs', heldSceneId: null }],
    ['a different scene is now held', { pendingSceneId: 'kifs', heldSceneId: 'plasma' }],
    ['the armed scene is already on screen', { pendingSceneId: 'kifs', heldSceneId: 'kifs', sceneId: 'kifs' }],
  ] as [string, Partial<ArmedInput>][])('is superseded when %s', (_why, over) => {
    const st = armedAt(100)
    expect(stepArmed(st, inp({ beat: 105, ...over }))).toEqual({ type: 'disarm', reason: 'superseded' })
  })

  it('a new source (beat counter going backwards) disarms and forgets everything', () => {
    const st = armedAt(5000)
    st.suppressDropPickUntil = 5100
    expect(stepArmed(st, inp({ beat: 3, sustain: false }))).toEqual({ type: 'disarm', reason: 'reset' })
    expect(st.armed).toBeNull()
    expect(dropPickSuppressed(st, 3)).toBe(false) // a stale window must not silence the next track
    expect(st.attempted).toBe(false)
  })

  it('a rewind with nothing armed just resets quietly', () => {
    const st = createArmedState()
    stepArmed(st, inp({ beat: 500, sustain: false }))
    st.suppressDropPickUntil = 900
    expect(stepArmed(st, inp({ beat: 2, sustain: false })).type).toBe('none')
    expect(dropPickSuppressed(st, 2)).toBe(false)
  })
})

describe('stepArmed: robustness', () => {
  it('never throws and never leaves an inconsistent record over a long random run', () => {
    let seed = 12345
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 4294967296
    }
    const st = createArmedState()
    let beat = 0
    for (let n = 0; n < 5000; n++) {
      if (rnd() < 0.7) beat += 1
      if (rnd() < 0.002) beat = Math.floor(rnd() * 50) // a new source
      const armed = st.armed
      const action = stepArmed(
        st,
        inp({
          beat,
          enabled: rnd() > 0.02,
          suppressed: rnd() < 0.03,
          silent: rnd() < 0.05,
          tier: Math.floor(rnd() * 4.2),
          sustain: rnd() < 0.7,
          buildEdge: rnd() < 0.05,
          dropEdge: rnd() < 0.04,
          beatsTillDrop: rnd() < 0.3 ? -1 : rnd() < 0.05 ? NaN : Math.floor(rnd() * 20),
          canDwell: rnd() < 0.5,
          pendingSceneId: armed ? (rnd() < 0.97 ? armed.sceneId : null) : rnd() < 0.1 ? 'plasma' : null,
          heldSceneId: armed ? (rnd() < 0.97 ? armed.sceneId : null) : null,
          sceneId: 'wireframe',
        }),
      )
      if (action.type === 'arm') {
        if (rnd() < 0.8) armPlaced(st, 'kifs', null, beat, 6)
        else armRefused(st, beat)
      }
      // Invariant: an arm request only ever comes with nothing armed.
      if (action.type === 'arm') expect(armed).toBeNull()
      // Invariant: confirm and disarm always leave nothing armed.
      if (action.type === 'confirm' || action.type === 'disarm') expect(st.armed).toBeNull()
    }
  })

  it('survives garbage numbers', () => {
    const st = createArmedState()
    for (const beat of [NaN, Infinity, -Infinity, 0, -5]) {
      expect(() => stepArmed(st, inp({ beat, beatsTillDrop: NaN }))).not.toThrow()
    }
  })
})
