/**
 * Baseline scene-change CADENCE (phase 0C, `so-the-mood-analysis-lively-hickey.md`): quantifies, BEFORE any
 * behaviour change, the complaint that the primary scene changes every ~17-25 s uncorrelated with the music.
 *
 * Real decoded audio (`corpus/audio/*.mp3`, 90 full-length Jamendo tracks, plus `testfolder/*.mp3`) is replayed
 * through the FULL current chain (`runTrack` with `FULL_CHAIN_HOOKS`: including `SectionTracker`, the engine's
 * second drop path and the per-frame character read), the per-frame trigger inputs are cached to
 * `corpus/structure/traces/<id>.json`, and `simulateLegacy` (`src/audio/eval/legacyCadence.ts`) replays the legacy
 * trigger logic (32-beat dwell, PerformanceDirector boundaries, AutoPilot triggers, the armed scene's confirm
 * triggers, SceneManager's downbeat commit) over each trace.
 *
 * IT IS A MODEL, NOT THE RUNNING APP: nothing here watched the app. See the module header of `legacyCadence.ts` for
 * every simplification, and the report's own caveats section. There is no ground truth for song sections, so
 * "alignment" is alignment to what the app's OWN detectors reported, with a random-phase control.
 *
 *   node --max-old-space-size=3072 ./node_modules/vitest/vitest.mjs run --config vitest.calibration.config.ts scripts/calibrate/baseline-scene-cadence.calib.ts
 *
 * Knobs: BASE_LIMIT=N      tracks decoded THIS run, deterministic shuffle (default 5; 0 = every track from the offset)
 *        BASE_OFFSET=n     skip the first n tracks of the shuffle (default 0) — run in chunks: 0, 5, 10, ...
 *        BASE_SEED=n       shuffle seed (default 1)
 *        BASE_REPORT_ONLY=1  decode nothing: re-run the legacy model over the cached traces (seconds)
 *        BASE_RECOMPUTE=1  re-decode tracks whose trace is already cached
 *
 * The report always aggregates EVERY trace present in the cache, not just this chunk.
 *
 * Output (gitignored, derived from non-commercial audio): corpus/structure/baseline-cadence.md + .json,
 * traces in corpus/structure/traces/.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { aggregateCadence, cadenceOfTrack, distStats, type CadenceAggregate, type TrackCadence } from '../../src/audio/eval/cadenceMetrics'
import { packTrace, unpackTrace, type PackedTrace } from '../../src/audio/eval/cadenceTrace'
import { simulateLegacy, type LegacyOptions } from '../../src/audio/eval/legacyCadence'
import { decodeMp3File } from './decode'
import { FULL_CHAIN_HOOKS, runTrack } from './features'
import { rng } from './stats'

const ROOT = resolve(__dirname, '../..')
const AUDIO_DIR = join(ROOT, 'corpus/audio')
const TEST_DIR = join(ROOT, 'testfolder')
const OUT_DIR = join(ROOT, 'corpus/structure')
const TRACE_DIR = join(OUT_DIR, 'traces')
const OUT_MD = join(OUT_DIR, 'baseline-cadence.md')
const OUT_JSON = join(OUT_DIR, 'baseline-cadence.json')

const LIMIT = process.env.BASE_LIMIT === undefined ? 5 : Math.max(0, Number(process.env.BASE_LIMIT) || 0)
const OFFSET = Math.max(0, Number(process.env.BASE_OFFSET) || 0)
const SEED = Number(process.env.BASE_SEED) || 1
const REPORT_ONLY = process.env.BASE_REPORT_ONLY === '1'
const RECOMPUTE = process.env.BASE_RECOMPUTE === '1'

interface Item {
  id: string
  path: string
  /** Genre tags (Jamendo) or the testfolder category. */
  tags: string[]
}

/** Coarse family for the per-genre glance; first match in this order. */
const FAMILIES: Array<[string, RegExp]> = [
  ['electronic/dance', /^(electronic|dance|house|edm|techno|trance|eurodance|club|dubstep|drumnbass|electronica|minimal|idm|electropop|synthpop)$/],
  ['rock/pop', /^(rock|pop|poprock|indie|alternativerock|metal|hard|punk|hardrock|popfolk|80s)$/],
  ['orchestral/soundtrack', /^(soundtrack|orchestral|classical|symphonic|medieval|newage|cinematic)$/],
  ['ambient/chill', /^(ambient|darkambient|downtempo|chillout|triphop|lounge)$/],
]
export function familyOf(tags: readonly string[]): string {
  for (const [name, re] of FAMILIES) if (tags.some((t) => re.test(t))) return name
  return 'other'
}

