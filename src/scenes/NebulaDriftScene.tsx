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
 * Revised to read as more visibly alive while keeping the same non-negotiable:
 * every route lands on a CONTINUOUS shape parameter (density, turbulence,
 * drift rate, ramp position), never a brightness pop — the distinction
 * MalachiteScene.tsx's header draws for why a `background` scene must not
 * punch on the beat. Four distinct bands now drive four distinct visual
 * dimensions, so a listener can tell WHICH band moved without everything
 * swelling in lockstep:
 *
 *   sub (bass)   -> uBassLift (ramp-position lift, as before) AND, new, a
 *                   direct additive term on uCoverage — bass now visibly
 *                   thickens/swells the fog's density, not just its
 *                   brightness. Both read off the same pre-smoothed
 *                   (one-pole, ~2s time constant) `bassLift`, so a hard sub
 *                   hit still cannot reach the GPU as a flash; only the
 *                   SIZE of the continuous swell increased.
 *   mids (mid)   -> two couplings now, not one: the drift-phase-rate nudge
 *                   (bumped 15% -> 22%) plus a new multiplicative lift on
 *                   `uWarp` itself (+22% at full mids) — mids used to only
 *                   speed the drift up slightly, now they also visibly
 *                   roughen the warp/turbulence. Still well under
 *                   Malachite's 50% coupling; this is atmosphere, not a lead
 *                   layer, so it stays a minority contributor to warp
 *                   alongside the `complexity` dial and kick `shock`. BOTH
 *                   couplings read a pre-smoothed `midsLift` (one-pole,
 *                   ~2s time constant, same shape as `bassLift`/`glowLift`
 *                   just above it), never raw `s.mids` — `s.mids` is a live
 *                   envelope that fluctuates frame to frame even under
 *                   steady mid-band energy, and both destinations here
 *                   ACCUMULATE (a dt-integrated phase rate) or scale a
 *                   field-wide continuous quantity (warp) every frame, so
 *                   feeding it in raw would have every frame's own noise
 *                   show up as visible jitter in the drift/turbulence
 *                   rather than washing out. (Fixed this pass — `s.mids`
 *                   was previously the one exception to this file's own
 *                   "smooth before it reaches a uniform" rule that
 *                   `bassLift`/`glowLift` already followed.)
 *   beat         -> new: `uBeatSin4` (this engine's bar-length tempo
 *                   oscillator, already in the prelude, no JS-side state
 *                   needed) modulates the warp amount +/-8% once per bar.
 *                   Not an onset spike and not routed through any `s.*`
 *                   band — it's the music's TIME GRID, not its loudness —
 *                   so it reads as the fog breathing on the bar rather than
 *                   reacting to any one hit. This is the "flowing/breathing"
 *                   half of "more reactive" that a background scene can take
 *                   without stealing contrast from whatever sits on top.
 *   energy       -> uGlowLift: pre-smoothed the same way as bass, gently
 *                   lifts how far up the ramp the brightest wisps reach
 *                   (weight bumped 0.12 -> 0.16 alongside bass's 0.18 ->
 *                   0.22, so the two ramp-position terms scale together).
 *   onKick       -> `bass` stands in for the onset routing too (same
 *                   convention Malachite/Snowflake/matrix use — the
 *                   `SceneBand` vocabulary has no onset-specific entry).
 *                   Charges a `shock` state that nudges BOTH the drift-phase
 *                   rate and the warp amount, then decays with
 *                   `Math.exp(-dt*0.9)` — Malachite's exact decay shape, just
 *                   a ~3x longer tail. Charge and both nudge weights bumped
 *                   (0.35 -> 0.45 charge; 0.3 -> 0.4 phase-rate nudge; 0.25
 *                   -> 0.35 warp nudge) so a hit reads more clearly as the
 *                   fog leaning into itself for a second or two — still
 *                   never a hit, just a stronger lean.
 *
 * No `highs`/`air` routing at all — this isn't a texture that wants
 * transient detail, matching the declared `bands: ['bass', 'mid', 'energy']`.
 * `uBeatSin4`'s tempo grid is the one addition outside that vocabulary,
 * deliberately: it's not a spectral band, so it doesn't belong in `bands`,
 * and it can't spike the way a loudness-derived route could.
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
 * Malachite measured 0.42ms at its THEN-CURRENT 1.3 MP budget (M1,
 * ANGLE/Metal). Both scenes have since been re-anchored — Malachite to 7.2,
 * this one to 8.9 (see the `pixelBudget` note in the registration below for
 * why) — so that 0.42 ms describes neither scene's shipped budget any more,
 * and the real cost of both is correspondingly higher and unmeasured.
 *
 * This shader has still never been bench-measured at all (documented op-count
 * estimate only, same caveat Snowflake's header uses for its own unmeasured
 * figure — confirm with `/bench`), so `pixelBudget: 8.9` remains what 1.6 was:
 * a conservative bump over Malachite's budget rather than the ~21 MP a naive
 * 1/3-cost scaling would imply. A third of the noise cost buys real headroom,
 * but it is headroom this scene is still declining to spend blind — the more so
 * because 8.9 MP already exceeds a 4K panel outright, so a naive scaling would
 * be buying resolution no mainstream display can show. The re-anchor changed
 * the SCALE both numbers sit on, not this scene's posture toward its own
 * unmeasured estimate: 8.9/7.2 is essentially the margin 1.6/1.3 was
 * (1.24x against 1.23x), which is the point of re-anchoring by a uniform
 * ratio rather than re-deriving each scene's number independently.
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

    // Bar-length breathing: uBeatSin4 (prelude oscillator, one cycle per bar)
    // nudges the warp amount +/-8%, so the field visibly breathes in time
    // with the music's own grid rather than only its loudness. Small and
    // continuous -- never a per-hit spike -- so it stays flow, not punch.
    float warpAmt = uWarp * (1.0 + 0.08 * uBeatSin4);
    float f = fbm(p + warpAmt * q);

    // Soft cloud density. soft is floor-clamped so the transition band can
    // never collapse toward a hard edge no matter how far uSpread (the
    // contrast dial) is pushed -- the one guarantee this whole shader exists
    // to keep. uCoverage is a signed offset around the neutral fbm output:
    // more coverage reads as thicker, more widespread fog; less as sparser
    // wisps with more open dark between them.
    float soft = clamp(uSpread, 0.12, 0.45);
    float density = smoothstep(0.5 - soft, 0.5 + soft, f + uCoverage);

    // Bass/energy arrive already smoothed (see update()) -- this is a
    // gentle, continuous lean along the ramp, never a flash. Weights bumped
    // (0.18/0.12 -> 0.22/0.16) so the same pre-smoothed envelopes read as
    // more visibly reactive without reintroducing any spike.
    float lit = clamp(density + uBassLift * 0.22 + uGlowLift * 0.16, 0.0, 1.0);

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
  /**
   * Smoothed mid-band level -- feeds the drift-phase-rate nudge and the
   * warp-amount lift, never spikes. Added this pass: both destinations were
   * previously reading raw `s.mids` directly, which is the "raw band feeds
   * a per-frame rate/multiplier" bug (see JavaZoneLattice/TruchetKaleido/
   * ButterflyField for the same fix elsewhere this session) --
   * a live envelope that jitters frame-to-frame even under steady mids was
   * landing straight on a dt-integrated rate and on the whole domain-warp
   * field's turbulence amount every frame, so its own frame noise never had
   * a chance to wash out. Same one-pole shape as `bassLift`/`glowLift`.
   */
  midsLift: number
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
  // Malachite's 7.2 MP budget costs nothing it hasn't earned. Still NOT
  // bench-measured -- confirm with /bench.
  //
  // ## Which `pixelBudget` this is
  //
  // `createShaderScene`'s spec field. It sizes THIS SCENE'S OWN offscreen
  // buffer and NOTHING else, solved by that module's private `solveScale`
  // (createShaderScene.tsx:191-196):
  //
  //     scale = clamp(sqrt(budget / fullMP), MIN_RENDER_SCALE /* 0.4 */, 1)
  //
  // Not `SceneMetadata.pixelBudget` from scenes/index.ts, and nothing to do
  // with engine/renderScale.ts: no `combinePixelBudgets` reciprocal sum, no
  // `quality.knobs.pixelBudgetScale` tier multiplier on this path.
  //
  // ## Re-anchored 1.6 -> 8.9 MP
  //
  // The 1.6 was chosen while the roster was developed against 1080p and laptop
  // displays. On a 3840x2160 panel it solves to 0.44 linear — a hair off
  // `solveScale`'s own 0.4 clamp, and through it at 1440p and above once DPR is
  // counted — so the declared number had effectively stopped selecting a
  // resolution: the buffer sat near 40% linear whatever the display or the
  // hardware.
  //
  // ## Re-anchored again 8.9 -> 2.0 (F196/F200)
  //
  // F195 set 8.9 as 1.6 x 5.5556 — the ratio from `maze`'s chosen re-anchor
  // (0.9 -> 5.0), applied UNIFORMLY to all eleven scenes it touched. That
  // uniform factor is what broke this one. F195's own table records this
  // scene's pre-anchor 4K solve as **0.44**, which is ABOVE `solveScale`'s
  // 0.40 clamp — so unlike `maze` (0.40, genuinely pinned and the scene the
  // 5.5556x was derived from), `nebula` never had the clamp problem the
  // re-anchor existed to fix. It was swept up in a roster-wide multiply and
  // pushed straight out the other end: 8.9 MP exceeds a 4K panel outright, so
  // every display up to and including 4K solved to 1.00 and paid
  // `createShaderScene`'s extra fullscreen blit for a buffer that was already
  // native — the exact overhead the spec doc (`:157-159`) says to omit
  // `pixelBudget` to avoid. Inert at the ceiling where it had been inert at
  // the floor, which is F196.
  //
  // ## Why 2.0 — the window where the budget actually binds
  //
  // `solveScale` = `clamp(sqrt(B / fullMP), 0.4, 1)`. The budget SELECTS a
  // resolution only when that solve lands strictly inside the clamps, i.e.
  //
  //     0.16 * fullMP  <  B  <  fullMP
  //
  // Per panel, that admits:
  //
  //     1080p  fullMP 2.07  ->  B in (0.33, 2.07)
  //     1440p  fullMP 3.69  ->  B in (0.59, 3.69)
  //     4K     fullMP 8.29  ->  B in (1.33, 8.29)
  //
  // The intersection is **B in (1.33, 2.07)** — the only range that binds on
  // all three. 2.0 sits at the top of it, giving up the least resolution while
  // still selecting one everywhere:
  //
  //     panel   OLD 8.9        NEW 2.0
  //     1080p   1.00 native    0.98  (2.0 MP)
  //     1440p   1.00 native    0.74  (2.0 MP)
  //     4K      1.00 native    0.49  (2.0 MP)
  //     5K      0.78           0.40  floor (2.36 MP)
  //
  // Above 4K it floors, and that is the benign direction: the floor renders
  // MORE than the budget asked for, so the scene is under-throttled rather
  // than under-resolved. Flat across tiers either way — the budget is a plain
  // number with no threshold to flip and `solveScale` has no tier multiplier.
  //
  // ## Cost check at the new value
  //
  // `SCENE_COST_MS.nebula` tops out at 0.34 ms, and that row's own comment
  // states it was reasoned at `pixelBudget 1.6`. 2.0 MP is 1.25x that, so
  // ~0.43 ms — against a `sceneBudget(0)/2` bar of 5.05 ms, clear by ~12x.
  // Re-anchoring DOWN also moves the F195 risk note the safe way: this scene's
  // floor on a 2560x1664 MacBook Air drops from 1.00 (native) back to 0.74,
  // and the ladder keeps its per-pixel lever (`uOctaves` off `noiseOctaves`).
  //
  // ## Why a BACKGROUND's budget still matters
  //
  // Not because it drags anything else down — it does not. Each
  // `createShaderScene` budget sizes only its own offscreen buffer, so this
  // layer's resolution has no bearing on the subject composited over it. The
  // honest reason this one was re-anchored is that its OWN buffer was clamped:
  // "a soft upscale is invisible under a subject" is a fair claim about this
  // layer's own pixels, but it was propping up a number that had stopped
  // selecting any resolution at all.
  pixelBudget: 2.0,
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
  state: () => ({ phase: 0, shock: 0, bassLift: 0, glowLift: 0, midsLift: 0 }),
  update({ u, s, P, st, dt }) {
    // Kick nudges the drift rate and warp amount, then decays smoothly --
    // Malachite's exact `exp(-dt*rate)` shape, but a ~3x longer tail
    // (0.9 vs Malachite's 3.0). Charge and both nudge weights bumped this
    // pass (0.35 -> 0.45 charge below; 0.3 -> 0.4 phase nudge; 0.25 -> 0.35
    // warp nudge further down) so a hit reads more clearly as the fog
    // leaning into itself for a second or two -- still a lean, never a hit.
    if (s.onKick > 0) st.shock = Math.min(1.0, st.shock + 0.45 * s.onKick)
    st.shock *= Math.exp(-dt * 0.9)

    // Base drift is deliberately glacial: at the neutral speed dial and no
    // mids, sin(t) completes one cycle roughly every 17 minutes (2*PI /
    // 0.006). mids nudge the rate by at most 22% (was 15%) -- still a small
    // fraction of Malachite's own 50% coupling -- so nothing here ever reads
    // as urgent motion, even at high energy. Reads st.midsLift (smoothed
    // just above), NOT raw s.mids -- this is a dt-integrated rate, so any
    // per-frame noise in the raw envelope would have accumulated into the
    // phase itself instead of washing out; the smoothed value carries the
    // same shape of motion without the frame-to-frame jitter.
    st.phase += dt * 0.006 * (1 + st.midsLift * 0.22) * (1 + st.shock * 0.4) * drastic(P.speed)

    // Bass/energy are pre-smoothed HERE, in JS, with a slow one-pole filter
    // (~2s time constant) before they ever reach a uniform -- so even a hard
    // sub hit cannot read as a flash by the time it reaches the GPU. This is
    // the mechanism behind "gently deepen... never spike or flash": the
    // smoothing happens before the value exists on the shader side at all.
    st.bassLift += (s.sub - st.bassLift) * Math.min(1, dt * 0.5)
    st.glowLift += (s.energy - st.glowLift) * Math.min(1, dt * 0.5)
    // Same one-pole shape, same ~2s time constant -- mids get no special
    // treatment here, they were just missing it. This is what THE #1 RULE
    // fix looks like: smooth the input before it reaches a rate or a
    // per-frame multiplier, not after.
    st.midsLift += (s.mids - st.midsLift) * Math.min(1, dt * 0.5)

    u.uPhase.value = st.phase
    u.uBassLift.value = st.bassLift
    u.uGlowLift.value = st.glowLift

    // Piecewise so each dial's neutral 0.5 lands on this shader's own
    // authored default (scale 1.2, warp 1.8) rather than an arbitrary
    // linear-scale midpoint -- same convention Malachite/Snowflake use.
    u.uScale.value = P.fill < 0.5 ? 0.5 + P.fill * 1.4 : 1.2 + (P.fill - 0.5) * 2.4
    const baseWarp = P.complexity < 0.5 ? 0.6 + P.complexity * 2.4 : 1.8 + (P.complexity - 0.5) * 3.6
    // shock (kick lean) and mids (turbulence) are two independent multipliers
    // on the same warp amount -- distinct bands, distinct felt effect: a kick
    // reads as a brief lean, sustained mids as a steadier roughening. Neither
    // needs to dominate the `complexity` dial's own base value. Mids term
    // reads st.midsLift, NOT raw s.mids -- uWarp scales the WHOLE
    // domain-warped field every frame, so a raw envelope's own frame-to-frame
    // noise here would have been maximally visible (the exact bug already
    // found and fixed in GyroidFlux/JavaZoneLattice/TruchetKaleido/
    // ButterflyField); the smoothed value keeps the same 0.22 coupling
    // weight without the jitter.
    u.uWarp.value = baseWarp * (1 + st.shock * 0.35) * (1 + st.midsLift * 0.22)
    // Signed offset around the neutral fbm output, not a magnitude -- more
    // coverage reads as thicker/more widespread fog, less as sparser wisps.
    // bassLift now ALSO leans on this term (new) -- sub visibly thickens the
    // fog's density, a distinct dimension from uBassLift's ramp-brightness
    // lift just above, using the same pre-smoothed envelope so it can't spike.
    u.uCoverage.value = bipolar(P.density, 0.22) + st.bassLift * 0.15
    u.uSpread.value = 0.45 - P.contrast * 0.34

    // Dropping an octave removes the finest turbulence detail -- the
    // least-missed thing in a field this soft, same reasoning Malachite uses.
    u.uOctaves.value = Math.max(2, Math.min(MAX_OCTAVES, quality.knobs.noiseOctaves))
  },
})
