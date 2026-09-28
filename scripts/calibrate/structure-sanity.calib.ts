/**
 * Structure-detector firing-SANITY check (plan phase 6, `so-the-mood-analysis-lively-hickey.md`):
 * NOT an accuracy gate — there is no labeled ground truth for real song-section boundaries in any
 * corpus this repo has (PMEmo/DEAM are valence/arousal ratings, not structure labels), and the plan is
 * explicit that this isn't the goal. This exists purely so a regression that silently makes
 * `StructureAnalyzer` inert again — exactly what happened, undetected, for months, to the Essentia-only
 * predecessor it replaced (see the plan's Context section) — cannot land unnoticed a second time. It
 * asserts only WEAK bounds: some nonzero share of tracks produce at least one detected boundary. Tuning
 * thresholds against these numbers is out of scope here; that happens by ear against real, varied songs
 * via `?structuredebug`/`DebugPanel` (plan phase 7), not this script.
 *
 *   npm run calibrate -- scripts/calibrate/structure-sanity.calib.ts
 *
 * Data (gitignored, same corpus `emotion.calib.ts` already fetches via `node
 * corpus/fetch-emotion-sets.mjs`): PMEmo chorus clips
 * (`corpus/emotion/pmemo/extracted/PMEmo2019/chorus/*.mp3`) plus DEAM full tracks if present
 * (`corpus/emotion/deam/audio/**\/*.mp3`) — whichever exists locally. No annotations/ratings are read
 * (structure sanity needs audio only), so this loads mp3s directly rather than importing
 * `emotion.calib.ts`'s CSV-keyed loaders. This script does NOT fetch new audio: if the only corpus
 * present is PMEmo (as in the environment this was written against — DEAM has annotations but no
 * `deam/audio/` locally), note that PMEmo's "chorus" clips are ~45 s excerpts, not full multi-minute
 * tracks with real builds/drops — legitimate input for the "does it ever fire at all" check below, but
 * not the EDM-heavy material the plan's live-test step is meant to exercise. See the generated report's
 * own caveats section for whatever was actually true of the run.
 *
 * Knobs: STRUCT_LIMIT=N clips, deterministic sample (default 40; 0 = every clip found)
 *        STRUCT_SEED=n  sampling seed (default 1)
 *
 * Output (gitignored, derived): corpus/structure/sanity-report.md + sanity.json
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeMp3File } from './decode'
import { runTrack } from './features'
import { mean, rng } from './stats'

const ROOT = resolve(__dirname, '../..')
const EMO = join(ROOT, 'corpus/emotion')
const OUT_DIR = join(ROOT, 'corpus/structure')
const OUT_MD = join(OUT_DIR, 'sanity-report.md')
const OUT_JSON = join(OUT_DIR, 'sanity.json')

const LIMIT = process.env.STRUCT_LIMIT === undefined ? 40 : Math.max(0, Number(process.env.STRUCT_LIMIT) || 0)
const SEED = Number(process.env.STRUCT_SEED) || 1
/** Tracks at/above this length are the "not inert" check's real target (the plan's own wording: "every
 *  multi-minute track gets at least one detected boundary"). Below it, zero boundaries is a legitimate
 *  outcome — `StructureAnalyzer`'s own warm-up floor (`MIN_HISTORY_SEC` + `FIRST_JOB_DELAY_SEC`, ~20-25 s)
 *  already eats a big share of a 45 s clip before a first batch is even eligible to run. */
const MULTI_MINUTE_SEC = 60
/** A divergence beyond this between the detector's own `build.active` frame share and the fast, always-on
 *  `f.buildUp` heuristic's share is surfaced as a caveat, not asserted on — see the module header. */
const BUILD_SHARE_DIVERGENCE_FLAG = 0.3

interface Item {
  id: string
  set: 'pmemo' | 'deam'
  path: string
}

/** Recursively index *.mp3 under a directory by their basename (no annotations needed here). */
function indexMp3(dir: string, into = new Map<string, string>()): Map<string, string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) indexMp3(p, into)
    else if (/\.mp3$/i.test(name)) into.set(name.replace(/\.mp3$/i, ''), p)
  }
  return into
}

function loadPmemo(): Item[] {
  const dir = join(EMO, 'pmemo/extracted/PMEmo2019/chorus')
  if (!existsSync(dir)) return []
  return [...indexMp3(dir)].map(([id, path]) => ({ id: `pmemo_${id}`, set: 'pmemo' as const, path }))
}

function loadDeam(): Item[] {
  const dir = join(EMO, 'deam/audio')
  if (!existsSync(dir)) return []
  return [...indexMp3(dir)].map(([id, path]) => ({ id: `deam_${id}`, set: 'deam' as const, path }))
}

