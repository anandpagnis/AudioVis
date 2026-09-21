import { describe, expect, it } from 'vitest'
import { TIMBRE_TAU_SEC, TimbreDescriptors, type TimbreFeatureFrame } from '../TimbreDescriptors'
import { TIMBRE_CALIBRATION, type TimbreCalibration } from '../timbreQuantiles'
import { createEmptyFeatures } from '../types'

/** Identity-shaped tables (value == percentile) so these tests do not depend on the generated ones. */
const LINEAR = Array.from({ length: 21 }, (_, i) => i / 20)
const CAL: TimbreCalibration = {
  features: {
    loudness: LINEAR,
    flux: LINEAR,
    roughness: LINEAR,
    tonalness: LINEAR,
    modeAmbiguity: LINEAR,
  },
  composites: { harsh: LINEAR, busy: LINEAR, sparse: LINEAR },
  source: 'test',
}

function frame(over: Partial<TimbreFeatureFrame> = {}): TimbreFeatureFrame {
  return {
    loudness: 0.5,
    flux: 0.5,
    keyValid: false,
    keyModeStrength: 0,
    harmonicTensionValid: true,
    harmonicRoughness: 0.5,
    harmonicTonalness: 0.5,
    silence: false,
    ...over,
  }
}

const HARSH = { harmonicRoughness: 0.9, harmonicTonalness: 0.1 }
const SMOOTH = { harmonicRoughness: 0.1, harmonicTonalness: 0.9 }

function run(d: TimbreDescriptors, f: TimbreFeatureFrame, seconds: number, dt = 1 / 60) {
  const n = Math.round(seconds / dt)
  for (let i = 0; i < n; i++) d.update(f, dt)
  return d.read()
}

const KEYS = ['harsh', 'busy', 'sparse'] as const

