import { createShaderScene } from '../engine/createShaderScene'
import { criticalDamping, slew, spring, springStep, type SpringState } from '../engine/response'
import { PALETTE_RAMP_GLSL } from '../engine/shaderLib'
import { bipolar, drastic } from './contract'

/**
 * Moth Wings — a symmetric log-polar fractal moth whose wings breathe between
 * two poses while light travels outward along its veins.
 *
 * ## Provenance — NOT original work
 *
 * The owner's Shadertoy piece ("MOTH WINGS — clean B<->C morph"). Its fractal
 * core is the same log-map fold iteration as `tribalentity` — `z -> (log|a|,
 * angle(a)) + c` over `a = (z.x, |z.y|)`, with the same CX/CY and `trap`
 * accumulation, only the pivot (0.11), clamp floor and constants retuned —
 * which descends from @christinacoffin's Shadertoy Julia piece (2015), the
 * source of the quarantined `juliawings`. So it carries the same
 * `license: 'unverified'` and provenance record as `tribalentity`, not
 * `original`. Resolving the licence with the author is outstanding.
 *
 * ## What changed from the Shadertoy version — and what did not
 *
 * The picture is the owner's, unchanged: 44 iterations, every constant, the
 * line shaping, the travelling glow, the vignette and its early-out, and both
 * bottom lobes. Only the drivers changed:
 *
 *   - `iTime` became two accumulated phases (the wingbeat and the glow's
 *     travel), each advanced by a slewed rate. A phase that is INTEGRATED from a
 *     smoothed rate cannot jump — the music changes how fast the moth moves,
 *     never where it is — which is what keeps every reaction here flowing
 *     rather than jittering. No audio envelope reaches the shader raw.
 *   - The cosine palette became the live palette's lit slots.
 *   - The mouse override is gone (there is no mouse on a show output); the
 *     director's camera took over zoom and tilt instead.
 *
 * ## What reacts to what
 *
 *   mids      THE WINGBEAT. The B<->C morph runs on its own clock, whose pace
 *             follows the mids: slower on a sparse passage (never stopped —
 *             a moth that freezes reads as a broken scene), up to ~1.35x the
 *             Shadertoy pace on a full one.
 *   hats      The glow travelling out along the veins races with busy hats and
 *             drifts without them.
 *   kick      A surge in that glow — each kick throws a wave of light outward
 *             from the body that coasts back to cruising speed — and a soft
 *             breath of zoom through a spring, so the hit has weight without
 *             a hard edge.
 *   energy    Line brightness, quiet to loud.
 *   camera    ZOOM and TILT. The director's distance from this scene's anchor
 *             becomes zoom (push = slow zoom in, pull = out, spiral = breathing,
 *             locked = hold); its sideways angle becomes a gentle tilt. Both
 *             eased, so a camera cut or a handheld wobble glides.
 *   palette   Veins walk the live palette's lit slots (mid/accent/glow), so
 *             the moth recolours with the mood and never resolves to black.
 *
 * Dials: `speed` scales both clocks; `fill` is a manual zoom on top of the
 * camera's.
 *
 * ## Colour handling
 *
 * Same treatment as `tribalentity`, for the same reason: Shadertoy writes
 * display values and the display clips each channel at 1.0, and that clip is
 * part of this look (`glow` peaks at 2.2x, so the brightest veins saturate).
 * Scenes here output LINEAR. So palette colours, which arrive linear, go to
 * display space first, the owner's math runs unchanged, the result is clamped
 * to 0..1 exactly as the display would, then decoded back to linear.
 *
 * ## Cost
 *
 * 44 atan+log iterations per pixel with no pixel escaping early — the vignette
 * early-out only fires outside an ellipse wider than any landscape frame, so on
 * a 16:9 canvas it culls nothing. See its SCENE_COST_MS row for the measurement.
 */

