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
 * ## HELD OUT in DISABLED_SCENES — pending a real /bench
 *
 * This is a 77-step 4D raymarch with **no early ray termination** — every pixel
 * runs the full march, accumulating glow, there is no hit test that breaks the
 * loop. Op-count comparison against the measured roster (`kifs` 2.97 ms at
 * tier 0, ~20 KIFS iterations *with* an escape) puts this several times dearer
 * per pixel, so it is not expected to clear `slotBudget.test.ts`'s tier-0
 * `< sceneBudget(0)/2 = 4 ms` layer-funding bar as-is, and `/bench` (the only
 * instrument) cannot run from CI. `uMaxSteps` is wired to the quality governor
 * so a bench can sweep each tier. Promotion = move the object literal in
 * `index.ts` into `SCENES` + add a measured `SCENE_COST_MS` row.
 *
 * ## Port notes (Shadertoy -> AudioVis prelude)
 *
 *   iResolution           -> uRes
 *   iChannelTime[0]*1.9    -> uBeats — the source multiplied audio playback
 *                            seconds by 1.9 (= 114 BPM / 60) to get "beats
 *                            elapsed"; here uBeats IS beats, accumulated in
 *                            update() from ctx.f.bpm, so it stays right at any
 *                            tempo instead of being pinned to one track.
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
 *   speed  + energy  -> beat-rate multiplier (drastic dial, energy on top)
 *   onKick           -> uKick: recharges the per-beat brightness flash, decaying
 *   sub / bass       -> uSphere: swells the per-cell 4D sphere
 *   mids             -> spin rate of the XW/YW/ZW rotation
 *   highs            -> uEdge: thins the lattice box walls (hats crisp the grid)
 *
 * ## Band routing
 *
 *   onKick  -> per-beat flash recharge (decaying)
 *   sub     -> lattice sphere radius
 *   mids    -> 4D rotation rate
 *   highs   -> box-wall thinness
 *   energy  -> beat-rate throttle
 */

export const FRAG = /* glsl */ `
  uniform float uBeats;    // musical time in BEATS (replaces iChannelTime[0]*1.9)
  uniform float uMids;     // s.mids -> spin rate
  uniform float uSphere;   // 0.2 + bass -> per-cell 4D sphere radius
  uniform float uEdge;     // 0.05 - highs -> lattice box-wall thickness
  uniform float uInv;      // 9 * density -> @mla inversion strength
  uniform float uRoll;     // tilt -> static 4D angle offset
  uniform float uClip;     // contrast -> tanh divisor (clip point)
  uniform float uKick;     // s.onKick -> per-beat flash recharge (decaying)
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
    // offsets (11., 33. — from 11.*U.wxzw with U=vec4(1,2,3,0)). mids widen the
    // spin; tilt adds a static offset.
    vec4 rr = cos(t * (0.1 + uMids * 0.08) + uRoll + vec4(0.0, 11.0, 33.0, 0.0));
    mat2 R = mat2(rr.x, rr.y, rr.z, rr.w);

    // ray dir is constant across the march — hoisted out of the loop
    vec3 rd = normalize(vec3(C - 0.5 * uRes, uRes.y));

    float z = 0.0, d = 0.0, k = 0.0;

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

      // accumulate: a beat-synced flash (kick recharges it, decays over the
      // beat via 6.*F) in the glow colour, plus the structural term
      o += uGlow * exp(0.7 * k - 6.0 * F + uKick * 1.4)
         + ph.w * tint / max(d, 1e-3);

      z += 0.8 * d + 1e-3;
    }

    // mrange's tone map: tanh, then /0.9 for a deliberate slight clip. Then the
    // one edit every ported shader owes the compositor.
    vec3 col = tanh3(o / uClip) / 0.9;
    gl_FragColor = vec4(col * uFade, 1.0);
  }
`

interface BeatsState {
  /** Musical time in BEATS, accumulated so a changing tempo/rate stays continuous. */
  beats: number
  /** Per-beat flash charge, kicked up by onKick, decaying. */
  kick: number
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
    uMids: { value: 0 },
    uSphere: { value: 0.2 },
    uEdge: { value: 0.05 },
    uInv: { value: 9 },
    uRoll: { value: 0 },
    uClip: { value: 1e4 },
    uKick: { value: 0 },
    uMaxSteps: { value: 77 },
  }),
  state: () => ({ beats: 0, kick: 0 }),
  update({ u, s, P, st, dt, ctx }) {
    // T advances in BEATS. The source froze without an audio texture; here it
    // free-runs at the engine's tempo (120 default before a lock) so a track
    // with no beat grid still turns rather than sitting dead — the roster's
    // "frozen reads as broken" rule (cf. KaleidoPulseScene).
    const bpm = ctx.f.bpm > 0 ? ctx.f.bpm : 120
    st.beats += dt * (bpm / 60) * (1 + s.energy * 0.4) * drastic(P.speed)

    if (s.onKick > 0) st.kick = Math.min(1.5, st.kick + s.onKick)
    st.kick *= Math.exp(-dt * 3.5)

    u.uBeats.value = st.beats
    u.uKick.value = st.kick
    u.uMids.value = s.mids
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
    const qFrac = Math.min(1, quality.knobs.raymarchSteps / 96)
    u.uMaxSteps.value = Math.max(
      20,
      Math.min(77, Math.round(77 * qFrac * (0.55 + 0.9 * P.complexity))),
    )
  },
})
