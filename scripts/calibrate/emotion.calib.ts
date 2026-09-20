/**
 * Emotion evaluation: replays the REAL engine (same glue as the app) over
 * human-rated clips and reports how well its valence and arousal track the
 * listeners, plus how the 7-state mood label distributes and whether it carries
 * any of that information.
 *
 *   npm run calibrate -- scripts/calibrate/emotion.calib.ts        (or: npm run eval:emotion)
 *
 * Data (gitignored, fetched by `node corpus/fetch-emotion-sets.mjs`):
 *   PMEmo  corpus/emotion/pmemo/extracted/PMEmo2019/{chorus/*.mp3,annotations/static_annotations.csv}   ratings 0..1
 *   DEAM   corpus/emotion/deam/audio/**\/<song_id>.mp3 + annotations/...static_annotations_averaged_songs_*.csv  ratings 1..9
 *
 * Knobs:  EMO_SET=pmemo|deam|all (default all, whichever has audio)
 *         EMO_LIMIT=N clips per set, deterministic sample (default 150; 0 = every clip, ~20 min for PMEmo)
 *         EMO_SEED=n  sampling seed (default 1)
 *
 * Output (gitignored, derived from non-commercial data): corpus/emotion/eval-report.md + eval.json
 * INTERNAL EVALUATION ONLY: never train shipped weights on these ratings; the ridge fit below is a
 * diagnostic ("how much could these features explain?"), not a model to ship.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeMp3File } from './decode'
import { runTrack } from './features'
import { toFeatureCache } from './emotion'
import {
  MOOD_STATES,
  foldOf,
  PREDICTORS,
  quadrantAgreement,
  scorePredictor,
  summarizeClip,
  toUnit,
  type ClipSummary,
  type Fold,
  type Predictor,
  type Score,
} from './emotion'
import { etaSquared, mean, normalizedEntropy, ridgeCrossValidate, ridgeFit, rng, spearman } from './stats'
import { CHARACTER_MOODS } from '../../src/audio/characterTypes'

const ROOT = resolve(__dirname, '../..')
const EMO = join(ROOT, 'corpus/emotion')
const OUT_MD = join(EMO, 'eval-report.md')
const OUT_JSON = join(EMO, 'eval.json')
/** Per-clip feature cache (gitignored) so the estimator can be re-scored in seconds: see emotion-replay.calib.ts. */
const CACHE = join(EMO, 'cache')

const WANT = (process.env.EMO_SET ?? 'all').toLowerCase()
const LIMIT = process.env.EMO_LIMIT === undefined ? 150 : Math.max(0, Number(process.env.EMO_LIMIT) || 0)
const SEED = Number(process.env.EMO_SEED) || 1
/** tune | test | all (default all; the quantile-table pool fold is never evaluated). */
const FOLD = (process.env.EMO_FOLD ?? 'all').toLowerCase()

interface Item {
  id: string
  set: 'pmemo' | 'deam'
  path: string
  valence01: number
  arousal01: number
  fold: Fold
}

function readCsv(path: string): string[][] {
  return readFileSync(path, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((l) => l.split(',').map((c) => c.trim()))
}

function loadPmemo(): Item[] {
  const base = join(EMO, 'pmemo/extracted/PMEmo2019')
  const ann = join(base, 'annotations/static_annotations.csv')
  if (!existsSync(ann) || !existsSync(join(base, 'chorus'))) return []
  const rows = readCsv(ann)
  const h = rows[0]
  const ai = h.findIndex((c) => /arousal/i.test(c))
  const vi = h.findIndex((c) => /valence/i.test(c))
  const out: Item[] = []
  for (const r of rows.slice(1)) {
    const id = r[0]
    const path = join(base, 'chorus', `${id}.mp3`)
    const a = Number(r[ai])
    const v = Number(r[vi])
    if (existsSync(path) && Number.isFinite(a) && Number.isFinite(v)) {
      out.push({ id: `pmemo_${id}`, set: 'pmemo', path, valence01: v, arousal01: a, fold: foldOf(Number(id)) })
    }
  }
  return out
}

/** Recursively index *.mp3 under a directory by their numeric basename. */
function indexMp3(dir: string, into = new Map<string, string>()): Map<string, string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) indexMp3(p, into)
    else if (/\.mp3$/i.test(name)) into.set(name.replace(/\.mp3$/i, ''), p)
  }
  return into
}

