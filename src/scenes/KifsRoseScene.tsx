import { createShaderScene } from '../engine/createShaderScene'
import { beatMotion, stepBeatMotion, type BeatMotion } from '../engine/beatMotion'
import { barPhase, isDownbeat, slew } from '../engine/response'
import { drastic } from '../engine/sceneParams'
import { PALETTE_RAMP_GLSL } from '../engine/shaderLib'

/**
 * Fractal Rose Window — polar-kaleidoscope KIFS mandala, orbit-trap laser lines.
 *
 * Sourced from glslop (shader `fkdh866z`, "Fractal Rose Window" by `ufffd`),
 * CC0-1.0, `provenance_type: "witnessed_generation"`, `parents: []` — the
 * platform's own generation log, not a claimed upload, and no fork lineage to
 * audit. Credited in-source as "glslop agent (Claude)" / model `claude-opus-4-8`.
 * https://glslop.com/api/v1/shaders/fkdh866z carries the record.
 *
 * Colour walks the five-slot palette ramp (`paletteRamp()`, shared via `PALETTE_RAMP_GLSL`); the three orbit-trap
 * layers keep their fixed offsets into the ramp so they read as three distinct colours.
 *
 * ## Nothing in this scene moves the frame in or out (the "bouncing" fix)
 * The rose used to bounce in and out of the screen. Three rounds of easing did not stop it, because the causes were
 * structural, not a lack of smoothing:
 *
 *   1. The mood director steered the `fill` dial (the zoom) ~1.9x between moods, and within a beat on a drop, and
 *      steered `shape` (the wedge count). The scene is now exempt (`steerExempt` in the contract; no
 *      `directorSteers`), so the zoom and the wedge count move only by the user's hand.
 *   2. A per-bar STEP of the wedge count and the fold configuration. The Kaliset fold (`abs(z)/dot(z,z)` iterated) is
 *      a chaotic map, so even an eased step of its inputs swings the fractal's extent outward mid-ease, and a
 *      fractional wedge count leaves seams. There are no steps now: the wedge count is the dial's integer and the
 *      fold configuration is a slow continuous wave over four bars.
 *   3. A 2% bar-long zoom breath. Removed: the scale of the picture is constant.
 *
 * ## Motion is inside the beat
 * The beat reaches the picture as a pure ROTATION of the mandala: each beat advances the spin by one eased step
 * (`engine/beatMotion.ts`: most of the travel right after the beat line, a glide that settles as the next beat
 * lands; the downbeat travels furthest). A rotation cannot bounce, it keeps the extent of the picture exactly, and
 * because it is a function of the beat grid it stays on the beat even where the kick detector missed the hit. A
 * slow free drift keeps it alive when no grid is delivered.
 *
 *   spin (eased, per beat) -> the wedge pattern turns on the beat
 *   fold wave              -> the fractal web slowly morphs, one cycle per four bars, never a step
 *   onKick                 -> orbit-trap line width narrows (full on the downbeat, a quarter elsewhere)
 *   barPhase               -> ramp-position drift
 *   highs                  -> orbit-trap ramp spread (shimmer on hats)
 *   energy                 -> overall brightness
 *
 * No drum term drives brightness. The accent goes to line width and contrast, the downbeat tightens the tone curve
 * rather than flaring (counter-motion).
 *
 * The scene is `tempoLocked`: the beat grid already carries the tempo, and a second multiplier would pull the spin
 * off the grid. The speed dial still scales the steps.
 *
 * No `pixelBudget`: the orbit-trap terms are soft, glow-edged by construction, so downsampling is an option later,
 * but it has not been benchmarked either way. Nothing here adds an iteration: `kifs` is `performanceCost: 'high'`.
 */

/**
 * The fold configuration is `0.5 + FOLD_AMP * sin(...)`, one full cycle per {@link FOLD_CYCLE_BEATS} beats. It is
 * read as `cfg = uFoldStep - 0.5` in the shader. The amplitude matches the old per-bar cycle's spread
 * (`[0.33 .. 0.72]`), but it now arrives as a continuous wave, so the chaotic fold never sees a step.
 */
