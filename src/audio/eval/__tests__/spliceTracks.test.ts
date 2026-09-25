import { describe, expect, it } from 'vitest'
import { beatGridOf, resampleLinear, spliceTracks, type SpliceTrack } from '../spliceTracks'
import { synthSong, chord } from '../synthSong'
import { positiveTimes } from '../structureMetrics'

const SR = 8000

/** A constant-frequency sine track of `sec` seconds. */
function sine(freq: number, sec: number, sr = SR, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round(sec * sr))
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr)
  return out
}

const trackA = (): SpliceTrack => ({ pcm: sine(220, 40), sampleRate: SR, bpm: 120, phaseSec: 0.1 })
const trackB = (): SpliceTrack => ({ pcm: sine(700, 40), sampleRate: SR, bpm: 100, phaseSec: 0.3 })

describe('beatGridOf', () => {
  it('generates phase + k * 60 / bpm up to the end of the audio', () => {
    const g = beatGridOf({ pcm: new Float32Array(SR * 3), sampleRate: SR, bpm: 120, phaseSec: 0.25 })
    expect(g[0]).toBe(0.25)
    expect(g[1]).toBeCloseTo(0.75, 12)
    expect(g[g.length - 1]).toBeLessThanOrEqual(3)
    expect(g).toHaveLength(6)
  })

  it('prefers explicit beatTimes and requires some grid', () => {
    expect(beatGridOf({ pcm: new Float32Array(10), sampleRate: SR, beatTimes: [1, 2, 3], bpm: 120 })).toEqual([1, 2, 3])
    expect(() => beatGridOf({ pcm: new Float32Array(10), sampleRate: SR })).toThrow()
  })
})

