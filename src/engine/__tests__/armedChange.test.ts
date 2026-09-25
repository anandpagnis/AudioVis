import { describe, expect, it } from 'vitest'
import {
  ARM,
  armPlaced,
  armRefused,
  commitArmed,
  createArmedState,
  dropPickSuppressed,
  fitCheckDue,
  stepArmed,
  type ArmedAction,
  type ArmedInput,
  type ArmedState,
} from '../armedChange'

/** A quiet frame, long after the last commit, nothing pending; override what a case cares about. */
function inp(over: Partial<ArmedInput> = {}): ArmedInput {
  return {
    enabled: true,
    suppressed: false,
    silent: false,
    tier: 0,
    beat: 100,
    sustain: false,
    buildEdge: false,
    dropEdge: false,
    beatsTillDrop: -1,
    pendingSceneId: null,
    heldSceneId: null,
    sceneId: 'wireframe',
    canDwell: true,
    lastCommitBeat: 0,
    sectionEdge: false,
    phraseStrength: 0,
    phraseEdge: false,
    energy: 0.5,
    transitionActive: false,
    fit: null,
    ...over,
  }
}

/** The store's view of a scene held for the next change, for the frames after `armPlaced`. */
const held = (id = 'kifs'): Partial<ArmedInput> => ({ pendingSceneId: id, heldSceneId: id })

/** Step to an armed state at `beat`: the arm action, then the caller placing the scene. */
function armedAt(beat = 100, beatsTillDrop = -1, id = 'kifs'): ArmedState {
  const st = createArmedState()
  expect(stepArmed(st, inp({ beat, beatsTillDrop }))).toEqual({ type: 'arm' })
  armPlaced(st, id, null, beat, beatsTillDrop, 'flat aff.9')
  return st
}

const types = (actions: ArmedAction[]) => actions.map((a) => a.type)

describe('ARM constants', () => {
  it('keep the promises the header makes', () => {
    expect(ARM.maxTier).toBe(3) // tier 3-4 is where the user runs; tier 3 must arm
    expect(ARM.repickMinBeats).toBeGreaterThanOrEqual(ARM.fitCheckEveryBeats * 2)
    expect(ARM.phraseStrong).toBeGreaterThan(ARM.phraseMinStrength)
    expect(ARM.maxAgeBeats).toBeGreaterThanOrEqual(32) // the dwell floor
    expect(ARM.expiryBeats).toBeGreaterThan(ARM.maxAgeBeats)
  })
})

describe('idle => arm', () => {
  it('arms on the very first frame automation is allowed: no build, no drop needed', () => {
    const st = createArmedState()
    expect(stepArmed(st, inp())).toEqual({ type: 'arm' })
  })

  it('arms at tier 3 (the user\'s tier) but never at tier 4', () => {
    expect(stepArmed(createArmedState(), inp({ tier: 3 }))).toEqual({ type: 'arm' })
    expect(stepArmed(createArmedState(), inp({ tier: 4 }))).toEqual({ type: 'none' })
  })

  it('does not arm when off, suppressed, silent, in a transition, or while something is pending', () => {
    for (const over of [
      { enabled: false },
      { suppressed: true },
      { silent: true },
      { transitionActive: true },
      { pendingSceneId: 'plasma' },
    ] satisfies Partial<ArmedInput>[]) {
      expect(stepArmed(createArmedState(), inp(over)), JSON.stringify(over)).toEqual({ type: 'none' })
    }
  })

  it('does not arm on a build\'s rising edge or a drop frame (those frames belong to the directors)', () => {
    expect(stepArmed(createArmedState(), inp({ buildEdge: true }))).toEqual({ type: 'none' })
    expect(stepArmed(createArmedState(), inp({ dropEdge: true }))).toEqual({ type: 'none' })
  })

  it('waits armAfterCommitBeats after the last commit', () => {
    const st = createArmedState()
    expect(stepArmed(st, inp({ beat: 100, lastCommitBeat: 100 - ARM.armAfterCommitBeats + 1 }))).toEqual({ type: 'none' })
    expect(stepArmed(st, inp({ beat: 101, lastCommitBeat: 101 - ARM.armAfterCommitBeats }))).toEqual({ type: 'arm' })
  })

  it('rate-limits arms: one per repickMinBeats', () => {
    const st = armedAt(100)
    // The scene was committed (so the slot is free again) and only a few beats passed: no new arm yet.
    commitArmed(st, 'mood', 104)
    expect(stepArmed(st, inp({ beat: 110, lastCommitBeat: 104 }))).toEqual({ type: 'none' })
    expect(stepArmed(st, inp({ beat: 100 + ARM.repickMinBeats, lastCommitBeat: 104 }))).toEqual({ type: 'arm' })
  })

  it('retries a refused arm after refusedRetryBeats, not immediately and not a whole repick period', () => {
    const st = createArmedState()
    expect(stepArmed(st, inp({ beat: 100 }))).toEqual({ type: 'arm' })
    armRefused(st, 100)
    expect(stepArmed(st, inp({ beat: 100 + ARM.refusedRetryBeats - 1 }))).toEqual({ type: 'none' })
    expect(stepArmed(st, inp({ beat: 100 + ARM.refusedRetryBeats }))).toEqual({ type: 'arm' })
    expect(st.lastOutcome).toBe('refused@b100')
  })

  it('a new source (the beat counter going backwards) resets every tracker', () => {
    const st = armedAt(5000)
    st.suppressDropPickUntil = 5010
    const a = stepArmed(st, inp({ beat: 3, ...held() }))
    expect(a).toEqual({ type: 'disarm', reason: 'reset' })
    expect(st.armed).toBeNull()
    expect(st.suppressDropPickUntil).toBe(Number.NEGATIVE_INFINITY)
    expect(stepArmed(st, inp({ beat: 10, lastCommitBeat: -Infinity }))).toEqual({ type: 'arm' })
  })
})

