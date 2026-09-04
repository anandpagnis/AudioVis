import * as THREE from 'three'
import { createShaderScene } from '../engine/createShaderScene'
import { quality } from '../engine/quality'
import { drastic } from '../engine/sceneParams'

/**
 * 4D Beats — an inversion-folded 4D lattice, raymarched, with the whole
 * animation driven off the musical beat: `floor(T)` snaps to the beat and
 * `sqrt(fract(T))` eases across it, so the structure lurches forward on every
 * downbeat and settles between.
 *
 * Ported from mrange's minishader **"4D Beats"** (Shadertoy). Its header
 * declares `// CC0`, and the piece reads as mrange's — who releases everything
 * CC0 — so `license: 'original'`, same basis as `truchet` / `maze` /
 * `malachite`. mrange's own in-source note credits tricks/inspiration from
 * (alphabetical) @byt3_m3chanic, @FabriceNeyret2, @iq, @shane, @XorDev; kept
 * here so the provenance is not lost the way mrange worries minishaders lose it.
 *
 * ## FORCED LIVE by explicit request — pending a real /bench
 *
 * This is a 77-step 4D raymarch with **no early ray termination** — every pixel
 * runs the full march, accumulating glow, there is no hit test that breaks the
 * loop. Op-count comparison against the measured roster (`kifs` 2.97 ms at
 * tier 0, ~20 KIFS iterations *with* an escape) puts this several times dearer
 * per pixel, so it was not expected to clear `slotBudget.test.ts`'s tier-0
 * `< sceneBudget(0)/2 = 4 ms` layer-funding bar honestly priced — and `/bench`
 * (the only instrument that could settle it) cannot run from CI. It is
 * registered live in `index.ts`'s `SCENES` array anyway, by explicit request,
 * not because the cost is known to be safe. Its `SCENE_COST_MS` row in
 * `sceneCost.ts` is set to the worst-case tier-0 number that row's own comment
 * states (2-4x the old fabricated-ceiling value, at the 4x end) rather than a
 * fabricated ceiling built to clear the test — so `slotBudget.test.ts`'s
 * "no live scene dear enough to forbid a layer" check now fails honestly for
 * this scene instead of passing on a number nobody believed. `uMaxSteps` is
 * wired to the quality governor so a bench can sweep each tier. Closing this
 * out = run `/bench`, replace the estimate in `sceneCost.ts` with a
 * measurement, and either it clears the budget for real or the scene needs a
 * lower `pixelBudget` / a hard cut to step count / a move back to
 * `DISABLED_SCENES`.
 *
 * A later audit (see "Beat lock, spin, and kick placement" below) fixed three
 * audio-wiring bugs in this scene (beat lock, spin/mids scaling, kick
 * placement) that were independent of this cost question — none of the three
 * touch iteration count or per-iteration op cost, so this section's numbers
 * and status are UNCHANGED by them. `uMaxSteps`'s tier gate was reviewed as
 * part of that same audit (Finding 4) and kept as-is, deliberately, with the
 * real visual tradeoff documented at its computation in `update()` below
 * rather than silently assumed free — see that comment for why cutting steps
 * here is not the "nearly free" case `MazeFlightScene` found for its own
 * march.
 *
 * ## Port notes (Shadertoy -> AudioVis prelude)
 *
 *   iResolution           -> uRes
 *   iChannelTime[0]*1.9    -> uBeats — the source multiplied audio playback
 *                            seconds by 1.9 (= 114 BPM / 60) to get "beats
 *                            elapsed"; here uBeats IS beats, read each frame
 *                            from `ctx.f.beatIndex + ctx.f.beatProgress` (the
 *                            engine's own phase-locked beat grid, not a JS
 *                            integral of `bpm` — see "Beat lock" below), so it
 *                            stays right at any tempo instead of being pinned
 *                            to one track.
 *   mainImage()            -> main() / gl_FragColor, final * uFade
 *   round(x)               -> floor(x + 0.5)   (round() is GLSL ES 3.00 only)
 *   tanh(x)                -> tanh4() polyfill (ES 1.00 has no tanh)
 *   self-colour sin(U.wxyw)-> routed through the four palette slots (uShadow/
 *                            uMid/uAccent/uGlow), same move as malachite/matrix,
 *                            so the scene recolours with the show. The sin
 *                            PHASE and the glow WEIGHT (ph.w) are unchanged.
 *   uninitialised locals   -> explicitly zeroed (the source leans on drivers
 *                            zeroing them; doc 05's "uniform init != black")
 *
 * `tanh(o/1e4)/.9` is mrange's tone map — the `/0.9` is a deliberate slight
 * clip, kept. No linear->sRGB encode here (three's renderer does that).
 *
 * ## What was added (the source is beat-timed only, no band routing)
 *
 *   speed  + energy  -> beat-POSITION multiplier (drastic dial, energy on
 *                       top of the real beat grid — see "Beat lock" below)
 *   onKick           -> uKick: recharges the per-beat brightness flash, decaying
 *   sub / bass       -> uSphere: swells the per-cell 4D sphere
 *   mids             -> spin rate of the XW/YW/ZW rotation (JS-accumulated,
 *                       see "Beat lock" below)
 *   highs            -> uEdge: thins the lattice box walls (hats crisp the grid)
 *
 * ## Band routing
 *
 *   onKick  -> per-beat flash recharge (decaying)
 *   sub     -> lattice sphere radius
 *   mids    -> 4D rotation rate
 *   highs   -> box-wall thinness
 *   energy  -> beat-position throttle
 *
 * ## Beat lock, spin, and kick placement (audit fixes)
 *
 * Three things below `uBeats`, `uMids`, and `uKick` were wrong in a way that
 * only shows up over a live session, not in a single frame:
 *
 * 1. **`uBeats` was free-running off `bpm`'s RATE, not the engine's actual
 *    beat POSITION.** The old `update()` integrated `st.beats += dt *
 *    (bpm/60) * ...` from 0 at mount — a JS clock guessing at the tempo. But
 *    `ctx.f.bpm` is only the rate; `ctx.f.beatIndex + ctx.f.beatProgress` is
 *    the real, self-correcting beat position the engine already tracks (it
 *    snaps on a tempo re-lock; the JS integral never received that
 *    correction and drifted from the track's real kicks). Now `uBeats` reads
 *    the grid directly each frame — `grid * (1 + energy*0.4) * drastic(speed)`
 *    — the same fix TunnelDriftScene's `uBeatPhase` uses (see that scene's
 *    header, "The glow phase, and why it is not `b.pulse` directly"), with
 *    speed/energy kept as a multiplier ON the grid position rather than the
 *    sole driver of it. At neutral (energy 0, speed dial 0.5) `uBeats` tracks
 *    the real beat position exactly; away from neutral it runs faster/slower
 *    than the track on purpose, same as the old dial did — only the baseline
 *    it scales changed, from a guess to the truth.
 *
 * 2. **The XW/YW/ZW spin multiplied live `uMids` against the raw, ever-growing
 *    beat count.** `cos(t * (0.1 + uMids*0.08) + ...)` fed live mids noise
 *    into an argument whose OTHER factor (`t`) grows for the life of the
 *    scene, so the same frame-to-frame mids wobble swings the rotation by
 *    more and more radians the longer the scene has been live — imperceptible
 *    at mount, a multi-radian jump minutes in. Every sibling scene instead
 *    folds a band term into the RATE of a JS-accumulated phase (KifsRoseScene
 *    `st.phase += dt * rate * (1 + s.mids*0.5) * drastic(P.speed)`,
 *    MazeFlightScene/MalachiteScene/NeonJungleScene all the same shape), so
 *    this scene now does too: `uSpin` (replacing `uMids` as a shader uniform)
 *    is JS-accumulated in `update()` from `dt`, not multiplied against a
 *    growing GLSL value, so the sensitivity to a given mids wobble stays
 *    constant regardless of session length.
 *
 * 3. **The kick flash sat inside the 77-step accumulation loop.** `uKick` and
 *    `F` are per-pixel CONSTANTS across the march, so `exp(uKick*1.4)` was
 *    being evaluated (and its constant factor re-applied) on every one of 77
 *    iterations for a value that only needs it once — every sibling raymarch
 *    applies its kick/flash burst ONCE per pixel after the loop instead
 *    (MazeFlightScene's `light` used once inside `shade()`, NeonJungleScene's
 *    `col += NEON*exp(...)*uPortalFlash` one-shot after the march,
 *    KifsRoseScene's `glowAmt` computed once post-loop). The glow term is now
 *    accumulated WITHOUT the kick factor inside the loop, and `exp(uKick*1.4)`
 *    is computed once and applied once to that accumulated subtotal after the
 *    loop — algebraically the same result (the factor is constant, so it was
 *    always mathematically equivalent to pulling it out of the sum), but one
 *    `exp()` per pixel instead of 77, and it now matches the house convention
 *    of "burst applied once" instead of reading as compounding per-step.
 *
 * `uMaxSteps` truncation at low quality tiers is a separate, still-open
 * question — see the ACTION note above and the comment at its computation
 * in `update()` below (Finding 4: this march has no hit test, so cutting
 * steps changes what the lattice reads as, not just how expensive it is;
 * the decision made here is documented at the call site rather than acted on
 * blind). **Finding 5** (reported live, from screenshot: large regions
 * visibly going black on a demotion — the "black bezels" report — root cause
 * is Finding 4's step cut ALSO cutting how many terms `o`'s accumulator
 * sums, so a demoted frame was measurably under-exposed, not just coarser)
 * is fixed at the accumulator itself, in FRAG, right before the tone-map —
 * see that comment for why an exposure compensation is the right minimal
 * response and doesn't touch step count or per-tier cost.
 *
 * Also per direct request: `beatsSpinRate`'s base coefficient was lowered
 * (0.1 -> 0.08) to slow the lattice's rotation slightly. `beatsPosition`'s
 * phase-lock multiplier was deliberately left alone — see that function's
 * own comment for why the beat-lurch rate is not the safe knob to turn down.
 */

