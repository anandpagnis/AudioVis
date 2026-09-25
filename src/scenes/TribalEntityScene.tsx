import { createShaderScene } from '../engine/createShaderScene'
import { slew } from '../engine/response'
import { PALETTE_RAMP_GLSL } from '../engine/shaderLib'
import { bipolar, drastic } from './contract'

/**
 * Tribal Entity — a moth-winged, horned fractal presence that watches the room
 * through two glowing slit-pupilled eyes seated in its own eye sockets.
 *
 * ## Provenance — NOT original work
 *
 * The fractal core is the log-map Julia iteration from @christinacoffin's
 * Shadertoy piece (2015) — the same source as the quarantined `juliawings`
 * (`JuliaWingsScene.tsx`) — iterated on by the owner in Shadertoy (retuned
 * framing, line shaping, the three-pose "flap") and then given an eerie pass:
 * eyes placed in the fractal's measured sockets, anti-static, flicker, smoke.
 * A 2026-09-12 provenance audit found this construction derivative of that
 * source, so it is registered `license: 'unverified'` with a provenance record,
 * not `original`. Live by the owner's explicit decision (2026-09-22); resolving
 * the licence with the author is outstanding.
 *
 * ## Cost: 84 -> 24 iterations
 *
 * The owner's Shadertoy version ran 84 orbit iterations: 17.1 ms at 1080p,
 * against 6.4-7.2 ms at 24 on the same rig and run (~2.6x cheaper). `trap`
 * accumulates roughly in proportion to the iteration count, so its divisor is
 * scaled by ITER/84 — that keeps the strokes where they were (without it the
 * whole picture rearranges) while the chaotic "particles" thin out, which was
 * the point. Two compensations for the thinner strokes at 24: a wider line core
 * (COREW 0.024 -> 0.045) and an earlier anti-static fade (0.12..0.5 contours/px
 * instead of 0.9..2.2), which removes the surviving speckle without touching
 * the bold strokes (those sit at ~0.01-0.05 contours/px). An early-out on orbit
 * convergence was tried at 84 and bought nothing; the orbit is chaotic almost
 * everywhere.
 *
 * ## Smoothness: every input is a swell, never a step
 *
 * A recording of the first reactive version (2026-09-23) measured, frame to
 * frame, zoom jumps of 5-10% and luma swings of up to 35%, and a shape flipping
 * between two poses on alternate frames. Three causes, all fixed here:
 *
 *   - The kick zoom read the raw drum envelope, which attacks in ONE frame.
 *     Kick and snare now arrive as {@link SWELL}s: two cascaded slews, a
 *     rounded hump that starts rising on the hit and peaks ~100 ms later.
 *   - The snare shivered CY at 7.5 Hz. The fractal is extremely sensitive to
 *     CY (0.0035 was a fifth of the whole flap range), so sampled at 30-60 fps
 *     that flipped the body between shapes. Nothing audio-driven touches CY now
 *     except the mids-gated flap, which is slow by construction. (The rare
 *     "twitch" jolt went for the same reason.)
 *   - The candle flicker ran value noise at 8 cells/s with 67% depth — a new
 *     random brightness target every ~5 frames. Now 2.2 cells/s at 40%.
 *
 * The post chain had the same defect (bloom, aberration and lens riding
 * `beatPulse`'s one-frame spike); this scene opts out of it via
 * `FLOW_POST_SCENES` in PerformanceStateBridge.tsx.
 *
 * ## What reacts to what
 *
 *   mids      THE HOLD. The three-pose flap runs on its own clock, which only
 *             advances while the mids are playing — when they drop out, the
 *             entity holds its pose; when they come back, it moves again. The
 *             iris fibres drift on the same signal.
 *   camera    ZOOM. CameraDirector already pulls the camera in on energy and
 *             pulse and moves it per mode; its distance from this scene's anchor
 *             becomes the fractal's zoom (push = slow zoom in, pull = zoom out,
 *             spiral = breathing in and out, locked = hold), and its sideways
 *             angle becomes a gentle tilt (orbit/cinematic rock, handheld
 *             sways). Both eased, so a camera cut glides instead of jumping.
 *   kick      A zoom breath, a lift in line brightness, a surge of the glow
 *             travelling along the strands, and a swell in the eyes' glow.
 *   snare     The particle dust glitters: finer contours are let through the
 *             anti-static fade for a moment, then fade back.
 *   hats      Pace the travelling glow along the strands.
 *   bass      Dilates the eyes' slit pupils; thickens the smoke.
 *   energy    Line brightness, quiet to loud; the eyes' resting glow; speeds
 *             the scene's clock (blink, gaze, flicker, smoke) up to 1.5x.
 *   palette   Strands walk the live palette's lit slots (mid/accent/glow); the
 *             eyes run glow (pushed toward white) at the pupil to accent at the
 *             rim, so they are always the hottest thing on screen; smoke takes
 *             the mid slot.
 *
 * ## The eyes
 *
 * Almond lids that close over the iris on a blink (the iris is not squashed);
 * an iris with radial fibres, a bright collarette ring round the pupil and a
 * dark limbal ring at its edge; a vertical slit pupil rimmed with light; a fixed
 * catchlight; lid shading and a dark lid line. Their glow is emitted AFTER the
 * display clip, in linear light, so it can exceed 1.0 — that is what lets the
 * post chain's bloom treat them as light sources rather than bright paint.
 *
 * Dials: `speed` scales every clock; `fill` is a manual zoom on top of the
 * camera's.
 *
 * ## Colour handling
 *
 * Shadertoy writes display values and the display clips each channel at 1.0;
 * that clip is part of this look (a (0.3, 2.7, 3.0) stroke reads as clean cyan
 * only because it clips). Scenes here output LINEAR. So palette colours, which
 * arrive linear, are converted to display space first, the owner's math runs
 * unchanged, the result is clamped to 0..1 exactly as the display would, then
 * decoded back to linear. The palette changes the hue; the tone behaviour — how
 * strokes saturate — stays the owner's.
 */

