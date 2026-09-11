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
 * The beat-flash term (`pow(1.-FT,4.)*9.*pow(z,4.)*vec4(3,2,1,0)`) is the
 * source's OWN design, not something this port added -- it is largest right
 * at FT=0, i.e. exactly on the beat. Kept as-is; `onKick` only adds a boost
 * on top (`uFlash`), it does not replace the mechanism.
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
  uniform float uBeats;    // beatsPosition() result (speed+energy applied JS-side)
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

  // How far the camera travels/twists through the lattice per beat,
  // independent of the beat GRID's own rate (T below, which the flash at
  // the bottom of main() needs unscaled to stay locked exactly on the
  // beat). Slowed on direct request (2026-09-11, "too fast still, slow it
  // down significantly") -- see update()'s own note on why this axis moved
  // and not T's.
  const float FLOW_SCALE = 0.4;

  void main() {
    float FT = sqrt(fract(uBeats));
    float T = floor(uBeats) + FT;
    float Tz = T * FLOW_SCALE;

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
    o += uFlash * pow(1.0 - FT, 4.0) * 9.0 * pow(z, 4.0) * vec3(3.0, 2.0, 1.0);

    vec3 col = tanh3(o / uClip);
    gl_FragColor = vec4(col * uFade, 1.0);
  }
`

interface JavaZoneState {
  /** Phase-locked beat position, recomputed from the grid each frame. */
  beats: number
  /** Extra beat-flash boost, decaying. */
  shock: number
  /** `s.energy`, slewed — see `update()`'s own note on why the raw band
   *  feeds `beatsPosition`'s multiplier through a smoother rather than
   *  directly. */
  energySlew: number
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
    uCellR: { value: 0.53 },
    uRough: { value: 0.008 },
    uTwist: { value: 0.6 },
    uClip: { value: 2e4 },
    uFocal: { value: 1 },
    uRoll: { value: 0 },
    uFlash: { value: 1 },
    uMaxSteps: { value: 77 },
  }),
  state: () => ({ beats: 0, shock: 0, energySlew: 0 }),
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
    // read as fast. Fixed in FRAG — see `FLOW_SCALE` there — by scaling a
    // COPY of T used only for spatial position and twist, leaving the real
    // T (and therefore the on-beat flash's own timing, `FT`) untouched. Same
    // shape as the fix directly above: find the cosmetic axis next to the
    // locked one, not the locked one itself.
    st.energySlew = slew(st.energySlew, s.energy, dt, 3, 3)
    st.beats = beatsPosition(
      ctx.f.beatIndex,
      ctx.f.beatProgress,
      (1 + st.energySlew * 0.15) * drastic(P.speed),
    )
    if (s.onKick > 0) st.shock = Math.min(1.5, st.shock + s.onKick)
    st.shock *= Math.exp(-dt * 3.5)

    u.uBeats.value = st.beats
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
    // baseline (1.0 reproduces the source exactly with no kick active)
    u.uFlash.value = 1 + st.shock * 1.2

    // No hit-based early-out (see header) -- same Finding-4 shape `beats`
    // documents. Floored at the same 26% ratio beats itself uses (20/77),
    // since this is structurally its closest sibling.
    const qFrac = Math.min(1, quality.knobs.raymarchSteps / 96)
    u.uMaxSteps.value = Math.max(20, Math.min(77, Math.round(77 * qFrac)))
  },
})
