import * as THREE from 'three'
import { createShaderScene } from '../engine/createShaderScene'
import { quality } from '../engine/quality'
import { slew } from '../engine/response'
import { beatsPosition } from './BeatsScene'
import { bipolar, drastic } from './contract'

/**
 * JavaZone Lattice — a beat-locked flythrough down a rounded 4D lattice,
 * z-twisting as it advances, with a sharp flash timed to land exactly on
 * every downbeat.
 *
 * Shadertoy source "JavaZone 2026 Shader" ("Shader created during my
 * JavaZone 2026 presentation... No slides, just code"). Header is an
 * explicit, named CC0 declaration identical in wording to `fridaylines`' —
 * "mrange has waived all copyright..." — so `license: 'original'`, same
 * basis as `beats` / `travelling` / `web` / `fridaylines`.
 *
 * ## FORCED LIVE by explicit request — pending a real /bench
 *
 * 77-step accumulation with NO early-out at all (unlike `fridaylines`' soft
 * `z < 49.0` exit) -- the closest true analogue is `beats`, same author,
 * same iteration count, same `tanh(o/2e4)` shape. `SCENE_COST_MS.javazone`
 * in `sceneCost.ts` is a documented worst-case op-count estimate, not a
 * fabricated ceiling built to clear `slotBudget.test.ts` — see that row's
 * own comment. ACTION: run `/bench` and replace it with a measurement.
 *
 * ## Port notes (Shadertoy -> AudioVis prelude)
 *
 *   iResolution.xy   -> uRes (focal length generalised into `uFocal`)
 *   `BPM=85.` clock  -> `beatsPosition()`, imported from `BeatsScene` rather
 *                       than reimplemented: this shader's own
 *                       `FT=sqrt(fract(iTime*BPM/60.))`,
 *                       `NT=floor(iTime*BPM/60.)` idiom IS `beats`'
 *                       `floor(T)+sqrt(fract(T))` beat-lock move, verbatim,
 *                       by the same author -- reusing the helper means this
 *                       scene inherits the real-beat-grid fix `beats`' own
 *                       audit already found necessary (a hardcoded BPM
 *                       constant free-runs and drifts from the track; the
 *                       engine's `beatIndex + beatProgress` does not), rather
 *                       than reintroducing that bug from scratch.
 *   round(p)         -> floor(p + 0.5) (GLSL ES 1.00 has no round() -- same
 *                       fix `beats`' port documents for its own source)
 *   self-colour      -> routed through the four palette slots, same move
 *                       `beats`/`fridaylines` make for their near-identical
 *                       `1.+sin(...)` colour terms
 *   tanh()           -> tanh3() polyfill, copied from `beats`
 *   uninitialised `z`-> starts explicitly at 0.0 (the source's
 *                       `float i,d,z,FT=...` leaves z without an
 *                       initialiser; same fix class `beats`' port documents)
 *
 * The beat-flash term (`pow(1.-FT,4.)*pow(z,n)*vec4(3,2,1,0)`) is the
 * source's OWN design, not something this port added -- it is largest right
 * at FT=0, i.e. exactly on the beat. Kept as-is; `onKick` only adds a boost
 * on top (`uFlash`), it does not replace the mechanism. Its exact exponent
 * and coefficient were tuned down 2026-09-17 (see below) -- the on-beat
 * timing itself is untouched.
 *
 * ## 2026-09-17 fixes ("too jerky" + "center flashing too much" + "sometimes
 * blacks out")
 *
 * Two independent reports, two independent root causes:
 *
 * 1. Flash magnitude. The flash term multiplied the raw raymarch accumulator
 *    `z` (how far a given pixel's ray travelled through the lattice, see the
 *    loop above) by itself to the 4th power, then by 9.0, then by `uFlash`
 *    (itself already boosted up to 2.8x by `st.shock` on a kick). `z` is NOT
 *    a bounded 0..1 quantity -- through an open channel where the ray clears
 *    many cells before hitting a wall (most visibly looking straight down
 *    the tunnel CENTER, where `d` stays near `uCellR` every step instead of
 *    shrinking toward a surface) `z` can reach an order of magnitude larger
 *    than it does near a hit. Raised to the 4th power and multiplied by 9,
 *    that difference becomes enormous -- exactly the "center flashing too
 *    much" symptom -- and because it lands as a hard spike right on the beat
 *    (FT=0) with no smoothing, it also reads as an abrupt pop ("too jerky").
 *    Fixed by (a) clamping `z` before the power (see `zFlash` below) so an
 *    unusually long unobstructed ray can no longer blow the flash out far
 *    past every other pixel, (b) lowering the exponent 4 -> 2 and the
 *    coefficient 9 -> 4 so the accent reads as a highlight rather than an
 *    overexposing pop, and (c) halving `uFlash`'s kick-boost multiplier
 *    (1.2 -> 0.5) so a beat and a kick landing on the same frame no longer
 *    compound two multiplicative spikes into an extreme one. The beat-lock
 *    mechanism itself (`FT`, `pow(1-FT,4)`) is untouched -- only magnitude
 *    moved.
 *
 * 2. Intermittent full black-out. `update()`'s `qFrac` read
 *    `quality.knobs.raymarchSteps` and fed it straight through
 *    `Math.round(77 * Math.min(1, raw / 96))` with no finiteness check. Every
 *    live codepath in `engine/quality.ts` happens to always assign a numeric
 *    `TIERS[n].raymarchSteps` to `knobs` -- but `QualityGovernor.applyKnobs()`
 *    computes the DISCOUNTED variant as `mix(base, cheaper)` where `mix`'s
 *    weight `a` is `this.discount`, and `this.discount` is whatever
 *    `SceneManager` last passed to `setTransitionDiscount()` with only a
 *    `Math.min(1, Math.max(0, amount))` clamp -- `Math.max(0, NaN)` is `NaN`,
 *    so a NaN `amount` (e.g. from an eased transition timer dividing by a
 *    zero-length duration somewhere upstream) survives that clamp as NaN and
 *    propagates into `knobs.raymarchSteps`. If that ever lines up with this
 *    scene's own `update()` tick, `qFrac` becomes NaN, `Math.round(NaN)` is
 *    NaN, and `u.uMaxSteps.value` becomes NaN -- which three.js commonly
 *    uploads to a GLSL `int` uniform as 0. With `uMaxSteps` 0 the raymarch
 *    loop's `if (idx >= uMaxSteps) break;` fires at `idx` 0 (`0 >= 0`), so
 *    the loop runs ZERO iterations, `o` and `z` stay exactly `vec3(0.0)` /
 *    `0.0` for the whole frame, and `tanh3(vec3(0.0) / uClip)` is exactly
 *    black -- a full black-out with no error, matching the report precisely.
 *    Fixed defensively in THIS file only (see `update()`): `qFrac` now falls
 *    back to `1` (full, safe step count) instead of computing a NaN whenever
 *    `quality.knobs.raymarchSteps` is not a finite number, so a bad read from
 *    the governor can never zero out this scene's raymarch loop again,
 *    regardless of whether the exact NaN-producing path above is the only
 *    one that can reach it.
 *
 * ## What was added (the source is BPM-clock + colour dials only)
 *
 *   speed + energy -> beat-position multiplier (drastic dial, energy on top
 *                     of the real beat grid -- identical to `beats`' own fix)
 *   shape          -> lattice cell radius (source const 0.53)
 *   complexity     -> surface-roughness / bump strength (source const 0.008)
 *   density        -> z-twist rate (source const 0.6)
 *   contrast       -> tanh divisor (source const 2e4)
 *   fill           -> focal length / zoom
 *   tilt           -> static offset on the z-twist rotation phase
 *   onKick         -> uFlash: extra boost on the source's own beat-flash term
 *   sub            -> N/A (no natural continuous hook distinct from the
 *                     cell-radius dial without fighting it)
 *   highs          -> roughness boost on top of the complexity dial
 *
 * ## Band routing
 *
 *   onKick  -> boosts the source's own on-beat flash term
 *   mids    -> folded into the beat-position multiplier, same as `beats`
 *   highs   -> extra surface roughness
 *   energy  -> beat-position multiplier (brighter/faster on louder passages)
 *
 * ## Scene Contract
 *
 *   speed       beat-position rate
 *   shape       lattice cell radius — "cell"
 *   complexity  surface roughness / bump strength — "roughness"
 *   density     z-twist rate — "twist"
 *   contrast    tanh clip point
 *   fill        focal length / zoom
 *   tilt        static z-twist offset — "roll"
 */

