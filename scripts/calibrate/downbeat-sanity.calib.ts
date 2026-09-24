/**
 * Downbeat (bar-phase) estimator SANITY check. NOT an accuracy gate: no corpus this repo has carries
 * downbeat annotations (PMEmo/DEAM are valence/arousal ratings). It answers two narrow questions about
 * `src/audio/structure/downbeat.ts` as wired into the same per-frame pipeline `AudioEngine` runs:
 *
 *   A. SYNTHETIC drum tracks with a KNOWN bar line (a real kick/bass/snare/hat synth pushed through the whole
 *      DSP chain: FFT -> bands -> percussion -> beat grid -> salience -> estimator). Does it adopt the RIGHT
 *      phase when there is a real accent, and stay at the legacy `beatIndex % 4` (never lock) when there is not
 *      (equal four-on-the-floor, ambient, timing jitter)? Reports how often the legacy phase was right.
 *   B. REAL clips (PMEmo chorus excerpts): how often does it adopt an offset at all, how early, and does it
 *      FLAP (change the offset again after adopting)? With no ground truth this can only say "neither always
 *      locked on noise nor flapping" - it cannot say the adopted phase is right.
 *
 *   npm run calibrate -- scripts/calibrate/downbeat-sanity.calib.ts
 *   (or, memory-lean:  node --max-old-space-size=1536 ./node_modules/vitest/vitest.mjs run \
 *        --config vitest.calibration.config.ts scripts/calibrate/downbeat-sanity.calib.ts)
 *
 * Knobs: DBN_LIMIT=N  PMEmo clips, deterministic sample (default 20; 0 = every clip)
 *        DBN_SEED=n   sampling seed (default 1)
 *        DBN_SYNTH=0  skip part A
 *        DBN_GATE=x   grid-confidence gate for usable beats (default: the engine's DOWNBEAT_MIN_GRID_CONF)
 *        DBN_LOOP=k   part B: repeat each clip k times back to back (default 1). Emulates a longer track so the
 *                     estimator has time to lock; the seams are grid slips, i.e. a stress test for hysteresis.
 *
 * Output (gitignored, derived): corpus/structure/downbeat-sanity.md + .json
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeMp3File } from './decode'
import { runTrack, type BeatSample } from './features'
import { mean, rng } from './stats'

const ROOT = resolve(__dirname, '../..')
const PMEMO = join(ROOT, 'corpus/emotion/pmemo/extracted/PMEmo2019/chorus')
const OUT_DIR = join(ROOT, 'corpus/structure')

const LIMIT = process.env.DBN_LIMIT === undefined ? 20 : Math.max(0, Number(process.env.DBN_LIMIT) || 0)
const SEED = Number(process.env.DBN_SEED) || 1
const RUN_SYNTH = process.env.DBN_SYNTH !== '0'
const GATE = process.env.DBN_GATE === undefined ? undefined : Number(process.env.DBN_GATE)
const LOOP = Math.max(1, Math.floor(Number(process.env.DBN_LOOP) || 1))
/** Beats before this time are warm-up (the grid needs to lock before a bar phase means anything). */
const WARM_SEC = 8

/* ------------------------------------------------------------------------------------------------
 * Synthetic material
 * ---------------------------------------------------------------------------------------------- */

const SR = 44100

interface SynthSpec {
  name: string
  bpm: number
  seconds: number
  /** Kick amplitude by bar position (0 = the true downbeat). 0 = no kick. */
  kick: [number, number, number, number]
  /** A bass note (55 Hz, 0.4 s) on the downbeat, amplitude. */
  bassOnOne: number
  /** Snare (noise) on beats 2 and 4. */
  snare: number
  /** Eighth-note hats. */
  hat: number
  /** Continuous pad (ambient), amplitude. */
  pad: number
  /** Per-hit timing jitter, seconds (uniform +-). */
  jitter: number
  /** First downbeat time. */
  t0: number
  /** Expected: should the estimator ADOPT the true phase? */
  expectLock: boolean
}