export const FRAG = /* glsl */ `
  uniform float uT;        // master clock: speed dial x energy
  uniform float uFlap;     // flap clock: advances only while the mids play
  uniform float uTravel;   // travelling-glow phase: hats pace it, kicks surge it
  uniform float uZoom;     // camera distance x fill dial, eased
  uniform float uRoll;     // tilt from the camera's sideways angle, eased
  uniform float uEnergy;   // slewed energy, 0..1
  uniform float uPunch;    // kick as a rounded swell, ~0..1
  uniform float uSparkle;  // snare as a rounded swell, ~0..1
  uniform float uBass;     // slewed bass, 0..1
  uniform float uEyeGlow;  // eye glow drive: energy + kick swell, ~0.35..1.9
  uniform float uIris;     // iris-fibre drift phase: advances with the mids

  #define ITER    24
  #define ZOOM    92.0
  #define CX      -0.058
  #define CY      5.752
  #define DENSITY 14.0
  #define COREW   0.045
  #define SHARP   200.0
  #define CAP     3.0
  #define GAIN    0.60
  #define TALL    0.90

  // Morph stages - small CY offsets around baseline.
  #define STAGE_A  0.000
  #define STAGE_B -0.018
  #define STAGE_C  0.020

  #define EYES       1
  #define EYE_X      0.076
  #define EYE_Y0     0.100
  #define EYE_TRACK  0.85
  #define EYE_TILT   0.38
  #define ANTISTATIC 1.0
  #define FLICKER    0.40   // candle depth...
  #define FLICKER_HZ 2.2    // ...and rate (was 0.67 at 8: read as chop)
  #define SMOKE      0.05

  // Audio reactions (see the header table). Every input arrives pre-smoothed.
  #define KICK_ZOOM   0.035
  #define PUNCH_GLOW  0.18
  #define ENERGY_GLOW 0.55
  #define SPARKLE     1.0
  #define SMOKE_BASS  1.5

  // Eye anatomy, in eye-local units (the lid almond is 0.040 x 0.016).
  #define IRIS_R   0.0078
  #define PUPIL_H  0.0070
  #define PUPIL_W0 0.0015   // slit half-width at rest...
  #define PUPIL_W1 0.0040   // ...and dilated by the bass
  #define EYE_REACH 0.1     // lid distance past which nothing of the eye is drawn

  // Live palette in display space, so the clip-then-decode tone is unchanged.
  vec3 toDisplay(vec3 c){ return pow(max(c, 0.0), vec3(1.0/2.2)); }
  vec3 pal(float t){ return toDisplay(paletteLit(t)); }

  mat2 rot(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
  // exp(-x^2). Not pow(x, 2.0): pow of a negative base is undefined in GLSL,
  // and ANGLE's exp2(2*log2(x)) makes it NaN.
  float gauss(float x){ return exp(-x*x); }
  float hash11(float x){ return fract(sin(x * 127.1) * 43758.5453); }
  float hash21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f*f*(3.0 - 2.0*f);
    return mix(mix(hash21(i), hash21(i + vec2(1,0)), u.x),
               mix(hash21(i + vec2(0,1)), hash21(i + vec2(1,1)), u.x), u.y);
  }
  float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 3; i++){ s += a*vnoise(p); p = p*2.03 + 7.1; a *= 0.5; } return s; }
  float sdVesica(vec2 p, float r, float d){
    p = abs(p);
    float b = sqrt(max(r*r - d*d, 0.0));
    return ((p.y - b)*d > p.x*b) ? length(p - vec2(0.0, b)) : length(p - vec2(-d, 0.0)) - r;
  }
  float blink(float t){
    float P = 4.7, k = floor(t / P);
    float d = abs(t - k*P - hash11(k)*P*0.8 - 0.08);
    return 1.0 - (1.0 - smoothstep(0.0, 0.08, d)) * step(0.3, hash11(k + 19.0));
  }
  vec2 gazeAt(float k){ return vec2(hash11(k*1.7), hash11(k*2.3 + 5.0)) * 2.0 - 1.0; }
  vec2 gaze(float t){ float x = t*0.42, k = floor(x); return mix(gazeAt(k), gazeAt(k + 1.0), smoothstep(0.0, 0.15, fract(x))); }

  void main(){
    vec2 fc = gl_FragCoord.xy;
    vec2 suv = (fc - 0.5*uRes.xy) / uRes.x;               // screen space
    // Camera: the director's distance and sway, the fill dial, a kick breath.
    vec2 uv = rot(uRoll) * suv / (uZoom * (1.0 + KICK_ZOOM * uPunch));

    // Three-pose flap on the mids clock: holds when the mids drop out.
    float t = fract(uFlap * 0.13);
    float s;
    if      (t < 0.25) s = mix(0.0, 1.0, smoothstep(0.0, 1.0, t/0.25));
    else if (t < 0.50) s = mix(1.0, 2.0, smoothstep(0.0, 1.0, (t-0.25)/0.25));
    else if (t < 0.75) s = mix(2.0, 1.0, smoothstep(0.0, 1.0, (t-0.50)/0.25));
    else               s = mix(1.0, 0.0, smoothstep(0.0, 1.0, (t-0.75)/0.25));

    float cyOffset;
    if (s < 1.0) cyOffset = mix(STAGE_A, STAGE_B, s);
    else         cyOffset = mix(STAGE_B, STAGE_C, s - 1.0);

    vec2 c = vec2(CX, CY + cyOffset);

    vec2 z = vec2(-uv.y * TALL, 1.05*uv.x) * ZOOM;

    float trap = 0.0;
    for(int i=0;i<ITER;i++){
      vec2 a = vec2(z.x, abs(z.y));
      float ang = atan(a.y, a.x + 0.81);
      if (ang > 0.0) ang -= 6.28318;
      z = vec2(log(max(length(a), 1e-4)), ang) + c;

      trap += length(z) / max(length(a), 1e-9) * abs(ang);
      trap = clamp(trap, 0.2, 999999.0);
    }
    trap /= 201.0 * float(ITER) / 84.0;       // keeps strokes in place at fewer iterations

    float band = log2(0.5*log2(max(trap/0.579, 1.0001))) * DENSITY;

    float f = abs(fract(band) - 0.5);
    float line = min(pow(COREW/max(f,1e-4), SHARP), CAP);
    float n = smoothstep(0.20, 0.50, line);

    // Particle fade: contours packed densely enough to read as speckle go. A
    // snare lets finer contours through for a moment, so the dust glitters in
    // and fades back rather than flashing.
    float bpp = fwidth(band);
    n *= 1.0 - ANTISTATIC * smoothstep(0.12 + 0.10 * SPARKLE * uSparkle, 0.5 + 0.5 * SPARKLE * uSparkle, bpp);

    // Travelling glow along the filaments: hats pace it, kicks surge it.
    float travel = length(uv * vec2(1.0, 1.5)) * 9.0 + band * 0.6;
    float glow = 4.90 + 0.55 * sin(travel - uTravel);
    float loud = 1.0 - 0.5*ENERGY_GLOW + ENERGY_GLOW * uEnergy + PUNCH_GLOW * uPunch;

    vec3 col = pal(band * 0.035) * n * GAIN * glow * loud;

    // Faint smoke rising through the dark belly of the entity; the bass thickens it.
    float smoke = fbm(suv*vec2(5.0, 3.0) + vec2(0.0, -uT*0.12));
    col += toDisplay(uMid) * smoke * smoke * SMOKE * (1.0 + SMOKE_BASS * uBass) * (1.0 - smoothstep(-0.30, 0.10, suv.y));

    // Linear-light emission added after the display clip (see the header).
    vec3 eyeHDR = vec3(0.0);

  #if EYES
    // Eyes seated in the fractal's own sockets, which rise as CY moves.
    float cyEff = c.y - CY;
    float side = uv.x < 0.0 ? -1.0 : 1.0;
    vec2 ep = rot(EYE_TILT) * (vec2(abs(uv.x), uv.y) - vec2(EYE_X, EYE_Y0 + EYE_TRACK*cyEff));
    float pxE = max(fwidth(ep.x), 1e-6);                  // one screen pixel, in eye units

    // Lids: the almond, squeezed shut by the blink. The iris is NOT squeezed,
    // so the lids close over it rather than the eye flattening.
    float bl = max(blink(uT), 0.05);
    float dEye = sdVesica(vec2(ep.y / bl, ep.x), 0.029, 0.021);

    // Everything below lives within EYE_REACH of the lids — the halo is faded
    // to zero before it — so the other ~90% of the frame skips it. No
    // derivatives are taken inside the branch (pxE is computed above it).
    if (dEye < EYE_REACH) {
      float fill = 1.0 - smoothstep(-pxE, pxE, dEye);

      // Iris, following the gaze (both eyes look the same way on screen).
      vec2 g = gaze(uT) * vec2(0.0075, 0.003);
      vec2 q = ep - vec2(side * g.x, g.y);
      float qr = length(q);
      float r = qr / IRIS_R;                                // 0 centre .. 1 limbus
      vec2 dir = q / max(qr, 1e-6);
      float irisMask = 1.0 - smoothstep(1.0 - pxE/IRIS_R, 1.0 + pxE/IRIS_R, r);

      vec3 hot  = toDisplay(mix(uGlow, vec3(1.0), 0.35));   // hottest colour on screen
      vec3 deep = toDisplay(uAccent);
      float glowAmt = uEyeGlow * (0.88 + 0.12 * sin(uT * 0.9));   // slow breath under the music

      // Radial fibres: noise around the circle, drawn out along the radius and
      // drifting with the mids. Faded when the iris is too few pixels across to
      // carry them, where they would alias into a crawl.
      float fib = vnoise(dir * 2.6 + vec2(r * 0.9 - uIris, 3.1)) * 0.65
                + vnoise(dir * 5.2 + vec2(r * 1.6 + uIris * 0.7, 8.3)) * 0.35;
      float detail = smoothstep(7.0, 14.0, IRIS_R / pxE);
      vec3 irisCol = mix(hot, deep, smoothstep(0.15, 1.0, r)) * mix(1.0, 0.35 + 1.1 * fib, detail);
      irisCol *= 1.0 - 0.7 * smoothstep(0.72, 1.0, r);                     // dark limbal ring
      irisCol += hot * gauss((r - 0.42) / 0.08) * (0.35 + 0.5 * uPunch);            // collarette
      irisCol *= 0.7 + 0.45 * glowAmt;

      // Sclera: a dim ember, darker toward the corners.
      vec3 sclera = deep * 0.16 * (1.0 - 0.6 * smoothstep(0.3, 1.0, abs(ep.x) / 0.02));

      // Vertical slit pupil, dilated by the bass and rimmed with light. Its AA
      // width is one pixel across the slit's narrow axis, worked out analytically.
      float pw = mix(PUPIL_W0, PUPIL_W1, uBass);
      float pd = length(q / vec2(pw, PUPIL_H));
      float pa = pxE / pw;
      float pupil = 1.0 - smoothstep(1.0 - pa, 1.0 + pa, pd);
      float prim = gauss((pd - 1.15) / 0.3) * irisMask;

      vec3 eye = mix(sclera, irisCol, irisMask);
      eye += hot * prim * (0.4 + 0.7 * glowAmt);
      eye *= 1.0 - pupil;
      eye *= 1.0 - 0.45 * smoothstep(0.001, 0.007, ep.y / bl);             // upper lid shade
      eye *= 1.0 - 0.8 * smoothstep(-3.0 * pxE, -0.5 * pxE, dEye);         // lid line
      // Catchlight: a fixed glint up and to the screen-left of each iris.
      float cl = 1.0 - smoothstep(0.0005, 0.0005 + 1.5 * pxE, length(q - vec2(-0.0024 * side, 0.0026)));
      eye += vec3(0.85) * cl * irisMask;

      col = mix(col, eye, fill);

      // Glow, as light: a halo that widens with the music, and a hot core in the
      // iris. Dimmed through a blink so a closed eye only smoulders. Gaussian,
      // not exponential: this is linear light on black, where even a 5% tail
      // displays at ~25% and greys the whole face — the post chain's bloom is
      // what spreads it softly, this only has to seed it.
      vec3 hotLin = mix(uGlow, vec3(1.0), 0.35);
      float open = smoothstep(0.1, 0.6, bl);
      float halo = gauss(max(dEye, 0.0) / (0.006 + 0.008 * glowAmt)) * (1.0 - fill);
      float core = fill * irisMask * (1.0 - pupil) * max(1.0 - r, 0.0);
      eyeHDR = open * (mix(uAccent, uGlow, 0.5) * halo * (0.01 + 0.06 * max(glowAmt - 0.3, 0.0))
                     + hotLin * core * (0.2 + 1.3 * glowAmt));
    }
  #endif

    // Candle flicker over everything: a slow breath, not a strobe.
    float flick = 1.0 - FLICKER * vnoise(vec2(uT * FLICKER_HZ, 1.7));
    float vig = 1.0 - smoothstep(0.18, 1.00, length(suv*vec2(1.0,1.45)));
    col *= flick * vig;

    // Shadertoy clips at the display; this engine is linear. Clip, then decode.
    col = pow(clamp(col, 0.0, 1.0), vec3(2.2));
    col += eyeHDR * flick * vig;
    gl_FragColor = vec4(col * uFade, 1.0);
  }
`