export const FRAG = /* glsl */ `
  uniform float uBeats;    // beatsPosition() result (speed+energy applied JS-side) --
                            // FLASH timing only (FT below); NOT used for spatial
                            // travel, see uTravel
  uniform float uTravel;   // JS-accumulated forward travel through the lattice --
                            // strictly increasing, drives Tz (see main()'s own note
                            // and update())
  uniform float uCellR;    // shape dial -> lattice cell radius, source 0.53
  uniform float uRough;    // complexity dial (+highs) -> bump strength, source 0.008
  uniform float uTwist;    // density dial -> z-twist rate, source 0.6
  uniform float uClip;     // contrast dial -> tanh divisor, source 2e4
  uniform float uFocal;    // fill dial -> zoom
  uniform float uRoll;     // tilt dial (+transient) -> static twist offset
  uniform float uFlash;    // onKick -> boost on the source's own beat-flash term
  uniform int   uMaxSteps;

  vec3 tanh3(vec3 x) {
    x = clamp(x, -10.0, 10.0);
    vec3 e = exp(2.0 * x);
    return (e - 1.0) / (e + 1.0);
  }

  void main() {
    float FT = sqrt(fract(uBeats));
    float T = floor(uBeats) + FT;
    // Spatial travel through the lattice is uTravel, a JS-accumulated,
    // strictly-increasing counter (see update()) -- NOT derived from T/uBeats.
    // Report (2026-09-16): "move forward on beat not back and forth". Root
    // cause: T (and the old in-shader Tz = T * FLOW_SCALE) is
    // floor(uBeats) + sqrt(fract(uBeats)), and uBeats itself is
    // (beatIndex + beatProgress) * mult where mult is a LIVE, audio-reactive
    // multiplier (energy/speed) recomputed every frame. That is fine for
    // FT/T's actual job -- the on-beat FLASH below only needs
    // fract(uBeats), which stays correct under any positive mult -- but it
    // is the wrong shape for a POSITION: multiplying an ever-growing clock
    // (beatIndex+beatProgress) by a shrinking mult doesn't just slow the
    // product down, it can drive it BACKWARD (e.g. beatIndex+beatProgress
    // 200, mult drops 1.2 -> 1.0 in one frame: 240 -> 200, a hard reverse),
    // which reads exactly as "back and forth" instead of continuous forward
    // travel. uTravel sidesteps this the same way BeatsScene's uSpin fixes
    // the identical shape for its rotation phase (see that file's "Beat
    // lock, spin, and kick placement" note, Finding 2): accumulate from dt
    // in JS instead of multiplying a growing GLSL value, so every increment
    // added is >= 0 and the running total can only ever grow.
    float Tz = uTravel;

    vec3 rd = normalize(vec3(gl_FragCoord.xy - 0.5 * uRes.xy, uRes.y * uFocal));
    float z = 0.0;
    vec3 o = vec3(0.0);

    for (int idx = 0; idx < 77; idx++) {
      if (idx >= uMaxSteps) break;

      vec4 p = vec4(z * rd, 0.0);
      p.z += Tz;

      mat2 R = mat2(cos(uTwist * p.z + 0.4 * Tz + uRoll + vec4(0.0, 11.0, 33.0, 0.0)));
      p.xy *= R;
      vec4 P = p;
      vec4 Sn = sin(117.0 * p);
      p -= floor(p + 0.5);

      float d = uCellR - sqrt(length(p * p));
      d += uRough * (Sn.x + Sn.y + Sn.z);
      d = abs(d) + 1e-3;

      vec4 ph = 1.0 + sin(0.5 * P.z + 4.0 * P.x + vec4(6.0, 2.0, 10.0, 1.0));
      vec3 tint = uShadow + uMid * ph.x + uAccent * ph.y + uGlow * ph.z;
      o += (ph.w / max(d, 1e-3)) * tint;

      z += 0.8 * d;
    }

    // The source's own on-beat flash -- sharpest exactly at FT=0. uFlash only
    // scales it (onKick boost); it is not what creates the beat-lock.
    //
    // z (the raymarch accumulator above) is clamped before the power -- see
    // the file's own 2026-09-17 header note. Down an open channel (most
    // visibly straight through the tunnel center) z can run far larger than
    // it does near a hit surface, and left unclamped that made the flash
    // blow out hardest exactly there. 3.0 sits comfortably above the z a
    // typical near-surface hit accumulates (see the loop's own d ~ uCellR
    // range) so ordinary flashes are unaffected; only the unbounded-open-path
    // outlier gets capped.
    float zFlash = min(z, 3.0);
    // Exponent 4 -> 2 and coefficient 9 -> 4 (2026-09-17, was pow(z,4.0)*9.0):
    // softer response curve on top of the clamp above, so the accent reads as
    // a highlight rather than an overexposing pop even at zFlash's own cap.
    o += uFlash * pow(1.0 - FT, 4.0) * 4.0 * pow(zFlash, 2.0) * vec3(3.0, 2.0, 1.0);

    vec3 col = tanh3(o / uClip);
    gl_FragColor = vec4(col * uFade, 1.0);
  }
`

