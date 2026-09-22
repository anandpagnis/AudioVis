/**
 * Acceptance gates for the timbre descriptors (`src/audio/TimbreDescriptors.ts`: harsh / busy / sparse).
 * Replays them over the per-clip feature caches, with no audio decoding, so it takes seconds:
 *   corpus/emotion/cache       683 human-rated PMEmo clips (folds tune/test)
 *   corpus/emotion/cache-pool  184 unlabelled tracks (Jamendo + testfolder + PMEmo fold 9), the population the tables are built from
 * and reports the gates from the mood-look plan (P1):
 *   (i)   spread:      corpus IQR of each descriptor >= 0.30
 *   (ii)  independence: |Spearman r| with the character estimator's arousal <= 0.70 for harsh and busy
 *   (iii) meaning:     on the Gemini-labelled Jamendo/testfolder tracks, harsh is higher for aggressive/tense/
 *                      brooding/driving than for serene/tender/dreamy (mean difference, Mann-Whitney AUC, eta squared)
 *   (iv)  sanity:      Spearman rho with the PMEmo human arousal and valence (reported, not a gate)
 *
 *   npm run eval:descriptors          (needs `npm run calibrate:timbre` once, or the committed tables)
 *
 * Output: corpus/emotion/descriptors-report.md (gitignored) and a PASS/FAIL line per gate on the console.
 * A failing gate never fails the run: it is a finding to act on, not a test.
 *
 * DISCIPLINE. The gate thresholds below were fixed before the first run. Formula adjustments were chosen on
 * gates (i) and (ii), which use no labels, on the tune fold and the pool. Gate (iii) (Gemini) and the human ratings
 * were reported, not optimised against, BUT adjustment 2 was tried after adjustment 1 failed (iii), so its (iii)
 * pass is optimistic (see HISTORY). n is small, Gemini labels are LLM pre-labels not ground truth, and the 98
 * Gemini tracks are inside the population the tables were built from (a monotone, label-free normalisation, so
 * only a mild in-sample effect). INTERNAL EVALUATION ONLY.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TimbreDescriptors, TIMBRE_TAU_SEC } from '../../src/audio/TimbreDescriptors'
import { TIMBRE_CALIBRATION } from '../../src/audio/timbreQuantiles'
import { KEY_WARMUP_SEC, REPLAY_STRIDE, WARMUP_SEC, framesFromCache, replayDimensions, type FeatureCache } from './emotion'
import type { FrameSample } from './features'
import { bootstrapCI, etaSquared, mean, rng, spearman } from './stats'

const ROOT = resolve(__dirname, '../..')
const CACHE = join(ROOT, 'corpus/emotion/cache')
const POOL = join(ROOT, 'corpus/emotion/cache-pool')
const LABELS = join(ROOT, 'corpus/labels/gemini')
const OUT = join(ROOT, 'corpus/emotion/descriptors-report.md')

// --- Gate thresholds (fixed in advance) ---
const IQR_MIN = 0.3
const AROUSAL_R_MAX = 0.7
/** Gate (iii): hard-mood tracks must beat soft-mood tracks by at least this much on average, and by AUC. */
const GEMINI_DIFF_MIN = 0.1
const GEMINI_AUC_MIN = 0.65
const HARD_MOODS = ['aggressive', 'tense', 'brooding', 'driving']
const HARD_STRICT = ['aggressive', 'tense', 'brooding']
const SOFT_MOODS = ['serene', 'tender', 'dreamy']

const DESCRIPTORS = ['harsh', 'busy', 'sparse'] as const
type Desc = (typeof DESCRIPTORS)[number]

interface Clip {
  id: string
  set: 'human' | 'pool'
  fold: 'tune' | 'test' | 'pool'
  humanValence: number
  humanArousal: number
  charArousal: number
  charValence: number
  charTension: number
  d: Record<Desc, number>
  poolFile: string
}

interface GeminiRec {
  trackId: string
  file: string
  status: string
  model: string
  label: { primaryMood: string } | null
}

// ---------------------------------------------------------------- helpers
function quantile(xs: readonly number[], q: number): number {
  if (!xs.length) return NaN
  const s = Float64Array.from(xs).sort()
  const pos = q * (s.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.min(s.length - 1, lo + 1)
  return s[lo] + (s[hi] - s[lo]) * (pos - lo)
}
const iqr = (xs: readonly number[]) => quantile(xs, 0.75) - quantile(xs, 0.25)

/** Mann-Whitney AUC: P(random 'high' scores above a random 'low'); 0.5 = no signal. */
function auc(high: readonly number[], low: readonly number[]): number {
  if (!high.length || !low.length) return NaN
  let w = 0
  for (const h of high) for (const l of low) w += h > l ? 1 : h === l ? 0.5 : 0
  return w / (high.length * low.length)
}

function shuffle<T>(xs: T[], r: () => number): void {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[xs[i], xs[j]] = [xs[j], xs[i]]
  }
}

