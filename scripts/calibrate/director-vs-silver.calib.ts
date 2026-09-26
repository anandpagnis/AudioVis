/**
 * DIRECTOR vs SILVER (lane W3): where do the scene CUTS of three systems fall relative to the whole-song, non-causal
 * "silver" structure of each track, and how good is the live v2 event layer against the same reference?
 *
 *   (a) legacy         the legacy trigger MODEL (`legacyCadence.ts` `simulateLegacy`, 32-beat dwell, drop bypass, ...)
 *   (b) director+legacy the REAL show director fed the LEGACY event stream (`directorReplay.ts` as-is)
 *   (c) director+v2    the REAL show director fed the v2 stream: v2 change / fill / gain / breakdown events from the cached
 *                      event cells + the legacy drop / buildStart events, merged as `eventMux.ts` and the adapter do, with the
 *                      anchored bar grid driving both the request (`barLine`) and the commit (`isCommitBarLine`)
 *
 * All on the SAME cached data (`corpus/structure/traces/`, `events-cells/`, `silver/`), so a full run takes seconds:
 *
 *   node --max-old-space-size=3072 ./node_modules/vitest/vitest.mjs run --config vitest.calibration.config.ts scripts/calibrate/director-vs-silver.calib.ts --reporter=verbose
 *
 * NOTHING HERE IS GROUND TRUTH. The silver analyser (`src/audio/plan/analyzeSong.ts`) uses the whole song (future included),
 * shares its features with the live detector (circular) and has not been checked against human labels: every score is
 * RELATIVE evidence between systems scored the same way, next to a random-phase chance control. Tap logs (`?structurelog`)
 * are what settle it.
 *
 * Scored span per track = min(trace length, event-cell coverage): the event cells cover the first 240 s only, so every
 * system and the silver boundaries are cut to the same span (cuts at t <= span; the director runs are stopped there).
 *
 * Knobs: DVS_LIMIT=N  first N tracks only (default all)   DVS_SEED=n  chance seed (default 1)
 *        DVS_COPIES=n chance copies per track (default 20)   DVS_SWEEP=0  skip the v2 tuning sweep (default on)
 *
 * Output (gitignored, derived from non-commercial audio): corpus/structure/director-vs-silver.md + .json.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectorEvents, seededRng } from '../../src/audio/eval/cadenceMetrics'
import { unpackTrace, type CadenceTrace, type PackedTrace } from '../../src/audio/eval/cadenceTrace'
import { prepareLiveStream, simulateDirector, type LiveStream } from '../../src/audio/eval/directorReplay'
import type { EventCellRecord } from '../../src/audio/eval/eventReplay'
import { simulateLegacy } from '../../src/audio/eval/legacyCadence'
import {
  circularShift,
  cutsInLagWindow,
  scoreEventsVsSilver,
  scoreTrackCuts,
  silverRef,
  summarizeEvents,
  summarizeSystem,
  type CutList,
  type EventSummary,
  type SilverPlanLike,
  type SilverRef,
  type SystemSummary,
  type TrackEventScore,
  type TrackSilverScore,
} from '../../src/audio/eval/silverScore'
import type { SectionEvent } from '../../src/audio/events/types'
import { percentile } from '../../src/audio/eval/structureMetrics'
import { LEGACY } from '../../src/audio/events/legacyEvents'
import { SHOW } from '../../src/engine/show/showPolicy'

const ROOT = resolve(__dirname, '../..')
const OUT_DIR = join(ROOT, 'corpus/structure')
const TRACE_DIR = join(OUT_DIR, 'traces')
const CELLS_DIR = join(OUT_DIR, 'events-cells')
const SILVER_DIR = join(OUT_DIR, 'silver')
const OUT_MD = join(OUT_DIR, 'director-vs-silver.md')
const OUT_JSON = join(OUT_DIR, 'director-vs-silver.json')
const BASELINE_JSON = join(OUT_DIR, 'baseline-cadence.json')

const LIMIT = Math.max(0, Number(process.env.DVS_LIMIT) || 0)
const SEED = Number(process.env.DVS_SEED) || 1
const COPIES = Math.max(1, Number(process.env.DVS_COPIES) || 20)
const SWEEP = process.env.DVS_SWEEP !== '0'
const SWEEP_COPIES = 6

const f1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : 'n/a')
const f2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : 'n/a')
const f3 = (v: number): string => (Number.isFinite(v) ? v.toFixed(3) : 'n/a')
const pct = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : 'n/a')

/** Run `fn` with `over` written onto `target` (the constants are `as const` in the types only), then put them back. */
function withConstants<T>(target: object, over: Record<string, unknown>, fn: () => T): T {
  const rec = target as Record<string, unknown>
  const old: Record<string, unknown> = {}
  for (const k of Object.keys(over)) {
    old[k] = rec[k]
    rec[k] = over[k]
  }
  try {
    return fn()
  } finally {
    for (const k of Object.keys(old)) rec[k] = old[k]
  }
}

// --- Data ----------------------------------------------------------------------------------------------------------

interface CachedRun {
  id: string
  sampleRate: number
  durationSec: number
  cells: EventCellRecord[]
}

interface TrackData {
  id: string
  family: string
  trace: CadenceTrace
  ref: SilverRef
  live: LiveStream
  /** Scored span (s). */
  horizon: number
  /** The slow analyser's boundaries, the legacy sectionChange edges and latched boundaries (s), on the trace clock. */
  legacyEvents: { sectionChange: number[]; boundary: number[]; analyser: number[] }
}

