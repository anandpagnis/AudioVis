/**
 * Fast estimator iteration: re-scores `EmotionDimensionEstimator` + `CharacterClassifier`
 * over the per-clip feature caches written by `emotion.calib.ts` (no audio decoding), in seconds.
 *
 *   npm run eval:replay                      # both folds, prints a compact table
 *   EMO_FOLD=tune npm run eval:replay        # iterate on the tune fold only
 *
 * Discipline: iterate on `tune`; look at `test` only when you are done, once.
 * INTERNAL EVALUATION ONLY (see emotion.calib.ts).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHARACTER_MOODS } from '../../src/audio/characterTypes'
import { framesFromCache, replayDimensions, type FeatureCache } from './emotion'
import { bootstrapCI, etaSquared, mean, normalizedEntropy, spearman } from './stats'

const CACHE = join(resolve(__dirname, '../..'), 'corpus/emotion/cache')
const FOLD = (process.env.EMO_FOLD ?? 'all').toLowerCase()

interface Row {
  id: string
  fold: string
  valence01: number
  arousal01: number
  cache: FeatureCache
}

function load(): Row[] {
  if (!existsSync(CACHE)) return []
  const rows: Row[] = []
  for (const f of readdirSync(CACHE).filter((n) => n.endsWith('.json'))) {
    const j = JSON.parse(readFileSync(join(CACHE, f), 'utf8'))
    if (j.fold === 'pool') continue
    if (FOLD !== 'all' && j.fold !== FOLD) continue
    rows.push({ id: j.id, fold: j.fold, valence01: j.valence01, arousal01: j.arousal01, cache: j.cache })
  }
  return rows
}

const rows = load()
const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : 'n/a')
const pct = (v: number) => `${(v * 100).toFixed(0)}%`

describe.skipIf(rows.length < 20)('estimator replay on cached features', () => {
  it(`scores ${rows.length} cached clips`, () => {
    const scored = rows
      .map((r) => {
        const d = replayDimensions(framesFromCache(r.cache), 1)
        return d ? { r, d } : null
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
    expect(scored.length).toBeGreaterThan(10)

    const out: string[] = ['']
    const folds = FOLD === 'all' ? ['tune', 'test', 'all'] : [FOLD]
    out.push('fold   clips   arousal rho (95% CI)     valence rho (95% CI)     tension rho(A/V)   pulse rho(A)')
    for (const fold of folds) {
      const s = fold === 'all' ? scored : scored.filter((x) => x.r.fold === fold)
      if (s.length < 10) continue
      const a = s.map((x) => x.d.arousal)
      const v = s.map((x) => x.d.valence)
      const ha = s.map((x) => x.r.arousal01)
      const hv = s.map((x) => x.r.valence01)
      const [al, ah] = bootstrapCI(a, ha)
      const [vl, vh] = bootstrapCI(v, hv)
      out.push(
        `${fold.padEnd(6)} ${String(s.length).padEnd(7)} ${f2(spearman(a, ha))} (${f2(al)}..${f2(ah)})      ${f2(spearman(v, hv))} (${f2(vl)}..${f2(vh)})      ${f2(spearman(s.map((x) => x.d.tension), ha))}/${f2(spearman(s.map((x) => x.d.tension), hv))}          ${f2(spearman(s.map((x) => x.d.pulse), ha))}`,
      )
    }

    const share: Record<string, number> = {}
    for (const m of CHARACTER_MOODS) share[m] = mean(scored.map((x) => x.d.charShare[m] ?? 0))
    const dom: Record<string, number> = {}
    for (const m of CHARACTER_MOODS) dom[m] = 0
    for (const x of scored) dom[x.d.dominantChar]++
    out.push('')
    out.push(`14-mood share of time: ${CHARACTER_MOODS.map((m) => `${m} ${pct(share[m])}`).join(', ')}`)
    out.push(
      `largest ${pct(Math.max(...CHARACTER_MOODS.map((m) => share[m])))} | entropy ${normalizedEntropy(CHARACTER_MOODS.map((m) => share[m])).toFixed(2)} | moods leading >=1 clip: ${CHARACTER_MOODS.filter((m) => dom[m] > 0).length}/14`,
    )
    out.push(
      `variance of human ratings explained by dominant mood (eta^2): arousal ${f2(etaSquared(scored.map((x) => x.d.dominantChar), scored.map((x) => x.r.arousal01)))}, valence ${f2(etaSquared(scored.map((x) => x.d.dominantChar), scored.map((x) => x.r.valence01)))}`,
    )
    writeFileSync(join(resolve(__dirname, '../..'), 'corpus/emotion/replay.txt'), out.join('\n') + '\n')
    console.log(out.join('\n'))
  })
})