const clean = (s: string): string => s.replace(/\r/g, '').trim().toLowerCase()

function listItems(): Item[] {
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
      const tags = cat.startsWith('electronic')
        ? ['electronic']
        : cat.startsWith('rock-pop')
          ? ['rock']
          : cat.startsWith('ambient')
            ? ['ambient']
            : ['hiphop']
      items.push({ id: `test_${f.replace(/\.mp3$/i, '')}`, path: join(TEST_DIR, f), tags })
    }
  }
  return items
}

/** Deterministic shuffle (same shape as `structure-sanity.calib.ts`'s sample), so chunks tile the whole set. */
function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const idx = xs.map((_, i) => i)
  const r = rng(seed)
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[idx[i], idx[j]] = [idx[j], idx[i]]
  }
  return idx.map((i) => xs[i])
}

const f1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : 'n/a')
const f2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : 'n/a')
const pct = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : 'n/a')

const VARIANTS: Array<{ name: string; blurb: string; opts: LegacyOptions }> = [
  { name: 'default', blurb: 'today: armed next scene on, 32-beat dwell, grid trust from the trace', opts: {} },
  { name: 'armOff', blurb: '`?arm=off`: no armed scene, every director picks cold', opts: { armed: false } },
  { name: 'noDrops', blurb: 'sensitivity: the drop path removed, to isolate the dwell / first-opportunity cadence of every other trigger', opts: { drops: false } },
  { name: 'gridAlways', blurb: 'sensitivity: the downbeat wait always applies (grid always trusted)', opts: { gridTrust: 'always' } },
]

interface Analysed {
  item: Item
  family: string
  perVariant: Record<string, TrackCadence>
  frames: number
  stepped: { character: boolean; dropStateMachine: boolean }
}

function distRow(label: string, d: ReturnType<typeof distStats>, unit: string): string {
  return `| ${label} | ${d.n} | ${f1(d.median)} | ${f1(d.p10)} | ${f1(d.p90)} | ${f1(d.mean)} | ${f1(d.min)}..${f1(d.max)} ${unit} |`
}