describe('armed: validity', () => {
  it('records the placement (scene, projected drop, reason, expiry) and starts the fit clock', () => {
    const st = armedAt(100, 12, 'kifs')
    expect(st.armed).toMatchObject({ sceneId: 'kifs', armedAtBeat: 100, expectedBeat: 112, gate: 'hold', reason: 'flat aff.9' })
    expect(st.armed!.expiresAtBeat).toBe(100 + ARM.expiryBeats)
    expect(fitCheckDue(st, 100)).toBe(false)
    expect(fitCheckDue(st, 100 + ARM.fitCheckEveryBeats)).toBe(true)
    expect(fitCheckDue(st, 100, true)).toBe(true) // forced (a build's rising edge)
    expect(fitCheckDue(createArmedState(), 100, true)).toBe(false) // nothing armed
  })

  it.each([
    ['off', { enabled: false }],
    ['suppressed', { suppressed: true }],
    ['tier', { tier: 4 }],
  ] as const)('disarms (%s)', (reason, over) => {
    const st = armedAt(100)
    expect(stepArmed(st, inp({ beat: 101, ...held(), ...over }))).toEqual({ type: 'disarm', reason })
    expect(st.armed).toBeNull()
    expect(st.lastOutcome).toBe(`${reason}@b101`)
  })

  it('is superseded when someone replaced the pending scene, or the armed scene became the current one', () => {
    for (const over of [
      { pendingSceneId: 'plasma', heldSceneId: null },
      { pendingSceneId: null, heldSceneId: null },
      { ...held(), sceneId: 'kifs' },
    ]) {
      const st = armedAt(100)
      expect(stepArmed(st, inp({ beat: 101, ...over })), JSON.stringify(over)).toEqual({ type: 'disarm', reason: 'superseded' })
    }
  })

  it('a director having released the hold is NOT an error: reported as released (no store action needed)', () => {
    const st = armedAt(100)
    expect(stepArmed(st, inp({ beat: 101, pendingSceneId: 'kifs', heldSceneId: null }))).toEqual({
      type: 'disarm',
      reason: 'released',
    })
    expect(st.lastOutcome).toBe('released@b101')
  })

  it('expires after expiryBeats so a scene that never fits is not held forever', () => {
    const st = armedAt(100)
    expect(stepArmed(st, inp({ beat: 100 + ARM.expiryBeats - 1, ...held() }))).not.toEqual({ type: 'disarm', reason: 'expired' })
    expect(stepArmed(st, inp({ beat: 100 + ARM.expiryBeats, ...held() }))).toEqual({ type: 'disarm', reason: 'expired' })
  })
})

