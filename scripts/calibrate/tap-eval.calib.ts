/**
 * TAP EVAL: score every detector against the human taps of the `?structurelog` exports found in a folder.
 *
 *   TAPLOG_DIR=C:\Users\aryan\Downloads node --max-old-space-size=3072 ./node_modules/vitest/vitest.mjs run --config vitest.calibration.config.ts scripts/calibrate/tap-eval.calib.ts --reporter=verbose
 *
 * Reads every `structurelog-*.json` in `TAPLOG_DIR` (default `C:\Users\aryan\Downloads`; the logs are NEVER copied into the
 * repo), and writes `corpus/structure/tap-eval.md` (gitignored). Works for any number of songs; with none it skips.
 *
 * Sections: (1) the songs, (2) the measured human lag per mark (tap minus audio onset) with its per-song and pooled
 * distribution, (3) every detector at several windows, per song, pooled, M marks vs N marks, next to the score of the same
 * stream circularly shifted (chance), (4) which signals respond at each mark kind, (5) what the director did, (6) the v2
 * layer with each candidate config (leave-one-song-out when there are at least two songs).
 *
 * NOTHING HERE IS A TARGET. The taps are evidence to check mechanisms against; with n songs = 2 every number carries a wide
 * interval (Wilson 95% shown for recall). Constants are never fitted here: the variants below are fixed, mechanism-based
 * settings and the leave-one-song-out block only asks whether a setting chosen on one song also helps the other.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WINDOWS,
  chanceScore,
  estimateOnsets,
  faPerMin,
  loadTapSong,
  markResponses,
  markTimes,
  medianLagOf,
  phraseRescue,
  poolScores,
  precisionOf,
  recallOf,
  replayWithProbe,
  sceneGaps,
  scoreStream,
  songStreams,
  summarizeLags,
  triggeredProfile,
  times,
  wilson,
  type OnsetEstimate,
  type StreamScore,
  type TapSong,
  type Window,
} from '../../src/audio/eval/tapEval'
import { percentile } from '../../src/audio/eval/structureMetrics'
import type { EventLayerConfig } from '../../src/audio/events/EventLayer'
import { PhrasePrior } from '../../src/audio/events/phrasePrior'
import { MUX } from '../../src/audio/events/eventMux'
import { simulateDirectorOnSong, type DirectorSimOptions } from '../../src/audio/eval/tapDirector'

const ROOT = resolve(__dirname, '../..')
const OUT_MD = join(ROOT, 'corpus/structure/tap-eval.md')
const DIR = process.env.TAPLOG_DIR || 'C:\\Users\\aryan\\Downloads'

const f1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : 'n/a')
const f2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : 'n/a')
const pct = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : 'n/a')
const wname = (w: Window): string => `[-${w.before},+${w.after}]`

function loadSongs(): TapSong[] {
  if (!existsSync(DIR)) return []
  return readdirSync(DIR)
    .filter((f) => /^structurelog-.*\.json$/i.test(f))
    .sort()
    .map((f) => loadTapSong(f.replace(/^structurelog-/i, '').replace(/\.json$/i, ''), readFileSync(join(DIR, f), 'utf8')))
    .filter((s) => s.marks.length > 0)
}

/** A config the v2 layer is replayed with; `name` shows in the tables. */
export interface Variant {
  name: string
  cfg: Partial<EventLayerConfig>
}

const VARIANTS: Variant[] = [
  { name: 'default', cfg: {} },
  { name: 'old fill typing (ratio only)', cfg: { fillRecentFrac: Infinity } },
]

function row(cells: Array<string | number>): string {
  return `| ${cells.join(' | ')} |`
}

function table(head: string[], rows: Array<Array<string | number>>): string[] {
  return [row(head), row(head.map(() => '---')), ...rows.map(row), '']
}

function scoreCells(s: StreamScore, chance: { recall: number; precision: number }): Array<string | number> {
  const [lo, hi] = wilson(s.hits, s.nMarks)
  return [
    `${s.hits}/${s.nMarks} (${pct(recallOf(s))}, ci ${pct(lo)}-${pct(hi)})`,
    pct(chance.recall),
    `${s.tpEvents}/${s.nEvents} (${pct(precisionOf(s))})`,
    pct(chance.precision),
    f2(faPerMin(s)),
    f2(medianLagOf(s)),
  ]
}