/** Deterministic sample, same shuffle-and-slice shape as `emotion.calib.ts`'s own `sample()`. */
function sample<T>(items: T[], n: number, seed: number): T[] {
  if (!n || items.length <= n) return items
  const idx = items.map((_, i) => i)
  const r = rng(seed)
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[idx[i], idx[j]] = [idx[j], idx[i]]
  }
  return idx.slice(0, n).map((i) => items[i])
}

interface TrackSanity {
  id: string
  set: 'pmemo' | 'deam'
  durationSec: number
  frames: number
  /** From the LAST `StructureRaw` in `structureRuns` (segments/boundaries accumulate and refine
   *  batch to batch, so the last one is the track's final read), or 0/empty if no batch ever ran. */
  segments: number
  boundaries: number
  hasBoundary: boolean
  /** Mean share of frames where `StructureAnalyzer`'s own held `build.active` read was true. */
  detectorBuildShare: number
  /** Mean share of frames where the fast, always-on broadband `f.buildUp` flag was true. */
  fastBuildShare: number
  runs: number
  lastCostMs: number
}

function summarize(id: string, set: 'pmemo' | 'deam', run: ReturnType<typeof runTrack>): TrackSanity {
  const last = run.structureRuns.length ? run.structureRuns[run.structureRuns.length - 1] : null
  return {
    id,
    set,
    durationSec: run.durationSec,
    frames: run.frames.length,
    segments: last ? last.segments.length : 0,
    boundaries: last ? last.boundaries.length : 0,
    hasBoundary: !!last && last.boundaries.length > 0,
    detectorBuildShare: mean(run.frames.map((f) => (f.structureBuildActive ? 1 : 0))),
    fastBuildShare: mean(run.frames.map((f) => (f.buildUp ? 1 : 0))),
    runs: run.structureStatus.runs,
    lastCostMs: run.structureStatus.lastCostMs,
  }
}

const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : 'n/a')
const pct = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : 'n/a')

function buildReport(clips: TrackSanity[], failed: number, elapsedSec: number): { md: string; json: unknown } {
  const pctWithBoundary = mean(clips.map((c) => (c.hasBoundary ? 1 : 0)))
  const multiMinute = clips.filter((c) => c.durationSec >= MULTI_MINUTE_SEC)
  const pctMultiMinuteWithBoundary = multiMinute.length ? mean(multiMinute.map((c) => (c.hasBoundary ? 1 : 0))) : NaN
  const meanBoundaries = mean(clips.map((c) => c.boundaries))
  const meanSegments = mean(clips.map((c) => c.segments))
  const meanDetectorBuildShare = mean(clips.map((c) => c.detectorBuildShare))
  const meanFastBuildShare = mean(clips.map((c) => c.fastBuildShare))
  const buildShareDivergence = Math.abs(meanDetectorBuildShare - meanFastBuildShare)
  const meanRuns = mean(clips.map((c) => c.runs))
  const zeroRunTracks = clips.filter((c) => c.runs === 0).length
  const meanLastCostMs = mean(clips.map((c) => c.lastCostMs))
  const maxLastCostMs = clips.reduce((m, c) => Math.max(m, c.lastCostMs), 0)
  const meanDurationSec = mean(clips.map((c) => c.durationSec))

  const L: string[] = []
  L.push('# Structure detector: firing-sanity report', '')
  L.push(
    `Generated ${new Date().toISOString()} | ${clips.length} clips (${failed} failed) | ${(elapsedSec / 60).toFixed(1)} min | STRUCT_LIMIT=${LIMIT || 'all'} seed ${SEED}`,
    '',
  )
  L.push(
    'NOT an accuracy gate (no labeled boundary ground truth exists for this corpus). Checks only that the',
    'detector is not silently inert: fires on a nonzero share of tracks, and its own `build.active` read is',
    'in the same ballpark as the fast, always-on `f.buildUp` heuristic. See the module header for the full',
    'rationale (plan phase 6).',
    '',
  )
  L.push('## Aggregate', '')
  L.push(`- Mean clip duration: **${meanDurationSec.toFixed(1)}s**`)
  L.push(
    `- **% of ALL evaluated clips with >=1 detected boundary: ${pct(pctWithBoundary)}** (${clips.filter((c) => c.hasBoundary).length}/${clips.length}) — the core "not inert" check.`,
  )
  L.push(
    multiMinute.length
      ? `- % of multi-minute (>=${MULTI_MINUTE_SEC}s) clips with >=1 boundary: ${pct(pctMultiMinuteWithBoundary)} (n=${multiMinute.length}).`
      : `- No clips reached the multi-minute (>=${MULTI_MINUTE_SEC}s) threshold in this run (n=0) — this corpus is PMEmo/DEAM ~45s "chorus" excerpts, not full tracks; the plan itself anticipates this ("shorter clips may legitimately produce zero"). The all-clips figure above is the one this run can actually speak to.`,
  )
  L.push(`- Mean boundaries/clip: ${meanBoundaries.toFixed(2)}; mean segments/clip: ${meanSegments.toFixed(2)}.`)
  L.push(
    `- Mean detector \`build.active\` frame share: **${pct(meanDetectorBuildShare)}** vs. mean fast \`f.buildUp\` frame share: **${pct(meanFastBuildShare)}** (|divergence| ${pct(buildShareDivergence)}` +
      (buildShareDivergence > BUILD_SHARE_DIVERGENCE_FLAG
        ? ` — **flagged**: beyond the ${pct(BUILD_SHARE_DIVERGENCE_FLAG)} sanity margin, worth a look, not asserted on.`
        : ` — within the ${pct(BUILD_SHARE_DIVERGENCE_FLAG)} sanity margin.`) +
      ')',
  )
  L.push(
    `- Mean batch runs/clip: ${meanRuns.toFixed(2)} (${zeroRunTracks} clip(s) never cleared warm-up — expected for anything well under ~20-25s).`,
  )
  L.push(`- \`lastCostMs\`: mean ${meanLastCostMs.toFixed(1)}ms, max ${maxLastCostMs.toFixed(1)}ms (watch for a blowup here across runs).`, '')

  L.push('## Per-track', '')
  L.push('| id | set | dur(s) | frames | segs | bnd | detBld% | fastBld% | runs | lastCostMs |')
  L.push('|---|---|---|---|---|---|---|---|---|---|')
  for (const c of clips) {
    L.push(
      `| ${c.id} | ${c.set} | ${c.durationSec.toFixed(1)} | ${c.frames} | ${c.segments} | ${c.boundaries} | ${pct(c.detectorBuildShare)} | ${pct(c.fastBuildShare)} | ${c.runs} | ${f2(c.lastCostMs)} |`,
    )
  }
  L.push('')
  L.push('## Caveats', '')
  L.push(
    '- Internal evaluation only. PMEmo/DEAM are non-commercial research data; do not redistribute the audio.',
  )
  L.push(
    '- No ground truth: "boundary fired" is a firing-rate check, not a correctness check. A track scoring 0 boundaries is not necessarily wrong (see the multi-minute note above); a track scoring many is not necessarily right.',
  )
  L.push('- The engine runs without Essentia here (matching the commercial build) — this is exactly the code path `StructureAnalyzer` exists to cover.', '')

  const json = {
    generated: new Date().toISOString(),
    clips: clips.length,
    failed,
    limit: LIMIT,
    seed: SEED,
    aggregate: {
      meanDurationSec,
      pctWithBoundary,
      multiMinuteN: multiMinute.length,
      pctMultiMinuteWithBoundary,
      meanBoundaries,
      meanSegments,
      meanDetectorBuildShare,
      meanFastBuildShare,
      buildShareDivergence,
      meanRuns,
      zeroRunTracks,
      meanLastCostMs,
      maxLastCostMs,
    },
    perClip: clips,
  }
  return { md: L.join('\n') + '\n', json }
}

