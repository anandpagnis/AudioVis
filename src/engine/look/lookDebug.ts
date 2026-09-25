import { CHARACTER_MOODS, type CharacterMood } from '../../audio/characterTypes'
import { lensStyleName } from '../opticalRack'
import type { LookProfile } from './lookRow'

/**
 * The look overlay's data and text (plan P0 "seams": the tuning workflow is to watch real footage, so the
 * profile has to be visible while it plays). Pure and free of singletons, so it is tested without a window;
 * `src/ui/LookDebug.tsx` gathers a snapshot from the live singletons at ~4 Hz and prints these lines.
 *
 * Enabled by `?lookdebug` (`lookFlags.lookDebugEnabled`), which the console forwards to the output window
 * (`lookUrl.ts`). What it shows, top to bottom: where the profile came from and whether consumers are using
 * it, the three strongest moods of the blend, the character confidence and the timbre descriptors, the fast
 * layer (build, drop afterglow, breakdown, intensity gate), the values the post chain is APPLYING, the grade on
 * the GradePass uniforms and the camera / transition picks. Applied values, not the profile's targets: the
 * point of the overlay is to see what reached the screen and compare it with what the row asked for.
 */

/** How often the overlay refreshes. Text at 4 Hz is readable, and cheap enough not to matter to the frame. */
export const LOOK_DEBUG_INTERVAL_MS = 250

/**
 * The grade currently on `GradePass`'s uniforms, published by `PostFXChain` each frame (three assignments)
 * because the tracker that eases it lives inside that component. Identity until the chain first runs.
 */
export const lookDebugProbe = { sat: 1, temp: 0, contrast: 1 }

/** The post-fx values as applied this moment (`performanceState`'s own fields). */
export interface LookDebugApplied {
  bloom: number
  /** Chromatic aberration (the field is called `glitch`). */
  glitch: number
  vignette: number
  fog: number
  trails: number
  echo: number
  lensStyle: number
  lensAmount: number
  mirrorSegments: number
  mirrorTwist: number
  mirrorSpin: number
  mirrorMix: number
  cameraMode: string
  /**
   * What `pickTransitionStyle` most recently chose for the NEXT scene change — not necessarily what actually
   * rendered. `SceneManager`'s commit block can silently downgrade a rack style to `dissolve` when the frame
   * budget can't fund the overlap, and a wipe style the same way when the quality tier is worse than
   * `WIPE_MAX_TIER` — see `committedTransitionStyle` below, which is what the viewer actually saw.
   */
  transitionStyle: string
  /** The style actually committed for the transition in flight (or last one), post any budget/tier downgrade. */
  committedTransitionStyle: string
  transitionActive: boolean
  transitionProgress: number
  /** Live quality tier (0 = richest). Wipe styles need `tier <= wipeMaxTier` — see the `shot` line. */
  qualityTier: number
  wipeMaxTier: number
  /** Tempo -> motion speed: the live BPM, the eased octave distance from 120, and the resulting rate (`tempoRate.ts`). */
  bpm: number
  tempoOctaves: number
  tempoRate: number
  /**
   * The armed next scene (`engine/armedChange.ts`), or null when nothing is armed. `warm` = compiled and ready;
   * `reason` = why this scene (trend / affinity / bpm / look / cost, `armedPick.describeChoice`).
   */
  armed: {
    sceneId: string
    sinceBeat: number
    expiresBeat: number
    gate: string
    warm: boolean
    trigger: string
    reason: string
  } | null
  /** The armed scene's last fit score vs the best candidate, `0.71/0.80`, or ''. */
  armedFit: string
  /** The last arm / confirm outcome (`drop@b140`, `phrase@b152`, `refit@b120`, ...). Always shown. */
  armedLast: string
}

/**
 * The show director's state (`engine/show/showRuntime.showProbe`). `on` false = `?director=legacy`: the old trigger
 * blocks run and there is nothing to report.
 */
export interface LookDebugShow {
  on: boolean
  /** Last decided action `HOLD` / `MICRO` / `CUT`, its reason, and what a MICRO varied ('' otherwise). */
  kind: string
  reason: string
  micro: string
  /** S, T_eff, scene age in bars, pressure 0..1 and bars until the forced-change ceiling. */
  S: number
  T: number
  age: number
  pressure: number
  etaBars: number
  hold: number
  microCount: number
  cut: number
  forced: number
  /** How the last CUT was performed: `armed`, `pick`, `busy`, `refused`. */
  cutHow: string
}

/** Everything one overlay refresh prints. */
export interface LookDebugSnapshot {
  look: LookProfile
  character: { valid: boolean; confidence: number }
  applied: LookDebugApplied
  grade: { sat: number; temp: number; contrast: number }
  /** Absent (older callers, tests) prints the director line as off. */
  show?: LookDebugShow
}

/** A number to `d` places, or `-` when it is not finite (a NaN must show up as a dash, never crash the overlay). */
function fmt(x: number, d: number): string {
  return Number.isFinite(x) ? x.toFixed(d) : '-'
}

/** Signed to `d` places (`+0.10`), or `-`. */
function fmtSigned(x: number, d: number): string {
  return Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(d) : '-'
}

/** The `n` heaviest moods of a `CHARACTER_MOODS`-ordered weight vector, heaviest first; zero and non-finite weights are left out. */
export function topMoodWeights(weights: ArrayLike<number>, n = 3): { mood: CharacterMood; weight: number }[] {
  const all: { mood: CharacterMood; weight: number }[] = []
  for (let i = 0; i < CHARACTER_MOODS.length && i < weights.length; i++) {
    const w = weights[i]
    if (Number.isFinite(w) && w > 0) all.push({ mood: CHARACTER_MOODS[i], weight: w })
  }
  all.sort((a, b) => b.weight - a.weight)
  return all.slice(0, n)
}