describe('TimbreDescriptors', () => {
  it('starts neutral (0.5) and is satisfiable by the live AudioFeatures shape', () => {
    const d = new TimbreDescriptors(CAL)
    expect(d.read()).toEqual({ harsh: 0.5, busy: 0.5, sparse: 0.5 })
    // Compile-time check: the engine passes `features` straight in.
    const live: TimbreFeatureFrame = createEmptyFeatures()
    expect(typeof live.harmonicTonalness).toBe('number')
  })

  it('stays in 0..1 for every combination of extreme inputs, with linear and shipped tables', () => {
    const vals = [0, 0.25, 0.5, 0.75, 1]
    for (const cal of [CAL, TIMBRE_CALIBRATION]) {
      const d = new TimbreDescriptors(cal)
      for (const loudness of vals)
        for (const flux of vals)
          for (const r of vals)
            for (const t of vals)
              for (const keyValid of [false, true]) {
                d.update(
                  frame({
                    loudness,
                    flux,
                    harmonicRoughness: r,
                    harmonicTonalness: t,
                    keyValid,
                    keyModeStrength: r * 2 - 1,
                  }),
                  0.05,
                )
                for (const k of KEYS) {
                  expect(d.read()[k]).toBeGreaterThanOrEqual(0)
                  expect(d.read()[k]).toBeLessThanOrEqual(1)
                }
              }
    }
  })

  it('is NaN/Infinity-safe, ignores non-positive or NaN dt, and returns the same object every call', () => {
    const d = new TimbreDescriptors(CAL)
    const r = d.read()
    const junk = frame({
      loudness: Number.NaN,
      flux: Number.POSITIVE_INFINITY,
      harmonicRoughness: -5,
      harmonicTonalness: 9,
      keyValid: true,
      keyModeStrength: Number.NaN,
    })
    run(d, junk, 10)
    for (const k of KEYS) {
      expect(Number.isFinite(r[k])).toBe(true)
      expect(r[k]).toBeGreaterThanOrEqual(0)
      expect(r[k]).toBeLessThanOrEqual(1)
    }

    const e = new TimbreDescriptors(CAL)
    const before = { ...e.read() }
    e.update(frame(HARSH), 0)
    e.update(frame(HARSH), -1)
    e.update(frame(HARSH), Number.NaN)
    expect(e.read()).toEqual(before)
    e.update(frame(HARSH), Number.POSITIVE_INFINITY) // a huge dt saturates the filter, it must not produce NaN
    for (const k of KEYS) expect(Number.isFinite(e.read()[k])).toBe(true)
    expect(e.read()).toBe(e.read())
  })

  it('holds the last read through silence, and stays neutral if it never heard anything', () => {
    const d = new TimbreDescriptors(CAL)
    run(d, frame({ ...HARSH, flux: 0.9, loudness: 0.9, keyValid: true, keyModeStrength: 0 }), 12)
    const before = { ...d.read() }
    run(d, frame({ silence: true, ...SMOOTH, flux: 0, loudness: 0 }), 30)
    expect(d.read()).toEqual(before)

    const fresh = new TimbreDescriptors(CAL)
    run(fresh, frame({ silence: true, ...HARSH }), 30)
    expect(fresh.read()).toEqual({ harsh: 0.5, busy: 0.5, sparse: 0.5 })
  })

  it('harsh rises with rougher and less tonal (noisier) input, and is neutral while the harmonic read is unknown', () => {
    const smooth = run(new TimbreDescriptors(CAL), frame(SMOOTH), 20).harsh
    const mid = run(new TimbreDescriptors(CAL), frame(), 20).harsh
    const rough = run(new TimbreDescriptors(CAL), frame(HARSH), 20).harsh
    expect(smooth).toBeLessThan(mid)
    expect(mid).toBeLessThan(rough)
    expect(smooth).toBeLessThan(0.2)
    expect(rough).toBeGreaterThan(0.8)

    // Each cue on its own also pushes it the right way.
    const roughOnly = run(new TimbreDescriptors(CAL), frame({ harmonicRoughness: 0.9 }), 20).harsh
    const noisyOnly = run(new TimbreDescriptors(CAL), frame({ harmonicTonalness: 0.1 }), 20).harsh
    expect(roughOnly).toBeGreaterThan(mid)
    expect(noisyOnly).toBeGreaterThan(mid)

    const unknown = run(
      new TimbreDescriptors(CAL),
      frame({ ...HARSH, harmonicTensionValid: false }),
      20,
    ).harsh
    expect(unknown).toBeCloseTo(0.5, 6)
  })

  it('busy rises with denser onsets and a more ambiguous key, and does not depend on loudness', () => {
    const calm = run(
      new TimbreDescriptors(CAL),
      frame({ flux: 0.1, keyValid: true, keyModeStrength: 1 }),
      20,
    ).busy
    const mid = run(
      new TimbreDescriptors(CAL),
      frame({ flux: 0.5, keyValid: true, keyModeStrength: 0.5 }),
      20,
    ).busy
    const dense = run(
      new TimbreDescriptors(CAL),
      frame({ flux: 0.9, keyValid: true, keyModeStrength: 0 }),
      20,
    ).busy
    expect(calm).toBeLessThan(mid)
    expect(mid).toBeLessThan(dense)
    expect(calm).toBeLessThan(0.1)
    expect(dense).toBeGreaterThan(0.9)
    // Sign of the mode does not matter, only how clear it is.
    const minor = run(
      new TimbreDescriptors(CAL),
      frame({ flux: 0.5, keyValid: true, keyModeStrength: -0.5 }),
      20,
    ).busy
    expect(minor).toBeCloseTo(mid, 6)
    const loud = run(
      new TimbreDescriptors(CAL),
      frame({ flux: 0.5, loudness: 1, keyValid: true, keyModeStrength: 0.5 }),
      20,
    ).busy
    expect(loud).toBeCloseTo(mid, 6)
  })

  it('sparse is high for quiet and steady input, and falls with loudness or with density', () => {
    const quietSteady = run(
      new TimbreDescriptors(CAL),
      frame({ loudness: 0.1, flux: 0.05, keyValid: true, keyModeStrength: 1 }),
      20,
    ).sparse
    const loudSteady = run(
      new TimbreDescriptors(CAL),
      frame({ loudness: 0.9, flux: 0.05, keyValid: true, keyModeStrength: 1 }),
      20,
    ).sparse
    const quietBusy = run(
      new TimbreDescriptors(CAL),
      frame({ loudness: 0.1, flux: 0.95, keyValid: true, keyModeStrength: 0 }),
      20,
    ).sparse
    const loudBusy = run(
      new TimbreDescriptors(CAL),
      frame({ loudness: 0.9, flux: 0.95, keyValid: true, keyModeStrength: 0 }),
      20,
    ).sparse
    expect(quietSteady).toBeGreaterThan(0.8)
    expect(quietSteady).toBeGreaterThan(loudSteady)
    expect(quietSteady).toBeGreaterThan(quietBusy)
    expect(loudSteady).toBeGreaterThan(loudBusy)
    expect(quietBusy).toBeGreaterThan(loudBusy)
    expect(loudBusy).toBeLessThan(0.05)
  })

  it('seeds on the first non-silent frame (no slow ramp from neutral) and then settles with a ~4 s time constant', () => {
    const d = new TimbreDescriptors(CAL)
    d.update(frame(SMOOTH), 1 / 60)
    expect(d.read().harsh).toBeCloseTo(0.1, 6) // seeded straight to the first frame's value

    run(d, frame(SMOOTH), 20)
    const base = d.read().harsh
    const target = 0.9
    run(d, frame(HARSH), TIMBRE_TAU_SEC) // one time constant later
    const frac = (d.read().harsh - base) / (target - base)
    expect(frac).toBeGreaterThan(0.58)
    expect(frac).toBeLessThan(0.68) // 1 - 1/e = 0.632
    run(d, frame(HARSH), 5 * TIMBRE_TAU_SEC)
    expect((d.read().harsh - base) / (target - base)).toBeGreaterThan(0.99)
  })

  it('a one-second burst barely moves the read (texture is slow), and the step response is frame-rate independent', () => {
    const d = new TimbreDescriptors(CAL)
    run(d, frame(SMOOTH), 20)
    const base = d.read().harsh
    run(d, frame(HARSH), 1)
    expect(d.read().harsh - base).toBeLessThan(0.25)

    const a = new TimbreDescriptors(CAL)
    const b = new TimbreDescriptors(CAL)
    run(a, frame(SMOOTH), 10, 1 / 60)
    run(b, frame(SMOOTH), 10, 1 / 20)
    run(a, frame(HARSH), 4, 1 / 60)
    run(b, frame(HARSH), 4, 1 / 20)
    expect(a.read().harsh).toBeCloseTo(b.read().harsh, 3)
  })

  it('reset() returns to neutral and re-seeds', () => {
    const d = new TimbreDescriptors(CAL)
    run(d, frame({ ...HARSH, flux: 0.9, loudness: 0.9 }), 20)
    expect(d.read().harsh).toBeGreaterThan(0.8)
    d.reset()
    expect(d.read()).toEqual({ harsh: 0.5, busy: 0.5, sparse: 0.5 })
    d.update(frame(SMOOTH), 1 / 60)
    expect(d.read().harsh).toBeCloseTo(0.1, 6)
  })
})

