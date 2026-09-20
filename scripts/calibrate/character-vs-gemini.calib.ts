/**
 * Compares the CHARACTER layer (estimator + 14-mood classifier) with the offline Gemini labels
 * (corpus/labels/gemini/*.json) for the same tracks, replayed from the pool feature caches
 * (`npm run calibrate:quantiles` builds them: first 90 s of each Jamendo/testfolder track).
 *
 *   npm run eval:gemini
 *
 * Gemini labels are LLM pre-labels, NOT ground truth (mixed models on the free tier, valence is noisy).
 * This is a sanity check on named moods and tension, which no human-rated dataset here covers.
 * INTERNAL EVALUATION ONLY.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHARACTER_MOODS } from '../../src/audio/characterTypes'
import { JAMENDO_TAG_MAP } from '../mood-labels/lib.mjs'
import { framesFromCache, replayDimensions, type FeatureCache } from './emotion'
import { mean, normalizedEntropy, spearman } from './stats'

const ROOT = resolve(__dirname, '../..')
const LABELS = join(ROOT, 'corpus/labels/gemini')
const POOL = join(ROOT, 'corpus/emotion/cache-pool')
const OUT = join(ROOT, 'corpus/emotion/character-vs-gemini.md')

interface GeminiRec {
  trackId: string
  file: string
  status: string
  model: string
  samples: number
  needsReview?: boolean
  label: { primaryMood: string; secondaryMood: string | null; valence: number; arousal: number; tension: number; confidence: number } | null
  jamendoTags?: string[]
}

function loadRows() {
  if (!existsSync(LABELS) || !existsSync(POOL)) return []
  const rows: { rec: GeminiRec; cache: FeatureCache }[] = []
  for (const f of readdirSync(LABELS).filter((n) => /^jamendo_.*\.json$/.test(n))) {
    const rec = JSON.parse(readFileSync(join(LABELS, f), 'utf8')) as GeminiRec
    if (rec.status !== 'ok' || !rec.label) continue
    const cf = join(POOL, `${basename(dirname(rec.file))}__${basename(rec.file)}.json`)
    if (!existsSync(cf)) continue
    rows.push({ rec, cache: JSON.parse(readFileSync(cf, 'utf8')) as FeatureCache })
  }
  return rows
}

const rows = loadRows()
/** Mann-Whitney AUC: P(random 'high' track scores above a random 'low' one); 0.5 = no signal. */
function auc(high: number[], low: number[]): number {
  if (!high.length || !low.length) return NaN
  let w = 0
  for (const h of high) for (const l of low) w += h > l ? 1 : h === l ? 0.5 : 0
  return w / (high.length * low.length)
}
const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : 'n/a')
const pct = (v: number) => `${(v * 100).toFixed(0)}%`