interface Separation {
  nHigh: number
  nLow: number
  diff: number
  auc: number
  aucLo: number
  aucHi: number
  /** One-sided permutation p: chance of an AUC at least this large if the labels were unrelated. */
  p: number
}

function separation(high: readonly number[], low: readonly number[], seed = 21): Separation {
  const obs = auc(high, low)
  const r = rng(seed)
  // Bootstrap CI (resample each group).
  const boots: number[] = []
  for (let k = 0; k < 1000; k++) {
    const h = high.map(() => high[Math.floor(r() * high.length)])
    const l = low.map(() => low[Math.floor(r() * low.length)])
    boots.push(auc(h, l))
  }
  boots.sort((a, b) => a - b)
  // Permutation test.
  const all = [...high, ...low]
  let ge = 0
  const PERMS = 4000
  for (let k = 0; k < PERMS; k++) {
    shuffle(all, r)
    if (auc(all.slice(0, high.length), all.slice(high.length)) >= obs - 1e-12) ge++
  }
  return {
    nHigh: high.length,
    nLow: low.length,
    diff: mean(high) - mean(low),
    auc: obs,
    aucLo: boots[Math.floor(boots.length * 0.025)],
    aucHi: boots[Math.min(boots.length - 1, Math.floor(boots.length * 0.975))],
    p: (ge + 1) / (PERMS + 1),
  }
}

/** Replays the descriptors over one clip: mean read after warm-up, plus optional per-frame sink for pooled spread. */
function replayTimbre(frames: readonly FrameSample[], sink?: (d: Record<Desc, number>) => void): Record<Desc, number> | null {
  const t = new TimbreDescriptors()
  const dt = REPLAY_STRIDE / 60
  const sum = { harsh: 0, busy: 0, sparse: 0 }
  let n = 0
  const tmp: Record<Desc, number> = { harsh: 0, busy: 0, sparse: 0 }
  for (const f of frames) {
    if (f.t < WARMUP_SEC) continue
    t.update(f, dt)
    if (f.t < KEY_WARMUP_SEC || f.silence) continue
    const r = t.read()
    sum.harsh += r.harsh
    sum.busy += r.busy
    sum.sparse += r.sparse
    n++
    if (sink) {
      tmp.harsh = r.harsh
      tmp.busy = r.busy
      tmp.sparse = r.sparse
      sink(tmp)
    }
  }
  return n >= 5 ? { harsh: sum.harsh / n, busy: sum.busy / n, sparse: sum.sparse / n } : null
}

// ---------------------------------------------------------------- data
const frameVals: Record<Desc, number[]> = { harsh: [], busy: [], sparse: [] }
let frameCounter = 0
const sinkFrames = (d: Record<Desc, number>) => {
  if ((frameCounter++ & 1) === 0) for (const k of DESCRIPTORS) frameVals[k].push(d[k])
}

function loadClips(): Clip[] {
  const clips: Clip[] = []
  const add = (id: string, set: Clip['set'], fold: Clip['fold'], hv: number, ha: number, cache: FeatureCache, poolFile: string) => {
    const frames = framesFromCache(cache)
    const dims = replayDimensions(frames, 1)
    const d = replayTimbre(frames, sinkFrames)
    if (!dims || !d) return
    clips.push({ id, set, fold, humanValence: hv, humanArousal: ha, charArousal: dims.arousal, charValence: dims.valence, charTension: dims.tension, d, poolFile })
  }
  if (existsSync(CACHE)) {
    for (const f of readdirSync(CACHE).filter((n) => n.endsWith('.json'))) {
      const j = JSON.parse(readFileSync(join(CACHE, f), 'utf8'))
      if (j.fold === 'pool') continue
      add(String(j.id), 'human', j.fold, j.valence01, j.arousal01, j.cache as FeatureCache, '')
    }
  }
  if (existsSync(POOL)) {
    for (const f of readdirSync(POOL).filter((n) => n.endsWith('.json'))) {
      add(f, 'pool', 'pool', NaN, NaN, JSON.parse(readFileSync(join(POOL, f), 'utf8')) as FeatureCache, f)
    }
  }
  return clips
}

