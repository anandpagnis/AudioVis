import { describe, expect, it } from 'vitest'
import {
  STIMULI,
  STIMULUS_NAMES,
  chord,
  hashPcm,
  synthSong,
  type StimulusName,
  type SynthSong,
  type TruthEvent,
  type TruthEventType,
} from '../synthSong'

/** 22.05 kHz keeps the whole file to a few seconds; one 44.1 kHz build checks the default rate. */
const SR = 22050
const cache = new Map<StimulusName, SynthSong>()
function stim(name: StimulusName): SynthSong {
  let s = cache.get(name)
  if (!s) {
    s = STIMULI[name]({ sampleRate: SR })
    cache.set(name, s)
  }
  return s
}

/* ---------------------------- measurement helpers ---------------------------- */

function rmsDb(pcm: Float32Array, sr: number, t0: number, t1: number): number {
  const i0 = Math.round(t0 * sr)
  const i1 = Math.min(pcm.length, Math.round(t1 * sr))
  let q = 0
  for (let i = i0; i < i1; i++) q += pcm[i] * pcm[i]
  return 10 * Math.log10(q / Math.max(1, i1 - i0) + 1e-20)
}

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k
        const b = i + k + len / 2
        const xr = re[b] * cr - im[b] * ci
        const xi = re[b] * ci + im[b] * cr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
        const t = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = t
      }
    }
  }
}

const NFFT = 16384
/** Mean Hann-windowed magnitude spectrum over `wins` windows spread across [t0, t1]. */
function avgSpectrum(pcm: Float32Array, sr: number, t0: number, t1: number, wins = 8): Float64Array {
  const acc = new Float64Array(NFFT / 2)
  for (let w = 0; w < wins; w++) {
    const st = Math.round((t0 + ((t1 - t0 - NFFT / sr) * w) / (wins - 1)) * sr)
    const re = new Float64Array(NFFT)
    const im = new Float64Array(NFFT)
    for (let i = 0; i < NFFT; i++) re[i] = (pcm[st + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / NFFT))
    fft(re, im)
    for (let k = 0; k < NFFT / 2; k++) acc[k] += Math.hypot(re[k], im[k])
  }
  return acc
}

function chroma(spec: Float64Array, sr: number): number[] {
  const c = new Array<number>(12).fill(0)
  for (let k = 1; k < spec.length; k++) {
    const f = (k * sr) / NFFT
    if (f < 60 || f > 2000) continue
    c[(((Math.round(12 * Math.log2(f / 440) + 69) % 12) + 12) % 12)] += spec[k]
  }
  const n = Math.hypot(...c)
  return c.map((v) => v / n)
}

const cosine = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0)

/** Band energy in dB over [lo, hi) Hz. */
function bandDb(spec: Float64Array, sr: number, lo: number, hi: number): number {
  let e = 0
  for (let k = 1; k < spec.length; k++) {
    const f = (k * sr) / NFFT
    if (f >= lo && f < hi) e += spec[k] * spec[k]
  }
  return 10 * Math.log10(e + 1e-20)
}

const sig = (t: TruthEvent) => `${t.type}${t.shouldTrigger ? '+' : '-'}@${t.bar}`

/* ---------------------------------- tests ---------------------------------- */