export const FRAG = /* glsl */ `
  uniform float uBeats;    // musical time in BEATS (replaces iChannelTime[0]*1.9)
  uniform float uSpin;     // JS-accumulated XW/YW/ZW rotation phase (s.mids folded
                            // into its RATE in update(), not multiplied here against
                            // a growing GLSL value — see the header's "Beat lock,
                            // spin, and kick placement" note, point 2)
  uniform float uSphere;   // 0.2 + bass -> per-cell 4D sphere radius
  uniform float uEdge;     // 0.05 - highs -> lattice box-wall thickness
  uniform float uInv;      // 9 * density -> @mla inversion strength
  uniform float uRoll;     // tilt -> static 4D angle offset
  uniform float uClip;     // contrast -> tanh divisor (clip point)
  // uKick is NOT declared here — SHADER_SCENE_PRELUDE already declares
  // uniform float uKick; (createShaderScene.tsx's "decaying envelope per
  // drum" block, alongside uSnare/uHihat), and the factory concatenates
  // PRELUDE + FRAG as plain strings with no dedup. A second declaration here
  // compiled fine as JS (no typecheck/lint/vitest ever invokes the GL
  // compiler) but GLSL rejects it as a duplicate at global scope, so the
  // shader failed to link and the scene rendered a silent black frame. The
  // uniform is still used below (uKick * 1.4) and still set from JS via the
  // uniforms: () => ({ uKick: ... }) factory call — only the redundant
  // declaration is gone.
  uniform float uMaxSteps; // quality x complexity -> march early-break

  // GLSL ES 1.00 has no tanh(). mrange bundles a tanh_approx; this is the exact
  // rational form with the input clamped so exp() cannot overflow on a hot
  // accumulator.
  vec3 tanh3(vec3 x){
    x = clamp(x, -10.0, 10.0);
    vec3 e = exp(2.0 * x);
    return (e - 1.0) / (e + 1.0);
  }

  void main(){
    vec2 C = gl_FragCoord.xy;

    // source: vec4 o,p,P — accumulator + march position + a saved copy for
    // colour. Only o.rgb survives the tone map, so o is a vec3 here.
    vec3 o = vec3(0.0);
    vec4 p = vec4(0.0), P = vec4(0.0);

    // Musical timing. floor(T) snaps to the beat; sqrt(fract(T)) eases across
    // it (fast attack, decaying). mrange's "floor(T)+sqrt(F)".
    float F = fract(uBeats);
    float t = floor(uBeats) + sqrt(F);

    // mrange's not-quite-rotation: a mat2 built from cos() of a vec4 of phase
    // offsets (11., 33. — from 11.*U.wxzw with U=vec4(1,2,3,0)). uSpin is the
    // JS-accumulated phase (mids widen its rate in update(), not here); tilt
    // adds a static offset.
    vec4 rr = cos(uSpin + uRoll + vec4(0.0, 11.0, 33.0, 0.0));
    mat2 R = mat2(rr.x, rr.y, rr.z, rr.w);

    // ray dir is constant across the march — hoisted out of the loop
    vec3 rd = normalize(vec3(C - 0.5 * uRes, uRes.y));

    float z = 0.0, d = 0.0, k = 0.0;

    // Kick burst factor, hoisted out of the march (Finding 3): uKick is a
    // per-pixel constant, so exp(uKick*1.4) is the same value on every one of
    // up to 77 iterations. Computing it once here and applying it once to the
    // glow subtotal after the loop is the exact same result — the constant
    // factor always distributed linearly out of the sum — for one exp() per
    // pixel instead of 77, and it now reads as a one-shot burst (matching
    // MazeFlightScene/NeonJungleScene/KifsRoseScene's own kick/flash terms)
    // instead of looking like it compounds per step.
    float kickGlow = exp(uKick * 1.4);
    vec3 glow = vec3(0.0);

    for(int iter = 0; iter < 77; iter++){
      if(float(iter) > uMaxSteps) break;

      // ray from camera through this pixel, extended to 4D (w = 0.2), camera
      // pulled back in z
      p = vec4(z * rd, 0.2);
      p.z -= 3.0;

      p.xw *= R;   // rotate in XW
      p.yw *= R;   // rotate in YW
      p.zw *= R;   // rotate in ZW

      // @mla inversion — folds the plain lattice into something worth looking
      // at. uInv is the source's constant 9.0, opened up as the density dial.
      p *= k = uInv / dot(p, p);

      // offset by beat time to move the grid; keep P for the colour phase
      P = p -= 0.5 * t;

      // fold to the unit cell of the infinite lattice
      p = abs(p - floor(p + 0.5));

      // distance field: axis crosses + a 4D sphere per cell + thin box walls,
      // all in one min() tree, divided back out of the inversion scale
      d = abs(
        min(
          min(
            min(min(length(p.xz), length(p.yz)), length(p.xy)),
            length(p) - uSphere
          ),
          min(p.w, min(p.x, min(p.z, p.y))) + uEdge
        )
      ) / k;

      // colour: the source self-coloured from 1.+sin(P.z + log2(k) + U.wxyw)
      // with U.wxyw = (0,1,2,0). Route that phase through the palette instead;
      // ph.w is still the glow weight, unchanged.
      vec4 ph = 1.0 + sin(P.z + log2(k) + vec4(0.0, 1.0, 2.0, 0.0));
      vec3 tint = uShadow + uMid * ph.x + uAccent * ph.y + uGlow * ph.z;

      // accumulate: a beat-synced flash (decays over the beat via 6.*F) in the
      // glow colour, tracked separately from the structural term so the kick
      // burst (kickGlow, constant across the march) can be applied once,
      // after the loop, instead of per-iteration — see Finding 3 above.
      glow += uGlow * exp(0.7 * k - 6.0 * F);
      o += ph.w * tint / max(d, 1e-3);

      z += 0.8 * d + 1e-3;
    }

    // Kick burst applied once to the accumulated glow subtotal (Finding 3).
    o += glow * kickGlow;

    // Step-truncation exposure compensation (Finding 5) — see the header's
    // "black bezels" note and Finding 4 in update() below. o is a SUM over
    // however many of the 77 iterations actually ran (no hit test, so every
    // iteration always contributes), so at a demoted tier's cut uMaxSteps the
    // sum is a fraction of its full-march total — not "the same image at
    // lower detail", genuinely LESS LIGHT gathered, and large regions fell
    // toward black. This does not restore the missing structure (Finding 4's
    // "less of the lattice actually visited" is still true and still costs
    // nothing to leave alone), it restores the EXPOSURE — scaling the total
    // back up to roughly what a full march would have accumulated, so a
    // demoted frame reads as "coarser" rather than "going dark". Safe against
    // overcorrection specifically because tanh() is the very next line: an
    // already-bright region scaled up past its normal range just saturates at
    // the same ceiling a full march hits, it cannot blow out further.
    o *= 77.0 / max(uMaxSteps, 1.0);

    // mrange's tone map: tanh, then /0.9 for a deliberate slight clip. Then the
    // one edit every ported shader owes the compositor.
    vec3 col = tanh3(o / uClip) / 0.9;
    gl_FragColor = vec4(col * uFade, 1.0);
  }
`

