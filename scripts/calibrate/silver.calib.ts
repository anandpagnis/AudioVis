/**
 * SILVER STANDARD run (plan phase 4, `so-the-mood-analysis-lively-hickey.md`): analyse the full-length local tracks
 * with the whole-song, NON-causal analyser (`src/audio/plan/analyzeSong.ts`, future included) and write, per track,
 * the section boundaries / events the causal live detector can later be scored against. There are no human structure
 * labels anywhere in this repo, so this is an evaluation REFERENCE, not truth: it is only trustworthy after it has
 * been validated against the user's tap logs (`src/audio/eval/structureLogToTruth.ts`) and against the synthetic
 * suite (`src/audio/plan/__tests__/analyzeSong.test.ts`).
 *
 *   node --max-old-space-size=3072 ./node_modules/vitest/vitest.mjs run --config vitest.calibration.config.ts scripts/calibrate/silver.calib.ts
 *
 * Data (gitignored): `corpus/audio/*.mp3` (90 full-length Jamendo tracks) and `testfolder/*.mp3` (8). Nothing is
 * fetched. Decoding goes through `decode.ts` (`decodeMp3File`, mono mixdown at the file's own rate).
 *
 * Knobs: SILVER_LIMIT=N   tracks per run after the offset, deterministic sample (default 10; 0 = every track)
 *        SILVER_OFFSET=n  skip the first n tracks of the seeded shuffle (default 0), so consecutive runs of
 *                         `SILVER_OFFSET=0,10,20...` walk the whole set in memory-safe chunks
 *        SILVER_SEED=n    shuffle seed (default 1)
 *
 * Output (gitignored, derived; `corpus/structure/` is ignored):
 *   corpus/structure/silver/<id>.json   one file per analysed track (schema below)
 *   corpus/structure/silver-report.md   aggregates over EVERY file in silver/ (not just this run's chunk), so
 *                                       chunked runs accumulate
 *
 * ## How a later evaluation harness loads a silver file
 *
 *   const j = JSON.parse(readFileSync('corpus/structure/silver/<id>.json', 'utf8'))
 *   j.schema === 'audiovis.silver' && j.version === 1
 *   j.plan.bpm, j.plan.beats[], j.plan.downbeatPhase, j.plan.bars[]      seconds from sample 0 of the decoded mono PCM
 *   j.plan.events[]                                                       `SectionEvent`s (`../events/types`), source 'plan':
 *       boundaryTime / boundaryBeat (bar-aligned; beat index into plan.beats), type change|drop|buildStart|breakdown,
 *       strength / confidence 0..1, `sim` on a return to earlier material. detectedAt* == boundary* (no latency).
 *   j.plan.segments[]                                                     {startSec,endSec,startBar,endBar,label,repeatOf?,meanLevelDb}
 *   j.plan.diagnostics                                                    tempo / downbeat confidence, novelty curve, warnings
 *
 * Score a detector with `mirEvalStyleDetectionF(silverBoundaryTimes, detectorTimes, 0.5 | 3)` and
 * `scoreDetectionsBars(...)` from `src/audio/eval/structureMetrics.ts`, taking `plan.events.map(e => e.boundaryTime)`
 * as the reference (all of them for recall; only `strength >= 0.5` for a precision-critical reference: about a third of the events are marginal); weight by `confidence` (or drop tracks with `diagnostics.tempo.confidence < 0.3` /
 * `diagnostics.downbeat.confidence < 0.5`) where the bar grid is unreliable. Times are on the decoded-file clock; the
 * live audio clock can differ by the mp3 decoder delay (tens of ms), well inside the +-0.5 s / +-1 bar windows.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeSong } from '../../src/audio/plan/analyzeSong'
import type { SongPlan } from '../../src/audio/plan/types'
import { decodeMp3File } from './decode'
import { mean, rng } from './stats'

const ROOT = resolve(__dirname, '../..')
const OUT_DIR = join(ROOT, 'corpus/structure')
const SILVER_DIR = join(OUT_DIR, 'silver')
const OUT_MD = join(OUT_DIR, 'silver-report.md')

const LIMIT = process.env.SILVER_LIMIT === undefined ? 10 : Math.max(0, Number(process.env.SILVER_LIMIT) || 0)
const OFFSET = Math.max(0, Number(process.env.SILVER_OFFSET) || 0)
const SEED = Number(process.env.SILVER_SEED) || 1

interface Item {
  id: string
  set: 'corpus' | 'testfolder'
  path: string
  rel: string
}

function listMp3(dir: string, set: Item['set']): Item[] {
  const abs = join(ROOT, dir)
  if (!existsSync(abs)) return []
  return readdirSync(abs)
    .filter((n) => /\.mp3$/i.test(n))
    .sort()
    .map((n) => {
      const base = n.replace(/\.mp3$/i, '')
      return { id: set === 'corpus' ? base : `testfolder_${base}`, set, path: join(abs, n), rel: `${dir}/${n}` }
    })
}

/** Seeded shuffle of the whole list (same shape as `structure-sanity.calib.ts`), then the `[offset, offset + n)` slice. */
function chunk<T>(items: T[], n: number, offset: number, seed: number): T[] {
  const idx = items.map((_, i) => i)
  const r = rng(seed)
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[idx[i], idx[j]] = [idx[j], idx[i]]
  }
  const order = idx.map((i) => items[i])
  return n > 0 ? order.slice(offset, offset + n) : order.slice(offset)
}

