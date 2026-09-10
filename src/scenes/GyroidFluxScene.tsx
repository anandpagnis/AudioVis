import * as THREE from 'three'
import { createShaderScene } from '../engine/createShaderScene'
import { quality } from '../engine/quality'
import { slew } from '../engine/response'
import { bipolar, drastic } from './contract'

/**
 * Gyroid Flux — an infinite, glowing gyroid minimal-surface lattice, warped by
 * a slow sinusoidal domain distortion, with the camera drifting and orbiting
 * through it rather than committing to a single flight path.
 *
 * Shadertoy source, supplied directly by the requester and credited as CC0 ->
 * `license: 'original'`, same basis as `beats` / `harkonnen` / `web`. No URL
 * was given with the paste (unlike `tunnel`'s recorded MfVfz3 link) — if a
 * source page turns up later, this header is the place to add it.
 *
 * ## PARKED in DISABLED_SCENES — cost, not licence
 *
 * This is a 150-step march with NO hit-based early-out — like `beats`, every
 * pixel accumulates glow for every step it is given; the only exits besides
 * the step cap are `t > U_DEPTH` (25.4) and the loop bound itself, and the
 * adaptive step size floors at 0.004, so in practice nearly every pixel runs
 * close to the full 150. Rough op-count read against the two nearest
 * measured/estimated analogues (see docs/ISSUES.md F181b for why this stays a
 * documented estimate rather than a fabricated pass-the-test number):
 *
 *   - vs `kifs` (2.97 ms @ tier 0, ~20 folds, WITH an escape that spares most
 *     pixels): 150 steps is 7.5x the iteration count. Each iteration here is
 *     lighter (one warp `sin(vec3)` plus the gyroid tap's `sin`/`cos`/`dot`/
 *     `abs`, no nested fold), but kifs's escape means its true full-run cost
 *     is higher than 2.97/20 suggests. Scaling the count alone: ~18-22 ms.
 *   - vs `beats` (est. 15.2 ms @ tier 0, 77 steps, ALSO no hit-based
 *     early-out — the closest true analogue): 150/77 = 1.95x the steps, but
 *     beats' own iteration does 3 mat2 rotations + an inversion divide + a
 *     lattice fold + a 7-deep min() tree + a vec4 sin colour phase — several
 *     times the arithmetic of this shader's single warp-plus-gyroid tap.
 *     Scaling both factors: roughly 7-8 ms.
 *
 * The two methods land 7-22 ms apart. `SCENE_COST_MS.gyroid` in
 * `sceneCost.ts` is priced at the pessimistic (kifs-scaled) end of that
 * range rather than split down the middle — same call `beats`' own row
 * makes for its own two-sided estimate — and is a documented worst-case
 * estimate, not a fabricated ceiling built to clear `slotBudget.test.ts`.
 *
 * ## FORCED LIVE by explicit request — pending a real /bench
 *
 * ACTION: run `/bench`, get a real number, then decide whether it needs
 * `pixelBudget` tightened further, a step-count cut, or is fine as measured.
 * Do not trust the estimate above longer than it takes to get a measurement.
 *
 * ## Port notes (Shadertoy -> AudioVis prelude)
 *
 *   iResolution.xy       -> uRes
 *   iTime                 -> uRawT, JS-accumulated (see below), NOT
 *                            `elapsed * speed` — multiplying a running clock
 *                            by a changing rate would jump the camera's orbit
 *                            position the moment the dial or mids changed,
 *                            same reasoning as `TunnelDriftScene`'s `uDist`.
 *                            `tt` and the warp phase are both reconstructed
 *                            from this ONE accumulator (`uRawT * 0.46` and
 *                            `uRawT * 0.6` respectively) so they can never
 *                            drift out of the source's authored ratio.
 *   iMouse                -> dropped; this project has no mouse input. The
 *                            look-direction wobble it drove is now `uWobble`
 *                            — the tilt dial only, static. Originally also
 *                            carried a transient-driven flinch; removed
 *                            (2026-09-11, see `update()`'s own note) once a
 *                            reported "still jerky, still back and forth"
 *                            traced to it: `b.transient` rises and falls
 *                            continuously (spectral flux, ~50ms tracking,
 *                            not a one-shot decay), and ANY term riding on a
 *                            rotation ANGLE that rises and falls makes the
 *                            camera swing out and back by definition — no
 *                            amount of smoothing changes that, only removing
 *                            it from the angle does.
 *   mainImage/fragColor   -> main() / gl_FragColor, final * uFade
 *   fragCoord              -> gl_FragCoord.xy
 *
 * `col = 1.0 - exp(-col)` is the source's own exposure tonemap, not a 1/2.2
 * sRGB encode — three's renderer does that itself. Kept as-is.
 *
 * ## What was added (the source is wall-clock + mouse only)
 *
 *   speed + mids  -> the one flight/warp clock (see uRawT above)
 *   shape         -> U_WARP, the domain-warp amount: rectilinear grid at low,
 *                    molten/organic at high
 *   complexity    -> U_SCALE, the lattice cell frequency
 *   density       -> U_THICK, the glow-band thickness (see `map()` — higher
 *                    packs more of the volume into the glowing region)
 *   contrast+highs-> glow falloff sharpness (was the constant `8.0`)
 *   fill          -> focal length / zoom (was the constant `1.6`)
 *   tilt          -> static camera-wobble offset (replaces `mo`)
 *   onKick        -> uShock, folded into brightness AND a focal-length punch
 *                    (see update() — the camera zooms in briefly on a hit)
 *   sub           -> continuous warp-amount swell, distinct from onKick
 *   energy        -> overall glow brightness
 *   transient     -> overall glow brightness (moved off the camera's
 *                    rotation angle, 2026-09-11 — see the iMouse port note)
 *
 * ## Band routing
 *
 *   onKick    -> decaying brightness flash + focal punch (uShock, folded
 *                into both uGlowAmt and uFocal)
 *   sub       -> continuous swell added straight onto the warp amount
 *   mids      -> flight/orbit clock rate, and the orbit's own radius
 *   highs     -> tighter glow edges (stacks with the contrast dial)
 *   energy    -> overall glow brightness
 *   transient -> overall glow brightness (NOT the camera — see port notes)
 *
 * ## Scene Contract
 *
 *   speed       flight/orbit + domain-warp clock rate
 *   shape       domain-warp amount — "warp", grid to molten
 *   complexity  lattice cell frequency — "scale"
 *   density     glow-band thickness — "thickness"
 *   contrast    glow falloff sharpness
 *   fill        focal length / zoom
 *   tilt        static camera-wobble offset (replaces the source's mouse look)
 */

