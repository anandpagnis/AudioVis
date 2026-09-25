import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { aggregateCadence, cadenceOfTrack, distStats, quantile } from '../../src/audio/eval/cadenceMetrics'
import { unpackTrace, type PackedTrace } from '../../src/audio/eval/cadenceTrace'
import { simulateDirector } from '../../src/audio/eval/directorReplay'
import { simulateLegacy } from '../../src/audio/eval/legacyCadence'
import { createLegacyEventState, stepLegacyEvents, type LegacyInput } from '../../src/audio/events/legacyEvents'
import type { SectionEvent } from '../../src/audio/events/types'

const TRACE_DIR = join(resolve(__dirname, '../..'), 'corpus/structure/traces')

describe('w2b scratch', () => {
  it('stats', () => {
    const names = readdirSync(TRACE_DIR).filter((n) => n.endsWith('.json')).sort()
    const dropGapBars: number[] = []
    const scStrength: number[] = []
    let drops = 0
    let dropsBuild = 0
    let dropsCorr = 0
    let dropsLone = 0
    let dropsLoneUncorr = 0
    let dropsWithin32 = [0, 0, 0, 0, 0, 0]
    let minutes = 0
    let builds = 0
    let boundaries = 0
    let sc = 0
    const perTrackDropsPerMin: number[] = []
    const ctx = { n: 0, sustainNow: 0, within16: 0, within128: 0, corr: 0, priorGe3: 0, loneNoBuild128: 0, loneNoBuild128Uncorr: 0 }
    const perTrackCuts: Array<[string, number, number, number]> = []
    const tracksAgg = []
    const legAgg = []
    for (const name of names) {
      const trace = unpackTrace(JSON.parse(readFileSync(join(TRACE_DIR, name), 'utf8')) as PackedTrace)
      const st = createLegacyEventState()
      const li: LegacyInput = { time: 0, beat: 0, bpm: 120, sectionChange: false, sectionChangeStrength: 0, drop: false, buildUp: false, structureValid: false, boundaryChanged: false, section: '', previousSection: '', sectionConfidence: 0, beatsInSection: 0, isSustain: false }
      const c = trace.cols
      const seen = new Map<number, SectionEvent>()
      const order: number[] = []
      const out: SectionEvent[] = []
      for (let i = 0; i < trace.n; i++) {
        li.time = i / 60
        li.beat = c.beatIndex[i]
        li.bpm = c.bpm10[i] / 10
        li.sectionChange = c.sectionChange[i] === 1
        li.sectionChangeStrength = c.sectionChangeStrength[i] / 100
        li.drop = c.drop[i] === 1
        li.buildUp = c.buildUp[i] === 1
        li.structureValid = c.structureValid[i] === 1
        li.boundaryChanged = c.boundaryChanged[i] === 1
        li.section = trace.enums.sections[c.section[i]] ?? ''
        li.previousSection = trace.enums.sections[c.previousSection[i]] ?? ''
        li.sectionConfidence = c.sectionConfidence[i] / 255
        li.beatsInSection = c.beatsInSection[i]
        li.isSustain = c.isSustain[i] === 1
        if (li.sectionChange) scStrength.push(li.sectionChangeStrength)
        out.length = 0
        stepLegacyEvents(st, li, out)
        for (const e of out) {
          if (!seen.has(e.id)) order.push(e.id)
          seen.set(e.id, { ...e })
        }
      }
      const min = trace.n / 60 / 60
      minutes += min
      const dropBeats: number[] = []
      let lastSust = -1e9
      let lastBrk = -1e9
      let brkNow = 0
      const dropEcho: number[] = []
      let prevDrop = 0
      const dropEdges: Array<{ beat: number; sustNow: boolean; since: number }> = []
      for (let i = 0; i < trace.n; i++) {
        const sus = c.structureValid[i] === 1 && c.isSustain[i] === 1
        const bu = c.buildUp[i] === 1
        if (sus || bu) lastSust = c.beatIndex[i]
        if (c.structureValid[i] === 1 && c.isBreakdown[i] === 1) lastBrk = c.beatIndex[i]
        if (c.drop[i] === 1 && prevDrop === 0) { (globalThis as any).__brk16 = ((globalThis as any).__brk16 ?? 0) + (c.beatIndex[i] - lastBrk <= 16 ? 1 : 0); (globalThis as any).__brk64 = ((globalThis as any).__brk64 ?? 0) + (c.beatIndex[i] - lastBrk <= 64 ? 1 : 0); (globalThis as any).__echo = ((globalThis as any).__echo ?? 0) + (c.boundaryChanged[i] === 1 && c.structureValid[i] === 1 && trace.enums.sections[c.section[i]] === 'drop' ? 1 : 0) }
        if (c.drop[i] === 1 && prevDrop === 0) dropEdges.push({ beat: c.beatIndex[i], sustNow: sus || bu, since: c.beatIndex[i] - lastSust })
        prevDrop = c.drop[i]
      }
      for (const d of dropEdges) { ctx.n++; if (d.sustNow) ctx.sustainNow++; if (d.since <= 16) ctx.within16++; if (d.since <= 128) ctx.within128++ }
      for (const id of order) {
        const e = seen.get(id) as SectionEvent
        if (e.type === 'drop') {
          drops++
          if (e.confidence >= 0.89) dropsBuild++
          if (e.corroborated) dropsCorr++
          if (e.confidence < 0.89 && !e.corroborated) dropsLoneUncorr++
          if (e.confidence < 0.89) dropsLone++
          const prior = dropBeats.filter((b) => e.detectedAtBeat - b <= 128 && e.detectedAtBeat - b > 0).length
          dropsWithin32[Math.min(5, prior)]++
          if (dropBeats.length) dropGapBars.push((e.detectedAtBeat - dropBeats[dropBeats.length - 1]) / 4)
          dropBeats.push(e.detectedAtBeat)
        } else if (e.type === 'buildStart') builds++
        else if (e.type === 'change') { sc++ }
      }
      perTrackDropsPerMin.push(dropBeats.length / min)
      boundaries += trace.analyserBoundaries.length
      const dres = simulateDirector(trace)
      tracksAgg.push(cadenceOfTrack(name, trace, dres))
      perTrackCuts.push([name, dres.commits.length / min, dropEdges.length / min, dres.commits.length])
      legAgg.push(cadenceOfTrack(name, trace, simulateLegacy(trace)))
    }
    const s = (x: number[]) => x.slice().sort((a, b) => a - b)
    console.log('minutes', minutes.toFixed(1), 'drops', drops, 'per hr', (drops / minutes * 60).toFixed(0))
    console.log('drops w/ build conf', dropsBuild, 'corroborated', dropsCorr, 'lone(no build)', dropsLone, 'lone&uncorroborated', dropsLoneUncorr)
    console.log('prior drops within 32 bars histogram (0..5+)', dropsWithin32.join(','))
    console.log('drop gap bars q10/50/90', quantile(s(dropGapBars), 0.1), quantile(s(dropGapBars), 0.5), quantile(s(dropGapBars), 0.9))
    console.log('per-track drops/min q10/50/90', quantile(s(perTrackDropsPerMin), 0.1).toFixed(2), quantile(s(perTrackDropsPerMin), 0.5).toFixed(2), quantile(s(perTrackDropsPerMin), 0.9).toFixed(2))
    console.log('buildStarts', builds, 'changes(events)', sc)
    console.log('sectionChange raw strength q10/50/90', quantile(s(scStrength), 0.1), quantile(s(scStrength), 0.5), quantile(s(scStrength), 0.9), 'n', scStrength.length)
    console.log('drops w/ breakdown within 16 beats', (globalThis as any).__brk16, 'within 64 beats', (globalThis as any).__brk64, 'same-frame drop-boundary echo', (globalThis as any).__echo)
    console.log('drop edges', ctx.n, 'build now', ctx.sustainNow, 'build within 16 beats', ctx.within16, 'within 128 beats', ctx.within128)
    perTrackCuts.sort((a, b) => b[1] - a[1])
    console.log('per-track cuts/min q10/50/90/max', quantile(perTrackCuts.map((x) => x[1]).sort((a, b) => a - b), 0.1).toFixed(2), quantile(perTrackCuts.map((x) => x[1]).sort((a, b) => a - b), 0.5).toFixed(2), quantile(perTrackCuts.map((x) => x[1]).sort((a, b) => a - b), 0.9).toFixed(2), perTrackCuts[0][1].toFixed(2))
    console.log('top 10 cut-rate tracks', JSON.stringify(perTrackCuts.slice(0, 10).map((x) => [x[0].slice(0, 20), +x[1].toFixed(1), +x[2].toFixed(1)])))
    const dir = aggregateCadence(tracksAgg)
    const leg = aggregateCadence(legAgg)
    console.log('DIR', dir.commitsPerMinute.toFixed(2), dir.intervalBars.median, dir.intervalBars.p10, dir.intervalBars.p90, dir.shareBars.in4to32.toFixed(2))
    console.log('LEG', leg.commitsPerMinute.toFixed(2), leg.intervalBars.median, leg.intervalBars.p10, leg.intervalBars.p90, leg.shareBars.in4to32.toFixed(2))
    console.log(JSON.stringify(dir.triggers))
    void distStats
    expect(true).toBe(true)
  }, 600000)
})