/** Energy can speed the master clock up to (1 + ENERGY_RATE)x. */
const ENERGY_RATE = 0.5
/** Mids level below which the flap holds still, and at which it runs full speed. */
const HOLD_LO = 0.12
const HOLD_HI = 0.45
/** Travelling-glow speed: a base crawl, what the hats add, what a kick swell adds. */
const TRAVEL_BASE = 0.35
const TRAVEL_HATS = 1.0
const TRAVEL_KICK = 1.2
/** Iris-fibre drift: a base rate plus what the mids add. */
const IRIS_BASE = 0.04
const IRIS_MIDS = 0.3
/**
 * Kick and snare as rounded swells: two cascaded slews of the drum envelope,
 * then make-up gain. The envelopes attack in one frame (see PercussionDetector);
 * this starts rising on the hit and peaks ~100 ms later. Simulated at 120-174
 * BPM: the largest per-frame step is ~0.14 of the raw envelope's, and the gain
 * brings the peak back to ~1.
 */
const SWELL = { rise1: 20, fall1: 20, rise2: 12, fall2: 5, gain: 2.5 }
/** This scene's camera anchor — must match its `cameraAnchor` in scenes/index.ts. */
const ANCHOR_DISTANCE = 10.0
/** How strongly camera distance maps to zoom (1 = proportional), and its bounds. */
const CAM_ZOOM_POWER = 0.8
const CAM_ZOOM_MIN = 0.7
const CAM_ZOOM_MAX = 1.6
/** Largest tilt the camera's sideways angle may apply, in radians. */
const MAX_SWAY = 0.2
/** Easing on zoom and sway: slow enough that a camera cut glides. */
const CAMERA_EASE = 3

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))
const smooth01 = (x: number) => {
  const t = clamp(x, 0, 1)
  return t * t * (3 - 2 * t)
}

