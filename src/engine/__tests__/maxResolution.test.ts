import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_RESOLUTION,
  MAX_RESOLUTION_OPTIONS,
  maxResolutionMP,
  sanitizeMaxResolution,
} from '../maxResolution'
import { mergePersistedSettings, useStore } from '../../store'

/**
 * F272 stage 6: the "max render resolution" setting. The cap maths lives in
 * renderScale.test.ts; this pins the value itself — what it may be, what it
 * means in megapixels, and that nothing from storage or a stray caller can
 * leave the store holding something the renderer and the select disagree on.
 */
describe('sanitizeMaxResolution', () => {
  it('keeps every option id', () => {
    for (const o of MAX_RESOLUTION_OPTIONS) expect(sanitizeMaxResolution(o.id)).toBe(o.id)
  })

  it('reads anything else as Native', () => {
    for (const v of [undefined, null, '', 'huge', '1920×1080', 1080, {}, ['native']]) {
      expect(sanitizeMaxResolution(v)).toBe('native')
    }
    expect(DEFAULT_MAX_RESOLUTION).toBe('native')
  })
})

describe('maxResolutionMP', () => {
  it('is the option’s pixel count in megapixels', () => {
    expect(maxResolutionMP('1920x1080')).toBeCloseTo(2.0736)
    expect(maxResolutionMP('2560x1440')).toBeCloseTo(3.6864)
    expect(maxResolutionMP('3840x2160')).toBeCloseTo(8.2944)
  })

  it('is uncapped for Native and for an unknown value', () => {
    expect(maxResolutionMP('native')).toBe(Infinity)
    expect(maxResolutionMP('bogus')).toBe(Infinity)
  })

  it('lists the options largest first, after Native', () => {
    const mps = MAX_RESOLUTION_OPTIONS.map((o) => o.mp)
    expect(mps[0]).toBe(Infinity)
    for (let i = 1; i < mps.length; i++) expect(mps[i]).toBeLessThan(mps[i - 1])
  })
})

describe('the store’s maxResolution', () => {
  it('defaults to Native', () => {
    expect(useStore.getInitialState().maxResolution).toBe('native')
  })

  it('setMaxResolution keeps a real option and sanitises anything else', () => {
    const s = () => useStore.getState()
    const before = s().maxResolution
    try {
      s().setMaxResolution('1920x1080')
      expect(s().maxResolution).toBe('1920x1080')
      s().setMaxResolution('8k' as never)
      expect(s().maxResolution).toBe('native')
    } finally {
      s().setMaxResolution(before)
    }
  })
})

describe('mergePersistedSettings', () => {
  const current = () => useStore.getInitialState()

  it('keeps a valid stored value, like the default merge', () => {
    const merged = mergePersistedSettings({ maxResolution: '2560x1440', quality: 'low' }, current())
    expect(merged.maxResolution).toBe('2560x1440')
    expect(merged.quality).toBe('low')
  })

  it('turns a value this build does not know into Native', () => {
    expect(mergePersistedSettings({ maxResolution: '7680x4320' }, current()).maxResolution).toBe('native')
    expect(mergePersistedSettings({ maxResolution: 42 }, current()).maxResolution).toBe('native')
  })

  it('leaves the current value when none was stored (an install from before the setting)', () => {
    const merged = mergePersistedSettings({ quality: 'high' }, { ...current(), maxResolution: '1280x720' })
    expect(merged.maxResolution).toBe('1280x720')
    expect(merged.quality).toBe('high')
  })

  it('ignores a stored blob that is not an object', () => {
    expect(mergePersistedSettings(null, current())).toBe(current())
    expect(mergePersistedSettings('corrupt', current())).toBe(current())
  })
})