export const FRAG = /* glsl */ `
  uniform float uRawT;    // JS-accumulated clock; tt = uRawT*0.46, warp phase = uRawT*0.6
  uniform float uWarp;    // shape dial (+ sub swell) -> domain-warp amount, source const 2.5
  uniform float uScale;   // complexity dial -> gyroid cell frequency, source const 0.6
  uniform float uThick;   // density dial -> glow-band thickness, source const 0.0
  uniform float uSharp;   // contrast+highs -> glow falloff sharpness, source const 8.0
  uniform float uFocal;   // fill dial -> zoom, source const 1.6
  uniform float uOrbitR;  // orbit radius, breathing with mids -- see update()
  uniform vec2  uWobble;  // tilt dial only, static -> replaces mouse look. Was ALSO
                           // transient-driven once; removed (2026-09-11) -- see update()
  uniform float uGlowAmt; // energy + onKick shock + transient -> overall glow brightness, source const 4.6
  uniform vec3  uColA;    // palette-tinted, source const vec3(0.0, 0.25, 1.0)
  uniform vec3  uColB;    // palette-tinted, source const vec3(0.3, 0.3, 1.0)
  uniform int   uMaxSteps;

  #define U_DEPTH 25.4

  mat2 rot(float a) {
    float c = cos(a); float s = sin(a);
    return mat2(c, -s, s, c);
  }

  float gyroid(vec3 p) {
    p *= uScale;
    return abs(dot(sin(p), cos(p.yzx))) / uScale - uThick;
  }

  float map(vec3 p) {
    return gyroid(p + uWarp * sin(p.yzx * 1.7 + uRawT * 0.6));
  }

  void main() {
    vec2 uv = (2.0 * gl_FragCoord.xy - uRes.xy) / uRes.y;

    float tt = uRawT * 0.46;
    // Single orbit phase, not the source's two independently-timed sin/cos
    // pairs — see update()'s own note on why that read as "back and forth"
    // rather than a flow. cos/sin of ONE continuously-advancing phase is a
    // true constant-speed revolution: it never stalls or reverses, unlike
    // two mismatched frequencies on X and Y, which trace a Lissajous path
    // that visibly doubles back on itself wherever the two axes fight.
    float orbitPhase = tt * 0.35;
    vec3 ro = vec3(uOrbitR * cos(orbitPhase), uOrbitR * sin(orbitPhase), tt);
    vec3 rd = normalize(vec3(uv, uFocal));
    // Second fix (still reported jerky after the first): the position orbit
    // above is a true one-directional revolution now, but this gaze sway was
    // STILL rot(A * sin(phase)) -- a bounded oscillation. Bounded means
    // exactly what it sounds like: the angle decelerates to zero and reverses
    // at its own turning points no matter what phase drives it, so this term
    // alone reproduced the same "back and forth" the position fix could not
    // touch, being a completely separate piece of math. Fixed the same way as
    // the orbit itself: orbitPhase used directly as the rotation angle
    // (continuously increasing, never bounded) rather than as the input to a
    // sin/cos swing -- a slow, continuous roll that never stalls or reverses,
    // at a rate slow enough (roughly one full turn per 11 orbit revolutions)
    // to read as a gentle drift rather than a spin.
    rd.yz = rot(orbitPhase * 0.09 + uWobble.y) * rd.yz;
    rd.xz = rot(orbitPhase * 0.11 + uWobble.x) * rd.xz;

    float t = 0.0;
    float atten = 1.0;
    vec3 col = vec3(0.0);

    for (int i = 0; i < 150; i++) {
      if (i >= uMaxSteps) break;
      vec3 p = ro + rd * t;
      float d = map(p);
      float ad = abs(d);

      vec3 surfaceColor = mix(uColA, uColB, clamp(ad * uSharp, 0.0, 1.0));
      col += surfaceColor * (uGlowAmt * 0.014) * exp(-ad * uSharp) * atten;

      t += max(ad * 0.455, 0.004);
      atten *= 0.999;
      if (t > U_DEPTH) break;
    }

    col += uColA * 0.015;
    col = 1.0 - exp(-col);
    gl_FragColor = vec4(col * uFade, 1.0);
  }
`