/**
 * Beat position for `uBeats` — phase-locked to the engine's real beat grid
 * (`beatIndex + beatProgress`) rather than integrated from `bpm` alone
 * (Finding 1). Pure and exported so the lock invariant is unit-testable
 * without a GL context: see `__tests__/BeatsScene.test.ts`.
 *
 * At `mult === 1` (energy 0, `drastic(P.speed)` at its neutral 1) this
 * returns the grid position exactly — the phase-lock the fix exists for.
 * Away from 1, `mult` scales how fast the beat position moves relative to
 * the real grid, same as the old free-running dial did, but now multiplying
 * the correct baseline instead of a JS clock guessing at the tempo.
 */
export function beatsPosition(beatIndex: number, beatProgress: number, mult: number): number {
  return (beatIndex + beatProgress) * mult
}

/**
 * Per-frame rate for the JS-accumulated spin phase (`uSpin`, Finding 2) —
 * tempo-scaled so the rotation keeps its original beat-relative cadence
 * (same `bpm > 0 ? bpm : 120` fallback `uBeats` uses), with `mids` widening
 * the RATE rather than being multiplied against a raw, ever-growing GLSL
 * value.
 *
 * Base coefficient lowered from mrange's source `0.1` to `0.08` (requested:
 * "slightly slow down 4D Beats") — deliberately touching THIS constant and
 * not `beatsPosition`'s beat-lock multiplier: `st.beats` is phase-LOCKED to
 * the engine's real beat grid at neutral (Finding 1 above — "at mult===1
 * this returns the grid position exactly"), so scaling it down would detune
 * the lurch from the track's actual tempo, reopening the exact bug that fix
 * exists to close. `uSpin` carries none of that invariant — it is a purely
 * cosmetic JS-accumulated rotation with no "correct" rate to preserve — so
 * it is the one speed knob in this scene safe to turn down on its own. 20%
 * off the base keeps the same mids-widening ratio, `0.08 .. 0.144` at
 * `mids` 0..1 (was `0.1 .. 0.18`).
 */
