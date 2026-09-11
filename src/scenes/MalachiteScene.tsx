import * as THREE from 'three'
import { createShaderScene } from '../engine/createShaderScene'
import { quality } from '../engine/quality'
import { slew } from '../engine/response'
import { drastic } from '../engine/sceneParams'

/**
 * Malachite — domain-warped fbm banded into concentric botryoidal veins, like
 * polished mineral stone.
 *
 * Replaces `ink` in the background slot. Sourced from glslop, CC0, credited
 * in-source to "claude-opus-4-8".
 *
 * The technique is two well-known, generic pieces stacked: Quilez's
 * domain-warping (sample an fbm, use it to displace where the next one
 * samples, twice — public technique, no owner) feeding a "ramp" term —
 * `length(p - 0.6*r) * bands` — that would be plain concentric rings on its
 * own, except its own centre is dragged around by the same turbulence field
 * `r` that warped the noise. That single line is what turns rings into
 * swirling botryoidal veins instead of a target pattern.
 *
 * ## Colour
 *
 * The source drove three fixed hardcoded greens (`deep`/`mid`/`light`) picked
 * by a `tox` slider blending between two hand-authored endpoints. Replaced
 * with a direct mix of the five prelude colours (`uShadow`/`uMid`/`uAccent`/
 * `uGlow`) so the stone recolours under the active AudioVis palette — same
 * move as `HeapCorruptionScene`'s phosphor and `MatrixRainScene`'s glyphs.
 * `uTox` still exists, but now blends WHICH prelude colours the mid/light
 * tiers lean toward, rather than picking between two fixed green constants.
 *
 * ## What else changed from the standalone draft
 *
 * The source had no speed control at all (`TIME * 0.08`, fixed) and no audio
 * routing — this is a still image that happens to drift. Added a `speed` param
 * replacing the fixed rate, and one slow swell (below). That is all, on
 * purpose.
 *
 * ## Identity: this one breathes, it does not punch
 *
 * This scene is `role: background`, `intensity: 'calm'`, composited under a
 * subject at the background slot's 0.4 gain. Its job is to be the
 * least-noticed layer in the frame.
 *
 * It used to charge a shock on every kick (`exp(-dt*3.0)`) into the domain
 * warp and the crest sheen, lift the sheen again from `energy`, and tighten
 * the vein width on `highs` — i.e. the exact `onKick`→decay→glow template ten
 * of the twelve shader scenes share, which meant **the ground punched on the
 * beat like everything else in the frame**. That is a real defect and not a
 * matter of taste: a background flashing on the same kick the subject flashes
 * on is not supporting the subject, it is competing with it for the same
 * moment, and the subject loses contrast it can never get back. `nebula` and
 * `dustfield`, the roster's other two backgrounds, already decline to do this;
 * `malachite` was the one still fighting.
 *
 * So the kick routing is **removed outright**, not softened. Nothing in this
 * scene is traceable to an individual hit any more. In its place is a single
 * `slew()` on programme energy with a multi-second time constant (~7.5 s in,
 * ~15 s out — asymmetric, so it recedes more slowly than it swells), which
 * moves on the timescale of a phrase rather than a beat. One envelope governs
 * everything the music does here.
 *
 * This is a deliberate REDUCTION and the reduction is the deliverable. The
 * scene is quieter and less obviously "reactive" in isolation; in a real
 * composition, which is the only place it ever appears, that is the whole
 * point.
 *
 * ## What the swell drives — and what it deliberately does not
 *
 * Not brightness. The audit's headline finding was that 22 of 22 scenes drove
 * brightness or glow from an audio envelope, so the crest sheen here is now a
 * flat constant at the source's authored 0.25 and no audio term reaches it.
 * The swell instead moves:
 *
 *   - **colour-ramp position** — where the shadow→mid walk sits, so the stone
 *     tonally opens and closes across a phrase, and
 *   - **vein width** — veins BROADEN as it swells.
 *
 * Those two partly oppose each other (a lifted ramp is lighter, wider veins
 * darken more of the surface), which is the point: the stone swells into
 * *definition* rather than into brightness. Counter-motion of that kind
 * appears exactly once elsewhere in the roster.
 *
 * ## Band routing
 *
 *   energy → one slow swell (`slew`, ~7.5 s attack / ~15 s release), driving
 *             colour-ramp position, vein width, and the drift rate
 *
 * Nothing else. No `onKick`, no `mids`, no `highs` — all three were the
 * template's own terms and all three are gone.
 */

/** Octaves per fbm call. Constant loop bound; `uOctaves` early-breaks inside. */
const MAX_OCTAVES = 5

/**
 * Exported so the shader can be compiled AND linked outside the app — the
 * roster convention (see `MatrixRainScene`). Full source is
 * `SHADER_SCENE_PRELUDE + FRAG` (no shared `include`; `hash`/`noise`/`fbm`
 * are self-contained, matching the source).
 */