const items: Item[] = []
items.push(...sample(loadPmemo(), LIMIT, SEED))
items.push(...sample(loadDeam(), LIMIT, SEED + 1))

describe.skipIf(items.length === 0)('structure detector firing sanity', () => {
  it(
    `runs ${items.length} clip(s) through StructureAnalyzer and writes the sanity report`,
    async () => {
      const t0 = Date.now()
      const clips: TrackSanity[] = []
      let failed = 0
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        try {
          const audio = await decodeMp3File(item.path)
          const run = runTrack(audio.pcm, audio.sampleRate)
          clips.push(summarize(item.id, item.set, run))
        } catch (e) {
          failed++
          console.log(`  skip ${item.id}: ${(e as Error).message}`)
        }
        if ((i + 1) % 10 === 0 || i + 1 === items.length) {
          const el = (Date.now() - t0) / 1000
          console.log(`  ${i + 1}/${items.length} clips, ${el.toFixed(0)}s`)
        }
      }
      expect(clips.length).toBeGreaterThan(0)
      const { md, json } = buildReport(clips, failed, (Date.now() - t0) / 1000)
      mkdirSync(OUT_DIR, { recursive: true })
      writeFileSync(OUT_MD, md)
      writeFileSync(OUT_JSON, JSON.stringify(json, null, 2))
      console.log(md)
      console.log(`wrote ${OUT_MD} (${clips.length} clips, ${failed} failed)`)

      // Weak sanity bound only (plan phase 6: "not an accuracy gate ... a firing-sanity gate"): some
      // nonzero share of tracks fire at least one boundary. Not a tuned threshold — a regression that
      // makes the detector permanently inert (boundaries always 0) is what this catches.
      const pctWithBoundary = mean(clips.map((c) => (c.hasBoundary ? 1 : 0)))
      expect(pctWithBoundary).toBeGreaterThan(0)
    },
    20 * 60 * 1000,
  )
})