describe.skipIf(rows.length < 15)('character layer vs Gemini pre-labels', () => {
  it(`compares ${rows.length} tracks`, () => {
    const scored = rows
      .map(({ rec, cache }) => {
        const d = replayDimensions(framesFromCache(cache), 1)
        return d ? { rec, d } : null
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
    expect(scored.length).toBeGreaterThan(10)

    const corr = (subset: typeof scored) => {
      const g = (k: 'arousal' | 'valence' | 'tension') => subset.map((x) => x.rec.label![k])
      return {
        n: subset.length,
        a: spearman(subset.map((x) => x.d.arousal), g('arousal')),
        v: spearman(subset.map((x) => x.d.valence), g('valence')),
        t: spearman(subset.map((x) => x.d.tension), g('tension')),
      }
    }
    const all = corr(scored)
    const solid = corr(scored.filter((x) => x.rec.samples >= 3 && !x.rec.needsReview))
    const strongModel = corr(scored.filter((x) => !/lite/.test(x.rec.model)))

    // Named-mood agreement.
    let top1 = 0
    let top1or2 = 0
    let inTop2 = 0
    const conf: Record<string, Record<string, number>> = {}
    for (const x of scored) {
      const g = x.rec.label!.primaryMood
      const g2 = x.rec.label!.secondaryMood
      const ranked = CHARACTER_MOODS.map((m) => [m, x.d.charShare[m] ?? 0] as const).sort((a, b) => b[1] - a[1])
      const e1 = ranked[0][0]
      const e2 = ranked[1][0]
      if (e1 === g) top1++
      if (e1 === g || (g2 && e1 === g2)) top1or2++
      if (e1 === g || e2 === g) inTop2++
      ;(conf[g] ??= {})[e1] = (conf[g][e1] ?? 0) + 1
    }
    const n = scored.length
    const engDom: Record<string, number> = {}
    const gemDom: Record<string, number> = {}
    for (const m of CHARACTER_MOODS) {
      engDom[m] = 0
      gemDom[m] = 0
    }
    for (const x of scored) {
      engDom[x.d.dominantChar]++
      if (x.rec.label!.primaryMood in gemDom) gemDom[x.rec.label!.primaryMood]++
    }
    const chance = 1 / CHARACTER_MOODS.length
    const L: string[] = []
    L.push('# Character layer vs Gemini pre-labels', '')
    L.push(`Generated ${new Date().toISOString()} | ${n} tracks (Gemini labels present, engine replayed on the first 90 s).`, '')
    L.push('Gemini labels are LLM pre-labels (mixed models, free tier), not ground truth. Read these as a sanity check.', '')
    L.push('## Continuous axes (Spearman rho vs Gemini 1-9 ratings)', '', '| subset | tracks | arousal | valence | tension |', '|---|---|---|---|---|')
    L.push(`| all | ${all.n} | ${f2(all.a)} | ${f2(all.v)} | ${f2(all.t)} |`)
    L.push(`| 3 samples and not flagged for review | ${solid.n} | ${f2(solid.a)} | ${f2(solid.v)} | ${f2(solid.t)} |`)
    L.push(`| non-lite models only | ${strongModel.n} | ${f2(strongModel.a)} | ${f2(strongModel.v)} | ${f2(strongModel.t)} |`, '')
    L.push('## Named moods', '')
    L.push(`- Engine dominant mood equals Gemini primary: **${pct(top1 / n)}** (chance about ${pct(chance)} for 14 moods, more if Gemini itself is lopsided).`)
    L.push(`- ... equals Gemini primary or secondary: **${pct(top1or2 / n)}**.`)
    L.push(`- Gemini primary is among the engine's top two: **${pct(inTop2 / n)}**.`)
    L.push(`- Spread of the engine's dominant moods: normalised entropy **${normalizedEntropy(CHARACTER_MOODS.map((m) => engDom[m])).toFixed(2)}**, Gemini's own: **${normalizedEntropy(CHARACTER_MOODS.map((m) => gemDom[m])).toFixed(2)}**.`, '')
    L.push('| mood | engine dominant (tracks) | Gemini primary (tracks) |', '|---|---|---|', ...CHARACTER_MOODS.map((m) => `| ${m} | ${engDom[m]} | ${gemDom[m]} |`), '')
    L.push('## Where they disagree (Gemini primary -> engine dominant, tracks)', '')
    for (const [g, row] of Object.entries(conf).sort((a, b) => Object.values(b[1]).reduce((s, v) => s + v, 0) - Object.values(a[1]).reduce((s, v) => s + v, 0))) {
      L.push(`- ${g}: ${Object.entries(row).sort((a, b) => b[1] - a[1]).map(([e, c]) => `${e} ${c}`).join(', ')}`)
    }
    // Second, independent reference: the Jamendo mood tags (weak, human-applied, coarse map). Gemini and the
    // engine are both scored against them, so a disagreement between the two can be attributed to one side.
    const tagMap = JAMENDO_TAG_MAP as Record<string, { valence?: string; arousal?: string; moods?: string[] }>
    const side = (tags: string[], key: 'valence' | 'arousal') => {
      const vals = new Set(tags.map((t) => tagMap[t]?.[key]).filter(Boolean))
      return vals.size === 1 ? [...vals][0] : null
    }
    const tagged = scored.map((x) => {
      const tags = (x.rec.jamendoTags ?? []).map((t) => t.trim().toLowerCase())
      return { x, v: side(tags, 'valence'), a: side(tags, 'arousal'), compat: new Set(tags.flatMap((t) => tagMap[t]?.moods ?? [])) }
    })
    const sep = (axis: 'a' | 'v') => {
      const hi = tagged.filter((t) => t[axis] === 'high')
      const lo = tagged.filter((t) => t[axis] === 'low')
      const key = axis === 'a' ? 'arousal' : 'valence'
      return { nHi: hi.length, nLo: lo.length, eng: auc(hi.map((t) => t.x.d[key]), lo.map((t) => t.x.d[key])), gem: auc(hi.map((t) => t.x.rec.label![key]), lo.map((t) => t.x.rec.label![key])) }
    }
    const sa = sep('a')
    const sv = sep('v')
    const withMoods = tagged.filter((t) => t.compat.size)
    const hit = (pick: (t: (typeof tagged)[number]) => string[]) => withMoods.filter((t) => pick(t).some((m) => t.compat.has(m))).length / withMoods.length
    const chanceMood = mean(withMoods.map((t) => t.compat.size / CHARACTER_MOODS.length))
    const engTop2 = (t: (typeof tagged)[number]) => CHARACTER_MOODS.map((m) => [m, t.x.d.charShare[m] ?? 0] as const).sort((a, b) => b[1] - a[1]).slice(0, 2).map((r) => r[0])
    L.push('', '## Both against the Jamendo mood tags (independent of each other)', '')
    L.push('AUC = chance that a track tagged high-on-the-axis scores above one tagged low (0.5 = no signal, 1 = perfect). Tags are weak and the map is coarse.', '')
    L.push('| axis | tagged high / low | engine AUC | Gemini AUC |', '|---|---|---|---|')
    L.push(`| arousal | ${sa.nHi} / ${sa.nLo} | ${f2(sa.eng)} | ${f2(sa.gem)} |`)
    L.push(`| valence | ${sv.nHi} / ${sv.nLo} | ${f2(sv.eng)} | ${f2(sv.gem)} |`, '')
    L.push(`Named mood is tag-compatible (${withMoods.length} tracks with an interpretable tag; chance if picking at random about ${pct(chanceMood)}):`, '')
    L.push(`- engine dominant mood: **${pct(hit((t) => [t.x.d.dominantChar]))}**, engine top two: **${pct(hit(engTop2))}**`)
    L.push(`- Gemini primary: **${pct(hit((t) => [t.x.rec.label!.primaryMood]))}**, Gemini primary or secondary: **${pct(hit((t) => [t.x.rec.label!.primaryMood, t.x.rec.label!.secondaryMood ?? '']))}**`)
    L.push('', `Mean Gemini V/A/T: ${f2(mean(scored.map((x) => x.rec.label!.valence)))}/${f2(mean(scored.map((x) => x.rec.label!.arousal)))}/${f2(mean(scored.map((x) => x.rec.label!.tension)))} (1-9 scale).`)
    writeFileSync(OUT, L.join('\n') + '\n')
    console.log(L.join('\n'))
  })
})
