/**
 * EVENT-LAYER CELL CACHE (phase 2, `so-the-mood-analysis-lively-hickey.md`): runs audio through `runTrack` with the live
 * event layer stepped (`hooks.events`) and stores what the layer was FED, the per-beat `BeatCell`s with the raw-dB tap,
 * so the change scorer can be tuned and re-scored in milliseconds (`replayCells`, `events-tune.calib.ts`,
 * `events-real.calib.ts`) without re-running the FFT chain.
 *
 *   node --max-old-space-size=3072 ./node_modules/vitest/vitest.mjs run --config vitest.calibration.config.ts scripts/calibrate/events-cache.calib.ts
 *
 * Knobs: EV_SYNTH=0        skip the synthetic stimuli (default: all 12, seed 1, 44.1 kHz)
 *        EV_SYNTH_ONLY=a,b only these stimuli
 *        EV_SEED=n         synthesis seed (default 1; other seeds are cached as synth_<name>_s<n>: a generalisation check)
 *        EV_REAL=N         real tracks decoded THIS run (deterministic shuffle of corpus/audio + testfolder; default 0)
 *        EV_REAL_OFFSET=n  skip the first n of the shuffle (run in chunks: 0, 6, 12, ...)
 *        EV_REAL_SEC=n     analyse at most the first n seconds of each real track (default 240)
 *        EV_RECOMPUTE=1    redo entries already cached
 *
 * Output (gitignored; derived from non-commercial audio for the real tracks): corpus/structure/events-cells/<id>.json.
 * Cell times are shifted onto the AUDIO clock (`runTrack` frames are stamped at the window START).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { EventCellRecord } from '../../src/audio/eval/eventReplay'
import type { SectionEvent } from '../../src/audio/events/types'
import { STIMULI, STIMULUS_NAMES, type StimulusName, type TruthEvent } from '../../src/audio/eval/synthSong'
import { decodeMp3File } from './decode'
import { runTrack } from './features'
import { rng } from './stats'

const ROOT = resolve(__dirname, '../..')
const AUDIO_DIR = join(ROOT, 'corpus/audio')
const TEST_DIR = join(ROOT, 'testfolder')
const OUT_DIR = join(ROOT, 'corpus/structure/events-cells')
const FFT_SIZE = 2048

const SYNTH = process.env.EV_SYNTH !== '0'
const SYNTH_ONLY = (process.env.EV_SYNTH_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const REAL = Math.max(0, Number(process.env.EV_REAL) || 0)
const REAL_OFFSET = Math.max(0, Number(process.env.EV_REAL_OFFSET) || 0)
const REAL_SEC = Number(process.env.EV_REAL_SEC) || 240
const RECOMPUTE = process.env.EV_RECOMPUTE === '1'
const SEED = Number(process.env.EV_SEED) || 1
const SEED_TAG = SEED === 1 ? '' : `_s${SEED}`

export interface CachedRun {
  id: string
  kind: 'synth' | 'real'
  tags: string[]
  bpm: number
  sampleRate: number
  durationSec: number
  truth: TruthEvent[]
  cells: EventCellRecord[]
  /** What the live layer delivered on this replay (default config), for a sanity comparison with a fresh replay. */
  liveEvents: SectionEvent[]
}

const round = (_k: string, v: unknown): unknown => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1e5) / 1e5 : v)

function save(run: CachedRun): void {
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(join(OUT_DIR, `${run.id}.json`), JSON.stringify(run, round))
}

const clean = (s: string): string => s.replace(/\r/g, '').trim().toLowerCase()

interface Item {
  id: string
  path: string
  tags: string[]
}

