import { afterEach, describe, expect, it, vi } from 'vitest'
import { structureLogEnabled, structureLogRequested } from '../structureLogFlags'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('structureLogEnabled', () => {
  it('is on for the bare flag and for truthy values', () => {
    expect(structureLogEnabled('?structurelog')).toBe(true)
    expect(structureLogEnabled('?structurelog=1')).toBe(true)
    expect(structureLogEnabled('?structurelog=true')).toBe(true)
    expect(structureLogEnabled('?structurelog=on')).toBe(true)
    expect(structureLogEnabled('?a=1&structurelog&b=2')).toBe(true)
    expect(structureLogEnabled('structurelog')).toBe(true)
  })

  it('is off when absent, misspelt, or explicitly off', () => {
    expect(structureLogEnabled('')).toBe(false)
    expect(structureLogEnabled('?')).toBe(false)
    expect(structureLogEnabled('?structurelogs')).toBe(false)
    expect(structureLogEnabled('?structure=log')).toBe(false)
    expect(structureLogEnabled('?structure=off')).toBe(false)
    for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
      expect(structureLogEnabled(`?structurelog=${encodeURIComponent(off)}`)).toBe(false)
    }
  })

  it('does not disturb the other flags on the same URL', () => {
    expect(structureLogEnabled('?output&lookdebug&structurelog')).toBe(true)
    expect(structureLogEnabled('?output&lookdebug')).toBe(false)
  })

  it('is safe with no location (node), and with a throwing one', () => {
    expect(structureLogEnabled()).toBe(false)
    vi.stubGlobal('location', {
      get search(): string {
        throw new Error('no location for you')
      },
    })
    expect(structureLogEnabled()).toBe(false)
  })

  it('reads location.search by default', () => {
    vi.stubGlobal('location', { search: '?structurelog' })
    expect(structureLogEnabled()).toBe(true)
    vi.stubGlobal('location', { search: '?structurelog=off' })
    expect(structureLogEnabled()).toBe(false)
  })
})

describe('structureLogRequested (own URL, then the window that opened this one)', () => {
  it('is false with no window, or nothing asking for it', () => {
    expect(structureLogRequested()).toBe(false)
    expect(structureLogRequested(null)).toBe(false)
    expect(structureLogRequested({ location: { search: '?output' } })).toBe(false)
    expect(structureLogRequested({ location: { search: '?output' }, opener: { location: { search: '' } } })).toBe(false)
  })

  it('is true when this window asks for it', () => {
    expect(structureLogRequested({ location: { search: '?output&structurelog' } })).toBe(true)
  })

  it('is true when only the opener (the console) asks for it', () => {
    expect(
      structureLogRequested({ location: { search: '?output' }, opener: { location: { search: '?structurelog' } } }),
    ).toBe(true)
  })

  it('an explicit off on this window wins over an opener that asks for it', () => {
    expect(
      structureLogRequested({
        location: { search: '?output&structurelog=off' },
        opener: { location: { search: '?structurelog' } },
      }),
    ).toBe(false)
  })

  it('never throws on a cross-origin or broken opener', () => {
    const opener = {
      get location(): { search: string } {
        throw new Error('SecurityError')
      },
    }
    expect(structureLogRequested({ location: { search: '?output' }, opener })).toBe(false)
    const brokenOwn = {
      get location(): { search: string } {
        throw new Error('nope')
      },
      opener: { location: { search: '?structurelog' } },
    }
    expect(structureLogRequested(brokenOwn)).toBe(true)
  })

  it('defaults to the real window global when there is one', () => {
    vi.stubGlobal('window', { location: { search: '?output&structurelog' } })
    expect(structureLogRequested()).toBe(true)
    vi.stubGlobal('window', { location: { search: '?output' }, opener: null })
    expect(structureLogRequested()).toBe(false)
  })
})