describe('spliceTracks', () => {
  it('alternates A/B at beat lines and puts truth exactly at each join', () => {
    const s = spliceTracks(trackA(), trackB(), { beatsPerSegment: 8, segmentCount: 4 })
    // A: 8 beats @120 = 4 s; B: 8 beats @100 = 4.8 s
    expect(s.segments.map((x) => [x.track, x.beats])).toEqual([
      [0, 8],
      [1, 8],
      [0, 8],
      [1, 8],
    ])
    expect(s.segments[0].endSec - s.segments[0].startSec).toBeCloseTo(4, 3)
    expect(s.segments[1].endSec - s.segments[1].startSec).toBeCloseTo(4.8, 3)
    expect(s.joinTimes[0]).toBeCloseTo(4, 3)
    expect(s.joinTimes[1]).toBeCloseTo(8.8, 3)
    expect(s.joinTimes[2]).toBeCloseTo(12.8, 3)
    expect(s.durationSec).toBeCloseTo(4 + 4.8 + 4 + 4.8, 3)
    expect(s.pcm.length).toBe(Math.round(s.durationSec * SR))
    // truth: one positive change per join, beat and bar counted in output beats
    expect(s.truth).toHaveLength(3)
    expect(s.truth.map((t) => [t.type, t.shouldTrigger, t.beat, t.bar])).toEqual([
      ['change', true, 8, 2],
      ['change', true, 16, 4],
      ['change', true, 24, 6],
    ])
    expect(positiveTimes(s.truth)).toEqual(s.joinTimes)
    // each track continues where it left off: A's second segment starts at beat 8 of A's grid
    expect(s.segments[2].srcStartSec).toBeCloseTo(0.1 + 8 * 0.5, 3)
    expect(s.segments[3].srcStartSec).toBeCloseTo(0.3 + 8 * 0.6, 3)
  })

  it('output beat lines follow each segment\'s own tempo, re-based at the join', () => {
    const s = spliceTracks(trackA(), trackB(), { beatsPerSegment: 4, segmentCount: 2 })
    expect(s.beatTimes).toHaveLength(8)
    expect(s.beatTimes[0]).toBeCloseTo(0, 6)
    expect(s.beatTimes[1]).toBeCloseTo(0.5, 6)
    expect(s.beatTimes[4]).toBeCloseTo(2, 3)
    expect(s.beatTimes[5]).toBeCloseTo(2.6, 3)
  })

  it('the incoming segment starts on the source beat line (content is the source at that sample)', () => {
    const s = spliceTracks(trackA(), trackB(), { beatsPerSegment: 8, segmentCount: 2, crossfadeSec: 0.01 })
    const b = trackB()
    const srcStart = Math.round(0.3 * SR)
    const join = Math.round(s.joinTimes[0] * SR)
    const half = Math.round(0.005 * SR)
    // well after the crossfade, the output equals the B source sample for sample
    for (let n = half + 2; n < half + 200; n++) expect(s.pcm[join + n]).toBeCloseTo(b.pcm[srcStart + n], 6)
    // well before it, it equals A
    const a = trackA()
    const aStart = Math.round(0.1 * SR)
    for (let n = half + 2; n < half + 200; n++) expect(s.pcm[join - n]).toBeCloseTo(a.pcm[aStart + (join - n)], 6)
  })

  it('crossfades are equal-power and click-free: bounded, and no sample jump beyond the source slope', () => {
    const s = spliceTracks(trackA(), trackB(), { beatsPerSegment: 8, segmentCount: 2 })
    const join = Math.round(s.joinTimes[0] * SR)
    let maxJump = 0
    let peak = 0
    for (let i = join - 60; i < join + 60; i++) {
      maxJump = Math.max(maxJump, Math.abs(s.pcm[i + 1] - s.pcm[i]))
      peak = Math.max(peak, Math.abs(s.pcm[i]))
    }
    // two 0.5-amp sines: the steepest a single one moves is 0.5*2*pi*700/8000 ~ 0.28; a hard cut would jump up to ~1
    expect(maxJump).toBeLessThan(0.45)
    expect(peak).toBeLessThan(0.75)
  })

  it('a hard-cut-free join has the same total energy either side (no gap, no doubling)', () => {
    const s = spliceTracks(trackA(), trackB(), { beatsPerSegment: 8, segmentCount: 2 })
    const join = Math.round(s.joinTimes[0] * SR)
    const rms = (a: number, b: number) => {
      let q = 0
      for (let i = a; i < b; i++) q += s.pcm[i] * s.pcm[i]
      return Math.sqrt(q / (b - a))
    }
    // 0.5-amp sine RMS = 0.3536
    expect(rms(join - 2000, join - 200)).toBeCloseTo(0.3536, 2)
    expect(rms(join + 200, join + 2000)).toBeCloseTo(0.3536, 2)
  })

  it('explicit plans, including several joins on the same track', () => {
    const s = spliceTracks(trackA(), trackB(), {
      segments: [
        { track: 1, startBeat: 2, beats: 6 },
        { track: 0, startBeat: 10, beats: 4 },
        { track: 0, startBeat: 30, beats: 4 },
      ],
    })
    expect(s.truth.map((t) => [t.beat, t.note])).toEqual([
      [6, 'splice track 1 -> 0'],
      [10, 'splice track 0 -> 0'],
    ])
    expect(s.durationSec).toBeCloseTo(6 * 0.6 + 4 * 0.5 + 4 * 0.5, 3)
  })

  it('resamples a second track at a different sample rate', () => {
    const b48: SpliceTrack = { pcm: sine(700, 40, 16000), sampleRate: 16000, bpm: 100, phaseSec: 0.3 }
    const s = spliceTracks(trackA(), b48, { beatsPerSegment: 8, segmentCount: 2 })
    expect(s.sampleRate).toBe(SR)
    expect(s.segments[1].endSec - s.segments[1].startSec).toBeCloseTo(4.8, 2)
  })

  it('rejects segments that do not fit the grid', () => {
    expect(() => spliceTracks(trackA(), trackB(), { beatsPerSegment: 200, segmentCount: 2 })).toThrow(/does not fit/)
    expect(() => spliceTracks(trackA(), trackB(), { segments: [] })).toThrow(/empty plan/)
    expect(() => spliceTracks(trackA(), trackB(), { segments: [{ track: 0, startBeat: 0, beats: 1 }], crossfadeSec: 5 })).toThrow(/shorter than the crossfade/)
  })

  it('works on synthesised songs (real drum/pad timbres) using their beat lists', () => {
    const mk = (bpm: number, root: number, seed: number) =>
      synthSong({
        name: 'x',
        bpm,
        seed,
        sampleRate: 11025,
        sections: [{ label: 's', bars: 16, chords: [chord(root, 'min')], kick: 'four', snare: 'backbeat', hats: 'eighth', bass: 'root' }],
      })
    const a = mk(120, 9, 1)
    const b = mk(128, 2, 2)
    const s = spliceTracks(
      { pcm: a.pcm, sampleRate: a.sampleRate, beatTimes: a.beatTimes },
      { pcm: b.pcm, sampleRate: b.sampleRate, beatTimes: b.beatTimes },
      { beatsPerSegment: 16, segmentCount: 3 },
    )
    expect(s.joinTimes).toHaveLength(2)
    expect(s.joinTimes[0]).toBeCloseTo(16 * 0.5, 3)
    expect(s.joinTimes[1]).toBeCloseTo(16 * 0.5 + 16 * (60 / 128), 3)
    expect(Array.from(s.pcm).every(Number.isFinite)).toBe(true)
  })
})

describe('resampleLinear', () => {
  it('is the identity at equal rates and scales the length otherwise', () => {
    const x = sine(100, 1, 1000)
    expect(resampleLinear(x, 1000, 1000)).toBe(x)
    expect(resampleLinear(x, 1000, 2000)).toHaveLength(2000)
    const y = resampleLinear(x, 1000, 500)
    expect(y).toHaveLength(500)
    expect(y[10]).toBeCloseTo(x[20], 6)
  })
})
