import { describe, expect, it } from 'vitest'
import { LensPass } from '../LensPass'

/**
 * `LENS_HARD_DISABLED` (F142) keeps the lens rack off for every ordinary
 * scene; DJ Cam is the one deliberate exception (docs/13_DJ_Cam.md) — see
 * `advance()`'s `djCamActive` param. No GL context is available in this suite
 * (vitest runs in `node`), same posture as `isfFilterPass.test.ts`: what's
 * checkable off-GPU is `Pass.enabled`, which is exactly the switch this
 * behaviour turns on, not that the shader draws anything.
 */
const NO_AUDIO = { kick: 0, highs: 0, mids: 0, onKick: 0 }

describe('LensPass — DJ Cam kill-switch bypass', () => {
  it('stays off on a normal scene even with an engaged rack', () => {
    const pass = new LensPass()
    pass.advance({ amount: 0.8, style: 2 }, 1 / 60, NO_AUDIO, false)
    expect(pass.enabled).toBe(false)
  })

  it('turns on during a DJ Cam cutaway with an engaged rack', () => {
    const pass = new LensPass()
    pass.advance({ amount: 0.8, style: 2 }, 1 / 60, NO_AUDIO, true)
    expect(pass.enabled).toBe(true)
  })

  it('stays off during a DJ Cam cutaway when the rack has nothing engaged', () => {
    const pass = new LensPass()
    pass.advance({ amount: 0, style: 2 }, 1 / 60, NO_AUDIO, true)
    expect(pass.enabled).toBe(false)
  })
})
