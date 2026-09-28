import { beforeEach, describe, expect, it, vi } from 'vitest'

// Only the lazy-chunk fetch is stubbed (it would import a real scene module in node); the real registry still answers
// `getCharacterCandidates` and `canHoldPrimary`.
vi.mock('../../scenes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scenes')>()),
  preloadScene: vi.fn(),
}))

import { createEmptyCharacterState } from '../../audio/characterTypes'
import { createEmptyFeatures, type AudioFeatures } from '../../audio/types'
import { getCharacterCandidates } from '../../scenes'
import { MIN_SUBJECT_DWELL_BEATS, useStore } from '../../store'
import AUTOPILOT_SRC from '../AutoPilot.tsx?raw'
import ADAPTER_SRC from '../show/showAdapter.tsx?raw'
import DIRECTOR_SRC from '../PerformanceDirector.tsx?raw'
import STAGE_SRC from '../Stage.tsx?raw'
import ARMED_CHANGE_SRC from '../armedChange.ts?raw'
import ARMED_DIRECTOR_SRC from '../armedDirector.ts?raw'
import {
  ARM,
  armPlaced,
  createArmedState,
  stepArmed,
  type ArmedInput,
  type ArmedState,
} from '../armedChange'
import { armedFitNow, armedRuntime, tryCommitArmed } from '../armedDirector'
import { DIRECTOR_ON, directorLegacy } from '../show/directorFlags'
import { clearShowRuntime, showRuntime, LAYERS_CUT, LAYERS_MICRO, LAYERS_NONE } from '../show/showRuntime'

/**
 * `?director=legacy` must restore the OLD trigger behaviour bit-for-bit. The frame hooks (AutoPilot,
 * PerformanceDirector) have no node harness, so the parts whose GUARD is what makes them correct are pinned at the
 * source level, the same idiom as `armedAutoPilot.test.ts` (which itself still passes unchanged: it pins the legacy
 * strings this change deliberately left intact). The pure pieces (`stepArmed`, `tryCommitArmed`, `requestScene`, the
 * flag) are tested by behaviour.
 */
const ap = AUTOPILOT_SRC.replace(/\r\n/g, '\n')
const pd = DIRECTOR_SRC.replace(/\r\n/g, '\n')
const adapter = ADAPTER_SRC.replace(/\r\n/g, '\n')

