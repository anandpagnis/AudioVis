import { describe, expect, it } from 'vitest'
import AUTOPILOT_SRC from '../AutoPilot.tsx?raw'
import SCENEMANAGER_SRC from '../SceneManager.tsx?raw'

/**
 * AutoPilot is a React frame hook with no node harness, so the parts of the armed-scene wiring whose ORDER or
 * GUARD is what makes them correct are pinned at the source level (the same idiom as the wipe-priority pin in
 * `transitionWipe.test.ts`). Behaviour itself is covered by `armedChange.test.ts` (the state machine),
 * `armedStore.test.ts` (the store actions) and `dropCommit.test.ts` (`resolveCommit`).
 */
const src = AUTOPILOT_SRC.replace(/\r\n/g, '\n')

describe('AutoPilot: armed drop scene wiring', () => {
  it('steps the armed state BEFORE the early returns, so an edge during a manual hold is consumed, not fired late', () => {
    const step = src.indexOf('stepArmed(armed, {')
    const firstReturn = src.indexOf("if (!s.autoPilot || s.status !== 'running' || f.silence) return")
    expect(step).toBeGreaterThan(0)
    expect(firstReturn).toBeGreaterThan(step)
  })

  it('reads the flag once at module load, from the same helper family as ?tempo', () => {
    expect(src).toMatch(/const ARM_ENABLED = !armOff\(\)/)
  })

  it('feeds suppression from every automation bail-out, but never from silence (a pre-drop gap keeps the arm)', () => {
    const block = src.slice(src.indexOf('suppressed:'), src.indexOf('silent: f.silence'))
    for (const cond of ['s.autoPilot', "s.status !== 'running'", 'cueState.governed', 'djCam.active', 'limitless.active', 'MANUAL_HOLD_SEC']) {
      expect(block, cond).toContain(cond)
    }
    expect(block).not.toContain('f.silence')
  })

  it('keeps the original 1-3-beat pre-arm as the off-path: skipped only when the armed path can act', () => {
    expect(src).toMatch(/!\(ARM_ENABLED && quality\.tier <= ARM\.maxTier\) &&\s+inSustain &&\s+!preArmed\.current/)
    // ...and it still requests with immediate:false, exactly as before.
    expect(src).toMatch(/s\.requestScene\(armPick\.id, \{ auto: true, immediate: false \}\)/)
  })

  it('a drop the armed scene answered does not request a second scene', () => {
    expect(src).toMatch(/dropEdge && \(preArmed\.current \|\| armedConfirmedDrop \|\| dropPickSuppressed\(/)
  })

  it('only a hold that was really released counts as having answered the drop', () => {
    expect(src).toMatch(/const released = s\.releaseHold\(action\.immediate\)/)
    expect(src).toMatch(/armedConfirmedDrop = released && action\.trigger === 'drop'/)
  })

  it('clears a stale hold without touching whatever is pending', () => {
    expect(src).toMatch(/armed\.armed === null && s\.heldSceneId !== null/)
    expect(src).toMatch(/useStore\.setState\(\{ heldSceneId: null \}\)/)
  })

  it('arms through armScene (the hold), never through requestScene', () => {
    const armBranch = src.slice(src.indexOf("action.type === 'arm'"), src.indexOf('armRefused(armed'))
    expect(armBranch).toContain('s.armScene(scene.id)')
    expect(armBranch).not.toContain('requestScene')
  })

  it('the hype pick is one shared function, so the armed path and the pre-arm cannot drift apart', () => {
    expect(src.match(/pickHypeScene\(/g)?.length).toBeGreaterThanOrEqual(3) // definition + armed path + pre-arm
    expect(src).toMatch(/minArousal: 0\.85/)
    expect(src.match(/minArousal: 0\.85/g)?.length).toBe(1)
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
})
