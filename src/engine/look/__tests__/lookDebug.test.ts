import { describe, expect, it } from 'vitest'
import { CHARACTER_MOODS } from '../../../audio/characterTypes'
import LOOK_DEBUG_SRC from '../../../ui/LookDebug.tsx?raw'
import VISUALIZER_SRC from '../../../routes/Visualizer.tsx?raw'
import {
  formatLookDebug,
  formatShowLine,
  LOOK_DEBUG_INTERVAL_MS,
  lookDebugProbe,
  mirrorSummary,
  topMoodWeights,
  type LookDebugShow,
  type LookDebugSnapshot,
} from '../lookDebug'
import { createLookProfile, LENS } from '../lookRow'

function snap(over: Partial<LookDebugSnapshot> = {}): LookDebugSnapshot {
  const look = createLookProfile()
  look.valid = true
  look.source = 'character'
  look.primary = 'euphoric'
  look.relax = 0.12
  look.harsh = 0.42
  look.busy = 0.55
  look.sparse = 0.3
  look.buildIntent = 0.25
  look.afterglow = 0.5
  look.breakdown = 0
  look.intensityGate = 0.7
  look.weights[CHARACTER_MOODS.indexOf('euphoric')] = 0.55
  look.weights[CHARACTER_MOODS.indexOf('uplifting')] = 0.25
  look.weights[CHARACTER_MOODS.indexOf('driving')] = 0.12
  look.weights[CHARACTER_MOODS.indexOf('playful')] = 0.08
  return {
    look,
    character: { valid: true, confidence: 0.71 },
    applied: {
      bloom: 0.82,
      glitch: 0.0031,
      vignette: 0.88,
      fog: 0.04,
      trails: 0.61,
      echo: 0.42,
      lensStyle: LENS.anamorphic,
      lensAmount: 0.24,
      mirrorSegments: 8,
      mirrorTwist: 0,
      mirrorSpin: 0.31,
      mirrorMix: 0.8,
      cameraMode: 'spiral',
      transitionStyle: 'collapse',
      committedTransitionStyle: 'collapse',
      transitionActive: true,
      transitionProgress: 0.4,
      qualityTier: 1,
      wipeMaxTier: 1,
      bpm: 128,
      tempoOctaves: 0.09,
      tempoRate: 1.06,
      armed: null,
      armedFit: '',
      armedLast: '-',
    },
    grade: { sat: 1.06, temp: 0.04, contrast: 1.02 },
    ...over,
  }
}

describe('topMoodWeights', () => {
  it('returns the heaviest moods first, at most n, named', () => {
    const w = new Array<number>(CHARACTER_MOODS.length).fill(0)
    w[CHARACTER_MOODS.indexOf('tense')] = 0.5
    w[CHARACTER_MOODS.indexOf('aggressive')] = 0.3
    w[CHARACTER_MOODS.indexOf('driving')] = 0.15
    w[CHARACTER_MOODS.indexOf('epic')] = 0.05
    expect(topMoodWeights(w, 3)).toEqual([
      { mood: 'tense', weight: 0.5 },
      { mood: 'aggressive', weight: 0.3 },
      { mood: 'driving', weight: 0.15 },
    ])
    expect(topMoodWeights(w, 1)).toHaveLength(1)
  })

  it('leaves out zero, negative and non-finite weights, and copes with a short or empty vector', () => {
    expect(topMoodWeights([])).toEqual([])
    expect(topMoodWeights([0, NaN, -1, Infinity, 0.2])).toEqual([{ mood: CHARACTER_MOODS[4], weight: 0.2 }])
    expect(topMoodWeights(new Array<number>(40).fill(1), 3)).toHaveLength(3)
  })
})

describe('mirrorSummary', () => {
  it('names the fold, the vortex, or off', () => {
    expect(mirrorSummary(8, 0, 0.8)).toBe('kaleido/8')
    expect(mirrorSummary(0, -1.02, 0.5)).toBe('vortex -1.02')
    expect(mirrorSummary(0, 0, 1)).toBe('off')
    expect(mirrorSummary(6, 0, 0)).toBe('off') // faded out: nothing to see
    expect(mirrorSummary(NaN, NaN, NaN)).toBe('off')
  })
})

