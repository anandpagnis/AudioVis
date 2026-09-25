import { describe, it } from 'vitest'
import { STIMULI, STIMULUS_NAMES } from '../../eval/synthSong'
import { analyzeSong } from '../analyzeSong'
import { footeNovelty, windowDistance, cosineSsm, typeBoundary } from '../structure'
import { robustZ, type Agg } from '../aggregate'

type Dbg = { vec: Float32Array; vecMain: Float32Array; chromaVec: Float32Array; nBars: number; bounds: number[]; bar: Agg; nov: { z: Float64Array; zRaw: Float64Array; dist: Float64Array } }
const dbg = () => (globalThis as Record<string, unknown>).__planDebug as Dbg
const NL = '\n'

function scales(): string {
  const d = dbg()
  const out: string[] = []
  const S = cosineSsm(d.vecMain, d.nBars)
  const Sc = cosineSsm(d.chromaVec, d.nBars)
  for (const K of [2, 4, 8]) {
    const z = robustZ(footeNovelty(S, d.nBars, K), 2, d.nBars - 2)
    const dist = windowDistance(d.vecMain, d.nBars, K)
    out.push(`K${K}: ` + Array.from(z).map((v, i) => i + ':' + v.toFixed(1) + '/' + dist[i].toFixed(1)).join(' '))
  }
  const zh = robustZ(footeNovelty(Sc, d.nBars, 8), 2, d.nBars - 2)
  const dh = windowDistance(d.chromaVec, d.nBars, 8)
  out.push('H8: ' + Array.from(zh).map((v, i) => i + ':' + v.toFixed(1) + '/' + dh[i].toFixed(1)).join(' '))
  return out.join(NL)
}
function typings(): string {
  const d = dbg()
  const out: string[] = []
  for (let k = 1; k + 1 < d.bounds.length; k++) {
    const t = typeBoundary(d.bar, d.bounds[k], d.bounds[k - 1], d.bounds[k + 1])
    out.push(`${d.bounds[k]}: ${t.type} dLow ${t.deltaLowDb.toFixed(1)} dLevel ${t.deltaLevelDb.toFixed(1)} slope ${t.levelSlope.toFixed(2)} lfRatio ${t.lowFluxRatio.toFixed(2)}`)
  }
  return out.join(NL)
}
function bars(from: number, to: number): string {
  const d = dbg()
  const out: string[] = ['bar level low high flux lowFlux hiFlux fluxStd']
  for (let i = from; i < to; i++) out.push([i, d.bar.levelDb[i], d.bar.lowDb[i], d.bar.highDb[i], d.bar.flux[i], d.bar.lowFlux[i], d.bar.hiFlux[i], d.bar.fluxStd[i]].map((v, k) => (k === 0 ? String(v) : (v as number).toFixed(1))).join(' '))
  return out.join(NL)
}

const only = process.env.ONLY?.split(',')
describe('scratch', () => {
  for (const name of STIMULUS_NAMES) {
    if (only && !only.includes(name)) continue
    it(name, () => {
      const song = STIMULI[name]({ sampleRate: 22050 })
      const t0 = Date.now()
      const plan = analyzeSong(song.pcm, song.sampleRate)
      const ms = Date.now() - t0
      const barSec = 240 / song.bpm
      const lines: string[] = []
      lines.push(`=== ${name} nominal ${song.bpm} got ${plan.bpm.toFixed(2)} phase ${plan.downbeatPhase} conf ${plan.diagnostics.downbeat.confidence.toFixed(2)} (sal ${plan.diagnostics.downbeat.salienceConfidence.toFixed(2)} str ${plan.diagnostics.downbeat.structureConfidence.toFixed(2)}) tempoConf ${plan.diagnostics.tempo.confidence.toFixed(2)} onsetRatio ${plan.diagnostics.beatOnsetRatio.toFixed(2)} ${ms}ms beats ${plan.beats.length} bars ${plan.diagnostics.nBars} grid ${JSON.stringify(plan.diagnostics.grid)}`)
      lines.push(`beat0 ${plan.beats[0]?.toFixed(3)} truth0 ${song.beatTimes[0].toFixed(3)}  bar0 ${plan.bars[0]?.toFixed(3)}`)
      lines.push('truth: ' + song.truth.map((t) => `${t.type}${t.shouldTrigger ? '+' : '-'}@bar${(t.timeSec / barSec).toFixed(1)}`).join(' '))
      lines.push('det:   ' + plan.events.map((e) => `${e.type}@${(e.boundaryTime / barSec).toFixed(1)}(z${plan.diagnostics.novelty[(e.boundaryBeat - plan.downbeatPhase) / 4].toFixed(1)},d${plan.diagnostics.distance[(e.boundaryBeat - plan.downbeatPhase) / 4].toFixed(1)})`).join(' '))
      lines.push('segs:  ' + plan.segments.map((s) => `${s.label}[${s.startBar}-${s.endBar}]`).join(' '))
      if (process.env.DEBUG) lines.push('nov: ' + plan.diagnostics.novelty.map((v, i) => i + ':' + v.toFixed(1) + '/' + plan.diagnostics.distance[i].toFixed(1)).join(' '))
      lines.push(`rejectedByFloor ${plan.diagnostics.rejectedByFloor}`)
      if (process.env.SCALES) lines.push(scales())
      lines.push(typings())
      if (process.env.BARS) {
        const [a, b] = process.env.BARS.split('-').map(Number)
        lines.push(bars(a, b))
      }
      console.log(lines.join(NL))
    }, 60000)
  }
})