// Tz-units of forward travel added per beat at neutral speed/energy -- the
// same 0.4 this scene has used since the 2026-09-11 "too fast" fix, just
// applied as a JS-accumulated rate now instead of a shader-side multiply of
// T. See update()'s own note (2026-09-16, "back and forth") for why it moved.
const FLOW_SCALE_PER_BEAT = 0.4

// How much extra forward speed the on-beat push adds, at its peak (right on
// the beat, decaying to 0 by mid-beat). 0 would make travel a flat drift with
// no beat feel at all; kept modest so the push reads as a lurch, not a jolt.
const BEAT_PUSH_STRENGTH = 0.6

interface JavaZoneState {
  /** Phase-locked beat position, recomputed from the grid each frame --
   *  drives the on-beat FLASH (FT) only, not spatial travel. */
  beats: number
  /** Extra beat-flash boost, decaying. */
  shock: number
  /** `s.energy`, slewed — see `update()`'s own note on why the raw band
   *  feeds `beatsPosition`'s multiplier through a smoother rather than
   *  directly. */
  energySlew: number
  /** JS-accumulated forward travel through the lattice (Tz in FRAG) --
   *  monotonically increasing, dt by dt, so it can never run backward
   *  regardless of how the audio-reactive rate multiplier moves. See
   *  main()'s own note on the "back and forth" report this replaces. */
  travel: number
}