describe('formatLookDebug', () => {
  it('prints everything the tuning workflow needs', () => {
    const text = formatLookDebug(snap()).join('\n')
    expect(text).toMatch(/source=character/)
    expect(text).toMatch(/profile ON/)
    expect(text).toMatch(/primary=euphoric/)
    expect(text).toMatch(/relax=0\.12/)
    // top three moods, with names, heaviest first (the fourth is left out)
    expect(text).toMatch(/0\.55 euphoric\s+0\.25 uplifting\s+0\.12 driving/)
    expect(text).not.toMatch(/playful/)
    expect(text).toMatch(/conf=0\.71/)
    expect(text).toMatch(/harsh=0\.42 busy=0\.55 sparse=0\.30/)
    expect(text).toMatch(/build=0\.25 afterglow=0\.50 breakdown=0\.00 gate=0\.70/)
    expect(text).toMatch(/bloom=0\.82/)
    expect(text).toMatch(/trails=0\.61 echo=0\.42/)
    expect(text).toMatch(/lens\s+anamorphic 0\.24/)
    expect(text).toMatch(/mirror kaleido\/8 mix=0\.80/)
    expect(text).toMatch(/grade sat=1\.060 temp=\+0\.040 contrast=1\.020/)
    expect(text).toMatch(/camera=spiral\s+transition: requested=collapse applied=collapse/)
    expect(text).not.toMatch(/DOWNGRADED/)
    expect(text).toMatch(/active=true t=0\.40/)
    expect(text).toMatch(/quality tier=1 \(wipe needs <= 1\)/)
    expect(text).toMatch(/tempo bpm=128 oct=\+0\.09 coupling=\d\.\d\d -> speed x1\.06/)
    expect(text).toMatch(/quality tier=1 \(wipe needs <= 1\)/)
    expect(text).toMatch(/armed - {2}last=-/)
  })

  it('prints the armed scene with its reason, fit and last outcome, within the width and line caps', () => {
    const s = snap()
    s.applied.armed = {
      sceneId: 'kifs',
      sinceBeat: 128,
      expiresBeat: 224,
      gate: 'hold',
      warm: true,
      trigger: 'idle',
      reason: 'rise aff.71 bpm+.12 look x1.4 cost x1.3',
    }
    s.applied.armedFit = '0.71/0.80'
    s.applied.armedLast = 'drop@b120'
    const lines = formatLookDebug(s)
    expect(lines.join('\n')).toMatch(
      /armed kifs b128>b224 warm=y trig=idle fit=0\.71\/0\.80 {2}why=rise aff\.71 bpm\+\.12 look x1\.4 cost x1\.3 {2}last=drop@b120/,
    )
    expect(lines.length).toBeLessThanOrEqual(14) // 13 + the show-director line
    for (const l of lines) expect(l.length).toBeLessThan(140)
    s.applied.armed = { ...s.applied.armed, warm: false }
    expect(formatLookDebug(s).join('\n')).toMatch(/warm=n/)
  })

  it('shows the last outcome while nothing is armed, and never prints NaN for a garbage beat', () => {
    const s = snap()
    s.applied.armedLast = 'phrase@b140'
    expect(formatLookDebug(s).join('\n')).toMatch(/armed - {2}last=phrase@b140/)
    s.applied.armed = {
      sceneId: 'kifs',
      sinceBeat: NaN,
      expiresBeat: Infinity,
      gate: 'hold',
      warm: false,
      trigger: 'idle',
      reason: '',
    }
    const text = formatLookDebug(s).join('\n')
    expect(text).not.toMatch(/NaN|Infinity/)
    expect(text).toMatch(/armed kifs b->b- /)
  })

  it('flags a silent downgrade — the requested style did not actually reach the screen', () => {
    const s = snap()
    s.applied.transitionStyle = 'inkDissolve'
    s.applied.committedTransitionStyle = 'dissolve'
    s.applied.qualityTier = 3
    const text = formatLookDebug(s).join('\n')
    expect(text).toMatch(/requested=inkDissolve applied=dissolve \(DOWNGRADED\)/)
    expect(text).toMatch(/quality tier=3 \(wipe needs <= 1\)/)
  })

  it('says so when consumers are on their legacy paths, and which families are switched off', () => {
    const s = snap()
    s.look.valid = false
    s.look.source = 'legacy'
    s.look.primary = null
    s.look.families = { grade: true, post: false, scene: true, camera: false }
    s.character = { valid: false, confidence: 0 }
    const text = formatLookDebug(s).join('\n')
    expect(text).toMatch(/legacy paths/)
    expect(text).toMatch(/primary=-/)
    expect(text).toMatch(/\(invalid\)/)
    expect(text).toMatch(/family grade -post scene -camera/)
  })

  it('never prints NaN or throws, whatever a field holds', () => {
    const s = snap()
    s.applied = { ...s.applied, bloom: NaN, glitch: Infinity, lensStyle: NaN, mirrorSegments: NaN, mirrorMix: NaN }
    s.look.weights.fill(NaN)
    s.look.relax = NaN
    s.grade = { sat: NaN, temp: NaN, contrast: NaN }
    const text = formatLookDebug(s).join('\n')
    expect(text).not.toMatch(/NaN|Infinity/)
    expect(text).toMatch(/moods -/)
  })

  it('is a handful of lines, so it fits a corner', () => {
    const lines = formatLookDebug(snap())
    expect(lines.length).toBeLessThanOrEqual(14) // 13 + the show-director line
    for (const l of lines) expect(l.length).toBeLessThan(140)
  })
})