export interface SilverFile {
  schema: 'audiovis.silver'
  version: 1
  id: string
  set: Item['set']
  file: string
  durationSec: number
  sampleRate: number
  generated: string
  plan: SongPlan
}

/** JSON with numbers rounded to 4 decimals (times are seconds; 0.1 ms is far below any tolerance). */
function stringify(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : x))
}

/* ---------------------------------- aggregates ---------------------------------- */

const pct = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : 'n/a')
const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : 'n/a')
const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : 'n/a')

function quantile(xs: number[], p: number): number {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const i = p * (s.length - 1)
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return s[lo] + (s[hi] - s[lo]) * (i - lo)
}

function loadAll(): SilverFile[] {
  if (!existsSync(SILVER_DIR)) return []
  const out: SilverFile[] = []
  for (const n of readdirSync(SILVER_DIR).sort()) {
    if (!n.endsWith('.json')) continue
    try {
      const j = JSON.parse(readFileSync(join(SILVER_DIR, n), 'utf8')) as SilverFile
      if (j.schema === 'audiovis.silver') out.push(j)
    } catch {
      /* a half-written file from an interrupted run: skip */
    }
  }
  return out
}

function buildReport(files: SilverFile[], thisRun: number, failed: number, elapsedSec: number): string {
  const L: string[] = []
  L.push('# Silver standard: whole-song structure analysis', '')
  L.push(
    `Generated ${new Date().toISOString()} | ${files.length} tracks analysed in total (this run: ${thisRun}, ${failed} failed, ${(elapsedSec / 60).toFixed(1)} min) | SILVER_LIMIT=${LIMIT || 'all'} SILVER_OFFSET=${OFFSET} SILVER_SEED=${SEED}`,
    '',
  )
  L.push(
    'A REFERENCE for evaluating the causal live detector, NOT ground truth: it uses the whole song (future included) and',
    'shares its features with the live detector, so it is circular until validated against the user tap logs. Validated so far',
    'only on the synthetic suite. Aggregates below cover every file in `corpus/structure/silver/`.',
    '',
  )

  const plans = files.map((f) => f.plan)
  const ok = plans.filter((p) => p.diagnostics.nBars >= 8)
  const bpm = ok.map((p) => p.bpm)
  const segLens: number[] = []
  let on4 = 0
  let on8 = 0
  let bounds = 0
  let mult4 = 0
  let mult8 = 0
  let mult16 = 0
  let inRange = 0
  const typeCounts: Record<string, number> = { change: 0, drop: 0, buildStart: 0, breakdown: 0 }
  let events = 0
  let repeated = 0
  let segs = 0
  for (const p of ok) {
    const b = p.segments.slice(1).map((s) => s.startBar)
    if (b.length > 0) {
      // "on the bar grid" is by construction; the informative test is how the boundaries relate to EACH OTHER: the
      // share sitting on the song's dominant 4-bar (8-bar) phase
      const h4 = [0, 0, 0, 0]
      const h8 = [0, 0, 0, 0, 0, 0, 0, 0]
      for (const x of b) {
        h4[x % 4]++
        h8[x % 8]++
      }
      on4 += Math.max(...h4)
      on8 += Math.max(...h8)
      bounds += b.length
    }
    for (const s of p.segments) {
      const len = s.endBar - s.startBar
      segLens.push(len)
      segs++
      if (s.repeatOf !== undefined) repeated++
    }
    // interior sections only (the first and last are cut by the song's own edges)
    for (const s of p.segments.slice(1, -1)) {
      const len = s.endBar - s.startBar
      if (len % 4 === 0) mult4++
      if (len % 8 === 0) mult8++
      if (len % 16 === 0) mult16++
      if (len >= 8 && len <= 32) inRange++
    }
    for (const e of p.events) {
      typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1
      events++
    }
  }
  const interior = ok.reduce((n, p) => n + Math.max(0, p.segments.length - 2), 0)
  const beatless = ok.filter((p) => p.diagnostics.tempo.confidence < 0.3).length
  const weakDown = ok.filter((p) => p.diagnostics.downbeat.confidence < 0.5).length
  const agree = ok.filter((p) => p.diagnostics.downbeat.methodsAgree).length
  const strengths = ok.flatMap((p) => p.events.map((e) => e.strength))
  const confs = ok.flatMap((p) => p.events.map((e) => e.confidence))
  const dur = ok.reduce((s, p) => s + p.diagnostics.durationSec, 0)
  const ms = plans.map((p) => p.diagnostics.analysisMs)
  const rt = plans.map((p) => p.diagnostics.durationSec / Math.max(1, p.diagnostics.analysisMs / 1000))

  L.push('## Aggregate', '')
  L.push(`- Tracks with a usable bar grid (>= 8 bars): **${ok.length}/${plans.length}**; total ${(dur / 60).toFixed(0)} min of audio, mean ${f1(dur / Math.max(1, ok.length))} s per track.`)
  L.push(`- **Segments per song**: mean ${f1(segs / Math.max(1, ok.length))}, median ${f1(quantile(ok.map((p) => p.segments.length), 0.5))}, events per minute ${f2(events / Math.max(1e-9, dur / 60))}.`)
  L.push(
    `- **Section length (bars, all segments)**: median ${f1(quantile(segLens, 0.5))}, p10 ${f1(quantile(segLens, 0.1))}, p90 ${f1(quantile(segLens, 0.9))}; ` +
      `interior sections (n=${interior}): **${pct(mult4 / Math.max(1, interior))} multiples of 4 bars, ${pct(mult8 / Math.max(1, interior))} of 8, ${pct(mult16 / Math.max(1, interior))} of 16**, ${pct(inRange / Math.max(1, interior))} in 8-32 bars.`,
  )
  L.push(
    `- **Bar-grid alignment of boundaries**: every boundary sits on a tracked bar line by construction; relative to each other, **${pct(on4 / Math.max(1, bounds))}** sit on the song's dominant 4-bar phase and **${pct(on8 / Math.max(1, bounds))}** on its dominant 8-bar phase (chance: 25% / 12.5%), n=${bounds} boundaries.`,
  )
  L.push(`- Repetition: ${pct(repeated / Math.max(1, segs))} of segments are labelled a repeat of an earlier segment.`)
  L.push(
    `- **Event types** (n=${events}): ` + Object.entries(typeCounts).map(([k, v]) => `${k} ${v} (${pct(v / Math.max(1, events))})`).join(', ') + '.',
  )
  L.push(
    `- **Event strength** (1 - exp(-z/5); a typical change ~0.6): p10 ${f2(quantile(strengths, 0.1))}, median ${f2(quantile(strengths, 0.5))}, p90 ${f2(quantile(strengths, 0.9))}; **confidence**: p10 ${f2(quantile(confs, 0.1))}, median ${f2(quantile(confs, 0.5))}, p90 ${f2(quantile(confs, 0.9))}. ${strengths.filter((x) => x < 0.5).length} of ${strengths.length} events are marginal (strength < 0.5): filter on strength or confidence for a stricter reference.`,
  )
  L.push(
    `- **Tempo (BPM)**: median ${f1(quantile(bpm, 0.5))}, p10 ${f1(quantile(bpm, 0.1))}, p90 ${f1(quantile(bpm, 0.9))}; ` +
      `bins: <74 ${bpm.filter((x) => x < 74).length}, 74-90 ${bpm.filter((x) => x >= 74 && x < 90).length}, 90-110 ${bpm.filter((x) => x >= 90 && x < 110).length}, 110-130 ${bpm.filter((x) => x >= 110 && x < 130).length}, 130-152 ${bpm.filter((x) => x >= 130 && x < 152).length}, >=152 ${bpm.filter((x) => x >= 152).length}. ` +
      `The working range is folded into 74-152 BPM (see \`foldPeriod\`), so a 60 BPM ballad reads 120 and a 174 BPM track reads 87: octave errors show up as a musically-implausible section length, not as an out-of-range BPM.`,
  )
  L.push(
    `- **Reliability**: ${beatless} tracks have tempo confidence < 0.3 (no clear pulse: ambient / drumless / free time; their bar grid is arbitrary, treat their events as low-trust); ${weakDown} have downbeat confidence < 0.5 (bar PHASE unreliable, boundaries are still on the bar grid but the 4-beat unit may be off by 1-3 beats). At least two of the three independent downbeat cues (onset / harmony salience, boundary structure, bar-cut sharpness) pick the reported phase on ${agree}/${ok.length} tracks.`,
  )
  L.push(
    `- **Analysis time per track**: mean ${f1(mean(ms) / 1000)} s, median ${f1(quantile(ms, 0.5) / 1000)} s, max ${f1(Math.max(...ms, 0) / 1000)} s (${f1(quantile(rt, 0.5))}x real time, median).`,
    '',
  )

  L.push('## Per track', '')
  L.push('| id | dur(s) | bpm | tempo conf | down conf | bars | segs | events | analysis(s) | warnings |')
  L.push('|---|---|---|---|---|---|---|---|---|---|')
  for (const f of files) {
    const p = f.plan
    const d = p.diagnostics
    L.push(
      `| ${f.id} | ${f1(d.durationSec)} | ${f1(p.bpm)} | ${f2(d.tempo.confidence)} | ${f2(d.downbeat.confidence)} | ${d.nBars} | ${p.segments.length} | ${p.events.length} | ${f1(d.analysisMs / 1000)} | ${d.warnings.join('; ')} |`,
    )
  }
  L.push('')
  L.push('## Caveats', '')
  L.push('- Internal evaluation only. The audio is CC BY-SA / BY-NC-SA (MTG-Jamendo); do not redistribute it or these derived files.')
  L.push('- No human labels: agreement with a person is unmeasured until the tap logs exist. Plausibility (section lengths, grid alignment) is the only check on real music.')
  L.push('- Weak spots: drumless / ambient music (arbitrary bar grid, tonal textures change as much within a section as between sections), tempo-octave ambiguity, unreliable downbeat phase in four-on-the-floor music, gradual morphs (no discontinuity to find).', '')
  return L.join('\n') + '\n'
}