function listReal(): Item[] {
  const items: Item[] = []
  if (existsSync(AUDIO_DIR)) {
    let genres = new Map<string, string[]>()
    const manifest = join(ROOT, 'corpus/tracks.json')
    if (existsSync(manifest)) {
      const j = JSON.parse(readFileSync(manifest, 'utf8')) as { tracks: Array<{ file: string; genres?: string[] }> }
      genres = new Map(j.tracks.map((t) => [t.file, (t.genres ?? []).map(clean)]))
    }
    for (const f of readdirSync(AUDIO_DIR).filter((n) => /\.mp3$/i.test(n)).sort()) {
      items.push({ id: `jamendo_${f.replace(/\.mp3$/i, '')}`, path: join(AUDIO_DIR, f), tags: genres.get(f) ?? [] })
    }
  }
  if (existsSync(TEST_DIR)) {
    for (const f of readdirSync(TEST_DIR).filter((n) => /\.mp3$/i.test(n)).sort()) {
      const cat = f.split('__')[0] ?? ''
      const tags = cat.startsWith('electronic') ? ['electronic'] : cat.startsWith('rock-pop') ? ['rock'] : cat.startsWith('ambient') ? ['ambient'] : ['hiphop']
      items.push({ id: `test_${f.replace(/\.mp3$/i, '')}`, path: join(TEST_DIR, f), tags })
    }
  }
  return items
}

function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const idx = xs.map((_, i) => i)
  const r = rng(seed)
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[idx[i], idx[j]] = [idx[j], idx[i]]
  }
  return idx.map((i) => xs[i])
}

function toRun(id: string, kind: 'synth' | 'real', tags: string[], bpm: number, sr: number, durationSec: number, truth: TruthEvent[], res: ReturnType<typeof runTrack>): CachedRun {
  const off = FFT_SIZE / sr
  const shift = (t: number) => t + off
  const cells = (res.cells ?? []).map((r) => ({ ...r, time: shift(r.time) }))
  const liveEvents = (res.events ?? []).map((e) => ({
    ...e,
    boundaryTime: shift(e.boundaryTime),
    detectedAtTime: shift(e.detectedAtTime),
  }))
  return { id, kind, tags, bpm, sampleRate: sr, durationSec, truth, cells, liveEvents }
}

describe('event-layer cell cache', () => {
  const names = STIMULUS_NAMES.filter((n) => SYNTH && (SYNTH_ONLY.length === 0 || SYNTH_ONLY.includes(n)))
  for (const name of names) {
    it(
      `synth ${name}`,
      () => {
        if (!RECOMPUTE && existsSync(join(OUT_DIR, `synth_${name}${SEED_TAG}.json`))) return
        const s = STIMULI[name as StimulusName]({ sampleRate: 44100, seed: SEED })
        const res = runTrack(s.pcm, s.sampleRate, { events: true })
        const run = toRun(`synth_${name}${SEED_TAG}`, 'synth', [], s.bpm, s.sampleRate, s.songEndSec, s.truth, res)
        save(run)
        console.log(`  synth ${name}: ${run.cells.length} cells, ${run.liveEvents.length} live events`)
        expect(run.cells.length).toBeGreaterThan(20)
      },
      10 * 60 * 1000,
    )
  }

  const items = REAL > 0 ? shuffled(listReal(), 1).slice(REAL_OFFSET, REAL_OFFSET + REAL) : []
  for (const item of items) {
    it(
      `real ${item.id}`,
      async () => {
        if (!RECOMPUTE && existsSync(join(OUT_DIR, `${item.id}.json`))) return
        const audio = await decodeMp3File(item.path)
        const n = Math.min(audio.pcm.length, Math.floor(REAL_SEC * audio.sampleRate))
        const pcm = audio.pcm.subarray(0, n)
        const res = runTrack(pcm, audio.sampleRate, { events: true })
        const bpm = res.frames.length ? res.frames[Math.floor(res.frames.length / 2)].bpm : 120
        const run = toRun(item.id, 'real', item.tags, bpm, audio.sampleRate, n / audio.sampleRate, [], res)
        save(run)
        console.log(`  real ${item.id}: ${(n / audio.sampleRate).toFixed(0)} s, ${run.cells.length} cells, ${run.liveEvents.length} live events`)
        expect(run.cells.length).toBeGreaterThanOrEqual(0)
      },
      20 * 60 * 1000,
    )
  }
})