/**
 * Source colour constants, preserved as the VALUE structure of the piece —
 * same move as `TunnelDriftScene`'s WALL_BASE/RAIL_BASE/FOG_BASE. Palette
 * TINTS these; it must not replace them outright, or the deep-blue / violet
 * contrast the source was built around flattens to whatever the live palette
 * happens to be.
 */
const COL_A_BASE = new THREE.Color(0.0, 0.25, 1.0)
const COL_B_BASE = new THREE.Color(0.3, 0.3, 1.0)

interface GyroidState {
  /** Unscaled accumulated clock — tt and the warp phase are both derived from this in-shader. */
  rawT: number
  /** Kick brightness flash, decaying. */
  shock: number
  /** `s.mids`, slewed — see `update()`'s own note on why the raw band feeds
   *  a rate rather than a position. */
  midsSlew: number
}

export const GyroidFluxScene = createShaderScene<GyroidState>({
  id: 'gyroid',
  frag: FRAG,
  blending: THREE.NoBlending,
  // Offscreen + upscale, same shape as beats/harkonnen — the glow accumulation
  // hides a soft upscale. Numbers borrowed from `beats` pending a real
  // /bench: this scene's own estimate range (see header) overlaps beats'
  // ballpark closely enough that inventing different numbers blind would not
  // be more honest, just differently wrong.
  pixelBudget: () => (quality.knobs.raymarchSteps >= 50 ? 1.2 : 0.7),
  uniforms: () => ({
    uRawT: { value: 0 },
    uWarp: { value: 2.5 },
    uScale: { value: 0.6 },
    uThick: { value: 0 },
    uSharp: { value: 8 },
    uFocal: { value: 1.6 },
    uOrbitR: { value: 0.8 },
    uWobble: { value: new THREE.Vector2(0, 0) },
    uGlowAmt: { value: 4.6 },
    uColA: { value: new THREE.Color().copy(COL_A_BASE) },
    uColB: { value: new THREE.Color().copy(COL_B_BASE) },
    uMaxSteps: { value: 150 },
  }),
  state: () => ({ rawT: 0, shock: 0, midsSlew: 0 }),
  update({ u, s, P, pal, st, dt, ctx }) {
    // Slowed and smoothed on direct request (2026-09-07): this clock's rate
    // used to read `s.mids` — a live audio envelope, not itself smoothed —
    // DIRECTLY into a multiplier every frame, so the flight/warp speed
    // visibly sped up and slowed down on every raw fluctuation of the mids
    // band, reading as jerky rather than a flow. `slew()` (the same
    // exponential-approach rate limiter `MazeFlightScene`'s skip decay and
    // this file's own `st.shock` below use, just applied to the INPUT here
    // instead of the output) tracks the real mids trend within a few tenths
    // of a second while erasing frame-to-frame jitter; unlike `beatsPosition`
    // (see `JavaZoneLatticeScene`'s own note below), nothing about this
    // free-running clock is grid-locked to the track's tempo, so both the
    // base rate and the reactive swing are free to move — base cruise
    // roughly halved (1.0 -> 0.5) and the swing's own amplitude cut by the
    // same ratio (0.6 -> 0.3) rather than only slowing one of the two.
    st.midsSlew = slew(st.midsSlew, s.mids, dt, 3, 3)
    st.rawT += dt * (0.5 + st.midsSlew * 0.3) * drastic(P.speed)

    // Second, separate fix (2026-09-11): "jerky, moves back and forth" is a
    // DIFFERENT complaint than the rate-smoothing above already addressed —
    // that fixed how the CLOCK accelerates/decelerates, not the SHAPE of the
    // camera path it drives. The source's own orbit (`ro`) and look-sway
    // (`rd` rotation) each read TWO independently-timed sin/cos terms — a
    // Lissajous path, which genuinely stalls and reverses direction wherever
    // the two mismatched frequencies fight, not merely a smoothness issue.
    // Rewritten in-shader (see FRAG) onto one continuously-advancing orbit
    // phase: cos/sin of a single ever-increasing angle is a true constant-
    // speed revolution that never stalls, so the camera now consistently
    // circles one way while flying forward — "moves in one direction" as
    // asked, without flattening the path to a straight line.
    //
    // First attempt at this only rewrote `ro` (the camera's POSITION) this
    // way and left `rd`'s own rotation (where it LOOKS) as a bounded
    // `rot(A * sin(phase))` swing — reported still jerky immediately after,
    // correctly: a bounded angle reverses at its own turning points no
    // matter what phase drives it, so that term alone reproduced the exact
    // same complaint on its own, being completely separate math from the
    // position fix. Fixed the same way, in FRAG: the gaze rotation now uses
    // `orbitPhase` directly as its angle (continuously increasing) rather
    // than as the input to a sin/cos swing — a slow, continuous roll, never
    // bounded, never reversing.
    //
    // "maybe change speed or some other params to visualise" / "change some
    // other params for reactivity" — three axes now carry the visual life
    // the removed swing used to supply on its own clock, none of them able
    // to reopen the same complaint since none of them oscillate:
    //   1. Orbit RADIUS breathes with the already-smoothed mids signal above.
    //   2. Focal length (zoom, below) gets a kick-triggered punch off
    //      `st.shock` — reuses the flash envelope already computed for
    //      `uGlowAmt`, strictly additive and self-decaying.
    //   3. The gaze's own slow roll (FRAG) is itself riding on `orbitPhase`,
    //      which is already mids-modulated via `uRawT`'s own rate above — so
    //      it already breathes with the music without a fourth signal.
    u.uOrbitR.value = 0.8 + st.midsSlew * 0.25

    if (s.onKick > 0) st.shock = Math.min(1.5, st.shock + s.onKick)
    st.shock *= Math.exp(-dt * 4.0)

    u.uRawT.value = st.rawT

    // shape 0.5 -> 2.5 (source const); sub adds a continuous swell on top,
    // distinct from onKick's transient flash below.
    u.uWarp.value = 2.5 + bipolar(P.shape, 1.5) + s.sub * 0.8
    // complexity 0.5 -> 0.6 (source const)
    u.uScale.value = 0.6 + bipolar(P.complexity, 0.3)
    // density 0.5 -> 0.0 (source const)
    u.uThick.value = bipolar(P.density, 0.15)
    // contrast 0.5 -> 8.0 (source const); highs tightens further on top
    u.uSharp.value = 8.0 + bipolar(P.contrast, 4.0) + s.highs * 3.0
    // fill 0.5 -> 1.6 (source const), plus a kick punch: zooms in briefly on
    // a hit and eases back out on `st.shock`'s own decay — the same signal
    // already driving `uGlowAmt`'s flash below, reused rather than a second
    // envelope. A THIRD reactive axis restoring the visual life the removed
    // gaze-swing (above) used to supply on its own clock, this one strictly
    // additive and self-decaying rather than oscillating, so it cannot
    // reopen the same "back and forth" complaint no matter how hard or how
    // often it fires.
    u.uFocal.value = 1.2 + P.fill * 0.8 + st.shock * 0.25
    // tilt replaces the source's mouse look — a fixed user offset only, no
    // live signal riding on it.
    //
    // Third bug in this same rotation angle, found only because "still
    // jerky" was reported a SECOND time (2026-09-11): `ctx.b.transient` used
    // to be added here too ("adds a dynamic flinch on top"). Both earlier
    // fixes made the BASE of this angle (orbitPhase, scaled) genuinely
    // monotonic — but `b.transient` is spectral flux through a fast ~50ms
    // tracking filter (see AudioEngine.ts), not a one-shot decay: it rises
    // and falls continuously as the spectrum changes, many times a second in
    // a busy mix. Added directly to a ROTATION ANGLE, any term that rises
    // and falls makes the camera swing out and back, by definition,
    // regardless of how smooth or jittery that rise-and-fall is — smoothing
    // it (this session's usual fix for a raw-band problem) would not have
    // helped here, because the bug was never the smoothness, it was that
    // ANYTHING added to this specific angle that ever decreases reopens
    // "back and forth". The only fix that actually holds the "one direction
    // only" guarantee is removing it from the angle entirely.
    u.uWobble.value.set(bipolar(P.tilt, 3.0), bipolar(P.tilt, 1.5))
    // energy + kick flash + the transient reactivity moved off the camera
    // above, all boosts ON TOP of the source const (4.6), so silence still
    // reproduces the authored brightness rather than dimming it. Brightness
    // pulsing with a live signal is the safe place for it — unlike an angle,
    // there is no "direction" for a rise-and-fall term to visibly reverse.
    u.uGlowAmt.value = 4.6 * (1 + s.energy * 0.6) * (1 + st.shock * 0.7) * (1 + ctx.b.transient * 0.3)

    u.uColA.value.copy(COL_A_BASE).lerp(pal.accent, 0.4)
    u.uColB.value.copy(COL_B_BASE).lerp(pal.glow, 0.4)

    // No hit-based early-out (see header) — cutting steps genuinely shortens
    // how far the ray reaches before the glow accumulation truncates, not
    // just resolution softness (same Finding-4 shape `beats` documents).
    // Floored higher than beats' 20/77 (26%) for that reason: 70/150 (~47%).
    // Purely governor-driven, no user dial on top — same call TunnelDriftScene
    // makes for its own `uMaxSteps`, and for the same reason: a dial that
    // could reach this floor would be a dial that breaks the scene.
    const qFrac = Math.min(1, quality.knobs.raymarchSteps / 96)
    u.uMaxSteps.value = Math.max(70, Math.min(150, Math.round(150 * qFrac)))
  },
})