/* ------------------------------------- the run ------------------------------------- */

const items = chunk([...listMp3('corpus/audio', 'corpus'), ...listMp3('testfolder', 'testfolder')], LIMIT, OFFSET, SEED)

describe.skipIf(items.length === 0)('silver standard: whole-song analysis', () => {
  it(
    `analyses ${items.length} track(s) and writes corpus/structure/silver/*.json + silver-report.md`,
    async () => {
      const t0 = Date.now()
      mkdirSync(SILVER_DIR, { recursive: true })
      let done = 0
      let failed = 0
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        try {
          const audio = await decodeMp3File(item.path)
          const plan = analyzeSong(audio.pcm, audio.sampleRate)
          const file: SilverFile = {
            schema: 'audiovis.silver',
            version: 1,
            id: item.id,
            set: item.set,
            file: item.rel,
            durationSec: audio.pcm.length / audio.sampleRate,
            sampleRate: audio.sampleRate,
            generated: new Date().toISOString(),
            plan,
          }
          writeFileSync(join(SILVER_DIR, `${item.id}.json`), stringify(file))
          done++
          console.log(
            `  ${i + 1}/${items.length} ${item.id}: ${file.durationSec.toFixed(0)}s bpm ${plan.bpm.toFixed(1)} bars ${plan.diagnostics.nBars} segs ${plan.segments.length} events ${plan.events.length} ${(plan.diagnostics.analysisMs / 1000).toFixed(1)}s`,
          )
        } catch (e) {
          failed++
          console.log(`  skip ${item.id}: ${(e as Error).message}`)
        }
      }
      expect(done).toBeGreaterThan(0)
      const all = loadAll()
      const md = buildReport(all, done, failed, (Date.now() - t0) / 1000)
      writeFileSync(OUT_MD, md)
      console.log(md)
      console.log(`wrote ${OUT_MD} (${all.length} tracks total, ${done} this run, ${failed} failed)`)
      // Weak sanity only: not an accuracy gate (there is no ground truth). Every analysed track must produce a
      // finite tempo and time-ordered events on the bar grid.
      for (const f of all) {
        const p = f.plan
        for (let k = 1; k < p.events.length; k++) expect(p.events[k].boundaryTime).toBeGreaterThan(p.events[k - 1].boundaryTime)
        if (p.diagnostics.nBars >= 8) expect(p.bpm).toBeGreaterThan(40)
      }
    },
    60 * 60 * 1000,
  )
})