describe('shipped timbre tables (generated by npm run calibrate:timbre)', () => {
  it('cover every input and composite with ascending 21-knot tables', () => {
    for (const name of ['loudness', 'flux', 'roughness', 'tonalness', 'modeAmbiguity']) {
      const k = TIMBRE_CALIBRATION.features[name]
      expect(k, name).toBeDefined()
      expect(k.length, name).toBe(21)
      for (let i = 1; i < k.length; i++) expect(k[i], name).toBeGreaterThanOrEqual(k[i - 1])
    }
    for (const name of ['harsh', 'busy', 'sparse'] as const) {
      const k = TIMBRE_CALIBRATION.composites[name]
      expect(k, name).toBeDefined()
      expect(k!.length, name).toBe(21)
      for (let i = 1; i < k!.length; i++) expect(k![i], name).toBeGreaterThanOrEqual(k![i - 1])
    }
  })

  it('spread the output over the range: opposite textures land far apart', () => {
    const rough = run(
      new TimbreDescriptors(),
      frame({
        harmonicRoughness: 0.5,
        harmonicTonalness: 0.02,
        flux: 0.6,
        loudness: 1,
        keyValid: true,
        keyModeStrength: 0,
      }),
      20,
    )
    const calm = run(
      new TimbreDescriptors(),
      frame({
        harmonicRoughness: 0.15,
        harmonicTonalness: 0.85,
        flux: 0.01,
        loudness: 0.3,
        keyValid: true,
        keyModeStrength: 1,
      }),
      20,
    )
    expect(rough.harsh).toBeGreaterThan(calm.harsh + 0.5)
    expect(rough.busy).toBeGreaterThan(calm.busy + 0.5)
    expect(calm.sparse).toBeGreaterThan(rough.sparse + 0.5)
  })
})
