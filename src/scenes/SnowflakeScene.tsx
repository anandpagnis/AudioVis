import * as THREE from 'three'
import { createShaderScene } from '../engine/createShaderScene'
import { drastic } from '../engine/sceneParams'

/**
 * Snowflake — a six-fold dendritic ice crystal slowly turning and glinting
 * against the deep cold.
 *
 * Supplied directly by the requester as an ISF shader, credited in-source to
 * "claude-opus-4-8" — same provenance basis as `malachite` (a witnessed
 * generation, no upstream to audit) — so `license: 'original'`.
 *
 * ## Port notes (ISF -> AudioVis prelude)
 *
 *   TIME            -> uTime (slow oscillators) + uAngle (JS turn accumulator)
 *   RENDERSIZE      -> uRes
 *   gl_FragCoord    -> unchanged
 *   mainImage/main  -> main() / gl_FragColor, final * uFade
 *   ISF inputs      -> the Scene Contract dials (see below) + audio uniforms
 *
 * `pow(col, 0.9)` at the end is the source's mild contrast gamma, NOT a
 * linear->sRGB (1/2.2) encode — three's renderer does that itself. Kept.
 *
 * ## What was added (the source is time-driven only — "a still that drifts")
 *
 *   speed dial + mids   -> turn rate (was a fixed TIME*spin)
 *   onKick              -> glint burst + a brief line-width bloom, decaying
 *   energy              -> crystal brightness + arm-length swell
 *   highs               -> glint amplitude + more sparkle in the star dust
 *
 * ## Band routing
 *
 *   onKick  -> uShock: glint flash + line bloom (decaying)
 *   mids    -> turn rate
 *   energy  -> crystal / arm swell
 *   highs   -> glints + snow-dust sparkle
 *
 * No `quality.knobs`: a flat 2D SDF with a 6-iteration constant loop has no
 * expensive knob to gate — same as `matrix` / `wireframe` (F111). Its
 * `SCENE_COST_MS` row is therefore flat across tiers.
 */

export const FRAG = /* glsl */ `
  uniform float uAngle;    // accumulated turn (rate + static tilt offset), JS-side
  uniform float uZoom;     // fill dial
  uniform float uArms;     // shape dial -> 4..8
  uniform float uBranch;   // complexity dial -> 0.2..1.0
  uniform float uTint;     // contrast dial -> ice colour
  uniform float uEnergy;
  uniform float uHighs;
  uniform float uShock;    // decaying kick envelope

  #define PI 3.14159265

  mat2 rot(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
  float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }

  float seg(vec2 p, vec2 a, vec2 b){
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h);
  }

  void main(){
    vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
    uv *= rot(uAngle);
    uv *= uZoom;
    float r = length(uv);

    // fold into one wedge (n-fold rotation + mirror)
    float a = atan(uv.y, uv.x);
    float seg6 = 2.0 * PI / uArms;
    a = mod(a, seg6);
    a = abs(a - 0.5 * seg6);
    vec2 p = vec2(cos(a), sin(a)) * r;     // p.x radial, p.y >= 0 perpendicular

    float armLen = 0.78 + 0.05 * sin(uTime * 0.4) + uEnergy * 0.12;
    float d = seg(p, vec2(0.04, 0.0), vec2(armLen, 0.0));     // main spine

    // side branches (a little fern), 60 degrees off the spine, shrinking to the tip
    float bAng = PI / 3.0;
    vec2 bdir = vec2(cos(bAng), sin(bAng));
    for (int k = 1; k <= 6; k++){
      float bx = 0.10 * float(k);
      if (bx > armLen) break;
      float bl = uBranch * 0.22 * (1.0 - bx / armLen);
      d = min(d, seg(p, vec2(bx, 0.0), vec2(bx, 0.0) + bdir * bl));
    }
    // hexagonal plates along the arm, and the central hub
    d = min(d, abs(length(p - vec2(0.34, 0.0)) - 0.05));
    d = min(d, abs(length(p - vec2(0.6, 0.0)) - 0.035));
    d = min(d, abs(r - 0.09));

    // a kick briefly widens the strokes, so the whole flake blooms on the hit
    float w = 0.012 * (1.0 + uShock * 0.6);
    float crystal = smoothstep(w, 0.0, d);
    float glow = smoothstep(w * 6.0, 0.0, d);

    vec3 ice = mix(vec3(0.6, 0.85, 1.0), vec3(0.8, 0.9, 1.0), uTint);
    vec3 col = mix(vec3(0.01, 0.03, 0.08), vec3(0.0, 0.01, 0.03), r);   // cold deep field
    col += smoothstep(0.99 - uHighs * 0.02, 1.0, hash(floor(gl_FragCoord.xy)))
         * (0.5 + uHighs * 0.4);                                        // snow dust / stars
    col += ice * crystal * (1.0 + uEnergy * 0.5 + uShock * 0.8);
    col += ice * glow * 0.3;
    col += vec3(1.0) * crystal
         * (0.4 + 0.6 * sin(uTime * 3.0 + r * 20.0))
         * (0.5 + uHighs * 0.8 + uShock * 1.2);                          // glints

    col *= 1.0 - 0.2 * dot(uv, uv);
    col = pow(max(col, 0.0), vec3(0.9));
    gl_FragColor = vec4(col * uFade, 1.0);
  }
`

interface SnowflakeState {
  /** Accumulated turn, so a changing rate stays continuous. */
  angle: number
  /** Kick glint burst, decaying. */
  shock: number
}

export const SnowflakeScene = createShaderScene<SnowflakeState>({
  id: 'snowflake',
  frag: FRAG,
  // Crisp thin strokes — the direct (native-res) path, same as `matrix`,
  // whose hard edges ruled the upscaled offscreen path out. No `pixelBudget`.
  blending: THREE.NoBlending,
  uniforms: () => ({
    uAngle: { value: 0 },
    uZoom: { value: 1 },
    uArms: { value: 6 },
    uBranch: { value: 0.6 },
    uTint: { value: 0.5 },
    uEnergy: { value: 0 },
    uHighs: { value: 0 },
    uShock: { value: 0 },
  }),
  state: () => ({ angle: 0, shock: 0 }),
  update({ u, s, P, st, dt }) {
    // Source's authored turn was a fixed TIME*0.08. Accumulate so a changing
    // rate stays continuous; mids speed the turn, `speed` is the dial.
    st.angle += dt * 0.08 * (1 + s.mids * 0.8) * drastic(P.speed)
    // A kick is a twinkle, not a sustained value — charge a fast-decay burst.
    if (s.onKick > 0) st.shock = Math.min(1.5, st.shock + s.onKick)
    st.shock *= Math.exp(-dt * 4.5)

    // `tilt` is a static rotation offset folded onto the running angle so the
    // slider centre (0.5) is the source's zero offset.
    u.uAngle.value = st.angle + (P.tilt - 0.5) * Math.PI
    u.uShock.value = st.shock
    u.uEnergy.value = s.energy
    u.uHighs.value = s.highs

    // Piecewise so each dial's neutral 0.5 lands on the source's authored
    // default: arms 6, branch 0.6, zoom 1.0, tint 0.5.
    u.uArms.value = 4 + Math.round(P.shape * 4) // 4..8, `steps(P.shape, 4, 8)`
    u.uBranch.value = 0.2 + P.complexity * 0.8 // 0.2..1.0
    u.uZoom.value = 0.6 + P.fill * 0.8 // 0.5 -> 1.0
    u.uTint.value = P.contrast
  },
})