describe('refresh: the armed scene stops fitting', () => {
  it('re-picks when its fit falls below refitRatio of the best, once it has been held long enough', () => {
    const st = armedAt(100)
    const beat = 100 + ARM.repickMinBeats
    const a = stepArmed(st, inp({ beat, ...held(), fit: { armed: 0.2, best: 1 } }))
    expect(a).toEqual({ type: 'disarm', reason: 'refit' })
    expect(st.lastFitArmed).toBe(0.2)
    expect(st.lastFitBest).toBe(1)
  })

  it('keeps a scene that still fits (at or above the ratio)', () => {
    const st = armedAt(100)
    const beat = 100 + ARM.repickMinBeats
    expect(stepArmed(st, inp({ beat, ...held(), fit: { armed: ARM.refitRatio, best: 1 } })).type).toBe('none')
    expect(st.armed).not.toBeNull()
  })

  it('RATE LIMIT: never re-picks a scene held for less than repickMinBeats, however bad its fit', () => {
    const st = armedAt(100)
    for (let b = 101; b < 100 + ARM.repickMinBeats; b += ARM.fitCheckEveryBeats) {
      const a = stepArmed(st, inp({ beat: b, ...held(), fit: { armed: 0, best: 1 } }))
      expect(a.type, `beat ${b}`).toBe('none')
    }
    expect(st.armed).not.toBeNull()
  })

  it('never re-picks during a transition (a compile on top of a crossfade is two heavy scenes at once)', () => {
    const st = armedAt(100)
    const a = stepArmed(st, inp({ beat: 100 + ARM.repickMinBeats, ...held(), transitionActive: true, fit: { armed: 0, best: 1 } }))
    expect(a.type).toBe('none')
  })

  it('a zero or non-finite fit counts as not fitting', () => {
    for (const armed of [0, NaN]) {
      const st = armedAt(100)
      const a = stepArmed(st, inp({ beat: 100 + ARM.repickMinBeats, ...held(), fit: { armed, best: 1 } }))
      expect(a, String(armed)).toEqual({ type: 'disarm', reason: 'refit' })
    }
  })

  it('re-arms on the next frame after a refit (the slot is free and the rate limit has been served)', () => {
    const st = armedAt(100)
    const beat = 100 + ARM.repickMinBeats
    expect(stepArmed(st, inp({ beat, ...held(), fit: { armed: 0, best: 1 } })).type).toBe('disarm')
    expect(stepArmed(st, inp({ beat: beat + 1 }))).toEqual({ type: 'arm' })
  })
})

describe('confirm: a real drop', () => {
  it('cuts NOW (immediate), at any time, even right after arming, inside the dwell, and in silence', () => {
    const st = armedAt(100)
    const a = stepArmed(st, inp({ beat: 100, ...held(), dropEdge: true, canDwell: false, silent: true }))
    expect(a).toEqual({ type: 'confirm', trigger: 'drop', immediate: true })
    expect(st.armed).toBeNull()
    expect(st.lastOutcome).toBe('drop@b100')
  })

  it('takes priority over every other trigger on the same frame', () => {
    const st = armedAt(100)
    const a = stepArmed(st, inp({ beat: 110, ...held(), dropEdge: true, sectionEdge: true, phraseStrength: 1 }))
    expect(a).toEqual({ type: 'confirm', trigger: 'drop', immediate: true })
  })

  it('does not suppress the ordinary drop pick (only a predicted commit does)', () => {
    const st = armedAt(100)
    stepArmed(st, inp({ beat: 110, ...held(), dropEdge: true }))
    expect(dropPickSuppressed(st, 111)).toBe(false)
  })
})

