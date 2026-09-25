import * as THREE from 'three'
import { createShaderScene } from '../engine/createShaderScene'
import { FULLSCREEN_VERT } from '../engine/glsl'
import { lerpOklab } from '../engine/oklab'
import type { PaletteBlender } from '../engine/palettes'
import { slew } from '../engine/response'
import { PALETTE_RAMP_GLSL } from '../engine/shaderLib'
import { drastic, steps } from './contract'

/**
 * Ink Fluid — a tank of water with ink dropped into it, run as a real fluid
 * simulation (Stam stable fluids), not a picture of one.
 *
 * ## Provenance
 *
 * glslop "Stable Fluids" (shader rys00f2f), CC0 — glslop's own header states
 * everything on it is public domain. A six-pass ISF shader; this is a port of
 * its solver pass for pass, and of the render styles that suit a show — see
 * {@link INK_MODES}.
 *
 * ## Always fluid
 *
 * The source is a playground: its 30 sliders include a reset event, a "still"
 * emitter mode, and ink/force/stir amounts that go to zero, and with the wrong
 * combination the tank sits there as a static blob. (The owner's screenshot of
 * that is `uReset` left on: the solver re-seeds every frame, so nothing moves.)
 * This scene exposes none of that. There is no reset (the tank is seeded once,
 * when its buffers are allocated), no "still" layout, and every quantity that
 * keeps the water moving — emitter force, ink, the roaming stirrer, the
 * simulation clock — has a floor the dials and the audio cannot take it below.
 * `InkFluidScene.test.ts` pins those floors.
 *
 * ## What reacts to what
 *
 *   kick      The emitters push harder and pour more ink on the beat. It is a
 *             FORCE, so the fluid integrates it: a kick becomes a surge that
 *             rolls through the water, never a jump.
 *   mids      The stirrer — a vortex roaming the tank on a figure of eight —
 *             churns harder.
 *   hats      Vorticity confinement: more fine curl in the filaments.
 *   energy    The simulation clock: the whole tank flows faster when it is loud.
 *   camera    Push/pull becomes a gentle zoom INTO the tank (never out: past
 *             the glass there is no water).
 *   palette   Every drop of ink is drawn from the live palette's lit slots, so
 *             the tank recolours with the mood; styles that paint by density
 *             walk the same slots.
 *
 * Every audio input is slewed first (the kick through two cascaded slews), so
 * nothing the music does reaches the solver as a one-frame step.
 *
 * ## How it runs here
 *
 * Five simulation passes run in `update()` into half-float targets cached per
 * renderer; the factory then draws the render style as the scene's output, so
 * palette binding, fade, program caching and prewarm are the factory's.
 *
 * The source ran every pass at window resolution with the stencil spaced by
 * `uCoarse` pixels, because its renderer ignores per-pass sizes. Here the
 * velocity and pressure run on the lattice that spacing was emulating —
 * {@link SIM_ROWS} cells tall at any window size, one texel per cell — and the
 * ink runs on its own finer grid ({@link DYE_ROWS}), sampled bilinearly by the
 * render pass. Same solver, same tank, a fraction of the cost.
 *
 * Both grids are sized from the canvas ASPECT only, not its pixel count, so the
 * quality governor's resolution changes never reallocate (and so never reset)
 * the tank; only a real window reshape does.
 *
 * ## Colour
 *
 * The source's ink and styles are written in display values and clip at the
 * display. Palette colours arrive linear, so they are taken to display space
 * before they become ink, the source's math runs unchanged, and the render pass
 * clamps and decodes back to linear — the same treatment as `tribalentity`.
 */

// =============================================================================
//  Simulation — five passes, lattice units (see the source's notes on half
//  float: every stored quantity is kept order 1, and the pressure solve is
//  written in CELL units so the cell size cancels out of it).
// =============================================================================

const SIM_COMMON = /* glsl */ `
  precision highp float;
  uniform vec2  uSimRes;   // lattice size in cells (= texels)
  uniform float uAsp;      // width / height
  uniform float uDT;       // simulated seconds this frame
  uniform float uSeeding;  // 1.0 on the frame the tank is filled
  uniform float uHashSeed;

  float safe1(float x, float lim){ return (x > -lim && x < lim) ? x : 0.0; }
  vec2  safe2(vec2 v, float lim){ return vec2(safe1(v.x, lim), safe1(v.y, lim)); }
  vec3  safe3(vec3 v, float lim){ return vec3(safe1(v.x, lim), safe1(v.y, lim), safe1(v.z, lim)); }
  float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  float hash1(float n){ return fract(sin(n * 12.9898 + uHashSeed * 7.13) * 43758.5453); }
  vec2  hash2(float n){ return vec2(hash1(n), hash1(n + 17.31)); }

  // World space: y runs 0..1, x runs 0..uAsp, so vortices stay round.
  vec2 worldP(vec2 uv){ return vec2(uv.x * uAsp, uv.y); }

  // The tank's glass. Clamping to the outermost texel centres makes the
  // pressure solve Neumann at the wall (ghost cell = wall cell), which is the
  // boundary condition a closed tank wants.
  vec2 edgeUV(vec2 uv, vec2 texel){ return clamp(uv, 0.5 * texel, 1.0 - 0.5 * texel); }
  vec2 trace(vec2 uv, vec2 v, float dt, vec2 texel){
    return edgeUV(uv - vec2(v.x / uAsp, v.y) * dt, texel);
  }
  float blob(vec2 p, vec2 c, float r){ vec2 d = p - c; return exp(-dot(d, d) / (r * r)); }

  // Free-slip walls: only the component heading out of the tank is removed.
  vec2 walls(vec2 uv, vec2 v){
    vec2 b = 1.5 / uSimRes;
    if (uv.x <       b.x) v.x = max(v.x, 0.0);
    if (uv.x > 1.0 - b.x) v.x = min(v.x, 0.0);
    if (uv.y <       b.y) v.y = max(v.y, 0.0);
    if (uv.y > 1.0 - b.y) v.y = min(v.y, 0.0);
    return v;
  }
`