describe('directorFlags: ?director=legacy', () => {
  it('is legacy only for ?director=legacy (or an explicit off value); absent or anything else is the director', () => {
    expect(directorLegacy('?director=legacy')).toBe(true)
    expect(directorLegacy('?director=LEGACY')).toBe(true)
    expect(directorLegacy('?lookdebug&director=legacy&x=1')).toBe(true)
    expect(directorLegacy('director=legacy')).toBe(true)
    for (const off of ['off', '0', 'false', 'no']) expect(directorLegacy(`?director=${off}`)).toBe(true)
    expect(directorLegacy('')).toBe(false)
    expect(directorLegacy('?')).toBe(false)
    expect(directorLegacy('?director')).toBe(false)
    expect(directorLegacy('?director=on')).toBe(false)
    expect(directorLegacy('?director=show')).toBe(false)
    expect(directorLegacy('?directors=legacy')).toBe(false)
  })

  it('with no location (node, workers) it answers "flag absent", so the director is on by default', () => {
    expect(directorLegacy()).toBe(false)
    expect(DIRECTOR_ON).toBe(true)
  })

  it('is read once at module load, like ARM_ENABLED', () => {
    const src = ADAPTER_SRC + AUTOPILOT_SRC
    expect(src).toContain("from './show/directorFlags'")
    expect(src.match(/directorLegacy\(/g)).toBeNull() // no per-frame call: only the constant is imported
  })
})

/** A quiet frame with an armed scene: nothing pending except the held scene. */
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
    pendingSceneId: 'kifs',
    heldSceneId: 'kifs',
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

function armedAt(beat = 90): ArmedState {
  const st = createArmedState()
  armPlaced(st, 'kifs', null, beat, -1, 'test')
  return st
}

describe('stepArmed: the confirm triggers under the director (directorOwns)', () => {
  const triggers: [string, Partial<ArmedInput>][] = [
    ['section', { sectionEdge: true }],
    ['strong phrase', { phraseStrength: ARM.phraseStrong }],
    ['phrase edge after a change', { phraseStrength: ARM.phraseMinStrength, phraseEdge: true }],
    ['predicted', { sustain: true, beatsTillDrop: 1 }],
    ['age', { phraseEdge: true, lastCommitBeat: -100 }],
  ]

  it('legacy (directorOwns absent or false): every one of them still releases the armed scene', () => {
    for (const [name, over] of triggers) {
      for (const flag of [undefined, false]) {
        const st = armedAt()
        const a = stepArmed(st, inp({ ...over, directorOwns: flag }))
        expect(a.type, `${name} directorOwns=${String(flag)}`).toBe('confirm')
      }
    }
    const drop = stepArmed(armedAt(), inp({ dropEdge: true }))
    expect(drop).toEqual({ type: 'confirm', trigger: 'drop', immediate: true })
  })

  it('with the director: none of them releases it on its own, the drop included (the director\'s CUT does)', () => {
    for (const [name, over] of triggers) {
      const st = armedAt()
      expect(stepArmed(st, inp({ ...over, directorOwns: true })), name).toEqual({ type: 'none' })
      expect(st.armed, name).not.toBeNull() // still armed and waiting
    }
    const st = armedAt()
    expect(stepArmed(st, inp({ dropEdge: true, directorOwns: true }))).toEqual({ type: 'none' })
    expect(st.armed).not.toBeNull()
  })

  it('with the director: an energy step is demoted too', () => {
    const st = armedAt()
    // ramp the energy tracker: quiet for a while, then a sustained jump
    for (let b = 91; b < 99; b++) stepArmed(st, inp({ beat: b, energy: 0.1, directorOwns: true }))
    let last = stepArmed(st, inp({ beat: 99, energy: 0.95, directorOwns: true }))
    for (let b = 100; b < 104; b++) last = stepArmed(st, inp({ beat: b, energy: 0.95, directorOwns: true }))
    expect(last.type).toBe('none')
    const legacy = armedAt()
    for (let b = 91; b < 99; b++) stepArmed(legacy, inp({ beat: b, energy: 0.1 }))
    const types: string[] = []
    for (let b = 99; b < 104; b++) types.push(stepArmed(legacy, inp({ beat: b, energy: 0.95 })).type)
    expect(types).toContain('confirm')
  })

  it('with the director: arming, refit and expiry still run (the armed scene stays a pick)', () => {
    // arm from idle
    const idle = createArmedState()
    expect(stepArmed(idle, inp({ pendingSceneId: null, heldSceneId: null, directorOwns: true }))).toEqual({ type: 'arm' })
    // refit when it no longer suits
    const st = armedAt(50)
    const refit = stepArmed(st, inp({ beat: 100, fit: { armed: 0.1, best: 0.9 }, directorOwns: true }))
    expect(refit).toEqual({ type: 'disarm', reason: 'refit' })
    // expiry
    const old = armedAt(0)
    expect(stepArmed(old, inp({ beat: ARM.expiryBeats + 1, directorOwns: true }))).toEqual({ type: 'disarm', reason: 'expired' })
  })
})

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
    pendingReason: null,
    heldSceneId: null,
    lastCommitBeat: -Infinity,
    recentSceneIds: [],
  })
}

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

function arm(id: string, f: AudioFeatures) {
  expect(st().armScene(id)).toBe(true)
  armedRuntime.state = createArmedState()
  armPlaced(armedRuntime.state, id, null, f.beatIndex - 10, -1, 'test')
}