interface TribalEntityState {
  /** Master clock — replaces Shadertoy's iTime for blink, gaze, flicker, smoke. */
  t: number
  /** Flap clock — advances only while the mids play. */
  flap: number
  /** Travelling-glow phase. */
  travel: number
  /** Iris-fibre drift phase. */
  iris: number
  /** Slewed band levels: a raw band driving an accumulating rate visibly jerks. */
  energy: number
  mids: number
  highs: number
  bass: number
  /** The two stages of each {@link SWELL}. */
  kickA: number
  kickB: number
  snareA: number
  snareB: number
  /** Eased camera mapping, so mode switches and cuts glide rather than jump. */
  zoom: number
  sway: number
}

export const TribalEntityScene = createShaderScene<TribalEntityState>({
  id: 'tribalentity',
  frag: FRAG,
  include: PALETTE_RAMP_GLSL,
  state: () => ({
    t: 0,
    flap: 0,
    travel: 0,
    iris: 0,
    energy: 0,
    mids: 0,
    highs: 0,
    bass: 0,
    kickA: 0,
    kickB: 0,
    snareA: 0,
    snareB: 0,
    zoom: 1,
    sway: 0,
  }),
  uniforms: () => ({
    uT: { value: 0 },
    uFlap: { value: 0 },
    uTravel: { value: 0 },
    uZoom: { value: 1 },
    uRoll: { value: 0 },
    uEnergy: { value: 0 },
    uPunch: { value: 0 },
    uSparkle: { value: 0 },
    uBass: { value: 0 },
    uEyeGlow: { value: 0.35 },
    uIris: { value: 0 },
  }),
  update({ u, s, P, st, dt, ctx }) {
    const rate = drastic(P.speed)
    st.energy = slew(st.energy, s.energy, dt, 3, 3)
    st.mids = slew(st.mids, s.mids, dt, 4, 1.5)
    st.highs = slew(st.highs, s.highs, dt, 6, 2)
    st.bass = slew(st.bass, ctx.b.bass, dt, 5, 2)

    st.kickA = slew(st.kickA, s.kick, dt, SWELL.rise1, SWELL.fall1)
    st.kickB = slew(st.kickB, st.kickA, dt, SWELL.rise2, SWELL.fall2)
    st.snareA = slew(st.snareA, ctx.b.snare, dt, SWELL.rise1, SWELL.fall1)
    st.snareB = slew(st.snareB, st.snareA, dt, SWELL.rise2, SWELL.fall2)
    const punch = clamp(st.kickB * SWELL.gain, 0, 1.2)
    const sparkle = clamp(st.snareB * SWELL.gain, 0, 1.2)

    st.t += dt * rate * (1 + ENERGY_RATE * st.energy)
    // The hold: the flap only advances while the mids are playing.
    st.flap += dt * rate * smooth01((st.mids - HOLD_LO) / (HOLD_HI - HOLD_LO))
    st.travel += dt * rate * 3.0 * (TRAVEL_BASE + TRAVEL_HATS * st.highs + TRAVEL_KICK * punch)
    st.iris += dt * rate * (IRIS_BASE + IRIS_MIDS * st.mids)

    // Camera director -> zoom and sway. The anchor target is the origin.
    const { x, z } = ctx.camera.position
    const dist = Math.max(ctx.camera.position.length(), 0.01)
    const camZoom = clamp(Math.pow(ANCHOR_DISTANCE / dist, CAM_ZOOM_POWER), CAM_ZOOM_MIN, CAM_ZOOM_MAX)
    st.zoom = slew(st.zoom, camZoom * (1 + bipolar(P.fill, 0.3)), dt, CAMERA_EASE, CAMERA_EASE)
    // The director aims with lookAt(), so the camera never rolls; its sideways
    // angle around the anchor is what orbit/cinematic/handheld actually change.
    // sin(yaw) keeps a full orbit a gentle rock rather than a spin.
    const side = Math.hypot(x, z)
    st.sway = slew(st.sway, side > 1e-6 ? (x / side) * MAX_SWAY : 0, dt, CAMERA_EASE, CAMERA_EASE)

    u.uT.value = st.t
    u.uFlap.value = st.flap
    u.uTravel.value = st.travel
    u.uZoom.value = st.zoom
    u.uRoll.value = st.sway
    u.uEnergy.value = st.energy
    u.uPunch.value = punch
    u.uSparkle.value = sparkle
    u.uBass.value = st.bass
    u.uEyeGlow.value = 0.35 + 0.65 * st.energy + 0.9 * punch
    u.uIris.value = st.iris
  },
})