function detectorSection(songs: TapSong[], variant: Variant, out: string[]): void {
  const replays = songs.map((s) => replayWithProbe(s, variant.cfg).events)
  const streams = songs.map((s, i) => songStreams(s, replays[i]))
  const names = Object.keys(streams[0]).filter((n) => variant.name === 'default' || n.startsWith('v2 replay'))
  for (const win of DEFAULT_WINDOWS) {
    out.push(`#### Window ${wname(win)} s around the tap${variant.name === 'default' ? '' : ` (v2 replay: ${variant.name})`}`, '')
    for (const scope of ['scene', 'small'] as const) {
      out.push(`Marks: **${scope === 'scene' ? 'M (scene-worthy)' : 'N (small change)'}**; precision / FA against ${scope === 'scene' ? 'M marks only' : 'N marks only'}`, '')
      const rows: Array<Array<string | number>> = []
      for (const name of names) {
        const per = songs.map((s, i) => scoreStream(markTimes(s, scope), times(streams[i][name]), win, s.durationSec))
        const pooled = poolScores(per)
        let cr = 0
        let cp = 0
        let cn = 0
        for (let i = 0; i < songs.length; i++) {
          const c = chanceScore(markTimes(songs[i], scope), times(streams[i][name]), win, songs[i].durationSec)
          if (Number.isFinite(c.recall)) {
            cr += c.recall * per[i].nMarks
            cp += c.precision * per[i].nEvents
            cn++
          }
        }
        const cRecall = cn ? cr / Math.max(1, pooled.nMarks) : Number.NaN
        const cPrec = cn ? cp / Math.max(1, pooled.nEvents) : Number.NaN
        rows.push([name, ...scoreCells(pooled, { recall: cRecall, precision: cPrec }), per.map((p) => `${p.hits}/${p.nMarks}`).join(' ')])
      }
      out.push(...table(['stream', 'recall', 'chance', 'precision', 'chance', 'FA/min', 'median lag', 'per song'], rows))
    }
  }
}

function lagSection(songs: TapSong[], out: string[]): OnsetEstimate[] {
  out.push('## 2. Measured human lag: tap minus audio change onset', '')
  out.push(
    'Onset = the latest strong step of the raw-dB level / low band / high band within [tap-4 s, tap+0.5 s] of each mark (cells are one beat apart, so the resolution is ~0.5 s). Marks without a step >= z 4, or whose onset sits at the window edge, are excluded from the summary.',
    '',
  )
  const all: OnsetEstimate[] = []
  const rows: Array<Array<string | number>> = []
  for (const s of songs) {
    const est = estimateOnsets(s.series, s.marks)
    all.push(...est)
    const lg = summarizeLags(est)
    rows.push([s.name, `${lg.n}/${lg.nMarks}`, f2(lg.median), `${f2(lg.p25)}..${f2(lg.p75)}`, `${f2(lg.min)}..${f2(lg.max)}`])
  }
  const pooled = summarizeLags(all)
  rows.push(['**pooled**', `${pooled.n}/${pooled.nMarks}`, f2(pooled.median), `${f2(pooled.p25)}..${f2(pooled.p75)}`, `${f2(pooled.min)}..${f2(pooled.max)}`])
  out.push(...table(['song', 'marks with onset', 'median lag (s)', 'IQR', 'range'], rows))
  for (const kind of ['scene', 'small'] as const) {
    const l = summarizeLags(all.filter((e) => e.kind === kind))
    out.push(`- ${kind === 'scene' ? 'M' : 'N'} marks: ${l.n}/${l.nMarks} with an onset, median lag ${f2(l.median)} s (IQR ${f2(l.p25)}..${f2(l.p75)})`)
  }
  out.push('')
  out.push('Event-triggered profile: mean capped step z of the raw-dB channels at each offset from the taps (a peak BEFORE 0 = the audio changed before the tap; the offset of the peak is the population lag, robust to marks with no single clear onset).', '')
  const prof = songs.map((s) => triggeredProfile(s.series, s.marks))
  const pooledProf = prof[0].map((b, i) => ({ offset: b.offset, z: prof.reduce((a, p) => a + p[i].z * p[i].n, 0) / Math.max(1, prof.reduce((a, p) => a + p[i].n, 0)) }))
  out.push(...table(['offset (s)', ...songs.map((s) => s.name), 'pooled'], pooledProf.map((b, i) => [f1(b.offset), ...prof.map((p) => f1(p[i].z)), f1(b.z)])))
  const peak = pooledProf.reduce((a, b) => (b.z > a.z ? b : a))
  out.push('- pooled peak at offset ' + f2(peak.offset) + ' s (z ' + f1(peak.z) + '); per song: ' + songs.map((s, k) => s.name + ' ' + f2(prof[k].reduce((a, b) => (b.z > a.z ? b : a)).offset)).join(', '), '')
  for (const s of songs) {
    const est = estimateOnsets(s.series, s.marks)
    out.push(`#### ${s.name}`, '')
    out.push(
      ...table(
        ['tap (s)', 'kind', 'onset (s)', 'lag (s)', 'channel', 'step (dB)', 'z', 'edge'],
        est.map((e) => [f1(e.tap), e.kind === 'scene' ? 'M' : 'N', e.onset === null ? '-' : f1(e.onset), f2(e.lag), e.channel ?? '-', f1(e.stepDb), f1(e.z), e.atEdge ? 'yes' : '']),
      ),
    )
  }
  return all
}

