import { afterEach, describe, expect, it, vi } from 'vitest'
import { structureOff } from '../structureFlags'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('structureOff', () => {
  it('is off (analyzer enabled) when the flag is absent', () => {
    expect(structureOff('')).toBe(false)
    expect(structureOff('?')).toBe(false)
    expect(structureOff('?lookdebug')).toBe(false)
    expect(structureOff('?a=1&b=2')).toBe(false)
  })

  it('disables for the bare flag and for any value (presence alone is enough — see file header)', () => {
    expect(structureOff('?structure')).toBe(true)
    expect(structureOff('?structure=')).toBe(true)
    expect(structureOff('?structure=off')).toBe(true)
    expect(structureOff('?structure=0')).toBe(true)
    expect(structureOff('?structure=false')).toBe(true)
    expect(structureOff('?structure=no')).toBe(true)
    expect(structureOff('?structure=1')).toBe(true)
    expect(structureOff('?structure=banana')).toBe(true)
  })

  it('is off when misspelt', () => {
    expect(structureOff('?structuredebug')).toBe(false)
    expect(structureOff('?struct=off')).toBe(false)
  })

  it('works without the leading ? and among other params', () => {
    expect(structureOff('structure=off')).toBe(true)
    expect(structureOff('?a=1&structure=off&b=2')).toBe(true)
    expect(structureOff('?lookforce=tense&structure')).toBe(true)
  })
})

describe('default search string', () => {
  it('is the "flag absent" answer when there is no location (node)', () => {
    expect(structureOff()).toBe(false)
  })

  it('reads location.search when it exists', () => {
    vi.stubGlobal('location', { search: '?structure=off' })
    expect(structureOff()).toBe(true)
  })

  it('an injected search wins over location', () => {
    vi.stubGlobal('location', { search: '?structure=off' })
    expect(structureOff('')).toBe(false)
    expect(structureOff('?structure=off')).toBe(true)
  })

  it('survives a throwing location', () => {
    vi.stubGlobal('location', {
      get search(): string {
        throw new Error('blocked')
      },
    })
    expect(structureOff()).toBe(false)
  })
})