const FOLD_AMP = 0.17
const FOLD_CYCLE_BEATS = 16

/** Weight of each beat in a bar (sums to 4): the downbeat spins furthest. */
const BEAT_WEIGHTS = [1.6, 0.7, 1.0, 0.7] as const

/** Spin per weighted beat, radians (~0.4 rad/s at 120 BPM, the old rotation rate of one turn per 16 s). */
const SPIN_STEP = 0.2

/** Free drift, rad/s: the fold morph (`sin(th)` in the shader) runs on it, so the web is alive even with no grid. */
const DRIFT = 0.2

/** How fast the wedge count eases to a changed dial, in `slew` rate (only the user's hand changes it now). */
const SYMMETRY_RATE = 6

/**
 * Fraction of the full accent a kick on beat 2, 3 or 4 is worth. The contrast term's `smoothstep(0.45, ...)` floor
 * is unreachable from an off-beat, so those beats reach the line width only.
 */
const OFFBEAT_ACCENT = 0.25

/**
 * How far into the last beat of a bar a kick still counts as the downbeat. Detector latency and a drummer pushing
 * the beat routinely put the bar's first hit tens of milliseconds ahead of the crossing, where `beatInBar` still
 * reads 3. At 120 BPM this is the last ~60 ms of the bar.
 */
const DOWNBEAT_LEAD = 0.88

/** Is this frame close enough to the bar line to count as the downbeat? */
function onDownbeat(beatInBar: number, beatProgress: number): boolean {
  if (isDownbeat(beatInBar)) return true
  return Math.floor(beatInBar) === 3 && beatProgress >= DOWNBEAT_LEAD
}

/** The dial's wedge count, an integer 3..12. */
function wedgeCount(shape: number): number {
  return Math.min(12, Math.max(3, Math.round(3 + shape * 9)))
}

/**
 * Exported so the shader can be compiled AND linked outside the app — the
 * roster convention (see MatrixRainScene). Full source is
 * \`SHADER_SCENE_PRELUDE + PALETTE_RAMP_GLSL + FRAG\`.
 */