function familyMap(): Map<string, string> {
  const m = new Map<string, string>()
  if (existsSync(BASELINE_JSON)) {
    const j = JSON.parse(readFileSync(BASELINE_JSON, 'utf8')) as { perTrack?: Array<{ id: string; family: string }> }
    for (const t of j.perTrack ?? []) m.set(t.id, t.family)
  }
  return m
}

/** `jamendo_123` -> `123.json`; `test_x__1` -> `testfolder_x__1.json` (the silver run's naming). */
function silverFile(id: string): string {
  if (id.startsWith('jamendo_')) return `${id.slice('jamendo_'.length)}.json`
  if (id.startsWith('test_')) return `testfolder_${id.slice('test_'.length)}.json`
  return `${id}.json`
}

function loadTrack(name: string, fam: Map<string, string>): TrackData | null {
  const id = name.replace(/\.json$/, '')
  const silverPath = join(SILVER_DIR, silverFile(id))
  const cellsPath = join(CELLS_DIR, name)
  if (!existsSync(silverPath) || !existsSync(cellsPath)) return null
  const trace = unpackTrace(JSON.parse(readFileSync(join(TRACE_DIR, name), 'utf8')) as PackedTrace)
  const silver = JSON.parse(readFileSync(silverPath, 'utf8')) as { plan: SilverPlanLike }
  const run = JSON.parse(readFileSync(cellsPath, 'utf8')) as CachedRun
  const traceSec = trace.n / trace.frameRate
  const horizon = Math.min(traceSec, run.durationSec)
  const live = prepareLiveStream(trace, run.cells, run.sampleRate)
  const de = detectorEvents(trace)
  return {
    id,
    family: fam.get(id) ?? 'unknown',
    trace,
    ref: silverRef(silver.plan),
    live,
    horizon,
    legacyEvents: { sectionChange: de.sectionChange, boundary: de.boundary, analyser: de.analyser },
  }
}

// --- Systems -------------------------------------------------------------------------------------------------------

type SystemKey = 'legacy' | 'dirLegacy' | 'dirV2' | 'dirV2LegacyGrid'

const SYSTEMS: Array<{ key: SystemKey; title: string }> = [
  { key: 'legacy', title: 'legacy model' },
  { key: 'dirLegacy', title: 'director + legacy events' },
  { key: 'dirV2', title: 'director + v2 events' },
  { key: 'dirV2LegacyGrid', title: 'director + v2, commit on f.beatInBar (control)' },
]

const LEVEL_TRIGGERS = ['stale', 'phraseFallback', 'armed:age']

interface CutRun {
  list: CutList
  /** The trigger string of each cut (`change:event`, `drop:drop-fast`, `forced:forced-bar`, or the legacy model's). */
  triggers: string[]
  /** v2 director only, for cuts made by a v2 change / breakdown event: cut time minus the event's claimed boundary time / fire time (s), and the claimed lag in silver bars. */
  claimLagSec: number[]
  fireLagSec: number[]
  claimLagBars: number[]
}

/** The cuts of `key` on this track, limited to the scored span. */
function runSystem(d: TrackData, key: SystemKey): CutRun {
  const t = d.trace
  const claimLagSec: number[] = []
  const fireLagSec: number[] = []
  const claimLagBars: number[] = []
  let commits
  if (key === 'legacy') commits = simulateLegacy(t).commits
  else if (key === 'dirLegacy') commits = simulateDirector(t, { endSec: d.horizon }).commits
  else {
    const r = simulateDirector(t, { endSec: d.horizon, live: d.live, commitGrid: key === 'dirV2' ? 'anchored' : 'legacy' })
    commits = r.commits
    const byId = new Map<number, SectionEvent>()
    for (const e of d.live.events) if (e.event.type === 'change' || e.event.type === 'breakdown') byId.set(e.event.id, e.event)
    for (const c of r.commits) {
      const dec = r.decisions.find((x) => x.frame === c.requestFrame && x.kind === 'CUT' && !x.refused && (x.eventType === 'change' || x.eventType === 'breakdown'))
      const ev = dec ? byId.get(dec.eventId) : undefined
      if (!ev || c.timeSec > d.horizon) continue
      claimLagSec.push(c.timeSec - ev.boundaryTime)
      fireLagSec.push(c.timeSec - ev.detectedAtTime)
      claimLagBars.push((c.timeSec - ev.boundaryTime) / d.ref.barSec)
    }
  }
  const kept = commits.filter((c) => c.timeSec <= d.horizon)
  return {
    list: {
      times: kept.map((c) => c.timeSec),
      beats: kept.map((c) => c.beat),
      forced: kept.map((c) => (key === 'legacy' ? LEVEL_TRIGGERS.includes(c.trigger) : String(c.trigger).startsWith('forced:'))),
    },
    triggers: kept.map((c) => String(c.trigger)),
    claimLagSec,
    fireLagSec,
    claimLagBars,
  }
}

const scoreRun = (d: TrackData, run: CutRun, copies: number): TrackSilverScore =>
  scoreTrackCuts(d.id, d.family, d.ref, run.list, d.horizon, { chanceCopies: copies, seed: SEED })

/** Coarse trigger bucket of a director cut. */
function bucketOf(trigger: string): 'event' | 'drop' | 'forced' {
  if (trigger.startsWith('forced:')) return 'forced'
  if (trigger.startsWith('drop:')) return 'drop'
  return 'event'
}