function addKick(buf: Float32Array, at: number, amp: number) {
  const n = Math.floor(0.25 * SR)
  for (let i = 0; i < n && at + i < buf.length; i++) {
    const t = i / SR
    const env = Math.exp(-t / 0.07)
    const f = 48 + 95 * Math.exp(-t / 0.03)
    buf[at + i] += amp * env * Math.sin(2 * Math.PI * f * t)
  }
}
function addBass(buf: Float32Array, at: number, amp: number) {
  const n = Math.floor(0.4 * SR)
  for (let i = 0; i < n && at + i < buf.length; i++) {
    const t = i / SR
    buf[at + i] += amp * Math.exp(-t / 0.25) * Math.sin(2 * Math.PI * 55 * t)
  }
}
function addNoise(buf: Float32Array, at: number, amp: number, decay: number, rand: () => number) {
  const n = Math.floor(decay * 3 * SR)
  let prev = 0
  for (let i = 0; i < n && at + i < buf.length; i++) {
    const white = rand() * 2 - 1
    const hp = white - prev * 0.9
    prev = white
    buf[at + i] += amp * Math.exp(-(i / SR) / decay) * hp
  }
}

function synth(spec: SynthSpec, seed: number): Float32Array {
  const rand = rng(seed)
  const buf = new Float32Array(Math.floor(spec.seconds * SR))
  const period = 60 / spec.bpm
  const jit = () => (rand() * 2 - 1) * spec.jitter
  const total = Math.floor((spec.seconds - spec.t0) / period)
  for (let n = 0; n < total; n++) {
    const pos = n % 4
    const t = spec.t0 + n * period
    const at = (dt: number) => Math.max(0, Math.floor((t + dt + jit()) * SR))
    if (spec.kick[pos] > 0) addKick(buf, at(0), spec.kick[pos])
    if (pos === 0 && spec.bassOnOne > 0) addBass(buf, at(0), spec.bassOnOne)
    if ((pos === 1 || pos === 3) && spec.snare > 0) addNoise(buf, at(0), spec.snare, 0.06, rand)
    if (spec.hat > 0) {
      addNoise(buf, at(period / 2), spec.hat, 0.02, rand)
      addNoise(buf, at(0), spec.hat * 0.7, 0.02, rand)
    }
  }
  if (spec.pad > 0) {
    for (let i = 0; i < buf.length; i++) {
      const t = i / SR
      buf[i] +=
        spec.pad * (Math.sin(2 * Math.PI * 220 * t) + 0.7 * Math.sin(2 * Math.PI * 277.2 * t) + 0.5 * Math.sin(2 * Math.PI * 329.6 * t)) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.1 * t))
    }
  }
  let peak = 0
  for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]))
  if (peak > 0) for (let i = 0; i < buf.length; i++) buf[i] *= 0.85 / peak
  return buf
}

const SYNTH: SynthSpec[] = [
  { name: 'rock 1-heavy (kick 1.0/.45/.7/.45, bass on 1, snare 2+4, 8th hats)', bpm: 120, seconds: 100, kick: [1, 0.45, 0.7, 0.45], bassOnOne: 0.6, snare: 0.5, hat: 0.15, pad: 0, jitter: 0, t0: 1.13, expectLock: true },
  { name: 'kick on 1 & 3, 1 stronger (1.0/0/.55/0), bass on 1', bpm: 100, seconds: 110, kick: [1, 0, 0.55, 0], bassOnOne: 0.6, snare: 0.5, hat: 0.1, pad: 0, jitter: 0, t0: 0.71, expectLock: true },
  { name: 'accented 1 + timing jitter +-20 ms', bpm: 128, seconds: 100, kick: [1, 0.5, 0.65, 0.5], bassOnOne: 0.5, snare: 0.4, hat: 0.15, pad: 0, jitter: 0.02, t0: 0.9, expectLock: true },
  { name: 'EQUAL four-on-the-floor (no accent), 8th hats', bpm: 124, seconds: 100, kick: [1, 1, 1, 1], bassOnOne: 0, snare: 0, hat: 0.15, pad: 0, jitter: 0, t0: 1.3, expectLock: false },
  { name: 'EQUAL four-on-the-floor + timing jitter +-20 ms', bpm: 124, seconds: 100, kick: [1, 1, 1, 1], bassOnOne: 0, snare: 0, hat: 0.15, pad: 0, jitter: 0.02, t0: 1.3, expectLock: false },
  { name: 'kick on 1 & 3 EQUAL', bpm: 110, seconds: 100, kick: [1, 0, 1, 0], bassOnOne: 0, snare: 0.5, hat: 0.1, pad: 0, jitter: 0, t0: 0.6, expectLock: false },
  { name: 'ambient pad, no drums', bpm: 90, seconds: 100, kick: [0, 0, 0, 0], bassOnOne: 0, snare: 0, hat: 0, pad: 0.3, jitter: 0, t0: 0, expectLock: false },
]