export const FRAG = /* glsl */ `
  uniform float uMorph;   // wingbeat phase, in cycles (wrapped 0..1): paced by the mids
  uniform float uTravel;  // travelling-glow phase, radians (wrapped): hats + kick surge
  uniform float uZoom;    // camera distance x fill dial x kick breath
  uniform float uRoll;    // tilt from the camera's sideways angle
  uniform float uBright;  // slewed energy -> line brightness

  #define ITER    44
  #define ZOOM    82.0
  #define CX      -0.058
  #define CY      5.752
  #define DENSITY 12.0
  #define COREW   0.094
  #define SHARP   2.0
  #define CAP     1.0
  #define GAIN    1.00
  #define TALL    0.90

  #define STAGE_B -0.0305
  #define STAGE_C -0.0450

  // Live palette in display space, so the clip-then-decode tone is unchanged.
  vec3 toDisplay(vec3 c){ return pow(max(c, 0.0), vec3(1.0/2.2)); }
  vec3 pal(float t){ return toDisplay(paletteLit(t)); }

  mat2 rot(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

  void main(){
    vec2 suv = (gl_FragCoord.xy - 0.5*uRes.xy) / uRes.x;   // screen space

    // Vignette first, in SCREEN space so the frame edge holds still while the
    // camera zooms. Pixels it has already killed never enter the loop.
    float vig = smoothstep(1.00, 0.18, length(suv*vec2(1.0,1.45)));
    if (vig < 0.003) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

    // Picture space: the director's zoom and tilt, the fill dial, the breath.
    vec2 uv = rot(uRoll) * suv / uZoom;

    float s = 0.5 + 0.5 * sin(uMorph * 6.28318);
    float cyOffset = mix(STAGE_B, STAGE_C, s);

    vec2 c = vec2(CX, CY + cyOffset);

    vec2 z = vec2(-uv.y * TALL, 1.05*uv.x) * ZOOM;

    float trap = 0.0;
    for(int i=0;i<ITER;i++){
      vec2 a = vec2(z.x, abs(z.y));
      float ang = atan(a.y, a.x + 0.11);
      if (ang > 0.0) ang -= 6.28318;
      z = vec2(log(max(length(a), 1e-4)), ang) + c;

      trap += length(z) / max(length(a), 1e-3) * abs(ang);
      trap = clamp(trap, 111.0, 99999.0);
    }
    trap /= 181.0;

    float band = log2(0.5*log2(max(trap/0.579, 1.0001))) * DENSITY;

    float f = abs(fract(band) - 0.5);
    float line = min(pow(COREW/max(f,1e-4), SHARP), CAP);
    float n = smoothstep(0.20, 0.55, line);

    // Travelling glow along the veins: hats pace it, kicks surge it.
    float travel = length(uv * vec2(1.0, 1.5)) * 9.0 + band * 0.6;
    float glow = 1.35 + 0.85 * sin(travel - uTravel);

    vec3 col = pal(band * 0.035) * n * GAIN * glow * uBright;

    col *= vig;

    // Shadertoy clips at the display; this engine is linear. Clip, then decode.
    col = pow(clamp(col, 0.0, 1.0), vec3(2.2));
    gl_FragColor = vec4(col * uFade, 1.0);
  }
`

const TAU = Math.PI * 2

/** The Shadertoy wingbeat, in cycles per second. */
const MORPH_SPD = 0.55
/** Wingbeat pace with the mids silent, and how much a full mid band adds. */
const MORPH_FLOOR = 0.45
const MORPH_MIDS = 0.9
/** The Shadertoy glow speed, in radians per second. */
const TRAVEL_SPD = 3.0
/** Glow speed with no hats, and how much busy hats add. */
const TRAVEL_FLOOR = 0.55
const TRAVEL_HATS = 0.9
/** Extra glow speed a full kick surge adds, in radians per second. */
const SURGE_SPD = 8.0
/** Line brightness at silence, and how much full energy adds. */
const BRIGHT_FLOOR = 0.75
const BRIGHT_ENERGY = 0.45
/** Kick breath: zoom depth, and the spring that carries it. */
const BREATH_ZOOM = 0.06
const BREATH_STIFFNESS = 60
const BREATH_DAMPING = criticalDamping(BREATH_STIFFNESS) * 0.85
/** This scene's camera anchor — must match its `cameraAnchor` in scenes/index.ts. */
const ANCHOR_DISTANCE = 10.0
/** How strongly camera distance maps to zoom (1 = proportional), and its bounds. */
const CAM_ZOOM_POWER = 0.8
const CAM_ZOOM_MIN = 0.7
const CAM_ZOOM_MAX = 1.6
/** Largest tilt the camera's sideways angle may apply, in radians. */
const MAX_SWAY = 0.2

/**
 * Longest step the two clocks take in one frame. The engine already caps a
 * frame at 0.1 s; after a stall (a tab returning, a GC pause) that would still
 * skip the wings a quarter-beat ahead in one frame. Capped to the same 1/30 s
 * the slews and spring use, a stall reads as a pause rather than a skip.
 */
const MAX_CLOCK_STEP = 1 / 30

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

/** The audio one frame reads. `LilimAudioState` satisfies it as-is. */
export interface MothWingsAudio {
  energy: number
  mids: number
  highs: number
  kick: number
}

/** The dials one frame reads. `ResolvedSceneParams` satisfies it as-is. */
export interface MothWingsDials {
  speed: number
  fill: number
}

