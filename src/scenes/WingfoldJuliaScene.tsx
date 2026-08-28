import { createShaderScene } from '../engine/createShaderScene'
import { drastic } from '../engine/sceneParams'
import { PALETTE_RAMP_GLSL } from '../engine/shaderLib'

/**
 * Wingfold Julia — an animated, audio-punched Julia-set fractal.
 *
 * Started as a clean-room recreation attempt for the (now-disabled,
 * unverified-licence) `juliawings` scene, built from nothing but the
 * classic escape-time Julia formula (`z -> z^2 + c`, Gaston Julia, 1918 —
 * public-domain mathematics) plus a fold trick of my own devising. Once the
 * actual `juliawings` reference art turned out to be a completely different
 * technique (a flat vector wing-and-vein composition, not a fractal at all —
 * see `MazeFlightScene`'s sibling scenes for that lineage), this stood on its
 * own merit as a good-looking piece in a different genre and earned its own
 * slot instead of being discarded.
 *
 * ## The fold
 *
 * The sample point is mirrored with `abs()` on both axes before iterating.
 * That is the one structural choice that turns a stock Julia set's single
 * spiral arm into a symmetric four-winged form — everything else is the
 * textbook formula. `c` orbits a small circle just outside the Mandelbrot
 * set's main cardioid, which is what keeps the set richly connected and
 * constantly morphing rather than freezing solid or dissolving to dust.
 *
 * ## What changed from the original standalone Shadertoy draft
 *
 * That version drove its own independent cosine palette and animated purely
 * off `iTime` with no audio input at all. Here:
 *   - Colour now walks the five-slot AudioVis ramp (`paletteRamp`/`paletteLit`
 *     from `PALETTE_RAMP_GLSL`) instead of a fixed indigo-to-gold palette, so
 *     it recolours with mood and palette like every other scene in the roster.
 *   - The zoom now breathes with the beat-subdivision pulse (`ctx.b.pulse`) in
 *     addition to a kick-triggered punch — the "dancy" request — rather than
 *     a purely autonomous sine wave with no relationship to the music.
 *   - `onKick` also widens the orbit radius and boosts the filament edge glow
 *     as a decaying shock, so a hit visibly reorganises the fractal rather
 *     than just flashing brightness.
 *
 * ## Band routing
 *
 *   onKick  → orbit-radius widen + zoom punch + edge-glow boost, all decaying
 *   pulse   → continuous beat-synced zoom breathing (the "dancy" part)
 *   mids    → orbit angular speed
 *   energy  → overall brightness + orbit radius (busier at high energy)
 *   highs   → filament edge-glow intensity
 */

/** Loop ceiling. GLSL ES 1.00 needs a constant bound; `uMaxIter` early-breaks. */
const MAX_ITER_CAP = 160

/**
 * Exported so the shader can be compiled AND linked outside the app — the
 * roster convention (see MatrixRainScene). Full source is
 * `SHADER_SCENE_PRELUDE + PALETTE_RAMP_GLSL + FRAG`.
 */