/** Pass 0 — advect the velocity through itself, then force it. Writes velA. */
export const VEL_FRAG =
  SIM_COMMON +
  /* glsl */ `
  uniform sampler2D tVelB;   // last frame's projected velocity .xy, curl .z
  uniform sampler2D tDye;    // last frame's ink, for buoyancy
  uniform vec2  uDyeTexel;
  uniform vec2  uSrcPos[8];
  uniform vec2  uSrcDir[8];
  uniform int   uSources;
  uniform float uRadius;
  uniform float uForce;
  uniform vec2  uStirP;
  uniform float uStirF;
  uniform float uStirR;
  uniform float uVort;
  uniform float uBuoy;
  uniform float uDrag;

  // The tank does not start still: a stream function, differentiated, gives a
  // velocity field that is divergence free by construction.
  float potential(vec2 p){
    float s = 0.0, f = 3.0, a = 1.0;
    for (int k = 0; k < 4; k++){
      vec2 o = hash2(float(k) * 5.13) * 6.283185;
      s += a * sin(p.x * f + o.x) * sin(p.y * f * 1.13 + o.y);
      f *= 2.03; a *= 0.5;
    }
    return s;
  }
  vec2 seedVelocity(vec2 p){
    float e = 0.01;
    float dx = potential(p + vec2(e, 0.0)) - potential(p - vec2(e, 0.0));
    float dy = potential(p + vec2(0.0, e)) - potential(p - vec2(0.0, e));
    return vec2(dy, -dx) * (0.05 / (2.0 * e));
  }

  void main(){
    vec2 cell = 1.0 / uSimRes;
    vec2 uv = gl_FragCoord.xy * cell;
    vec2 p = worldP(uv);
    vec2 v;

    if (uSeeding > 0.5) {
      v = seedVelocity(p);
    } else {
      vec4 vb = texture2D(tVelB, edgeUV(uv, cell));
      v = texture2D(tVelB, trace(uv, vb.xy, uDT, cell)).xy;

      // Vorticity confinement: give back the curl advection drains out of
      // small eddies, so filaments keep curling instead of fogging out.
      vec2 dx = vec2(cell.x, 0.0), dy = vec2(0.0, cell.y);
      float cL = texture2D(tVelB, edgeUV(uv - dx, cell)).z;
      float cR = texture2D(tVelB, edgeUV(uv + dx, cell)).z;
      float cB = texture2D(tVelB, edgeUV(uv - dy, cell)).z;
      float cT = texture2D(tVelB, edgeUV(uv + dy, cell)).z;
      vec2  gc = vec2(abs(cR) - abs(cL), abs(cT) - abs(cB));
      float gn = length(gc);
      if (gn > 1e-5) {
        vec2 N = gc / gn;
        v += uVort * vec2(N.y, -N.x) * vb.z * uDT * 6.0;
      }

      vec2 f = vec2(0.0);
      for (int i = 0; i < 8; i++){
        if (i >= uSources) break;
        f += uSrcDir[i] * blob(p, uSrcPos[i], uRadius);
      }
      v += f * uForce * 5.0 * uDT;

      // The stirrer: a rotating vortex dragging the water round.
      vec2 d = p - uStirP;
      float r = length(d);
      if (r > 1e-4) v += (vec2(-d.y, d.x) / r) * uStirF * blob(p, uStirP, uStirR) * 2.2 * uDT;

      v.y += uBuoy * lum(texture2D(tDye, edgeUV(uv, uDyeTexel)).rgb) * uDT * 1.6;
      v *= exp(-uDrag * uDT * 4.0);
    }

    v = walls(uv, safe2(v, 40.0));
    gl_FragColor = vec4(v, 0.0, 1.0);
  }
`

/**
 * Passes 1 and 2 — damped Jacobi sweeps of the pressure Poisson equation, in
 * cell units: P = (PL + PR + PB + PT - dvg) / 4. Divergence is a FORWARD
 * difference and the projection a BACKWARD one, so div(grad p) is exactly the
 * compact Laplacian the sweep inverts (the source's MAC-staggering note).
 * Writes prsA (measuring, warm-started from last frame's prsB) then prsB.
 */
