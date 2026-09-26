/**
 * DIRECTOR REPLAY over the real tracks (lane W2-B): the REAL pure show director (`src/engine/show/showDirector.ts`,
 * fed by the REAL legacy-event mapper `src/audio/events/legacyEvents.ts`) replayed over the cached per-frame traces of
 * `baseline-scene-cadence.calib.ts`, next to the legacy trigger MODEL (`legacyCadence.ts`), scored by the SAME metrics
 * (`cadenceMetrics.ts`). Three variants over the same traces:
 *
 *   legacy             the legacy trigger model (32-beat dwell, drop bypass, ...): the baseline the complaint is about
 *   directorCommitted  the director exactly as first committed (7793d77, before this lane): the constants below in
 *                      `COMMITTED` are put back for the run, so the "before" number is reproducible from today's code
 *   director           the director with the current constants (`showPolicy.ts` SHOW, `legacyEvents.ts` LEGACY)
 *
 * NOTHING HERE WAS WATCHED. It is a replay of the app's own detector outputs through the shipped decision code plus a
 * model of the store / SceneManager commit path (see `src/audio/eval/directorReplay.ts`). There is NO musical ground
 * truth: "alignment" is to the app's own detectors, against a random-phase control (the same commit times circularly
 * shifted). Tap logs (`?structurelog`) are the only real check.
 *
 *   node --max-old-space-size=3072 ./node_modules/vitest/vitest.mjs run --config vitest.calibration.config.ts scripts/calibrate/director-replay.calib.ts --reporter=verbose
 *
 * Knobs: DR_LIMIT=N    replay only the first N cached traces (default 0 = every trace in `corpus/structure/traces/`)
 *        DR_SEED=n     seed of the random-phase chance control (default 1)
 *        DR_COPIES=n   chance-control copies per track (default 20)
 *
 * Needs the trace cache written by `baseline-scene-cadence.calib.ts` (gitignored; nothing is decoded here, a full run
 * takes seconds). Output (gitignored, derived from non-commercial audio): corpus/structure/director-replay.md + .json.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { aggregateCadence, cadenceOfTrack, distStats, quantile, type CadenceAggregate, type TrackCadence } from '../../src/audio/eval/cadenceMetrics'
import { STRENGTH_SCALE, unpackTrace, type PackedTrace } from '../../src/audio/eval/cadenceTrace'
import {
  simulateDirector,
  structuralAlignment,
  type DirectorReplayResult,
  type EventOutcomes,
  type ReleaseDropOutcomes,
} from '../../src/audio/eval/directorReplay'
import { simulateLegacy } from '../../src/audio/eval/legacyCadence'
import { LEGACY, sectionStrength } from '../../src/audio/events/legacyEvents'
import { SHOW } from '../../src/engine/show/showPolicy'

const ROOT = resolve(__dirname, '../..')
const OUT_DIR = join(ROOT, 'corpus/structure')
const TRACE_DIR = join(OUT_DIR, 'traces')
const OUT_MD = join(OUT_DIR, 'director-replay.md')
const OUT_JSON = join(OUT_DIR, 'director-replay.json')
const BASELINE_JSON = join(OUT_DIR, 'baseline-cadence.json')

const LIMIT = Math.max(0, Number(process.env.DR_LIMIT) || 0)
const SEED = Number(process.env.DR_SEED) || 1
const COPIES = Math.max(1, Number(process.env.DR_COPIES) || 20)

/**
 * The constants of the director as FIRST committed (7793d77), i.e. before the false-drop lane changed them. Applied
 * over the live constants for the `directorCommitted` variant only, then restored.
 */
const COMMITTED = {
  legacy: {
    sectionFloor: 0.4,
    sectionCeil: 1.2,
    dropConfidence: 0.7,
    dropMidConfidence: 0.7,
    dropReleaseConfidence: 0.7,
    buildLookbackBeats: 8,
    echoCorroborates: true,
    dropKeepsOwnConfidence: false,
  },
  show: {
    dropCredibility: [1, 1, 1, 1],
    dropImmediateOnlyFast: false,
    thresholdFloor: 0.35,
    thresholdSpan: 0.55,
    rampEndBars: 16,
    rampBars: 12,
  },
}

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

const f1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : 'n/a')
const f2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : 'n/a')
const pct = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : 'n/a')