interface BeatStats {
  beats: number
  lockedShare: number
  firstLockSec: number
  /** Among locked beats: share where beatInBar matches the true bar position. */
  correctWhenLocked: number
  /** Share (of all post-warm beats) where the LEGACY `beatIndex % 4` matches the true bar position. */
  legacyCorrect: number
  /** Share (of all post-warm beats) of the FINAL reported beatInBar matching the true bar position. */
  finalCorrect: number
  flips: number
}

function trueBarPos(t: number, t0: number, period: number): number {
  const k = Math.round((t - t0) / period)
  return ((k % 4) + 4) % 4
}

function beatStats(beats: readonly BeatSample[], t0: number, period: number): BeatStats {
  const b = beats.filter((x) => x.t >= WARM_SEC)
  const locked = b.filter((x) => x.downbeatLocked)
  let flips = 0
  for (let i = 1; i < b.length; i++) if (b[i].offset !== b[i - 1].offset) flips++
  const ok = (x: BeatSample, pos: number) => pos === trueBarPos(x.t, t0, period)
  return {
    beats: b.length,
    lockedShare: b.length ? locked.length / b.length : 0,
    firstLockSec: locked.length ? locked[0].t : NaN,
    correctWhenLocked: locked.length ? mean(locked.map((x) => (ok(x, x.beatInBar) ? 1 : 0))) : NaN,
    legacyCorrect: b.length ? mean(b.map((x) => (ok(x, x.beatIndex % 4) ? 1 : 0))) : NaN,
    finalCorrect: b.length ? mean(b.map((x) => (ok(x, x.beatInBar) ? 1 : 0))) : NaN,
    flips,
  }
}

/* ------------------------------------------------------------------------------------------------
 * Real clips
 * ---------------------------------------------------------------------------------------------- */

function indexMp3(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) indexMp3(p, into)
    else if (/\.mp3$/i.test(name)) into.push(p)
  }
  return into
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

interface ClipStats {
  id: string
  durationSec: number
  beats: number
  /** Share of post-warm beats whose grid confidence was usable (>= 0.3, not silent). */
  usableShare: number
  everLocked: boolean
  lockedShare: number
  firstLockSec: number
  /** Times the offset changed after the first adoption (0 for a clean single adoption). */
  reAnchors: number
  /** Offset changes in total, including the first adoption. */
  offsetChanges: number
  maxCandidateConf: number
  /** Adopted offset (last), or -1 if never locked. */
  finalOffset: number
  /** Median grid (tempo) confidence over post-warm beats, and share of beats at/above 0.15 / 0.3. */
  medGridConf: number
  gridAbove15: number
  gridAbove30: number
}

function clipStats(id: string, durationSec: number, beats: readonly BeatSample[]): ClipStats {
  const b = beats.filter((x) => x.t >= WARM_SEC)
  const locked = b.filter((x) => x.downbeatLocked)
  let changes = 0
  let reAnchors = 0
  let seenLock = false
  for (let i = 1; i < b.length; i++) {
    if (b[i].downbeatLocked && !b[i - 1].downbeatLocked) seenLock = true
    if (b[i].offset !== b[i - 1].offset) {
      changes++
      if (seenLock && b[i - 1].downbeatLocked && b[i].downbeatLocked) reAnchors++
    }
  }
  return {
    id,
    durationSec,
    beats: b.length,
    usableShare: b.length ? mean(b.map((x) => (!x.silence && x.gridConfidence >= (GATE ?? 0.3) ? 1 : 0))) : 0,
    everLocked: locked.length > 0,
    lockedShare: b.length ? locked.length / b.length : 0,
    firstLockSec: locked.length ? locked[0].t : NaN,
    reAnchors,
    offsetChanges: changes,
    maxCandidateConf: b.reduce((m, x) => Math.max(m, x.downbeatConfidence), 0),
    finalOffset: locked.length ? locked[locked.length - 1].offset : -1,
    medGridConf: b.length ? b.map((x) => x.gridConfidence).sort((p, q) => p - q)[b.length >> 1] : 0,
    gridAbove15: b.length ? mean(b.map((x) => (x.gridConfidence >= 0.15 ? 1 : 0))) : 0,
    gridAbove30: b.length ? mean(b.map((x) => (x.gridConfidence >= 0.3 ? 1 : 0))) : 0,
  }
}