export const PRS_FRAG =
  SIM_COMMON +
  /* glsl */ `
  uniform sampler2D tVelA;
  uniform sampler2D tSrc;     // the pressure being relaxed
  uniform float uMeasure;     // 1: first sweep, measures divergence and curl

  void main(){
    vec2 cell = 1.0 / uSimRes;
    vec2 uv = gl_FragCoord.xy * cell;
    vec2 dx = vec2(cell.x, 0.0), dy = vec2(0.0, cell.y);
    vec4 a  = texture2D(tVelA, uv);
    vec4 s0 = texture2D(tSrc, uv);

    float dvg, crl;
    if (uMeasure > 0.5) {
      vec2 vR = texture2D(tVelA, edgeUV(uv + dx, cell)).xy;
      vec2 vT = texture2D(tVelA, edgeUV(uv + dy, cell)).xy;
      dvg = (vR.x - a.x) + (vT.y - a.y);
      crl = (vR.y - a.y) - (vT.x - a.x);
    } else {
      dvg = s0.y; crl = s0.z;              // carried, not recomputed
    }

    float pL = texture2D(tSrc, edgeUV(uv - dx, cell)).x;
    float pR = texture2D(tSrc, edgeUV(uv + dx, cell)).x;
    float pB = texture2D(tSrc, edgeUV(uv - dy, cell)).x;
    float pT = texture2D(tSrc, edgeUV(uv + dy, cell)).x;
    float pj = (pL + pR + pB + pT - dvg) * 0.25;
    // Half steps: a full Jacobi step with this few sweeps a frame injects more
    // divergence than it removes and tears the tank apart.
    float p = mix(s0.x, pj, 0.5);
    if (uSeeding > 0.5) p = 0.0;

    gl_FragColor = vec4(safe1(p, 4000.0), safe1(dvg, 40.0), safe1(crl, 40.0), 1.0);
  }
`

/** Pass 3 — subtract the pressure gradient, and carry the curl. Writes velB. */
export const PROJ_FRAG =
  SIM_COMMON +
  /* glsl */ `
  uniform sampler2D tVelA;
  uniform sampler2D tPrs;

  void main(){
    vec2 cell = 1.0 / uSimRes;
    vec2 uv = gl_FragCoord.xy * cell;
    vec2 v = texture2D(tVelA, uv).xy;
    vec4 P = texture2D(tPrs, uv);
    v -= vec2(P.x - texture2D(tPrs, edgeUV(uv - vec2(cell.x, 0.0), cell)).x,
              P.x - texture2D(tPrs, edgeUV(uv - vec2(0.0, cell.y), cell)).x);
    v = walls(uv, safe2(v, 40.0));
    // Curl of velA equals curl of the projected field (projection removes a
    // gradient, whose curl is zero); the first sweep already measured it.
    gl_FragColor = vec4(v, P.z, 1.0);
  }
`

/**
 * Pass 4 — carry the ink through the incompressible field (MacCormack, clamped
 * to the range it interpolated from), fade it, and pour more in. Runs on the
 * ink grid, which is finer than the lattice.
 */
export const DYE_FRAG =
  SIM_COMMON +
  /* glsl */ `
  uniform sampler2D tDyePrev;
  uniform sampler2D tVelB;
  uniform vec2  uDyeRes;
  uniform vec2  uSrcPos[8];
  uniform vec3  uSrcCol[8];
  uniform int   uSources;
  uniform float uRadius;
  uniform float uInk;
  uniform float uInkFade;
  uniform vec3  uSeedCol[7];

  vec4 inkTap(vec2 uv, vec2 texel){ return texture2D(tDyePrev, edgeUV(uv, texel)); }

  vec3 seedDye(vec2 p){
    vec3 c = vec3(0.0);
    for (int i = 0; i < 7; i++){
      float fi = float(i);
      vec2  q  = vec2(hash1(fi * 1.77 + 0.3) * uAsp, 0.1 + 0.8 * hash1(fi * 2.91 + 5.1));
      float r  = mix(0.05, 0.13, hash1(fi * 4.43 + 9.0));
      c += uSeedCol[i] * blob(p, q, r) * 1.3;
    }
    return c;
  }

  void main(){
    vec2 tx = 1.0 / uDyeRes;
    vec2 cell = 1.0 / uSimRes;
    vec2 uv = gl_FragCoord.xy * tx;
    vec2 p = worldP(uv);
    vec3 d;

    if (uSeeding > 0.5) {
      d = seedDye(p);
    } else {
      vec2 v0 = texture2D(tVelB, edgeUV(uv, cell)).xy;
      vec2 u1 = trace(uv, v0, uDT, tx);
      vec4 q1 = inkTap(u1, tx);
      vec2 v1 = texture2D(tVelB, edgeUV(u1, cell)).xy;
      vec4 q2 = inkTap(trace(u1, -v1, uDT, tx), tx);
      vec4 q  = q1 + 0.5 * (inkTap(uv, tx) - q2);
      // The limiter: neighbours one LATTICE cell away, as in the source.
      vec2 dx = vec2(cell.x, 0.0), dy = vec2(0.0, cell.y);
      vec4 a = inkTap(u1 + dx, tx), b = inkTap(u1 - dx, tx);
      vec4 c = inkTap(u1 + dy, tx), e = inkTap(u1 - dy, tx);
      d = clamp(q, min(min(a, b), min(min(c, e), q1)),
                   max(max(a, b), max(max(c, e), q1))).rgb;
      d *= exp(-uInkFade * uDT * 3.0);

      vec3 ink = vec3(0.0);
      for (int i = 0; i < 8; i++){
        if (i >= uSources) break;
        ink += uSrcCol[i] * blob(p, uSrcPos[i], uRadius);
      }
      d += ink * uInk * 2.4 * uDT;
    }
    gl_FragColor = vec4(clamp(safe3(d, 64.0), 0.0, 16.0), 1.0);
  }
`