export const FRAG = /* glsl */ `
  uniform float uPhase;
  uniform float uSpin;
  // uBeatAccent, NOT uAccent -- uAccent is a vec3 palette slot in
  // SHADER_SCENE_PRELUDE. Redeclaring any prelude uniform at global scope is a
  // GLSL link error the engine surfaces as a silently BLACK scene, which has
  // already cost this project a session; see BeatsScene's note on uKick.
  uniform float uBeatAccent;
  uniform float uFoldStep;
  uniform float uBarSweep;
  // Float, not int: it eases when the user drags the dial, and segAngle = TAU / uSymmetry is continuous in a
  // fractional value. At rest it is always an integer, so the wedges tile exactly.
  uniform float uSymmetry;
  uniform int uIterCount;
  uniform float uMorph;
  uniform float uFill;
  uniform float uContrast;
  uniform float uHighs;
  uniform float uEnergy;

  const int MAXI = 20;
  const float TAU = 6.28318530718;
  mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }


  void main() {
    // Bar-long sine of the bar position, continuous ACROSS the bar line (uBarSweep is a 0..1 sawtooth). It now
    // drives only the slow ramp-position drift below; it does NOT touch the scale of the picture.
    float sweep = sin(uBarSweep * TAU);

    vec2 uv = (gl_FragCoord.xy - 0.5 * uRes.xy) / uRes.y;
    // The scale of the picture is constant: no zoom breath, no beat swell, no steered zoom. (Those were the
    // "bouncing in and out of the screen".) uFill is the user's dial and nothing else.
    uv *= 1.7 / uFill;

    // th: slow free drift, used only by the fold's own gentle morph. uSpin: the beat-locked, eased spin of the
    // wedge pattern, a pure rotation that cannot change the extent of the picture.
    float th = uPhase;

    // Kaleidoscope: fold the plane into N mirrored wedges. The wedge count is the dial's integer (uSymmetry only
    // eases when the user drags the dial); it is never stepped by the music.
    float a = atan(uv.y, uv.x) + uSpin;
    float r = length(uv);
    float segAngle = TAU / float(uSymmetry);
    a = mod(a, segAngle);
    a = abs(a - 0.5 * segAngle);
    vec2 z = vec2(cos(a), sin(a)) * r;

    // Iterated Kaliset fold (abs + inversion) -> ornate nested fractal webs; orbit traps drive the thin laser
    // lines. cfg is a slow continuous wave over four bars (see FOLD_AMP), never a step: the fold is a CHAOTIC map,
    // so a stepped input swings the fractal's extent outward mid-ease however it is eased. Its coefficients below
    // are ~60% of the original for the same reason. cfg = 0 reproduces the authored constants exactly.
    float cfg = uFoldStep - 0.5;
    mat2 R = rot(0.08 * sin(th) + 0.036 * cfg);
    vec2 off = vec2(0.74 + 0.10 * uMorph * sin(th), 0.56 + 0.10 * uMorph * cos(th))
             + vec2(0.031, -0.023) * cfg;
    float t1 = 1.0e9, t2 = 1.0e9, t3 = 1.0e9;
    for (int i = 0; i < MAXI; i++) {
      if (i >= uIterCount) break;
      z = abs(z) / (dot(z, z) + 0.0008);
      z = R * z;
      z -= off;
      t1 = min(t1, dot(z, z));
      t2 = min(t2, abs(z.x));
      t3 = min(t3, length(z - vec2(0.45, 0.18)));
    }

    // Orbit-trap line WIDTH, not gain. Numerator and epsilon scale by the same
    // factor, so the trap-centre value (k*n)/(0 + k*e) == n/e is untouched for
    // any k and only the falloff narrows: a beat reads as the laser lines
    // drawing thinner, with no brightness component at all. This is the axis
    // the old uShock->glow term was moved onto.
    float lw = 1.0 - 0.40 * uBeatAccent;

    // Ramp position. Highs shimmer per frame; the fold wave walks all three trap layers through the palette and
    // the bar sweep drifts them slowly while it does. The fixed 0.05/0.42/0.74
    // offsets still keep the three layers visually distinct.
    float hshift = uHighs * 0.08 + cfg * 0.14 + sweep * 0.030;
    vec3 col = vec3(0.0);
    col += paletteRamp(0.05 + hshift + 0.45 * r) * (0.0060 * lw / (t1 + 0.00060 * lw));
    col += paletteRamp(0.42 - hshift * 0.5 + 0.45 * r) * (0.0042 * lw / (t2 * t2 + 0.00035 * lw));
    col += paletteRamp(0.74 + hshift + 0.45 * r) * (0.0050 * lw / (t3 * t3 + 0.00060 * lw));

    // No drum term here any more. 22 of 22 scenes drove brightness from an
    // audio envelope; this one now drives none of it, and energy is the only
    // thing left that brightens.
    float glowAmt = max(0.3, 1.6 - (uContrast - 0.5) * 1.8) * (1.0 + uEnergy * 0.35);
    col *= glowAmt;

    // Tone map -> hot cores toward white, saturated halos. Hardening (contrast
    // above 0.5) steepens the curve for punchier cores.
    //
    // The downbeat RAISES the exponent, pulling the halos back and leaving the
    // cores: the mandala tightens on the bar line instead of flaring, which is
    // counter-motion (audit: 1 of 22 scenes). The smoothstep floor is above
    // OFFBEAT_ACCENT's ceiling by construction, so beats 2-4 cannot reach this
    // term at any kick strength.
    float hard = smoothstep(0.45, 1.0, uBeatAccent);
    col = col / (1.0 + col);
    col = pow(col, vec3(mix(0.9, 0.68, max(0.0, uContrast - 0.5) * 2.0) + 0.14 * hard));
    col *= 1.0 - 0.18 * dot(uv, uv) * uFill * uFill;

    gl_FragColor = vec4((uBg + col) * uFade, 1.0);
  }
`

