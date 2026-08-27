import { describe, expect, it } from 'vitest'
import { getEffectScenes } from '../index'

/**
 * The one requirement that kept the effect role unclaimed for so long.
 *
 * `SceneManager` retires an effect entry the moment `slotProgress` reaches 1
 * and does NOT fade it out — so a scene still bright there simply vanishes,
 * which reads as a dropped frame rather than as punctuation. It is the sort of
 * contract that is invisible until someone writes the second effect scene and
 * forgets it.
 *
 * The envelope itself lives in `OrbitGlowScene`; this pins the shape it has to
 * have, against a local copy, so a future scene has something to check against.
 */
function effectEnvelope(p: number): number {
  const t = Math.min(1, Math.max(0, p))
  const rise = t < 0.05 ? t / 0.05 : 1
  const fall = 1 - (t - 0.18) / 0.82
  return rise * Math.max(0, Math.min(1, fall)) ** 1.6
}

describe('the effect slot exit contract', () => {
  it('is exactly zero at slotProgress 1, where SceneManager retires it', () => {
    expect(effectEnvelope(1)).toBe(0)
  })

  it('rises fast enough to land on the transient that fired it', () => {
    // A drop is an instant. An effect that takes half a second to arrive has
    // already missed the thing it is punctuating.
    expect(effectEnvelope(0.05)).toBeGreaterThan(0.9)
  })

  it('spends most of its life decaying', () => {
    // What makes a drop read as a hit followed by a room, rather than as a
    // shape that came and went.
    expect(effectEnvelope(0.5)).toBeLessThan(effectEnvelope(0.2))
    expect(effectEnvelope(0.9)).toBeLessThan(0.1)
  })

  it('never leaves the 0..1 range, including outside its domain', () => {
    for (const p of [-1, 0, 0.5, 1, 2, 99]) {
      const v = effectEnvelope(p)
      expect(v, `p=${p}`).toBeGreaterThanOrEqual(0)
      expect(v, `p=${p}`).toBeLessThanOrEqual(1)
    }
  })

  it('has no step at either end', () => {
    // A hard edge at 1 looks like a dropped frame, which is the impression the
    // effect slot exists to avoid.
    expect(effectEnvelope(0.99)).toBeLessThan(0.02)
    expect(effectEnvelope(0.01)).toBeLessThan(0.35)
  })
})

describe('the registered effect scenes', () => {
  it('are none, until a licensed scene claims the role', () => {
    // See F105. The envelope contract above is still pinned — it is what the
    // NEXT effect scene has to satisfy, and it outlives any particular scene.
    expect(getEffectScenes().length).toBe(0)
  })
})
