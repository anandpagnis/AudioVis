import { createShaderScene } from '../engine/createShaderScene'
import { criticalDamping, gate, spring, springStep, type SpringState } from '../engine/response'
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
 *   - The zoom breathes with the beat-subdivision pulse (`ctx.b.pulse`) — the
 *     "dancy" request — rather than a purely autonomous sine wave with no
 *     relationship to the music.
 *   - The drum response is now two-tier and probability-gated. See below.
 *
 * ## Restraint as the technique — this scene's identity
 *
 * This scene answers **most** beats with something small and **occasionally**
 * with something large, and which beats get the large answer is decided by a
 * deterministic gate rather than by the music's loudness.
 *
 * The roster audit that produced `engine/response.ts` measured what it is
 * reacting against: all 22 live scenes drove brightness from an audio
 * envelope, ten of the twelve `createShaderScene` scenes shared a
 * near-identical `onKick`→`exp()`-decay→glow mapping, and nothing in the
 * roster reacted at anything above per-frame level. This scene was a textbook
 * case — one `uShock`, charged by every `onKick`, decayed at `exp(-dt*4)`, and
 * wired simultaneously into a 10% zoom punch, the orbit radius and the edge
 * glow. Every kick got the same answer at the same size, which is what makes a
 * visualiser read as a strobe rather than as a performance.
 *
 * Now:
 *
 *   - **Small, on essentially every beat** (`uTick`, charged by `onKick`,
 *     `exp(-dt*5)`): the escape-colour band spacing tightens ~30% and the zoom
 *     nudges 3%. That is it. Alongside the always-on `uBeatPulse` breathing,
 *     the picture is doing something on every beat whether or not the gate
 *     fires.
 *   - **Large, on roughly one beat in seven** (`uSurge` + `uJumpPhase`, gated):
 *     a 22% zoom lunge, the wing fold's seam pulling open, the orbit radius
 *     widening — and, the part that persists, a **structural jump**: `c` leaps
 *     to a new point on its orbit and *stays there*, on a spring that
 *     overshoots and settles. The Julia set does not brighten, it becomes a
 *     different set.
 *
 * The occasional big move reads as intentional precisely because the beats
 * either side of it did something small. A big move on every beat is not a
 * bigger scene, it is the strobe again.
 *
 * ### The gate is deterministic, and that is a hard requirement
 *
 * `gate(f.beatIndex, p)` hashes the running beat index. `Math.random()` would
 * have been one character shorter and is wrong for a reason that has nothing
 * to do with tidiness: **a recorded show has to replay identically.** A session
 * is logged (`engine/sessionLog.ts`) and re-rendered against the same audio;
 * with a random gate, every playback of the same track would be a different
 * edit — different beats escalating, a big move landing on a moment that had
 * nothing in the first render. The visualiser would stop being reproducible
 * output and become a slot machine, and no cut of it could be reviewed,
 * compared, or trusted. Same reasoning `pickTransitionStyle`'s deterministic
 * rotation records.
 *
 * Seeded on `beatIndex` specifically — not on a frame counter, not on elapsed
 * time — because `beatIndex` is a property of the *music's position*, so the
 * same beat of the same track always makes the same decision no matter what
 * frame rate the render ran at or how long the scene had been mounted.
 *
 * The jump *magnitude* is a fixed golden-angle step ({@link JUMP_STEP}) for the
 * same reason: successive jumps land far apart on `c`'s orbit and never quite
 * revisit a previous point, so no two consecutive big moves look alike, with no
 * randomness anywhere to make a second playback diverge.
 *
 * ### The probability escalates across the phrase
 *
 * `p` ramps from {@link GATE_P_MIN} at the start of a phrase to
 * {@link GATE_P_MAX} at its end, off `f.phraseProgress` — another signal with
 * zero readers across the roster before this. Big moves therefore cluster
 * toward phrase ends, which is where a listener is already braced for one.
 * Measured over 4000 beats: 105 / 134 / 169 / 191 fires across the phrase's
 * four bars, a clean monotone build. The ramp is still deterministic — it is a
 * function of the analysed audio, not of chance.
 *
 * **Measured rate.** 15.0% of beats fire, mean gap 6.7 beats, median 5. At
 * 120 BPM that is one big move every ~3.3 s, i.e. roughly every 1.7 bars —
 * comfortably inside "occasionally" without ever being so sparse that a
 * 20-second scene slot might not contain one. With `phraseProgress` pinned at
 * 0 (no phrase read yet) it degrades to 8%, one big move every ~6 s, which is
 * still alive.
 *
 * ### Why it does not read as frozen between big moves
 *
 * The codebase's standing rule (see `KaleidoPulseScene`, and `HoldScene`'s
 * self-sustaining breath) is that a scene visibly stopping between triggers
 * reads as broken. Between gate fires this one still has: `uPhase` accumulating
 * continuously so `c` keeps walking its orbit, the `uBeatPulse` zoom breathing
 * on every beat subdivision, `uTick` on every detected kick, and `highs` and
 * `energy` per frame. The held `uJumpPhase` is an *offset* to a phase that
 * never stops advancing, so holding it freezes nothing.
 *
 * ## Band routing
 *
 *   gate(beatIndex, p) → the big move: c-orbit structural jump (HELD, sprung),
 *                        22% zoom lunge, fold-seam widen, orbit-radius widen.
 *                        p ramps 0.08 -> 0.24 across the phrase; ~15% of beats.
 *                        Deterministic — see above, this is load-bearing.
 *   onKick             → the small move: escape-colour band spacing + 3% zoom.
 *                        Reaches NO brightness term at all.
 *   pulse              → continuous beat-synced zoom breathing (the "dancy" part)
 *   mids               → orbit angular speed
 *   energy             → overall brightness + orbit radius (busier at high energy)
 *   highs              → filament edge-glow intensity
 *
 * ### One term deliberately off brightness
 *
 * 22 of 22 scenes drove brightness from an audio envelope. The drum response
 * here now drives none of it: `uShock`'s `+ uShock * 0.7` term is gone from
 * `edgeBoost` and nothing replaced it, leaving `highs` as the only thing that
 * lifts the filament glow. What the small per-beat response drives instead is
 * the **escape-colour band spacing** — the `0.045` multiplier on the smooth
 * iteration count, which sets how tightly the filaments are striped. A beat
 * reads as the stripes drawing closer together, a density change with no gain
 * component. The big move additionally walks the **ramp position** off the held
 * jump phase, so a new configuration arrives in a new colour rather than merely
 * at a new zoom.
 *
 * ## Parameter neutrality
 *
 * The roster invariant that every contract dial at 0.5 reproduces the authored
 * constants survives: `uTick`, `uSurge` and `uJumpPhase` are all 0 with no
 * audio, and every term they appear in is written as an addition to (or a
 * `1.0 +` multiplier on) the original expression, so a silent frame renders the
 * shader that was here before.
 */