function aggregateSection(name: string, blurb: string, a: CadenceAggregate): string[] {
  const L: string[] = []
  L.push(`### Variant \`${name}\`: ${blurb}`, '')
  L.push(`- **${a.tracks} tracks, ${f1(a.minutes)} min, ${a.commits} scene commits = ${f2(a.commitsPerMinute)} per minute** (one every ${f1(60 / a.commitsPerMinute)} s on average; ${a.startupCommits} of them are startup commits inside the first 5 s).`)
  L.push(`- Requests: ${a.requests.accepted} accepted, ${a.requests.refusedDwell} refused by the 32-beat dwell. Commits that released the ARMED scene: ${a.viaArmed} (${pct(a.viaArmed / a.commits)}). Share of playback time spent inside the dwell: ${pct(a.dwellShare)}.`)
  const dropCommits = a.triggers.filter((t) => t.trigger === 'drop' || t.trigger === 'armed:drop').reduce((s, t) => s + t.count, 0)
  L.push(
    `- Drop path (the only dwell bypass): ${a.align.drop.events} \`f.drop\` rising edges = ${f1(a.align.drop.events / (a.minutes / 60))} per hour (broadband ratio test + the breakdown/snap-back state machine); drop-triggered commits: ${dropCommits} (${pct(dropCommits / a.commits)}).`,
  )
  L.push('', '| interval between consecutive commits | n | median | p10 | p90 | mean | range |', '|---|---|---|---|---|---|---|')
  L.push(distRow('seconds', a.intervalSec, 's'))
  L.push(distRow('bars (beat counter / 4)', a.intervalBars, 'bars'))
  L.push(distRow('per-track MEDIAN interval', a.perTrackMedianSec, 's'))
  L.push('')
  L.push(
    `- Share of intervals inside **[4, 32] bars: ${pct(a.shareBars.in4to32)}** (below 4 bars: ${pct(a.shareBars.below4)}, above 32 bars: ${pct(a.shareBars.above32)}); inside [10, 30] s: ${pct(a.shareSec10to30)}.`,
  )
  L.push(`- Downbeat wait between request and commit: median ${f2(a.waitSec.median)} s, p90 ${f2(a.waitSec.p90)} s.`)
  L.push(
    `- **First opportunity after the dwell**: non-immediate commits land a median ${f1(a.slackBeats.median)} beats (p90 ${f1(a.slackBeats.p90)}) after the 32-beat dwell ended; ${pct(a.shareSlack.within4)} within 4 beats (one bar), ${pct(a.shareSlack.within8)} within 8, ${pct(a.shareSlack.within16)} within 16 (n=${a.slackBeats.n}).`,
    '',
  )
  L.push('**Which trigger produced each commit**', '', '| trigger | commits | share |', '|---|---|---|')
  for (const t of a.triggers) L.push(`| ${t.trigger} | ${t.count} | ${pct(t.share)} |`)
  L.push('')
  const k = a.kinds
  const tot = k.event + k.latched + k.level
  L.push(
    `- **Level-type** (stale timer / armed age / blind phrase fallback): **${pct(k.level / tot)}**; latched edges (mood/character carried past their edge, weak fast change waiting for a phrase edge): ${pct(k.latched / tot)}; **event-type** (a fresh detector edge on that frame): **${pct(k.event / tot)}**. Level + latched = ${pct((k.level + k.latched) / tot)}.`,
  )
  L.push('', '**Detector edges vs the dwell**', '', '| edge | total | arrived inside the dwell | led to a request | armed confirm | other trigger that frame | discarded by dwell | pending in flight | same beat | build hold | commit within 6 s |', '|---|---|---|---|---|---|---|---|---|---|---|')
  for (const key of ['sectionChange', 'boundary'] as const) {
    const e = a.edges[key]
    const o = e.outcomes
    L.push(
      `| ${key === 'sectionChange' ? 'f.sectionChange' : 'songSection.boundaryChanged'} | ${e.total} | ${e.inDwell} (${pct(e.shareInDwell)}) | ${o.requested} | ${o.armedConfirm} | ${o.otherTrigger} | ${o.dwell} | ${o.pending} | ${o.sameBeat} | ${o.buildHold} | ${e.commitWithin6s} (${pct(e.total ? e.commitWithin6s / e.total : NaN)}) |`,
    )
  }
  const n = a.nextCommitAfterDiscard
  const nTot = n.event + n.latched + n.level + n.none
  L.push('', `- Of the ${nTot} edges the dwell discarded, the NEXT scene change was level-type for ${pct(n.level / nTot)}, latched for ${pct(n.latched / nTot)}, event-type for ${pct(n.event / nTot)} (none followed: ${pct(n.none / nTot)}).`)
  L.push(`- ${a.commitsAfterDiscard.event + a.commitsAfterDiscard.latched + a.commitsAfterDiscard.level} of ${a.commits} commits had a dwell-discarded edge inside their preceding interval; of those, ${a.commitsAfterDiscard.level + a.commitsAfterDiscard.latched} were level/latched-type, landing a median ${f1(a.lagAfterDiscardSec.median)} s (p90 ${f1(a.lagAfterDiscardSec.p90)} s) after the last lost edge.`, '')
  L.push('**Alignment of commits to the detectors\' own events (real vs the random-phase control)**', '', '| detector event | events | median \\|commit - nearest\\| | within 2 s | within 4 s | follows an event by <= 6 s |', '|---|---|---|---|---|---|')
  for (const ty of ['sectionChange', 'boundary', 'analyser', 'drop', 'any'] as const) {
    const al = a.align[ty]
    L.push(
      `| ${ty} | ${al.events} | ${f1(al.medianAbsSec.real)} s (chance ${f1(al.medianAbsSec.chance)} s) | ${pct(al.within2s.real)} (chance ${pct(al.within2s.chance)}) | ${pct(al.within4s.real)} (chance ${pct(al.within4s.chance)}) | ${pct(al.causal6s.real)} (chance ${pct(al.causal6s.chance)}) |`,
    )
  }
  L.push('')
  return L
}