export const FRAG = /* glsl */ `
  uniform float uPhase;
  uniform float uShock;
  uniform float uOrbitR;
  uniform float uZoom;
  uniform float uContrast;
  uniform float uEnergy;
  uniform float uHighs;
  uniform float uBeatPulse;
  uniform int uMaxIter;

  void main() {
    vec2 uv = (2.0 * gl_FragCoord.xy - uRes.xy) / uRes.y;

    // Zoom breathes continuously with the beat-subdivision pulse, and punches
    // in sharply on a kick shock -- the two together are what make it read as
    // dancing WITH the music rather than drifting on its own clock.
    float zoomPulse = 1.0 + 0.12 * uBeatPulse + 0.10 * uShock;
    float zoom = uZoom * zoomPulse;
    float ang = uPhase * 0.25;
    float ca = cos(ang), sa = sin(ang);
    uv = mat2(ca, -sa, sa, ca) * uv / zoom;

    // The wing fold: mirror both axes before iterating.
    vec2 z = abs(uv);

    // c orbits just outside the cardioid; onKick and energy widen the orbit
    // briefly, which visibly reorganises the whole set rather than merely
    // brightening it.
    float orbitR = uOrbitR + uShock * 0.06 + uEnergy * 0.03;
    vec2 c = orbitR * vec2(cos(uPhase), sin(uPhase * 1.3 + 1.7));

    int n = 0;
    for (int i = 0; i < ${MAX_ITER_CAP}; i++) {
      if (i >= uMaxIter) break;
      z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
      if (dot(z, z) > 256.0) break;
      n++;
    }

    vec3 col;
    if (n >= uMaxIter) {
      // Never escaped: deep interior, walking the ramp's dark end.
      col = mix(uBg, uShadow, 0.4);
    } else {
      // Smooth (renormalised) escape count -- standard public-domain
      // continuous-coloring formula (Vepstas, 1997) -- removes the banding a
      // raw integer iteration count would show as concentric rings.
      float log_zmod = log2(dot(z, z)) * 0.5; // == log2(|z|)
      float smoothN = float(n) + 1.0 - log2(log_zmod);
      float t2 = smoothN * 0.045 + uPhase * 0.02;

      col = paletteRamp(t2);

      // Filament glow: brighter right at the escape threshold, boosted by
      // highs and by a kick shock, sampled from the LIT slots only so it
      // never dips toward the dark ground.
      float edge = smoothstep(0.0, 1.0, fract(smoothN));
      float edgeBoost = 0.35 + uHighs * 0.55 + uShock * 0.7;
      col += paletteLit(t2 + 0.5) * edge * edgeBoost;
      col *= 0.7 + 0.5 * uEnergy;
    }

    // Contrast: below 0.5 opens the vignette and softens the tone curve,
    // above 0.5 tightens the frame and hardens it -- the roster's standard
    // bipolar reading of the parameter.
    float vig = mix(0.55, 0.2, uContrast);
    col *= 1.0 - vig * dot(uv, uv);
    col = pow(max(col, 0.0), vec3(mix(1.1, 0.85, uContrast)));

    gl_FragColor = vec4(col * uFade, 1.0);
  }
`

interface WingfoldState {
  /** c-orbit phase, accumulated so a changing speed stays continuous. */
  phase: number
  /** Kick shock, decaying. */
  shock: number
}

export const WingfoldJuliaScene = createShaderScene<WingfoldState>({
  id: 'wingfold',
  frag: FRAG,
  include: PALETTE_RAMP_GLSL,
  state: () => ({ phase: 0, shock: 0 }),
  uniforms: () => ({
    uPhase: { value: 0 },
    uShock: { value: 0 },
    uOrbitR: { value: 0.7885 },
    uZoom: { value: 1.15 },
    uContrast: { value: 0.5 },
    uEnergy: { value: 0 },
    uHighs: { value: 0 },
    uBeatPulse: { value: 0 },
    uMaxIter: { value: MAX_ITER_CAP },
  }),
  update({ u, s, P, st, dt, ctx }) {
    st.phase += dt * (0.35 + s.mids * 0.25) * drastic(P.speed)

    if (s.onKick > 0) st.shock = Math.min(1.4, st.shock + s.onKick)
    st.shock *= Math.exp(-dt * 4.0)

    u.uPhase.value = st.phase
    u.uShock.value = st.shock
    u.uBeatPulse.value = ctx.b.pulse
    u.uOrbitR.value = 0.55 + P.shape * 0.35 // 0.55..0.9 -- character of the set
    u.uZoom.value = 0.75 + P.fill * 0.9
    u.uContrast.value = P.contrast
    u.uEnergy.value = s.energy
    u.uHighs.value = s.highs

    // No quality-tier coupling (F129): the tier's job is resolution, via the
    // global pixelBudget/performanceCost system (engine/renderScale.ts), not
    // escape-time detail. Cutting `uMaxIter` at low tiers left the interior
    // set visibly under-resolved -- only the complexity dial spans the range
    // now.
    u.uMaxIter.value = Math.max(30, Math.round(30 + P.complexity * (MAX_ITER_CAP - 30)))
  },
})
