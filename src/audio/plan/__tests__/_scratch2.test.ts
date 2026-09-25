import { describe, it } from 'vitest'
import { STIMULI } from '../../eval/synthSong'
import { analyzeSong } from '../analyzeSong'

describe('scratch2', () => {
  it('fourSections beats', () => {
    const song = STIMULI.fourSections({ sampleRate: 22050 })
    const plan = analyzeSong(song.pcm, song.sampleRate)
    const T = 60 / 128
    const res = plan.beats.map((t) => ((((t / T) % 1) + 1) % 1))
    const lines: string[] = []
    lines.push('cands ' + JSON.stringify(plan.diagnostics.tempo))
    lines.push('phase residual (fraction of beat) per beat: ' + res.map((r) => r.toFixed(2)).join(' '))
    console.log(lines.join('\n'))
  })
})
