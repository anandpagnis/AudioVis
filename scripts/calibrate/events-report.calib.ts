/**
 * EVENT-LAYER v2 REPORT (phase 2, `so-the-mood-analysis-lively-hickey.md`): replays the cached beat cells
 * (`events-cache.calib.ts`) through `EventLayer` with the DEFAULT (or an overridden) configuration and writes
 * `corpus/structure/events-v2.md`:
 *
 *  1. SYNTHETIC songs of known structure (seed 1, plus seeds 2-3 as a generalisation check): recall within +-1 bar,
 *     false alarms per minute, scene-class events near fills / gain steps / silence gaps / the gradual morph, lag,
 *     next to the baseline detectors' numbers from `synth-baseline.json` (`synth-structure.calib.ts`).
 *  2. REAL tracks (the corpus, first 240 s each, NO structure ground truth): scene-class events per minute per genre
 *     family, the interval between events, the share whose boundary already sat on the anchored bar grid (against the
 *     25 % a random phase would give), `sim` returns, the score / strength distribution the calibration is anchored
 *     on, the per-track channel noise the sigma floors were set from, and the rate as a function of the score floor.
 *
 * It is a REPLAY of recorded cells: it costs seconds. Re-run `events-cache.calib.ts` first if the feature front end
 * (StructureAnalyzer, the raw tap) changed.
 *
 *   node --max-old-space-size=3072 ./node_modules/vitest/vitest.mjs run --config vitest.calibration.config.ts scripts/calibrate/events-report.calib.ts
 *
 * Knobs: EV_CFG='{"scorer":{"k":3}}'  EventLayerConfig overrides (a tuning experiment; the report says so)
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { copyEvent, medianLag, replayCells, scoreEventStream, type StreamScore } from '../../src/audio/eval/eventReplay'
import { percentile } from '../../src/audio/eval/structureMetrics'
import { EventLayer, type EventLayerConfig } from '../../src/audio/events/EventLayer'
import type { SectionEvent } from '../../src/audio/events/types'
import type { CachedRun } from './events-cache.calib'

const ROOT = resolve(__dirname, '../..')
const CELL_DIR = join(ROOT, 'corpus/structure/events-cells')
const OUT_MD = join(ROOT, 'corpus/structure/events-v2.md')
const BASELINE_JSON = join(ROOT, 'corpus/structure/synth-baseline.json')
const CFG: Partial<EventLayerConfig> = process.env.EV_CFG ? (JSON.parse(process.env.EV_CFG) as Partial<EventLayerConfig>) : {}

const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '-')
const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '-')
const pct = (n: number, d: number) => (d > 0 ? `${((100 * n) / d).toFixed(0)}% (${n}/${d})` : '-')

const FAMILIES: Array<[string, RegExp]> = [
  ['electronic/dance', /^(electronic|dance|house|edm|techno|trance|eurodance|club|dubstep|drumnbass|electronica|minimal|idm|electropop|synthpop)$/],
  ['rock/pop', /^(rock|pop|poprock|indie|alternativerock|metal|hard|punk|hardrock|popfolk|80s)$/],
  ['orchestral/soundtrack', /^(soundtrack|orchestral|classical|symphonic|medieval|newage|cinematic)$/],
  ['ambient/chill', /^(ambient|darkambient|downtempo|chillout|triphop|lounge)$/],
]
const familyOf = (tags: readonly string[]): string => {
  for (const [name, re] of FAMILIES) if (tags.some((t) => re.test(t))) return name
  return 'other'
}

function load(): CachedRun[] {
  if (!existsSync(CELL_DIR)) return []
  return readdirSync(CELL_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(CELL_DIR, f), 'utf8')) as CachedRun)
}

const isMorph = (r: CachedRun) => r.id.includes('gradualMorph')

interface Agg {
  nTruth: number
  hits: number
  hitsCausal: number
  fa: number
  minutes: number
  negNear: number
  negTotal: number
  lags: number[]
  nDet: number
  fills: number
  gains: number
}

function aggregate(scores: Array<{ run: CachedRun; sc: StreamScore }>): Agg {
  const a: Agg = { nTruth: 0, hits: 0, hitsCausal: 0, fa: 0, minutes: 0, negNear: 0, negTotal: 0, lags: [], nDet: 0, fills: 0, gains: 0 }
  for (const { run, sc } of scores) {
    a.nTruth += sc.nTruth
    a.hits += sc.hits
    a.hitsCausal += sc.hitsCausal
    a.fa += sc.falseAlarms
    a.minutes += run.durationSec / 60
    a.negNear += sc.negNear
    a.negTotal += sc.negTotal
    a.lags.push(...sc.lags)
    a.nDet += sc.nDet
    a.fills += sc.fills
    a.gains += sc.gains
  }
  return a
}

describe('event layer v2 report', () => {
  it('writes corpus/structure/events-v2.md', () => {
    const runs = load()
    const synth = runs.filter((r) => r.kind === 'synth')
    const real = runs.filter((r) => r.kind === 'real')
    if (synth.length === 0 && real.length === 0) {
      console.log('no cached cells: run events-cache.calib.ts first')
      return
    }
    const L: string[] = []
    L.push('# Live event layer v2 (`?events=v2`): synthetic acceptance and real-track rates', '')
    L.push(
      `Generated ${new Date().toISOString()} | ${synth.length} synthetic runs, ${real.length} real tracks | config overrides: ${Object.keys(CFG).length ? '`' + JSON.stringify(CFG) + '`' : 'none (defaults)'}`,
      '',
    )

    // ---------------------------------------------------------------------------------------------- synthetic
    const seeds = new Map<string, Array<{ run: CachedRun; sc: StreamScore; events: SectionEvent[] }>>()
    for (const run of synth) {
      const seed = /_s(\d+)$/.exec(run.id)?.[1] ?? '1'
      const events = replayCells(run.cells, CFG)
      const sc = scoreEventStream(run.truth, events, run.bpm)
      const list = seeds.get(seed) ?? []
      list.push({ run, sc, events })
      seeds.set(seed, list)
    }
    const json: Record<string, unknown> = {}
    if (synth.length) {
      L.push('## 1. Synthetic songs of known structure', '')
      L.push(
        'Truth: `src/audio/eval/synthSong.ts` (25 positive changes over 12 stimuli, 22 negatives). Scene-class = `change` + `breakdown`. A HIT is a',
        'boundary the event CLAIMS within +-1 bar of the truth (one-to-one); lag = confirmed-at minus truth for matches inside [-1, +4] bars.',
        'The gradual morph\'s END is a truth positive that no causal detector is expected to time (excluded from the acceptance recall).',
        '',
      )
      const seed1 = seeds.get('1') ?? []
      const rows = seed1.map((s) => s)
      L.push('### Seed 1 per stimulus', '')
      L.push('| stimulus | bpm | positives | hits +-1 bar | false alarms | scene events near negatives | fills | gains | lag s | events (type@claimed s) |')
      L.push('|---|---|---|---|---|---|---|---|---|---|')
      for (const { run, sc, events } of rows) {
        const list = events
          .map((e) => `${e.type[0]}${e.type === 'change' ? '' : e.type.slice(1, 3)}@${(e.boundaryTime).toFixed(1)}`)
          .join(' ')
        const lags = sc.lags.map((l) => l.toFixed(1)).join(', ')
        L.push(`| ${run.id.replace(/^synth_/, '')} | ${f1(run.bpm)} | ${sc.nTruth} | ${sc.hits} | ${sc.falseAlarms} | ${sc.negNear}/${sc.negTotal} | ${sc.fills} | ${sc.gains} | ${lags || '-'} | ${list || '-'} |`)
      }
      L.push('')
      L.push('### Aggregate, v2 against the baseline detectors (seed 1)', '')
      const base = existsSync(BASELINE_JSON) ? (JSON.parse(readFileSync(BASELINE_JSON, 'utf8')) as { synthetic?: Record<string, { nTruth: number; hitsStrict: number; hitsCausal: number; faPerMinStrict: number; faPerMinCausal: number; negNear: number; negTotal: number; lag: { median: number } }> }) : null
      const a1 = aggregate(seed1)
      const a1ex = aggregate(seed1.filter((s) => !isMorph(s.run)))
      L.push('| detector | positives | recall +-1 bar | recall causal | FA/min (+-1 bar) | detections near negatives | median lag s |')
      L.push('|---|---|---|---|---|---|---|')
      if (base?.synthetic) {
        for (const id of ['sectionChange', 'structure.boundaries', 'songSection.boundary']) {
          const b = base.synthetic[id]
          if (b) L.push(`| ${id} (baseline) | ${b.nTruth} | ${pct(b.hitsStrict, b.nTruth)} | ${pct(b.hitsCausal, b.nTruth)} | ${f2(b.faPerMinStrict)} | ${b.negNear}/${b.negTotal} | ${f1(b.lag.median)} |`)
        }
      }
      L.push(`| **events.v2 (this layer)**, all positives | ${a1.nTruth} | ${pct(a1.hits, a1.nTruth)} | ${pct(a1.hitsCausal, a1.nTruth)} | ${f2(a1.fa / a1.minutes)} | ${a1.negNear}/${a1.negTotal} | ${f1(percentile(a1.lags, 0.5))} |`)
      L.push(`| **events.v2**, excluding the gradual morph end | ${a1ex.nTruth} | ${pct(a1ex.hits, a1ex.nTruth)} | ${pct(a1ex.hitsCausal, a1ex.nTruth)} | ${f2(a1ex.fa / a1ex.minutes)} | ${a1ex.negNear}/${a1ex.negTotal} | ${f1(percentile(a1ex.lags, 0.5))} |`)
      L.push('')
      // acceptance items
      const get = (name: string, list = seed1) => list.find((s) => s.run.id.includes(name))
      const eq = get('verseChorusEqualLoudness')
      const key = get('keyChangeEqualLoudness')
      const morph = get('gradualMorph16')
      const negOnly = ['fillsOnly', 'gainStep', 'silenceGap'].map((n) => get(n))
      L.push('### Acceptance items (seed 1)', '')
      L.push(`- equal-loudness verse->chorus: ${eq ? `${eq.sc.hits}/${eq.sc.nTruth}` : '-'}; key change at equal loudness: ${key ? `${key.sc.hits}/${key.sc.nTruth}` : '-'} (baseline: 0/2 for every detector on both)`)
      L.push(`- scene-class events on the fills-only, +-6 dB gain-step and silence-gap stimuli: ${negOnly.map((s) => s?.sc.nDet ?? 0).join(' / ')} (target 0 / 0 / 0); typed \`fill\` ${negOnly[0]?.sc.fills ?? '-'}, \`gain\` ${negOnly[1]?.sc.gains ?? '-'}`)
      L.push(`- gradual morph: ${morph ? morph.sc.nDet : '-'} scene-class events (target <= 1)`)
      L.push(`- median lag ${f1(medianLag(seed1.map((s) => s.sc)))} s (target <= 3.5 s); FA/min ${f2(a1.fa / a1.minutes)} against the baseline's 2.11 (\`f.sectionChange\`) and 1.70 (analyser)`)
      L.push('')
      // per seed
      L.push('### Generalisation over synthesis seeds (same specs, other random phases / noise / melodies)', '')
      L.push('| seed | recall +-1 bar (excl. morph end) | FA/min | near negatives | median lag s |')
      L.push('|---|---|---|---|---|')
      for (const [seed, list] of [...seeds.entries()].sort()) {
        const ex = aggregate(list.filter((s) => !isMorph(s.run)))
        const all = aggregate(list)
        L.push(`| ${seed} | ${pct(ex.hits, ex.nTruth)} | ${f2(all.fa / all.minutes)} | ${all.negNear}/${all.negTotal} | ${f1(percentile(all.lags, 0.5))} |`)
      }
      L.push('')
      // by truth type
      const byType = new Map<string, { n: number; hit: number }>()
      for (const { sc } of seed1) for (const e of sc.perEvent) {
        const t = byType.get(e.type) ?? { n: 0, hit: 0 }
        t.n++
        if (e.hit) t.hit++
        byType.set(e.type, t)
      }
      L.push('Recall by truth type (seed 1): ' + [...byType.entries()].map(([t, v]) => `${t} ${v.hit}/${v.n}`).join(', '), '')
      json.synthetic = { seed1: { ...a1ex, lags: undefined }, seeds: [...seeds.keys()] }
    }

    // ---------------------------------------------------------------------------------------------- real
    if (real.length) {
      L.push('## 2. Real tracks (no ground truth)', '')
      L.push(`${real.length} tracks (MTG-Jamendo corpus + \`testfolder/\`), the first ${f1(percentile(real.map((r) => r.durationSec), 0.5))} s of each (median), replayed with the beat cells the live engine would have produced.`, '')
      const fam: Record<string, { minutes: number; scene: number; fill: number; gain: number; tracks: number; rates: number[] }> = {}
      const sAll: number[] = []
      const strengths: number[] = []
      const lagBeats: number[] = []
      const intervals: number[] = []
      let gridReady = 0
      let gridOn = 0
      let nScene = 0
      let nSim = 0
      const chSigma: number[][] = Array.from({ length: 8 }, () => [])
      const cellSpans: number[] = []
      for (const run of real) {
        const layer = new EventLayer(CFG)
        const ser: number[][] = Array.from({ length: 8 }, () => [])
        layer.scorer.probe = (_st, d) => {
          for (let k = 0; k < 8; k++) ser[k].push(Math.abs(d[k]))
        }
        const evs: SectionEvent[] = []
        for (const r of run.cells) {
          for (const e of layer.push(r.cell, r.beat, r.time, r.bpm, { locked: r.locked, offset: r.offset })) {
            evs.push(copyEvent(e))
            if (e.type === 'change' || e.type === 'breakdown') {
              sAll.push(layer.lastEmit.s)
              if (layer.lastEmit.gridReady) {
                gridReady++
                if (layer.lastEmit.rawOnGrid) gridOn++
              }
            }
          }
        }
        const minutes = run.durationSec / 60
        const F = familyOf(run.tags)
        const b = (fam[F] ??= { minutes: 0, scene: 0, fill: 0, gain: 0, tracks: 0, rates: [] })
        const scene = evs.filter((e) => e.type === 'change' || e.type === 'breakdown')
        b.minutes += minutes
        b.scene += scene.length
        b.fill += evs.filter((e) => e.type === 'fill').length
        b.gain += evs.filter((e) => e.type === 'gain').length
        b.tracks++
        b.rates.push(scene.length / minutes)
        nScene += scene.length
        for (const e of scene) {
          strengths.push(e.strength)
          lagBeats.push(e.detectedAtBeat - e.boundaryBeat)
          if (e.sim) nSim++
        }
        for (let i = 1; i < scene.length; i++) intervals.push(scene[i].boundaryTime - scene[i - 1].boundaryTime)
        for (let k = 0; k < 8; k++) {
          const a = ser[k].slice(8)
          if (a.length > 30) {
            const m = percentile(a, 0.5)
            chSigma[k].push(1.4826 * percentile(a.map((x) => Math.abs(x - m)), 0.5))
          }
        }
        if (run.cells.length > 1) cellSpans.push((run.cells[run.cells.length - 1].time - run.cells[0].time) / (run.cells.length - 1))
      }
      L.push('### Scene-class events per minute, by genre family', '')
      L.push('| family | tracks | minutes | scene events / min | per-track median (p90) | fills / min | gains / min |')
      L.push('|---|---|---|---|---|---|---|')
      let totMin = 0
      let totScene = 0
      for (const [name, v] of Object.entries(fam).sort()) {
        totMin += v.minutes
        totScene += v.scene
        L.push(`| ${name} | ${v.tracks} | ${f1(v.minutes)} | ${f2(v.scene / v.minutes)} | ${f2(percentile(v.rates, 0.5))} (${f2(percentile(v.rates, 0.9))}) | ${f2(v.fill / v.minutes)} | ${f2(v.gain / v.minutes)} |`)
      }
      L.push(`| **all** | ${real.length} | ${f1(totMin)} | **${f2(totScene / totMin)}** | | | |`, '')
      L.push(`Target from the plan: <= ~4 scene-class events/min. Legacy references on the same corpus: \`f.sectionChange\` 3.8/min, analyser \`boundaryChanged\` 4.0/min (\`baseline-cadence.md\`).`, '')
      L.push('### Where the events fall', '')
      L.push(`- interval between consecutive scene events: median ${f1(percentile(intervals, 0.5))} s, p10 ${f1(percentile(intervals, 0.1))} s, p90 ${f1(percentile(intervals, 0.9))} s`)
      L.push(`- confirmation lag: median ${f1(percentile(lagBeats, 0.5))} beats (peak confirmed 2 beats after it, the window is 4 beats: ~6-7 beats by design)`)
      L.push(`- bar grid: ${gridReady}/${nScene} events had a confident anchored grid BEFORE they voted; of those ${pct(gridOn, gridReady)} already sat on its bar line (within half a beat, before snapping). A random phase gives ~25 %: the excess is the evidence that real changes fall on bars, and it is modest because the beat index is only a beat-tracker count.`)
      L.push(`- \`sim\` (return to earlier material) attached to ${pct(nSim, nScene)} of scene events`)
      L.push(`- calibrated strength of accepted events: p10 ${f2(percentile(strengths, 0.1))}, median ${f2(percentile(strengths, 0.5))}, p90 ${f2(percentile(strengths, 0.9))}`)
      L.push(`- whitened score s of accepted events (what the strength map is anchored on): p10 ${f1(percentile(sAll, 0.1))}, p25 ${f1(percentile(sAll, 0.25))}, p50 ${f1(percentile(sAll, 0.5))}, p75 ${f1(percentile(sAll, 0.75))}, p90 ${f1(percentile(sAll, 0.9))}, p99 ${f1(percentile(sAll, 0.99))}`, '')
      L.push('### Per-track channel noise (what the sigma floors are set from)', '')
      L.push('1.4826 x MAD of |d| per track, percentiles over tracks. The scorer\'s per-channel floor sits near the p05-p10 column.', '')
      L.push('| channel | p05 | p10 | p25 | p50 | p75 |', '|---|---|---|---|---|---|')
      const names = ['level dB', 'low dB', 'mid dB', 'high dB', 'timbre 1-cos', 'harmony 1-cos', 'rhythm', 'texture']
      for (let k = 0; k < 8; k++) L.push(`| ${names[k]} | ${[0.05, 0.1, 0.25, 0.5, 0.75].map((p) => percentile(chSigma[k], p).toPrecision(3)).join(' | ')} |`)
      L.push('')
      L.push('### Rate against the absolute score floor (k = 1, so the floor binds)', '')
      L.push('| absFloor | scene events / min |', '|---|---|')
      for (const af of [2, 3, 4, 6, 8, 12]) {
        let n = 0
        let m = 0
        for (const run of real) {
          const evs = replayCells(run.cells, { ...CFG, scorer: { ...(CFG.scorer ?? {}), absFloor: af, k: 1 } })
          n += evs.filter((e) => e.type === 'change' || e.type === 'breakdown').length
          m += run.durationSec / 60
        }
        L.push(`| ${af} | ${f2(n / m)} |`)
      }
      L.push('')
      json.real = { tracks: real.length, sceneEventsPerMin: totScene / totMin }
    }

    // ---------------------------------------------------------------------------------------------- ablations
    const seed1Runs = synth // all seeds pooled: 3 x 24 positives
    if (seed1Runs.length && real.length && process.env.EV_ABLATE !== '0') {
      L.push('## 3. What each design decision is worth (ablations)', '')
      L.push(
        'Each row changes ONE thing against the defaults and re-scores the synthetic suite (seeds 1-3 pooled) and re-counts the real-track event rate (same cached cells).',
        'The synthetic columns exclude the gradual-morph end (3 x 24 = 72 positives). "raw tap off" strips `BeatCell.raw`, i.e. the level channel falls back to the',
        'normalised front-end loudness, which is what the engine had before the tap.',
        '',
      )
      L.push('| variant | recall +-1 bar | FA/min | scene events near negatives | median lag s | real events/min |', '|---|---|---|---|---|---|')
      const variants: Array<[string, Partial<EventLayerConfig>, boolean]> = [
        ['**defaults**', {}, false],
        ['raw dB tap off', {}, true],
        ['harmony window 4 beats (no slow window)', { scorer: { newBeatsSlow: 4 } }, false],
        ['no change-point refinement', { scorer: { refineRange: 0 } }, false],
        ['no shadow: statistics include the decay tails', { scorer: { shadowBeats: 0 } }, false],
        ['peakHalf 1 (confirm 1 beat after the peak)', { scorer: { peakHalf: 1 } }, false],
        ['peakHalf 3', { scorer: { peakHalf: 3 } }, false],
        ['N = 3, M = 12', { scorer: { newBeats: 3, oldBeats: 12 } }, false],
        ['N = 6, M = 24', { scorer: { newBeats: 6, oldBeats: 24 } }, false],
        ['equal channel weights', { scorer: { weights: [1, 1, 1, 1, 1, 1, 1, 1] } }, false],
        ['k = 2.5', { scorer: { k: 2.5 } }, false],
        ['k = 5', { scorer: { k: 5 } }, false],
        ['absFloor 3', { scorer: { absFloor: 3 } }, false],
        ['absFloor 5', { scorer: { absFloor: 5 } }, false],
        ['fillPersist 0.5 (was 0.7)', { fillPersist: 0.5 }, false],
      ]
      for (const [name, over, stripRaw] of variants) {
        const cfg: Partial<EventLayerConfig> = { ...CFG, ...over, scorer: { ...(CFG.scorer ?? {}), ...(over.scorer ?? {}) } }
        const rows = seed1Runs.filter((r) => !isMorph(r)).map((run) => {
          const cells = stripRaw ? run.cells.map((c) => ({ ...c, cell: { ...c.cell, raw: undefined } })) : run.cells
          return { run, sc: scoreEventStream(run.truth, replayCells(cells, cfg), run.bpm) }
        })
        const a = aggregate(rows)
        let n = 0
        let m = 0
        for (const run of real) {
          const cells = stripRaw ? run.cells.map((c) => ({ ...c, cell: { ...c.cell, raw: undefined } })) : run.cells
          n += replayCells(cells, cfg).filter((e) => e.type === 'change' || e.type === 'breakdown').length
          m += run.durationSec / 60
        }
        L.push(`| ${name} | ${pct(a.hits, a.nTruth)} | ${f2(a.fa / a.minutes)} | ${a.negNear}/${a.negTotal} | ${f1(percentile(a.lags, 0.5))} | ${f2(n / m)} |`)
      }
      L.push('')
    }

    L.push('## Caveats', '')
    L.push(
      '- The synthetic songs are clean, bar-aligned, exactly repeating and free of vocals/reverb: they FLATTER this detector (the plan says so too). They set a necessary bar. The real-track section has no ground truth: rates are not precision.',
      '- Recall is scored against the synthetic truth list, which annotates only the designed changes; a legitimate musical change the stimulus does not list (the kick dropout at the end of a build) counts as a false alarm, so FA/min is pessimistic.',
      '- The drumless `slowAmbient` stimulus (erratic beat tracker, harmony/filter-only changes whose per-loop variation is as large as the change) is NOT detected: 0/3 in every seed.',
      '- The tap logs (`?structurelog`, `structureLogToTruth.ts`) are what turn the real-track rates into precision and recall. In `?events=legacy` mode v2 events are recorded as `shadow` `sectionEvent` records for exactly this.',
      '',
    )
    writeFileSync(OUT_MD, L.join('\n') + '\n')
    writeFileSync(OUT_MD.replace(/\.md$/, '.json'), JSON.stringify(json, null, 2))
    console.log(L.slice(0, 60).join('\n'))
    expect(L.length).toBeGreaterThan(10)
  })
})