/** The director camera's position. A `THREE.Vector3` satisfies it as-is. */
export interface MothWingsCamera {
  x: number
  y: number
  z: number
}

export interface MothWingsState {
  /** Wingbeat phase in cycles, wrapped to 0..1 so float precision never erodes. */
  morph: number
  /** Travelling-glow phase in radians, wrapped to 0..TAU. */
  travel: number
  /**
   * Slewed band levels. Each one drives a RATE, and a raw band driving a rate
   * turns every flicker in the analysis into a visible lurch in speed.
   */
  energy: number
  mids: number
  highs: number
  /** Kick surge — fast in, slow out — added to the glow's speed. */
  surge: number
  /** Spring carrying the kick breath, so a hit swells in rather than snapping. */
  breath: SpringState
  /** Eased camera zoom and tilt, so mode switches and handheld wobble glide. */
  camZoom: number
  roll: number
  /** Outputs: final zoom (camera x fill x breath) and line brightness. */
  zoom: number
  bright: number
}

export function createMothWingsState(): MothWingsState {
  return {
    morph: 0,
    travel: 0,
    energy: 0,
    mids: 0,
    highs: 0,
    surge: 0,
    breath: spring(0),
    camZoom: 1,
    roll: 0,
    zoom: 1,
    bright: BRIGHT_FLOOR,
  }
}

/**
 * Advance one frame. Pure over its inputs (no engine, no GL), so the "flows,
 * never jitters" property is testable directly — see MothWingsScene.test.ts.
 */
export function stepMothWings(
  st: MothWingsState,
  s: MothWingsAudio,
  P: MothWingsDials,
  cam: MothWingsCamera,
  dt: number,
): void {
  const rate = drastic(P.speed)
  st.energy = slew(st.energy, s.energy, dt, 2.5, 1.2)
  st.mids = slew(st.mids, s.mids, dt, 1.5, 0.8)
  st.highs = slew(st.highs, s.highs, dt, 3, 1.5)
  st.surge = slew(st.surge, s.kick, dt, 18, 3.5)
  springStep(st.breath, s.kick, dt, BREATH_STIFFNESS, BREATH_DAMPING)

  // Integrated, never set: the music changes how fast the moth moves, not
  // where it is, so nothing here can jump.
  const step = isFinite(dt) && dt > 0 ? Math.min(dt, MAX_CLOCK_STEP) : 0
  st.morph += step * rate * MORPH_SPD * (MORPH_FLOOR + MORPH_MIDS * st.mids)
  st.morph -= Math.floor(st.morph)
  st.travel +=
    step * rate * (TRAVEL_SPD * (TRAVEL_FLOOR + TRAVEL_HATS * st.highs) + SURGE_SPD * st.surge)
  st.travel %= TAU

  // Camera director -> zoom and sway. The anchor target is the origin.
  const dist = Math.max(Math.hypot(cam.x, cam.y, cam.z), 0.01)
  const camZoom = clamp(
    Math.pow(ANCHOR_DISTANCE / dist, CAM_ZOOM_POWER),
    CAM_ZOOM_MIN,
    CAM_ZOOM_MAX,
  )
  st.camZoom = slew(st.camZoom, camZoom * (1 + bipolar(P.fill, 0.3)), dt, 4, 4)
  // The director aims with lookAt(), so the camera never rolls; its sideways
  // angle around the anchor is what orbit/cinematic/handheld actually change.
  // sin(yaw) keeps a full orbit a gentle rock rather than a spin.
  const side = Math.hypot(cam.x, cam.z)
  const sway = side > 1e-6 ? (cam.x / side) * MAX_SWAY : 0
  st.roll = slew(st.roll, sway, dt, 3, 3)

  st.zoom = st.camZoom * (1 + BREATH_ZOOM * Math.max(0, st.breath.value))
  st.bright = BRIGHT_FLOOR + BRIGHT_ENERGY * st.energy
}

export const MothWingsScene = createShaderScene<MothWingsState>({
  id: 'mothwings',
  frag: FRAG,
  include: PALETTE_RAMP_GLSL,
  state: createMothWingsState,
  uniforms: () => ({
    uMorph: { value: 0 },
    uTravel: { value: 0 },
    uZoom: { value: 1 },
    uRoll: { value: 0 },
    uBright: { value: BRIGHT_FLOOR },
  }),
  update({ u, s, P, st, dt, ctx }) {
    stepMothWings(st, s, P, ctx.camera.position, dt)
    u.uMorph.value = st.morph
    u.uTravel.value = st.travel
    u.uZoom.value = st.zoom
    u.uRoll.value = st.roll
    u.uBright.value = st.bright
  },
})
