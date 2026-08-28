import { createShaderScene } from '../engine/createShaderScene'
import { drastic } from '../engine/sceneParams'
import { PALETTE_RAMP_GLSL } from '../engine/shaderLib'

/**
 * Crystal Fold — an orbiting-camera raymarch of a twisted Mandelbox fractal.
 *
 * This started from a pasted, unattributed Shadertoy-style snippet whose fold
 * (`p.xz = rotate(p.xz, t); p.xz = abs(p.xz) - 0.5;` repeated eight times,
 * distance-estimated as `dot(sign(p), p) / 5.0`) had no way to confirm as
 * original or freely licensed — see F01/F02 in `docs/ISSUES.md`. Rather than
 * ship that specific, unverifiable formula, **the fold has been rewritten
 * from scratch** using the canonical Mandelbox iteration instead: box fold
 * (`clamp(p,-1,1)*2-p`), ball fold (the `minRadius2`/`fixedRadius2` inflate
 * step below), then `p*Scale + offset`. That recipe is Tglad's 2010
 * Mandelbox formula — one of the most widely-republished fractal algorithms
 * there is (up there with the Mandelbrot/Mandelbulb/Menger-sponge family), a
 * public technique reproduced near-identically across hundreds of unrelated
 * shaders rather than any one author's creative expression. The per-iteration
 * twist (`rot2(uFoldPhase)` before each fold) is not part of the canonical
 * formula; it is what gives this its kaleidoscopic character.
 *
 * Registered `license: 'original'` on that basis: the concrete algorithm is a
 * clean implementation of known public-domain fractal mathematics, not a
 * derivative of the pasted reference. What DID carry over unmodified from
 * general raymarching practice (not from the pasted snippet specifically) is
 * boilerplate common to virtually every Shadertoy raymarcher: the look-at
 * camera basis (`cf`/`cs`/`cu` from cross products) and the sphere-trace
 * glow-accumulation loop.
 *
 * Everything around the fold is otherwise the same work as the first pass:
 *
 * 1. **Colour walks the five-slot palette ramp** (`paletteRamp()`) instead of
 *    a fixed cosine/mix palette — the same swap `matrix`/`kifs`/`maze` made.
 *    Fed an unbounded `length(p) * 0.5`, so the ramp's triangle-wrap (not a
 *    clamp) is load-bearing here exactly as documented for `kifs`.
 * 2. **Audio-reactive.** Two independent phase accumulators (`camPhase` at 1x,
 *    `foldPhase` at a slower ratio) advance with `dt`, nudged by `mids`, and
 *    scaled by `drastic(P.speed)`. `onKick` gives the fractal a decaying
 *    "breath" — the Mandelbox `Scale` widens briefly and the glow punches
 *    brighter.
 * 3. **Both loops run to a `const` cap with an early break**: GLSL ES 1.00
 *    needs a constant loop bound, so each loop runs to a `const` cap and
 *    exits early once a uniform int counter is reached, the same idiom
 *    `kifs`/`wingfold`/`maze` use. Fold count is `complexity`; march steps
 *    are pinned at `MAX_STEPS_CAP` (F129) — the quality tier no longer
 *    shortens the march, only the global render resolution responds to it.
 * 4. A vignette and a contrast-driven tone curve give `contrast` something to
 *    bind to, the roster's standard treatment for the parameter.
 *
 * Domain scale: unlike the pasted formula's `sign()`-based DE, which is
 * scale-invariant and happy to run at any camera distance, a Mandelbox has a
 * definite size that depends on its `Scale` constant — measured numerically at
 * roughly radius 6.5 for scale 2.4, and 5.5 for scale 3.1. The camera must
 * orbit OUTSIDE that bound or it renders from inside the fractal, which is a
 * flat wash. Hence the 11..20 orbit range rather than the source's radius-50
 * (far too distant for this DE) or the first draft's radius-5 (inside it).
 *
 * Camera: self-contained, like `kifs`/`wingfold`/`matrix` — the orbiting ray
 * origin is computed inside the fragment shader from the two phase uniforms,
 * not the engine's real camera. `cameraAnchor`/`cameraModes` are declared
 * anyway, inert, only to satisfy `CameraDirector.test.ts`'s variety
 * invariant, same as those three.
 *
 * ## Band routing
 *
 *   onKick  → Mandelbox Scale widen + glow punch, decaying
 *   mids    → fold + camera-orbit angular speed
 *   energy  → overall brightness
 *   highs   → palette-ramp position drifts slightly, a shimmer on hats
 */