describe('synthSong: determinism and timing', () => {
  const spec = () => ({
    name: 'tiny',
    bpm: 120,
    sampleRate: 11025,
    sections: [
      { label: 'a', bars: 4, chords: [chord(0), chord(7)], kick: 'four' as const, hats: 'eighth' as const, bass: 'root' as const, lead: 'melody' as const },
      { label: 'b', bars: 4, chords: [chord(9, 'min')], kick: 'oneAndThree' as const, riser: true, snareRoll: 2, event: { type: 'change' as const } },
    ],
  })

  it('same seed gives an identical PCM hash; a different seed does not', () => {
    const a = synthSong({ ...spec(), seed: 5 })
    const b = synthSong({ ...spec(), seed: 5 })
    const c = synthSong({ ...spec(), seed: 6 })
    expect(hashPcm(a.pcm)).toBe(hashPcm(b.pcm))
    expect(hashPcm(a.pcm)).not.toBe(hashPcm(c.pcm))
    expect(a.truth).toEqual(b.truth)
  })

  it('a catalogue stimulus is reproducible', () => {
    expect(hashPcm(STIMULI.fillsOnly({ sampleRate: 8000 }).pcm)).toBe(hashPcm(STIMULI.fillsOnly({ sampleRate: 8000 }).pcm))
  })

  it('sample count = end of the last bar + the 1.2 s tail; beat/bar/truth times follow bpm and the spec', () => {
    const s = synthSong(spec())
    expect(s.beatTimes).toHaveLength(32)
    expect(s.barTimes).toHaveLength(8)
    s.beatTimes.forEach((t, k) => expect(t).toBeCloseTo(k * 0.5, 9))
    s.barTimes.forEach((t, i) => expect(t).toBeCloseTo(i * 2, 9))
    expect(s.songEndSec).toBeCloseTo(16, 9)
    expect(s.pcm.length).toBe(Math.ceil((16 + 1.2) * 11025))
    expect(s.truth).toHaveLength(1)
    expect(s.truth[0]).toMatchObject({ type: 'change', beat: 16, bar: 4, shouldTrigger: true, sectionIndex: 1 })
    expect(s.truth[0].timeSec).toBeCloseTo(8, 9)
    expect(s.sections.map((x) => [x.startBar, x.endBar, x.startSec, x.endSec])).toEqual([
      [0, 4, 0, 8],
      [4, 8, 8, 16],
    ])
  })

  it('startOffsetSec shifts every time and leaves leading silence', () => {
    const s = synthSong({ ...spec(), startOffsetSec: 0.5 })
    expect(s.beatTimes[0]).toBeCloseTo(0.5, 9)
    expect(s.truth[0].timeSec).toBeCloseTo(8.5, 9)
    expect(rmsDb(s.pcm, s.sampleRate, 0, 0.45)).toBeLessThan(-100)
  })

  it('tempoDrift: beats wobble within +-2%, bar times stay on every 4th beat, drums follow the drift', () => {
    const s = stim('tempoDrift')
    const ibi = s.beatTimes.slice(1).map((t, k) => t - s.beatTimes[k])
    expect(Math.max(...ibi)).toBeLessThanOrEqual(0.5 / 0.98 + 1e-9)
    expect(Math.min(...ibi)).toBeGreaterThanOrEqual(0.5 / 1.02 - 1e-9)
    expect(Math.max(...ibi) - Math.min(...ibi)).toBeGreaterThan(0.015)
    s.barTimes.forEach((t, i) => expect(t).toBe(s.beatTimes[i * 4]))
    // Kicks sit on beats 1 and 3 of every bar (both sections), so on those beats the energy just after the beat
    // exceeds the energy just before it. Without the drift-following beat map they would drift up to ~100 ms off.
    let rises = 0
    let n = 0
    for (let k = 8; k < s.beatTimes.length - 8; k += 2) {
      n++
      const t = s.beatTimes[k]
      if (rmsDb(s.pcm, SR, t + 0.005, t + 0.06) > rmsDb(s.pcm, SR, t - 0.07, t - 0.02) + 3) rises++
    }
    expect(rises / n).toBeGreaterThan(0.85)
  })
})