// =============================================================================
//  Render — the factory's fragment shader. Photographs the tank.
// =============================================================================

export const FRAG = /* glsl */ `
  uniform sampler2D tDye;    // ink, display-space rgb
  uniform sampler2D tVel;    // projected velocity .xy, curl .z
  uniform vec2  uDyeTexel;
  uniform vec2  uCell;       // one lattice cell, in uv
  uniform float uCellPx;     // one lattice cell, in render pixels
  uniform float uPh;         // forcing phase, 0..1
  uniform float uZoom;       // camera push, >= 1

  #define DREF  0.20         // the dye luminance that reads as fully inked
  #define EDGE  0.8
  #define GLOWK 0.5
  #define VIGN  0.35

  vec3 toDisplay(vec3 c){ return pow(max(c, 0.0), vec3(1.0/2.2)); }
  vec3 pal(float t){ return toDisplay(paletteLit(t)); }
  float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  float squash(float x){ return x / (1.0 + abs(x)); }
  vec2 edgeUV(vec2 uv, vec2 texel){ return clamp(uv, 0.5 * texel, 1.0 - 0.5 * texel); }
  vec3 dyeAt(vec2 uv){ return texture2D(tDye, edgeUV(uv, uDyeTexel)).rgb; }

  void main(){
    vec2 suv = gl_FragCoord.xy / uRes;
    vec2 uv  = (suv - 0.5) / uZoom + 0.5;
    float asp = uRes.x / uRes.y;
    vec2 dx = vec2(uCell.x, 0.0), dy = vec2(0.0, uCell.y);

    float ex = 1.0 / DREF;
    vec3  d  = max(dyeAt(uv), 0.0) * ex;
    float L  = lum(d);

    // Density gradient, one lattice cell across: the filament edges.
    float lR = lum(dyeAt(uv + dx)) * ex, lL = lum(dyeAt(uv - dx)) * ex;
    float lT = lum(dyeAt(uv + dy)) * ex, lB = lum(dyeAt(uv - dy)) * ex;
    vec2  g  = vec2(lR - lL, lT - lB) * 0.5;
    float e  = squash(length(g) * 7.0 * EDGE);

    vec3 col;
    if (uMode == 0) {
      // ink: the body of the ink under a soft exposure that never flattens to
      // a clipped pool, with the source's neon edges riding on it, so dense
      // ink still shows the flow moving through it.
      vec3 blur = (dyeAt(uv + dx * 7.0) + dyeAt(uv - dx * 7.0)
                 + dyeAt(uv + dy * 7.0) + dyeAt(uv - dy * 7.0)) * 0.25 * ex;
      vec3 body = 1.0 - exp(-(d * 0.6 + blur * GLOWK * 0.5));
      col = body * 0.8 + pal(fract(L * 0.45 + uPh)) * e * 1.1;
    } else if (uMode == 1) {
      // neon: edges only, lit from the palette.
      col = pal(fract(L * 0.45 + uPh)) * e * 1.6 + d * 0.06;
    } else {
      // contour: a map of the ink. Line width comes from the density gradient
      // itself (fwidth() was banned in the source's ISF, and this is the same
      // measurement in cell units). Lines take the palette's glow slot.
      float f  = L * 7.0;
      float ln = abs(fract(f) - 0.5) * 2.0;
      float w  = clamp(28.0 * length(g) / uCellPx, 0.004, 0.45);
      col = pal(fract(floor(f) * 0.11 + 0.2)) * (0.28 + 0.5 * smoothstep(0.0, 1.0, L));
      col = mix(vec3(0.02, 0.02, 0.03), col, smoothstep(0.0, 0.02, L));
      col = mix(col, toDisplay(mix(uGlow, vec3(1.0), 0.35)), 1.0 - smoothstep(w, w * 2.4, ln));
    }

    col = max(col, 0.0);
    vec2 vg = (suv - 0.5) * vec2(asp, 1.0);
    col *= 1.0 - VIGN * smoothstep(0.20, 0.95, dot(vg, vg) * 1.6);

    // The source clips at the display; this engine is linear. Clip, then decode.
    col = pow(clamp(col, 0.0, 1.0), vec3(2.2));
    gl_FragColor = vec4(col * uFade, 1.0);
  }
`

// =============================================================================
//  JS side — forcing, audio, and the pass driver
// =============================================================================

const TAU = Math.PI * 2

/** Lattice height in cells: the source's 512 / uCoarse at its default 2.5. */
export const SIM_ROWS = 205
/**
 * Ink grid height in texels. Measured against 1080 on the same run: the same
 * plumes and filaments with marginally softer ripples at the fronts, for 1.0 ms
 * of solver time against 2.4. The grid is fixed-size, so the quality tiers
 * cannot shed its cost on a weaker machine — it has to be affordable there.
 */
export const DYE_ROWS = 720
/** The source's forcing period: every emitter and the stirrer repeat on it. */
const PERIOD = 12
/** The source's hash seed default. */
const HASH_SEED = 7