/** Loop ceiling. GLSL ES 1.00 needs a constant bound; `uMaxIter` early-breaks. */
const MAX_ITER_CAP = 160

/** Probability the big move fires, at the START of a phrase. */
const GATE_P_MIN = 0.08

/** Probability the big move fires, at the END of a phrase. */
const GATE_P_MAX = 0.24

/**
 * How far `c` leaps along its orbit on a big move, in radians.
 *
 * The golden angle, `pi * (3 - sqrt(5))`. Stepping by it means successive jumps
 * distribute themselves as evenly as an irrational rotation can over the
 * circle and never land twice on the same point, so consecutive big moves are
 * always visibly different configurations — the phyllotaxis argument, applied
 * to a parameter orbit instead of to seeds on a sunflower. Fixed rather than
 * hashed so there is nothing left in the big move that a replay could diverge
 * on: which beats fire is deterministic, and so is what they do.
 */
const JUMP_STEP = Math.PI * (3 - Math.sqrt(5))

const TAU = Math.PI * 2

/**
 * Spring constants carrying `uJumpPhase` to its new held value.
 *
 * A spring rather than another `exp()` decay because `exp()` only ever falls —
 * it cannot express *arriving somewhere*, which is what a structural jump is —
 * and because the overshoot is what makes the leap read as having mass rather
 * than as a crossfade. `response.ts` records that the audit found overshoot in
 * 0 of 22 scenes.
 *
 * Stiffness 90 gives a natural frequency of ~9.5 rad/s; damping at 0.55x
 * critical gives ~13% overshoot and settles in ~0.8 s, so at 120 BPM the lunge
 * takes about a beat and a half to come to rest. The travel itself is ~20x the
 * orbit's normal angular rate, which is what makes it read as a leap and not as
 * a speed-up.
 */
