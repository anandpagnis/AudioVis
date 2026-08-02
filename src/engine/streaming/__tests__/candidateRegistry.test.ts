import { describe, expect, it } from 'vitest'
import { CandidateRegistry } from '../candidateRegistry'

describe('CandidateRegistry', () => {
  it('creates a candidate in UNLOADED', () => {
    const reg = new CandidateRegistry()
    const c = reg.ensure('plasma', 0, 10)
    expect(c.id).toBe('plasma')
    expect(c.lifecycle.status).toBe('UNLOADED')
    expect(c.requestedAtSec).toBe(10)
  })

  it('ensure() is idempotent and never resets an in-flight candidate', () => {
    // This is the property that makes it safe for the Planner to call
    // preload() every frame for the same id: a repeat request must not
    // restart a scene that is already halfway through warming.
    const reg = new CandidateRegistry()
    const first = reg.ensure('plasma', 0, 10)
    first.lifecycle.transition('LOADING')
    first.lifecycle.transition('PREWARMING')

    const second = reg.ensure('plasma', 5, 99)
    expect(second).toBe(first)
    expect(second.lifecycle.status).toBe('PREWARMING')
    expect(second.requestedAtSec).toBe(10) // original request time preserved
    expect(second.priority).toBe(0) // not clobbered by the repeat call
  })

  it('tracks multiple concurrent candidates independently', () => {
    const reg = new CandidateRegistry()
    reg.ensure('a', 0, 0).lifecycle.transition('LOADING')
    reg.ensure('b', 0, 0)
    expect(reg.all().size).toBe(2)
    expect(reg.get('a')?.lifecycle.status).toBe('LOADING')
    expect(reg.get('b')?.lifecycle.status).toBe('UNLOADED')
  })

  it('remove() drops a candidate and get() reports it gone', () => {
    const reg = new CandidateRegistry()
    reg.ensure('a', 0, 0)
    reg.remove('a')
    expect(reg.get('a')).toBeUndefined()
    expect(reg.all().size).toBe(0)
  })

  it('remove() on an unknown id is a no-op rather than an error', () => {
    const reg = new CandidateRegistry()
    expect(() => reg.remove('never-existed')).not.toThrow()
  })
})