/** Where the ink comes from. The source's seven minus "still". */
export const LAYOUTS = ['fountains', 'rain', 'orbit', 'collide', 'ring', 'wander'] as const
export type InkLayout = (typeof LAYOUTS)[number]

/** The source's defaults, which every audio and dial mapping below is built around. */
const RADIUS = 0.03
const INK = 1.3
/**
 * Ink fade. The source's 0.10 lets a closed tank fill: measured over 20 s, the
 * interior layouts (orbit, ring, wander) pooled into flat washes that clip over
 * 6-26% of the frame and read as a static blob even while the water moves.
 * At 0.40 only recent ink survives, which is the ink still carrying structure:
 * ~1% clipped, ~25% lit, the most filament edge of any setting tried.
 */
const INK_FADE = 0.4
const FORCE = 1.0
const VORT = 1.1
const DRAG = 0.12
const BUOY = 0.8
const STIR_F = 0.35
const STIR_R = 0.14
const STIR_CENTER = { x: 0.5, y: 0.3 }
const WANDER = 0.55

/** Longest simulated step in one frame: past this the solver stops keeping up. */
const MAX_SIM_DT = 0.05
/** The dials may slow the tank, never stop it. */
export const MIN_SPEED = 0.4
/** The fewest emitters the density dial can leave in the tank. */
export const MIN_SOURCES = 3

/** One frame of audio, in the lilim vocabulary. `LilimAudioState` satisfies it. */
export interface InkAudio {
  energy: number
  mids: number
  highs: number
  kick: number
}

/** The dials one frame reads. `ResolvedSceneParams` satisfies it. */
export interface InkDials {
  speed: number
  shape: number
  density: number
  complexity: number
}

export interface InkFluidState {
  /**
   * Forcing clock in cycles of PERIOD simulated seconds — never wrapped. The
   * source had to wrap it (a half-float seconds counter stops advancing after
   * ~35 s), and its `wander` layout moves on non-integer harmonics of it, so
   * its emitters jumped every period. A JS double has no such limit.
   */
  clock: number
  /** The clock wrapped to 0..1, for the shaders' periodic uses of it. */
  ph: number
  energy: number
  mids: number
  highs: number
  /** The kick through two cascaded slews: a rounded swell, never a step. */
  kickA: number
  kickB: number
  /** Eased camera zoom. */
  zoom: number
  /** Outputs of {@link stepInkFluid}, read by the pass driver. */
  dt: number
  force: number
  ink: number
  stirF: number
  vort: number
  sources: number
  layout: number
}

export function createInkFluidState(): InkFluidState {
  return {
    clock: 0,
    ph: 0,
    energy: 0,
    mids: 0,
    highs: 0,
    kickA: 0,
    kickB: 0,
    zoom: 1,
    dt: 0,
    force: FORCE,
    ink: INK,
    stirF: STIR_F,
    vort: VORT,
    sources: 4,
    layout: 0,
  }
}

/**
 * Advance the JS side one frame: smooth the audio, and turn it and the dials
 * into this frame's solver settings. Pure over its inputs, so the floors that
 * keep the tank fluid are testable without a GPU.
 */
export function stepInkFluid(st: InkFluidState, s: InkAudio, P: InkDials, dt: number): void {
  st.energy = slew(st.energy, s.energy, dt, 2, 1)
  st.mids = slew(st.mids, s.mids, dt, 1.5, 0.8)
  st.highs = slew(st.highs, s.highs, dt, 3, 1.5)
  st.kickA = slew(st.kickA, s.kick, dt, 18, 18)
  st.kickB = slew(st.kickB, st.kickA, dt, 12, 6)
  const kick = Math.min(1, st.kickB * 1.9)

  const frame = isFinite(dt) && dt > 0 ? Math.min(dt, 1 / 30) : 0
  const speed = Math.max(MIN_SPEED, drastic(P.speed)) * (0.85 + 0.45 * Math.min(1, st.energy))
  st.dt = Math.min(MAX_SIM_DT, frame * speed)
  st.clock += st.dt / PERIOD
  st.ph = st.clock - Math.floor(st.clock)

  st.force = FORCE * (1 + 1.5 * kick)
  st.ink = INK * (1 + 0.8 * kick)
  st.stirF = STIR_F + 0.9 * Math.min(1, st.mids)
  st.vort = (0.4 + 1.4 * P.complexity) * (1 + 0.8 * Math.min(1, st.highs))
  // Three at the least: with two, most layouts leave the tank nearly empty.
  st.sources = steps(P.density, MIN_SOURCES, 8)
  st.layout = steps(P.shape, 0, LAYOUTS.length - 1)
}

function hash1(n: number): number {
  const x = Math.sin(n * 12.9898 + HASH_SEED * 7.13) * 43758.5453
  return x - Math.floor(x)
}

/**
 * Position and direction of emitter `i`, for a layout, on the source's
 * formulas, at forcing clock `clock` (cycles, unwrapped — see
 * {@link InkFluidState.clock}). Returns the ink colour's position on the
 * palette, which drifts on the same clock.
 */
