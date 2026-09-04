import * as THREE from 'three'
import { createShaderScene } from '../engine/createShaderScene'
import { quality } from '../engine/quality'
import { PALETTE_RAMP_GLSL } from '../engine/shaderLib'
import { bipolar, drastic } from './contract'

/**
 * Nebula Drift — a slow, soft domain-warped fbm cloud, closer to looking
 * through fog or a nebula photograph than at a mineral surface.
 *
 * Written for this project against this engine's own noise/palette
 * primitives — no ported source, nothing pasted, no upstream to credit, so
 * `license: 'original'` (same posture `wireframe`'s header states and the
 * same reasoning: written down instead of left to the `?? 'original'`
 * default, see F01).
 *
 * ## Why this scene exists
 *
 * The live roster has exactly one background scene (`malachite`) and it is
 * hard mineral/crystalline — swirling botryoidal veins, a ramp term that
 * reads as banded stone. Every OTHER calm thing on the roster is also
 * crystalline in some way (`snowflake`'s ice, `kifs`'s rose window). Nothing
 * reads as soft atmospheric depth. This fills that gap specifically: no
 * bands, no veins, no hard edges anywhere, just drifting luminance as if
 * looking into fog.
 *
 * ## Technique
 *
 * Same public move Malachite uses — Quilez's domain warping: sample an fbm,
 * use it to displace where the next one samples — but deliberately ONE warp
 * layer, not two, and with no ramp/ring term on top of it:
 *
 *   q = (fbm(p + drift), fbm(p + offset - drift))    -- 2 fbm calls
 *   f = fbm(p + warp * q)                             -- 1 fbm call
 *
 * Malachite's own second warp layer (`r`) and its
 * `length(p - 0.6*r) * bands` ramp term are what turn a warped field into
 * concentric botryoidal veins — that is precisely the reading this scene
 * must NOT have, so both are simply absent rather than zeroed out. `f` goes
 * straight into a `smoothstep`-bounded density and from there into
 * `paletteRamp`, with no ring/band math anywhere in between.
 *
 * ## Colour
 *
 * `paletteRamp(t)` (shaderLib.ts) walks the full `uBg -> uShadow -> uMid ->
 * uAccent -> uGlow` ramp in Oklab, continuously, wrapping rather than
 * clamping. Its own doc names "fog" as exactly the case it exists for —
 * right for a field that should be able to go all the way from "barely
 * there" to "luminous wisp" with no seam, unlike a hand-rolled two-stage
 * `mix` (Malachite's approach) which was tuned for that shader's three fixed
 * tiers rather than a continuous fog reading. `lit` (the ramp position) is
 * always clamped 0..1 before the call, so the wrap never actually engages —
 * clamping is used instead of feeding an unbounded value, since this field
 * has no reason to cycle through the ramp more than once.
 *
 * ## Softness — the actual brief
 *
 * The one rule every line below answers to: no `step()`, no unguarded
 * comparison producing a binary result, anywhere. The only threshold in the
 * whole shader is a `smoothstep` whose half-width (`soft`) is floor-clamped
 * to 0.12 — so even pushing the contrast dial to its extreme narrows the
 * transition band without ever letting it collapse toward a hard edge. Same
 * defensive-clamp instinct as Malachite's `max(0.02, ...)` on its vein
 * width, aimed at the opposite outcome: guaranteeing softness rather than
 * guaranteeing a visible minimum line width.
 *
 * ## Audio routing — "nothing sudden ever happens here"
 *
 *   sub (bass)   -> uBassLift: pre-smoothed (one-pole, ~2s time constant) in
 *                   JS before it ever reaches a uniform, so even a hard sub
 *                   hit cannot read as a flash. Gently deepens/lifts the fog.
 *   mids (mid)   -> a small (<=15%) nudge to the drift-phase rate. Malachite
 *                   couples mids at 50%; this is deliberately a fraction of
 *                   that, because nothing here should read as urgent motion
 *                   even at high energy.
 *   energy       -> uGlowLift: pre-smoothed the same way as bass, gently
 *                   lifts how far up the ramp the brightest wisps reach.
 *   onKick       -> `bass` stands in for the onset routing too (same
 *                   convention Malachite/Snowflake/matrix use — the
 *                   `SceneBand` vocabulary has no onset-specific entry).
 *                   Charges a `shock` state that nudges BOTH the drift-phase
 *                   rate and the warp amount, then decays with
 *                   `Math.exp(-dt*0.9)` — Malachite's exact decay shape, just
 *                   a ~3x longer tail and a smaller charge, so a hit reads as
 *                   the fog leaning into itself for a second or two, never a
 *                   hit.
 *
 * No `highs`/`air` routing at all — this isn't a texture that wants
 * transient detail, matching the declared `bands: ['bass', 'mid', 'energy']`.
 *
 * ## Cost — why `performanceCost: 'low'`
 *
 * Per pixel: 3 fbm calls (`q.x`, `q.y`, `f`) x up to `uOctaves` (capped at
 * `MAX_OCTAVES = 3`) octaves each = **up to 9 `noise()` samples**, against
 * Malachite's 5 fbm calls x up to 5 octaves = up to 25 samples — roughly a
 * third of Malachite's per-pixel noise cost, using the same hash-based value
 * noise (not the ~10x-more-expensive `SIMPLEX3D_GLSL`). `paletteRamp` adds
 * one small FIXED cost on top that Malachite's hand-rolled linear `mix`
 * does not pay — up to 2 `mixOklab` calls, each a couple of `pow()`s — but
 * that cost is documented in `OKLAB_MIX_GLSL` as constant per pixel, not one
 * that scales with octave count, so it does not change the complexity class,
 * only adds a small flat term. Net: cheaper than Malachite per pixel even
 * counting it.
 *
 * Malachite measured 0.42ms at its 1.3 MP budget (M1, ANGLE/Metal). This
 * shader has NOT been bench-measured (documented op-count estimate only,
 * same caveat Snowflake's header uses for its own unmeasured figure —
 * confirm with `/bench`), so `pixelBudget: 1.6` is a conservative bump over
 * Malachite's 1.3 rather than the ~3.6 MP a naive 1/3-cost scaling would
 * imply — a third of the noise cost buys real headroom, but it is headroom
 * this scene is declining to spend blind.
 *
 * ## Band-scoped octaves
 *
 * `uOctaves` early-breaks the same way Malachite's does; dropping to 2
 * octaves under load removes the finest turbulence detail, which is the
 * least-missed thing in a field this soft to begin with.
 */

