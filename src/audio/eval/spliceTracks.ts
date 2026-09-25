/**
 * Spliced real-audio stimuli with a KNOWN join time (plan phase 0B).
 *
 * Two decoded tracks are cut at BEAT lines and joined: `A[0..n) B[0..n) A[n..2n) B[n..2n) ...` (or any explicit
 * plan). Each join is a hard change of timbre, harmony and usually tempo on real material, and its time is
 * known to the sample, so a detector's lag and hit rate can be measured on real timbres without labels.
 * The segments keep their own tempo (no time-stretching): the output beat grid is each track's own grid,
 * re-based at each join.
 *
 * The beat grid comes from the caller: `beatTimes` (seconds, one per beat) or `bpm` + `phaseSec`. It only decides
 * WHERE the cuts fall (on a beat line, so the splice sounds like a section change rather than a click); the truth
 * is the exact join sample, so a slightly wrong grid does not corrupt the score.
 *
 * Joins are crossfaded (equal-power, default 10 ms centred on the join) so there is no click; the truth time is
 * the centre of the crossfade = the first sample of the incoming segment's beat line.
 *
 * Pure: no I/O. Tests use synthetic PCM; `scripts/calibrate/synth-structure.calib.ts` feeds it decoded mp3s.
 */
import type { TruthEvent } from './synthSong'

export interface SpliceTrack {
  pcm: Float32Array
  sampleRate: number
  /** Beat times in seconds, ascending. Preferred over `bpm` + `phaseSec` when both are given. */
  beatTimes?: readonly number[]
  bpm?: number
  /** Time of a beat (seconds); the grid is `phaseSec + k * 60 / bpm`. Default 0. */
  phaseSec?: number
}

export interface SpliceSegmentSpec {
  /** 0 = first track, 1 = second track. */
  track: 0 | 1
  /** Beat index (into that track's grid) where the segment starts. */
  startBeat: number
  beats: number
}

export interface SpliceOptions {
  /** Explicit plan. Default: alternate 0,1,0,1... with `beatsPerSegment` each, each track continuing where it left off. */
  segments?: SpliceSegmentSpec[]
  /** Default 32. */
  beatsPerSegment?: number
  /** Default 4. */
  segmentCount?: number
  /** Total crossfade length in seconds (default 0.01). */
  crossfadeSec?: number
  /** Beats per bar used to number `TruthEvent.bar` (default 4). */
  beatsPerBar?: number
}

export interface SplicedSegment {
  track: 0 | 1
  beats: number
  /** Output time span (seconds). */
  startSec: number
  endSec: number
  /** Source time span (seconds) in the track's own clock. */
  srcStartSec: number
  srcEndSec: number
}

export interface SplicedStimulus {
  pcm: Float32Array
  sampleRate: number
  /** One `change` event (shouldTrigger true) per join, at the join's centre. */
  truth: TruthEvent[]
  /** Join times in seconds (`truth[i].timeSec`). */
  joinTimes: number[]
  /** Output beat lines (each segment's source beats re-based at its output start). */
  beatTimes: number[]
  segments: SplicedSegment[]
  durationSec: number
}

/** Linear-interpolation resampler (adequate for a stimulus whose only job is a known join time). */
export function resampleLinear(pcm: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return pcm
  const n = Math.max(1, Math.floor((pcm.length * to) / from))
  const out = new Float32Array(n)
  const step = from / to
  for (let i = 0; i < n; i++) {
    const x = i * step
    const i0 = Math.floor(x)
    const f = x - i0
    const a = pcm[i0] ?? 0
    const b = pcm[Math.min(pcm.length - 1, i0 + 1)] ?? a
    out[i] = a + (b - a) * f
  }
  return out
}

/** The track's beat times: `beatTimes` if given, else `phaseSec + k * 60 / bpm` up to the end of the audio. */
export function beatGridOf(track: SpliceTrack): number[] {
  if (track.beatTimes && track.beatTimes.length > 0) return [...track.beatTimes]
  if (!track.bpm || !(track.bpm > 0)) throw new Error('spliceTracks: a track needs beatTimes or a positive bpm')
  const period = 60 / track.bpm
  const dur = track.pcm.length / track.sampleRate
  const out: number[] = []
  for (let t = track.phaseSec ?? 0; t <= dur + 1e-9; t += period) out.push(t)
  return out
}

/** Read `pcm[i]`, 0 outside the buffer. */
const at = (pcm: Float32Array, i: number) => (i >= 0 && i < pcm.length ? pcm[i] : 0)