describe('synthSong: the stimulus catalogue', () => {
  it('lists the 12 required stimuli', () => {
    expect([...STIMULUS_NAMES].sort()).toEqual(
      [
        'breakdown',
        'buildThenDrop',
        'fillsOnly',
        'fourSections',
        'gainStep',
        'gradualMorph16',
        'keyChangeEqualLoudness',
        'mixed',
        'silenceGap',
        'slowAmbient',
        'tempoDrift',
        'verseChorusEqualLoudness',
      ].sort(),
    )
  })

  it.each([...STIMULUS_NAMES])('%s: builds finite, non-clipping audio of a sane length', (name) => {
    const s = stim(name)
    let peak = 0
    let bad = 0
    for (let i = 0; i < s.pcm.length; i++) {
      const v = s.pcm[i]
      if (!Number.isFinite(v)) bad++
      else if (Math.abs(v) > peak) peak = Math.abs(v)
    }
    expect(bad).toBe(0)
    expect(peak).toBeLessThanOrEqual(1)
    expect(peak).toBeGreaterThan(0.5)
    expect(s.name).toBe(name)
    expect(s.description.length).toBeGreaterThan(10)
    const dur = s.pcm.length / s.sampleRate
    expect(dur).toBeGreaterThanOrEqual(60)
    // `mixed` is the specified 88-bar structure: ~151 s at 140 BPM, everything else stays under ~2 minutes.
    expect(dur).toBeLessThanOrEqual(name === 'mixed' ? 155 : 125)
    expect(s.bpm).toBeGreaterThanOrEqual(name === 'slowAmbient' ? 90 : 100)
    expect(s.bpm).toBeLessThanOrEqual(140)
    // times are consistent
    expect(s.beatTimes).toHaveLength(s.sections[s.sections.length - 1].endBar * 4)
    expect(s.sections[s.sections.length - 1].endSec).toBeCloseTo(s.songEndSec, 9)
    for (const t of s.truth) {
      expect(t.timeSec).toBeGreaterThanOrEqual(0)
      expect(t.timeSec).toBeLessThan(s.songEndSec)
      expect(t.bar).toBe(Math.floor(t.beat / 4))
      expect(t.timeSec).toBeGreaterThanOrEqual(s.beatTimes[t.beat] - 1e-9)
      expect(t.timeSec).toBeLessThanOrEqual(s.beatTimes[t.beat] + 1e-9)
    }
  })

  it('synthesises a 2-minute song at 44.1 kHz well under 3 s', () => {
    const t0 = performance.now()
    const s = STIMULI.fourSections()
    const ms = performance.now() - t0
    expect(s.sampleRate).toBe(44100)
    expect(s.pcm.length / 44100).toBeGreaterThan(119)
    expect(ms).toBeLessThan(3000)
  })

  const EXPECTED: Record<StimulusName, string[]> = {
    buildThenDrop: ['buildStart+@16', 'drop+@32', 'fill-@39', 'fill-@47'],
    breakdown: ['fill-@7', 'breakdown+@16', 'drop+@24'],
    verseChorusEqualLoudness: ['change+@16', 'change+@32', 'change+@40'],
    keyChangeEqualLoudness: ['change+@16', 'change+@32'],
    gradualMorph16: ['change-@20', 'change-@24', 'change-@28', 'change+@32'],
    fillsOnly: ['fill-@3', 'fill-@7', 'fill-@11', 'fill-@15', 'fill-@19', 'fill-@23', 'fill-@31', 'fill-@39', 'fill-@47'],
    gainStep: ['gain-@16', 'gain-@32'],
    silenceGap: ['silence-@16', 'silence-@28'],
    tempoDrift: ['change+@16', 'change+@32'],
    slowAmbient: ['change+@10', 'change+@20', 'change+@30'],
    fourSections: ['change+@16', 'change+@32', 'change+@48'],
    mixed: [
      'change+@8',
      'fill-@15',
      'buildStart+@24',
      'drop+@32',
      'fill-@39',
      'breakdown+@48',
      'buildStart+@56',
      'drop+@64',
      'fill-@71',
      'change+@80',
    ],
  }
  it.each([...STIMULUS_NAMES])('%s: documented positives and negatives', (name) => {
    expect(stim(name).truth.map(sig)).toEqual(EXPECTED[name])
  })

  it('negatives are exactly fills, gain steps, silence gaps and morph steps', () => {
    const neg = new Set<TruthEventType>()
    for (const name of STIMULUS_NAMES) for (const t of stim(name).truth) if (!t.shouldTrigger) neg.add(t.type)
    expect([...neg].sort()).toEqual(['change', 'fill', 'gain', 'silence'])
    // and every fill / gain / silence event is a negative
    for (const name of STIMULUS_NAMES) {
      for (const t of stim(name).truth) if (t.type === 'fill' || t.type === 'gain' || t.type === 'silence') expect(t.shouldTrigger).toBe(false)
    }
  })

  it('negative-only stimuli carry no positive truth', () => {
    for (const name of ['fillsOnly', 'gainStep', 'silenceGap'] as const) expect(stim(name).truth.some((t) => t.shouldTrigger)).toBe(false)
  })

  it('fills never sit in the bar before a real change', () => {
    for (const name of STIMULUS_NAMES) {
      const s = stim(name)
      const positiveBars = new Set(s.truth.filter((t) => t.shouldTrigger).map((t) => t.bar))
      for (const t of s.truth) if (t.type === 'fill') expect(positiveBars.has(t.bar + 1)).toBe(false)
    }
  })

  it('fourSections: A repeats exactly, B is varied', () => {
    const s = stim('fourSections')
    expect(s.sections.map((x) => x.repeatOf)).toEqual([null, null, 0, null])
    expect(s.sections.map((x) => x.variantOf)).toEqual([null, null, null, 1])
    expect(s.truth.map((t) => t.repeatOf)).toEqual([undefined, 0, undefined])
    expect(s.truth[2].note).toContain('variation')
    // exact repeat: the two A sections have the same chroma and the same level
    const [a0, , a2, b3] = s.sections
    const spec = (sec: { startSec: number; endSec: number }) => avgSpectrum(s.pcm, SR, sec.startSec + 2, sec.endSec - 2)
    const cA0 = chroma(spec(a0), SR)
    expect(cosine(cA0, chroma(spec(a2), SR))).toBeGreaterThan(0.995)
    expect(Math.abs(rmsDb(s.pcm, SR, a0.startSec + 2, a0.endSec - 2) - rmsDb(s.pcm, SR, a2.startSec + 2, a2.endSec - 2))).toBeLessThan(0.3)
    // ... while B differs from A
    expect(cosine(cA0, chroma(spec(s.sections[1]), SR))).toBeLessThan(0.9)
    // and the variation B' keeps B's harmony (same chords)
    expect(cosine(chroma(spec(s.sections[1]), SR), chroma(spec(b3), SR))).toBeGreaterThan(0.97)
  })

  it('mixed: two drops and two builds are exact repeats', () => {
    const s = stim('mixed')
    expect(s.sections.map((x) => x.label)).toEqual(['intro', 'verse', 'build', 'drop', 'breakdown', 'build', 'drop', 'outro'])
    expect(s.sections.map((x) => x.endBar - x.startBar)).toEqual([8, 16, 8, 16, 8, 8, 16, 8])
    expect(s.sections[5].repeatOf).toBe(2)
    expect(s.sections[6].repeatOf).toBe(3)
  })
})