const SHOW: LookDebugShow = {
  on: true,
  kind: 'CUT',
  reason: 'drop-fast',
  micro: '',
  S: 1.12,
  T: 0.61,
  age: 6,
  pressure: 0.4,
  hold: 12,
  microCount: 5,
  cut: 3,
  cutHow: 'armed',
}

describe('the show-director line', () => {
  it('prints the last action and reason, S, T_eff, age in bars, pressure, `no timer` and the counts', () => {
    const line = formatShowLine(SHOW)
    expect(line).toMatch(/^show {2}CUT drop-fast\(armed\) S=1\.12 T=0\.61 age=6\.0b P=0\.40 no timer {2}H12 M5 C3$/)
  })

  it('names what a MICRO varied and omits the cut method for a non-CUT', () => {
    const line = formatShowLine({ ...SHOW, kind: 'MICRO', reason: 'below-T', micro: 'palette' })
    expect(line).toMatch(/^show {2}MICRO:palette below-T S=/)
    expect(line).not.toMatch(/\(armed\)/)
    expect(formatShowLine({ ...SHOW, kind: 'HOLD', reason: 'refractory' })).toMatch(/^show {2}HOLD refractory S=/)
  })

  it('says the director is off under ?director=legacy, and when no show data is supplied', () => {
    expect(formatShowLine({ ...SHOW, on: false })).toMatch(/director off \(\?director=legacy/)
    expect(formatShowLine(undefined)).toMatch(/director off/)
  })

  it('is one more line in the overlay, within the width cap, and never prints NaN', () => {
    const s = snap({ show: SHOW })
    const lines = formatLookDebug(s)
    expect(lines.some((l) => l.startsWith('show '))).toBe(true)
    for (const l of lines) expect(l.length).toBeLessThan(140)
    const bad = formatLookDebug(snap({ show: { ...SHOW, S: NaN, T: Infinity, age: NaN, pressure: NaN } }))
    expect(bad.join('\n')).not.toMatch(/NaN|Infinity/)
  })
})

describe('overlay plumbing', () => {
  it('starts at identity and refreshes about four times a second', () => {
    expect(lookDebugProbe).toEqual({ sat: 1, temp: 0, contrast: 1 })
    expect(LOOK_DEBUG_INTERVAL_MS).toBeGreaterThanOrEqual(200)
    expect(LOOK_DEBUG_INTERVAL_MS).toBeLessThanOrEqual(300)
  })

  it('the component is a fixed top-left, click-through, monospace overlay with no per-frame React state', () => {
    expect(LOOK_DEBUG_SRC).toMatch(/position:\s*'fixed'/)
    expect(LOOK_DEBUG_SRC).toMatch(/top:\s*8/)
    expect(LOOK_DEBUG_SRC).toMatch(/left:\s*8/)
    expect(LOOK_DEBUG_SRC).toMatch(/pointerEvents:\s*'none'/)
    expect(LOOK_DEBUG_SRC).toMatch(/monospace/)
    expect(LOOK_DEBUG_SRC).not.toMatch(/useState|useFrame|requestAnimationFrame/)
    expect(LOOK_DEBUG_SRC).toMatch(/setInterval\(tick,\s*LOOK_DEBUG_INTERVAL_MS\)/)
    expect(LOOK_DEBUG_SRC).toMatch(/lookDebugEnabled\(\)/)
    expect(LOOK_DEBUG_SRC).toMatch(/if \(!enabled\) return null/)
  })

  it('is mounted in the OUTPUT surface (the window that runs the engine), and nowhere else', () => {
    const output = VISUALIZER_SRC.slice(VISUALIZER_SRC.indexOf('function OutputSurface'), VISUALIZER_SRC.indexOf('function usePrefetchScenes'))
    expect(output).toMatch(/<LookDebug \/>/)
    expect(VISUALIZER_SRC.match(/<LookDebug \/>/g)).toHaveLength(1)
  })
})