function buildReport(all: Analysed[], chunk: { done: number; failed: number }, elapsedSec: number): { md: string; json: unknown } {
  const byVariant: Record<string, CadenceAggregate> = {}
  for (const v of VARIANTS) byVariant[v.name] = aggregateCadence(all.map((t) => t.perVariant[v.name]))
  const families = [...new Set(all.map((t) => t.family))].sort()
  const byFamily: Record<string, CadenceAggregate> = {}
  for (const fam of families) byFamily[fam] = aggregateCadence(all.filter((t) => t.family === fam).map((t) => t.perVariant.default))

  const L: string[] = []
  L.push('# Baseline scene-change cadence (legacy trigger MODEL over real audio)', '')
  L.push(
    `Generated ${new Date().toISOString()} | ${all.length} traces analysed (this run decoded ${chunk.done}, ${chunk.failed} failed, ${(elapsedSec / 60).toFixed(1)} min) | BASE_LIMIT=${LIMIT || 'all'} BASE_OFFSET=${OFFSET} seed ${SEED}`,
    '',
  )
  L.push(
    '**This is a MODEL of the legacy trigger logic, not the running app.** Real audio is replayed through the current DSP chain (`runTrack`, no Essentia, as in the commercial build) including `SectionTracker`,',
    'and `src/audio/eval/legacyCadence.ts` replays the dwell / director / autopilot / armed-scene / commit arithmetic over the recorded detector outputs. Scene identity, picker pools, shader warm-up,',
    'the armed scene\'s fit checks, manual holds and DJ-cam/Limitless cutaways are NOT modelled (all of which can only make the real show change less often than modelled). There is no structure ground truth:',
    '"alignment" is to the app\'s own detectors, with a random-phase control (the same commit times circularly shifted).',
    '',
  )
  L.push('## Aggregate', '')
  for (const v of VARIANTS) L.push(...aggregateSection(v.name, v.blurb, byVariant[v.name]))

  L.push('## Per genre family (variant `default`)', '')
  L.push('| family | tracks | commits/min | median interval s | median bars | share in [4,32] bars | level-type | level+latched | sectionChange in dwell | within 4 s of any event (chance) |', '|---|---|---|---|---|---|---|---|---|---|')
  for (const fam of families) {
    const a = byFamily[fam]
    const k = a.kinds
    const tot = k.event + k.latched + k.level || 1
    L.push(
      `| ${fam} | ${a.tracks} | ${f2(a.commitsPerMinute)} | ${f1(a.intervalSec.median)} | ${f1(a.intervalBars.median)} | ${pct(a.shareBars.in4to32)} | ${pct(k.level / tot)} | ${pct((k.level + k.latched) / tot)} | ${pct(a.edges.sectionChange.shareInDwell)} | ${pct(a.align.any.within4s.real)} (${pct(a.align.any.within4s.chance)}) |`,
    )
  }
  L.push('')

  L.push('## Per track (variant `default`)', '')
  L.push('| id | family | dur s | bpm | commits | median int s | median bars | level | latched | event | sectionChange edges | in dwell | boundary edges |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const t of all) {
    const p = t.perVariant.default
    const d = distStats(p.intervalsSec)
    const db = distStats(p.intervalsBars)
    L.push(
      `| ${t.item.id} | ${t.family} | ${p.durationSec.toFixed(0)} | ${f1(p.medianBpm)} | ${p.commits} | ${f1(d.median)} | ${f1(db.median)} | ${p.kinds.level} | ${p.kinds.latched} | ${p.kinds.event} | ${p.edges.sectionChange.total} | ${p.edges.sectionChange.inDwell} | ${p.edges.boundary.total} |`,
    )
  }
  L.push('')
  L.push('## Caveats', '')
  L.push(
    '- Internal evaluation only. The Jamendo tracks are non-commercial research data; do not redistribute the audio or the traces.',
    '- Intervals in bars use the app\'s own beat counter / 4: on a track whose tempo is read at half or double time the bar length is wrong (seconds are not affected).',
    '- `f.sectionChange` and `boundaryChanged` are the detectors as they stand today; a noisy detector makes noisy "events", so a high alignment to them would not prove musical alignment either. Read the REAL-vs-CHANCE gap, not the absolute share.',
    '- The armed scene always "fits" in the model, `quality.tier <= 3` is assumed and the build one-shot always fires on a build\'s rising edge: armed and build commits are therefore upper bounds. Compare variant `armOff`.',
    '- The drop path dominates the `default` cadence, and it is the least validated input: `f.drop` has no ground truth (the plan flags its precision as unknown) and the breakdown/snap-back state machine\'s thresholds are documented as untuned. On a 33-track sample (every 3rd track) the broadband ratio test alone fires ~81 drops/hour and the state machine roughly triples that (~227/hour); `runTrack` only steps the state machine with `hooks.dropStateMachine`. Variant `noDrops` isolates everything else.',
    '- The offline harness has no Essentia: `f.danceability` / `f.moods*` are at their defaults, exactly as in the commercial build.',
    '',
  )

  const jsonAggregate = (a: CadenceAggregate) => a
  const json = {
    generated: new Date().toISOString(),
    tracks: all.length,
    knobs: { limit: LIMIT, offset: OFFSET, seed: SEED },
    variants: Object.fromEntries(VARIANTS.map((v) => [v.name, { blurb: v.blurb, options: v.opts, aggregate: jsonAggregate(byVariant[v.name]) }])),
    perFamily: byFamily,
    perTrack: all.map((t) => {
      const strip = (c: TrackCadence) => ({ ...c, align: undefined })
      return {
        id: t.item.id,
        family: t.family,
        tags: t.item.tags,
        frames: t.frames,
        stepped: t.stepped,
        default: strip(t.perVariant.default),
        armOff: strip(t.perVariant.armOff),
      }
    }),
  }
  return { md: L.join('\n') + '\n', json }
}

