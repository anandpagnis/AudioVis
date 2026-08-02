import { describe, expect, it } from 'vitest'
import {
  SceneLifecycle,
  canTransition,
  isEvictable,
  isResident,
  type SceneLifecycleStatus,
} from '../lifecycle'

const ALL: SceneLifecycleStatus[] = [
  'UNLOADED',
  'LOADING',
  'PREWARMING',
  'READY',
  'ACTIVE',
  'BACKGROUND',
  'UNLOADING',
]

describe('canTransition / SceneLifecycle', () => {
  it('never allows the direct UNLOADED -> ACTIVE jump this whole system exists to prevent', () => {
    expect(canTransition('UNLOADED', 'ACTIVE')).toBe(false)
    const lc = new SceneLifecycle()
    expect(lc.transition('ACTIVE')).toBe(false)
    expect(lc.status).toBe('UNLOADED')
  })

  it('walks the full happy path: UNLOADED -> LOADING -> PREWARMING -> READY -> ACTIVE', () => {
    const lc = new SceneLifecycle()
    expect(lc.transition('LOADING')).toBe(true)
    expect(lc.transition('PREWARMING')).toBe(true)
    expect(lc.transition('READY')).toBe(true)
    expect(lc.transition('ACTIVE')).toBe(true)
    expect(lc.status).toBe('ACTIVE')
  })

  it('supports the demote/re-promote ping-pong, skipping LOADING/PREWARMING on the way back', () => {
    const lc = new SceneLifecycle()
    lc.transition('LOADING')
    lc.transition('PREWARMING')
    lc.transition('READY')
    lc.transition('ACTIVE')
    expect(lc.transition('BACKGROUND')).toBe(true)
    expect(lc.transition('ACTIVE')).toBe(true) // instant, no reload
    expect(lc.status).toBe('ACTIVE')
  })

  it('allows UNLOADING as a cancellation exit from every resident/in-flight state', () => {
    for (const from of ['LOADING', 'PREWARMING', 'READY', 'ACTIVE', 'BACKGROUND'] as const) {
      expect(canTransition(from, 'UNLOADING')).toBe(true)
    }
  })

  it('UNLOADING only ever returns to UNLOADED, and UNLOADED only ever proceeds to LOADING', () => {
    expect(canTransition('UNLOADING', 'UNLOADED')).toBe(true)
    for (const to of ALL) {
      if (to === 'UNLOADED') continue
      expect(canTransition('UNLOADING', to)).toBe(false)
    }
    expect(canTransition('UNLOADED', 'LOADING')).toBe(true)
    for (const to of ALL) {
      if (to === 'LOADING') continue
      expect(canTransition('UNLOADED', to)).toBe(false)
    }
  })

  it('rejects every illegal jump across the full state space, not just the headline one', () => {
    const legal = new Set<string>()
    legal.add('UNLOADED>LOADING')
    legal.add('LOADING>PREWARMING')
    legal.add('LOADING>UNLOADING')
    legal.add('PREWARMING>READY')
    legal.add('PREWARMING>UNLOADING')
    legal.add('READY>ACTIVE')
    legal.add('READY>UNLOADING')
    legal.add('ACTIVE>BACKGROUND')
    legal.add('ACTIVE>UNLOADING')
    legal.add('BACKGROUND>ACTIVE')
    legal.add('BACKGROUND>UNLOADING')
    legal.add('UNLOADING>UNLOADED')

    for (const from of ALL) {
      for (const to of ALL) {
        const expected = legal.has(`${from}>${to}`)
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected)
      }
    }
  })

  it('a failed transition leaves state exactly as it was', () => {
    const lc = new SceneLifecycle()
    lc.transition('LOADING')
    expect(lc.transition('ACTIVE')).toBe(false) // illegal from LOADING
    expect(lc.status).toBe('LOADING')
  })
})

describe('isResident / isEvictable', () => {
  it('a scene is resident (holding GPU resources) in every state except UNLOADED/LOADING/UNLOADING', () => {
    expect(isResident('UNLOADED')).toBe(false)
    expect(isResident('LOADING')).toBe(false)
    expect(isResident('PREWARMING')).toBe(true)
    expect(isResident('READY')).toBe(true)
    expect(isResident('ACTIVE')).toBe(true)
    expect(isResident('BACKGROUND')).toBe(true)
    expect(isResident('UNLOADING')).toBe(false)
  })

  it('only READY and BACKGROUND are evictable — ACTIVE is untouchable, in-flight work is left alone', () => {
    for (const status of ALL) {
      const expected = status === 'READY' || status === 'BACKGROUND'
      expect(isEvictable(status), status).toBe(expected)
    }
  })
})