const pct = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : 'n/a')
const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : 'n/a')

describe('downbeat estimator sanity', () => {
  it.skipIf(!RUN_SYNTH)(
    'A. synthetic tracks with a known bar line',
    () => {
      const lines: string[] = []
      const json: unknown[] = []
      const failures: string[] = []
      lines.push('## A. Synthetic tracks (known bar line)', '')
      lines.push('| track | expect | est bpm | grid conf | salience by true bar pos 1/2/3/4 | beats | locked | first lock (s) | correct when locked | LEGACY correct | FINAL correct | offset changes |')
      lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|')
      for (let i = 0; i < SYNTH.length; i++) {
        const spec = SYNTH[i]
        const pcm = synth(spec, 1000 + i)
        const run = runTrack(pcm, SR, { skipStructure: true, downbeatMinGridConf: GATE })
        const st = beatStats(run.beats, spec.t0, 60 / spec.bpm)
        const late = run.frames.filter((fr) => fr.t >= WARM_SEC)
        const bpmSorted = late.map((fr) => fr.bpm).sort((a, b) => a - b)
        const medBpm = bpmSorted.length ? bpmSorted[bpmSorted.length >> 1] : NaN
        const gridConf = mean(late.map((fr) => fr.confidence))
        // What the estimator was actually fed: mean per-beat salience by TRUE bar position (usable beats only).
        const tOf = new Map(run.beats.map((b) => [b.beatIndex, b.t]))
        const sal: number[][] = [[], [], [], []]
        for (const e of run.salience) {
          const t = tOf.get(e.beatIndex)
          if (t !== undefined && t >= WARM_SEC && e.usable) sal[trueBarPos(t, spec.t0, 60 / spec.bpm)].push(e.salience)
        }
        const salStr = sal.map((a) => (a.length ? mean(a).toFixed(2) : 'n/a')).join('/')
        json.push({ spec: spec.name, ...st })
        lines.push(
          `| ${spec.name} | ${spec.expectLock ? 'lock' : 'stay legacy'} | ${f1(medBpm)} (true ${spec.bpm}) | ${gridConf.toFixed(2)} | ${salStr} | ${st.beats} | ${pct(st.lockedShare)} | ${f1(st.firstLockSec)} | ${pct(st.correctWhenLocked)} | ${pct(st.legacyCorrect)} | ${pct(st.finalCorrect)} | ${st.flips} |`,
        )
        // Collected, not asserted inline, so one bad track does not hide the rest of the table.
        if (spec.expectLock) {
          // A real accent: it should adopt, and the adopted phase should be the true one.
          if (!(st.lockedShare > 0.3)) failures.push(`${spec.name}: never adopted (${pct(st.lockedShare)})`)
          if (!(st.correctWhenLocked > 0.9)) failures.push(`${spec.name}: adopted the wrong phase (${pct(st.correctWhenLocked)})`)
        } else if (!(st.lockedShare < 0.05)) {
          // No accent to find: it must stay on the legacy phase.
          failures.push(`${spec.name}: locked with no accent (${pct(st.lockedShare)})`)
        }
      }
      lines.push('')
      console.log(lines.join('\n'))
      mkdirSync(OUT_DIR, { recursive: true })
      writeFileSync(join(OUT_DIR, 'downbeat-sanity-synth.json'), JSON.stringify(json, null, 2))
      writeFileSync(join(OUT_DIR, 'downbeat-sanity-synth.md'), lines.join('\n') + '\n')
    },
    20 * 60 * 1000,
  )

  const files = existsSync(PMEMO) ? sample(indexMp3(PMEMO), LIMIT, SEED) : []
  it.skipIf(files.length === 0)(
    'B. real clips: adoption rate and flapping (no ground truth)',
    async () => {
      const t0 = Date.now()
      const clips: ClipStats[] = []
      for (let i = 0; i < files.length; i++) {
        try {
          const audio = await decodeMp3File(files[i])
          let pcm = audio.pcm
          if (LOOP > 1) {
            pcm = new Float32Array(audio.pcm.length * LOOP)
            for (let k = 0; k < LOOP; k++) pcm.set(audio.pcm, k * audio.pcm.length)
          }
          const run = runTrack(pcm, audio.sampleRate, { skipStructure: true, downbeatMinGridConf: GATE })
          clips.push(clipStats(files[i].replace(/^.*[\\/]/, '').replace(/\.mp3$/i, ''), run.durationSec, run.beats))
        } catch (e) {
          console.log(`  skip ${files[i]}: ${(e as Error).message}`)
        }
        if ((i + 1) % 5 === 0 || i + 1 === files.length) console.log(`  ${i + 1}/${files.length}, ${((Date.now() - t0) / 1000).toFixed(0)}s`)
      }
      expect(clips.length).toBeGreaterThan(0)
      const ever = clips.filter((c) => c.everLocked)
      const lines: string[] = []
      lines.push('## B. PMEmo clips (real music, NO ground truth)', '')
      lines.push(
        `- ${clips.length} clips (mean ${f1(mean(clips.map((c) => c.durationSec)))} s). Warm-up ${WARM_SEC} s excluded.`,
        `- **Ever adopted an offset: ${ever.length}/${clips.length} (${pct(ever.length / clips.length)})**; mean share of post-warm beats locked: ${pct(mean(clips.map((c) => c.lockedShare)))} (among the clips that locked: ${pct(mean(ever.map((c) => c.lockedShare)))}).`,
        `- Median first-lock time among locked clips: ${f1([...ever.map((c) => c.firstLockSec)].sort((a, b) => a - b)[Math.floor(ever.length / 2)])} s.`,
        `- **Re-anchors after adoption (offset moved while locked): total ${clips.reduce((s, c) => s + c.reAnchors, 0)}, clips with any: ${clips.filter((c) => c.reAnchors > 0).length}.** Offset changes overall (incl. the first adoption): ${clips.reduce((s, c) => s + c.offsetChanges, 0)}.`,
        `- Adopted offsets (final) by phase 0/1/2/3: ${[0, 1, 2, 3].map((p) => clips.filter((c) => c.finalOffset === p).length).join('/')} (a strong skew to 0 would suggest the grid start correlates with the accent, a uniform spread is what a real bar-phase detector should show).`,
        `- Grid (tempo) confidence over post-warm beats: median of clip medians ${mean([...clips.map((c) => c.medGridConf)].sort((a, b) => a - b).slice(clips.length >> 1, (clips.length >> 1) + 1))?.toFixed(2)}; mean share of beats >= 0.15: ${pct(mean(clips.map((c) => c.gridAbove15)))}, >= 0.30: ${pct(mean(clips.map((c) => c.gridAbove30)))}. Usable (gate ${GATE ?? 'engine default'}, not silent): ${pct(mean(clips.map((c) => c.usableShare)))}. Loop x${LOOP}.`,
        '',
        '| clip | dur | beats | med grid conf | usable | locked | first lock | offset | re-anchors | max conf |',
        '|---|---|---|---|---|---|---|---|---|---|',
      )
      for (const c of clips) {
        lines.push(
          `| ${c.id} | ${f1(c.durationSec)} | ${c.beats} | ${c.medGridConf.toFixed(2)} | ${pct(c.usableShare)} | ${pct(c.lockedShare)} | ${f1(c.firstLockSec)} | ${c.finalOffset} | ${c.reAnchors} | ${c.maxCandidateConf.toFixed(2)} |`,
        )
      }
      lines.push('')
      console.log(lines.join('\n'))
      mkdirSync(OUT_DIR, { recursive: true })
      writeFileSync(join(OUT_DIR, 'downbeat-sanity-pmemo.md'), lines.join('\n') + '\n')
      writeFileSync(join(OUT_DIR, 'downbeat-sanity-pmemo.json'), JSON.stringify(clips, null, 2))
      // Weak bounds only: not "always locked", and not flapping.
      expect(ever.length / clips.length).toBeLessThan(0.9)
      expect(Math.max(...clips.map((c) => c.reAnchors))).toBeLessThanOrEqual(2)
    },
    30 * 60 * 1000,
  )
})
