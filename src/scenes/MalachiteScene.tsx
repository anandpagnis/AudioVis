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
 *             colour-ramp position, vein width, and the flow/rotation rate
 *
 * Nothing else. No `onKick`, no `mids`, no `highs` — all three were the
 * template's own terms and all three are gone.
 *
 * ## Addendum: "breathes" was reading as "frozen"
 *
 * The swell above governs COLOUR, not motion, and was always meant to be
 * near-subliminal (0.035 / 0.02 additive terms against a 0..1 ramp — see the
 * shader body). The scene's actual sense of being alive was supposed to come
 * from the domain-warp field drifting under `uPhase`. It didn't read that
 * way, for a structural reason, not a taste one: the old `drift` term —
 * `vec2(0.3*sin(t), 0.2*cos(t*1.1))` — is a BOUNDED orbit, not a walk. At
 * `uPhase`'s authored rate (`dt*0.08`) that orbit takes ~78s to close one
 * loop, and because it is periodic and small (amplitude 0.3/0.2 against a
 * `uScale`-2.4 field) the pattern spends its whole visible lifetime near one
 * point of that loop, wobbling a few percent and never actually going
 * anywhere. A background that "breathes" needs a lung that moves air, not
 * one that flexes 3% and holds.
 *
 * Two additions below, both still driven off nothing but `uPhase` (so
 * `P.speed` and the swell's existing rate modulation keep working
 * unchanged) and neither touching brightness or reintroducing a per-hit
 * term — the "does not punch" identity above is untouched:
 *
 *   - **`flow`** — an UNBOUNDED advection of the fbm sample point, replacing
 *     the bounded orbit as the field's primary motion. The old orbit is kept
 *     as `wobble`, a small secondary term riding on top, so short-timescale
 *     motion still has some non-linear texture rather than reading as a
 *     pure scroll.
 *   - **rotation** — the whole sample plane turns slowly around centre
 *     before anything else touches it. This is a second, independent axis
 *     of motion: even a viewer who never registers the fbm churning gets a
 *     large-scale cue (the vein field's centre of mass visibly precessing)
 *     that something is moving.
 *
 * The swell's leverage over rate also went from a 15%-at-full-energy nudge
 * to 55% — the old figure was itself part of why energy arriving did
 * nothing you could see.
 *
 * ## Addendum 2: "breathes" still wasn't "on beat" — added a bar-locked tick
 *
 * Everything above moves on either a phrase timescale (`uSwell`, several
 * seconds) or free-running real time (`uPhase`'s drift/rotation, no relation
 * to tempo at all). Nothing in the file ticked with the actual beat/bar grid
 * — a grep for `uBeatSin` over the FRAG string came back empty. That is a
 * real gap distinct from "does not punch": a background can decline to flash
 * on every kick and still read as in time with the music, via smooth
 * continuous motion locked to the tempo clock rather than a per-hit snap.
 *
 * Fixed by reading the prelude's `uBeatSin4` (one continuous sine per BAR,
 * not per beat — engine-computed from `ctx.f.beatIndex`/`beatProgress`, see
 * `createShaderScene.tsx`; nothing to wire up in this file's `update()`) and
 * adding it, small and purely additive, to the whole-field rotation angle
 * (`ROT_BEAT_AMOUNT`, next to `ROT_RATE` below). Bar-length rather than
 * per-beat on purpose: a scene whose whole identity is "breathes, does not
 * punch" should tick with the phrase's larger pulse, not twitch four times
 * as fast as that identity implies.
 *
 * This is NOT the "exactly one audio input" rule being quietly broken.
 * `uBeatSin4` is a tempo-grid oscillator, not an audio-envelope band — it has
 * no amplitude relationship to loudness the way `s.energy`/`s.mids` do, so it
 * cannot reintroduce a punch; it only answers "where in the bar are we".
 * Nor is it engine rule #2's bounded-oscillator bug: it rides ADDITIVELY on
 * top of the monotonically-increasing `t * ROT_RATE` sweep as a small
 * decoration, not as that sweep's only driver, so the plane's overall
 * precession never reverses — it just ticks a couple of degrees early or
 * late across each bar.
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

  // Rotation rate for the whole sample plane, in radians per \`uPhase\` unit.
  // Deliberately much smaller than FLOW_RATE below -- this is a large-scale,
  // slow precession, the second independent axis of motion described in the
  // header's addendum, not a spin you can clock.
  const float ROT_RATE = 0.045;
  // Bar-locked tick on top of that precession (see header addendum 2). Small
  // on purpose -- about 2.9 degrees of swing across a whole bar, similar
  // order to this scene's other additive nudges (uSwell * 0.06 / 0.035
  // below). It is added, never multiplied, onto an angle that keeps
  // increasing on its own via t * ROT_RATE, so this term can only nudge the
  // sweep a little early or late each bar -- it never becomes the sweep's
  // only driver and so never turns it into a back-and-forth oscillation.
  const float ROT_BEAT_AMOUNT = 0.05;
  // Unbounded per-axis walk rate for the fbm sample point, replacing the old
  // bounded sin/cos orbit as the field's primary motion (see header). Two
  // different rates so the walk isn't a straight diagonal line.
  const vec2 FLOW_RATE = vec2(0.085, -0.061);

  void main() {
    vec2 uvBase = (vUv - 0.5) * vec2(uAspect, 1.0);
    float t = uPhase;

    // Slow whole-field rotation -- see header addendum. Applied before the
    // warp so the ring ramp's centre-of-mass visibly precesses, independent
    // of the fbm churn below. The uBeatSin4 term is the scene's one
    // beat-grid-locked motion (header addendum 2): a continuous per-bar
    // sine, not a per-hit snap, so the stone visibly ticks with tempo
    // without touching the "does not punch" identity above.
    float ang = t * ROT_RATE + uBeatSin4 * ROT_BEAT_AMOUNT;
    float ca = cos(ang), sa = sin(ang);
    vec2 uv = mat2(ca, -sa, sa, ca) * uvBase;
    vec2 p = uv * uScale;

    // Heavy domain warp -> botryoidal swirls. The warp DEPTH is exactly the
    // authored constant with no audio term at all: a kick used to deepen it
    // as a churn burst, which is precisely the per-hit reaction a background
    // has no business making. Where the warp SAMPLES, though, now walks
    // continuously (\`flow\`) instead of orbiting a fixed point (\`wobble\`,
    // the old bounded term, kept as a secondary ripple on top of the walk) --
    // see header addendum for why the old orbit alone read as static.
    float warpAmt = uWarp;
    vec2 flow = t * FLOW_RATE;
    vec2 wobble = vec2(0.3 * sin(t * 1.7), 0.2 * cos(t * 1.9));
    vec2 q = vec2(fbm(p + flow + wobble), fbm(p + vec2(5.2, 1.3) - flow - wobble));
    vec2 r = vec2(
      fbm(p + warpAmt * q + vec2(1.7, 9.2) + flow),
      fbm(p + warpAmt * q + vec2(8.3, 2.8) - flow * 0.6)
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
    // Nudged up from 0.035 -- at the old figure this term was small enough
    // to be functionally invisible against the palette mix, which was part
    // of why "one slow swell" wasn't reading as motion at all.
    float lit = clamp(litness + uSwell * 0.06, 0.0, 1.0);
    // Base hardness from toxicity. Veins BROADEN slightly as the phrase
    // swells (the old term tightened them on hats, per-transient); against the
    // lifting ramp above this reads as the stone gaining definition rather
    // than gaining brightness. Also nudged up (0.02 -> 0.035) for the same
    // readability reason as \`lit\` above.
    float veinW = max(0.02, mix(0.20, 0.06, uTox) + uSwell * 0.035);
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

    // \`lit\`, not \`litness\`: this mix is the colour-ramp position the header
    // and comment above describe as swell-driven. It previously read
    // \`litness\` here -- \`lit\` was computed and never consumed, so the
    // swell's colour term was dead code and the ramp never actually moved
    // no matter how much energy arrived. That silent no-op was as much a
    // cause of "feels static" as the motion terms above.
    vec3 col = mix(uShadow, midCol, lit);
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
    // now drives the flow/rotation rate too — this was `s.mids` before the
    // rewrite; this scene has exactly one audio input, so the phrase breath
    // widens the flow instead of a band level that no longer reaches this
    // scene. The 0.15 multiplier here originally made high energy barely
    // distinguishable from silence (max +15% rate); raised to 0.55 so a loud
    // phrase visibly quickens the churn/rotation against the quiet baseline,
    // per the header addendum on why this scene read as static.
    st.phase += dt * 0.08 * (1 + st.swell * 0.55) * drastic(P.speed)
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
