import { describe, expect, it } from 'vitest'
import AUTOPILOT_SRC from '../AutoPilot.tsx?raw'
import DIRECTOR_SRC from '../PerformanceDirector.tsx?raw'
import SCENEMANAGER_SRC from '../SceneManager.tsx?raw'

/**
 * AutoPilot, PerformanceDirector and SceneManager are React frame hooks with no node harness, so the parts of the
 * armed-scene wiring whose ORDER or GUARD is what makes them correct are pinned at the source level (the same idiom
 * as the wipe-priority pin in `transitionWipe.test.ts`). Behaviour itself is covered by `armedChange.test.ts` (the
 * state machine), `armedPick.test.ts` (scoring and picking), `armedDirector.test.ts` (the store-facing commit),
 * `armedStore.test.ts` (the store actions) and `dropCommit.test.ts` (`resolveCommit`).
 */
const src = AUTOPILOT_SRC.replace(/\r\n/g, '\n')
const pd = DIRECTOR_SRC.replace(/\r\n/g, '\n')

describe('AutoPilot: constantly armed scene wiring', () => {
  it('steps the armed state BEFORE the early returns, so an edge during a manual hold is consumed, not fired late', () => {
    const step = src.indexOf('stepArmed(armed, {')
    const firstReturn = src.indexOf("if (!s.autoPilot || s.status !== 'running' || f.silence) return")
    expect(step).toBeGreaterThan(0)
    expect(firstReturn).toBeGreaterThan(step)
  })

  it('takes the flag and the shared state from armedDirector, not from a local copy', () => {
    expect(src).toMatch(/ARM_ENABLED,\s+activeLook,/)
    expect(src).toContain('const armed = armedRuntime.state')
    expect(src).not.toMatch(/const ARM_ENABLED = !armOff\(\)/)
  })

  it('feeds suppression from every automation bail-out, but never from silence (a pre-drop gap keeps the arm)', () => {
    const block = src.slice(src.indexOf('suppressed:'), src.indexOf('silent: f.silence'))
    for (const cond of ['s.autoPilot', "s.status !== 'running'", 'cueState.governed', 'djCam.active', 'limitless.active', 'MANUAL_HOLD_SEC']) {
      expect(block, cond).toContain(cond)
    }
    expect(block).not.toContain('f.silence')
  })

  it('re-scores the armed scene on the fit clock, and at once on a build\'s rising edge', () => {
    expect(src).toMatch(/fitCheckDue\(armed, beat, buildEdge\)\s+\? armedFitNow\(f, s, armed\.armed\.sceneId\)/)
  })

  it('hands the state machine every confirm signal it needs', () => {
    const call = src.slice(src.indexOf('stepArmed(armed, {'), src.indexOf("if (action.type === 'disarm')"))
    for (const field of [
      'lastCommitBeat: s.lastCommitBeat',
      'sectionEdge: f.structureValid && f.songSection.boundaryChanged',
      'phraseStrength: f.sectionChange ? f.sectionChangeStrength : 0',
      'phraseEdge: isPhraseEdge(f.beat, f.beatInBar, f.bar)',
      'energy: f.energy',
      'transitionActive: performanceState.transition.active',
      'canDwell: canAutoSwitch(s.lastCommitBeat, beat)',
    ]) {
      expect(call, field).toContain(field)
    }
  })

  it('keeps the original 1-3-beat pre-arm as the off-path: skipped only when the armed path can act', () => {
    expect(src).toMatch(/!\(ARM_ENABLED && quality\.tier <= ARM\.maxTier\) &&\s+inSustain &&\s+!preArmed\.current/)
    expect(src).toMatch(/s\.requestScene\(armPick\.id, \{ auto: true, immediate: false \}\)/)
  })

  it('a drop the armed scene answered does not request a second scene', () => {
    expect(src).toMatch(/dropEdge && \(preArmed\.current \|\| armedConfirmedDrop \|\| dropPickSuppressed\(armedRuntime\.state,/)
  })

  it('only a hold that was really released counts as having answered the drop', () => {
    expect(src).toMatch(/const released = s\.releaseHold\(action\.immediate\)/)
    expect(src).toMatch(/armedConfirmedDrop = released && action\.trigger === 'drop'/)
  })

  it('a `released` disarm gives nothing back to the store (a director already released the hold)', () => {
    expect(src).toMatch(/if \(action\.reason !== 'released'\) s\.disarmScene\(\)/)
  })

  it('clears a stale hold without touching whatever is pending', () => {
    expect(src).toMatch(/armed\.armed === null && s\.heldSceneId !== null/)
    expect(src).toMatch(/useStore\.setState\(\{ heldSceneId: null \}\)/)
  })

  it('arms through armScene (the hold), never through requestScene, choosing from the music (pickArmScene)', () => {
    const armBranch = src.slice(src.indexOf("action.type === 'arm'"), src.indexOf('armRefused(armed'))
    expect(armBranch).toContain('s.armScene(scene.id)')
    expect(armBranch).toContain('pickArmScene(f, s, exclude, trend)')
    expect(armBranch).not.toContain('requestScene')
    expect(armBranch).toContain('armReason(f, s, placed.id, trend)')
  })

  it('a MOOD-driven change prefers the armed scene; only then does a cold pick run', () => {
    const guard = src.indexOf('if (s.pendingSceneId && s.pendingSceneId !== s.heldSceneId && !dropEdge) return')
    const prefer = src.indexOf("if (!dropEdge && tryCommitArmed('mood', false, f)) return")
    const cold = src.indexOf('const candidates = getPrimaryScenesForMood(target)')
    expect(guard).toBeGreaterThan(0)
    expect(prefer).toBeGreaterThan(guard)
    expect(cold).toBeGreaterThan(prefer)
  })

  it('a held (armed) scene does not count as a switch in flight for the build switch, which prefers it too', () => {
    expect(src).toMatch(/hasPending: s\.pendingSceneId !== null && s\.pendingSceneId !== s\.heldSceneId/)
    const build = src.slice(src.indexOf('buildState.current.fired = true'), src.indexOf('const { scene: switched }'))
    expect(build).toContain("tryCommitArmed('build', false, f)")
  })

  it('the hype pick is one shared function for the off-path pre-arm', () => {
    expect(src.match(/pickHypeScene\(/g)?.length).toBeGreaterThanOrEqual(2) // definition + pre-arm
    expect(src.match(/minArousal: 0\.85/g)?.length).toBe(1)
  })
})

describe('PerformanceDirector: prefers the armed scene at a boundary', () => {
  it('treats a held (armed) pending scene as not landing: layers sit on the current scene until it is released', () => {
    expect(pd).toMatch(/const heldPending = s\.heldSceneId !== null && s\.heldSceneId === s\.pendingSceneId/)
    expect(pd).toMatch(/let primaryId = s\.pendingSceneId && !heldPending \? s\.pendingSceneId : s\.sceneId/)
  })

  it('commits the armed scene first; only otherwise does a fresh (cold) pick run', () => {
    expect(pd).toMatch(/const armedTaken = heldPending && tryCommitArmed\('boundary', false, f\)/)
    expect(pd).toMatch(/if \(armedTaken\) primaryId = s\.heldSceneId as string/)
    expect(pd).toMatch(/if \(!armedTaken && \(!s\.pendingSceneId \|\| heldPending\) && primaryCandidates\.length > 0\)/)
  })
})

describe('SceneManager: held scene wiring', () => {
  const sm = SCENEMANAGER_SRC.replace(/\r\n/g, '\n')

  it('passes the held flag into resolveCommit, matched against the pending id so a stale hold cannot freeze a request', () => {
    expect(sm).toMatch(/const held = state\.heldSceneId !== null && state\.heldSceneId === pendingSceneId/)
    expect(sm).toMatch(/waited,\s+held,\s+\}\)/)
  })

  it('pins the wait clock while held, so a release starts from ~0 rather than the 2.5 s backstop', () => {
    expect(sm).toMatch(/if \(held\) pendingSince\.current = clock\.elapsedTime/)
  })

  it('suspends frame sampling when an armed scene mounts, so its compile is not read as load (no arm -> demote -> disarm loop)', () => {
    expect(sm).toMatch(/if \(held\) suspendFrameSampling\(WARM_FRAMES \* 4 \+ 30\)/)
  })

  it('records boot-prewarmed scenes as compiled, so arming prefers them', () => {
    expect(sm).toMatch(/prewarmScene\(bootId, gl\)\s+\/\/[^\n]*\n\s+sceneStreamer\.markCompiled\(bootId\)/)
  })
})