/** A run restricted to the cuts of one bucket. */
function subRun(run: CutRun, bucket: 'event' | 'drop' | 'forced'): CutList {
  const idx = run.triggers.map((tr, k) => (bucketOf(tr) === bucket ? k : -1)).filter((k) => k >= 0)
  return { times: idx.map((k) => run.list.times[k]), beats: idx.map((k) => run.list.beats[k]), forced: idx.map((k) => run.list.forced[k]) }
}

// --- The event layer itself against silver --------------------------------------------------------------------------

type DetectorKey = 'v2' | 'v2At' | 'sectionChange' | 'boundary' | 'analyser'

const DETECTORS: Array<{ key: DetectorKey; title: string }> = [
  { key: 'v2', title: 'v2 event layer, change + breakdown (claimed boundary time)' },
  { key: 'v2At', title: 'v2 event layer, change + breakdown (time it fired)' },
  { key: 'sectionChange', title: 'legacy `f.sectionChange` edges' },
  { key: 'boundary', title: 'legacy latched analyser section changes (`boundaryChanged`)' },
  { key: 'analyser', title: 'slow analyser boundaries (`StructureAnalyzer`, retrospective)' },
]

function detectorTimes(d: TrackData, key: DetectorKey): number[] {
  if (key === 'v2' || key === 'v2At') {
    const scene = d.live.events.filter((e) => e.event.type === 'change' || e.event.type === 'breakdown').map((e) => e.event)
    return scene.map((e: SectionEvent) => (key === 'v2' ? e.boundaryTime : e.detectedAtTime))
  }
  return d.legacyEvents[key]
}

function scoreDetector(d: TrackData, key: DetectorKey, strong: boolean): TrackEventScore {
  return scoreEventsVsSilver(d.id, d.family, d.ref, strong ? d.ref.strong : d.ref.all, detectorTimes(d, key), d.horizon, { chanceCopies: COPIES, seed: SEED })
}

// --- Report --------------------------------------------------------------------------------------------------------

const lift = (s: { real: number; chance: number; lift: number }): string => `${pct(s.real)} (chance ${pct(s.chance)}, lift ${f2(s.lift)})`

function systemTable(cols: Array<{ title: string; s: SystemSummary }>): string[] {
  const row = (label: string, f: (s: SystemSummary) => string): string => `| ${label} | ${cols.map((c) => f(c.s)).join(' | ')} |`
  return [
    `| | ${cols.map((c) => c.title).join(' | ')} |`,
    `|---|${cols.map(() => '---').join('|')}|`,
    row('tracks / minutes scored', (s) => `${s.tracks} / ${f1(s.minutes)}`),
    row('scene cuts (startup included)', (s) => `${s.cuts}`),
    row('**cuts per minute**', (s) => f2(s.cutsPerMin)),
    row('**interval, bars (app beat counter / 4): median / p10 / p90**', (s) => `${f1(s.intervalBarsApp.median)} / ${f1(s.intervalBarsApp.p10)} / ${f1(s.intervalBarsApp.p90)}`),
    row('interval, silver bars: median / p10 / p90', (s) => `${f1(s.intervalBarsSilver.median)} / ${f1(s.intervalBarsSilver.p10)} / ${f1(s.intervalBarsSilver.p90)}`),
    row('**intervals in [4, 32] bars (app)** (below 4 / above 32)', (s) => `${pct(s.intervalBarsApp.in4to32)} (${pct(s.intervalBarsApp.below4)} / ${pct(s.intervalBarsApp.above32)})`),
    row('interval, seconds: median / p10 / p90', (s) => `${f1(s.intervalSec.median)} / ${f1(s.intervalSec.p10)} / ${f1(s.intervalSec.p90)}`),
    row('**forced (ceiling / level-timer) cuts**', (s) => pct(s.forcedShare)),
    row('**cuts within +-1 bar of a silver boundary** (cuts after 5 s)', (s) => lift(s.post.within1Bar)),
    row('... within +-1 bar, every cut incl. startup', (s) => lift(s.all.within1Bar)),
    row('cuts within +-2 s of a silver boundary', (s) => lift(s.post.within2s)),
    row('cuts within +-1 bar of a STRONG boundary', (s) => lift(s.post.within1BarStrong)),
    row('cuts inside [-1, +4] bars after some boundary', (s) => lift(s.post.followsBoundary)),
    row('**COVERAGE: strong boundaries (>= 0.5) with a cut in [-1, +4] bars**', (s) => lift(s.post.coverStrong)),
    row('COVERAGE: all boundaries', (s) => lift(s.post.coverAll)),
    row('median lag, preceding silver boundary -> cut (s)', (s) => `${f1(s.post.sinceMedian.real)} (chance ${f1(s.post.sinceMedian.chance)})`),
    row('median lag, covered strong boundary -> its first cut (s)', (s) => `${f1(s.post.coverLagMedian.real)} (chance ${f1(s.post.coverLagMedian.chance)})`),
    row('silver boundaries in the scored span (all / strong)', (s) => `${s.silverBoundaries.all} / ${s.silverBoundaries.strong}`),
  ]
}