/** `off`, `kaleido/8` or `vortex -1.02`, from the applied mirror rack (segments >= 3 is a fold, else a twist is a vortex). */
export function mirrorSummary(segments: number, twist: number, mix: number): string {
  if (!(mix > 0.01)) return 'off'
  if (segments >= 2.5) return `kaleido/${Math.round(segments)}`
  if (Math.abs(twist) > 0.01) return `vortex ${fmtSigned(twist, 2)}`
  return 'off'
}

/**
 * The director line: `show CUT drop-fast(armed) S=1.12 T=0.61 age=6.0b P=0.40 next<=26b  H12 M5 C3(f1)`: the last
 * action and why, the score against the effective threshold, the scene's age in bars, the pressure, the bars until the
 * forced ceiling, and the running counts of HOLD / MICRO / CUT (f = how many of the cuts were forced).
 */
export function formatShowLine(show: LookDebugShow | undefined): string {
  if (!show || !show.on) return 'show  director off (?director=legacy: the old triggers run)'
  const how = show.kind === 'CUT' && show.cutHow !== '-' ? `(${show.cutHow})` : ''
  const what = show.kind === 'MICRO' && show.micro ? `:${show.micro}` : ''
  return (
    `show  ${show.kind}${what} ${show.reason}${how} S=${fmt(show.S, 2)} T=${fmt(show.T, 2)} age=${fmt(show.age, 1)}b` +
    ` P=${fmt(show.pressure, 2)} next<=${fmt(show.etaBars, 0)}b  H${fmt(show.hold, 0)} M${fmt(show.microCount, 0)} C${fmt(show.cut, 0)}(f${fmt(show.forced, 0)})`
  )
}

/** The overlay text, one string per line. Total: any snapshot field may be NaN. */
export function formatLookDebug(s: LookDebugSnapshot): string[] {
  const { look, character, applied: a, grade } = s
  const lines: string[] = []

  lines.push(
    `LOOK  source=${look.source}  ${look.valid ? 'profile ON' : 'legacy paths'}  primary=${look.primary ?? '-'}  relax=${fmt(look.relax, 2)}`,
  )
  const top = topMoodWeights(look.weights, 3)
  lines.push('moods ' + (top.length > 0 ? top.map((t) => `${fmt(t.weight, 2)} ${t.mood}`).join('   ') : '-'))
  lines.push(
    `read  conf=${fmt(character.confidence, 2)}${character.valid ? '' : ' (invalid)'}  harsh=${fmt(look.harsh, 2)} busy=${fmt(look.busy, 2)} sparse=${fmt(look.sparse, 2)}`,
  )
  lines.push(
    `fast  build=${fmt(look.buildIntent, 2)} afterglow=${fmt(look.afterglow, 2)} breakdown=${fmt(look.breakdown, 2)} gate=${fmt(look.intensityGate, 2)}`,
  )
  lines.push(
    `post  bloom=${fmt(a.bloom, 2)} ca=${fmt(a.glitch, 4)} vig=${fmt(a.vignette, 2)} fog=${fmt(a.fog, 2)}`,
  )
  lines.push(
    `fb    trails=${fmt(a.trails, 2)} echo=${fmt(a.echo, 2)}  shape z${fmt(look.trailsZoom, 1)} r${fmt(look.trailsRotate, 1)} s${fmt(look.trailsSwirl, 1)} w${fmt(look.trailsWobble, 1)}`,
  )
  lines.push(
    `lens  ${lensStyleName(a.lensStyle)} ${fmt(a.lensAmount, 2)}   mirror ${mirrorSummary(a.mirrorSegments, a.mirrorTwist, a.mirrorMix)} mix=${fmt(a.mirrorMix, 2)} spin=${fmt(a.mirrorSpin, 2)}`,
  )
  lines.push(`grade sat=${fmt(grade.sat, 3)} temp=${fmtSigned(grade.temp, 3)} contrast=${fmt(grade.contrast, 3)}`)
  const downgraded = a.transitionStyle !== a.committedTransitionStyle
  lines.push(
    `shot  camera=${a.cameraMode}  transition: requested=${a.transitionStyle} applied=${a.committedTransitionStyle}` +
      `${downgraded ? ' (DOWNGRADED)' : ''}  active=${a.transitionActive} t=${fmt(a.transitionProgress, 2)}`,
  )
  lines.push(`quality tier=${a.qualityTier} (wipe needs <= ${a.wipeMaxTier})`)
  // The armed next scene: what is waiting, whether it is compiled, how well it still fits, why it was chosen, and
  // what last released or dropped it (the confirm trigger: drop / section / phrase / energy / predicted / age /
  // mood / boundary / build).
  const arm = a.armed
  const fit = a.armedFit ? ` fit=${a.armedFit}` : ''
  lines.push(
    arm
      ? `armed ${arm.sceneId} b${fmt(arm.sinceBeat, 0)}>b${fmt(arm.expiresBeat, 0)} warm=${arm.warm ? 'y' : 'n'} trig=${arm.trigger}${fit}  why=${arm.reason}  last=${a.armedLast}`
      : `armed -  last=${a.armedLast}`,
  )
  lines.push(formatShowLine(s.show))
  lines.push(
    `tempo bpm=${fmt(a.bpm, 0)} oct=${fmtSigned(a.tempoOctaves, 2)} coupling=${fmt(look.tempoCoupling, 2)} -> speed x${fmt(a.tempoRate, 2)}`,
  )
  const f = look.families
  lines.push(
    `family ${f.grade ? 'grade' : '-grade'} ${f.post ? 'post' : '-post'} ${f.scene ? 'scene' : '-scene'} ${f.camera ? 'camera' : '-camera'}`,
  )
  return lines
}