function responseSection(songs: TapSong[], variant: Variant, out: string[]): void {
  out.push('## 4. Which v2 channels respond at the marks (whitened z, strongest in [tap-4, tap+1])', '')
  const win: Window = { before: 4, after: 1 }
  for (const s of songs) {
    const { probe } = replayWithProbe(s, variant.cfg)
    const rs = markResponses(probe, s.marks, win)
    out.push(`#### ${s.name}`, '')
    out.push(
      ...table(
        ['tap (s)', 'kind', 's/thr', 'dominant', 'channels z>=2'],
        rs.map((r) => [f1(r.tap), r.kind === 'scene' ? 'M' : 'N', f2(r.ratio), r.dominant, r.active.join(' ')]),
      ),
    )
  }
  const pooled = songs.flatMap((s) => markResponses(replayWithProbe(s, variant.cfg).probe, s.marks, win))
  for (const kind of ['scene', 'small'] as const) {
    const r = pooled.filter((x) => x.kind === kind)
    if (!r.length) continue
    out.push(
      `- ${kind === 'scene' ? 'M' : 'N'} marks (n=${r.length}): median s/thr ${f2(percentile(r.map((x) => x.ratio), 0.5))}, share with a candidate (s >= thr) ${pct(r.filter((x) => x.ratio >= 1).length / r.length)}; dominant channels ${Object.entries(
        r.reduce<Record<string, number>>((a, x) => ((a[x.dominant] = (a[x.dominant] ?? 0) + 1), a), {}),
      )
        .map(([k, v]) => `${k}:${v}`)
        .join(' ')}`,
    )
  }
  out.push('')
}

function directorSection(songs: TapSong[], out: string[]): void {
  out.push('## 5. What the director did in the logs (recorded decisions, commits)', '')
  const win: Window = { before: 1.5, after: 6 }
  for (const s of songs) {
    out.push(`#### ${s.name}: decisions of the recorded events`, '')
    const rows = s.recorded.map((e) => {
      const near = s.marks.find((m) => e.t >= m.t - win.before && e.t <= m.t + win.after)
      return [f1(e.t), e.type ?? '', f2(e.strength ?? NaN), e.decision ?? '', near ? `${near.kind === 'scene' ? 'M' : 'N'} ${f1(near.t)}` : '']
    })
    out.push(...table(['t', 'type', 'strength', 'decision', 'mark in [-1.5,+6]'], rows))
    out.push(`Scene commits (s): ${s.commits.map((c) => `${f1(c.t)}${c.trigger !== 'unknown' ? `(${c.trigger})` : ''}`).join(', ') || 'none'}`, '')
    // what was going on when each scene actually changed (the log has no reason for a commit: `trigger` is `unknown`)
    const rel = (t: number): number => t - s.firstT
    const crows = s.commits.map((c) => {
      const kinds = s.log.events
        .filter((e) => rel(e.t) <= c.t + 0.05 && rel(e.t) >= c.t - 1.5 && !['tempo', 'sceneRequest', 'sceneWithdrawn', 'songSection', 'isDrop'].includes(e.kind))
        .map((e) => e.kind + (e.kind === 'sectionEvent' ? ':' + String(e.data.decision ?? e.data.type) : ''))
      const near = s.marks.find((m) => c.t >= m.t - 1.5 && c.t <= m.t + 6)
      return [f1(c.t), c.to, [...new Set(kinds)].join(' ') || '(none within 1.5 s)', near ? (near.kind === 'scene' ? 'M ' : 'N ') + f1(near.t) : '']
    })
    out.push('Scene commits and the detector events in the 1.5 s before each (a mood change or a silence-to-music transition is not an event of the show director):', '', ...table(['commit (s)', 'scene', 'events just before', 'mark in [-1.5,+6]'], crows))
    const gaps = sceneGaps(s)
    if (gaps.length) out.push(`M-mark gaps (s): ${gaps.map(f1).join(' ')}`, '')
  }
}

