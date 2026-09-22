import { describe, expect, it } from 'vitest'
import { shouldHardCut } from '../CameraDirector'

/**
 * `look.cameraCutRate` reaching the camera (the "Camera cut-rate fix" plan section): `shouldHardCut` is the pure
 * probability check `PerformanceStateBridge`'s phrase-boundary block samples once per phrase — see that file's
 * `cutDue` construction, which is left untested in isolation the same way `arousalDue` a few lines above it
 * already is (neither is exported; both are glue in a `useFrame` callback that composes already-tested pure
 * functions — `arousalDue` reads `AROUSAL_CUT_THRESHOLD`/`phraseBoundary`/`lastCameraBeat`, `cutDue` reads this
 * function plus the same `phraseBoundary`/`L.valid`/`L.families.camera` gates — and verified here only by reading
 * PerformanceStateBridge.tsx directly, not by a harness around `useFrame`).
 */

describe('shouldHardCut', () => {
  it('never fires at cutRate 0', () => {
    for (let k = 0; k < 300; k++) expect(shouldHardCut(0, k)).toBe(false)
  })

  it('always fires at cutRate 1', () => {
    for (let k = 0; k < 300; k++) expect(shouldHardCut(1, k)).toBe(true)
  })

  it('fires close to half the counters at cutRate 0.5', () => {
    // Same tolerance convention as rotationUnit/pickIndexByWeight's own "selects options in proportion to their
    // weights" test (transitions.look.test.ts): 5000 counters, 2 decimal places.
    const n = 5000
    let hits = 0
    for (let k = 0; k < n; k++) if (shouldHardCut(0.5, k)) hits++
    expect(hits / n).toBeCloseTo(0.5, 2)
  })

  it('fires in proportion to cutRate at other values too', () => {
    const n = 5000
    for (const rate of [0.1, 0.25, 0.75, 0.9]) {
      let hits = 0
      for (let k = 0; k < n; k++) if (shouldHardCut(rate, k)) hits++
      expect(hits / n, `rate=${rate}`).toBeCloseTo(rate, 2)
    }
  })

  it('clamps a cutRate above 1 to "always"', () => {
    for (const rate of [1.5, 2, 1e6]) {
      for (let k = 0; k < 50; k++) expect(shouldHardCut(rate, k), `rate=${rate}`).toBe(true)
    }
  })

  it('clamps a negative cutRate to "never"', () => {
    for (const rate of [-0.1, -1, -1e6]) {
      for (let k = 0; k < 50; k++) expect(shouldHardCut(rate, k), `rate=${rate}`).toBe(false)
    }
  })

  it('is NaN/non-finite-safe: never throws, never fires', () => {
    // Matches the constant's own doc: non-finite is the safe "never cut" default, the same direction as
    // `rotationUnit`'s own "NaN -> 0" fold, not the identity-1 direction `lookGain` uses elsewhere in this file
    // (that function's safe default is "no gain change"; this one's is "no extra cut").
    for (const rate of [NaN, Infinity, -Infinity]) {
      for (const k of [0, 1, 100, NaN, -5]) {
        expect(() => shouldHardCut(rate, k)).not.toThrow()
        expect(shouldHardCut(rate, k), `rate=${rate} k=${k}`).toBe(false)
      }
    }
  })

  it('is deterministic: the same counter always returns the same answer', () => {
    for (const rate of [0, 0.3, 0.5, 0.7, 1]) {
      for (const k of [0, 1, 7, 16, 1000]) {
        expect(shouldHardCut(rate, k)).toBe(shouldHardCut(rate, k))
      }
    }
  })

  it('handles negative, fractional and non-finite counters without throwing (folded by rotationUnit)', () => {
    for (const k of [-5, 2.9, NaN, Infinity, -Infinity]) {
      expect(() => shouldHardCut(0.5, k)).not.toThrow()
    }
  })

  it('counter 0 is deterministic across rates, same as rotationUnit(0) === 0', () => {
    // rotationUnit(0) is 0 by construction, so counter 0 fires whenever cutRate > 0 and never when it is exactly 0.
    expect(shouldHardCut(0, 0)).toBe(false)
    expect(shouldHardCut(0.01, 0)).toBe(true)
    expect(shouldHardCut(1, 0)).toBe(true)
  })
})