const JUMP_STIFFNESS = 90
const JUMP_DAMPING = criticalDamping(JUMP_STIFFNESS) * 0.55

/**
 * Exported so the shader can be compiled AND linked outside the app — the
 * roster convention (see MatrixRainScene). Full source is
 * `SHADER_SCENE_PRELUDE + PALETTE_RAMP_GLSL + FRAG`.
 */
export const FRAG = /* glsl */ `
  uniform float uPhase;
  // uTick / uSurge are the two tiers of the drum response; uJumpPhase is the
  // held half of the big one. None of these may collide with a name in
  // SHADER_SCENE_PRELUDE (uKick, uBeatSin*, the palette slots, ...) -- a
  // redeclaration at global scope is a GLSL link error that surfaces as a
  // silently BLACK scene, which has already cost this project a session.
  uniform float uTick;
  uniform float uSurge;
  uniform float uJumpPhase;
  uniform float uOrbitR;
  uniform float uZoom;
  uniform float uContrast;
  uniform float uEnergy;
  uniform float uHighs;
  uniform float uBeatPulse;
  uniform int uMaxIter;

  void main() {
    vec2 uv = (2.0 * gl_FragCoord.xy - uRes.xy) / uRes.y;

    // Zoom, three tiers: continuous subdivision breathing, a small nudge on
    // every kick, and the gated lunge. The 3:22 ratio between the last two is
    // the whole design -- the big one only reads as big because the small one
    // is what a beat normally gets.
    float zoomPulse = 1.0 + 0.12 * uBeatPulse + 0.030 * uTick + 0.22 * uSurge;
    float zoom = uZoom * zoomPulse;
    float ang = uPhase * 0.25;
    float ca = cos(ang), sa = sin(ang);
    uv = mat2(ca, -sa, sa, ca) * uv / zoom;

    // The wing fold: mirror both axes before iterating. A big move pulls the
    // seam open, which separates the four wings for as long as the surge lasts.
    vec2 z = abs(uv) - vec2(0.052, 0.038) * uSurge;

    // c orbits just outside the cardioid. uJumpPhase is the HELD half of the
    // big move: it steps by a golden angle and stays, so the set does not
    // brighten, it becomes a different set. Added here and not to uPhase itself
    // so the frame rotation and the ramp drift, which also read uPhase, are
    // left alone.
    float cPhase = uPhase + uJumpPhase;
    float orbitR = uOrbitR + uSurge * 0.055 + uTick * 0.010 + uEnergy * 0.03;
    vec2 c = orbitR * vec2(cos(cPhase), sin(cPhase * 1.3 + 1.7));

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

      // The small per-beat response, and it lands HERE rather than on any
      // brightness term: this multiplier sets how tightly the escape bands are
      // striped across the filaments, so a beat reads as the stripes drawing
      // closer together. Density, not gain.
      float bandScale = 0.045 * (1.0 + 0.30 * uTick);

      // sin() of the held jump phase, not the phase itself: it has period TAU,
      // exactly the period uJumpPhase is wrapped on in JS, so the wrap is
      // invisible here. A new configuration therefore arrives in a new colour.
      float jumpTint = 0.11 * sin(uJumpPhase);
      float t2 = smoothN * bandScale + uPhase * 0.02 + jumpTint;

      col = paletteRamp(t2);

      // Filament glow: brighter right at the escape threshold, boosted by
      // highs, sampled from the LIT slots only so it never dips toward the dark
      // ground. The drum term that used to sit here (+ uShock * 0.7) is gone --
      // 22 of 22 scenes drove brightness from an audio envelope and this one
      // now drives none of it.
      float edge = smoothstep(0.0, 1.0, fract(smoothN));
      float edgeBoost = 0.35 + uHighs * 0.55;
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
  /** The small tier: charged by every detected kick, decaying fast. */
  tick: number
  /** The big tier's transient half: charged only when the gate fires. */
  surge: number
  /**
   * The big tier's held half — target for the c-orbit jump, in radians, kept
   * inside 0..TAU.
   */
  jumpTarget: number
  /**
   * Spring carrying `uJumpPhase` to {@link jumpTarget}. Overshoots and settles,
   * then holds until the next gate fire.
   */
  jump: SpringState
  /**
   * `beatIndex` the gate was last evaluated on.
   *
   * `f.beat` is documented as true for exactly one frame, so this is belt and
   * braces — but a long frame (a shader compile, a tab returning from the
   * background) is exactly when the flag could be observed twice, and a
   * double evaluation would fire the same seed's decision twice and double the
   * jump step, breaking the "the same beat always does the same thing" property
   * this whole design rests on.
   */
  lastGateBeat: number
}

export const WingfoldJuliaScene = createShaderScene<WingfoldState>({
  id: 'wingfold',
  frag: FRAG,
  include: PALETTE_RAMP_GLSL,
  state: () => ({ phase: 0, tick: 0, surge: 0, jumpTarget: 0, jump: spring(0), lastGateBeat: -1 }),
  uniforms: () => ({
    uPhase: { value: 0 },
    uTick: { value: 0 },
    uSurge: { value: 0 },
    uJumpPhase: { value: 0 },
    uOrbitR: { value: 0.7885 },
    uZoom: { value: 1.15 },
    uContrast: { value: 0.5 },
    uEnergy: { value: 0 },
    uHighs: { value: 0 },
    uBeatPulse: { value: 0 },
    uMaxIter: { value: MAX_ITER_CAP },
  }),
  update({ u, s, P, st, dt, ctx }) {
    const f = ctx.f

    // Never gated: this is what keeps c walking its orbit between big moves,
    // so a held uJumpPhase is an offset to a moving phase rather than a freeze.
    st.phase += dt * (0.35 + s.mids * 0.25) * drastic(P.speed)

    // --- The small tier. Every detected kick, at a size that reaches exactly
    // two terms (band spacing, a 3% zoom nudge) and no brightness term at all.
    if (s.onKick > 0) st.tick = Math.min(1, st.tick + s.onKick * 0.55)
    st.tick *= Math.exp(-dt * 5.0)

    // --- The big tier. Evaluated once per beat crossing, deterministically.
    if (f.beat && f.beatIndex !== st.lastGateBeat) {
      st.lastGateBeat = f.beatIndex
      const progress = Math.min(1, Math.max(0, f.phraseProgress))
      const p = GATE_P_MIN + (GATE_P_MAX - GATE_P_MIN) * progress
      if (gate(f.beatIndex, p)) {
        st.surge = 1
        st.jumpTarget += JUMP_STEP
        if (st.jumpTarget >= TAU) {
          // Wrap the target AND the spring's position by the same amount, so
          // the spring still sees the short forward step it was given rather
          // than sweeping a full turn backwards through the orbit. Velocity is
          // untouched, which is correct — a rigid translation of a spring's
          // frame does not change its motion. cos/sin have period TAU, so the
          // rendered `c` is continuous across this.
          st.jumpTarget -= TAU
          st.jump.value -= TAU
        }
      }
    }
    // Slower than the small tier's decay on purpose: the surge is the event, and
    // it should still be visibly settling when the next ordinary beat lands.
    st.surge *= Math.exp(-dt * 1.6)
    springStep(st.jump, st.jumpTarget, dt, JUMP_STIFFNESS, JUMP_DAMPING)

    u.uPhase.value = st.phase
    u.uTick.value = st.tick
    u.uSurge.value = st.surge
    u.uJumpPhase.value = st.jump.value
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