interface DirectorVariant {
  name: string
  opt: DirectorSimOptions
  legacyDrops: 'all' | 'release' | 'none'
}

const DIRECTOR_VARIANTS: DirectorVariant[] = [
  { name: 'legacy events (?events=legacy)', opt: { events: 'legacy' }, legacyDrops: 'all' },
  { name: 'v2 before (ratio-only fill typing, no gap drop, all legacy drops)', opt: { events: 'v2', layer: { fillRecentFrac: Infinity, gapDrop: false } }, legacyDrops: 'all' },
  { name: 'v2 now (fill typing + gap drop, release-backed legacy drops only)', opt: { events: 'v2' }, legacyDrops: 'release' },
]

/** The director replayed on each song for one variant (MUX restored afterwards). */
export function runDirector(songs: TapSong[], v: DirectorVariant): ReturnType<typeof simulateDirectorOnSong>[] {
  const old = MUX.legacyDrops
  MUX.legacyDrops = v.legacyDrops
  try {
    return songs.map((s) => simulateDirectorOnSong(s, v.opt))
  } finally {
    MUX.legacyDrops = old
  }
}

function directorReplaySection(songs: TapSong[], out: string[]): void {
  out.push('## 6. The director replayed on the cells (CUT should meet M marks, MICRO should meet N marks)', '')
  out.push('The real `showDirector.step` and event layer on the logged cells and legacy edges; the commit path is modelled (a CUT lands on the next bar line, drop-fast at once). No mood / character pressure (the log has only their changes). Scored against the M marks (CUT) and N marks (MICRO); a CUT near an N-only mark is the wrong reaction.', '')
  for (const win of DEFAULT_WINDOWS) {
    out.push(`#### Window ${wname(win)}`, '')
    const rows: Array<Array<string | number>> = []
    for (const v of DIRECTOR_VARIANTS) {
      const runs = runDirector(songs, v)
      const cutsM = poolScores(songs.map((s, i) => scoreStream(markTimes(s, 'scene'), runs[i].cuts, win, s.durationSec)))
      const cutsN = poolScores(songs.map((s, i) => scoreStream(markTimes(s, 'small'), runs[i].cuts, win, s.durationSec)))
      const micN = poolScores(songs.map((s, i) => scoreStream(markTimes(s, 'small'), runs[i].micros, win, s.durationSec)))
      const micAny = poolScores(songs.map((s, i) => scoreStream(markTimes(s), runs[i].micros, win, s.durationSec)))
      const nCuts = runs.reduce((a, r) => a + r.cuts.length, 0)
      const minutes = songs.reduce((a, s) => a + s.durationSec / 60, 0)
      rows.push([
        v.name,
        `${nCuts} (${f2(nCuts / minutes)}/min)`,
        `${cutsM.hits}/${cutsM.nMarks}`,
        `${cutsM.tpEvents}/${cutsM.nEvents} (${pct(precisionOf(cutsM))})`,
        f2(medianLagOf(cutsM)),
        `${cutsN.hits}/${cutsN.nMarks}`,
        `${micN.hits}/${micN.nMarks}`,
        `${micAny.tpEvents}/${micAny.nEvents}`,
        runs.map((r, i) => `${scoreStream(markTimes(songs[i], 'scene'), r.cuts, win, songs[i].durationSec).hits}/${markTimes(songs[i], 'scene').length}`).join(' '),
      ])
    }
    out.push(...table(['variant', 'cuts', 'M marks cut', 'cuts at an M mark', 'median lag', 'N marks cut (want few)', 'N marks with MICRO', 'MICROs at any mark', 'M cut per song'], rows))
  }
}