function eventTable(rows: Array<{ title: string; s: EventSummary }>): string[] {
  const L: string[] = [
    '| detector | est / min | recall +-1 bar | precision +-1 bar | recall +-3 s | precision +-3 s | F0.5 | **F3** | F3 macro | chance F3 (F0.5) |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ]
  for (const r of rows) {
    const s = r.s
    L.push(
      `| ${r.title} | ${f2(s.estPerMin)} | ${pct(s.bar1.recall)} | ${pct(s.bar1.precision)} | ${pct(s.s3.recall)} | ${pct(s.s3.precision)} | ${f3(s.s05.f)} | **${f3(s.s3.f)}** | ${f3(s.macroF3)} | ${f3(s.chanceS3.f)} (${f3(s.chanceS05.f)}) |`,
    )
  }
  return L
}

interface Criterion {
  name: string
  ok: boolean
  value: string
}

const sortById = <T extends { id: string }>(xs: T[]): T[] => [...xs].sort((a, b) => (a.id < b.id ? -1 : 1))

describe.skipIf(!existsSync(TRACE_DIR) || !existsSync(SILVER_DIR) || !existsSync(CELLS_DIR))('director vs silver over the cached tracks', () => {
  it(
    'scores the legacy model, director+legacy and director+v2 cuts, and the v2 event layer, against the silver boundaries',
    () => {
      const fam = familyMap()
      let names = readdirSync(TRACE_DIR).filter((n) => n.endsWith('.json')).sort()
      if (LIMIT) names = names.slice(0, LIMIT)
      expect(names.length).toBeGreaterThan(0)

      const data: TrackData[] = []
      let skipped = 0
      for (const n of names) {
        const d = loadTrack(n, fam)
        if (d) data.push(d)
        else skipped++
      }
      expect(data.length).toBeGreaterThan(0)
      const placement = data.reduce(
        (a, d) => ({ matched: a.matched + d.live.cells.matched, mismatched: a.mismatched + d.live.cells.mismatched, unplaced: a.unplaced + d.live.cells.unplaced }),
        { matched: 0, mismatched: 0, unplaced: 0 },
      )
      const traceMin = data.reduce((s, d) => s + d.trace.n / d.trace.frameRate, 0) / 60
      const horizonMin = data.reduce((s, d) => s + d.horizon, 0) / 60

      // --- per-system, per-track scores ---
      const scores: Record<SystemKey, TrackSilverScore[]> = { legacy: [], dirLegacy: [], dirV2: [], dirV2LegacyGrid: [] }
      const runs: Record<SystemKey, CutRun[]> = { legacy: [], dirLegacy: [], dirV2: [], dirV2LegacyGrid: [] }
      for (const d of data) {
        for (const s of SYSTEMS) {
          const run = runSystem(d, s.key)
          runs[s.key].push(run)
          scores[s.key].push(scoreRun(d, run, COPIES))
        }
      }
      const summ = (key: SystemKey, pick: (t: TrackSilverScore) => boolean = () => true): SystemSummary => summarizeSystem(scores[key].filter(pick))
      const main = SYSTEMS.slice(0, 3)
      const cols = (pick?: (t: TrackSilverScore) => boolean) => main.map((s) => ({ title: s.title, s: summ(s.key, pick) }))

      // --- event layer vs silver ---
      const evScores = (key: DetectorKey, strong: boolean): TrackEventScore[] => data.map((d) => scoreDetector(d, key, strong))
      const ev = Object.fromEntries(DETECTORS.map((x) => [x.key, { all: evScores(x.key, false), strong: evScores(x.key, true) }])) as Record<DetectorKey, { all: TrackEventScore[]; strong: TrackEventScore[] }>
      const evRows = (which: 'all' | 'strong', pick: (t: TrackEventScore) => boolean = () => true) =>
        DETECTORS.map((x) => ({ title: x.title, s: summarizeEvents(ev[x.key][which].filter(pick)) }))

      // --- headline numbers and the flip criteria ---
      const A = summ('legacy')
      const B = summ('dirLegacy')
      const C = summ('dirV2')
      const evAll = Object.fromEntries(DETECTORS.map((x) => [x.key, summarizeEvents(ev[x.key].all)])) as Record<DetectorKey, EventSummary>
      const crit: Criterion[] = [
        {
          name: '(i) share of cuts within +-1 bar of a silver boundary >= 2x the legacy model\'s',
          ok: C.post.within1Bar.real >= 2 * A.post.within1Bar.real,
          value: `${pct(C.post.within1Bar.real)} vs ${pct(A.post.within1Bar.real)} = x${f2(C.post.within1Bar.real / A.post.within1Bar.real)} (chance ${pct(C.post.within1Bar.chance)} vs ${pct(A.post.within1Bar.chance)}; chance-corrected lift ${f2(C.post.within1Bar.lift)} vs ${f2(A.post.within1Bar.lift)})`,
        },
        { name: '(ii) cuts/min <= 3.5 and >= 1.2', ok: C.cutsPerMin <= 3.5 && C.cutsPerMin >= 1.2, value: f2(C.cutsPerMin) },
        {
          name: '(iii) median interval 8-16 bars, >= 80% of intervals in [4, 32] bars',
          ok: C.intervalBarsApp.median >= 8 && C.intervalBarsApp.median <= 16 && C.intervalBarsApp.in4to32 >= 0.8,
          value: `${f1(C.intervalBarsApp.median)} bars, ${pct(C.intervalBarsApp.in4to32)} in [4,32]`,
        },
        { name: '(iv) forced-cut share <= 25%', ok: C.forcedShare <= 0.25, value: pct(C.forcedShare) },
        {
          name: '(v) coverage of strong silver boundaries not worse than director+legacy\'s',
          ok: C.post.coverStrong.real >= B.post.coverStrong.real,
          value: `${pct(C.post.coverStrong.real)} (chance ${pct(C.post.coverStrong.chance)}, lift ${f2(C.post.coverStrong.lift)}) vs ${pct(B.post.coverStrong.real)} (chance ${pct(B.post.coverStrong.chance)}, lift ${f2(B.post.coverStrong.lift)})`,
        },
        {
          name: '(vi) v2 layer F3 vs silver >= the slow analyser\'s and > `sectionChange`\'s',
          ok: evAll.v2.s3.f >= evAll.analyser.s3.f && evAll.v2.s3.f > evAll.sectionChange.s3.f,
          value: `v2 ${f3(evAll.v2.s3.f)} (fired-at ${f3(evAll.v2At.s3.f)}); analyser ${f3(evAll.analyser.s3.f)}; sectionChange ${f3(evAll.sectionChange.s3.f)}`,
        },
      ]

      // --- families, halves, robustness ---
      const families = [...new Set(data.map((d) => d.family))].sort()
      const lowIds = new Set(data.filter((d) => d.ref.lowConfidence).map((d) => d.id))
      const half = (h: 0 | 1) => {
        const ids = new Set(sortById(data).filter((_, k) => k % 2 === h).map((d) => d.id))
        return (t: { id: string }) => ids.has(t.id)
      }

      const L: string[] = []
      L.push('# Director vs silver: where do the scene cuts fall relative to the whole-song structure?', '')
      L.push(
        `Generated ${new Date().toISOString()} | ${data.length} tracks (${skipped} skipped: no cache), ${f1(traceMin)} min of trace, ${f1(horizonMin)} min scored | DVS_LIMIT=${LIMIT || 'all'} seed ${SEED}, ${COPIES} chance copies`,
        '',
      )
      L.push(
        '**The silver reference is NOT ground truth.** It is the non-causal whole-song analyser (`src/audio/plan/analyzeSong.ts`): it sees the future, shares its features with the live detector (circular),',
        'and has not been checked against human labels (the `?structurelog` tap logs will do that). Every number below is RELATIVE evidence between systems scored the same way on the same data, printed next to',
        'a random-phase CHANCE control (the same cut times circularly shifted by a random offset). "Lift" = (real - chance) / (1 - chance): 0 is no better than chance. Bars use the SILVER tempo',
        '(one unit for every system); the interval rows also give the app\'s own bar count (beat counter / 4) that the earlier reports use.',
        '',
        `**Scored span.** The cached event cells cover the first 240 s of each track, so every system and the silver boundaries are limited to min(trace, cells) per track: ${f1(horizonMin)} of ${f1(traceMin)} min.`,
        `Cell placement on trace frames: ${placement.matched} cells with the trace's own beat index, ${placement.mismatched} with a different one, ${placement.unplaced} outside the trace.`,
        `Cuts in the first ${5} s (the startup commit) are left out of the alignment / coverage scores for every system (they count in cuts/min and the intervals); a row shows the alignment with them.`,
        '',
      )

      L.push('## Flip criteria for `?events=v2` as the default (director + v2 events)', '', '| criterion | result | met |', '|---|---|---|')
      for (const c of crit) L.push(`| ${c.name} | ${c.value} | ${c.ok ? 'yes' : '**NO**'} |`)
      L.push('')

      L.push('## Three-way, all tracks', '', ...systemTable(cols()), '')
      L.push(`### Robustness: excluding low-confidence tracks (${lowIds.size} tracks with tempo confidence < 0.3, beatless, or downbeat confidence < 0.5: their bar grid is unreliable)`, '', ...systemTable(cols((t) => !lowIds.has(t.id))), '')

      L.push('### Control: the same v2 stream, SceneManager committing on the arbitrary-phase `f.beatInBar === 0` instead of the anchored grid', '')
      L.push(...systemTable([{ title: 'director + v2 (anchored commit)', s: C }, { title: 'director + v2 (f.beatInBar commit)', s: summ('dirV2LegacyGrid') }]), '')

      // --- how often the commit alignment can matter at all ---
      {
        let frames = 0
        let trustedFrames = 0
        let beats = 0
        let confident = 0
        let onLine = 0
        let differ = 0
        let total = 0
        data.forEach((d, k) => {
          const c = d.trace.cols
          const end = Math.min(d.trace.n, Math.floor(d.horizon * d.trace.frameRate))
          for (let i = 0; i < end; i++) {
            frames++
            if (c.confidence[i] / 255 > 0.25 && c.silence[i] === 0) trustedFrames++
            if (c.beat[i] === 1) {
              beats++
              if (d.live.toLine[i] >= 0) confident++
              if (d.live.toLine[i] === 0) onLine++
            }
          }
          const a = runs.dirV2[k].list.times
          const b = runs.dirV2LegacyGrid[k].list.times
          total += a.length
          differ += a.length === b.length ? a.filter((t, j) => Math.abs(t - b[j]) > 1e-6).length : Math.abs(a.length - b.length)
        })
        L.push('### Commit alignment: how often it can matter', '')
        L.push(
          `SceneManager commits a pending scene on the next bar line ONLY while the beat grid is trusted (\`f.confidence > 0.25\`, otherwise it commits at once): that held on ${pct(trustedFrames / frames)} of the scored frames. In v2 mode the bar line is the boundary-anchored grid's, but only while that grid is confident (it needs a few confirmed boundaries): it was confident on ${pct(confident / beats)} of the beats (${pct(onLine / beats)} of the beats were one of its bar lines). So the anchored commit changed ${differ} of the ${total} director + v2 cuts against committing on \`f.beatInBar === 0\`: safe (it falls back exactly when the grid is not confident) and rarely active on this corpus; it matters where the layer has learned the phase and the beat grid is trusted.`,
          '',
        )
      }

      L.push('## Per genre family', '')
      L.push('| family | tracks | system | cuts/min | median bars (app) | in [4,32] | forced | +-1 bar aligned (chance, lift) | strong coverage (chance, lift) |', '|---|---|---|---|---|---|---|---|---|')
      for (const fm of families) {
        for (const s of main) {
          const x = summ(s.key, (t) => t.family === fm)
          L.push(`| ${fm} | ${x.tracks} | ${s.title} | ${f2(x.cutsPerMin)} | ${f1(x.intervalBarsApp.median)} | ${pct(x.intervalBarsApp.in4to32)} | ${pct(x.forcedShare)} | ${pct(x.post.within1Bar.real)} (${pct(x.post.within1Bar.chance)}, ${f2(x.post.within1Bar.lift)}) | ${pct(x.post.coverStrong.real)} (${pct(x.post.coverStrong.chance)}, ${f2(x.post.coverStrong.lift)}) |`)
        }
      }
      L.push('')

      // --- alignment by lag window (a causal show cannot land inside +-1 bar of the change it reacts to) ---
      const WINDOWS: Array<[number, number]> = [[-1, 1], [0, 2], [0, 3], [1, 3], [1, 4], [-1, 4]]
      L.push('### Alignment by lag window (cuts after 5 s; the lag is cut time minus a silver boundary, in silver bars)', '')
      L.push(
        'A causal show hears a change ~1.5 bars after it began (the v2 layer confirms it ~6 beats late; the legacy `sectionChange` flag needs a full bar of history) and then waits for a bar line, so it lands AFTER the boundary. The first row is the +-1 bar criterion of the plan; the others are windows a live show can meet. Each cell: real share (chance share, lift).',
        '',
      )
      L.push(`| window (bars after a boundary) | ${main.map((s) => s.title).join(' | ')} |`, `|---|${main.map(() => '---').join('|')}|`)
      for (const [lo, hi] of WINDOWS) {
        const cells = main.map((s) => {
          let real = 0
          let chance = 0
          let n = 0
          let nc = 0
          data.forEach((d, k) => {
            const cuts = runs[s.key][k].list.times.filter((t) => t >= 5)
            const rng = seededRng(SEED * 7919 + k)
            real += cutsInLagWindow(cuts, d.ref.all.filter((b) => b <= d.horizon), lo * d.ref.barSec, hi * d.ref.barSec)
            n += cuts.length
            for (let c = 0; c < COPIES; c++) {
              const sh = circularShift(cuts, d.horizon, rng() * d.horizon)
              chance += cutsInLagWindow(sh, d.ref.all.filter((b) => b <= d.horizon), lo * d.ref.barSec, hi * d.ref.barSec)
              nc += sh.length
            }
          })
          const r = real / n
          const c = chance / nc
          return `${pct(r)} (${pct(c)}, ${f2((r - c) / (1 - c))})`
        })
        L.push(`| [${lo}, +${hi}]${lo === -1 && hi === 1 ? ' (the criterion)' : ''} | ${cells.join(' | ')} |`)
      }
      L.push('')

      L.push('### Which trigger made the cuts, and how those cuts line up with silver (director systems)', '')
      L.push('| system | trigger | cuts | share | +-1 bar aligned (chance) | inside [-1, +4] bars after a boundary (chance) | median lag, preceding boundary -> cut (s) |', '|---|---|---|---|---|---|---|')
      for (const s of main.slice(1)) {
        const total = runs[s.key].reduce((a, r) => a + r.list.times.length, 0)
        for (const bucket of ['event', 'drop', 'forced'] as const) {
          const sub = data.map((d, k) =>
            scoreTrackCuts(d.id, d.family, d.ref, subRun(runs[s.key][k], bucket), d.horizon, { chanceCopies: COPIES, seed: SEED }),
          )
          const x = summarizeSystem(sub)
          const label = bucket === 'event' ? (s.key === 'dirV2' ? 'v2 change / breakdown event' : 'legacy change / breakdown event') : bucket === 'drop' ? 'drop' : 'forced ceiling'
          L.push(`| ${s.title} | ${label} | ${x.cuts} | ${pct(x.cuts / total)} | ${pct(x.post.within1Bar.real)} (${pct(x.post.within1Bar.chance)}) | ${pct(x.post.followsBoundary.real)} (${pct(x.post.followsBoundary.chance)}) | ${f1(x.post.sinceMedian.real)} |`)
        }
      }
      {
        const cs = runs.dirV2.flatMap((r) => r.claimLagSec)
        const fs2 = runs.dirV2.flatMap((r) => r.fireLagSec)
        const cb = runs.dirV2.flatMap((r) => r.claimLagBars)
        L.push('', `Director + v2, cuts made by a v2 change / breakdown event (n=${cs.length}): the cut lands a median ${f1(percentile(cs, 0.5))} s (${f1(percentile(cb, 0.5))} silver bars; p10 ${f1(percentile(cb, 0.1))}, p90 ${f1(percentile(cb, 0.9))}) after the boundary the event CLAIMS and ${f1(percentile(fs2, 0.5))} s after the event fired. A causal show cannot cut before the change is heard (the layer confirms it ~6 beats late, then the cut waits for the next bar line), so a +-1 bar window around the silver boundary is out of reach for the cuts of ANY causal system; the [-1, +4] bar window is the one a live show can meet.`, '')
      }

      L.push('### Split-half stability (tracks alternately assigned by sorted id)', '')
      L.push('| half | system | tracks | cuts/min | median bars | in [4,32] | forced | +-1 bar aligned (chance, lift) | strong coverage (chance, lift) |', '|---|---|---|---|---|---|---|---|---|')
      for (const h of [0, 1] as const) {
        for (const s of main) {
          const x = summ(s.key, half(h))
          L.push(`| ${h === 0 ? 'even' : 'odd'} | ${s.title} | ${x.tracks} | ${f2(x.cutsPerMin)} | ${f1(x.intervalBarsApp.median)} | ${pct(x.intervalBarsApp.in4to32)} | ${pct(x.forcedShare)} | ${pct(x.post.within1Bar.real)} (${pct(x.post.within1Bar.chance)}, ${f2(x.post.within1Bar.lift)}) | ${pct(x.post.coverStrong.real)} (${pct(x.post.coverStrong.chance)}, ${f2(x.post.coverStrong.lift)}) |`)
        }
      }
      L.push('')

      L.push('## The event detectors themselves against silver', '')
      L.push(
        'One-to-one matching (`structureMetrics.ts`), micro-averaged over the pooled boundaries. `est / min` is what the detector reports; a detector that reports more finds more but pays in precision, so read F next to the chance F',
        '(the same est times circularly shifted). v2 is scored on its CLAIMED boundary time (where it says the change began, bar-snapped) and, for the causal view, on the time it fired (~6 beats later). `sectionChange` is the flag time,',
        'the analyser rows are the retrospective boundary times (the analyser learns of them late; the fast flag has no lag but no memory).',
        '',
        '### against all silver boundaries',
        '',
        ...eventTable(evRows('all')),
        '',
        '### against STRONG silver boundaries (strength >= 0.5)',
        '',
        ...eventTable(evRows('strong')),
        '',
        `### against all silver boundaries, excluding the ${lowIds.size} low-confidence tracks`,
        '',
        ...eventTable(evRows('all', (t) => !lowIds.has(t.id))),
        '',
        '### split-half, F3 against all silver boundaries',
        '',
        '| detector | even | odd |',
        '|---|---|---|',
      )
      for (const x of DETECTORS) {
        const e = summarizeEvents(ev[x.key].all.filter(half(0)))
        const o = summarizeEvents(ev[x.key].all.filter(half(1)))
        L.push(`| ${x.title} | ${f3(e.s3.f)} | ${f3(o.s3.f)} |`)
      }
      L.push('')

      // --- the v2 director tuning sweep ---
      const sweep: SweepVariant[] = []
      const sweepRows: string[] = []
      const sweepJson: unknown[] = []
      if (SWEEP) {
        sweep.push({ label: 'as shipped', over: {} })
        for (const v of V2_SWEEP) sweep.push(v)
        sweepRows.push('| variant | cuts/min | median bars | in [4,32] | forced | cuts by v2 events | +-1 bar (lift) | inside [-1,+4] after (lift) | strong coverage (lift) | even: cuts/min, bars, forced, follows lift, cover lift | odd: same |', '|---|---|---|---|---|---|---|---|---|---|---|')
        for (const v of sweep) {
          const evCuts = { n: 0, of: 0 }
          const sc: TrackSilverScore[] = withConstants(SHOW, v.over, () =>
            withConstants(LEGACY, v.legacyOver ?? {}, () =>
            data.map((d) => {
              const run = runSystem(d, 'dirV2')
              evCuts.of += run.triggers.length
              evCuts.n += run.triggers.filter((tr) => bucketOf(tr) === 'event').length
              return scoreRun(d, run, SWEEP_COPIES)
            }),
            ),
          )
          const all = summarizeSystem(sc)
          const e = summarizeSystem(sc.filter(half(0)))
          const o = summarizeSystem(sc.filter(half(1)))
          const cell = (x: SystemSummary): string => `${f2(x.cutsPerMin)}, ${f1(x.intervalBarsApp.median)}, ${pct(x.forcedShare)}, ${f2(x.post.followsBoundary.lift)}, ${f2(x.post.coverStrong.lift)}`
          sweepRows.push(`| ${v.label} | ${f2(all.cutsPerMin)} | ${f1(all.intervalBarsApp.median)} | ${pct(all.intervalBarsApp.in4to32)} | ${pct(all.forcedShare)} | ${pct(evCuts.n / Math.max(1, evCuts.of))} | ${pct(all.post.within1Bar.real)} (${f2(all.post.within1Bar.lift)}) | ${pct(all.post.followsBoundary.real)} (${f2(all.post.followsBoundary.lift)}) | ${pct(all.post.coverStrong.real)} (${f2(all.post.coverStrong.lift)}) | ${cell(e)} | ${cell(o)} |`)
          sweepJson.push({ label: v.label, over: v.over, legacyOver: v.legacyOver, all, even: e, odd: o })
        }
        L.push('## The v2-specific constants: sweep (director + v2 events only)', '')
        L.push(`${SWEEP_COPIES} chance copies per track here (the lift is noisier than in the tables above). Each row changes ONLY the listed constants (\`showPolicy.ts\`); the legacy-event director never reads them (see \`director-replay.md\`).`, '')
        L.push(...sweepRows, '')
      }

      L.push('## Constants', '')
      L.push('- `SHOW` (live): `' + JSON.stringify(Object.fromEntries(Object.entries(SHOW).filter(([k]) => !['typeWeight', 'dropCredibility'].includes(k)))) + '`, `typeWeight` `' + JSON.stringify(SHOW.typeWeight) + '`.', '')

      L.push('## Caveats', '')
      L.push(
        '- The silver standard is unvalidated: it is the same family of features as the live detector, so agreement can be circular, and the disagreements may be the silver\'s mistakes. Only the user\'s tap logs settle who is right.',
        '- Silver tempo is folded into 74-152 BPM, so a half-time or double-time track has a bar of the wrong length for every system (bar-tolerance metrics widen or narrow together); `+-2 s` rows are unit-free. The low-confidence row drops the tracks whose grid the silver itself distrusts.',
        '- The three shows are MODELS of the app driven by recorded detector outputs (`directorReplay.ts` and `legacyCadence.ts` headers): manual holds, cues, DJ-cam / Limitless cutaways and scene identity are absent, which can only make the real show change less often.',
        '- The v2 stream is the event layer replayed over the cached beat cells (first 240 s): its anchored bar grid is learned only from the events it has itself confirmed so far, exactly as live. The engine\'s beat counter and the cells agree frame by frame (see the placement line).',
        '- The chance control is a circular shift of the cuts with a per-track seed; coverage and alignment both rise with the number of cuts, which is why the lift, not the raw share, is the comparison between systems that cut at different rates.',
        '- Internal evaluation only. The Jamendo tracks are non-commercial research data; do not redistribute the audio, the traces or the derived files.',
        '',
      )

      const jsonSys = (s: SystemSummary) => s
      const json = {
        generated: new Date().toISOString(),
        knobs: { limit: LIMIT, seed: SEED, copies: COPIES, sweepCopies: SWEEP_COPIES },
        tracks: data.length,
        minutes: { trace: traceMin, scored: horizonMin },
        placement,
        criteria: crit,
        systems: Object.fromEntries(SYSTEMS.map((s) => [s.key, jsonSys(summ(s.key))])),
        systemsExcludingLowConfidence: Object.fromEntries(SYSTEMS.map((s) => [s.key, jsonSys(summ(s.key, (t) => !lowIds.has(t.id)))])),
        perFamily: Object.fromEntries(families.map((fm) => [fm, Object.fromEntries(SYSTEMS.map((s) => [s.key, jsonSys(summ(s.key, (t) => t.family === fm))]))])),
        splitHalf: Object.fromEntries(([0, 1] as const).map((h) => [h === 0 ? 'even' : 'odd', Object.fromEntries(SYSTEMS.map((s) => [s.key, jsonSys(summ(s.key, half(h)))]))])),
        events: Object.fromEntries(DETECTORS.map((x) => [x.key, { all: summarizeEvents(ev[x.key].all), strong: summarizeEvents(ev[x.key].strong), allExcludingLowConfidence: summarizeEvents(ev[x.key].all.filter((t) => !lowIds.has(t.id))) }])),
        lowConfidenceTracks: [...lowIds],
        sweep: sweepJson,
        constants: { show: SHOW },
        perTrack: data.map((d, k) => ({
          id: d.id,
          family: d.family,
          horizonSec: d.horizon,
          silverBpm: d.ref.bpm,
          lowConfidence: d.ref.lowConfidence,
          boundaries: scores.legacy[k].boundaries,
          cuts: Object.fromEntries(SYSTEMS.map((s) => [s.key, scores[s.key][k].cutsAll])),
        })),
      }
      mkdirSync(OUT_DIR, { recursive: true })
      writeFileSync(OUT_MD, L.join('\n') + '\n')
      writeFileSync(OUT_JSON, JSON.stringify(json, null, 2))
      console.log(L.slice(0, 90).join('\n'))
      console.log(`wrote ${OUT_MD} (${data.length} tracks)`)
      expect(C.cuts).toBeGreaterThan(0)
    },
    30 * 60 * 1000,
  )
})

/** One sweep row: overrides of `SHOW`, and (exploration only, never shipped) of the legacy event mapper's `LEGACY`. */
interface SweepVariant {
  label: string
  over: Record<string, unknown>
  legacyOver?: Record<string, unknown>
}

/**
 * The sweep of the v2-specific constant `SHOW.liveGain` (shipped 1.75) and, as EXPLORATION ONLY, two lone-drop confidences
 * (`LEGACY.dropConfidence`, shipped 0.35, tuned for the legacy event source: what would weakening it do to the v2 show?).
 */
const V2_SWEEP: SweepVariant[] = [
  ...[1, 1.25, 1.5, 2, 2.5, 3].map((g) => ({ label: `liveGain ${g}`, over: { liveGain: g } })),
  { label: 'exploration: liveGain 1.75 + lone drops 0.25', over: {}, legacyOver: { dropConfidence: 0.25 } },
  { label: 'exploration: liveGain 1.75 + lone drops 0.15', over: {}, legacyOver: { dropConfidence: 0.15 } },
]