// --- One replayed track --------------------------------------------------------------------------------------

interface Run {
  id: string
  family: string
  minutes: number
  cad: TrackCadence
  /** Cuts by bucket (see `bucketOf`). */
  buckets: Record<Bucket, number>
  /** Director only. */
  hold: number
  micro: number
  cut: number
  outcomes: DirectorReplayResult['outcomes'] | null
  release: ReleaseDropOutcomes | null
  /** |commit - nearest structural event| samples, real and chance. */
  structReal: number[]
  structChance: number[]
}

const BUCKETS = ['drop', 'change', 'breakdown', 'forced', 'build', 'other'] as const
type Bucket = (typeof BUCKETS)[number]

/** `forced` = the LEGACY model's level-type timers (stale / phrase fallback / armed age); the director has no timer, so it never lands here. */
function bucketOf(trigger: string): Bucket {
  if (trigger.startsWith('drop:') || trigger === 'drop' || trigger === 'armed:drop' || trigger === 'dropPreArm') return 'drop'
  if (trigger.startsWith('breakdown:')) return 'breakdown'
  if (trigger.startsWith('change:') || ['sectionChange', 'latchedBoundary', 'armed:section', 'armed:phrase'].includes(trigger)) return 'change'
  if (['stale', 'phraseFallback', 'armed:age'].includes(trigger)) return 'forced'
  if (trigger === 'buildSwitch') return 'build'
  return 'other'
}

/** Scenes (inter-cut intervals) longer than 64 bars / 120 s / 300 s over a set of runs. */
function longStats(rs: readonly Run[]): { n: number; bars64: number; sec120: number; sec300: number; tracks64: number } {
  let n = 0
  let bars64 = 0
  let sec120 = 0
  let sec300 = 0
  let tracks64 = 0
  for (const r of rs) {
    n += r.cad.intervalsBars.length
    const b = r.cad.intervalsBars.filter((x) => x > 64).length
    bars64 += b
    if (b > 0) tracks64++
    sec120 += r.cad.intervalsSec.filter((x) => x > 120).length
    sec300 += r.cad.intervalsSec.filter((x) => x > 300).length
  }
  return { n, bars64, sec120, sec300, tracks64 }
}

const emptyBuckets = (): Record<Bucket, number> => ({ drop: 0, change: 0, breakdown: 0, forced: 0, build: 0, other: 0 })

interface Item {
  id: string
  family: string
}

function familyMap(): Map<string, string> {
  const m = new Map<string, string>()
  if (existsSync(BASELINE_JSON)) {
    const j = JSON.parse(readFileSync(BASELINE_JSON, 'utf8')) as { perTrack?: Array<{ id: string; family: string }> }
    for (const t of j.perTrack ?? []) m.set(t.id, t.family)
  }
  return m
}

function runOne(item: Item, trace: ReturnType<typeof unpackTrace>, variant: 'legacy' | 'director'): Run {
  const minutes = trace.n / trace.frameRate / 60
  const res = variant === 'legacy' ? simulateLegacy(trace) : simulateDirector(trace)
  const cad = cadenceOfTrack(item.id, trace, res, { seed: SEED, chanceCopies: COPIES })
  const buckets = emptyBuckets()
  for (const c of res.commits) buckets[bucketOf(c.trigger)]++
  const sa = structuralAlignment(trace, res.commits.map((c) => c.timeSec), { seed: SEED, chanceCopies: COPIES })
  const d = variant === 'director' ? (res as DirectorReplayResult) : null
  return {
    id: item.id,
    family: item.family,
    minutes,
    cad,
    buckets,
    hold: d?.stats.hold ?? 0,
    micro: d?.stats.micro ?? 0,
    cut: d?.stats.cut ?? 0,
    outcomes: d?.outcomes ?? null,
    release: d?.releaseDrops ?? null,
    structReal: sa.real,
    structChance: sa.chance,
  }
}

// --- Aggregation ---------------------------------------------------------------------------------------------

interface Agg {
  runs: Run[]
  cad: CadenceAggregate
  cutsPerMin: number
  forcedShare: number
  buckets: Record<Bucket, number>
  bucketShare: Record<Bucket, number>
  hold: number
  micro: number
  cut: number
  outcomes: Record<string, EventOutcomes> | null
  release: ReleaseDropOutcomes | null
  struct2s: { real: number; chance: number }
  struct4s: { real: number; chance: number }
  perTrackCutsPerMin: { p10: number; median: number; p90: number; max: number }
  perTrackMedianBars: { p10: number; median: number; p90: number }
}