export function sourceAt(
  layout: number,
  i: number,
  n: number,
  clock: number,
  asp: number,
  pos: THREE.Vector2,
  dir: THREE.Vector2,
): number {
  const a = (i + 0.5) / n
  const w = TAU * clock
  const j = TAU * hash1(i * 3.71 + 0.5)
  switch (LAYOUTS[layout]) {
    case 'fountains':
      pos.set(a * asp + 0.05 * Math.sin(w * 2 + j), 0.05)
      dir.set(0.45 * Math.sin(w * 3 + j * 1.7), 1).normalize()
      break
    case 'rain':
      pos.set(a * asp + 0.05 * Math.sin(w * 2 + j), 0.95)
      dir.set(0.45 * Math.sin(w * 3 + j * 1.7), -1).normalize()
      break
    case 'orbit': {
      const th = TAU * a + w
      pos.set(asp * 0.5 + 0.28 * Math.cos(th), 0.5 + 0.28 * Math.sin(th))
      dir.set(-Math.sin(th), Math.cos(th))
      break
    }
    case 'collide': {
      const side = i % 2
      const row = (Math.floor(i * 0.5) + 0.5) / Math.max(1, Math.ceil(n * 0.5))
      const fr = row + 0.12 * Math.sin(w + j)
      pos.set(0.05 + (asp - 0.1) * side, 0.15 + 0.7 * (fr - Math.floor(fr)))
      dir.set(side ? -1 : 1, 0)
      break
    }
    case 'ring': {
      const th = TAU * a + 0.25 * Math.sin(w + j)
      pos.set(asp * 0.5 + 0.4 * Math.cos(th), 0.5 + 0.4 * Math.sin(th))
      dir.set(-Math.cos(th), -Math.sin(th))
      break
    }
    default:
      pos.set(asp * (0.5 + 0.34 * Math.sin(w + j)), 0.5 + 0.34 * Math.cos(w * 1.31 + j * 2.1))
      dir.set(Math.cos(w * 0.7 + j), Math.sin(w * 0.9 + j))
  }
  return a + 0.13 * Math.sin(w + j)
}

/** Where the stirrer is: a figure of eight around its centre, closed on the phase. */
export function stirAt(ph: number, asp: number, out: THREE.Vector2): THREE.Vector2 {
  const w = TAU * ph
  const x = STIR_CENTER.x * asp + WANDER * 0.3 * Math.sin(w)
  const y = STIR_CENTER.y + WANDER * 0.3 * Math.sin(2 * w + 1.1)
  return out.set(Math.min(asp - 0.08, Math.max(0.08, x)), Math.min(0.92, Math.max(0.08, y)))
}

/**
 * `paletteLit` on the CPU — mid -> accent -> glow, triangle-wrapped — then
 * taken to display space, which is the space the ink lives in.
 */
function inkColour(pal: PaletteBlender, t: number, out: THREE.Color): THREE.Color {
  const m = t - Math.floor(t)
  const w = (m < 0.5 ? m : 1 - m) * 4
  if (w < 1) lerpOklab(out.copy(pal.mid), pal.accent, w)
  else lerpOklab(out.copy(pal.accent), pal.glow, w - 1)
  return out.setRGB(Math.pow(out.r, 1 / 2.2), Math.pow(out.g, 1 / 2.2), Math.pow(out.b, 1 / 2.2))
}

// ---- GPU side -----------------------------------------------------------------

export interface InkFluidGPU {
  simW: number
  simH: number
  dyeW: number
  dyeH: number
  velA: THREE.WebGLRenderTarget
  prsA: THREE.WebGLRenderTarget
  prsB: THREE.WebGLRenderTarget
  velB: THREE.WebGLRenderTarget
  dye: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget]
  /** Index of the dye target holding the latest ink. */
  dyeRead: number
  seeded: boolean
  vel: THREE.ShaderMaterial
  prs: THREE.ShaderMaterial
  proj: THREE.ShaderMaterial
  ink: THREE.ShaderMaterial
  scene: THREE.Scene
  mesh: THREE.Mesh
  camera: THREE.OrthographicCamera
  /** Which mounted instance steps the tank, and when it last did. */
  stepper: object | null
  lastStepAt: number
}

/**
 * One tank per renderer, never disposed on unmount — the same trade the
 * factory makes for its materials and render targets (F138/F144): a remount
 * must not pay a recompile or a reallocation, and a context loss produces a new
 * renderer and so a fresh entry.
 */
const tanks = new WeakMap<THREE.WebGLRenderer, InkFluidGPU>()

function makeTarget(w: number, h: number): THREE.WebGLRenderTarget {
  const t = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  })
  t.texture.generateMipmaps = false
  return t
}

function simMaterial(frag: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: frag,
    depthWrite: false,
    depthTest: false,
    blending: THREE.NoBlending,
    uniforms: {
      uSimRes: { value: new THREE.Vector2(1, 1) },
      uAsp: { value: 1 },
      uDT: { value: 0 },
      uSeeding: { value: 0 },
      uHashSeed: { value: HASH_SEED },
      ...uniforms,
    },
  })
}

const vec2s = (n: number) => Array.from({ length: n }, () => new THREE.Vector2())
const colours = (n: number) => Array.from({ length: n }, () => new THREE.Color())