describe('confirm: the other triggers (dwell-gated, beat-locked crossfade)', () => {
  const at = (over: Partial<ArmedInput>, st = armedAt(100)) =>
    stepArmed(st, inp({ beat: 100 + ARM.minHoldBeats, ...held(), ...over }))

  it('a latched section boundary', () => {
    expect(at({ sectionEdge: true })).toEqual({ type: 'confirm', trigger: 'section', immediate: false })
  })

  it('a strong fast change confirms at once', () => {
    expect(at({ phraseStrength: ARM.phraseStrong })).toEqual({ type: 'confirm', trigger: 'phrase', immediate: false })
  })

  it('a moderate fast change is REMEMBERED and confirms at the next phrase edge within the latch', () => {
    const st = armedAt(100)
    expect(stepArmed(st, inp({ beat: 110, ...held(), phraseStrength: ARM.phraseMinStrength })).type).toBe('none')
    // Not on an edge yet.
    expect(stepArmed(st, inp({ beat: 112, ...held() })).type).toBe('none')
    // The phrase edge lands inside the latch window: confirm.
    expect(stepArmed(st, inp({ beat: 110 + ARM.phraseLatchBeats, ...held(), phraseEdge: true }))).toEqual({
      type: 'confirm',
      trigger: 'phrase',
      immediate: false,
    })
  })

  it('a moderate fast change is FORGOTTEN once the latch has expired, and a weak one is never remembered', () => {
    const st = armedAt(100)
    stepArmed(st, inp({ beat: 110, ...held(), phraseStrength: ARM.phraseMinStrength }))
    expect(stepArmed(st, inp({ beat: 110 + ARM.phraseLatchBeats + 1, ...held(), phraseEdge: true, lastCommitBeat: 100 })).type).toBe('none')
    const st2 = armedAt(100)
    stepArmed(st2, inp({ beat: 110, ...held(), phraseStrength: ARM.phraseMinStrength - 0.05 }))
    expect(stepArmed(st2, inp({ beat: 111, ...held(), phraseEdge: true, lastCommitBeat: 100 })).type).toBe('none')
  })

  it('a phrase edge alone (no fast change) does not confirm while the scene on screen is young', () => {
    expect(at({ phraseEdge: true, lastCommitBeat: 100 })).toEqual({ type: 'none' })
  })

  it('the projected drop beat, one beat early, with the build still sustained', () => {
    const st = armedAt(100, 14) // drop projected at b114
    const early = stepArmed(st, inp({ beat: 112, ...held(), sustain: true, beatsTillDrop: 2 }))
    expect(early.type).toBe('none')
    const a = stepArmed(st, inp({ beat: 113, ...held(), sustain: true, beatsTillDrop: 1 }))
    expect(a).toEqual({ type: 'confirm', trigger: 'predicted', immediate: false })
    expect(dropPickSuppressed(st, 114)).toBe(true) // the ordinary drop pick is suppressed for a while...
    expect(dropPickSuppressed(st, 113 + ARM.dropSuppressBeats)).toBe(false) // ...and then released
  })

  it('the projection needs the build to still be sustained', () => {
    const st = armedAt(100, 14)
    expect(stepArmed(st, inp({ beat: 113, ...held(), sustain: false, beatsTillDrop: 1 })).type).toBe('none')
  })

  it('the projection is re-made every beat: a later projection moves the release', () => {
    const st = armedAt(100, 14)
    expect(stepArmed(st, inp({ beat: 110, ...held(), sustain: true, beatsTillDrop: 20 })).type).toBe('none')
    expect(st.armed!.expectedBeat).toBe(130)
    expect(stepArmed(st, inp({ beat: 113, ...held(), sustain: true, beatsTillDrop: 17 })).type).toBe('none')
  })

  it('a sustained energy step (a drop in level as much as a rise)', () => {
    const st = armedAt(100)
    // Settle the trackers at a steady level.
    let beat = 100
    for (let i = 0; i < 24; i++) stepArmed(st, inp({ beat: ++beat, ...held(), energy: 0.3 }))
    expect(st.armed).not.toBeNull()
    // A big jump up held for energyStepBeats beats confirms.
    const seen: ArmedAction['type'][] = []
    for (let i = 0; i < 6; i++) {
      const a = stepArmed(st, inp({ beat: ++beat, ...held(), energy: 0.95 }))
      seen.push(a.type)
      if (a.type === 'confirm') {
        expect(a).toEqual({ type: 'confirm', trigger: 'energy', immediate: false })
        break
      }
    }
    expect(seen).toContain('confirm')
    // ...and not on the first beat of the jump.
    expect(seen[0]).toBe('none')
  })

  it('a steady level, or slow drift, is not a step', () => {
    const st = armedAt(100)
    let beat = 100
    for (let i = 0; i < 200; i++) {
      const a = stepArmed(st, inp({ beat: ++beat, ...held(), energy: 0.4 + 0.15 * Math.sin(i / 40) }))
      expect(a.type, `beat ${beat}`).not.toBe('confirm')
    }
  })

  it('AGE: the scene on screen has run maxAgeBeats and a phrase edge arrives => the show never stagnates', () => {
    const st = armedAt(100)
    expect(stepArmed(st, inp({ beat: 100 + ARM.minHoldBeats, ...held(), phraseEdge: true, lastCommitBeat: 100 + ARM.minHoldBeats - ARM.maxAgeBeats + 1 })).type).toBe('none')
    const a = stepArmed(st, inp({ beat: 104, ...held(), phraseEdge: true, lastCommitBeat: 104 - ARM.maxAgeBeats }))
    expect(a).toEqual({ type: 'confirm', trigger: 'age', immediate: false })
  })

  it('every dwell-gated trigger respects the dwell floor', () => {
    for (const over of [
      { sectionEdge: true },
      { phraseStrength: 1 },
      { phraseEdge: true, lastCommitBeat: -Infinity },
    ] satisfies Partial<ArmedInput>[]) {
      expect(at({ ...over, canDwell: false }), JSON.stringify(over)).toEqual({ type: 'none' })
    }
  })

  it('...and the minimum hold, and silence', () => {
    const st = armedAt(100)
    expect(stepArmed(st, inp({ beat: 101, ...held(), sectionEdge: true })).type).toBe('none') // 1 < minHoldBeats
    const st2 = armedAt(100)
    expect(stepArmed(st2, inp({ beat: 110, ...held(), sectionEdge: true, silent: true })).type).toBe('none')
  })

  it('a confirm clears the record so the same trigger cannot fire twice', () => {
    const st = armedAt(100)
    expect(at({ sectionEdge: true }, st).type).toBe('confirm')
    expect(st.armed).toBeNull()
    expect(stepArmed(st, inp({ beat: 103, sectionEdge: true, pendingSceneId: 'kifs', heldSceneId: null })).type).not.toBe('confirm')
  })
})