const share = (xs: readonly number[], hi: number): number => (xs.length ? xs.filter((x) => x <= hi).length / xs.length : NaN)

function aggregate(runs: Run[]): Agg {
  const cad = aggregateCadence(runs.map((r) => r.cad))
  const buckets = emptyBuckets()
  let hold = 0
  let micro = 0
  let cut = 0
  for (const r of runs) {
    for (const b of BUCKETS) buckets[b] += r.buckets[b]
    hold += r.hold
    micro += r.micro
    cut += r.cut
  }
  const total = BUCKETS.reduce((s, b) => s + buckets[b], 0)
  const bucketShare = emptyBuckets()
  for (const b of BUCKETS) bucketShare[b] = total ? buckets[b] / total : NaN
  const withOut = runs.filter((r) => r.outcomes !== null)
  let outcomes: Record<string, EventOutcomes> | null = null
  let release: ReleaseDropOutcomes | null = null
  if (withOut.length) {
    outcomes = {}
    release = { events: 0, cut: 0, micro: 0, hold: 0, fast: 0, refractory: 0 }
    for (const r of withOut) {
      for (const [ty, o] of Object.entries(r.outcomes as Record<string, EventOutcomes>)) {
        const t = (outcomes[ty] ??= { events: 0, cut: 0, micro: 0, hold: 0 })
        t.events += o.events
        t.cut += o.cut
        t.micro += o.micro
        t.hold += o.hold
      }
      const rd = r.release as ReleaseDropOutcomes
      release.events += rd.events
      release.cut += rd.cut
      release.micro += rd.micro
      release.hold += rd.hold
      release.fast += rd.fast
      release.refractory += rd.refractory
    }
  }
  const real = runs.flatMap((r) => r.structReal)
  const chance = runs.flatMap((r) => r.structChance)
  const rates = runs.map((r) => r.cad.commits / r.minutes).sort((a, b) => a - b)
  const medBars = runs
    .map((r) => distStats(r.cad.intervalsBars).median)
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
  return {
    runs,
    cad,
    cutsPerMin: cad.commitsPerMinute,
    forcedShare: total ? buckets.forced / total : NaN,
    buckets,
    bucketShare,
    hold,
    micro,
    cut,
    outcomes,
    release,
    struct2s: { real: share(real, 2), chance: share(chance, 2) },
    struct4s: { real: share(real, 4), chance: share(chance, 4) },
    perTrackCutsPerMin: { p10: quantile(rates, 0.1), median: quantile(rates, 0.5), p90: quantile(rates, 0.9), max: rates[rates.length - 1] },
    perTrackMedianBars: { p10: quantile(medBars, 0.1), median: quantile(medBars, 0.5), p90: quantile(medBars, 0.9) },
  }
}

// --- Report --------------------------------------------------------------------------------------------------

interface Variant {
  key: 'legacy' | 'directorCommitted' | 'director'
  title: string
  agg: Agg
}

function row(label: string, vs: Variant[], f: (a: Agg) => string): string {
  return `| ${label} | ${vs.map((v) => f(v.agg)).join(' | ')} |`
}

function outcomeRow(variant: string, label: string, o: EventOutcomes | undefined): string {
  if (!o || o.events === 0) return `| ${variant} | ${label} | 0 | - | - | - |`
  return `| ${variant} | ${label} | ${o.events} | ${o.cut} (${pct(o.cut / o.events)}) | ${o.micro} (${pct(o.micro / o.events)}) | ${o.hold} (${pct(o.hold / o.events)}) |`
}