function createTank(): InkFluidGPU {
  const srcPos = vec2s(8)
  const srcDir = vec2s(8)
  const srcCol = colours(8)
  const vel = simMaterial(VEL_FRAG, {
    tVelB: { value: null },
    tDye: { value: null },
    uDyeTexel: { value: new THREE.Vector2(1, 1) },
    uSrcPos: { value: srcPos },
    uSrcDir: { value: srcDir },
    uSources: { value: 4 },
    uRadius: { value: RADIUS },
    uForce: { value: FORCE },
    uStirP: { value: new THREE.Vector2() },
    uStirF: { value: STIR_F },
    uStirR: { value: STIR_R },
    uVort: { value: VORT },
    uBuoy: { value: BUOY },
    uDrag: { value: DRAG },
  })
  const prs = simMaterial(PRS_FRAG, {
    tVelA: { value: null },
    tSrc: { value: null },
    uMeasure: { value: 1 },
  })
  const proj = simMaterial(PROJ_FRAG, { tVelA: { value: null }, tPrs: { value: null } })
  const ink = simMaterial(DYE_FRAG, {
    tDyePrev: { value: null },
    tVelB: { value: null },
    uDyeRes: { value: new THREE.Vector2(1, 1) },
    uSrcPos: { value: srcPos },
    uSrcCol: { value: srcCol },
    uSources: { value: 4 },
    uRadius: { value: RADIUS },
    uInk: { value: INK },
    uInkFade: { value: INK_FADE },
    uSeedCol: { value: colours(7) },
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), vel)
  mesh.frustumCulled = false
  const scene = new THREE.Scene()
  scene.add(mesh)
  const t = () => makeTarget(1, 1)
  return {
    simW: 0,
    simH: 0,
    dyeW: 0,
    dyeH: 0,
    velA: t(),
    prsA: t(),
    prsB: t(),
    velB: t(),
    dye: [t(), t()],
    dyeRead: 0,
    seeded: false,
    vel,
    prs,
    proj,
    ink,
    scene,
    mesh,
    camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
    stepper: null,
    lastStepAt: -Infinity,
  }
}

/**
 * The tank for this renderer, sized for this aspect. Reallocates (and so
 * re-fills) only when the lattice's WIDTH changes — a real window reshape —
 * never on a DPR or resolution-tier change. Exported for the GPU harness.
 */
export function getTank(gl: THREE.WebGLRenderer, aspect: number): InkFluidGPU {
  let tank = tanks.get(gl)
  if (!tank) {
    tank = createTank()
    tanks.set(gl, tank)
  }
  const asp = isFinite(aspect) && aspect > 0 ? aspect : 16 / 9
  const simW = Math.max(8, Math.round(SIM_ROWS * asp))
  if (simW !== tank.simW) {
    tank.simW = simW
    tank.simH = SIM_ROWS
    tank.dyeW = Math.max(8, Math.round(DYE_ROWS * asp))
    tank.dyeH = DYE_ROWS
    for (const rt of [tank.velA, tank.prsA, tank.prsB, tank.velB]) rt.setSize(tank.simW, tank.simH)
    for (const rt of tank.dye) rt.setSize(tank.dyeW, tank.dyeH)
    tank.seeded = false
  }
  return tank
}

function pass(
  gl: THREE.WebGLRenderer,
  tank: InkFluidGPU,
  m: THREE.ShaderMaterial,
  to: THREE.WebGLRenderTarget,
) {
  tank.mesh.material = m
  gl.setRenderTarget(to)
  gl.render(tank.scene, tank.camera)
}

/**
 * Run one frame of the solver: velocity, two pressure sweeps, projection, ink.
 * Exported for the GPU harness.
 */
export function stepTank(
  gl: THREE.WebGLRenderer,
  tank: InkFluidGPU,
  st: InkFluidState,
  pal: PaletteBlender,
) {
  const asp = tank.simW / tank.simH
  const seeding = tank.seeded ? 0 : 1
  const n = st.sources

  // Forcing, evaluated once per frame on the CPU instead of per texel.
  const vu = tank.vel.uniforms
  const du = tank.ink.uniforms
  const pos = vu.uSrcPos.value as THREE.Vector2[]
  const dir = vu.uSrcDir.value as THREE.Vector2[]
  const col = du.uSrcCol.value as THREE.Color[]
  if (seeding) {
    const seedCol = du.uSeedCol.value as THREE.Color[]
    for (let i = 0; i < seedCol.length; i++) inkColour(pal, (i + 0.5) / seedCol.length, seedCol[i])
    st.clock = 0
    st.ph = 0
  }
  for (let i = 0; i < n; i++)
    inkColour(pal, sourceAt(st.layout, i, n, st.clock, asp, pos[i], dir[i]), col[i])

  for (const m of [tank.vel, tank.prs, tank.proj, tank.ink]) {
    m.uniforms.uSimRes.value.set(tank.simW, tank.simH)
    m.uniforms.uAsp.value = asp
    m.uniforms.uDT.value = st.dt
    m.uniforms.uSeeding.value = seeding
  }

  const dyePrev = tank.dye[tank.dyeRead]
  const dyeNext = tank.dye[1 - tank.dyeRead]
  const prevTarget = gl.getRenderTarget()

  vu.tVelB.value = tank.velB.texture
  vu.tDye.value = dyePrev.texture
  vu.uDyeTexel.value.set(1 / tank.dyeW, 1 / tank.dyeH)
  vu.uSources.value = n
  vu.uForce.value = st.force
  stirAt(st.ph, asp, vu.uStirP.value)
  vu.uStirF.value = st.stirF
  vu.uVort.value = st.vort
  pass(gl, tank, tank.vel, tank.velA)

  const pu = tank.prs.uniforms
  pu.tVelA.value = tank.velA.texture
  pu.tSrc.value = tank.prsB.texture
  pu.uMeasure.value = 1
  pass(gl, tank, tank.prs, tank.prsA)
  pu.tSrc.value = tank.prsA.texture
  pu.uMeasure.value = 0
  pass(gl, tank, tank.prs, tank.prsB)

  tank.proj.uniforms.tVelA.value = tank.velA.texture
  tank.proj.uniforms.tPrs.value = tank.prsB.texture
  pass(gl, tank, tank.proj, tank.velB)

  du.tDyePrev.value = dyePrev.texture
  du.tVelB.value = tank.velB.texture
  du.uDyeRes.value.set(tank.dyeW, tank.dyeH)
  du.uSources.value = n
  du.uInk.value = st.ink
  pass(gl, tank, tank.ink, dyeNext)

  gl.setRenderTarget(prevTarget)
  tank.dyeRead = 1 - tank.dyeRead
  tank.seeded = true
}