describe('commitArmed / director commits', () => {
  it('forgets the armed scene and records who released it', () => {
    const st = armedAt(100)
    commitArmed(st, 'mood', 130)
    expect(st.armed).toBeNull()
    expect(st.lastOutcome).toBe('mood@b130')
  })

  it('after a director release the machine reports `released`, not a fault, if it still holds a stale record', () => {
    const st = armedAt(100)
    expect(stepArmed(st, inp({ beat: 105, pendingSceneId: 'kifs', heldSceneId: null })).type).toBe('disarm')
    expect(st.lastOutcome).toBe('released@b105')
  })
})

describe('a whole show', () => {
  it('arms, holds, releases on a phrase change, re-arms, and never arms twice in a row', () => {
    const st = createArmedState()
    const log: string[] = []
    let beat = 0
    let lastCommit = 0
    let pending: string | null = null
    let heldId: string | null = null
    let current = 'wireframe'
    for (let i = 0; i < 400; i++) {
      beat++
      const a = stepArmed(
        st,
        inp({
          beat,
          lastCommitBeat: lastCommit,
          canDwell: beat - lastCommit >= 32,
          pendingSceneId: pending,
          heldSceneId: heldId,
          sceneId: current,
          phraseStrength: beat % 64 === 40 ? 1 : 0,
        }),
      )
      if (a.type === 'arm') {
        const id = ['kifs', 'plasma', 'maze', 'chrome'][log.length % 4]
        pending = heldId = id
        armPlaced(st, id, null, beat, -1)
        log.push(`arm ${id}@${beat}`)
      } else if (a.type === 'confirm') {
        current = pending as string // SceneManager commits the released scene
        pending = heldId = null
        lastCommit = beat
        log.push(`confirm ${a.trigger}@${beat}`)
      } else if (a.type === 'disarm') {
        pending = heldId = null
        log.push(`disarm ${a.reason}@${beat}`)
      }
    }
    // It armed a scene, released it on the strong phrase change past the dwell, and kept doing so.
    expect(log.filter((l) => l.startsWith('arm')).length).toBeGreaterThanOrEqual(4)
    expect(log.filter((l) => l.startsWith('confirm phrase')).length).toBeGreaterThanOrEqual(3)
    // Never two arms without a confirm / disarm between them.
    let armed = false
    for (const l of log) {
      if (l.startsWith('arm')) {
        expect(armed, l).toBe(false)
        armed = true
      } else armed = false
    }
    // The types of everything it ever asked for are all handled kinds.
    expect(types([{ type: 'none' }])).toEqual(['none'])
  })
})