describe('synthSong: level and spectrum of the designed stimuli', () => {
  const interior = (s: SynthSong, i: number) => [s.sections[i].startSec + 2, s.sections[i].endSec - 2] as const

  it('verseChorusEqualLoudness: equal RMS (< 1 dB) but different timbre and harmony', () => {
    const s = stim('verseChorusEqualLoudness')
    const levels = s.sections.map((_, i) => rmsDb(s.pcm, SR, ...interior(s, i)))
    expect(Math.max(...levels) - Math.min(...levels)).toBeLessThan(1)
    const verse = avgSpectrum(s.pcm, SR, ...interior(s, 0))
    const chorus = avgSpectrum(s.pcm, SR, ...interior(s, 1))
    // brighter: >= 10 dB more energy above 2 kHz although the overall level is equal
    expect(bandDb(chorus, SR, 2000, 8000) - bandDb(verse, SR, 2000, 8000)).toBeGreaterThan(10)
    // different chord set: the pitch-class profiles clearly differ
    expect(cosine(chroma(verse, SR), chroma(chorus, SR))).toBeLessThan(0.9)
    // the verse returns unchanged
    expect(cosine(chroma(verse, SR), chroma(avgSpectrum(s.pcm, SR, ...interior(s, 2)), SR))).toBeGreaterThan(0.99)
  })

  it('keyChangeEqualLoudness: equal RMS and equal band balance, but the harmony moves', () => {
    const s = stim('keyChangeEqualLoudness')
    const levels = s.sections.map((_, i) => rmsDb(s.pcm, SR, ...interior(s, i)))
    expect(Math.max(...levels) - Math.min(...levels)).toBeLessThan(1)
    const spec = s.sections.map((_, i) => avgSpectrum(s.pcm, SR, ...interior(s, i)))
    for (let i = 1; i < spec.length; i++) {
      for (const [lo, hi] of [
        [20, 250],
        [250, 2000],
        [2000, 8000],
      ]) {
        expect(Math.abs(bandDb(spec[i], SR, lo, hi) - bandDb(spec[0], SR, lo, hi))).toBeLessThan(2)
      }
      expect(cosine(chroma(spec[i - 1], SR), chroma(spec[i], SR))).toBeLessThan(0.93)
    }
  })

  it('gainStep: +6 dB then -6 dB, exactly', () => {
    const s = stim('gainStep')
    const bar = 2
    const win = (b0: number, b1: number) => rmsDb(s.pcm, SR, b0 * bar + 0.5, b1 * bar - 0.5)
    const before = win(0, 16)
    const up = win(16, 32)
    const after = win(32, 48)
    expect(up - before).toBeGreaterThan(5.7)
    expect(up - before).toBeLessThan(6.3)
    expect(after - before).toBeGreaterThan(-0.3)
    expect(after - before).toBeLessThan(0.3)
    // and a step is a step: the 4 bars right around it differ by ~6 dB too
    expect(rmsDb(s.pcm, SR, 32 - 8, 32 - 0.1) - rmsDb(s.pcm, SR, 32 - 16, 32 - 8)).toBeLessThan(1)
    expect(rmsDb(s.pcm, SR, 32.1, 40) - rmsDb(s.pcm, SR, 24, 31.9)).toBeGreaterThan(5)
  })

  it('silenceGap: a 2-beat digital gap (1 s at 120 BPM), audio on both sides', () => {
    const s = stim('silenceGap')
    for (const g of s.truth.filter((t) => t.type === 'silence')) {
      const i0 = Math.round(g.timeSec * SR)
      const i1 = Math.round((g.timeSec + 1) * SR)
      let peak = 0
      for (let i = i0 + 2; i < i1 - 2; i++) peak = Math.max(peak, Math.abs(s.pcm[i]))
      expect(peak).toBe(0)
      expect(rmsDb(s.pcm, SR, g.timeSec - 1, g.timeSec - 0.01)).toBeGreaterThan(-40)
      expect(rmsDb(s.pcm, SR, g.timeSec + 1.01, g.timeSec + 2)).toBeGreaterThan(-40)
    }
  })

  it('gradualMorph16: the brightness and level rise monotonically through the morph', () => {
    const s = stim('gradualMorph16')
    const hi = [4, 34, 46, 56, 70].map((a) => bandDb(avgSpectrum(s.pcm, SR, a, a + 6), SR, 2000, 8000))
    for (let i = 1; i < hi.length; i++) expect(hi[i]).toBeGreaterThan(hi[i - 1])
    const lvl = [4, 34, 46, 56, 70].map((a) => rmsDb(s.pcm, SR, a, a + 6))
    expect(lvl[4]).toBeGreaterThan(lvl[0] + 4)
  })

  it('buildThenDrop: crescendo through the build, kick dropout, then a step up at the drop', () => {
    const s = stim('buildThenDrop')
    const bar = 60 / 128 * 4
    // last 4 bars of the build carry no kick: the sub-100 Hz energy there is far below the drop's
    const lowBuild = bandDb(avgSpectrum(s.pcm, SR, 28 * bar + 1, 32 * bar - 1, 6), SR, 30, 100)
    const lowDrop = bandDb(avgSpectrum(s.pcm, SR, 33 * bar, 37 * bar, 6), SR, 30, 100)
    expect(lowDrop - lowBuild).toBeGreaterThan(6)
    // brightness climbs across the build
    const b = (a: number) => bandDb(avgSpectrum(s.pcm, SR, a * bar, a * bar + 3 * bar, 6), SR, 3000, 9000)
    expect(b(24)).toBeGreaterThan(b(17) + 6)
  })

  it('breakdown: kick and bass drop out for the 8 bars, then return', () => {
    const s = stim('breakdown')
    const [full, bd, ret] = s.sections
    const low = (sec: { startSec: number; endSec: number }) => bandDb(avgSpectrum(s.pcm, SR, sec.startSec + 2, sec.endSec - 2, 6), SR, 30, 120)
    expect(low(full) - low(bd)).toBeGreaterThan(10)
    expect(Math.abs(low(ret) - low(full))).toBeLessThan(1)
  })

  it('slowAmbient has no drums: no hat/snare noise above the pad', () => {
    // a filtered saw pad has essentially nothing above 5 kHz; hats and snares fill that band
    const air = (name: StimulusName) => {
      const s = stim(name)
      const spec = avgSpectrum(s.pcm, SR, 20, 50)
      return bandDb(spec, SR, 5000, 10000) - bandDb(spec, SR, 60, 2000)
    }
    expect(air('slowAmbient')).toBeLessThan(air('gainStep') - 20)
  })
})
