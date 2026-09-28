import { createShaderScene } from '../engine/createShaderScene'
import { beatMotion, beatSwell, stepBeatMotion, type BeatMotion } from '../engine/beatMotion'
import { drastic } from '../engine/sceneParams'
import { PALETTE_RAMP_GLSL } from '../engine/shaderLib'

/**
 * Wingfold Julia — an animated, beat-locked Julia-set fractal.
 *
 * Started as a clean-room recreation attempt for the (now-disabled, unverified-licence) `juliawings` scene, built
 * from nothing but the classic escape-time Julia formula (`z -> z^2 + c`, Gaston Julia, 1918 — public-domain
 * mathematics) plus a fold trick of my own devising. `c` orbits a small circle just outside the Mandelbrot set's
 * main cardioid, which keeps the set richly connected and constantly morphing.
 *
 * ## The fold
 * The sample point is mirrored with `abs()` on both axes before iterating, which turns a stock Julia set's single
 * spiral arm into a symmetric four-winged form.
 *
 * ## Motion is INSIDE the beat (why it was rebuilt)
 * The old scene ran `c` on wall-clock time and pasted kick-triggered zoom pulses and a randomly gated "big move"
 * (`c` leaping on a spring, a 12% zoom lunge) on top. Two clocks, and every pulse scaled the whole frame: it read as
 * a video looping in the background with events stuck on, "an mp4 trying to be on beat".
 *
 * Now the fractal itself travels on the beat grid (`engine/beatMotion.ts`). Every beat, `c` advances along its
 * orbit by one eased step: most of the travel happens right after the beat line (the hit) and the rest is a glide
 * that settles as the next beat lands. Each beat has a WEIGHT, so the bar has an accent pattern (downbeat biggest)
 * and the first downbeat of every fourth bar is a much bigger step, which is the phrase-level "the set becomes a
 * different set" move, deterministic and always on a bar line instead of a random gate. Because the position is a
 * function of the beat, it is on the beat even where the kick detector missed the hit, and it never jumps or runs
 * backwards.
 *
 * What does NOT happen any more: no whole-frame zoom pulse of any size (the zoom is the user's dial and nothing
 * else), and no jump of `c` in a single frame. The beat reaches the picture as
 *   - `c` stepping along its orbit (the filaments morph),
 *   - a smooth per-beat SWELL of the orbit radius and the wing-fold seam (the set breathes open and relaxes),
 *   - a small frame rotation and colour-ramp step per beat,
 *   - `uTick`, the kick-driven tightening of the escape-colour bands (density, not gain).
 * A slow free drift keeps it alive when no grid is delivered (`beatMotion` free-runs at the tempo).
 *
 * ## Band routing
 *   beat grid          -> c orbit step (weighted, eased), swell of radius / seam, rotation, ramp step
 *   phrase downbeat    -> a much larger c step (every 4th bar)
 *   onKick             -> band spacing tightens (no brightness term)
 *   energy             -> overall brightness + orbit radius
 *   highs              -> filament edge-glow intensity
 *
 * The scene is `tempoLocked`: the factory must not fold the song's tempo into `P.speed`, because the beat grid
 * already carries it and a second multiplier pulls the motion off the grid. The speed dial still scales the steps.
 *
 * ## Parameter neutrality
 * With no audio and no grid the scene renders the authored Julia set, drifting slowly. `fill` (zoom) is exempt from
 * the mood steer (`steerExempt`), so the zoom never changes except by the user's hand.
 */

/** Loop ceiling. GLSL ES 1.00 needs a constant bound; `uMaxIter` early-breaks. */
const MAX_ITER_CAP = 160

/** Weight of each beat in a bar (sums to 4, so a weighted beat averages 1): the downbeat travels furthest. */
const BEAT_WEIGHTS = [1.6, 0.7, 1.0, 0.7] as const

/** Extra weight on the first beat of every fourth bar: the phrase-level step. */
const PHRASE_BONUS = 2.4

/** c-orbit travel per unit of weighted beat, radians (~0.4 rad/s at 120 BPM, about the old orbit rate). */
const C_STEP = 0.2

/** Free drift of the orbit, rad/s, so the set is alive with no beat grid. */
const DRIFT = 0.07

/**
 * Exported so the shader can be compiled AND linked outside the app — the
 * roster convention (see MatrixRainScene). Full source is
 * `SHADER_SCENE_PRELUDE + PALETTE_RAMP_GLSL + FRAG`.
 */