function loadDeam(): Item[] {
  const audioDir = join(EMO, 'deam/audio')
  const annDir = join(EMO, 'deam/annotations/annotations/annotations averaged per song/song_level')
  if (!existsSync(audioDir) || !existsSync(annDir)) return []
  const files = indexMp3(audioDir)
  if (!files.size) return []
  const out: Item[] = []
  for (const f of readdirSync(annDir).filter((n) => /static_annotations_averaged/i.test(n))) {
    const rows = readCsv(join(annDir, f))
    const h = rows[0]
    const vi = h.findIndex((c) => /valence_mean/i.test(c))
    const ai = h.findIndex((c) => /arousal_mean/i.test(c))
    for (const r of rows.slice(1)) {
      const path = files.get(r[0])
      const v = Number(r[vi])
      const a = Number(r[ai])
      if (path && Number.isFinite(v) && Number.isFinite(a)) {
        out.push({ id: `deam_${r[0]}`, set: 'deam', path, valence01: toUnit(v, 1, 9), arousal01: toUnit(a, 1, 9), fold: foldOf(Number(r[0])) })
      }
    }
  }
  return out
}

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

const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : 'n/a')
const pct = (v: number) => `${(v * 100).toFixed(0)}%`
const row = (s: Score) => `| ${s.name} | ${s.n} | ${f2(s.rho)} | ${f2(s.lo)} to ${f2(s.hi)} |`

