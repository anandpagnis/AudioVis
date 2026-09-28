import { describe, expect, it } from 'vitest'
import { RAW_AIR, RAW_BASS, RAW_DB_CEIL, RAW_CHANNELS, RAW_DB_FLOOR, RAW_HIGH, RAW_MID, RAW_PRESENCE, RAW_RMS, RAW_SUB, RawTap, linToDb } from '../rawTap'

describe('rawTap', () => {
  it('linToDb is 20 log10, floored, and total on garbage', () => {
    expect(linToDb(1)).toBeCloseTo(0, 9)
    expect(linToDb(0.1)).toBeCloseTo(-20, 9)
    expect(linToDb(0.5)).toBeCloseTo(-6.0206, 3)
    expect(linToDb(0)).toBe(RAW_DB_FLOOR)
    expect(linToDb(-1)).toBe(RAW_DB_FLOOR)
    expect(linToDb(1e-12)).toBe(RAW_DB_FLOOR)
    expect(linToDb(Number.NaN)).toBe(RAW_DB_FLOOR)
    expect(linToDb(Number.POSITIVE_INFINITY)).toBe(RAW_DB_CEIL) // an absurdly hot value is clamped, never Infinity
  })

  it('writes the six bands and the RMS in dB into the reused buffer, in the documented channel order', () => {
    const tap = new RawTap()
    expect(tap.written).toBe(false)
    const buf = tap.db
    tap.write({ sub: 0, bass: 0.1, mid: 0.01, presence: 0.001, high: 0.0001, air: 0.00001 }, 1, 0.5)
    expect(tap.written).toBe(true)
    expect(tap.db).toBe(buf) // no allocation: the same array
    expect(tap.db.length).toBe(RAW_CHANNELS)
    expect(tap.db[RAW_SUB]).toBeCloseTo(0, 6) // the sub value passed separately wins over bands.sub
    expect(tap.db[RAW_BASS]).toBeCloseTo(-20, 6)
    expect(tap.db[RAW_MID]).toBeCloseTo(-40, 6)
    expect(tap.db[RAW_PRESENCE]).toBeCloseTo(-60, 6)
    expect(tap.db[RAW_HIGH]).toBeCloseTo(-80, 6)
    expect(tap.db[RAW_AIR]).toBeCloseTo(-100, 6)
    expect(tap.db[RAW_RMS]).toBeCloseTo(-6.0206, 3)
  })

  it('a uniform gain is a uniform dB shift of every channel (which is what makes differences gain-invariant)', () => {
    const a = new RawTap()
    const b = new RawTap()
    const bands = { sub: 0.2, bass: 0.15, mid: 0.05, presence: 0.02, high: 0.008, air: 0.001 }
    a.write(bands, 0.2, 0.1)
    const g = 2 // +6.02 dB
    b.write(
      { sub: bands.sub * g, bass: bands.bass * g, mid: bands.mid * g, presence: bands.presence * g, high: bands.high * g, air: bands.air * g },
      0.2 * g,
      0.1 * g,
    )
    for (let i = 0; i < RAW_CHANNELS; i++) expect(b.db[i] - a.db[i]).toBeCloseTo(20 * Math.log10(g), 6)
  })

  it('silence reads as the floor everywhere and reset() clears the written flag', () => {
    const tap = new RawTap()
    tap.write({ sub: 0, bass: 0, mid: 0, presence: 0, high: 0, air: 0 }, 0, 0)
    expect(Array.from(tap.db).every((v) => v === RAW_DB_FLOOR)).toBe(true)
    tap.reset()
    expect(tap.written).toBe(false)
  })
})