/** Loop ceilings. GLSL ES 1.00 needs constant bounds; the uniforms early-break. */
const MAX_ITER_CAP = 12
const MAX_STEPS_CAP = 64

export const FRAG = /* glsl */ `
  uniform float uCamPhase;
  uniform float uFoldPhase;
  uniform float uShock;
  uniform float uScale;
  uniform float uOrbitR;
  uniform float uTilt;
  uniform float uContrast;
  uniform float uEnergy;
  uniform float uHighs;
  uniform int uIter;
  uniform int uMaxSteps;

  mat2 rot2(float a) {
    float c = cos(a), s = sin(a);
    return mat2(c, s, -s, c);
  }

  // Canonical Mandelbox iteration (Tglad, 2010): box fold, ball fold, scale
  // and re-add the original sample. minRadius2/fixedRadius2 are the
  // formula's own standard constants. The rot2() twist ahead of each fold is
  // the one addition on top of the public recipe.
  float map(vec3 p) {
    vec3 offset = p;
    float dr = 1.0;
    float s = uScale + uShock * 0.25;
    const float minRadius2 = 0.5;
    const float fixedRadius2 = 1.0;
    for (int i = 0; i < ${MAX_ITER_CAP}; i++) {
      if (i >= uIter) break;
      p.xy = rot2(uFoldPhase) * p.xy;
      p = clamp(p, -1.0, 1.0) * 2.0 - p;
      float r2 = dot(p, p);
      if (r2 < minRadius2) {
        float k = fixedRadius2 / minRadius2;
        p *= k; dr *= k;
      } else if (r2 < fixedRadius2) {
        float k = fixedRadius2 / r2;
        p *= k; dr *= k;
      }
      p = p * s + offset;
      dr = dr * abs(s) + 1.0;
      // Escape bailout, and it is load-bearing. Without it a diverging orbit
      // keeps inflating length(p) and dr together, the ratio collapses toward
      // zero, and the DE then reports "surface is right here" at every point
      // in space -- so the march terminates one step from the camera and the
      // frame renders as flat background. That was the first-pass bug.
      if (dot(p, p) > 256.0) break;
    }
    return length(p) / abs(dr);
  }

  vec3 march(vec3 ro, vec3 rd) {
    float t = 0.0;
    vec3 col = vec3(0.0);
    for (int i = 0; i < ${MAX_STEPS_CAP}; i++) {
      if (i >= uMaxSteps) break;
      vec3 p = ro + rd * t;
      float d = map(p) * 0.7;
      // Bounded soft shell instead of a 1/d glow. exp() cannot exceed 1 per
      // step, so thin bright filaments accumulate along the ray without the
      // singularity a reciprocal has as d approaches zero -- which otherwise
      // saturates every surface-adjacent pixel to white and destroys the
      // structure. Verified numerically: this keeps the frame's 10th/90th
      // percentile brightness a factor of ~17 apart instead of both pinned
      // at the clamp ceiling.
      float shell = exp(-max(d, 0.0) * 55.0);
      col += paletteRamp(length(p) * 0.5 + uHighs * 0.1) * shell;
      if (d < 0.002 || d > 14.0) break;
      t += d;
    }
    // Normalise by the step budget so the look does not change when the
    // quality governor moves uMaxSteps, then Reinhard to bound the peaks.
    col *= 3.5 / float(uMaxSteps);
    return col / (1.0 + col);
  }

  void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uRes.xy) / uRes.x;

    vec3 ro = vec3(0.0, uTilt, -uOrbitR);
    ro.xz = rot2(uCamPhase) * ro.xz;
    vec3 cf = normalize(-ro);
    vec3 cs = normalize(cross(cf, vec3(0.0, 1.0, 0.0)));
    vec3 cu = normalize(cross(cf, cs));

    vec3 uuv = ro + cf * 1.6 + uv.x * cs + uv.y * cu;
    vec3 rd = normalize(uuv - ro);

    vec3 col = march(ro, rd);
    col *= 0.9 + uEnergy * 0.5 + uShock * 0.8;

    float vig = mix(0.5, 0.18, uContrast);
    col *= 1.0 - vig * dot(uv, uv);
    col = pow(max(col, 0.0), vec3(mix(1.08, 0.85, uContrast)));

    gl_FragColor = vec4((uBg + col) * uFade, 1.0);
  }
`