interface KifsRoseState {
  /** Free drift of the spin (radians); also drives the fold's own slow rotation. */
  drift: number
  /** The beat clock: weighted, eased position; see `engine/beatMotion.ts`. */
  motion: BeatMotion
  /** `motion.eased` at the previous frame, so only the increment is scaled by the speed dial. */
  lastEased: number
  /** Speed-scaled accumulated beat position (weighted beats). Monotone. */
  move: number
  /**
   * Beat accent, decaying. Charged in full by a kick on the downbeat and at {@link OFFBEAT_ACCENT} by a kick
   * anywhere else: one envelope with two amplitudes.
   */
  accent: number
  /** Eased wedge count (an integer target; only the user's dial changes it). */
  symmetry: number
}

export const KifsRoseScene = createShaderScene<KifsRoseState>({
  id: 'kifs',
  frag: FRAG,
  include: PALETTE_RAMP_GLSL,
  tempoLocked: true,
  state: () => ({
    drift: 0,
    motion: beatMotion(),
    lastEased: 0,
    move: 0,
    accent: 0,
    symmetry: wedgeCount(0.5),
  }),
  uniforms: () => ({
    uPhase: { value: 0 },
    uSpin: { value: 0 },
    uBeatAccent: { value: 0 },
    uFoldStep: { value: 0.5 },
    uBarSweep: { value: 0 },
    uSymmetry: { value: 6 },
    uIterCount: { value: 14 },
    uMorph: { value: 0.6 },
    uFill: { value: 1.0 },
    uContrast: { value: 0.5 },
    uHighs: { value: 0 },
    uEnergy: { value: 0 },
  }),
  update({ u, s, P, st, dt, ctx }) {
    const f = ctx.f
    const speed = drastic(P.speed)

    // Slow free drift: keeps the mandala alive when no beat grid is being delivered.
    st.drift += dt * DRIFT * speed

    // --- The beat clock: the spin advances one eased step per beat, the downbeat furthest.
    const inBar = ((Math.floor(f.beatInBar) % 4) + 4) % 4
    stepBeatMotion(st.motion, f.beatIndex, f.beatProgress, BEAT_WEIGHTS[inBar], dt, f.bpm)
    st.move += Math.max(0, st.motion.eased - st.lastEased) * speed
    st.lastEased = st.motion.eased

    // The fold configuration: a slow continuous wave over four bars, read off the UN-eased beat position so it
    // never lurches. Never a step.
    const fold = 0.5 + FOLD_AMP * Math.sin((st.motion.linear / FOLD_CYCLE_BEATS) * 2 * Math.PI)

    // The wedge count follows the dial only; slewed so a dial drag does not snap it.
    st.symmetry = slew(st.symmetry, wedgeCount(P.shape), dt, SYMMETRY_RATE, SYMMETRY_RATE)

    // --- Beat accent. One envelope, two amplitudes. Line width and (downbeat only) contrast; never brightness.
    if (s.onKick > 0) {
      const weight = onDownbeat(f.beatInBar, f.beatProgress) ? 1 : OFFBEAT_ACCENT
      st.accent = Math.min(1.2, st.accent + s.onKick * weight)
    }
    st.accent *= Math.exp(-dt * 3.2)

    u.uPhase.value = st.drift
    u.uSpin.value = st.move * SPIN_STEP
    u.uBeatAccent.value = st.accent
    u.uFoldStep.value = fold
    // Continuous 0..1 across the bar; read only as a slow ramp-position drift. Fed `f.beatInBar` (not
    // `f.beatIndex`) so it agrees with the downbeat used above.
    u.uBarSweep.value = barPhase(f.beatInBar, f.beatProgress)
    u.uSymmetry.value = st.symmetry
    // Fold count does not read the quality tier (F129): the tier's job is resolution, via the global
    // pixelBudget/performanceCost system. Complexity's own 4..20 range is the performer's dial alone.
    u.uIterCount.value = Math.round(4 + P.complexity * 16) // 4..20
    u.uMorph.value = P.tilt * 1.2 // matches source's 0..1.2 range
    u.uFill.value = 0.4 + P.fill * 2.1 // matches source's 0.4..2.5 zoom range; exempt from the mood steer
    u.uContrast.value = P.contrast
    u.uHighs.value = s.highs
    u.uEnergy.value = s.energy
  },
})