function buildReport(
  all: Record<Variant['key'], Run[]>,
  dropEdgesPerHour: number,
  totalMinutes: number,
  novelty: number[],
): { md: string; json: unknown } {
  const vs: Variant[] = [
    { key: 'legacy', title: 'legacy model', agg: aggregate(all.legacy) },
    { key: 'directorCommitted', title: 'director @ first commit', agg: aggregate(all.directorCommitted) },
    { key: 'director', title: 'director (tuned)', agg: aggregate(all.director) },
  ]
  const [leg, old, cur] = vs.map((v) => v.agg)
  const families = [...new Set(all.director.map((r) => r.family))].sort()

  const crit = [
    ['cuts per minute <= ~3 (legacy model 6.35)', cur.cutsPerMin <= 3.05, f2(cur.cutsPerMin)],
    ['median interval >= 8 bars (legacy model 4.0)', cur.cad.intervalBars.median >= 8, f1(cur.cad.intervalBars.median)],
    ['>= 80% of intervals inside [4, 32] bars (legacy model 53%)', cur.cad.shareBars.in4to32 >= 0.8, pct(cur.cad.shareBars.in4to32)],
    ['NO timer: every director cut is an event verdict (0 timer cuts)', cur.buckets.forced === 0 && cur.cad.triggers.every((t) => /^(drop|change|breakdown):/.test(t.trigger)), `${cur.buckets.forced} timer cuts`],
    [
      'drops that follow a build/breakdown still hard-cut (fast lane on >= 80% of those not held by the 4-bar refractory)',
      cur.release !== null && cur.release.events - cur.release.refractory > 0 && cur.release.fast / (cur.release.events - cur.release.refractory) >= 0.8,
      cur.release
        ? `${cur.release.fast} fast-lane of ${cur.release.events - cur.release.refractory} not in a refractory (${pct(cur.release.fast / Math.max(1, cur.release.events - cur.release.refractory))}); ${cur.release.refractory} of ${cur.release.events} were inside the refractory`
        : 'n/a',
    ],
    [
      'cuts within +-2 s of a STRUCTURAL detector event clearly above the random-phase control',
      cur.struct2s.real - cur.struct2s.chance >= 0.1,
      `${pct(cur.struct2s.real)} vs chance ${pct(cur.struct2s.chance)}`,
    ],
  ] as const

  const L: string[] = []
  L.push('# Director replay over the real tracks (the REAL show director vs the legacy trigger MODEL)', '')
  L.push(
    `Generated ${new Date().toISOString()} | ${all.director.length} cached traces, ${f1(totalMinutes)} min | DR_LIMIT=${LIMIT || 'all'} seed ${SEED}, ${COPIES} chance copies`,
    '',
  )
  L.push(
    '**Nothing was watched and there is no musical ground truth.** The real `showDirector.step` and the real legacy-event mapper are replayed over the app\'s own recorded detector outputs',
    '(`corpus/structure/traces/`, written by `baseline-scene-cadence.calib.ts`), with a model of the store / SceneManager commit path (`src/audio/eval/directorReplay.ts`). The legacy column is the',
    'legacy trigger MODEL (`legacyCadence.ts`), not the running app. "Alignment" is to the app\'s own detectors against a random-phase control; it bounds how music-anchored the show can be and does not',
    'say the detectors were right. The `f.drop` edges (~' + f1(dropEdgesPerHour) + ' per hour here) have no ground truth either: the point of this lane is that the director must not trust them blindly.',
    '',
  )
  L.push('## Success criteria (variant `director`)', '', '| criterion | result | met |', '|---|---|---|')
  for (const [name, ok, val] of crit) L.push(`| ${name} | ${val} | ${ok ? 'yes' : '**NO**'} |`)
  L.push('')

  L.push('## Side by side (same traces)', '', `| | ${vs.map((v) => v.title).join(' | ')} |`, `|---|${vs.map(() => '---').join('|')}|`)
  L.push(row('scene changes', vs, (a) => `${a.cad.commits}`))
  L.push(row('**cuts per minute**', vs, (a) => f2(a.cutsPerMin)))
  L.push(row('startup commits (first 5 s)', vs, (a) => `${a.cad.startupCommits}`))
  L.push(row('interval, seconds: median / p10 / p90', vs, (a) => `${f1(a.cad.intervalSec.median)} / ${f1(a.cad.intervalSec.p10)} / ${f1(a.cad.intervalSec.p90)}`))
  L.push(row('**interval, bars: median / p10 / p90**', vs, (a) => `${f1(a.cad.intervalBars.median)} / ${f1(a.cad.intervalBars.p10)} / ${f1(a.cad.intervalBars.p90)}`))
  L.push(row('**share of intervals in [4, 32] bars**', vs, (a) => `${pct(a.cad.shareBars.in4to32)} (below 4: ${pct(a.cad.shareBars.below4)}, above 32: ${pct(a.cad.shareBars.above32)})`))
  L.push(row('per-track cuts/min: p10 / median / p90 / max', vs, (a) => `${f2(a.perTrackCutsPerMin.p10)} / ${f2(a.perTrackCutsPerMin.median)} / ${f2(a.perTrackCutsPerMin.p90)} / ${f2(a.perTrackCutsPerMin.max)}`))
  L.push(row('per-track median interval, bars: p10 / median / p90', vs, (a) => `${f1(a.perTrackMedianBars.p10)} / ${f1(a.perTrackMedianBars.median)} / ${f1(a.perTrackMedianBars.p90)}`))
  L.push(row('**level-type timer cuts** (legacy model only; the director has no timer)', vs, (a) => pct(a.forcedShare)))
  L.push(row('HOLD / MICRO / CUT decisions (director only)', vs, (a) => (a.cut + a.micro + a.hold ? `${a.hold} / ${a.micro} / ${a.cut}` : '-')))
  L.push(
    row('cuts within +-2 s of a structural event (sectionChange, latched boundary, analyser boundary)', vs, (a) => `${pct(a.struct2s.real)} (chance ${pct(a.struct2s.chance)})`),
  )
  L.push(row('... within +-4 s', vs, (a) => `${pct(a.struct4s.real)} (chance ${pct(a.struct4s.chance)})`))
  L.push(row('cuts within +-2 s of ANY event incl. `f.drop`', vs, (a) => `${pct(a.cad.align.any.within2s.real)} (chance ${pct(a.cad.align.any.within2s.chance)})`))
  L.push(row('cuts within +-2 s of an `f.drop` edge', vs, (a) => `${pct(a.cad.align.drop.within2s.real)} (chance ${pct(a.cad.align.drop.within2s.chance)})`))
  L.push('')

  L.push('## Which trigger produced each cut', '', `| bucket | ${vs.map((v) => v.title).join(' | ')} |`, `|---|${vs.map(() => '---').join('|')}|`)
  for (const b of BUCKETS) L.push(row(b === 'forced' ? 'legacy level-type timers' : b, vs, (a) => `${a.buckets[b]} (${pct(a.bucketShare[b])})`))
  L.push('', 'Director trigger strings (variant `director`):', '', '| trigger | cuts | share |', '|---|---|---|')
  for (const t of cur.cad.triggers) L.push(`| ${t.trigger} | ${t.count} | ${pct(t.share)} |`)
  L.push('')

  L.push('## What became of the detector events (director decisions per distinct event)', '')
  L.push(`| variant | event | events | CUT | MICRO | HOLD |`, '|---|---|---|---|---|---|')
  for (const v of [vs[1], vs[2]]) {
    if (!v.agg.outcomes) continue
    L.push(outcomeRow(v.title, 'drop', v.agg.outcomes.drop))
    if (v.agg.release) L.push(outcomeRow(v.title, `drop after a build/breakdown (trace-judged; ${v.agg.release.fast} fast-lane, ${v.agg.release.refractory} in a refractory)`, v.agg.release))
    L.push(outcomeRow(v.title, 'change (sectionChange / boundary)', v.agg.outcomes.change))
    L.push(outcomeRow(v.title, 'breakdown', v.agg.outcomes.breakdown))
  }
  if (cur.outcomes) {
    const d = cur.outcomes.drop
    const oldD = old.outcomes?.drop
    L.push(
      '',
      `- Of the ${d.events} drop events (${f1(d.events / (totalMinutes / 60))} per hour), the tuned director turns ${pct(d.cut / d.events)} into a scene change (first-commit director: ${oldD ? pct(oldD.cut / oldD.events) : 'n/a'}), ${pct(d.micro / d.events)} into a MICRO and ${pct(d.hold / d.events)} into a HOLD.`,
    )
  }
  L.push('')

  // The section-change strength mapping against the real distribution of the detector's own edges.
  const nv = novelty.slice().sort((a, b) => a - b)
  const strengthOld = (x: number): number =>
    Math.min(1, Math.max(0, (x - COMMITTED.legacy.sectionFloor) / (COMMITTED.legacy.sectionCeil - COMMITTED.legacy.sectionFloor)))
  L.push('## Section-change strength mapping vs the real distribution', '')
  L.push(
    nv.length + ' `f.sectionChange` edges (' + f1(nv.length / totalMinutes) + ' per minute). Raw novelty (`sectionChangeStrength`) quantiles, and the score S = strength x confidence (' + LEGACY.sectionConfidence + ') each maps to, under the first mapping (' + COMMITTED.legacy.sectionFloor + '..' + COMMITTED.legacy.sectionCeil + ') and the current one (' + LEGACY.sectionFloor + '..' + LEGACY.sectionCeil + '):',
    '',
  )
  L.push('| quantile | novelty | S, first mapping | S, current | verdict for the current S in a 6-bar / 10-bar / 14-bar scene (T = 0.75 / 0.45 / 0.30) |', '|---|---|---|---|---|')
  for (const q of [0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99]) {
    const x = quantile(nv, q)
    const s0 = strengthOld(x) * LEGACY.sectionConfidence
    const s1 = sectionStrength(x) * LEGACY.sectionConfidence
    const v = (t: number): string => (s1 >= t ? 'CUT' : s1 >= 0.25 ? 'MICRO' : 'HOLD')
    L.push('| p' + Math.round(q * 100) + ' | ' + f2(x) + ' | ' + f2(s0) + ' | ' + f2(s1) + ' | ' + v(0.75) + ' / ' + v(0.45) + ' / ' + v(0.3) + ' |')
  }
  L.push('')

  L.push('## Per genre family (variant `director` vs `directorCommitted` vs `legacy`)', '')
  L.push('| family | tracks | legacy cuts/min | first-commit cuts/min | tuned cuts/min | legacy median bars | first-commit | tuned | tuned in [4,32] | tuned scenes > 64 bars | tuned scenes > 120 s | tuned struct <=2 s (chance) | tuned p90 track cuts/min |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const fam of families) {
    const sel = (rs: Run[]) => aggregate(rs.filter((r) => r.family === fam))
    const a = sel(all.legacy)
    const b = sel(all.directorCommitted)
    const c = sel(all.director)
    L.push(
      `| ${fam} | ${c.runs.length} | ${f2(a.cutsPerMin)} | ${f2(b.cutsPerMin)} | ${f2(c.cutsPerMin)} | ${f1(a.cad.intervalBars.median)} | ${f1(b.cad.intervalBars.median)} | ${f1(c.cad.intervalBars.median)} | ${pct(c.cad.shareBars.in4to32)} | ${longStats(c.runs).bars64} (${pct(longStats(c.runs).bars64 / Math.max(1, longStats(c.runs).n))}) | ${longStats(c.runs).sec120} (${pct(longStats(c.runs).sec120 / Math.max(1, longStats(c.runs).n))}) | ${pct(c.struct2s.real)} (${pct(c.struct2s.chance)}) | ${f2(c.perTrackCutsPerMin.p90)} |`,
    )
  }
  L.push('')

  // Split-half: the constants were tuned on all these tracks, so at least show the result does not hinge on a subset.
  L.push('### Split-half stability (variant `director`, tracks alternately assigned by sorted id)', '')
  L.push('| half | tracks | cuts/min | median bars | in [4,32] | struct <=2 s (chance) |', '|---|---|---|---|---|---|')
  for (const half of [0, 1]) {
    const h = aggregate(all.director.filter((_, k) => k % 2 === half))
    L.push('| ' + (half === 0 ? 'even' : 'odd') + ' | ' + h.runs.length + ' | ' + f2(h.cutsPerMin) + ' | ' + f1(h.cad.intervalBars.median) + ' | ' + pct(h.cad.shareBars.in4to32) + ' | ' + pct(h.struct2s.real) + ' (' + pct(h.struct2s.chance) + ') |')
  }
  L.push('')

  L.push('## Per track (variant `director`)', '')
  L.push('| id | family | min | drops/h | cuts/min (legacy) | median bars | longest scene (bars / s) | drop cuts | change cuts | breakdown cuts | HOLD/MICRO/CUT |', '|---|---|---|---|---|---|---|---|---|---|---|')
  for (let k = 0; k < all.director.length; k++) {
    const r = all.director[k]
    const lg = all.legacy[k]
    const dropsPerHour = r.cad.detector.drop / (r.minutes / 60)
    L.push(
      `| ${r.id} | ${r.family} | ${r.minutes.toFixed(1)} | ${dropsPerHour.toFixed(0)} | ${f2(r.cad.commits / r.minutes)} (${f2(lg.cad.commits / lg.minutes)}) | ${f1(distStats(r.cad.intervalsBars).median)} | ${f1(Math.max(0, ...r.cad.intervalsBars))} / ${f1(Math.max(0, ...r.cad.intervalsSec))} | ${r.buckets.drop} | ${r.buckets.change} | ${r.buckets.breakdown} | ${r.hold}/${r.micro}/${r.cut} |`,
    )
  }
  L.push('')

  // The real consequence of having no timer: how long a scene can be held when no event of enough strength arrives.
  {
    const ls = longStats(all.director)
    L.push('## Long scenes (variant `director`: no timer, so a scene lives until a strong enough event)', '')
    L.push(`- ${ls.n} intervals; ${ls.bars64} (${pct(ls.bars64 / Math.max(1, ls.n))}) are longer than 64 bars, ${ls.sec120} (${pct(ls.sec120 / Math.max(1, ls.n))}) longer than 120 s, ${ls.sec300} longer than 300 s.`)
    L.push(`- Tracks with at least one scene > 64 bars: ${ls.tracks64} of ${all.director.length}; tracks whose cuts/min is < 0.5 (visually near-static): ${all.director.filter((r) => r.cad.commits / r.minutes < 0.5).length}.`, '')
    L.push('| family | tracks | intervals | > 64 bars | > 120 s | tracks < 0.5 cuts/min | tracks with 0 cuts | longest scene (s) |', '|---|---|---|---|---|---|---|---|')
    for (const fam of families) {
      const rs = all.director.filter((r) => r.family === fam)
      const l = longStats(rs)
      L.push(`| ${fam} | ${rs.length} | ${l.n} | ${l.bars64} | ${l.sec120} | ${rs.filter((r) => r.cad.commits / r.minutes < 0.5).length} | ${rs.filter((r) => r.cad.commits === 0).length} | ${f1(Math.max(0, ...rs.flatMap((r) => r.cad.intervalsSec)))} |`)
    }
    L.push('', 'Longest scenes:', '', '| id | family | seconds | bars | track min |', '|---|---|---|---|---|')
    const top = all.director
      .flatMap((r) => r.cad.intervalsSec.map((sec, k) => ({ r, sec, bars: r.cad.intervalsBars[k] })))
      .sort((a, b) => b.sec - a.sec)
      .slice(0, 15)
    for (const t of top) L.push(`| ${t.r.id} | ${t.r.family} | ${f1(t.sec)} | ${f1(t.bars)} | ${f1(t.r.minutes)} |`)
    L.push('')
  }

  const constantsOf = (o: object, keys: string[]) => Object.fromEntries(keys.map((k) => [k, (o as Record<string, unknown>)[k]]))
  const liveLegacy = constantsOf(LEGACY, Object.keys(COMMITTED.legacy))
  const liveShow = constantsOf(SHOW, Object.keys(COMMITTED.show).concat(['minCutBars', 'dropFastMinBars', 'dropFastMinS', 'dropWindowBars', 'dropReleaseBars', 'refractoryBars', 'microMinS']))
  L.push('## Constants', '', '- Tuned (live): `LEGACY` ' + '`' + JSON.stringify(liveLegacy) + '`, `SHOW` `' + JSON.stringify(liveShow) + '`.')
  L.push('- First commit (put back for `directorCommitted`): `LEGACY` `' + JSON.stringify(COMMITTED.legacy) + '`, `SHOW` `' + JSON.stringify(COMMITTED.show) + '`.', '')

  L.push('## Caveats', '')
  L.push(
    '- Internal evaluation only. The Jamendo tracks are non-commercial research data; do not redistribute the audio or the traces.',
    '- The replay models the adapter\'s inputs and the commit path (`directorReplay.ts` header): manual holds, cues and DJ-cam / Limitless cutaways are absent (they only make the real show change less often), the mood\'s `isBuilding` / `isDecaying` flags are not in the trace (the trend pressure is under-reported), and scene identity / armed-scene fits are not modelled.',
    '- The legacy column is the model `legacyCadence.ts`; both shows are scored by the same `cadenceMetrics.ts`. The "share of intervals in [4, 32] bars" and the bar counts use the app\'s own beat counter / 4 (a track read at half or double tempo has the wrong bar length; seconds are exact).',
    '- "Structural events" are `f.sectionChange` edges, latched `boundaryChanged` edges and the analyser\'s boundaries. `f.drop` edges are reported separately because a drop-triggered cut satisfies that alignment by construction. Neither is ground truth: a noisy detector makes noisy events.',
    '- The constants were tuned on these same 98 tracks (sweeps of the section-strength mapping, the drop confidences, the rarity table and the threshold ramp). The per-genre table is the check against fitting one genre; there is no held-out set and no tap log yet.',
    '',
  )

  const jsonAgg = (a: Agg) => ({
    cutsPerMinute: a.cutsPerMin,
    cad: a.cad,
    buckets: a.buckets,
    bucketShare: a.bucketShare,
    forcedShare: a.forcedShare,
    hold: a.hold,
    micro: a.micro,
    cut: a.cut,
    outcomes: a.outcomes,
    releaseDrops: a.release,
    structural: { within2s: a.struct2s, within4s: a.struct4s },
    perTrackCutsPerMin: a.perTrackCutsPerMin,
    perTrackMedianBars: a.perTrackMedianBars,
  })
  const json = {
    generated: new Date().toISOString(),
    tracks: all.director.length,
    minutes: totalMinutes,
    knobs: { limit: LIMIT, seed: SEED, copies: COPIES },
    criteria: crit.map(([name, ok, val]) => ({ name, ok, value: val })),
    constants: { tuned: { legacy: liveLegacy, show: liveShow }, committed: COMMITTED },
    variants: Object.fromEntries(vs.map((v) => [v.key, jsonAgg(v.agg)])),
    perFamily: Object.fromEntries(
      families.map((fam) => [
        fam,
        Object.fromEntries((['legacy', 'directorCommitted', 'director'] as const).map((k) => [k, jsonAgg(aggregate(all[k].filter((r) => r.family === fam)))])),
      ]),
    ),
  }
  return { md: L.join('\n') + '\n', json }
}