/** Octaves per fbm call. Constant loop bound; `uOctaves` early-breaks inside. */
const MAX_OCTAVES = 3

/**
 * Exported so the shader can be compiled AND linked outside the app — same
 * roster convention `MalachiteScene`/`MatrixRainScene` use. Full source is
 * `SHADER_SCENE_PRELUDE + PALETTE_RAMP_GLSL + FRAG`.
 */
export const FRAG = /* glsl */ `
  uniform float uPhase;
  uniform float uScale;
  uniform float uWarp;
  uniform float uCoverage;
  uniform float uSpread;
  uniform float uBassLift;
  uniform float uGlowLift;
  uniform int uOctaves;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i), b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  float fbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < ${MAX_OCTAVES}; i++) {
      if (i >= uOctaves) break;
      s += a * noise(p);
      p = p * 2.02 + 5.0;
      a *= 0.5;
    }
    return s;
  }

  void main() {
    vec2 uv = (vUv - 0.5) * vec2(uAspect, 1.0);
    vec2 p = uv * uScale;
    float t = uPhase;

    // ONE domain-warp layer -- sample an fbm, use it to displace where the
    // next one samples -- and stop there. No second warp layer, no ramp
    // term: this is the entire technique difference from Malachite, which
    // needs both to turn the field into botryoidal veins. Leaving them out
    // rather than zeroing them keeps this shader cheap AND keeps the image
    // honestly soft rather than a veined look with the veins turned down.
    vec2 drift = vec2(0.14 * sin(t), 0.10 * cos(t * 1.1));
    vec2 q = vec2(fbm(p + drift), fbm(p + vec2(4.7, 2.1) - drift));
    float f = fbm(p + uWarp * q);

    // Soft cloud density. soft is floor-clamped so the transition band can
    // never collapse toward a hard edge no matter how far uSpread (the
    // contrast dial) is pushed -- the one guarantee this whole shader exists
    // to keep. uCoverage is a signed offset around the neutral fbm output:
    // more coverage reads as thicker, more widespread fog; less as sparser
    // wisps with more open dark between them.
    float soft = clamp(uSpread, 0.12, 0.45);
    float density = smoothstep(0.5 - soft, 0.5 + soft, f + uCoverage);

    // Bass/energy arrive already smoothed (see update()) -- this is a
    // gentle, continuous lean along the ramp, never a flash.
    float lit = clamp(density + uBassLift * 0.18 + uGlowLift * 0.12, 0.0, 1.0);

    // Walk the full bg -> shadow -> mid -> accent -> glow ramp in Oklab --
    // paletteRamp's own doc names fog as exactly its intended use. No stage
    // of this is a hard mix threshold; the whole ramp is one continuous
    // function of lit.
    vec3 col = paletteRamp(lit);

    col *= 1.0 - 0.25 * dot(uv, uv);
    // Mild tone curve, same 0.9 convention as Malachite/Snowflake -- NOT a
    // linear->sRGB encode, three's renderer already does that.
    col = pow(max(col, 0.0), vec3(0.9));

    gl_FragColor = vec4(col * uFade, 1.0);
  }
`