function loadGemini(): Map<string, string> {
  const byPoolFile = new Map<string, string>()
  if (!existsSync(LABELS)) return byPoolFile
  for (const f of readdirSync(LABELS).filter((n) => /^jamendo_.*\.json$/.test(n))) {
    const rec = JSON.parse(readFileSync(join(LABELS, f), 'utf8')) as GeminiRec
    if (rec.status !== 'ok' || !rec.label) continue
    byPoolFile.set(`${basename(dirname(rec.file))}__${basename(rec.file)}.json`, rec.label.primaryMood)
  }
  return byPoolFile
}

const clips = loadClips()
const gemini = loadGemini()

const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : 'n/a')
const f3 = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : 'n/a')
const sgn = (v: number, d = 2) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(d) : 'n/a')
const verdict = (ok: boolean) => (ok ? 'PASS' : 'FAIL')

/**
 * Adjustment log, kept here so the report always carries it. The numbers are from real runs of this script on
 * the corpus caches (2026-09-21), copied by hand; they cannot be regenerated without reverting the formula.
 * Decision rule, fixed before adjustment 2 was run: adopt an adjustment if it passes the label-free gates (i) and
 * (ii); (iii) is reported, not optimised. Even so adjustment 2 was chosen after seeing that adjustment 1 failed
 * (iii), so its (iii) pass is optimistic.
 */
const HISTORY: string[] = [
  '| version | formula | (i) IQR harsh / busy / sparse | (ii) rho with arousal harsh / busy (tune, test, pool for harsh) | (iii) harsh diff, AUC (strict AUC) |',
  '|---|---|---|---|---|',
  '| 0 plan | harsh = mean(flatness, roughness, rolloff, flux); busy = mean(flux, 1-abs(mode strength), rolloff) | 0.362 / 0.315 / 0.315 | +0.90 (0.88, 0.91, 0.91) FAIL / +0.70 (pool 0.78) FAIL | +0.18, 0.69 (0.47) |',
  '| 1 dedupe | harsh = 0.5 roughness + 0.25 flatness + 0.25 rolloff; busy = mean(flux, 1-abs(mode strength)) | 0.394 / 0.309 / 0.301 | +0.67 (0.61, 0.69, 0.70) PASS / +0.27 PASS | +0.11, 0.62 (0.33) FAIL |',
  '| 2 current | harsh = mean(roughness, 1 - tonalness); busy unchanged | 0.361 / 0.309 / 0.301 | +0.46 (0.37, 0.46, 0.54) PASS / +0.27 PASS | +0.18, 0.69 (0.56) PASS |',
  '',
  'Why: flatness, rolloff and centroid are one brightness cluster (rho 0.89-0.95 across clips) and flux joins loudness and energy in a level cluster; the arousal composite averages both, so a harsh built from them is arousal again (v0). Adjustment 1 counted the brightness cluster once, moved flux out of harsh (it is the busy cue) and dropped rolloff from busy (brightness again): it fixed independence but lost the Gemini split. Adjustment 2 replaced spectral flatness (confounded with brightness on a 2048-point FFT) with the harmonic estimator\'s own noisiness cue, the non-peak fraction (1 - tonalness), and dropped brightness altogether.',
  '',
  'Consequence to know about: harsh now uses the same two inputs as the character tension estimator, so it is close to it (see "Additional checks"). Its Gemini pass depends on the 21 "driving" tracks.',
]

