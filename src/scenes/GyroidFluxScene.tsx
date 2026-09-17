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
 * Was FORCED LIVE by explicit request for a session; parked back into
 * `DISABLED_SCENES` (2026-09-17) pending the same real `/bench` measurement —
 * nothing about the cost picture changed, the estimate above is still
 * undischarged. ACTION: run `/bench`, get a real number, then decide whether
 * it needs `pixelBudget` tightened further, a step-count cut, or is fine as
 * measured before it comes back to `SCENES`.
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
 *
 *                            `tt`'s own multiplier (below) was later raised
 *                            0.46 -> 0.62 (2026-09-17, "move it deeper into
 *                            it") — see the Round 2 section below for the
 *                            full note; flagged here too so this port-notes
 *                            block does not go stale next to it.
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
 *   complexity    -> U_SCALE, the lattice cell frequency, also now pulsed
 *                    +-10% by `uBeatSin` once per beat (2026-09-16, "move
 *                    complexity with beat" — see `gyroid()`)
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
 *   beat      -> +-10% lattice-frequency pulse (uBeatSin, `gyroid()`),
 *                added 2026-09-16 on direct request ("move complexity
 *                with beat")
 *
 * ## Scene Contract
 *
 *   speed       flight/orbit + domain-warp clock rate
 *   shape       domain-warp amount — "warp", grid to molten
 *   complexity  lattice cell frequency — "scale", also beat-pulsed (above)
 *   density     glow-band thickness — "thickness"
 *   contrast    glow falloff sharpness
 *   fill        focal length / zoom
 *   tilt        static camera-wobble offset (replaces the source's mouse look)
 *
 * ## Camera movement reduced (2026-09-16, direct request)
 *
 * Orbit rate, gaze-roll rate, orbit-radius swing and the kick zoom-punch were
 * all independently cut (roughly 35-50% each — not one master multiplier,
 * since they are four unrelated quantities: an angular rate, a smaller
 * angular rate, a radius, and a focal-length delta). None of the earlier
 * "one direction only" fixes above were touched — `orbitPhase` is still used
 * directly as a monotonically increasing angle, never as input to a bounded
 * sin/cos swing, so the camera still never reverses; it now simply covers
 * less ground doing it. See `main()`'s `orbitPhase`/`rd.yz`/`rd.xz` lines and
 * `update()`'s `uOrbitR`/`uFocal` assignments for the specific numbers.
 *
 * ## Round 2 (2026-09-17): step-count flicker, beat-pulse loudness, depth
 *
 * Reported after the round above: "camera is better, maybe move it deeper
 * into it? but whatever you've done makes it looks horribly bumpy, with
 * absolutely no changes as well." The camera math itself (`orbitPhase`,
 * still a single monotonically-increasing angle, never a bounded sin/cos
 * swing — see above) traces smooth and continuous under inspection, so
 * "horribly bumpy" was investigated as coming from somewhere ELSE first,
 * rather than reopening math that was already correct:
 *
 *   - `quality.ts`'s adaptive governor snaps `quality.knobs.raymarchSteps`
 *     to a new tier's raw number in a single frame outside a transition
 *     discount (its `applyKnobs()`: `this.knobs = base`, no easing at all)
 *     whenever it steps the render tier up or down. This scene's own
 *     estimated cost (7-22 ms, see the "PARKED" section above) straddles the
 *     governor's own demote/promote thresholds (roughly 17.5-25 ms at 60 Hz
 *     — `STEP_UP_MEAN_RATIO`..`STEP_DOWN_MEAN_RATIO` in quality.ts) almost
 *     exactly, which is precisely the profile that makes a governor hunt:
 *     climb once frame time looks steady for `CLIMB_HOLD_SEC`, get demoted
 *     again once the richer tier's real cost actually lands, back off,
 *     repeat. This scene fed that raw, un-eased tier number straight into
 *     `uMaxSteps` every frame with no smoothing of its own — the same shape
 *     `TunnelDriftScene`/`BeatsScene` also use for their own raymarchers,
 *     they are just far enough under the thresholds in practice not to hunt
 *     as visibly. Every hunt cycle changed how far the glow accumulation
 *     reaches, which reads as a flicker/bump completely independent of the
 *     actually-smooth camera path, and large enough to bury the beat pulse
 *     in `gyroid()` — matching "no changes as well" (the real per-beat pulse
 *     was there, just drowned out by a much bigger, non-musical jump).
 *     Fixed two ways, both local to this file (the governor's own hunting
 *     behaviour is a separate, cross-scene concern, out of scope here):
 *     `uMaxSteps` is now eased in this scene's own `update()`
 *     (`st.stepsSmooth`, see its doc) rather than snapped, and the ceiling it
 *     eases toward was cut 150 -> 120 (`RAYMARCH_STEP_CAP`) so this scene's
 *     worst-case cost sits further from the thresholds and the governor has
 *     less reason to hunt over it in the first place. Once the flicker is
 *     addressed, the beat pulse's own amplitude was raised 0.10 -> 0.16 (see
 *     `gyroid()`) since on its own it was judged too subtle to read clearly
 *     against what is now a calm background.
 *   - "move it deeper into it": the forward-crawl rate (`tt`, which IS
 *     `ro.z` — see `main()`) raised 0.46 -> 0.62, and the base focal length
 *     (`update()`'s `uFocal`) tightened 1.2 -> 1.35 — both independent of the
 *     orbit radius/rate and roll rate that were cut last round on direct
 *     request and are NOT reopened here; this is the depth/zoom axis, not
 *     the orbit-amplitude axis. `orbitPhase` was rewritten to derive its
 *     angular rate directly from `uRawT` (0.1012 = the previous
 *     `0.46 * 0.22`) rather than as a fraction of `tt`, specifically so
 *     speeding up `tt` could not drag the orbit's own rate up along with it
 *     — see `main()`'s own note on this.
 */

export const FRAG = /* glsl */ `
  uniform float uRawT;    // JS-accumulated clock; tt = uRawT*0.62, warp phase = uRawT*0.6
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
    // Beat-locked complexity pulse (2026-09-16, "move complexity with beat"):
    // uBeatSin is prelude-injected and already phase-locked to the tracked
    // beat grid (see SHADER_SCENE_PRELUDE / beatOscillators.ts) -- one full
    // sine cycle per beat, continuous and self-easing by construction, so
    // riding the cell frequency on it swells/relaxes the lattice detail once
    // a beat with no snap and no JS-side state to add.
    //
    // Amplitude raised 0.10 -> 0.16 (2026-09-17, "absolutely no changes"):
    // the original +-10% was tuned as a standalone number, but in practice
    // it was being visually drowned out by the uMaxSteps step-count flicker
    // (see RAYMARCH_STEP_CAP's own doc, below the FRAG block) firing on every
    // governor tier change -- a much larger, much more frequent-looking
    // swing in how far the glow reaches, next to which a +-10% frequency
    // wobble read as noise rather than as a deliberate pulse. Now that the
    // step count eases instead of snapping, +-16% is close to the loudest
    // this can go before the lattice visibly tears at the top of the swing
    // (the original ceiling this comment already warned about) while still
    // reading clearly as "moves with the beat" against a now-calm
    // background.
    float scale = uScale * (1.0 + uBeatSin * 0.16);
    p *= scale;
    return abs(dot(sin(p), cos(p.yzx))) / scale - uThick;
  }

  float map(vec3 p) {
    return gyroid(p + uWarp * sin(p.yzx * 1.7 + uRawT * 0.6));
  }

  void main() {
    vec2 uv = (2.0 * gl_FragCoord.xy - uRes.xy) / uRes.y;

    // Forward-crawl rate raised 0.46 -> 0.62 (2026-09-17, "move it deeper
    // into it"): tt IS the camera's z position (ro.z, below) as well as the
    // warp-phase time base, so this is the "how fast are we flying through
    // the lattice" dial. Deliberately decoupled from orbitPhase below (see
    // its own note right after) -- depth/immersion is a different axis from
    // the orbit amplitude/rate that was cut last round on direct request and
    // must stay cut.
    float tt = uRawT * 0.62;
    // Single orbit phase, not the source's two independently-timed sin/cos
    // pairs — see update()'s own note on why that read as "back and forth"
    // rather than a flow. cos/sin of ONE continuously-advancing phase is a
    // true constant-speed revolution: it never stalls or reverses, unlike
    // two mismatched frequencies on X and Y, which trace a Lissajous path
    // that visibly doubles back on itself wherever the two axes fight.
    // Orbit rate cut 0.35 -> 0.22 of tt (2026-09-16, "reduce camera
    // movement"). Now written directly against uRawT instead, as
    // 0.46 * 0.22 = 0.1012 (2026-09-17, "move it deeper into it"): once tt
    // itself sped up just above for the forward-crawl fix, leaving this as a
    // fraction OF tt would have dragged the orbit's own angular rate up
    // right along with it -- reopening the exact reduction that was cut last
    // round on direct request, just through a different multiplier than the
    // one someone would think to check. Deriving orbitPhase from uRawT
    // directly instead reproduces the EXACT same absolute angular rate the
    // "reduce camera movement" fix landed on, so that reduction holds no
    // matter how fast the camera now flies forward. Still the one
    // continuously-increasing phase, never a bounded sin/cos swing -- only
    // decoupled from a variable (tt) that now has its own separate reason to
    // change speed.
    float orbitPhase = uRawT * 0.1012;
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
    // Roll rate also cut (2026-09-16, same request) -- roughly halved, so the
    // slow drift reads as closer to one full turn per 22 orbit revolutions
    // rather than 11. Still orbitPhase used directly as the angle, never as
    // input to a sin/cos swing -- see the long note above on why that
    // specific shape is what keeps this "one direction only".
    rd.yz = rot(orbitPhase * 0.045 + uWobble.y) * rd.yz;
    rd.xz = rot(orbitPhase * 0.055 + uWobble.x) * rd.xz;

    float t = 0.0;
    float atten = 1.0;
    vec3 col = vec3(0.0);

    // Loop bound cut 150 -> 120 (2026-09-17, RAYMARCH_STEP_CAP in the JS
    // below) -- must stay equal to that constant or steps above it silently
    // do nothing; kept a literal here rather than interpolating the JS
    // constant into this template literal, matching how U_DEPTH above is
    // also a literal with no JS-side twin.
    for (int i = 0; i < 120; i++) {
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

/**
 * Raymarch step ceiling/floor (2026-09-17, see the header's "Round 2"
 * section for the full step-count-flicker investigation).
 *
 * Ceiling cut 150 -> 120 (20%): this scene's own header already reads it as
 * likely the most expensive one in the roster (7-22 ms, no hit-based
 * early-out), which is exactly the profile that keeps forcing the adaptive
 * governor (quality.ts) to intervene on it — and every intervention snapped
 * straight through to `uMaxSteps` with no easing of its own (see
 * `raymarchStepsTarget`/`st.stepsSmooth` below), which is the flicker that
 * was reported as "horribly bumpy". Trimming the ceiling lowers the
 * worst-case cost so the governor needs to reach for THIS scene less often
 * in the first place, on top of the easing fix. The floor is untouched, so
 * the worst case (survival tier) still marches at least 70 steps, same
 * guarantee as before — just a smaller ceiling-to-floor range to ease across
 * when the governor does move (120->70, 58%, vs. the old 150->70, 47%). The
 * FRAG loop's own compile-time bound (`main()`'s `for (int i = 0; i < 120;
 * ...)`) must stay equal to this or steps above it silently do nothing.
 */
const RAYMARCH_STEP_CAP = 120
/** Unchanged from the original 150-step version's floor — see `update()`'s
 *  own trailing note on why this is floored meaningfully higher (58% of the
 *  new, smaller ceiling) than `beats`'/`tunnel`'s own floors. */
const RAYMARCH_STEP_FLOOR = 70

/**
 * The governor-driven step-count TARGET, shared by `state()`'s seed and
 * `update()`'s own easing so the two can never drift apart into two
 * independently-maintained copies of the same formula.
 */
function raymarchStepsTarget(): number {
  const qFrac = Math.min(1, quality.knobs.raymarchSteps / 96)
  return Math.max(RAYMARCH_STEP_FLOOR, Math.min(RAYMARCH_STEP_CAP, RAYMARCH_STEP_CAP * qFrac))
}

interface GyroidState {
  /** Unscaled accumulated clock — tt and the warp phase are both derived from this in-shader. */
  rawT: number
  /** Kick brightness flash, decaying. */
  shock: number
  /** `s.mids`, slewed — see `update()`'s own note on why the raw band feeds
   *  a rate rather than a position. */
  midsSlew: number
  /**
   * Floating-point raymarch step count, eased toward
   * `raymarchStepsTarget()` every frame and rounded only when written to
   * `u.uMaxSteps` (2026-09-17, see `RAYMARCH_STEP_CAP`'s own doc). Kept as a
   * float rather than re-deriving an int fresh each frame specifically so it
   * can sit BETWEEN two governor tiers' step counts while easing from one to
   * the other, instead of jumping the instant the governor's own knob moves.
   */
  stepsSmooth: number
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
    // 150 -> RAYMARCH_STEP_CAP (120), matching the ceiling cut below.
    uMaxSteps: { value: RAYMARCH_STEP_CAP },
  }),
  // stepsSmooth seeded from the governor's CURRENT target rather than left at
  // 0/RAYMARCH_STEP_CAP, so the very first frame does not itself read as a
  // pop (a mount at a demoted tier would otherwise ease UP from a cold 0 or
  // snap DOWN from a hot 120 before settling) — see RAYMARCH_STEP_CAP's own
  // doc for why this is eased every frame after.
  state: () => ({ rawT: 0, shock: 0, midsSlew: 0, stepsSmooth: raymarchStepsTarget() }),
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
    // Radius + swing both cut (2026-09-16, "reduce camera movement"): base
    // 0.8 -> 0.6, mids breathing 0.25 -> 0.12 -- the orbit still breathes
    // with the track, it just doesn't swing as wide doing it.
    u.uOrbitR.value = 0.6 + st.midsSlew * 0.12

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
    // Kick zoom-punch amplitude also cut (2026-09-16, same request):
    // 0.25 -> 0.12 -- still a punch on a hit, just a smaller one.
    // Base tightened 1.2 -> 1.35 (2026-09-17, "move it deeper into it"): a
    // larger uFocal narrows the ray fan (`rd = normalize(vec2, uFocal)` in
    // FRAG), which is a lens getting more telephoto rather than the camera
    // moving — the structure reads closer/more enveloping without touching
    // the orbit radius this round is explicitly not allowed to reopen. Kept
    // modest ("somewhat" tighter, not a hard zoom) since `P.fill` and the
    // kick punch both still add on top of this same base.
    u.uFocal.value = 1.35 + P.fill * 0.8 + st.shock * 0.12
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
    // Floored higher than beats' 20/77 (26%) for that reason: 70/120 (~58%,
    // was 70/150 ~47% before the ceiling cut below).
    // Purely governor-driven, no user dial on top — same call TunnelDriftScene
    // makes for its own `uMaxSteps`, and for the same reason: a dial that
    // could reach this floor would be a dial that breaks the scene.
    //
    // EASED rather than assigned directly (2026-09-17, "horribly bumpy" —
    // see the header's Round 2 section for the full investigation this
    // traces to): outside a transition discount, quality.ts's `applyKnobs()`
    // assigns a tier's raw numbers with NO easing of its own
    // (`this.knobs = base`), so `quality.knobs.raymarchSteps` itself jumps
    // in a single frame every time the governor's hysteresis fires a tier
    // change. This scene sits close enough to the governor's own
    // demote/climb thresholds (see the header) that those changes are not
    // rare, and assigning the resulting target straight to `uMaxSteps` (as
    // this scene used to, and as `TunnelDriftScene`/`BeatsScene` still do)
    // turned every one of them into a visible snap in how far the glow
    // accumulation reaches — a bump with nothing to do with the (already
    // smooth) camera path. `st.stepsSmooth` now tracks the target as a float
    // and is rounded only at the very last moment, so a tier change reads as
    // the lattice gradually gaining or losing depth over roughly a second
    // rather than as a pop. Asymmetric on purpose: FALLING (the governor
    // shedding load) eases in over well under a second — fast enough that a
    // genuine frame-budget rescue is not meaningfully delayed, since
    // quality.ts's separate CONSECUTIVE_OVERBUDGET_FRAMES emergency path
    // already reacts to the RAW measured frame time, not to this uniform —
    // while RISING (the governor offering headroom back) eases in over
    // roughly two seconds, since a climb is explicitly a PROBE in quality.ts
    // (`RUNG_PROOF_SEC`) that may get reverted within 10 s, and there is no
    // reason for the visual to race to spend a headroom grant that might not
    // hold.
    st.stepsSmooth = slew(st.stepsSmooth, raymarchStepsTarget(), dt, 1.3, 3.8)
    u.uMaxSteps.value = Math.round(st.stepsSmooth)
  },
})
