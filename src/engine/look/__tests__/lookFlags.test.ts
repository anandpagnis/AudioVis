import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHARACTER_MOODS } from '../../../audio/characterTypes'
import { lookDebugEnabled, lookFamilies, lookForceMood, tempoCouplingOff } from '../lookFlags'

const ALL_ON = { grade: true, post: true, scene: true, camera: true }
const ALL_OFF = { grade: false, post: false, scene: false, camera: false }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('lookForceMood', () => {
  it('accepts every character mood id', () => {
    for (const m of CHARACTER_MOODS) expect(lookForceMood(`?lookforce=${m}`)).toBe(m)
  })

  it('is case-insensitive and trims', () => {
    expect(lookForceMood('?lookforce=Aggressive')).toBe('aggressive')
    expect(lookForceMood('?lookforce=%20tense%20')).toBe('tense')
    expect(lookForceMood('?lookforce=EPIC')).toBe('epic')
  })

  it('works without the leading ? and among other params', () => {
    expect(lookForceMood('lookforce=dreamy')).toBe('dreamy')
    expect(lookForceMood('?scenepick=x&lookforce=groove&lookdebug')).toBe('groove')
  })

  it('is null when absent, empty, or not a mood', () => {
    expect(lookForceMood('')).toBeNull()
    expect(lookForceMood('?')).toBeNull()
    expect(lookForceMood('?lookforce=')).toBeNull()
    expect(lookForceMood('?lookforce=happy')).toBeNull()
    expect(lookForceMood('?lookforce=silence')).toBeNull() // a legacy MoodState, not a character mood
    expect(lookForceMood('?lookforce=aggressive,tense')).toBeNull()
    expect(lookForceMood('?lookforced=tense')).toBeNull()
    expect(lookForceMood('?lookforce')).toBeNull()
  })

  it('takes the first of a repeated param', () => {
    expect(lookForceMood('?lookforce=serene&lookforce=tense')).toBe('serene')
  })
})

describe('lookDebugEnabled', () => {
  it('is on for the bare flag and for truthy values', () => {
    expect(lookDebugEnabled('?lookdebug')).toBe(true)
    expect(lookDebugEnabled('?lookdebug=1')).toBe(true)
    expect(lookDebugEnabled('?lookdebug=true')).toBe(true)
    expect(lookDebugEnabled('?a=1&lookdebug&b=2')).toBe(true)
  })

  it('is off when absent, misspelt, or explicitly off', () => {
    expect(lookDebugEnabled('')).toBe(false)
    expect(lookDebugEnabled('?lookdebugger')).toBe(false)
    expect(lookDebugEnabled('?look=debug')).toBe(false)
    for (const off of ['0', 'false', 'off', 'no', 'OFF']) expect(lookDebugEnabled(`?lookdebug=${off}`)).toBe(false)
  })
})

describe('tempoCouplingOff', () => {
  it('is off-switch only for an explicit off value', () => {
    expect(tempoCouplingOff('')).toBe(false)
    expect(tempoCouplingOff('?tempo=on')).toBe(false)
    expect(tempoCouplingOff('?tempo')).toBe(false)
    expect(tempoCouplingOff('?tempo=off')).toBe(true)
    expect(tempoCouplingOff('?tempo=OFF')).toBe(true)
    expect(tempoCouplingOff('?tempo=0')).toBe(true)
    expect(tempoCouplingOff('?tempo=false')).toBe(true)
    expect(tempoCouplingOff('?tempo=no')).toBe(true)
  })
})

describe('lookFamilies', () => {
  it('defaults to everything on', () => {
    expect(lookFamilies('')).toEqual(ALL_ON)
    expect(lookFamilies('?lookforce=tense&lookdebug')).toEqual(ALL_ON)
    expect(lookFamilies('?look=')).toEqual(ALL_ON)
  })

  it('disables the named families with a leading minus', () => {
    expect(lookFamilies('?look=-grade')).toEqual({ ...ALL_ON, grade: false })
    expect(lookFamilies('?look=-post')).toEqual({ ...ALL_ON, post: false })
    expect(lookFamilies('?look=-scene')).toEqual({ ...ALL_ON, scene: false })
    expect(lookFamilies('?look=-camera')).toEqual({ ...ALL_ON, camera: false })
    expect(lookFamilies('?look=-grade,-post')).toEqual({ grade: false, post: false, scene: true, camera: true })
    expect(lookFamilies('?look=-grade,-post,-scene,-camera')).toEqual(ALL_OFF)
  })

  it('ignores unknown names, tokens without a minus, and junk', () => {
    expect(lookFamilies('?look=-bogus,-post')).toEqual({ ...ALL_ON, post: false })
    expect(lookFamilies('?look=grade,post')).toEqual(ALL_ON)
    expect(lookFamilies('?look=--grade')).toEqual(ALL_ON)
    expect(lookFamilies('?look=-')).toEqual(ALL_ON)
    expect(lookFamilies('?look=,,,')).toEqual(ALL_ON)
    expect(lookFamilies('?look=+grade')).toEqual(ALL_ON) // '+' decodes to a space; not a minus
  })

  it('is case-insensitive and tolerates spaces around tokens', () => {
    expect(lookFamilies('?look=-GRADE')).toEqual({ ...ALL_ON, grade: false })
    expect(lookFamilies('?look=-grade%2C%20-Camera')).toEqual({ ...ALL_ON, grade: false, camera: false })
    expect(lookFamilies('?look=%20-%20scene')).toEqual({ ...ALL_ON, scene: false })
  })

  it('accumulates repeated look params', () => {
    expect(lookFamilies('?look=-grade&look=-camera')).toEqual({ ...ALL_ON, grade: false, camera: false })
  })

  it('turns everything off under ?scenepick=legacy, which wins over ?look=', () => {
    expect(lookFamilies('?scenepick=legacy')).toEqual(ALL_OFF)
    expect(lookFamilies('?look=-grade&scenepick=legacy')).toEqual(ALL_OFF)
    expect(lookFamilies('?scenepick=other')).toEqual(ALL_ON)
    expect(lookFamilies('?scenepick=')).toEqual(ALL_ON)
  })

  it('returns a fresh object each call', () => {
    const a = lookFamilies('')
    a.grade = false
    expect(lookFamilies('').grade).toBe(true)
  })
})

describe('default search string', () => {
  it('is the "flag absent" answer when there is no location (node)', () => {
    expect(lookForceMood()).toBeNull()
    expect(lookDebugEnabled()).toBe(false)
    expect(lookFamilies()).toEqual(ALL_ON)
  })

  it('reads location.search when it exists', () => {
    vi.stubGlobal('location', { search: '?lookforce=tense&lookdebug&look=-post' })
    expect(lookForceMood()).toBe('tense')
    expect(lookDebugEnabled()).toBe(true)
    expect(lookFamilies()).toEqual({ ...ALL_ON, post: false })
  })

  it('an injected search wins over location', () => {
    vi.stubGlobal('location', { search: '?lookforce=tense' })
    expect(lookForceMood('?lookforce=epic')).toBe('epic')
    expect(lookForceMood('')).toBeNull()
  })

  it('survives a throwing location', () => {
    vi.stubGlobal('location', {
      get search(): string {
        throw new Error('blocked')
      },
    })
    expect(lookForceMood()).toBeNull()
    expect(lookDebugEnabled()).toBe(false)
    expect(lookFamilies()).toEqual(ALL_ON)
  })
})