/**
 * Splice two tracks at beat lines. See the module header. Throws if a segment does not fit its track's grid.
 * If the tracks' sample rates differ, the second is linearly resampled to the first's rate.
 */
export function spliceTracks(a: SpliceTrack, b: SpliceTrack, opts: SpliceOptions = {}): SplicedStimulus {
  const sr = a.sampleRate
  const srcs: [Float32Array, Float32Array] = [a.pcm, b.sampleRate === sr ? b.pcm : resampleLinear(b.pcm, b.sampleRate, sr)]
  const grids: [number[], number[]] = [beatGridOf(a), beatGridOf(b)]
  const perSeg = opts.beatsPerSegment ?? 32
  const count = opts.segmentCount ?? 4
  const bpb = opts.beatsPerBar ?? 4

  let plan = opts.segments
  if (!plan) {
    const next: [number, number] = [0, 0]
    plan = []
    for (let i = 0; i < count; i++) {
      const track = (i % 2) as 0 | 1
      plan.push({ track, startBeat: next[track], beats: perSeg })
      next[track] += perSeg
    }
  }
  if (plan.length === 0) throw new Error('spliceTracks: empty plan')

  const half = Math.max(1, Math.round(((opts.crossfadeSec ?? 0.01) * sr) / 2))
  interface Placed {
    track: 0 | 1
    beats: number
    s: number
    e: number
    o: number
    beatsBefore: number
  }
  const placed: Placed[] = []
  let cursor = 0
  let beatCursor = 0
  for (const seg of plan) {
    const grid = grids[seg.track]
    if (seg.startBeat < 0 || seg.beats <= 0 || seg.startBeat + seg.beats >= grid.length) {
      throw new Error(
        `spliceTracks: segment (track ${seg.track}, beats ${seg.startBeat}..${seg.startBeat + seg.beats}) does not fit a grid of ${grid.length} beats`,
      )
    }
    const s = Math.round(grid[seg.startBeat] * sr)
    const e = Math.round(grid[seg.startBeat + seg.beats] * sr)
    if (e - s <= 2 * half) throw new Error('spliceTracks: segment shorter than the crossfade')
    placed.push({ track: seg.track, beats: seg.beats, s, e, o: cursor, beatsBefore: beatCursor })
    cursor += e - s
    beatCursor += seg.beats
  }

  const out = new Float32Array(cursor)
  for (const p of placed) {
    const src = srcs[p.track]
    for (let i = 0; i < p.e - p.s; i++) out[p.o + i] = at(src, p.s + i)
  }
  // Equal-power crossfade centred on each join, drawing on the outgoing segment's tail and the incoming head.
  for (let k = 1; k < placed.length; k++) {
    const prev = placed[k - 1]
    const cur = placed[k]
    const J = cur.o
    for (let n = -half; n < half; n++) {
      const idx = J + n
      if (idx < 0 || idx >= out.length) continue
      const theta = ((n + half + 0.5) / (2 * half)) * (Math.PI / 2)
      out[idx] = at(srcs[prev.track], prev.e + n) * Math.cos(theta) + at(srcs[cur.track], cur.s + n) * Math.sin(theta)
    }
  }

  const truth: TruthEvent[] = []
  const joinTimes: number[] = []
  const beatTimes: number[] = []
  const segments: SplicedSegment[] = []
  for (let k = 0; k < placed.length; k++) {
    const p = placed[k]
    const grid = grids[p.track]
    const startSec = p.o / sr
    segments.push({
      track: p.track,
      beats: p.beats,
      startSec,
      endSec: (p.o + p.e - p.s) / sr,
      srcStartSec: p.s / sr,
      srcEndSec: p.e / sr,
    })
    const startBeat = plan[k].startBeat
    for (let j = 0; j < p.beats; j++) beatTimes.push(startSec + (grid[startBeat + j] - grid[startBeat]))
    if (k > 0) {
      joinTimes.push(startSec)
      truth.push({
        type: 'change',
        timeSec: startSec,
        beat: p.beatsBefore,
        bar: Math.floor(p.beatsBefore / bpb),
        shouldTrigger: true,
        note: `splice track ${placed[k - 1].track} -> ${p.track}`,
        sectionIndex: k,
      })
    }
  }
  return { pcm: out, sampleRate: sr, truth, joinTimes, beatTimes, segments, durationSec: cursor / sr }
}