describe.skipIf(!existsSync(TRACE_DIR))('director replay over the real traces', () => {
  it(
    'replays the real director (first-commit and tuned constants) and the legacy model over every cached trace and writes the report',
    () => {
      const fam = familyMap()
      let names = readdirSync(TRACE_DIR).filter((n) => n.endsWith('.json')).sort()
      if (LIMIT) names = names.slice(0, LIMIT)
      expect(names.length).toBeGreaterThan(0)
      const all: Record<Variant['key'], Run[]> = { legacy: [], directorCommitted: [], director: [] }
      let minutes = 0
      let dropEdges = 0
      const novelty: number[] = []
      for (const name of names) {
        const id = name.replace(/\.json$/, '')
        const item: Item = { id, family: fam.get(id) ?? 'unknown' }
        const trace = unpackTrace(JSON.parse(readFileSync(join(TRACE_DIR, name), 'utf8')) as PackedTrace)
        minutes += trace.n / trace.frameRate / 60
        for (let i = 0; i < trace.n; i++) if (trace.cols.sectionChange[i] === 1) novelty.push(trace.cols.sectionChangeStrength[i] / STRENGTH_SCALE)
        all.legacy.push(runOne(item, trace, 'legacy'))
        all.directorCommitted.push(
          withConstants(LEGACY, COMMITTED.legacy, () => withConstants(SHOW, COMMITTED.show, () => runOne(item, trace, 'director'))),
        )
        const cur = runOne(item, trace, 'director')
        all.director.push(cur)
        dropEdges += cur.cad.detector.drop
      }
      const { md, json } = buildReport(all, dropEdges / (minutes / 60), minutes, novelty)
      mkdirSync(OUT_DIR, { recursive: true })
      writeFileSync(OUT_MD, md)
      writeFileSync(OUT_JSON, JSON.stringify(json, null, 2))
      console.log(md.split('\n').slice(0, 60).join('\n'))
      console.log(`wrote ${OUT_MD} (${names.length} traces)`)

      // Weak sanity only (this is a measurement, not a gate): every variant produced scene changes.
      for (const k of ['legacy', 'directorCommitted', 'director'] as const) {
        expect(all[k].reduce((s, r) => s + r.cad.commits, 0)).toBeGreaterThan(0)
      }
    },
    30 * 60 * 1000,
  )
})
