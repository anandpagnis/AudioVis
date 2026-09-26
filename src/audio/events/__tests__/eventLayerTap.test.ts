import { describe, expect, it } from 'vitest'
import type { BeatCell } from '../../essentia/structureDsp'
import { EventLayer, type EventLayerConfig } from '../EventLayer'
import type { SectionEvent } from '../types'
import { CHORUS, VERSE, makeCell, mulberry, smoothChroma, type SectionSpec } from './cellFactory'

/**
 * Fixes that came out of the first two tapped songs (`?structurelog` + `scripts/calibrate/tap-eval.calib.ts`):
 *  - the first hump of a real change was typed `fill` (its relative persistence is small because the peak saturates) and the
 *    `change` came 2-4 s later and weak: an ambiguous candidate is now held two beats and typed on the longer stretch;
 *  - the `drop` is read from the low band's dropout and return (`gapDrop.ts`).
 */

const SPB = 0.5

function run(cfg: Partial<EventLayerConfig>, cells: readonly BeatCell[]): SectionEvent[] {
  const layer = new EventLayer(cfg)
  const out: SectionEvent[] = []
  for (const c of cells) for (const e of layer.push(c, c.beat, c.beat * SPB, 120)) out.push({ ...e, feats: { ...e.feats } })
  return out
}

const mix = (a: SectionSpec, b: SectionSpec, l: number): SectionSpec => ({
  ...a,
  lowTilt: a.lowTilt + l * (b.lowTilt - a.lowTilt),
  midTilt: a.midTilt + l * (b.midTilt - a.midTilt),
  highTilt: a.highTilt + l * (b.highTilt - a.highTilt),
  mel: a.mel.map((m, i) => m * (1 - l) + b.mel[i] * l),
  chroma: a.chroma.map((m, i) => m * (1 - l) + b.chroma[i] * l),
  onset: a.onset + l * (b.onset - a.onset),
  flatness: a.flatness + l * (b.flatness - a.flatness),
  centroid: a.centroid + l * (b.centroid - a.centroid),
})

/** 80 beats of verse, a 4-beat IMPACT (a crash and a fresh timbre at +8 dB), then `settle` for the rest. */
function impactThen(settle: SectionSpec, seed = 7): BeatCell[] {
  const rnd = mulberry(seed)
  const cells: BeatCell[] = []
  for (let b = 1; b <= 200; b++) {
    if (b <= 80) cells.push(makeCell(VERSE, b, rnd))
    else if (b <= 84) cells.push(makeCell(CHORUS, b, rnd, { onsetBoost: 0.5, highBoostDb: 30, gainDb: 8 }))
    else cells.push(makeCell(settle, b, rnd))
  }
  return smoothChroma(cells)
}

describe('EventLayer: the first hump of a real change is a change, not a fill', () => {
  // the section that follows the impact is a moderately different one: it PERSISTS, but well below the impact's score
  const persisting = mix(VERSE, CHORUS, 0.3)

  it('now: a `change` at the first hump, on the boundary, a few beats after it', () => {
    const evs = run({}, impactThen(persisting))
    const first = evs[0]
    expect(first.type).toBe('change')
    expect(Math.abs(first.boundaryBeat - 80)).toBeLessThanOrEqual(2)
    expect(first.detectedAtBeat - first.boundaryBeat).toBeLessThanOrEqual(10)
    expect(first.detectedAtBeat).toBeGreaterThan(84) // held two beats: honest detectedAt
    expect(first.strength).toBeGreaterThan(0.8) // the saturated peak's strength, not a later weak one
  })

  it('before (ratio-only typing): that hump was a `fill` and the `change` arrived about 16 beats later', () => {
    const evs = run({ fillRecentFrac: Number.POSITIVE_INFINITY, fillHoldBeats: 0 }, impactThen(persisting))
    expect(evs[0].type).toBe('fill')
    const change = evs.find((e) => e.type === 'change')
    expect(change).toBeDefined()
    expect((change as SectionEvent).detectedAtBeat - evs[0].detectedAtBeat).toBeGreaterThanOrEqual(8)
  })

  it('holding is what keeps a fill a fill: an impact that RETURNS to the verse is a `fill`', () => {
    const evs = run({}, impactThen(VERSE))
    expect(evs[0].type).toBe('fill')
    // the absolute bar is what separates them: a lenient one (0.3 of the threshold) types the smeared tail a change
    expect(run({ fillRecentFrac: 0.3, fillHoldBeats: 0 }, impactThen(VERSE))[0].type).toBe('change')
  })

  it('an unambiguous fill (back to the baseline at once) is not delayed and is never a scene-class event', () => {
    const rnd = mulberry(5)
    const cells: BeatCell[] = []
    for (let b = 1; b <= 160; b++) cells.push(makeCell(VERSE, b, rnd, b === 100 || b === 101 ? { onsetBoost: 0.4, highBoostDb: 14 } : {}))
    const evs = run({}, cells)
    const fill = evs.find((e) => e.type === 'fill')
    if (fill) expect(fill.detectedAtBeat - fill.boundaryBeat).toBeLessThanOrEqual(8)
    expect(evs.filter((e) => e.type === 'change' || e.type === 'breakdown')).toEqual([])
  })

  it('a big change with nothing ambiguous is not delayed either', () => {
    const rnd = mulberry(3)
    const cells: BeatCell[] = []
    for (let b = 1; b <= 160; b++) cells.push(makeCell(b <= 80 ? VERSE : CHORUS, b, rnd))
    const evs = run({}, smoothChroma(cells))
    const e = evs.find((x) => x.type === 'change')
    expect(e).toBeDefined()
    expect((e as SectionEvent).detectedAtBeat - 80).toBeLessThanOrEqual(8)
  })
})