// ------------------------------------------------------------------------------------------- leave-one-song-out

const LOSO_WIN: Window = { before: 1.5, after: 4 }

/** F1 of an event stream against the M marks (recall over marks, precision over events) in `LOSO_WIN`. */
function f1Of(song: TapSong, evT: number[]): number {
  const s = scoreStream(markTimes(song, 'scene'), evT, LOSO_WIN, song.durationSec)
  const r = recallOf(s)
  const p = precisionOf(s)
  if (!(s.nEvents > 0) || !(r + p > 0)) return 0
  return (2 * p * r) / (p + r)
}

interface GridPoint<T> {
  label: string
  value: T
}

/**
 * Leave-one-song-out for one constant: `objective(song, value)` scores a song at a grid value. For each held-out song the
 * value is chosen on the OTHER songs (the mean objective) and scored on the held-out one, next to the shipped default's
 * score there. With n songs = 2 this is "tune on one, score the other, both ways". Returns the markdown rows.
 */
function losoBlock<T>(
  title: string,
  songs: TapSong[],
  grid: Array<GridPoint<T>>,
  shipped: string,
  objective: (song: TapSong, value: T) => number,
  out: string[],
): void {
  out.push(`#### ${title}`, '')
  const table1: Array<Array<string | number>> = grid.map((g) => [g.label + (g.label === shipped ? ' (shipped)' : ''), ...songs.map((s) => f2(objective(s, g.value))), f2(songs.reduce((a, s) => a + objective(s, g.value), 0) / songs.length)])
  out.push(...table(['value', ...songs.map((s) => `F1 ${s.name}`), 'mean'], table1))
  if (songs.length < 2) {
    out.push('Leave-one-song-out needs at least two songs.', '')
    return
  }
  const shippedPoint = grid.find((g) => g.label === shipped) ?? grid[0]
  const rows: Array<Array<string | number>> = []
  let sumChosen = 0
  let sumShipped = 0
  for (let j = 0; j < songs.length; j++) {
    const train = songs.filter((_, i) => i !== j)
    let best = grid[0]
    let bestV = -1
    for (const g of grid) {
      const v = train.reduce((a, s) => a + objective(s, g.value), 0) / train.length
      if (v > bestV + 1e-9) {
        bestV = v
        best = g
      }
    }
    const held = objective(songs[j], best.value)
    const dflt = objective(songs[j], shippedPoint.value)
    sumChosen += held
    sumShipped += dflt
    rows.push([songs[j].name, best.label, f2(held), f2(dflt), f2(held - dflt)])
  }
  rows.push(['**pooled (mean)**', '', f2(sumChosen / songs.length), f2(sumShipped / songs.length), f2((sumChosen - sumShipped) / songs.length)])
  out.push(...table(['held-out song', 'value chosen on the others', 'F1 held-out (chosen)', 'F1 held-out (shipped)', 'chosen - shipped'], rows))
}

function losoSection(songs: TapSong[], out: string[]): void {
  out.push('## 7. Leave-one-song-out (n = ' + songs.length + ' songs: an indication, not a validation)', '')
  out.push(
    'Objective: F1 of the stream against the M marks in [-1.5,+4] s (recall over marks, precision over events). Each constant is swept alone with the others at their shipped values.',
    '',
  )
  const sceneT = (s: TapSong, cfg: Partial<EventLayerConfig>): number[] => times(songStreams(s, replayWithProbe(s, cfg).events)['v2 replay scene-class'])
  const dropT = (s: TapSong, cfg: Partial<EventLayerConfig>): number[] => times(songStreams(s, replayWithProbe(s, cfg).events)['v2 replay drop'])
  losoBlock(
    'fill typing: `fillRecentFrac` (Infinity = the old ratio-only rule); objective on change + breakdown events',
    songs,
    [0.3, 0.5, 0.7, 0.8, 0.9, 1, Infinity].map((v) => ({ label: String(v), value: v })),
    '0.8',
    (s, v) => f1Of(s, sceneT(s, { fillRecentFrac: v })),
    out,
  )
  losoBlock(
    'gap drop: `lowDb` (dB the low band must fall), objective on drop events',
    songs,
    [6, 8, 10, 12, 15].map((v) => ({ label: String(v), value: v })),
    '10',
    (s, v) => f1Of(s, dropT(s, { gapDrop: { lowDb: v } })),
    out,
  )
  losoBlock(
    'gap drop: `minSec` (shortest dropout, seconds), objective on drop events',
    songs,
    [1, 1.75, 2.5, 3.5, 5].map((v) => ({ label: String(v), value: v })),
    '1.75',
    (s, v) => f1Of(s, dropT(s, { gapDrop: { minSec: v, minCells: 1 } })),
    out,
  )
  losoBlock(
    'gap drop: `returnDb` (how whole the low end must be again), objective on drop events',
    songs,
    [3, 6, 9, 12].map((v) => ({ label: String(v), value: v })),
    '6',
    (s, v) => f1Of(s, dropT(s, { gapDrop: { returnDb: v } })),
    out,
  )
}