describe('tryCommitArmed under the director', () => {
  beforeEach(() => {
    resetStore()
    armedRuntime.state = createArmedState()
    armedRuntime.directorOwns = false
  })

  it('directorOwns starts false, so every legacy caller behaves exactly as before', () => {
    expect(armedRuntime.directorOwns).toBe(false)
    const f = features()
    const id = bestFor(f)
    arm(id, f)
    expect(tryCommitArmed('mood', false, f)).toBe(true)
  })

  it('directorOwns: the demoted triggers (mood / boundary / build / stale) cannot release the armed scene', () => {
    armedRuntime.directorOwns = true
    const f = features()
    const id = bestFor(f)
    arm(id, f)
    for (const trigger of ['mood', 'boundary', 'build', 'stale'] as const) {
      expect(tryCommitArmed(trigger, false, f), trigger).toBe(false)
      expect(tryCommitArmed(trigger, true, f), `${trigger} immediate`).toBe(false)
    }
    expect(st().heldSceneId).toBe(id) // untouched
    expect(armedRuntime.state.armed).not.toBeNull()
  })

  it("the director's own 'show' release works, skips the 32-beat dwell, records the reason and who released it", () => {
    armedRuntime.directorOwns = true
    const f = features()
    const id = bestFor(f)
    arm(id, f)
    useStore.setState({ lastCommitBeat: f.beatIndex - 5 }) // the dwell has NOT elapsed
    expect(tryCommitArmed('show', false, f, undefined, 'show:event S=0.90')).toBe(true)
    expect(st().heldSceneId).toBeNull()
    expect(st().pendingSceneId).toBe(id)
    expect(st().pendingImmediate).toBe(false)
    expect(st().pendingReason).toBe('show:event S=0.90')
    expect(armedRuntime.state.lastOutcome).toBe(`show@b${f.beatIndex}`)
  })

  it("a 'show' release of a drop is immediate, and still refuses a scene that no longer fits", () => {
    armedRuntime.directorOwns = true
    const f = features()
    const id = bestFor(f)
    arm(id, f)
    expect(tryCommitArmed('show', true, f)).toBe(true)
    expect(st().pendingImmediate).toBe(true)
    expect(st().pendingReason).toBeNull() // no reason given: the store keeps none
  })

  it("legacy dwell rule is unchanged for the legacy triggers when the director is off", () => {
    const f = features()
    const id = bestFor(f)
    arm(id, f)
    useStore.setState({ lastCommitBeat: f.beatIndex - 5 })
    expect(tryCommitArmed('mood', false, f)).toBe(false)
    expect(tryCommitArmed('mood', true, f)).toBe(true)
  })
})

describe('store.requestScene: reason and bypassDwell', () => {
  beforeEach(resetStore)

  it('a legacy automatic request is still refused inside the 32-beat dwell', () => {
    useStore.setState({ lastCommitBeat: 0 })
    expect(MIN_SUBJECT_DWELL_BEATS).toBe(32)
    expect(st().requestScene('kifs', { auto: true, immediate: false })).toBe(false)
    expect(st().requestScene('kifs', { auto: true })).toBe(false)
    expect(st().pendingSceneId).toBeNull()
  })

  it("the director's request (bypassDwell) is accepted inside the dwell and carries its reason until the commit", () => {
    useStore.setState({ lastCommitBeat: 0 })
    expect(st().requestScene('kifs', { auto: true, immediate: false, bypassDwell: true, reason: 'show:event S=0.9' })).toBe(true)
    expect(st().pendingSceneId).toBe('kifs')
    expect(st().pendingReason).toBe('show:event S=0.9')
    st().commitScene()
    expect(st().sceneId).toBe('kifs')
    expect(st().pendingReason).toBeNull() // cleared with the pending scene
  })

  it('a legacy request leaves no reason, and clears a stale one', () => {
    st().requestScene('kifs', { auto: true, bypassDwell: true, reason: 'show:x' })
    st().requestScene('plasma')
    expect(st().pendingReason).toBeNull()
  })

  it('bypassDwell only skips the dwell: the same-scene and canHoldPrimary guards still hold', () => {
    expect(st().requestScene('wireframe', { auto: true, bypassDwell: true })).toBe(false) // already showing
    expect(st().requestScene('ribbons', { auto: true, bypassDwell: true })).toBe(false) // effect-only scene
    expect(st().pendingSceneId).toBeNull()
  })

  it('arming clears any stale reason', () => {
    useStore.setState({ pendingReason: 'stale' })
    st().armScene('kifs')
    expect(st().pendingReason).toBeNull()
  })
})