interface NebulaDriftState {
  /** Field drift, accumulated so a changing rate stays continuous. */
  phase: number
  /** Kick nudge to drift-rate and warp amount, decaying. */
  shock: number
  /** Smoothed sub-bass level -- deepens/lifts the fog reading, never spikes. */
  bassLift: number
  /** Smoothed overall energy -- lifts the glow tier, never spikes. */
  glowLift: number
}

export const NebulaDriftScene = createShaderScene<NebulaDriftState>({
  id: 'nebula',
  frag: FRAG,
  include: PALETTE_RAMP_GLSL,
  // Governs the OFFSCREEN pass only -- BlendedLayer overwrites the on-screen
  // material with the background slot's user-selected blend mode. Replace
  // rather than blend is right for the offscreen buffer: this scene paints
  // every pixel including its own ground, same as Malachite.
  blending: THREE.NoBlending,
  // See the header's "Cost" section for the full op-count reasoning: roughly
  // a third of Malachite's per-pixel noise cost even after accounting for
  // paletteRamp's small fixed Oklab overhead, so this conservative bump over
  // Malachite's 1.3 MP budget costs nothing it hasn't earned. NOT
  // bench-measured -- confirm with /bench.
  pixelBudget: 1.6,
  uniforms: () => ({
    uPhase: { value: 0 },
    uScale: { value: 1.2 },
    uWarp: { value: 1.8 },
    uCoverage: { value: 0 },
    uSpread: { value: 0.28 },
    uBassLift: { value: 0 },
    uGlowLift: { value: 0 },
    uOctaves: { value: MAX_OCTAVES },
  }),
  state: () => ({ phase: 0, shock: 0, bassLift: 0, glowLift: 0 }),
  update({ u, s, P, st, dt }) {
    // Kick nudges the drift rate and warp amount, then decays smoothly --
    // Malachite's exact `exp(-dt*rate)` shape, but a ~3x longer tail
    // (0.9 vs Malachite's 3.0) and roughly half the charge, so a hit reads
    // as the fog leaning into itself for a second or two, never a hit.
    if (s.onKick > 0) st.shock = Math.min(1.0, st.shock + 0.35 * s.onKick)
    st.shock *= Math.exp(-dt * 0.9)

    // Base drift is deliberately glacial: at the neutral speed dial and no
    // mids, sin(t) completes one cycle roughly every 17 minutes (2*PI /
    // 0.006). mids nudges the rate by at most 15% -- a small fraction of
    // Malachite's own 50% coupling -- so nothing here ever reads as urgent
    // motion, even at high energy.
    st.phase += dt * 0.006 * (1 + s.mids * 0.15) * (1 + st.shock * 0.3) * drastic(P.speed)

    // Bass/energy are pre-smoothed HERE, in JS, with a slow one-pole filter
    // (~2s time constant) before they ever reach a uniform -- so even a hard
    // sub hit cannot read as a flash by the time it reaches the GPU. This is
    // the mechanism behind "gently deepen... never spike or flash": the
    // smoothing happens before the value exists on the shader side at all.
    st.bassLift += (s.sub - st.bassLift) * Math.min(1, dt * 0.5)
    st.glowLift += (s.energy - st.glowLift) * Math.min(1, dt * 0.5)

    u.uPhase.value = st.phase
    u.uBassLift.value = st.bassLift
    u.uGlowLift.value = st.glowLift

    // Piecewise so each dial's neutral 0.5 lands on this shader's own
    // authored default (scale 1.2, warp 1.8) rather than an arbitrary
    // linear-scale midpoint -- same convention Malachite/Snowflake use.
    u.uScale.value = P.fill < 0.5 ? 0.5 + P.fill * 1.4 : 1.2 + (P.fill - 0.5) * 2.4
    const baseWarp = P.complexity < 0.5 ? 0.6 + P.complexity * 2.4 : 1.8 + (P.complexity - 0.5) * 3.6
    u.uWarp.value = baseWarp * (1 + st.shock * 0.25)
    // Signed offset around the neutral fbm output, not a magnitude -- more
    // coverage reads as thicker/more widespread fog, less as sparser wisps.
    u.uCoverage.value = bipolar(P.density, 0.22)
    u.uSpread.value = 0.45 - P.contrast * 0.34

    // Dropping an octave removes the finest turbulence detail -- the
    // least-missed thing in a field this soft, same reasoning Malachite uses.
    u.uOctaves.value = Math.max(2, Math.min(MAX_OCTAVES, quality.knobs.noiseOctaves))
  },
})