export function beatsSpinRate(bpm: number, mids: number): number {
  const effectiveBpm = bpm > 0 ? bpm : 120
  return (effectiveBpm / 60) * 0.08 * (1 + mids * 0.8)
}

interface BeatsState {
  /** Current phase-locked beat position (recomputed from the grid each frame — see {@link beatsPosition}). */
  beats: number
  /** Per-beat flash charge, kicked up by onKick, decaying. */
  kick: number
  /** XW/YW/ZW rotation phase, JS-accumulated so mids doesn't multiply against an ever-growing beat count (Finding 2). */
  spin: number
}

export const BeatsScene = createShaderScene<BeatsState>({
  id: 'beats',
  frag: FRAG,
  // Paints its own black background — replace, not blend, for the offscreen
  // buffer (BlendedLayer forces `add` on the on-screen primary anyway).
  blending: THREE.NoBlending,
  // STARTING POINT, not a measurement — a 77-step 4D march with no early-out.
  // Renders offscreen well below native and upscales (the glow + tanh clip hide
  // it). Replace with a real /bench sweep before promotion into SCENES.
  pixelBudget: () => (quality.knobs.raymarchSteps >= 50 ? 1.2 : 0.7),
  uniforms: () => ({
    uBeats: { value: 0 },
    uSpin: { value: 0 },
    uSphere: { value: 0.2 },
    uEdge: { value: 0.05 },
    uInv: { value: 9 },
    uRoll: { value: 0 },
    uClip: { value: 1e4 },
    uKick: { value: 0 },
    uMaxSteps: { value: 77 },
  }),
  state: () => ({ beats: 0, kick: 0, spin: 0 }),
  update({ u, s, P, st, dt, ctx }) {
    // Beat position, phase-locked to the engine's real beat grid rather than
    // integrated from `bpm` alone (Finding 1 — see the header's "Beat lock,
    // spin, and kick placement" note). `ctx.f.beatIndex + ctx.f.beatProgress`
    // free-runs at the engine's own 120-BPM default before a tempo locks (see
    // `createEmptyFeatures`'s own comment: "the beat grid free-runs at a sane
    // default ... so idle motion is musical rather than frozen"), so a track
    // with no beat grid still turns — the roster's "frozen reads as broken"
    // rule (cf. KaleidoPulseScene) — with no separate fallback needed here.
    st.beats = beatsPosition(ctx.f.beatIndex, ctx.f.beatProgress, (1 + s.energy * 0.4) * drastic(P.speed))

    // Rotation phase (Finding 2): JS-accumulated from `dt` at a tempo-scaled
    // rate, mids widening the RATE rather than being multiplied against
    // `st.beats` in the shader — see `beatsSpinRate`.
    st.spin += dt * beatsSpinRate(ctx.f.bpm, s.mids) * drastic(P.speed)

    if (s.onKick > 0) st.kick = Math.min(1.5, st.kick + s.onKick)
    st.kick *= Math.exp(-dt * 3.5)

    u.uBeats.value = st.beats
    u.uKick.value = st.kick
    u.uSpin.value = st.spin
    // Neutral (no audio) reproduces the source constants: sphere 0.2, edge 0.05.
    u.uSphere.value = 0.2 + s.sub * 0.14
    u.uEdge.value = Math.max(0.015, 0.05 - s.highs * 0.03)

    // Contract dials — each neutral (0.5) reproduces the source's own constant,
    // so adding the contract is not a visual change (the default-neutral
    // invariant).
    u.uInv.value = 9 * (0.6 + 0.8 * P.density) // 0.5 -> 9.0
    u.uRoll.value = (P.tilt - 0.5) * 3.0 // 0.5 -> 0
    u.uClip.value = 1e4 * (1.9 - 1.8 * P.contrast) // 0.5 -> 1e4

    // The one quality lever: break the march early. quality.knobs.raymarchSteps
    // peaks at 96 (tier 0); complexity rides on top, 0.5 leaving the full 77.
    //
    // Finding 4 (audit): kept deliberately, not switched to MazeFlightScene's
    // "never tier-gate the march" convention, because the two scenes' marches
    // are not the same shape. MazeFlightScene's march has a HIT TEST (`if (d <
    // 0.0013*(...) || t > uTMax) break;`) — most pixels converge and stop well
    // under its step cap on their own, which is exactly why that scene's own
    // profiling found cutting steps "nearly free" (96->48 ~5%) and moved the
    // cut to `pixelBudget` instead. This march has NO hit test: every pixel
    // always runs every step it's given, each one both adding to the glow
    // accumulator (`o`/`glow` above) AND advancing how far into the 4D lattice
    // `z` reaches (`p *= k = uInv/dot(p,p)` folds fresh lattice cells in at
    // every step). Cutting `uMaxSteps` from 77 to the 20-step floor (26%) is
    // not a softer version of the same image the way a hit-test march's cut
    // is — it is fewer lattice cells actually visited, i.e. less of the
    // structure the shader is supposed to be drawing. That part is still
    // real, still unavoidable without more steps, and still not fixed here.
    //
    // What WAS fixed (Finding 5, reported live: large regions visibly going
    // black on a demotion, not just reading coarser): `o`'s per-iteration
    // accumulation means the total gathered light scales with how many of
    // the 77 steps actually ran, so a hard cut to the 20-step floor was not
    // just less detail, it was measurably less exposed — an increasing
    // fraction of the frame fell toward black as uMaxSteps dropped. Fixed at
    // the accumulator, not here: see the `o *= 77.0 / uMaxSteps` compensation
    // right before the tone-map in FRAG, and its own comment for why scaling
    // exposure back up (not adding steps back) is the correct, cheap
    // response to specifically THAT symptom. The kick flash reading weaker
    // at low tiers (per Finding 3, `glow`'s smaller subtotal) is covered by
    // the same compensation, since it runs on the combined `o` after
    // `o += glow * kickGlow`.
    //
    // Reducing the real per-tier COST without the remaining structural
    // consequence would still mean removing/cheapening per-iteration ops
    // (the `dot()`/inversion/min-tree work), not cutting how many of the 77
    // steps run — a shader rewrite outside this fix's scope, and one that
    // needs a rendered A/B to trust, not a guess. Left as `/bench`'s job (see
    // the header's FORCED LIVE section); `SCENE_COST_MS.beats` is unchanged —
    // the exposure fix changes what a demoted frame looks like, not what it
    // costs.
    const qFrac = Math.min(1, quality.knobs.raymarchSteps / 96)
    u.uMaxSteps.value = Math.max(
      20,
      Math.min(77, Math.round(77 * qFrac * (0.55 + 0.9 * P.complexity))),
    )
  },
})