describe('showRuntime: the one-frame mailbox', () => {
  it('starts empty and clears every flag', () => {
    expect(showRuntime).toEqual({ palette: false, mode: false, layers: LAYERS_NONE })
    showRuntime.palette = true
    showRuntime.mode = true
    showRuntime.layers = LAYERS_CUT
    clearShowRuntime()
    expect(showRuntime).toEqual({ palette: false, mode: false, layers: LAYERS_NONE })
    expect(LAYERS_MICRO).not.toBe(LAYERS_CUT)
  })
})

describe('AutoPilot: the legacy trigger blocks are wrapped, not deleted', () => {
  it('imports the read-once flag and the mailbox from the show module', () => {
    expect(ap).toMatch(/import \{ DIRECTOR_ON \} from '\.\/show\/directorFlags'/)
    expect(ap).toMatch(/import \{ showRuntime \} from '\.\/show\/showRuntime'/)
  })

  it('the mood / predicted / character-shift / stale / drop trigger chain is the ELSE of the director branch, intact', () => {
    const start = ap.indexOf('if (DIRECTOR_ON) {')
    expect(start).toBeGreaterThan(0)
    const chain = ap.slice(start, ap.indexOf('if (target !== null) {'))
    expect(chain).toContain('} else if (dropEdge && !preArmedThisDrop) {')
    expect(chain).toContain('if (m.changed) pendingChange.current = m.changeCount')
    expect(chain).toContain('pendingChange.current !== handledChange.current')
    expect(chain).toContain('charShift.current.take(f.time, lastAutoTriggerAt.current)')
    expect(chain).toContain('f.time - lastAutoTriggerAt.current >= STALE_TARGET_SEC')
    // the director branch itself picks nothing
    const directorBranch = chain.slice(0, chain.indexOf('} else if (dropEdge'))
    expect(directorBranch).not.toMatch(/target =|requestScene|pickBy|pickVaried/)
  })

  it('the drop pre-arm and the build one-shot are guarded off under the director and otherwise unchanged', () => {
    expect(ap).toMatch(/if \(\s*!DIRECTOR_ON &&\s*sceneLook !== undefined &&\s*shouldSwitchOnBuild\(/)
    expect(ap).toMatch(/if \(\s*!DIRECTOR_ON &&\s*!\(ARM_ENABLED && quality\.tier <= ARM\.maxTier\) &&\s*inSustain &&/)
  })

  it('the palette and mode triggers read the director\'s mailbox, and keep the legacy expression as the alternative', () => {
    expect(ap).toContain(
      '(DIRECTOR_ON ? showRuntime.palette : target !== null || f.sectionChange || structureRecolour) &&',
    )
    expect(ap).toContain('(DIRECTOR_ON ? showRuntime.mode : f.sectionChange || structureRecolour) &&')
    // the cadence floors that bound palette / mode variation are the same constants
    expect(ap).toMatch(/f\.time - lastPaletteAt\.current >= PALETTE_MIN_SEC/)
    expect(ap).toMatch(/f\.time - lastModeVaryAt\.current >= MODE_VARY_MIN_SEC/)
  })

  it('tells the armed-scene machine and tryCommitArmed that the director owns timing', () => {
    expect(ap).toContain('armedRuntime.directorOwns = DIRECTOR_ON')
    expect(ap).toContain('directorOwns: DIRECTOR_ON,')
    // ...and the legacy confirm inputs are still handed over unchanged
    expect(ap).toContain('sectionEdge: f.structureValid && f.songSection.boundaryChanged')
    expect(ap).toContain('phraseStrength: f.sectionChange ? f.sectionChangeStrength : 0')
  })

  it('the stale timer, the mood gates and every legacy tryCommitArmed call are still there', () => {
    expect(ap).toContain('const STALE_TARGET_SEC = 25')
    expect(ap).toContain("tryCommitArmed('build', false, f)")
    expect(ap).toContain("tryCommitArmed('mood', false, f)")
    expect(ap).toContain('m.confidence >= MOOD_CHANGE_MIN_CONFIDENCE')
  })

  it('still exports the hype pick the director reuses for a drop CUT', () => {
    expect(ap).toMatch(/export function pickHypeScene\(/)
  })
})

describe('PerformanceDirector: layers recompose only through the director', () => {
  it('the three legacy signals still form the boundary under ?director=legacy', () => {
    expect(pd).toContain('f.sectionChange || latchedBoundary || phraseFallback')
    expect(pd).toMatch(/const latchedBoundary = f\.structureValid && f\.songSection\.boundaryChanged/)
    expect(pd).toMatch(/const phraseFallback = !f\.structureValid && isPhraseEdge\(f\.beat, f\.beatInBar, f\.bar\)/)
  })

  it('under the director the boundary is the mailbox and the section-scale recompose is a CUT', () => {
    expect(pd).toContain('const boundary = DIRECTOR_ON ? showRuntime.layers !== LAYERS_NONE :')
    expect(pd).toContain('const sectionBoundary = DIRECTOR_ON ? showRuntime.layers === LAYERS_CUT : f.sectionChange || latchedBoundary')
    expect(pd).toContain('const backgroundPool = sectionBoundary && !inBreakdown')
    expect(pd).toContain('if (sectionBoundary) s.setLayer(')
  })

  it('never picks a primary under the director (the candidate list is empty), and the phrase spacing / build hold are legacy-only', () => {
    expect(pd).toMatch(/const primaryCandidates: SceneDef\[\] = DIRECTOR_ON\s+\? \[\]\s+: inBreakdown/)
    expect(pd).toContain('if (!DIRECTOR_ON && f.structureValid && f.songSection.isSustain && !f.songSection.boundaryChanged) return')
    expect(pd).toMatch(/!DIRECTOR_ON &&\s+!f\.sectionChange &&\s+!latchedBoundary &&\s+f\.beatIndex - lastSwitchBeat\.current < PHRASE_HOLD_BEATS/)
    // a breakdown still clears the layers (an empty pool must not return early under the director)
    expect(pd).toContain('if (!DIRECTOR_ON && primaryCandidates.length === 0 && layerFits.length === 0) return')
  })

  it("the armed release at a boundary is still called with the legacy trigger (tryCommitArmed refuses it while the director owns timing)", () => {
    expect(pd).toMatch(/const armedTaken = heldPending && tryCommitArmed\('boundary', false, f\)/)
  })
})

describe('armedChange / armedDirector: legacy release policy kept behind the flag', () => {
  it('the drop confirm and the dwell-gated confirms are guarded by directorOwns, their bodies untouched', () => {
    const src = ARMED_CHANGE_SRC.replace(/\r\n/g, '\n')
    expect(src).toContain('if (i.dropEdge && i.directorOwns !== true) {')
    expect(src).toContain('if (i.directorOwns === true) return NONE')
    for (const line of [
      "if (i.sectionEdge) trigger = 'section'",
      "else if (i.phraseStrength >= ARM.phraseStrong) trigger = 'phrase'",
      "else if (st.stepRun >= ARM.energyStepBeats && newBeat) trigger = 'energy'",
      "else if (i.phraseEdge && i.beat - i.lastCommitBeat >= ARM.maxAgeBeats) trigger = 'age'",
    ]) {
      expect(src, line).toContain(line)
    }
  })

  it("tryCommitArmed refuses legacy triggers only while directorOwns, and 'show' skips the dwell", () => {
    const src = ARMED_DIRECTOR_SRC.replace(/\r\n/g, '\n')
    expect(src).toContain("if (armedRuntime.directorOwns && trigger !== 'show') return false")
    expect(src).toContain("if (!immediate && trigger !== 'show' && !canAutoSwitch(s.lastCommitBeat, f.beatIndex)) return false")
    expect(src).toContain('export const armedRuntime = { state: createArmedState(), directorOwns: false }')
  })
})

describe('ShowAdapter wiring', () => {
  it('is mounted once, in the decide band, before AutoPilot', () => {
    const stage = STAGE_SRC.replace(/\r\n/g, '\n')
    expect(stage.match(/<ShowAdapter \/>/g)).toHaveLength(1)
    expect(stage.indexOf('<ShowAdapter />')).toBeLessThan(stage.indexOf('<AutoPilot />'))
  })

  it('runs at -92: after the audio engine (-100), before AutoPilot (-90) and PerformanceDirector (-85)', () => {
    expect(adapter).toMatch(/\}, -92\)/)
  })

  it('clears the mailbox first and stands down entirely under ?director=legacy', () => {
    const body = adapter.slice(adapter.indexOf('useFrame(() => {'))
    expect(body.indexOf('clearShowRuntime()')).toBeGreaterThan(0)
    expect(body.indexOf('clearShowRuntime()')).toBeLessThan(body.indexOf('if (!DIRECTOR_ON) return'))
  })

  it('bails out on the same conditions the other directors do, but only after feeding its edge trackers', () => {
    const suppressed = adapter.slice(adapter.indexOf('const suppressed ='), adapter.indexOf('if (suppressed)'))
    for (const cond of ['s.autoPilot', "s.status !== 'running'", 'f.silence', 'cueState.governed', 'djCam.active', 'limitless.active', 'MANUAL_HOLD_SEC']) {
      expect(suppressed, cond).toContain(cond)
    }
    expect(adapter.indexOf('stepLegacyEvents(')).toBeLessThan(adapter.indexOf('if (suppressed)'))
    expect(adapter.indexOf('ctx.charShift.observe')).toBeLessThan(adapter.indexOf('if (suppressed)'))
  })

  it('performs a CUT through the armed release first, else the existing pickers, with the dwell bypass and a reason', () => {
    const cut = adapter.slice(adapter.indexOf('function performCut('), adapter.indexOf('/** Perform a MICRO'))
    expect(cut.indexOf("tryCommitArmed('show', drop, f, undefined, reason)")).toBeGreaterThan(0)
    expect(cut.indexOf("tryCommitArmed('show'")).toBeLessThan(cut.indexOf('pickAndRequest('))
    expect(cut).toContain('bypassDwell: true, reason')
    expect(cut).toContain('immediate: drop')
    expect(cut).toContain('ackCut(ctx.show, false')
    // never replace a switch already landing, except for a drop
    expect(cut).toMatch(/!drop && s\.pendingSceneId !== null && s\.pendingSceneId !== s\.heldSceneId/)
    const pick = adapter.slice(adapter.indexOf('function coldPick('), adapter.indexOf('/**\n * Perform a CUT'))
    expect(pick).toContain('pickHypeScene(f, s, sceneLook, exclude)')
    expect(pick).toContain('pickByCharacter(')
    expect(pick).toContain('pickVariedScene(')
    expect(pick).toContain('!breakdown || notHeavy(sc)') // the breakdown non-heavy restriction
  })

  it('performs a MICRO through the existing helpers (palette / mode / layers by mailbox, effects by advanceEffects)', () => {
    const micro = adapter.slice(adapter.indexOf('function performMicro('), adapter.indexOf('/** Copy the numbers'))
    expect(micro).toContain('showRuntime.palette = true')
    expect(micro).toContain('showRuntime.mode = true')
    expect(micro).toContain('showRuntime.layers = LAYERS_MICRO')
    expect(micro).toContain('advanceEffects({')
  })
})
