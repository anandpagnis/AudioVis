import { describe, expect, it } from 'vitest'
import { ceilingForTier, evaluateLedger, type LedgerEntry } from '../budgetLedger'
import type { SceneLifecycleStatus } from '../lifecycle'

function entry(
  sceneId: string,
  status: SceneLifecycleStatus,
  vramMB: number,
  opts: { priority?: number; lastActiveAtSec?: number } = {},
): LedgerEntry {
  return {
    sceneId,
    status,
    vramMB,
    measured: false,
    priority: opts.priority ?? 0,
    lastActiveAtSec: opts.lastActiveAtSec ?? 0,
  }
}

describe('ceilingForTier', () => {
  it('gives richer tiers more headroom than survival tiers', () => {
    expect(ceilingForTier(0)).toBeGreaterThan(ceilingForTier(4))
  })

  it('clamps out-of-range tiers instead of returning undefined', () => {
    expect(ceilingForTier(-5)).toBe(ceilingForTier(0))
    expect(ceilingForTier(99)).toBe(ceilingForTier(4))
  })
})

describe('evaluateLedger', () => {
  it('evicts nothing while under budget', () => {
    const verdict = evaluateLedger([entry('a', 'ACTIVE', 50), entry('b', 'READY', 30)], 256)
    expect(verdict.totalMB).toBe(80)
    expect(verdict.overBy).toBe(0)
    expect(verdict.evictionCandidates).toEqual([])
  })

  it('never evicts the ACTIVE scene, even when it alone blows the budget', () => {
    // Nothing may cut what is on screen — the only correct response here is to
    // report the overage and evict nothing.
    const verdict = evaluateLedger([entry('onscreen', 'ACTIVE', 400)], 128)
    expect(verdict.overBy).toBe(272)
    expect(verdict.evictionCandidates).toEqual([])
  })

  it('never evicts in-flight LOADING/PREWARMING work', () => {
    const verdict = evaluateLedger(
      [entry('a', 'ACTIVE', 100), entry('b', 'LOADING', 100), entry('c', 'PREWARMING', 100)],
      128,
    )
    expect(verdict.overBy).toBeGreaterThan(0)
    expect(verdict.evictionCandidates).toEqual([])
  })

  it('evicts lowest-priority READY/BACKGROUND entries first', () => {
    const verdict = evaluateLedger(
      [
        entry('active', 'ACTIVE', 100),
        entry('keep', 'READY', 60, { priority: 9 }),
        entry('drop', 'BACKGROUND', 60, { priority: 1 }),
      ],
      180,
    )
    expect(verdict.evictionCandidates).toEqual(['drop'])
  })

  it('breaks priority ties by staleness — the least recently active goes first', () => {
    const verdict = evaluateLedger(
      [
        entry('active', 'ACTIVE', 100),
        entry('fresh', 'BACKGROUND', 40, { priority: 5, lastActiveAtSec: 900 }),
        entry('stale', 'BACKGROUND', 40, { priority: 5, lastActiveAtSec: 10 }),
      ],
      160,
    )
    expect(verdict.evictionCandidates).toEqual(['stale'])
  })

  it('stops evicting as soon as enough has been freed, not evicting everything it could', () => {
    const verdict = evaluateLedger(
      [
        entry('active', 'ACTIVE', 100),
        entry('a', 'READY', 50, { priority: 0 }),
        entry('b', 'READY', 50, { priority: 1 }),
        entry('c', 'READY', 50, { priority: 2 }),
      ],
      210,
    )
    // 250 total, 40 over — one 50MB eviction clears it.
    expect(verdict.overBy).toBe(40)
    expect(verdict.evictionCandidates).toEqual(['a'])
  })

  it('evicts multiple entries when one is not enough', () => {
    const verdict = evaluateLedger(
      [
        entry('active', 'ACTIVE', 100),
        entry('a', 'READY', 40, { priority: 0 }),
        entry('b', 'READY', 40, { priority: 1 }),
        entry('c', 'READY', 40, { priority: 2 }),
      ],
      150,
    )
    expect(verdict.overBy).toBe(70)
    expect(verdict.evictionCandidates).toEqual(['a', 'b'])
  })

  it('handles an empty ledger without dividing by zero or returning junk', () => {
    const verdict = evaluateLedger([], 256)
    expect(verdict).toEqual({ totalMB: 0, ceilingMB: 256, overBy: 0, evictionCandidates: [] })
  })
})
