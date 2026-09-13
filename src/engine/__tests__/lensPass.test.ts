import { describe, expect, it } from 'vitest'
import { LensPass } from '../LensPass'

/**
 * `LENS_HARD_DISABLED` (F142) held the lens rack off for every ordinary
 * scene from 2026-08-29 until F229 (2026-09-12) re-enabled it, once the
 * actual complaint behind F142 — `ambient`/`mellow` drawing near-exclusively
 * from a two-item glass pool, not the materials being bad per se — was fixed
 * at the picker level (`opticalDirector.ts`'s `lensForSection`). DJ Cam's
 * bypass (`advance()`'s `djCamActive` param) predates that and is now a
 * no-op in practice, since the general switch is off — but it is exercised
 * here anyway so it stays correct if `LENS_HARD_DISABLED` is ever flipped
 * back on for a future look complaint. No GL context is available in this
 * suite (vitest runs in `node`), same posture as `isfFilterPass.test.ts`:
 * what's checkable off-GPU is `Pass.enabled`, which is exactly the switch
 * this behaviour turns on, not that the shader draws anything.
 */
const NO_AUDIO = { kick: 0, highs: 0, mids: 0, onKick: 0 }

describe('LensPass — re-enabled after F229', () => {
  it('engages on an ordinary scene now that the F142 kill switch is off', () => {
    const pass = new LensPass()
    pass.advance({ amount: 0.8, style: 2 }, 1 / 60, NO_AUDIO, false)
    expect(pass.enabled).toBe(true)
  })

  it('also engages during a DJ Cam cutaway — the bypass still composes', () => {
    const pass = new LensPass()
    pass.advance({ amount: 0.8, style: 2 }, 1 / 60, NO_AUDIO, true)
    expect(pass.enabled).toBe(true)
  })

  it('stays off with nothing engaged, on or off DJ Cam — the kill switch was never the only gate', () => {
    const pass = new LensPass()
    pass.advance({ amount: 0, style: 2 }, 1 / 60, NO_AUDIO, false)
    expect(pass.enabled).toBe(false)
    pass.advance({ amount: 0, style: 2 }, 1 / 60, NO_AUDIO, true)
    expect(pass.enabled).toBe(false)
  })
})