/** Steady verse with the low band gone (-90 dB sub and bass) for `gap` beats from beat 100. */
function dropoutStream(gap: number): BeatCell[] {
  const rnd = mulberry(11)
  const cells: BeatCell[] = []
  for (let b = 1; b <= 220; b++) {
    const c = makeCell(VERSE, b, rnd)
    if (b >= 100 && b < 100 + gap && c.raw) {
      c.raw = c.raw.slice()
      c.raw[0] = -90
      c.raw[1] = -90
    }
    cells.push(c)
  }
  return cells
}

describe('EventLayer: a drop is the low end returning after a dropout of at least a bar', () => {
  it('emits one `drop` at the first whole cell after a 4 s dropout, marked corroborated, from the live source', () => {
    const drops = run({}, dropoutStream(8)).filter((e) => e.type === 'drop')
    expect(drops).toHaveLength(1)
    const d = drops[0]
    expect(d.source).toBe('live')
    expect(d.corroborated).toBe(true)
    expect(d.detectedAtBeat).toBe(108)
    expect(d.boundaryBeat).toBe(107)
    expect(d.strength).toBeGreaterThan(0.6)
    expect(d.feats.low).toBeGreaterThan(5) // the depth, for the director's "what to vary"
  })

  it('a 1-beat hiccup of the low end is not a drop; gapDrop: false turns the detector off', () => {
    expect(run({}, dropoutStream(2)).filter((e) => e.type === 'drop')).toEqual([])
    expect(run({ gapDrop: false }, dropoutStream(8)).filter((e) => e.type === 'drop')).toEqual([])
  })

  it('the corroborated flag does not leak from a drop into the next event that reuses its ring slot', () => {
    const layer = new EventLayer()
    const seen: SectionEvent[] = []
    for (const c of dropoutStream(8)) for (const e of layer.push(c, c.beat, c.beat * SPB, 120)) seen.push({ ...e })
    const rnd = mulberry(2)
    const more: BeatCell[] = []
    for (let b = 221; b <= 400; b++) more.push(makeCell(b <= 300 ? VERSE : CHORUS, b, rnd))
    for (const c of smoothChroma(more)) for (const e of layer.push(c, c.beat, c.beat * SPB, 120)) seen.push({ ...e })
    const change = seen.find((e) => e.type === 'change')
    expect(change).toBeDefined()
    expect((change as SectionEvent).corroborated).toBe(false)
  })

  it('the ring holds the drop once, in order, and the stats count it', () => {
    const layer = new EventLayer()
    const ring: SectionEvent[] = []
    for (const c of dropoutStream(8)) {
      layer.push(c, c.beat, c.beat * SPB, 120)
      layer.drain(ring)
    }
    expect(ring.filter((e) => e.type === 'drop')).toHaveLength(1)
    expect(layer.stats.drops).toBe(1)
  })
})
