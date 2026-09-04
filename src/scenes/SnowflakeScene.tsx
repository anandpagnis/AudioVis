import * as THREE from 'three'
import { createShaderScene } from '../engine/createShaderScene'
import { slew } from '../engine/response'
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
 *   kick                -> FLINCH: the crystal draws in (see below)
 *   sub                 -> hub swell (the crystal's central anchor point)
 *   energy              -> crystal brightness + arm-length swell
 *   highs               -> glint amplitude + more sparkle in the star dust
 *
 * `sub` had nowhere to go until now — every arm/branch dimension in this SDF
 * is either a dial or a decaying kick burst. The hub ring (`r - 0.09`, the
 * point all six arms spring from) is the one feature with no dial bound to it
 * at all, so a continuous bass level swelling it reads as "the crystal's
 * heart breathing with the bass" instead of competing with `onKick`'s existing
 * stroke-width flash or `energy`'s arm-length swell.
 *
 * ## Band routing
 *
 *   kick    -> uOpen: the crystal CONTRACTS — arms shorten, the outermost fern
 *              branch withdraws entirely, strokes thin, contrast hardens. Snaps
 *              in fast, breathes back slow. Adds no brightness whatsoever.
 *   sub     -> hub ring radius (continuous swell, and now deliberately the
 *              counter-motion to uOpen — see below)
 *   mids    -> turn rate
 *   energy  -> crystal / arm swell
 *   highs   -> glints + snow-dust sparkle
 *
 * ## Response identity: counter-motion — the scene that answers a hit by
 * ## getting SMALLER
 *
 * The audit behind `engine/response.ts` counted the roster's reactions: 22 of
 * 22 scenes brighten on a kick, 14 of 22 grow, and exactly one did anything
 * that shrinks. This scene used to be a textbook member of that majority — a
 * kick widened its strokes (`uShock` -> line width) and pushed both the crystal
 * and the glints brighter. Both of those are gone. It now does the opposite of
 * what the room does.
 *
 * A kick makes the flake FLINCH. `uOpen` runs 1 (fully extended, the authored
 * still) down toward 0, and everything dimensional follows it inward at once:
 * the spine shortens, which drops the outermost side branch below `armLen` and
 * deletes it outright, the hexagonal plates slide down the arm with it, and the
 * stroke weight thins so the whole crystal reads as finer and colder. The
 * release is the reaction, though — see FLINCH_FALL / FLINCH_RISE for why the
 * asymmetry is the point rather than a detail.
 *
 * The hub ring is deliberately NOT part of the contraction. `sub` still swells
 * it while the arms pull in, so a bass hit sets the heart pushing out against
 * the limbs drawing back. That tension is the reason this reads as a flinch
 * (something recoiling) rather than as a zoom (everything scaling together).
 *
 * Nothing here is a gain term. Where the kick used to add brightness it now
 * moves the final contrast gamma instead: the flake goes harder and steelier as
 * it draws in, and softens as it re-opens. Same authored 0.9 at rest.
 *
 * No `quality.knobs`: a flat 2D SDF with a 6-iteration constant loop has no
 * expensive knob to gate — same as `matrix` / `wireframe` (F111). Its
 * `SCENE_COST_MS` row is therefore flat across tiers.
 */

/**
 * How far the crystal draws in at a full hit: `uOpen` is driven toward
 * `1 - FLINCH_DEPTH`. 0.85 is deep on purpose — the fall rate below means a
 * real kick only ever gets `uOpen` down to roughly 0.35-0.45 before the
 * envelope releases, so the authored depth has to overshoot the depth actually
 * reached. What lands is a ~15-18% contraction, which is enough to see the
 * outer fern branch vanish and not so much that the flake pops.
 */
const FLINCH_DEPTH = 0.85

/**
 * The snap inward, in `slew()` fall-rate units — a ~33 ms time constant, so
 * the contraction is faster than the eye tracks as motion and lands as a
 * recoil rather than as a shrink.
 */
const FLINCH_FALL = 30

/**
 * The breath back out — a ~0.45 s time constant, about **14x slower than the
 * fall**, and that ratio is the entire response identity.
 *
 * `slew()` exists precisely because the roster's ubiquitous
 * `shock *= exp(-dt * k)` is the SYMMETRIC case with an instant attack: one
 * rate, so every scene's kick has the same silhouette in time. Split the rate
 * in two and the identical kick envelope becomes a different gesture. Fast in,
 * slow out is a flinch — a thing recoiling from a blow and then, having decided
 * it is safe, unfolding again. Reverse the two and the same numbers read as a
 * slow inhale that gets cut off, which is a different scene.
 *
 * 2.2 rather than something slower is a compromise with four-on-the-floor: at
 * ~128 BPM the flake needs to re-open most of the way inside a 0.47 s beat, or
 * successive kicks just hold it contracted and the motion flattens into a
 * steady pumped state with no gesture left in it.
 */
const FLINCH_RISE = 2.2

export const FRAG = /* glsl */ `
  uniform float uAngle;    // accumulated turn (rate + static tilt offset), JS-side
  uniform float uZoom;     // fill dial
  uniform float uArms;     // shape dial -> 4..8
  uniform float uBranch;   // complexity dial -> 0.2..1.0
  uniform float uTint;     // contrast dial -> ice colour
  uniform float uEnergy;
  uniform float uHighs;
  uniform float uBass;     // s.sub -> hub ring swell (continuous)
  /**
   * How far the crystal is extended: 1 = fully open (the authored still),
   * falling toward 0 as it flinches from a kick. Every use of it below is a
   * mix() with 1.0 at one end, so uOpen = 1 reproduces the source's constants
   * exactly and silence is the authored image.
   */
  uniform float uOpen;

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

    // The flinch. Everything dimensional draws in together: the spine
    // shortens, which drops the outermost side branch below armLen in the loop
    // below and deletes it outright, and the hexagonal plates slide down the
    // arm with it so the crystal contracts as one body instead of stretching.
    float armScale = mix(0.70, 1.0, uOpen);

    float armLen = (0.78 + 0.05 * sin(uTime * 0.4) + uEnergy * 0.12) * armScale;
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
    // hexagonal plates along the arm, riding inward with armScale, and the
    // central hub -- the one feature with no dial of its own, so the sub-bass
    // level swells its radius. The hub is deliberately LEFT OUT of the
    // contraction: the heart pushes out while the limbs pull back, and that
    // opposition is what makes this read as a flinch rather than a zoom.
    d = min(d, abs(length(p - vec2(0.34 * armScale, 0.0)) - 0.05));
    d = min(d, abs(length(p - vec2(0.6 * armScale, 0.0)) - 0.035));
    d = min(d, abs(r - (0.09 + uBass * 0.05)));

    // A kick THINS the strokes rather than blooming them -- the flake gets
    // finer and colder on the hit, not fatter. Carries the glow radius below
    // with it, so the halo tightens too.
    float w = 0.012 * mix(0.55, 1.0, uOpen);
    float crystal = smoothstep(w, 0.0, d);
    float glow = smoothstep(w * 6.0, 0.0, d);

    vec3 ice = mix(vec3(0.6, 0.85, 1.0), vec3(0.8, 0.9, 1.0), uTint);
    vec3 col = mix(vec3(0.01, 0.03, 0.08), vec3(0.0, 0.01, 0.03), r);   // cold deep field
    col += smoothstep(0.99 - uHighs * 0.02, 1.0, hash(floor(gl_FragCoord.xy)))
         * (0.5 + uHighs * 0.4);                                        // snow dust / stars
    // Neither of the next two carries a kick term any more. They used to add
    // uShock * 0.8 and uShock * 1.2, which is the reaction 22 of 22 scenes
    // already have; the hit is entirely dimensional now.
    col += ice * crystal * (1.0 + uEnergy * 0.5);
    col += ice * glow * 0.3;
    col += vec3(1.0) * crystal
         * (0.4 + 0.6 * sin(uTime * 3.0 + r * 20.0))
         * (0.5 + uHighs * 0.8);                                         // glints

    col *= 1.0 - 0.2 * dot(uv, uv);
    // The source's mild contrast gamma, and where the kick's tonal reaction
    // went: drawing in hardens the curve (deeper midtones, steelier ice)
    // instead of adding gain. Exactly 0.9 -- the authored value -- at rest.
    col = pow(max(col, 0.0), vec3(0.9 + (1.0 - uOpen) * 0.3));
    gl_FragColor = vec4(col * uFade, 1.0);
  }
`

interface SnowflakeState {
  /** Accumulated turn, so a changing rate stays continuous. */
  angle: number
  /**
   * How far the crystal is extended, 0..1, resting at 1. Falls fast on a kick
   * and rises slowly afterwards — the asymmetry is the reaction.
   */
  open: number
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
    uBass: { value: 0 },
    uOpen: { value: 1 },
  }),
  state: () => ({ angle: 0, open: 1 }),
  update({ u, s, P, st, dt }) {
    // Source's authored turn was a fixed TIME*0.08. Accumulate so a changing
    // rate stays continuous; mids speed the turn, `speed` is the dial.
    st.angle += dt * 0.08 * (1 + s.mids * 0.8) * drastic(P.speed)

    // A kick makes the crystal FLINCH — it draws in, then breathes back.
    //
    // Both kick signals feed one target, and each covers the other's gap:
    // `s.onKick` is a single-frame onset spike, sharp enough to start the
    // contraction on the exact frame of the hit but gone by the next one, and
    // `s.kick` is the continuous ~140 ms punch envelope, which holds the
    // target down while the hit is still sounding but only reaches full
    // strength a frame or two late. The max of the two is contracted-while-hit
    // with no attack lag.
    const hit = Math.min(1, Math.max(s.kick, s.onKick))
    // Fast fall, slow rise. NOT `exp(-dt * k)`: that is this same follower with
    // one rate for both directions, and one rate is what makes every scene's
    // kick the same gesture. See FLINCH_RISE for the ratio's reasoning.
    st.open = slew(st.open, 1 - hit * FLINCH_DEPTH, dt, FLINCH_RISE, FLINCH_FALL)

    // `tilt` is a static rotation offset folded onto the running angle so the
    // slider centre (0.5) is the source's zero offset.
    u.uAngle.value = st.angle + (P.tilt - 0.5) * Math.PI
    u.uOpen.value = st.open
    u.uEnergy.value = s.energy
    u.uHighs.value = s.highs
    u.uBass.value = s.sub

    // Piecewise so each dial's neutral 0.5 lands on the source's authored
    // default: arms 6, branch 0.6, zoom 1.0, tint 0.5.
    u.uArms.value = 4 + Math.round(P.shape * 4) // 4..8, `steps(P.shape, 4, 8)`
    u.uBranch.value = 0.2 + P.complexity * 0.8 // 0.2..1.0
    u.uZoom.value = 0.6 + P.fill * 0.8 // 0.5 -> 1.0
    u.uTint.value = P.contrast
  },
})