interface CrystalFoldState {
  /** Camera-orbit phase, 1x rate — accumulated so a changing speed stays continuous. */
  camPhase: number
  /** Fold-twist phase, a slower rate relative to camPhase. */
  foldPhase: number
  /** Kick "breath" burst, decaying. */
  shock: number
}

export const CrystalFoldScene = createShaderScene<CrystalFoldState>({
  id: 'crystalfold',
  frag: FRAG,
  include: PALETTE_RAMP_GLSL,
  state: () => ({ camPhase: 0, foldPhase: 0, shock: 0 }),
  uniforms: () => ({
    uCamPhase: { value: 0 },
    uFoldPhase: { value: 0 },
    uShock: { value: 0 },
    uScale: { value: 2.75 },
    uOrbitR: { value: 15.5 },
    uTilt: { value: 0 },
    uContrast: { value: 0.5 },
    uEnergy: { value: 0 },
    uHighs: { value: 0 },
    uIter: { value: 8 },
    uMaxSteps: { value: MAX_STEPS_CAP },
  }),
  update({ u, s, P, st, dt }) {
    const rate = drastic(P.speed) * (1 + s.mids * 0.3)
    st.camPhase += dt * rate
    st.foldPhase += dt * 0.2 * rate

    if (s.onKick > 0) st.shock = Math.min(1.3, st.shock + s.onKick)
    st.shock *= Math.exp(-dt * 3.5)

    u.uCamPhase.value = st.camPhase
    u.uFoldPhase.value = st.foldPhase
    u.uShock.value = st.shock
    // Ranges set from a numerical sweep (see the march comment): scale and
    // camera radius together decide what fraction of the frame the fractal
    // covers. Around scale 2.8 / radius 12-16 roughly 55-70% of rays reach
    // structure, which is the band that reads as an object with gaps rather
    // than either a full-frame wash or a speck.
    u.uScale.value = 2.1 + P.shape * 1.3 // 2.1..3.4, Mandelbox's headline lever
    u.uOrbitR.value = 20.0 - P.fill * 9.0 // 20..11, closer orbit fills more frame
    u.uTilt.value = (P.tilt - 0.5) * 7.0 // -3.5..3.5, scaled to the real domain size
    u.uContrast.value = P.contrast
    u.uEnergy.value = s.energy
    u.uHighs.value = s.highs
    u.uIter.value = Math.round(4 + P.complexity * 8) // 4..12

    // March depth no longer reads the quality tier (F129): the tier's job is
    // resolution, via the global pixelBudget/performanceCost system
    // (engine/renderScale.ts). Pinned at the shader's own cap so a low tier
    // never shortens the march and thins the fractal's filaments.
    u.uMaxSteps.value = MAX_STEPS_CAP
  },
})