describe.skipIf(clips.length < 50)('timbre descriptors: acceptance gates', () => {
  it(`replays ${clips.length} clips`, () => {
    expect(clips.length).toBeGreaterThan(50)
    const L: string[] = []
    const gates: { gate: string; what: string; result: string; ok: boolean | null }[] = []
    const col = (subset: readonly Clip[], k: Desc) => subset.map((c) => c.d[k])
    const human = clips.filter((c) => c.set === 'human')
    const pool = clips.filter((c) => c.set === 'pool')
    const tune = clips.filter((c) => c.fold === 'tune')
    const test = clips.filter((c) => c.fold === 'test')

    // ---- (i) spread
    const spread = DESCRIPTORS.map((k) => ({
      k,
      all: iqr(col(clips, k)),
      human: iqr(col(human, k)),
      pool: iqr(col(pool, k)),
      frame: iqr(frameVals[k]),
      p5: quantile(col(clips, k), 0.05),
      p95: quantile(col(clips, k), 0.95),
      mean: mean(col(clips, k)),
    }))
    for (const s of spread) gates.push({ gate: `(i) ${s.k}`, what: `clip-mean IQR >= ${IQR_MIN}`, result: `IQR ${f3(s.all)}`, ok: s.all >= IQR_MIN })

    // ---- (ii) independence from arousal
    const rhoRow = (subset: readonly Clip[], k: Desc) => spearman(col(subset, k), subset.map((c) => c.charArousal))
    const indep = DESCRIPTORS.map((k) => {
      const [lo, hi] = bootstrapCI(col(clips, k), clips.map((c) => c.charArousal))
      return { k, all: rhoRow(clips, k), lo, hi, tune: rhoRow(tune, k), test: rhoRow(test, k), pool: rhoRow(pool, k), human: rhoRow(human, k) }
    })
    for (const r of indep) {
      if (r.k === 'sparse') continue
      gates.push({ gate: `(ii) ${r.k}`, what: `|r| with character arousal <= ${AROUSAL_R_MAX}`, result: `r ${sgn(r.all, 3)} (tune ${sgn(r.tune)}, test ${sgn(r.test)}, pool ${sgn(r.pool)})`, ok: Math.abs(r.all) <= AROUSAL_R_MAX })
    }
    const hb = spearman(col(clips, 'harsh'), col(clips, 'busy'))

    // ---- (iii) Gemini separation
    const labelled = pool.filter((c) => gemini.has(c.poolFile)).map((c) => ({ c, mood: gemini.get(c.poolFile)! }))
    const grp = (moods: readonly string[], k: Desc) => labelled.filter((x) => moods.includes(x.mood)).map((x) => x.c.d[k])
    const sepHarsh = separation(grp(HARD_MOODS, 'harsh'), grp(SOFT_MOODS, 'harsh'))
    const sepStrict = separation(grp(HARD_STRICT, 'harsh'), grp(SOFT_MOODS, 'harsh'))
    const eta = labelled.length >= 10 ? etaSquared(labelled.map((x) => x.mood), labelled.map((x) => x.c.d.harsh)) : NaN
    // eta^2 with ~13 groups and n ~ 98 is inflated by chance alone: compare with its permutation null.
    let etaNullMean = NaN
    let etaP = NaN
    if (labelled.length >= 10) {
      const r = rng(5)
      const moods = labelled.map((x) => x.mood)
      const y = labelled.map((x) => x.c.d.harsh)
      const nulls: number[] = []
      for (let k = 0; k < 2000; k++) {
        shuffle(moods, r)
        nulls.push(etaSquared(moods, y))
      }
      etaNullMean = mean(nulls)
      etaP = (nulls.filter((v) => v >= eta - 1e-12).length + 1) / (nulls.length + 1)
    }
    const gemOk = sepHarsh.diff >= GEMINI_DIFF_MIN && sepHarsh.auc >= GEMINI_AUC_MIN
    gates.push({
      gate: '(iii) harsh',
      what: `hard moods (${HARD_MOODS.join('/')}) beat soft moods (${SOFT_MOODS.join('/')}): diff >= ${GEMINI_DIFF_MIN}, AUC >= ${GEMINI_AUC_MIN}`,
      result: `diff ${sgn(sepHarsh.diff)}, AUC ${f2(sepHarsh.auc)} (n ${sepHarsh.nHigh} vs ${sepHarsh.nLow})`,
      ok: labelled.length >= 10 ? gemOk : null,
    })
    // Informational: the same split for the other two descriptors (busy expected higher for hard moods, sparse lower).
    const sepBusy = separation(grp(HARD_MOODS, 'busy'), grp(SOFT_MOODS, 'busy'))
    const sepSparse = separation(grp(SOFT_MOODS, 'sparse'), grp(HARD_MOODS, 'sparse'))

    // ---- (iv) human ratings
    const humanRho = DESCRIPTORS.map((k) => {
      const [al, ah] = bootstrapCI(col(human, k), human.map((c) => c.humanArousal))
      const [vl, vh] = bootstrapCI(col(human, k), human.map((c) => c.humanValence))
      return {
        k,
        a: spearman(col(human, k), human.map((c) => c.humanArousal)),
        al,
        ah,
        v: spearman(col(human, k), human.map((c) => c.humanValence)),
        vl,
        vh,
        aTune: spearman(col(tune, k), tune.map((c) => c.humanArousal)),
        aTest: spearman(col(test, k), test.map((c) => c.humanArousal)),
      }
    })

    // ---- report
    L.push('# Timbre descriptors: acceptance gates', '')
    L.push(`Generated ${new Date().toISOString()} | ${clips.length} clips (${human.length} human-rated PMEmo in tune/test, ${pool.length} unlabelled pool tracks) | ${labelled.length} Gemini-labelled tracks | smoothing tau ${TIMBRE_TAU_SEC} s | tables: ${TIMBRE_CALIBRATION.source}`, '')
    L.push('Every clip is replayed through the shipped `TimbreDescriptors` (cached features, 20 Hz); a clip\'s value is its mean read after the 8 s warm-up. Gate thresholds were fixed before the first run; formula adjustments were chosen on gates (i) and (ii) (no labels) but gate (iii) was in view, so its pass is optimistic (see "Adjustment history").', '')
    L.push('## Gate summary', '', '| gate | criterion | result | verdict |', '|---|---|---|---|')
    for (const g of gates) L.push(`| ${g.gate} | ${g.what} | ${g.result} | **${g.ok === null ? 'n/a (no labels)' : verdict(g.ok)}** |`)
    L.push('')
    const passes = (k: Desc) => gates.filter((g) => g.gate.endsWith(` ${k}`)).every((g) => g.ok === true)
    L.push(`Descriptors passing every gate that applies to them: ${DESCRIPTORS.filter(passes).join(', ') || 'none'}.`, '')

    L.push('## (i) Spread', '', 'IQR of the per-clip mean read (the gate) and of the pooled per-frame read (what the look system sees over time).', '')
    L.push('| descriptor | IQR all clips | IQR human | IQR pool | IQR per-frame | p5..p95 (clips) | mean |', '|---|---|---|---|---|---|---|')
    for (const s of spread) L.push(`| ${s.k} | ${f3(s.all)} | ${f3(s.human)} | ${f3(s.pool)} | ${f3(s.frame)} | ${f2(s.p5)}..${f2(s.p95)} | ${f2(s.mean)} |`)
    L.push('')

    L.push('## (ii) Independence from arousal', '', 'Spearman rho of the clip-mean descriptor with the clip-mean arousal of the character estimator (`replayDimensions`). |r| > 0.7 means the descriptor is mostly arousal again. Sparse is not gated (it is expected to track low arousal) but is shown.', '')
    L.push('| descriptor | all (95% CI) | tune | test | pool | human-rated |', '|---|---|---|---|---|---|')
    for (const r of indep) L.push(`| ${r.k} | ${sgn(r.all)} (${f2(r.lo)}..${f2(r.hi)}) | ${sgn(r.tune)} | ${sgn(r.test)} | ${sgn(r.pool)} | ${sgn(r.human)} |`)
    L.push('', `harsh vs busy: rho ${sgn(hb)}. Character valence/tension for reference (all clips): ` + DESCRIPTORS.map((k) => `${k} ${sgn(spearman(col(clips, k), clips.map((c) => c.charValence)))} / ${sgn(spearman(col(clips, k), clips.map((c) => c.charTension)))}`).join(', ') + ' (valence / tension).', '')

    L.push('## (iii) Gemini label separation (Jamendo + testfolder tracks)', '')
    L.push(`Gemini primary mood vs the clip-mean descriptors. Hard = ${HARD_MOODS.join(', ')}; soft = ${SOFT_MOODS.join(', ')}. **Small n and LLM labels: read as a sanity check, not a measurement.** Note "driving" is ${grp(['driving'], 'harsh').length} of the ${sepHarsh.nHigh} hard tracks, so the headline split mostly asks whether harsh separates rhythmic/energetic from serene, not harsh from soft in the timbral sense; the strict split below drops it.`, '')
    L.push('| split | n hard / soft | mean diff (hard - soft) | AUC (95% bootstrap CI) | one-sided permutation p |', '|---|---|---|---|---|')
    L.push(`| harsh: ${HARD_MOODS.join('/')} vs soft | ${sepHarsh.nHigh} / ${sepHarsh.nLow} | ${sgn(sepHarsh.diff)} | ${f2(sepHarsh.auc)} (${f2(sepHarsh.aucLo)}..${f2(sepHarsh.aucHi)}) | ${f3(sepHarsh.p)} |`)
    L.push(`| harsh: ${HARD_STRICT.join('/')} vs soft (strict, no driving) | ${sepStrict.nHigh} / ${sepStrict.nLow} | ${sgn(sepStrict.diff)} | ${f2(sepStrict.auc)} (${f2(sepStrict.aucLo)}..${f2(sepStrict.aucHi)}) | ${f3(sepStrict.p)} |`)
    L.push(`| busy (info): hard vs soft | ${sepBusy.nHigh} / ${sepBusy.nLow} | ${sgn(sepBusy.diff)} | ${f2(sepBusy.auc)} (${f2(sepBusy.aucLo)}..${f2(sepBusy.aucHi)}) | ${f3(sepBusy.p)} |`)
    L.push(`| sparse (info): soft vs hard | ${sepSparse.nHigh} / ${sepSparse.nLow} | ${sgn(sepSparse.diff)} | ${f2(sepSparse.auc)} (${f2(sepSparse.aucLo)}..${f2(sepSparse.aucHi)}) | ${f3(sepSparse.p)} |`, '')
    L.push(`eta squared of harsh by Gemini primary mood (all ${labelled.length} tracks, ${new Set(labelled.map((x) => x.mood)).size} moods): **${f2(eta)}**; permutation null mean ${f2(etaNullMean)} (chance alone gives this much with so many small groups), p ${f3(etaP)}.`, '')
    const moodsPresent = [...new Set(labelled.map((x) => x.mood))].sort()
    L.push('| Gemini primary | n | harsh | busy | sparse |', '|---|---|---|---|---|')
    for (const m of moodsPresent) {
      const sub = labelled.filter((x) => x.mood === m)
      L.push(`| ${m} | ${sub.length} | ${f2(mean(sub.map((x) => x.c.d.harsh)))} | ${f2(mean(sub.map((x) => x.c.d.busy)))} | ${f2(mean(sub.map((x) => x.c.d.sparse)))} |`)
    }
    L.push('')

    L.push('## (iv) Sanity against the PMEmo human ratings (not a gate)', '', `${human.length} clips. Spearman rho (95% bootstrap CI). Expected signs: harsh and busy positive with arousal, sparse negative.`, '')
    L.push('| descriptor | arousal rho (CI) | tune | test | valence rho (CI) | expected sign for arousal |', '|---|---|---|---|---|---|')
    for (const r of humanRho) {
      const expected = r.k === 'sparse' ? r.a < 0 : r.a > 0
      L.push(`| ${r.k} | ${sgn(r.a)} (${f2(r.al)}..${f2(r.ah)}) | ${sgn(r.aTune)} | ${sgn(r.aTest)} | ${sgn(r.v)} (${f2(r.vl)}..${f2(r.vh)}) | ${expected ? 'yes' : 'NO'} |`)
    }
    L.push('')

    // ---- additional checks that were NOT pre-registered as gates but that a reader needs
    const tensionRho = (k: Desc) => spearman(col(clips, k), clips.map((c) => c.charTension))
    L.push('## Additional checks (not gates)', '')
    L.push(`- harsh vs character **tension**: rho ${sgn(tensionRho('harsh'))}. ${tensionRho('harsh') > AROUSAL_R_MAX ? 'Above 0.7: harsh is close to tension (both are built from roughness and tonalness), so it adds independence from arousal, not from tension.' : 'Below 0.7.'}`)
    L.push(`- harsh vs busy: rho ${sgn(hb)} (they should not be one axis); sparse vs busy: rho ${sgn(spearman(col(clips, 'sparse'), col(clips, 'busy')))} (sparse is built from busy, so it is expected to be strongly negative).`)
    L.push(`- Spread on the human-rated clips alone (chorus excerpts, median about 40 s, from one dataset so less between-clip variety than the pool): IQR ${DESCRIPTORS.map((k) => `${k} ${f3(spread.find((s) => s.k === k)!.human)}`).join(', ')}. A value under ${IQR_MIN} there means the clip-level gate is marginal; the per-frame IQR above is the comfortable one.`)
    L.push('')

    L.push('## Adjustment history', '')
    for (const h of HISTORY) L.push(h)
    L.push('')
    writeFileSync(OUT, L.join('\n') + '\n')

    const lines = ['', 'TIMBRE DESCRIPTOR GATES', ...gates.map((g) => `${g.ok === null ? 'N/A ' : verdict(g.ok)}  ${g.gate.padEnd(14)} ${g.what}  =>  ${g.result}`), '', `passing every applicable gate: ${DESCRIPTORS.filter(passes).join(', ') || 'none'}`, `report: ${OUT}`]
    console.log(lines.join('\n'))
  })
})