export const FRAG = /* glsl */ `
  uniform float uPhase;
  // uMove: the weighted, eased, speed-scaled beat position. uSwell: the per-beat swell 0..1. uTick: kick tighten.
  // None of these may collide with a name in SHADER_SCENE_PRELUDE (uKick, uBeatSin*, the palette slots, ...) -- a
  // redeclaration at global scope is a GLSL link error that surfaces as a silently BLACK scene.
  uniform float uMove;
  uniform float uSwell;
  uniform float uTick;
  uniform float uOrbitR;
  uniform float uZoom;
  uniform float uContrast;
  uniform float uEnergy;
  uniform float uHighs;
  uniform int uMaxIter;

  void main() {
    vec2 uv = (2.0 * gl_FragCoord.xy - uRes.xy) / uRes.y;

    // NO zoom pulse: the zoom is the user's dial and nothing else. The beat moves the fractal, not the frame.
    float ang = uPhase * 0.25 + uMove * 0.035;
    float ca = cos(ang), sa = sin(ang);
    uv = mat2(ca, -sa, sa, ca) * uv / uZoom;

    // The wing fold: mirror both axes before iterating. The per-beat swell pulls the seam open a little, so the
    // four wings part on the beat and close again before the next.
    vec2 z = abs(uv) - vec2(0.028, 0.021) * uSwell;

    // c orbits just outside the cardioid. uMove steps it along the orbit once per beat (see beatMotion.ts), so the
    // set morphs ON the beat; uPhase is the slow free drift underneath.
    float cPhase = uPhase + uMove * ${C_STEP.toFixed(3)};
    float orbitR = uOrbitR + uSwell * 0.028 + uTick * 0.010 + uEnergy * 0.03;
    vec2 c = orbitR * vec2(cos(cPhase), sin(cPhase * 1.3 + 1.7));

    int n = 0;
    for (int i = 0; i < ${MAX_ITER_CAP}; i++) {
      if (i >= uMaxIter) break;
      z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
      if (dot(z, z) > 256.0) break;
      n++;
    }

    vec3 col;
    if (n >= uMaxIter) {
      // Never escaped: deep interior, walking the ramp's dark end.
      col = mix(uBg, uShadow, 0.4);
    } else {
      // Smooth (renormalised) escape count -- standard public-domain continuous-coloring formula (Vepstas, 1997).
      float log_zmod = log2(dot(z, z)) * 0.5; // == log2(|z|)
      float smoothN = float(n) + 1.0 - log2(log_zmod);

      // Kicks tighten the escape bands: a density change, no gain component.
      float bandScale = 0.045 * (1.0 + 0.30 * uTick);

      // The colour ramp steps with the beat too, so a new configuration arrives in a new colour.
      float t2 = smoothN * bandScale + uPhase * 0.02 + uMove * 0.012;

      col = paletteRamp(t2);

      // Filament glow: brighter right at the escape threshold, boosted by highs, sampled from the LIT slots only.
      float edge = smoothstep(0.0, 1.0, fract(smoothN));
      float edgeBoost = 0.35 + uHighs * 0.55;
      col += paletteLit(t2 + 0.5) * edge * edgeBoost;
      col *= 0.7 + 0.5 * uEnergy;
    }

    // Contrast: below 0.5 opens the vignette and softens the tone curve, above 0.5 tightens the frame and hardens it.
    float vig = mix(0.55, 0.2, uContrast);
    col *= 1.0 - vig * dot(uv, uv);
    col = pow(max(col, 0.0), vec3(mix(1.1, 0.85, uContrast)));

    gl_FragColor = vec4(col * uFade, 1.0);
  }
`

interface WingfoldState {
  /** Free drift phase of the c orbit (radians). */
  drift: number
  /** The beat clock: weighted, eased position; see `engine/beatMotion.ts`. */
  motion: BeatMotion
  /** `motion.eased` at the previous frame, so only the increment is scaled by the speed dial. */
  lastEased: number
  /** Speed-scaled accumulated beat position (weighted beats). Monotone. */
  move: number
  /** The small tier: charged by every detected kick, decaying fast. */
  tick: number
}

export const WingfoldJuliaScene = createShaderScene<WingfoldState>({
  id: 'wingfold',
  frag: FRAG,
  include: PALETTE_RAMP_GLSL,
  tempoLocked: true,
  state: () => ({ drift: 0, motion: beatMotion(), lastEased: 0, move: 0, tick: 0 }),
  uniforms: () => ({
    uPhase: { value: 0 },
    uMove: { value: 0 },
    uSwell: { value: 0 },
    uTick: { value: 0 },
    uOrbitR: { value: 0.7885 },
    uZoom: { value: 1.15 },
    uContrast: { value: 0.5 },
    uEnergy: { value: 0 },
    uHighs: { value: 0 },
    uMaxIter: { value: MAX_ITER_CAP },
  }),
  update({ u, s, P, st, dt, ctx }) {
    const f = ctx.f
    const speed = drastic(P.speed)

    // Slow free drift: what keeps the set alive when no beat grid is being delivered.
    st.drift += dt * DRIFT * speed

    // --- The beat clock. This beat's weight: the bar's accent pattern, plus the phrase step on the first
    // downbeat of every fourth bar.
    const inBar = ((Math.floor(f.beatInBar) % 4) + 4) % 4
    let weight: number = BEAT_WEIGHTS[inBar]
    if (inBar === 0 && Math.floor(f.bar) % 4 === 0) weight += PHRASE_BONUS
    stepBeatMotion(st.motion, f.beatIndex, f.beatProgress, weight, dt, f.bpm)
    st.move += Math.max(0, st.motion.eased - st.lastEased) * speed
    st.lastEased = st.motion.eased

    // --- The small tier: every detected kick tightens the escape bands. Reaches no brightness term.
    if (s.onKick > 0) st.tick = Math.min(1, st.tick + s.onKick * 0.55)
    st.tick *= Math.exp(-dt * 5.0)

    u.uPhase.value = st.drift
    u.uMove.value = st.move
    // The swell is the beat's attack-and-relax, scaled by how heavy this beat is (the phrase downbeat swells 1.6x).
    u.uSwell.value = beatSwell(f.beatProgress) * Math.min(1.6, weight / 1.6)
    u.uTick.value = st.tick
    u.uOrbitR.value = 0.55 + P.shape * 0.35 // 0.55..0.9 -- character of the set
    u.uZoom.value = 0.75 + P.fill * 0.9
    u.uContrast.value = P.contrast
    u.uEnergy.value = s.energy
    u.uHighs.value = s.highs

    // No quality-tier coupling (F129): the tier's job is resolution, via the global pixelBudget/performanceCost
    // system, not escape-time detail. Only the complexity dial spans the range.
    u.uMaxIter.value = Math.max(30, Math.round(30 + P.complexity * (MAX_ITER_CAP - 30)))
  },
})