function buildReport(clips: ClipSummary[], sets: Record<string, number>, elapsedSec: number): { md: string; json: unknown } {
  const A = 'humanArousal' as const
  const V = 'humanValence' as const
  const arousalScores = PREDICTORS.map((p) => scorePredictor(clips, p, A)).sort((a, b) => Math.abs(b.rho || 0) - Math.abs(a.rho || 0))
  const valenceScores = PREDICTORS.map((p) => scorePredictor(clips, p, V)).sort((a, b) => Math.abs(b.rho || 0) - Math.abs(a.rho || 0))
  const appA = scorePredictor(clips, 'appArousal', A)
  const appV = scorePredictor(clips, 'appValence', V)
  const quad = quadrantAgreement(clips)

  // Diagnostic ridge on the raw features (never ships).
  const feat = PREDICTORS.filter((p) => p !== 'appArousal' && p !== 'appValence')
  const colMean = feat.map((p) => mean(clips.map((c) => c.x[p]).filter(Number.isFinite)))
  const X = clips.map((c) => feat.map((p, j) => (Number.isFinite(c.x[p]) ? c.x[p] : colMean[j])))
  const cvA = ridgeCrossValidate(X, clips.map((c) => c.humanArousal))
  const cvV = ridgeCrossValidate(X, clips.map((c) => c.humanValence))
  const ridgeA = spearman(cvA, clips.map((c) => c.humanArousal))
  const ridgeV = spearman(cvV, clips.map((c) => c.humanValence))
  const fullV = ridgeFit(X, clips.map((c) => c.humanValence), 5)
  const fullA = ridgeFit(X, clips.map((c) => c.humanArousal), 5)
  const top = (m: { weights: number[] }) =>
    feat
      .map((p, j) => [p, m.weights[j]] as const)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 6)
      .map(([p, w]) => `${p} ${w >= 0 ? '+' : ''}${w.toFixed(3)}`)
      .join(', ')

  // Mood labels.
  const frameShare: Record<string, number> = {}
  for (const s of MOOD_STATES) frameShare[s] = mean(clips.map((c) => c.moodShare[s]))
  const dom: Record<string, number> = {}
  for (const s of MOOD_STATES) dom[s] = 0
  for (const c of clips) dom[c.dominantMood]++
  const entropyFrames = normalizedEntropy(MOOD_STATES.map((s) => frameShare[s]))
  const etaA = etaSquared(clips.map((c) => c.dominantMood), clips.map((c) => c.humanArousal))
  const etaV = etaSquared(clips.map((c) => c.dominantMood), clips.map((c) => c.humanValence))
  const humanByMood = MOOD_STATES.map((s) => {
    const g = clips.filter((c) => c.dominantMood === s)
    return { s, n: g.length, a: mean(g.map((c) => c.humanArousal)), v: mean(g.map((c) => c.humanValence)) }
  })

  // New CHARACTER layer (14 named moods).
  const withChar = clips.filter((c) => c.dominantChar)
  const charShare: Record<string, number> = {}
  for (const m of CHARACTER_MOODS) charShare[m] = mean(withChar.map((c) => c.charShare[m] ?? 0))
  const charDom: Record<string, number> = {}
  for (const m of CHARACTER_MOODS) charDom[m] = 0
  for (const c of withChar) charDom[c.dominantChar]++
  const charEntropy = normalizedEntropy(CHARACTER_MOODS.map((m) => charShare[m]))
  const charMax = Math.max(...CHARACTER_MOODS.map((m) => charShare[m]))
  const charEtaA = etaSquared(withChar.map((c) => c.dominantChar), withChar.map((c) => c.humanArousal))
  const charEtaV = etaSquared(withChar.map((c) => c.dominantChar), withChar.map((c) => c.humanValence))
  const humanByChar = CHARACTER_MOODS.map((m) => {
    const g = withChar.filter((c) => c.dominantChar === m)
    return { m, n: g.length, a: mean(g.map((c) => c.humanArousal)), v: mean(g.map((c) => c.humanValence)) }
  })
  const dimA = scorePredictor(clips, 'dimArousal', A)
  const dimV = scorePredictor(clips, 'dimValence', V)
  const byFold = (fold: string) => clips.filter((c) => c.fold === fold)
  const foldRow = (fold: string) => {
    const cs = byFold(fold)
    if (cs.length < 10) return `| ${fold} | ${cs.length} | n/a | n/a | n/a | n/a |`
    const g = (p: Predictor, axis: 'humanValence' | 'humanArousal') => f2(scorePredictor(cs, p, axis).rho)
    return `| ${fold} | ${cs.length} | ${g('appArousal', A)} | ${g('dimArousal', A)} | ${g('appValence', V)} | ${g('dimValence', V)} |`
  }

  const keyShare = mean(clips.map((c) => c.keyValidShare))
  const modeV = scorePredictor(clips, 'modeStrength', V)
  const maxShare = Math.max(...MOOD_STATES.map((s) => frameShare[s]))

  const L: string[] = []
  L.push('# Emotion evaluation: engine vs human ratings', '')
  L.push(`Generated ${new Date().toISOString()} | ${clips.length} clips (${Object.entries(sets).map(([k, v]) => `${k}: ${v}`).join(', ')}) | ${(elapsedSec / 60).toFixed(1)} min`)
  L.push(`Sampling: EMO_LIMIT=${LIMIT || 'all'} per set, seed ${SEED}. Warm-up ${3} s skipped (key/tension ${8} s).`, '')
  L.push('Human ratings are PMEmo/DEAM listener means, scaled to 0..1. All numbers are Spearman rank correlations (rho) over clips with a 95% bootstrap interval. Chart-song chorus clips and 45 s excerpts are a proxy for the app\'s use, not the same thing.', '')
  L.push('## 1. The engine as it ships today', '')
  L.push(`- **Arousal** (\`computeValenceArousal\`): rho **${f2(appA.rho)}** (${f2(appA.lo)} to ${f2(appA.hi)}), n=${appA.n}. Published DEAM baselines for reference: arousal r about 0.8, valence r about 0.65 for trained models.`)
  L.push(`- **Valence**: rho **${f2(appV.rho)}** (${f2(appV.lo)} to ${f2(appV.hi)}), n=${appV.n}.`)
  L.push(`- **Quadrant agreement** (median split of prediction vs human): ${pct(quad.accuracy)} of clips in the right valence/arousal quadrant (chance 25%); arousal side right ${pct(quad.arousalAcc)}, valence side right ${pct(quad.valenceAcc)} (chance 50%).`, '')
  L.push('## 2. Single features vs human arousal', '', '| feature | n | rho | 95% CI |', '|---|---|---|---|', ...arousalScores.map(row), '')
  L.push('## 3. Single features vs human valence', '', '| feature | n | rho | 95% CI |', '|---|---|---|---|', ...valenceScores.map(row), '')
  L.push('## 4. How much could these features explain? (diagnostic only, never shipped)', '')
  L.push(`5-fold cross-validated ridge regression on the raw features above: arousal rho **${f2(ridgeA)}**, valence rho **${f2(ridgeV)}**. If these are well above section 1, the hand-written mapping is leaving signal on the table; if they are close, the features themselves are the limit and a learned embedding is needed.`)
  L.push(`- Strongest arousal weights: ${top(fullA)}`)
  L.push(`- Strongest valence weights: ${top(fullV)}`, '')
  L.push('## 5. The 7-state mood label', '')
  L.push(`Share of analysed frames per state: ${MOOD_STATES.map((s) => `${s} ${pct(frameShare[s])}`).join(', ')}.`)
  L.push(`Largest single state: **${pct(maxShare)}** (target under 30%). Normalised entropy **${entropyFrames.toFixed(2)}** (1 = perfectly even; target at least 0.80).`)
  L.push(`Clips by dominant state: ${MOOD_STATES.map((s) => `${s} ${dom[s]}`).join(', ')}.`, '')
  L.push(`**Does the label carry emotion information?** Share of human-rating variance explained by the clip's dominant state (eta squared): arousal **${f2(etaA)}**, valence **${f2(etaV)}** (0 = none, 1 = all).`, '')
  L.push('| dominant state | clips | mean human arousal | mean human valence |', '|---|---|---|---|', ...humanByMood.map((h) => `| ${h.s} | ${h.n} | ${f2(h.a)} | ${f2(h.v)} |`), '')
  L.push('## 6. Clean-room key/mode estimator', '')
  L.push(`Key read was valid for **${pct(keyShare)}** of post-warm-up frames on average. Mode strength vs human valence: rho **${f2(modeV.rho)}** (${f2(modeV.lo)} to ${f2(modeV.hi)}), n=${modeV.n}. Valence from mode is a weak-to-moderate signal in the literature, so a small positive value is the expected outcome, not a failure.`, '')
  L.push('## 7. The new estimator and 14-mood CHARACTER layer', '')
  L.push(`Estimator vs human ratings (all evaluated clips): arousal rho **${f2(dimA.rho)}** (${f2(dimA.lo)} to ${f2(dimA.hi)}) vs the app's ${f2(appA.rho)}; valence rho **${f2(dimV.rho)}** (${f2(dimV.lo)} to ${f2(dimV.hi)}) vs the app's ${f2(appV.rho)}.`, '')
  L.push('Per fold (weights were chosen from the literature, not fitted; the "tune" fold is the only one used while iterating, "test" is held out):', '')
  L.push('| fold | clips | app arousal rho | new arousal rho | app valence rho | new valence rho |', '|---|---|---|---|---|---|', foldRow('tune'), foldRow('test'), '')
  L.push(`Share of time each of the 14 moods was the committed primary: ${CHARACTER_MOODS.map((m) => `${m} ${pct(charShare[m])}`).join(', ')}.`)
  L.push(`Largest single mood: **${pct(charMax)}** (target under 30%). Normalised entropy over 14 moods **${charEntropy.toFixed(2)}** (target at least 0.80). Moods that ever led a clip: **${CHARACTER_MOODS.filter((m) => charDom[m] > 0).length} of 14**.`)
  L.push(`Does the label carry emotion information? Variance of human ratings explained by the dominant mood (eta squared): arousal **${f2(charEtaA)}**, valence **${f2(charEtaV)}** (old 7-state label: ${f2(etaA)} and ${f2(etaV)}).`, '')
  L.push('| dominant mood | clips | mean human arousal | mean human valence |', '|---|---|---|---|', ...humanByChar.map((h) => `| ${h.m} | ${h.n} | ${f2(h.a)} | ${f2(h.v)} |`), '')
  L.push('## 8. Caveats', '')
  L.push('- Internal evaluation only. PMEmo/DEAM are non-commercial research data; PMEmo here is an unverified community mirror. Do not train shipped weights on them or redistribute the audio.')
  L.push('- Clip-level means hide within-clip change. Ratings are per-listener averages with real disagreement (DEAM valence std is often 1+ points on a 1-9 scale), so a ceiling below 1.0 is normal.')
  L.push('- The engine runs without Essentia here (no danceability, no MusiCNN moods), matching the commercial build.', '')

  const json = {
    generated: new Date().toISOString(),
    clips: clips.length,
    sets,
    limit: LIMIT,
    seed: SEED,
    engine: { arousal: appA, valence: appV, quadrant: quad },
    singleFeatureArousal: arousalScores,
    singleFeatureValence: valenceScores,
    ridgeDiagnostic: { arousalRho: ridgeA, valenceRho: ridgeV },
    character: { share: charShare, dominantClips: charDom, normalizedEntropy: charEntropy, etaSquaredArousal: charEtaA, etaSquaredValence: charEtaV, estimator: { arousal: dimA, valence: dimV } },
    mood: { frameShare, dominantClips: dom, normalizedEntropy: entropyFrames, etaSquaredArousal: etaA, etaSquaredValence: etaV, humanByMood },
    perClip: clips.map((c) => ({ id: c.id, set: c.set, humanValence: c.humanValence, humanArousal: c.humanArousal, dominantMood: c.dominantMood, x: c.x })),
  }
  return { md: L.join('\n') + '\n', json }
}