/** Ms an instance that is not the tank's stepper waits before taking over. */
const TAKEOVER_MS = 50
/** Camera push -> zoom: the scene's anchor distance, and the zoom ceiling. */
const ANCHOR_DISTANCE = 10.0
const CAM_ZOOM_MAX = 1.3

/**
 * The modes, in the order the render shader's `uMode` branches expect. Of the
 * source's seventeen styles, these show the flow's STRUCTURE — filament edges,
 * density contours — lit on black and drawn from the palette. `ink` is new:
 * the source's glow under a soft exposure, with its neon edges on top. Not
 * carried: the density washes (glow, aurora, nebula), which read as a blob even
 * while the water moves; the white-ground styles (ink in water, schlieren, wet
 * paper); the fixed-colour ones (thermal, x-ray, chrome, oil film, vorticity,
 * speed, marbling); and the grey full-frame streamlines.
 */
export const INK_MODES = ['ink', 'neon', 'contour']

interface InkFluidInstance extends InkFluidState {
  /** Identity for the tank's stepper handoff. */
  self: object
}

const InkFluidRender = createShaderScene<InkFluidInstance>({
  id: 'inkfluid',
  frag: FRAG,
  include: PALETTE_RAMP_GLSL,
  state: () => ({ ...createInkFluidState(), self: {} }),
  uniforms: () => ({
    tDye: { value: null },
    tVel: { value: null },
    uDyeTexel: { value: new THREE.Vector2(1, 1) },
    uCell: { value: new THREE.Vector2(1, 1) },
    uCellPx: { value: 1 },
    uPh: { value: 0 },
    uZoom: { value: 1 },
  }),
  update({ u, s, P, st, dt, ctx, gl, pal }) {
    stepInkFluid(st, s, P, dt)

    const tank = getTank(gl, u.uAspect.value)
    // One instance steps the tank; a second mount (a crossfade) only draws,
    // unless the stepper has gone quiet.
    const now = performance.now()
    if (tank.stepper === st.self || now - tank.lastStepAt > TAKEOVER_MS) {
      tank.stepper = st.self
      tank.lastStepAt = now
      stepTank(gl, tank, st, pal)
    }

    // Camera: push in zooms into the tank, never out past the glass.
    const dist = Math.max(ctx.camera.position.length(), 0.01)
    const camZoom = Math.min(CAM_ZOOM_MAX, Math.max(1, Math.pow(ANCHOR_DISTANCE / dist, 0.8)))
    st.zoom = slew(st.zoom, camZoom, dt, 3, 3)

    u.tDye.value = tank.dye[tank.dyeRead].texture
    u.tVel.value = tank.velB.texture
    u.uDyeTexel.value.set(1 / tank.dyeW, 1 / tank.dyeH)
    u.uCell.value.set(1 / tank.simW, 1 / tank.simH)
    u.uCellPx.value = u.uRes.value.y / tank.simH
    u.uPh.value = st.ph
    u.uZoom.value = st.zoom
  },
})

/**
 * The scene, with its prewarm extended to the solver: the factory's prewarm
 * compiles only the render shader, and the four simulation programs would
 * otherwise compile on the first frame the director picks this scene. One
 * seeding step into a boot-time tank forces all four with real draws.
 */
export const InkFluidScene = InkFluidRender
const renderPrewarm = InkFluidRender.prewarm
InkFluidScene.prewarm = (gl) => {
  renderPrewarm(gl)
  const size = gl.getSize(new THREE.Vector2())
  const tank = getTank(gl, size.x / Math.max(1, size.y))
  const st = createInkFluidState()
  const lit = new THREE.Color(0.5, 0.5, 0.5)
  stepTank(gl, tank, st, { mid: lit, accent: lit, glow: lit } as PaletteBlender)
  // The warm step filled the tank with grey; let the first real frame re-fill
  // it in the live palette.
  tank.seeded = false
}