export const FRAG = /* glsl */ `
  uniform float uPhase;
  uniform float uScale;
  uniform float uWarp;
  uniform float uBands;
  uniform float uTox;
  // One slow phrase swell, 0..1, replacing the old per-kick shock plus the
  // energy and highs terms. See the header on why this scene has exactly one
  // audio input and why none of it reaches the sheen.
  uniform float uSwell;
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

    // Heavy domain warp -> botryoidal swirls. The warp is now exactly the
    // authored depth with no audio term at all: a kick used to deepen it as a
    // churn burst, which is precisely the per-hit reaction a background has no
    // business making.
    float warpAmt = uWarp;
    vec2 drift = vec2(0.3 * sin(t), 0.2 * cos(t * 1.1));
    vec2 q = vec2(fbm(p + drift), fbm(p + vec2(5.2, 1.3) - drift));
    vec2 r = vec2(
      fbm(p + warpAmt * q + vec2(1.7, 9.2) + drift),
      fbm(p + warpAmt * q + vec2(8.3, 2.8))
    );
    float f = fbm(p + warpAmt * r);

    // Agate/malachite banding: a concentric ring ramp whose own centre is
    // dragged by the turbulence field r -- this is what turns plain rings
    // into swirling botryoidal veins.
    float ramp = length(p - 0.6 * r) * uBands;
    float phase = ramp + (f - 0.5) * 9.0;
    float band = sin(phase);
    float litness = 0.5 + 0.5 * band;
    // Colour-ramp position breathes with the swell -- a tonal open/close
    // across a phrase, NOT a glow term. Purely additive from zero so silence
    // reproduces the authored ramp exactly; clamped because s.energy runs to
    // ~1.1 and an over-1 mix factor would extrapolate past the palette.
    float lit = clamp(litness + uSwell * 0.035, 0.0, 1.0);
    // Base hardness from toxicity. Veins BROADEN slightly as the phrase
    // swells (the old term tightened them on hats, per-transient); against the
    // lifting ramp above this reads as the stone gaining definition rather
    // than gaining brightness.
    float veinW = max(0.02, mix(0.20, 0.06, uTox) + uSwell * 0.02);
    float vein = smoothstep(veinW, 0.0, abs(band));
    // Deliberately off the swell: crest is the specular sheen, the surface a
    // punch would have travelled through. It stays where the source authored
    // it so no audio envelope reaches brightness in this scene — flat 0.25,
    // no uEnergy/uShock term. (Those two were never declared as uniforms in
    // this file — referencing them here was a leftover from the pre-rewrite
    // shader and a hard GLSL compile error: undeclared identifiers, not a
    // silent black frame this time, an outright link failure.)
    float crest = pow(litness, 2.5);

    // Walk shadow -> mid -> a tox-blended lean toward glow, so higher
    // toxicity reads as more vivid/vitreous rather than just "more green".
    vec3 midCol = mix(uMid, uAccent, uTox * 0.4);
    vec3 lightCol = mix(uAccent, uGlow, uTox);

    vec3 col = mix(uShadow, midCol, litness);
    col = mix(col, lightCol, crest);
    col += uGlow * pow(crest, 2.0) * 0.25;
    col *= 1.0 - (0.5 + 0.4 * uTox) * vein;

    col *= 1.0 - 0.3 * dot(uv, uv);
    // Mild tone curve, matching the source's own 0.9 -- not a linear->sRGB
    // encode (that would be 0.4545 and would double-gamma under three's own
    // renderer encode; see MazeFlightScene's header for why that matters).
    col = pow(max(col, 0.0), vec3(0.9));

    gl_FragColor = vec4(col * uFade, 1.0);
  }
`

interface MalachiteState {
  /** Field drift, accumulated so a changing rate stays continuous. */
  phase: number
  /**
   * The one slow phrase swell — asymmetric `slew()` on `s.energy`, ~7.5s to
   * rise, ~15s to fall. Replaces the old per-kick `shock` accumulator
   * outright; see the header's "this one breathes, it does not punch".
   */
  swell: number
}

