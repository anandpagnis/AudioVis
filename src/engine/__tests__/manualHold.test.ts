import { describe, expect, it } from 'vitest'
import { audioEngine } from '../../audio/AudioEngine'
import { manualHoldActive, useStore, wallSeconds } from '../../store'
import AUTOPILOT_SRC from '../AutoPilot.tsx?raw'
import DIRECTOR_SRC from '../PerformanceDirector.tsx?raw'
import ADAPTER_SRC from '../show/showAdapter.tsx?raw'
import STORE_SRC from '../../store.ts?raw'

/**
 * The manual back-off ("the DJ touched something, stay out of the way for 45 s") must live on ONE clock. `features.time`
 * is `performance.now() / 1000` while idle but `AudioContext.currentTime` (0 at context creation) while audio runs, so
 * stamping with one and comparing with the other silenced ALL automation (colour changes included) for minutes after a
 * single click, and for the first 45 s of every session because the stamp started at 0.
 */
describe('manual back-off clock', () => {
  it('a store that was never touched has no back-off, whatever the clocks read', () => {
    const fresh = useStore.getInitialState().lastManualAt
    expect(manualHoldActive(fresh, 45)).toBe(false)
    expect(manualHoldActive(fresh, 45, 0)).toBe(false) // even at wall-clock second 0
    expect(manualHoldActive(fresh, 45, 12)).toBe(false)
  })

  it('is active for holdSec after a touch and then lifts', () => {
    expect(manualHoldActive(100, 45, 100)).toBe(true)
    expect(manualHoldActive(100, 45, 144.9)).toBe(true)
    expect(manualHoldActive(100, 45, 145)).toBe(false)
    expect(manualHoldActive(100, 45, 5000)).toBe(false)
  })

  it('does not depend on the audio clock: a small AudioContext time cannot keep it active', () => {
    // The old test was `features.time - lastManualAt < 45`; with lastManualAt on the wall clock (e.g. 3000 s of uptime)
    // and features.time on the audio clock (e.g. 20 s) that is always true. The helper reads the wall clock only.
    const stamp = wallSeconds() - 60
    const savedTime = audioEngine.features.time
    audioEngine.features.time = 20
    try {
      expect(manualHoldActive(stamp, 45)).toBe(false)
    } finally {
      audioEngine.features.time = savedTime
    }
  })

  it('every director uses the helper, and nothing compares features.time with lastManualAt any more', () => {
    for (const src of [AUTOPILOT_SRC, DIRECTOR_SRC, ADAPTER_SRC]) {
      const s = (src as string).replace(/\r\n/g, '\n')
      expect(s).toContain('manualHoldActive(')
      expect(s).not.toMatch(/f\.time\s*-\s*s\.lastManualAt/)
    }
    const store = (STORE_SRC as string).replace(/\r\n/g, '\n')
    expect(store).not.toMatch(/lastManualAt:\s*audioEngine\.features\.time/)
    expect(store).not.toMatch(/lastManualAt:\s*performance\.now\(\)\s*\/\s*1000/)
    expect(store).toContain('lastManualAt: -1e9')
    expect(store.match(/lastManualAt: wallSeconds\(\)/g)?.length).toBe(4)
  })
})