const items = listItems()

describe.skipIf(items.length === 0 && !existsSync(TRACE_DIR))('baseline scene-change cadence (legacy model)', () => {
  it(
    'decodes a chunk, caches traces, replays the legacy model over every cached trace and writes the report',
    async () => {
      const t0 = Date.now()
      mkdirSync(TRACE_DIR, { recursive: true })
      const chunk = (LIMIT ? shuffled(items, SEED).slice(OFFSET, OFFSET + LIMIT) : shuffled(items, SEED).slice(OFFSET))
      let done = 0
      let failed = 0
      if (!REPORT_ONLY) {
        for (let i = 0; i < chunk.length; i++) {
          const item = chunk[i]
          const cache = join(TRACE_DIR, `${item.id}.json`)
          if (existsSync(cache) && !RECOMPUTE) {
            console.log(`  cached ${item.id}`)
            continue
          }
          try {
            const ts = Date.now()
            const audio = await decodeMp3File(item.path)
            const run = runTrack(audio.pcm, audio.sampleRate, FULL_CHAIN_HOOKS)
            if (!run.trace) throw new Error('runTrack returned no trace')
            run.trace.meta.id = item.id
            writeFileSync(cache, JSON.stringify(packTrace(run.trace)))
            done++
            console.log(`  ${i + 1}/${chunk.length} ${item.id} ${run.trace.n} frames, ${((Date.now() - ts) / 1000).toFixed(0)}s`)
          } catch (e) {
            failed++
            console.log(`  skip ${item.id}: ${(e as Error).message}`)
          }
          ;(globalThis as { gc?: () => void }).gc?.()
        }
      }

      // Replay the model over EVERY cached trace (one at a time; a trace is ~1 MB).
      const byId = new Map(items.map((it) => [it.id, it]))
      const analysed: Analysed[] = []
      for (const name of readdirSync(TRACE_DIR).filter((n) => n.endsWith('.json')).sort()) {
        const id = name.replace(/\.json$/, '')
        const item = byId.get(id) ?? { id, path: '', tags: [] }
        const trace = unpackTrace(JSON.parse(readFileSync(join(TRACE_DIR, name), 'utf8')) as PackedTrace)
        const perVariant: Record<string, TrackCadence> = {}
        for (const v of VARIANTS) perVariant[v.name] = cadenceOfTrack(id, trace, simulateLegacy(trace, v.opts), { seed: SEED })
        analysed.push({
          item,
          family: familyOf(item.tags),
          perVariant,
          frames: trace.n,
          stepped: { character: trace.meta.characterStepped, dropStateMachine: trace.meta.dropStateMachine },
        })
      }
      expect(analysed.length).toBeGreaterThan(0)
      const { md, json } = buildReport(analysed, { done, failed }, (Date.now() - t0) / 1000)
      mkdirSync(OUT_DIR, { recursive: true })
      writeFileSync(OUT_MD, md)
      writeFileSync(OUT_JSON, JSON.stringify(json, null, 2))
      console.log(md)
      console.log(`wrote ${OUT_MD} (${analysed.length} traces; this run decoded ${done}, ${failed} failed)`)

      // Weak sanity only (this is a measurement, not a gate): the model must have produced scene changes.
      const total = analysed.reduce((s, t) => s + t.perVariant.default.commits, 0)
      expect(total).toBeGreaterThan(0)
    },
    60 * 60 * 1000,
  )
})