export const JavaZoneLatticeScene = createShaderScene<JavaZoneState>({
  id: 'javazone',
  frag: FRAG,
  blending: THREE.NoBlending,
  // Offscreen + upscale, same shape as beats -- the closest true analogue.
  // Starting point pending /bench, not a measurement.
  pixelBudget: () => (quality.knobs.raymarchSteps >= 50 ? 1.2 : 0.7),
  uniforms: () => ({
    uBeats: { value: 0 },
    uTravel: { value: 0 },
    uCellR: { value: 0.53 },
    uRough: { value: 0.008 },
    uTwist: { value: 0.6 },
    uClip: { value: 2e4 },
    uFocal: { value: 1 },
    uRoll: { value: 0 },
    uFlash: { value: 1 },
    uMaxSteps: { value: 77 },
  }),
  state: () => ({ beats: 0, shock: 0, energySlew: 0, travel: 0 }),
  update({ u, s, P, st, dt, ctx }) {
    // Phase-locked to the engine's real beat grid, exactly as beats' own
    // audit fixed it -- see the header's port notes.
    //
    // Smoothed and slowed on direct request (2026-09-07): `beatsPosition`'s
    // own multiplier is deliberately NOT the axis to touch for either ask —
    // `BeatsScene.beatsPosition`'s own doc is explicit that `mult === 1`
    // (energy 0, `drastic(speed)` neutral) reproduces the real beat grid
    // exactly, and de-tuning that base would reopen the phase-drift bug that
    // lock exists to close (see the near-identical prior request against
    // `beats` itself, handled there by touching `uSpin`'s rate instead of
    // this multiplier — same reasoning applies here). What moved instead: the
    // `s.energy` term riding on top of the lock, which used to read the raw
    // band straight into the multiplier every frame — a live, unsmoothed
    // signal directly speeding up and slowing down a beat-locked clock reads
    // as jerky rather than musical. Slewed the same way `GyroidFluxScene`'s
    // mids term now is, and its own swing cut by more than half (0.4 -> 0.15)
    // for "slow down" — the lock at neutral energy is unchanged either way.
    //
    // Still reported "too fast" after that fix (2026-09-11) — a DIFFERENT
    // axis than the one above: `mult` governs the beat GRID's phase rate
    // (how fast T itself ticks, which is what must never detune), but how
    // FAR the camera visibly travels/twists through the lattice for each
    // tick of T is a wholly separate question, and that is what actually
    // read as fast. At the time this was fixed by scaling a COPY of T
    // (`FLOW_SCALE`, in-shader) used only for spatial position and twist,
    // leaving the real T (and therefore the on-beat flash's own timing,
    // `FT`) untouched.
    //
    // Report (2026-09-16): "move forward on beat not back and forth" —
    // `FLOW_SCALE * T` was still a straight multiply of the ever-growing
    // `beatIndex + beatProgress` clock by a live `mult`, and that PRODUCT can
    // step backward when `mult` drops even though `mult` itself never goes
    // negative (see FRAG's own note on `uTravel` for the arithmetic). Beat
    // position (`st.beats`/`uBeats`/T/FT) stays exactly as above — it only
    // has to be phase-correct for the flash, a momentary wobble there is
    // invisible — but the spatial travel term is now `st.travel`,
    // accumulated from `dt` below so every increment is >= 0 and it can only
    // ever move forward, the same fix shape as `BeatsScene`'s `uSpin`.
    st.energySlew = slew(st.energySlew, s.energy, dt, 3, 3)
    st.beats = beatsPosition(
      ctx.f.beatIndex,
      ctx.f.beatProgress,
      (1 + st.energySlew * 0.15) * drastic(P.speed),
    )
    if (s.onKick > 0) st.shock = Math.min(1.5, st.shock + s.onKick)
    st.shock *= Math.exp(-dt * 3.5)

    // Forward travel through the lattice (replaces the old `FLOW_SCALE * T`
    // spatial term — see the notes above and in FRAG). `FLOW_SCALE_PER_BEAT`
    // is the same 0.4 Tz-units-per-beat this scene has always moved at;
    // `bps` converts it to a per-second rate off the real tempo (falls back
    // to 120 before a tempo locks, same convention as `beatsSpinRate`).
    // `beatPush` reuses the flash's own `pow(1-x, n)` decay shape — sharp
    // right on the beat (`beatProgress` 0), fully decayed by mid-beat — so
    // travel visibly QUICKENS on each beat (the "push" the report asked for)
    // without ever being able to reverse: it only ever adds extra forward
    // speed, never negative speed.
    const bps = (ctx.f.bpm > 0 ? ctx.f.bpm : 120) / 60
    const beatPush = Math.pow(1 - ctx.f.beatProgress, 3)
    const travelRate = bps * FLOW_SCALE_PER_BEAT * (1 + beatPush * BEAT_PUSH_STRENGTH)
    st.travel += dt * travelRate * (1 + st.energySlew * 0.15) * drastic(P.speed)

    u.uBeats.value = st.beats
    u.uTravel.value = st.travel
    // shape 0.5 -> 0.53 (source const)
    u.uCellR.value = 0.53 + bipolar(P.shape, 0.15)
    // complexity 0.5 -> 0.008 (source const); highs adds further roughness
    u.uRough.value = Math.max(0, 0.008 + bipolar(P.complexity, 0.006) + s.highs * 0.006)
    // density 0.5 -> 0.6 (source const)
    u.uTwist.value = 0.6 + bipolar(P.density, 0.3)
    // contrast 0.5 -> 2e4 (source const)
    u.uClip.value = 2e4 * (1.6 - 1.2 * P.contrast)
    // fill 0.5 -> 1.0 (source const)
    u.uFocal.value = 0.6 + P.fill * 0.8
    // tilt replaces nothing in the source; transient adds a dynamic flinch
    u.uRoll.value = bipolar(P.tilt, 2.0) + ctx.b.transient * 0.6
    // onKick boosts the source's own on-beat flash term on top of its
    // baseline (1.0 reproduces the source exactly with no kick active).
    // Multiplier 1.2 -> 0.5 (2026-09-17): halved so a beat and a kick landing
    // on the same frame don't compound two multiplicative spikes (this
    // boost x the FRAG-side flash term, itself softened the same session)
    // into an extreme one -- see the file's own header note.
    u.uFlash.value = 1 + st.shock * 0.5

    // No hit-based early-out (see header) -- same Finding-4 shape `beats`
    // documents. Floored at the same 26% ratio beats itself uses (20/77),
    // since this is structurally its closest sibling.
    //
    // Defensive NaN guard (2026-09-17, see header's "Intermittent full
    // black-out" note): `quality.knobs.raymarchSteps` is a plain field on a
    // mutable governor object, not something this scene controls, and at
    // least one live path (`QualityGovernor.applyKnobs()`'s discount mix,
    // fed by `SceneManager`'s `setTransitionDiscount`) can in principle carry
    // a NaN into it. A NaN here would propagate through every step below --
    // `Math.round`/`Math.min`/`Math.max` all return NaN when given one -- and
    // land in `u.uMaxSteps.value` as NaN, which three.js commonly uploads to
    // this GLSL `int` uniform as 0, making the raymarch loop's own
    // `idx >= uMaxSteps` break fire at idx 0 and render the whole frame
    // black. Falling back to `1` (full step count, i.e. the safest/richest
    // setting) rather than propagating NaN means a bad governor read can
    // never zero out this scene's loop, even if the exact trigger above
    // turns out not to be the only way to reach it.
    const rawSteps = quality.knobs.raymarchSteps
    const qFrac = Number.isFinite(rawSteps) ? Math.min(1, rawSteps / 96) : 1
    u.uMaxSteps.value = Math.max(20, Math.min(77, Math.round(77 * qFrac)))
  },
})