function phraseSection(songs: TapSong[], out: string[]): void {
  out.push('## 8. Phrase periodicity prior (causal near-miss check, not wired in)', '')
  const gaps = songs.map((s) => sceneGaps(s))
  out.push(
    'M-mark gaps per song (s): ' + songs.map((s, i) => `${s.name}: ${gaps[i].map(f1).join(' ')}`).join('; '),
    '',
    'For every scorer peak that fell short of its threshold by up to a factor 1/0.6 (a near-miss), what would a prior learned from the boundaries the layer had confirmed so far have done? "Rescued" = score x multiplier >= threshold. A useful prior rescues near-misses that are real more often than it rescues the others.',
    '',
  )
  const rows: Array<Array<string | number>> = []
  for (const boost of [1.15, 1.3, 1.5]) {
    let nm = 0, rescued = 0, rescuedM = 0, rescuedN = 0, rescuedNone = 0, nearMall = 0, nearMrescued = 0
    for (const s of songs) {
      const rp = replayWithProbe(s)
      const rows2 = phraseRescue(s, rp, new PhrasePrior({ boost }))
      nm += rows2.length
      for (const r of rows2) {
        if (r.near === 'scene') nearMall++
        if (r.rescued) {
          rescued++
          if (r.near === 'scene') {
            rescuedM++
            nearMrescued++
          } else if (r.near === 'small') rescuedN++
          else rescuedNone++
        }
      }
    }
    rows.push([boost, nm, `${nearMall} (${pct(nearMall / Math.max(1, nm))})`, rescued, `${rescuedM} / ${rescuedN} / ${rescuedNone}`, pct(rescuedM / Math.max(1, rescued))])
  }
  out.push(...table(['boost', 'near-misses', 'of them at an M mark', 'rescued', 'rescued at M / N / no mark', 'share of rescued at an M mark'], rows))
}

describe('tap eval', () => {
  const songs = loadSongs()
  it.skipIf(songs.length === 0)('scores the detectors against the taps', () => {
    const out: string[] = ['# Tap evaluation', '']
    out.push(
      `Generated by \`scripts/calibrate/tap-eval.calib.ts\` from ${songs.length} tapped song(s) in \`${DIR}\`. **The taps are evidence, not targets; n is tiny.**`,
      '',
      '## 1. Songs',
      '',
    )
    out.push(
      ...table(
        ['song', 'length (s)', 'M marks', 'N marks', 'raw taps', 'cells', 'legacy sectionChange', 'legacy drop', 'v2 recorded'],
        songs.map((s) => [
          s.name,
          f1(s.durationSec),
          s.marks.filter((m) => m.kind === 'scene').length,
          s.marks.filter((m) => m.kind === 'small').length,
          s.rawMarkCount,
          s.cells.length,
          s.legacy.sectionChange.length,
          s.legacy.drop.length,
          s.recorded.length,
        ]),
      ),
    )
    lagSection(songs, out)
    out.push('## 3. Detectors', '', 'Recall = marks with >= 1 event in the window; precision = events inside some mark window; chance = the same stream circularly shifted (mean over 40 shifts). Times of an event are DETECTION times (when the system knew).', '')
    for (const v of VARIANTS) detectorSection(songs, v, out)
    responseSection(songs, VARIANTS[0], out)
    directorSection(songs, out)
    directorReplaySection(songs, out)
    losoSection(songs, out)
    phraseSection(songs, out)
    mkdirSync(join(ROOT, 'corpus/structure'), { recursive: true })
    writeFileSync(OUT_MD, out.join('\n'))
    expect(out.length).toBeGreaterThan(10)
  })
})
