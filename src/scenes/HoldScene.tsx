import * as THREE from 'three'
import { createShaderScene } from '../engine/createShaderScene'

/**
 * Hold — near-black, one slow breathing gradient, minimal motion: the
 * screen's own authored answer to "the show is holding" during true silence.
 *
 * Original content, written directly to close a real gap in the live roster
 * (`SCENES`, src/scenes/index.ts). Every director that reacts to mood —
 * `PerformanceDirector`, `AutoPilot`, `EffectDirector`, `FilterDirector` —
 * already suppresses activity on `f.silence`, but nothing on the roster ever
 * declared `'silence'` in its own `moods` list, so the screen's actual
 * response to silence was always "whatever scene happened to be on screen
 * when the music stopped" rather than an authored look. This is that look.
 *
 * ## Technique
 *
 * Two closed-form terms. No loop, no fbm/noise, no raymarch, no texture read:
 *
 *   - a bare `sin(uTime * 2π / cycle)` for the breath itself. A sine already
 *     has the right shape for breathing with no easing curve layered on top —
 *     slow through both extremes (the held in/held out moment), fastest
 *     through the middle.
 *   - a radial Gaussian, `exp(-d² / 2σ²)`, for the glow. Unlike a
 *     `smoothstep` ring it never truly reaches zero, so there is no falloff
 *     radius to accidentally read as a hard edge — the brief's "no hard
 *     edges" is true by construction, not by tuning a softness knob.
 *
 * Both the glow's spatial extent (`sigma`) and its own core brightness
 * (`breathBright`) are driven off the SAME `breath` value, so the field
 * visibly swells as it brightens rather than just flickering in place — a
 * radial gradient whose reach and intensity pulse together is what makes it
 * read as one breath rather than two unrelated animations layered on it.
 *
 * Driven entirely off the free `uTime` prelude uniform (SHADER_SCENE_PRELUDE)
 * — never off a beat clock or a band level. That is the one hard requirement
 * this scene exists to satisfy: it has to keep breathing through TRUE
 * silence, the one moment `uBeatSin`/the band clocks may not be advancing at
 * all (no beat grid, no bass to hold `uBassClock` moving). A scene that went
 * static the moment the music did would look broken — worse than the
 * "nothing authored" gap this replaces.
 *
 * ## Band routing
 *
 *   energy       -> tiny continuous lift to the glow's brightness ceiling
 *   bass (s.sub) -> gentle colour lean from uShadow toward uMid ("warmth")
 *
 * Both are near-zero by definition during `f.silence` (see `amp`'s tiny
 * ceiling in the shader — even maxed, this stays a whisper) and both only
 * really move during the rare `ambient` moment this scene also declares. No
 * mid/high routing: per the brief, this scene has no business responding to
 * transient detail — the whole point is that nothing sharp is happening.
 *
 * ## No quality-tier response
 *
 * No `quality.knobs` read anywhere, same as `snowflake`/`matrix`/`wireframe`
 * (F111): two trig/exp evaluations per pixel is already at (or under) the
 * roster's own `low` floor, so there is no expensive term to gate by tier in
 * the first place — the `SCENE_COST_MS` row this earns should be flat across
 * every tier.
 *
 * ## No pixelBudget
 *
 * Full display resolution, direct (non-offscreen) path. The whole shader is
 * two closed-form scalar ops with no texture read and no loop — there is no
 * per-pixel cost here worth paying an extra fullscreen blit to avoid, unlike
 * a raymarch or an fbm field. Contrast `malachite`, whose five fbm calls are
 * genuinely worth downsampling.
 *
 * ## No contract
 *
 * Nothing here is meant to be performed. The one value that looks like a
 * dial — how fast the breath cycles — is deliberately NOT exposed: handing a
 * performer live control over "how is the show breathing right now" fights
 * the concept directly. A Scene Contract exists so a director can steer a
 * scene mid-show; this scene's entire premise is the one state where nothing
 * is being steered.
 */

/** Seconds for one full inhale-exhale. Within the brief's 4-8s+ range; not a
 * dial (see header) — a fixed, slow, human-breath-adjacent cadence. */
const BREATH_CYCLE_SEC = 6.5

export const FRAG = /* glsl */ `
  /** Master intensity, 0..~1.1 — near-zero through true silence. Lifts the
   * glow's brightness ceiling by a tiny, restrained amount. */
  uniform float uEnergy;
  /** Sub-bass level, 0..1-ish — this scene's stand-in for the SceneBand
   * 'bass' entry. Leans the glow's colour from shadow toward mid. */
  uniform float uBass;

  void main() {
    vec2 uv = (vUv - 0.5) * vec2(uAspect, 1.0);
    float d = length(uv);

    // One full breath every ${BREATH_CYCLE_SEC.toFixed(1)}s. uTime only --
    // never a beat clock, never a band -- so this keeps moving through total
    // silence exactly as it does under load.
    float breath = 0.5 + 0.5 * sin(uTime * (${(2 * Math.PI).toFixed(8)} / ${BREATH_CYCLE_SEC.toFixed(1)}));

    // Extent and core brightness pulse together off the same breath value --
    // a field that only dimmed without visibly swelling would read as
    // flicker, not as breathing.
    float sigma = mix(0.20, 0.44, breath);
    float glow = exp(-(d * d) / (2.0 * sigma * sigma));
    float breathBright = mix(0.55, 1.0, breath);

    // Deliberately tiny ceiling. energy nudges it during the rare ambient
    // moment, but even maxed this stays a whisper laid over near-black.
    float amp = 0.07 * breathBright + uEnergy * 0.05;

    // uBg is the palette's own darkest slot; dimmed further so "near-black"
    // holds regardless of how dark any given live palette's own bg actually
    // is -- this scene's floor must not depend on the operator's palette pick.
    vec3 base = uBg * 0.35;
    // Restrained warmth: sub-bass leans the glow colour toward mid, never a
    // hue jump, and only ever a partial lean (clamped mix, capped at 0.6).
    vec3 glowColor = mix(uShadow, uMid, clamp(uBass * 0.6, 0.0, 1.0));

    vec3 col = base + glowColor * glow * amp;
    gl_FragColor = vec4(col * uFade, 1.0);
  }
`

export const HoldScene = createShaderScene({
  id: 'hold',
  frag: FRAG,
  // Paints every pixel including its own near-black ground -- replace, not
  // blend, for the same reason malachite/snowflake/matrix do (see their own
  // headers). Only governs the on-screen material before BlendedLayer
  // overwrites it with the slot's own blend mode (createShaderScene's own
  // doc comment on `blending`); the direct path has no offscreen buffer.
  blending: THREE.NoBlending,
  uniforms: () => ({
    uEnergy: { value: 0 },
    uBass: { value: 0 },
  }),
  // No per-instance state: nothing here accumulates. The breath is a pure
  // function of uTime, which the engine already owns and advances -- no
  // phase to drift, no decay envelope to hold. `S` stays its `void` default.
  update({ u, s }) {
    u.uEnergy.value = s.energy
    u.uBass.value = s.sub
  },
})