export const MalachiteScene = createShaderScene<MalachiteState>({
  id: 'malachite',
  frag: FRAG,
  // Governs the OFFSCREEN pass only — `BlendedLayer` overwrites the on-screen
  // material with the background slot's user-selected blend mode. Replace
  // rather than blend is right for the offscreen buffer: the scene paints
  // every pixel including its own ground.
  blending: THREE.NoBlending,
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
  // ## Re-anchored 1.3 -> 7.2 MP
  //
  // The 1.3 was chosen while the roster was developed against 1080p and laptop
  // displays, where it still bought something. On anything at or above ~1440p
  // it does not: on a 3840x2160 panel 1.3 MP falls straight through
  // `solveScale`'s own 0.4 clamp, so the buffer was pinned at 0.40 — a 2.5x
  // upscale across a large display — at ALL FIVE tiers. Not "low at the bottom
  // of the ladder": the declared number had stopped meaning anything at all,
  // and the result was the same whatever the display or the hardware. That is
  // the 4K-vs-MacBook report: the Mac only wins because a 2.2x upscale on a 13"
  // panel hides where 2.5x across a 4K display does not.
  //
  // 7.2 is 1.3 x 5.5556 — the ratio taken from `maze`'s chosen re-anchor
  // (0.9 -> 5.0) and applied uniformly across all eleven affected scenes. One
  // explainable rule: it preserves the roster's RELATIVE ordering, which
  // encodes real measured cost differences.
  //
  // 4K (3840x2160, fullMP 8.29) linear scale by tier, from `solveScale`:
  //
  //     OLD  0.40 / 0.40 / 0.40 / 0.40 / 0.40
  //     NEW  0.93 / 0.93 / 0.93 / 0.93 / 0.93     buffer @ tier 0: 3577x2012
  //
  // Flat across the tiers, and that is not an artefact: the budget is a plain
  // number with no threshold to flip, and `solveScale` has no tier multiplier,
  // so this scene's resolution does not vary by tier at all — before or after.
  // The re-anchor moved where the flat line sits; it did not add rungs to it.
  //
  // ## KNOWN RISK: this raises the FLOOR, and the governor cannot lower it
  //
  // Because `solveScale` has no tier multiplier, the quality governor CANNOT
  // claw resolution back on this scene under load. Raising the budget raises
  // the floor of what a weak machine must render, not just the ceiling: on a
  // 2560x1664 MacBook Air this goes from 0.55 to 1.00 (native) at every tier —
  // ~3.3x the pixels, with no resolution move available to the governor at any
  // tier. The ladder can still cut per-pixel cost here (`uOctaves` drops the
  // fbm octave count off `noiseOctaves`), but it cannot cut pixel COUNT.
  // Stated as a known, accepted-for-now consequence pending a fresh `/bench` —
  // not as a solved problem.
  //
  // ## Why a BACKGROUND's budget still matters
  //
  // Not because it drags anything else down — it does not. Each
  // `createShaderScene` budget sizes only its own offscreen buffer, so this
  // layer's resolution has no effect whatsoever on the subject composited over
  // it. The honest reason this one was re-anchored is simply that its OWN
  // buffer was clamped too: "as ground under a subject, a soft upscale is
  // invisible" is a fair argument about this layer's own pixels, but it was
  // being used to justify a number that had quietly stopped selecting any
  // resolution at all.
  //
  // ## The 0.42 ms is a measurement of the OLD budget
  //
  // 0.42 ms on an M1 (see index.ts's metadata comment for the full numbers) was
  // measured at 1.3 MP and says nothing about 7.2. Cost here is per-pixel, and
  // this raises internal resolution substantially at 4K, so the real figure is
  // correspondingly higher — how much is unmeasured, and no new number is
  // invented here. This wants a fresh `/bench` sweep. What survives the change
  // is the reason it was cheap per sample: hash-based value noise is far
  // lighter than `ink`'s simplex was, which is how five fbm calls stayed
  // affordable in the first place.
  pixelBudget: 7.2,
  uniforms: () => ({
    uPhase: { value: 0 },
    uScale: { value: 2.4 },
    uWarp: { value: 3.5 },
    uBands: { value: 9.0 },
    uTox: { value: 0.5 },
    uSwell: { value: 0 },
    uOctaves: { value: MAX_OCTAVES },
  }),
  state: () => ({ phase: 0, swell: 0 }),
  update({ u, s, P, st, dt }) {
    // The one audio input this scene has: a slow phrase swell off programme
    // energy. Asymmetric — ~7.5s to rise (rate 0.4, ~95% there in 7.5s), ~15s
    // to fall (rate 0.2, ~95% decayed in 15s) — so it recedes more slowly than
    // it swells, per the header. No onKick, no mids, no highs anywhere below;
    // all three were the template's own terms.
    st.swell = slew(st.swell, s.energy, dt, 0.4, 0.2)
    u.uSwell.value = st.swell

    // Source was a fixed TIME*0.08 with no speed control at all. The swell
    // now drives the drift rate too — this was `s.mids` before the rewrite;
    // this scene has exactly one audio input, so the phrase breath widens
    // the drift instead of a band level that no longer reaches this scene.
    st.phase += dt * 0.08 * (1 + st.swell * 0.15) * drastic(P.speed)
    u.uPhase.value = st.phase

    // Piecewise so each param's neutral 0.5 lands exactly on the source's
    // authored default (scale 2.4, warp 3.5, bands 9.0) rather than an
    // arbitrary linear-scale midpoint.
    u.uScale.value = P.fill < 0.5 ? 1.0 + P.fill * 2.8 : 2.4 + (P.fill - 0.5) * 5.2
    u.uWarp.value = P.complexity < 0.5 ? 1.0 + P.complexity * 5.0 : 3.5 + (P.complexity - 0.5) * 5.0
    u.uBands.value = P.density < 0.5 ? 3.0 + P.density * 12.0 : 9.0 + (P.density - 0.5) * 22.0
    u.uTox.value = P.contrast

    // Dropping an octave removes the finest turbulence detail — the
    // least-missed thing in a soft field, same reasoning `ink` used.
    u.uOctaves.value = Math.max(2, Math.min(MAX_OCTAVES, quality.knobs.noiseOctaves))
  },
})