const items: Item[] = []
const inFold = (i: Item) => i.fold !== 'pool' && (FOLD === 'all' || i.fold === FOLD)
if (WANT === 'all' || WANT === 'pmemo') items.push(...sample(loadPmemo().filter(inFold), LIMIT, SEED))
if (WANT === 'all' || WANT === 'deam') items.push(...sample(loadDeam().filter(inFold), LIMIT, SEED + 1))

describe.skipIf(items.length === 0)('emotion evaluation vs human ratings', () => {
  it(
    `replays ${items.length} human-rated clip(s) through the engine and writes the report`,
    async () => {
      const t0 = Date.now()
      const clips: ClipSummary[] = []
      const sets: Record<string, number> = {}
      let failed = 0
      for (let i = 0; i < items.length; i++) {
        const it0 = items[i]
        try {
          const audio = await decodeMp3File(it0.path)
          const run = runTrack(audio.pcm, audio.sampleRate)
          mkdirSync(CACHE, { recursive: true })
          writeFileSync(join(CACHE, `${it0.id}.json`), JSON.stringify({ ...it0, path: undefined, cache: toFeatureCache(run.frames) }))
          const s = summarizeClip(it0.id, it0.set, it0.fold, it0.valence01, it0.arousal01, run.frames)
          if (s) {
            clips.push(s)
            sets[it0.set] = (sets[it0.set] ?? 0) + 1
          }
        } catch (e) {
          failed++
          console.log(`  skip ${it0.id}: ${(e as Error).message}`)
        }
        if ((i + 1) % 10 === 0 || i + 1 === items.length) {
          const el = (Date.now() - t0) / 1000
          console.log(`  ${i + 1}/${items.length} clips, ${el.toFixed(0)} s, ~${((el / (i + 1)) * (items.length - i - 1) / 60).toFixed(1)} min left`)
        }
      }
      expect(clips.length).toBeGreaterThan(20)
      const { md, json } = buildReport(clips, sets, (Date.now() - t0) / 1000)
      mkdirSync(EMO, { recursive: true })
      writeFileSync(OUT_MD, md)
      writeFileSync(OUT_JSON, JSON.stringify(json, null, 2))
      console.log(md)
      console.log(`wrote ${OUT_MD} (${clips.length} clips, ${failed} failed)`)
    },
    6 * 60 * 60 * 1000,
  )
})

// Keep the type imports used even when the suite is skipped.
export type { Predictor }
