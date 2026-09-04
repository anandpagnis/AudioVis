import { describe, expect, it } from 'vitest'
import { HANDOFF_GRACE_MS, LOOK_FIELDS, shouldAdoptStatus } from '../outputLink'
import LINK_SRC from '../outputLink.ts?raw'
import { useStore } from '../../store'

/**
 * The rule that decides whether the control window believes the output window
 * about what is playing.
 *
 * Worth a test of its own because getting it wrong is silent: every
 * screen-share start failed with no error anywhere, and the file path — which
 * awaits nothing between claiming `starting` and handing over — kept working,
 * so the suite stayed green.
 */
describe('shouldAdoptStatus', () => {
  const idle = { status: 'idle', hasSource: false }
  const running = { status: 'running', hasSource: true }

  it('defers to the output window when nothing is being handed over', () => {
    expect(shouldAdoptStatus(idle, false)).toBe(true)
    expect(shouldAdoptStatus(running, false)).toBe(true)
  })

  it('ignores an idle output while a hand-off is in flight', () => {
    // THE BUG. The console sets `starting` and opens the share picker; the
    // output window is still idle and says so every 100 ms. Adopting that wrote
    // `idle` over `starting`, and when the picker resolved the cancellation
    // guard read `idle`, concluded the user had backed out, and stopped the
    // tracks it had just been granted.
    expect(shouldAdoptStatus(idle, true)).toBe(false)
  })

  it('believes the output window the moment it actually has a source', () => {
    // The exemption has to end on evidence, not on a timer alone: once there is
    // a graph over there, its status is the truth whatever this window thinks.
    expect(shouldAdoptStatus(running, true)).toBe(true)
    expect(shouldAdoptStatus({ status: 'error', hasSource: true }, true)).toBe(true)
  })

  it('never adopts an empty status', () => {
    expect(shouldAdoptStatus({ status: '', hasSource: true }, false)).toBe(false)
  })
})

describe('the hand-off grace period', () => {
  it('outlasts the share picker it exists to cover', () => {
    // AudioEngine gives the picker 60 s before it gives up. A grace shorter
    // than that re-opens the bug for anyone who takes their time choosing a
    // window — which is most people, the first time.
    expect(HANDOFF_GRACE_MS).toBeGreaterThan(60_000)
  })
})

/**
 * The manual filter request has to survive the trip to the output window, and
 * the failure mode here is silent in both directions — a chip that does
 * nothing, with no error anywhere.
 *
 * Two separate things are pinned, because they break independently:
 *
 *  1. `pendingFilterId` has to be a LOOK FIELD at all. The console does not
 *     run a `FilterDirector` — nothing over there consumes the request — so a
 *     request that is not mirrored downward reaches nobody. This is the same
 *     bug `pendingSceneId`'s own comment in `LOOK_FIELDS` records having
 *     already been measured once ("the output sat on `wireframe` through every
 *     press").
 *  2. `filterRequestNonce` has to ride along with it. `outputLink` publishes
 *     only when a look value actually CHANGES, and only the control window
 *     publishes — the output applies looks and never echoes back. So when the
 *     output's director consumes a request and clears its own copy, the
 *     console's copy stays at the id it last sent, and a second click on the
 *     same chip would write an identical value, change nothing, publish
 *     nothing, and fire nothing.
 */
describe('the manual filter request crosses the window boundary', () => {
  it('mirrors both the request and its nonce downward', () => {
    expect(LOOK_FIELDS).toContain('pendingFilterId')
    expect(LOOK_FIELDS).toContain('filterRequestNonce')
  })

  it('bumps the nonce on every request, so a repeat id still publishes', () => {
    const s = () => useStore.getState()
    s().requestFilter('Bad TV')
    const first = s().filterRequestNonce
    expect(s().pendingFilterId).toBe('Bad TV')

    // The output window consumes and clears ITS copy; this window's stays put.
    // Simulated here by clearing, which is what the director calls.
    s().clearFilterRequest()

    // Same id again — the id alone is therefore NOT a change from what was
    // last published ('Bad TV'), which is precisely why the nonce exists.
    s().requestFilter('Bad TV')
    expect(s().filterRequestNonce).toBeGreaterThan(first)
  })

  it('reports the firing filter back up on telemetry rather than letting the console guess', () => {
    // The console cannot know this: the director fires autonomously too, and
    // can refuse a request it judges invalid. Same reasoning as `status`.
    //
    // A source check, and labelled as one: `Telemetry` is an interface, so
    // there is no runtime key list to assert against, and standing up two
    // BroadcastChannel-connected windows to read one field back would be
    // testing the harness more than the wire.
    expect(LINK_SRC).toMatch(/filterId:\s*performanceState\.filter\.id/)
    expect(LINK_SRC).toMatch(/filterMix:\s*performanceState\.filter\.mix/)
  })
})

/**
 * The console shows which scenes are on screen across every slot, and it cannot
 * work any of it out for itself — same asymmetry `startLink` documents and the
 * filter test above already leans on: only the CONTROL window publishes look
 * state, the output applies it and never echoes back.
 *
 * Source checks, and labelled as such for the reason the filter test gives:
 * `Telemetry` is an interface, so there is no runtime key list to assert
 * against, and standing up two BroadcastChannel-connected windows to read two
 * fields back would test the harness rather than the wire.
 */
describe('the whole composition is reported back up on telemetry', () => {
  it('publishes the MOUNTED layers, not the desire the console already holds', () => {
    // The distinction is the entire point of the field. `layerSceneIds` is a
    // request; `resolveLayerIds` can refuse it for budget and an admitted layer
    // still mounts invisibly until its shader compiles. The session recording
    // behind `performanceState.mountedLayers` caught 12 of 22 layer desires
    // living 20-90 ms and being withdrawn with nothing ever drawn — every one
    // of which would light a slot in a console reading the request.
    expect(LINK_SRC).toMatch(/mountedLayers:\s*\{[^}]*\bml\.background\b/)
    expect(LINK_SRC).toMatch(/const ml = performanceState\.mountedLayers/)
    // The failure this guards is a "simplification" to the desire, which would
    // typecheck perfectly and be wrong in exactly the withdrawn-layer case.
    expect(LINK_SRC).not.toMatch(/mountedLayers:\s*performanceState\.layers\b/)
    expect(LINK_SRC).not.toMatch(/mountedLayers:.*layerSceneIds/)
  })

  it('publishes the live effect firings by scene id', () => {
    // Transient by nature: 1.2-4.0s per firing against a 100ms poll, so a
    // consumer is meant to see these appear and disappear.
    expect(LINK_SRC).toMatch(/activeEffects:\s*performanceState\.layers\.effects\.map/)
  })
})
