import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { Wireframe } from 'three/examples/jsm/lines/Wireframe.js'
import { WireframeGeometry2 } from 'three/examples/jsm/lines/WireframeGeometry2.js'
import { CURL_NOISE_GLSL } from '../engine/shaderLib'
import { slew, spring, springStep, type SpringState } from '../engine/response'
import { proceduralDispatcher } from '../engine/streaming/proceduralDispatcher'
import { useSceneFrame } from '../engine/sceneFrame'
import { useDispose } from '../engine/useDispose'

/**
 * Dissolve Cage — a form scattering into particles and reforming, contained.
 *
 * Deliberately a composition of the other two new techniques rather than a
 * third one: WireframeHeroScene's real-edge cage supplies the hard geometric
 * container, PlasmaFilamentScene's curl field supplies the organic transport.
 * The tension between them (rigid frame, liquid contents) is the whole image.
 *
 * The transport is closed-form: every particle interpolates between a formed
 * position (area-weighted sample of the hero surface) and a scattered one, with
 * a per-particle stagger so dissolution sweeps across the form as a wave rather
 * than flipping like a switch. The curl term is enveloped by sin(t·π) so it
 * peaks mid-transition and vanishes at both ends — the form is crisp when
 * assembled and settled when dispersed, and only churns while in motion.
 *
 * Musically it runs an autonomous cycle so there is always something happening,
 * but drops and section changes yank it apart on the transient.
 *
 * ## Band routing
 *
 *   mid + bass  -> curl-field strength (the swirl widens through dense
 *                  harmonic passages, not only on the kick)
 *   presence    -> cage stroke weight
 *   pulse       -> point size, cage colour drive
 *   high        -> sparse per-particle sparkle, cage colour drive
 *   transient   -> per-particle jitter (see "Response identity" below)
 *   energy + presence -> per-particle brightness
 *   kick        -> cage rattle (roll) + stroke flash, via one underdamped
 *                  spring (see "Response identity" below)
 *
 * ## Response identity: per-particle stagger, refined rather than replaced
 *
 * Of 22 live scenes exactly one had any per-element delay at all before wave 1
 * — this scene's `aRand.y` stagger, and per `TRAVELLING_PULSE_GLSL`'s own doc
 * "even that is not audio-keyed" (it is a fixed per-particle offset, not tied
 * to which band or beat fires). That stagger IS the identity and is untouched
 * here. Two refinements sit on top of it instead of replacing it:
 *
 *   - The drop-forced arrival at full scatter now runs through
 *     `engine/response.ts`'s `slew()` instead of a hand-rolled
 *     `Math.min(1, dt * rate)` step — see the comment at the dissolve blend
 *     below for why an underdamped SPRING (overshoot) was considered for this
 *     spot and declined: the per-particle clamp already saturates most of the
 *     cloud before an overshoot could render anything.
 *   - The transient jitter now fires on a deterministic ~35% of particles per
 *     beat (a GLSL-side hash of particle × beat index — the same contract as
 *     `response.ts`'s `gate()`, reimplemented in-shader because a vertex
 *     shader cannot call into TS) instead of nudging all 24k every hit. A hit
 *     now reads as a subset of debris catching the impulse, which deepens the
 *     per-particle differentiation the stagger already started rather than
 *     competing with it.
 *   - The cage's only whole-object reaction used to be a generic tempo-locked
 *     sway — `rotation.x = animationSignals.oscillate * 0.12`, a free-running
 *     sine shared by every scene that opts into it — nodding the frame on a
 *     clock that had no relationship to anything the music actually DID. In a
 *     scene this fine-grained everywhere else, that one large, unmotivated
 *     motion was the picture ("the cube bounces up and down") instead of the
 *     dissolve/cage mechanic being the picture — reported as wasted
 *     potential. It is gone. In its place a kick charges `cageJolt`, one
 *     underdamped spring (`CAGE_JOLT_*` below, well under
 *     `criticalDamping(CAGE_JOLT_STIFFNESS)`), that rattles the cage's roll
 *     and snaps its stroke bright, then rings back through zero and settles —
 *     the "struck, has mass" character `response.ts`'s own header says a
 *     plain decay cannot give. A hit now knocks the CONTAINER that is actually
 *     holding the dissolve together, instead of moving the whole group on a
 *     beat the kick never touched. Kept deliberately small (see
 *     `CAGE_JOLT_ROLL`) — secondary texture on top of the steady mid-driven
 *     spin, not a replacement primary reaction.
 *   - 2026-09-17: reported as "stutter" in the cage movement — traced to
 *     `cageJolt` being underdamped enough (damping 5 against this
 *     stiffness's critical damping of ~16.7, ratio ~0.30) to ring through
 *     zero several times per hit, so back-to-back kicks overlaid multiple
 *     out-of-phase ringdowns on `rotation.z` at once. `CAGE_JOLT_DAMPING`
 *     raised to 13 (see the constant's own comment) so a hit settles in
 *     roughly one visible overshoot instead of several, and the charge-on-
 *     trigger now floors the spring's current value at 0 before adding the
 *     new impulse so a retrigger during a still-negative undershoot cannot
 *     produce a phase-dependent charge. Separately, and to answer the actual
 *     feature request ("speed up on beat") rather than only the bug: a
 *     smooth `beatSpeedup` multiplier (see `CAGE_BEAT_SPEEDUP` and the
 *     `rotation.y` update below) now swells the steady spin's rate right on
 *     each beat and eases back by the next one, continuous in
 *     `f.beatProgress` so it never steps or snaps. That lives on
 *     `rotation.y` (the monotonic spin), never on `rotation.z` (the kick
 *     spring's roll) — the two are meant to read as separate layers.
 */
const COUNT = 24000
const CYCLE_BEATS = 24
const CAGE = 7.0

/** Per-hit charge into `cageJolt`, scaled by strike strength so a soft kick
 *  barely nudges it and a hard one rings visibly longer off the same spring. */
const CAGE_JOLT_IMPULSE = 1.0
/** Clamp on accumulated charge — a fast kick flurry saturates the rattle
 *  rather than compounding into something that spins off unbounded. */
const CAGE_JOLT_MAX = 1.6
/** Well under `criticalDamping(CAGE_JOLT_STIFFNESS)` (~16.7) on purpose: the
 *  point of this spring is the ring-and-settle read, not a fast clean
 *  arrival — see the "Response identity" note above for why. */
const CAGE_JOLT_STIFFNESS = 70
/**
 * 2026-09-17 stutter fix: was 5 (damping ratio ~0.30 against this
 * stiffness's critical damping of ~16.7). That is underdamped enough to ring
 * through zero three-plus times before settling (~1.6s to decay inside a
 * ~2% band, `8 / damping` at this stiffness) — on a steady kick pattern
 * (roughly every beat or half-beat) the NEXT kick lands mid-ring almost every
 * time, so `rotation.z` was overlaying two or three out-of-phase ringdowns
 * at once. That reads as stutter, not rattle.
 *
 * Raised to 13 (ratio ~0.78, still comfortably underdamped so the "struck,
 * has mass" overshoot survives) which cuts the settle time to ~0.6s — inside
 * a typical beat interval — and the logarithmic decrement at this ratio
 * means the SECOND swing is already under 2% of the first, i.e. one clean
 * overshoot-and-settle per hit instead of a multi-bounce ring. A retrigger
 * now lands on an already-quiet spring almost all the time instead of a
 * still-oscillating one.
 */
const CAGE_JOLT_DAMPING = 13
/** Radians of roll at `cageJolt.value === 1` — small. This is secondary
 *  texture riding on the steady spin, never the scene's primary reaction. */
const CAGE_JOLT_ROLL = 0.05
/** How hard the jolt can brighten the cage stroke on top of the existing
 *  pulse/high drive, at `cageJolt.value === 1`. */
const CAGE_JOLT_FLASH = 0.9

/**
 * "Speed up on beat" — 2026-09-17 addition (user-requested: cage motion
 * should quicken on the beat, smoothly, not stutter). Fractional boost to
 * `rotation.y`'s rate right as a beat lands, easing back to no boost by the
 * next one. This is intentionally on the CONTINUOUS spin (rotation.y), never
 * on the kick spring's roll axis — the two read as distinct layers: a
 * steady quickening pulse on the turn, plus a separate struck rattle on the
 * roll. See the `beatSpeedup` term in the update loop below for the curve.
 */
const CAGE_BEAT_SPEEDUP = 0.9

/** Ease used for both the dissolve envelope and the cycle dwell. */
function smooth(x: number): number {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

export const VERT = /* glsl */ `
  attribute vec3 aScattered;
  attribute vec4 aRand;
  uniform float uDissolve;
  uniform float uTime;
  uniform float uBass;
  uniform float uMid;
  uniform float uPulse;
  uniform float uTransient;
  uniform float uSize;
  uniform float uJitterSeed;
  varying float vT;
  varying vec4 vRand;

  ${CURL_NOISE_GLSL}

  void main() {
    vRand = aRand;

    // Stagger: each particle starts its own transition slightly late, so the
    // dissolve reads as a travelling wave across the surface.
    float t = smoothstep(0.0, 1.0, clamp((uDissolve - aRand.y * 0.32) / 0.68, 0.0, 1.0));
    vT = t;

    vec3 p = mix(position, aScattered, t);

    // One curl tap as an organic correction, enveloped to zero at both ends.
    // Mid content widens the swirl, so the cloud churns harder through dense
    // harmonic passages rather than only responding to the kick.
    float env = sin(t * 3.14159265);
    // 0.2: Dissolve's authored epsilon — a wider sample than Plasma's, giving
    // a softer swirl. Preserved exactly rather than reconciled.
    p += curlNoise(p * 0.45 + uTime * 0.06 + aRand.x, 0.2) * env * (0.26 + uBass * 0.34 + uMid * 0.3);
    // Transient jitter: a per-particle scatter on sharp hits, strongest
    // mid-flight. Gated to a deterministic MINORITY of particles per beat
    // rather than nudging all 24k -- a hash of (particle, beat index) decides
    // participation, the same contract engine/response.ts's gate() documents
    // (same beat of the same track always picks the same subset), just
    // reimplemented here because a vertex shader cannot call into TS. Reads
    // as a spray of debris catching the impulse instead of the whole cloud
    // twitching in lockstep; the boost after the gate keeps the particles
    // that DO fire clearly visible rather than diluted by the smaller count.
    float jHash = fract(sin(dot(vec2(aRand.z, uJitterSeed), vec2(127.1, 311.7))) * 43758.5453);
    float jGate = step(jHash, 0.35);
    p += normalize(p + 0.001) * uTransient * env * 0.22 * (aRand.z - 0.5) * jGate * 1.6;
    p *= 1.0 + uPulse * 0.03;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (0.5 + aRand.w) * (1.0 + uPulse * 0.45)
      * (30.0 / max(1.0, -mv.z));
  }
`

export const FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColForm;
  uniform vec3 uColHot;
  uniform vec3 uColAir;
  uniform float uEnergy;
  uniform float uHigh;
  uniform float uPresence;
  uniform float uTime;
  uniform float uFade;
  varying float vT;
  varying vec4 vRand;

  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float m = smoothstep(0.5, 0.08, length(d));
    if (m < 0.01) discard;

    // Particles glow hottest while actually in flight — the transition is the
    // event, so it is what carries the colour and the light.
    float heat = sin(vT * 3.14159265);
    vec3 col = mix(uColForm, uColHot, heat * 0.85);

    // A sparse subset sparkles with the highs, so hats read on the cloud itself
    // and not just on the cage.
    float tw = step(0.9, fract(vRand.z * 19.0 + uTime * (0.3 + vRand.y)));
    col = mix(col, uColAir, tw * uHigh * 0.7);

    // Low per-particle contribution: 24k additive points over a compact form
    // build up fast, and the cage has to stay readable through the cloud.
    // Presence adds the snare/pluck snap on top of the slower energy term.
    float bright = (0.05 + uEnergy * 0.14 + uPresence * 0.07) * (0.4 + vRand.w)
      * (1.0 + heat * 0.7 + tw * uHigh * 1.6);
    gl_FragColor = vec4(col * bright * m * uFade, 1.0);
  }
`

/**
 * Fixed seed, so the particle field is identical every mount — what makes a
 * recording or screenshot reproducible. Previously reseeded from Math.random().
 */
const SEED = 0xd1550

/**
 * An empty shell with correctly-shaped (zero-filled) attributes and a zero
 * draw range. The area-weighted surface sampling that fills it runs on a
 * worker (see the effect below); allocating these arrays is a memset, while
 * the CDF build plus 24k binary searches it replaces cost milliseconds on the
 * mounting frame.
 */
function buildEmptyGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3))
  geo.setAttribute('aScattered', new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3))
  geo.setAttribute('aRand', new THREE.BufferAttribute(new Float32Array(COUNT * 4), 4))
  geo.setDrawRange(0, 0)
  return geo
}

/**
 * Pull the source surface out as a plain non-indexed triangle soup.
 * `BufferGeometry` is not structured-cloneable, so the worker takes raw typed
 * arrays; this throwaway source is disposed immediately either way.
 */
function extractSurface(): { position: Float32Array; normal: Float32Array } {
  const src = new THREE.TorusKnotGeometry(1.3, 0.42, 180, 24)
  const nonIndexed = src.index ? src.toNonIndexed() : src
  const position = new Float32Array(nonIndexed.getAttribute('position').array)
  const normal = new Float32Array(nonIndexed.getAttribute('normal').array)
  if (nonIndexed !== src) nonIndexed.dispose()
  src.dispose()
  return { position, normal }
}

export function DissolveCageScene() {
  const dissolve = useRef(0)
  /** Slewed `b.mid` — see the cage-spin update below. */
  const midEnv = useRef(0)
  const cycleStart = useRef(-1)
  const cageRef = useRef<THREE.Group>(null)
  /** Underdamped kick spring driving the cage's rattle + flash — see the
   *  "Response identity" note at the top of this file for why. */
  const cageJolt = useRef<SpringState>(spring(0))

  const cageMat = useMemo(
    () =>
      new LineMaterial({
        color: 0x00e5ff,
        linewidth: 1.8,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  )

  const cage = useMemo(() => {
    const src = new THREE.BoxGeometry(CAGE, CAGE, CAGE)
    const geo = new WireframeGeometry2(src)
    src.dispose()
    const wf = new Wireframe(geo, cageMat)
    wf.computeLineDistances()
    wf.frustumCulled = false
    return wf
  }, [cageMat])

  const geometry = useMemo(() => buildEmptyGeometry(), [])
  /** False until the worker's field lands; gates the draw range so the
   *  un-generated (all-at-origin) placeholder never renders as one bright dot. */
  const filled = useRef(false)

  useEffect(() => {
    let cancelled = false
    const { position, normal } = extractSurface()
    void proceduralDispatcher
      .requestDissolve({ position, normal, count: COUNT, cage: CAGE, seed: SEED })
      .then(({ formed, scattered, rand }) => {
        if (cancelled) return
        // Adopt the transferred buffers directly rather than copying.
        geometry.setAttribute('position', new THREE.BufferAttribute(formed, 3))
        geometry.setAttribute('aScattered', new THREE.BufferAttribute(scattered, 3))
        geometry.setAttribute('aRand', new THREE.BufferAttribute(rand, 4))
        filled.current = true
      })
    return () => {
      cancelled = true
    }
  }, [geometry])

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uDissolve: { value: 0 },
          uTime: { value: 0 },
          uBass: { value: 0 },
          uMid: { value: 0 },
          uPresence: { value: 0 },
          uHigh: { value: 0 },
          uPulse: { value: 0 },
          uTransient: { value: 0 },
          uJitterSeed: { value: 0 },
          uEnergy: { value: 0 },
          uSize: { value: 1.9 },
          uFade: { value: 0 },
          uColForm: { value: new THREE.Color('#00e5ff') },
          uColHot: { value: new THREE.Color('#00ffa3') },
          uColAir: { value: new THREE.Color('#7c4dff') },
        },
      }),
    [],
  )

  useDispose(cageMat, cage.geometry, material, geometry)

  useSceneFrame(
    ({ f, dt, b, col, vis, params, state, anim }) => {
      const u = material.uniforms

      geometry.setDrawRange(0, filled.current ? Math.floor(COUNT * state.particleDensity) : 0)

      // Band jobs here: mid widens the swirl and turns the cage, presence snaps the
      // cage stroke, high sparkles the cloud, transient jitters it.
      // Autonomous cycle: assembled → dispersed → assembled over CYCLE_BEATS, so
      // the scene is never static even on a track that never drops. Section
      // changes restart it, which keeps the arc aligned with the music's own form.
      const total = f.beatIndex + f.beatProgress
      if (cycleStart.current < 0) cycleStart.current = total
      if (f.sectionChange) cycleStart.current = total
      const phase = ((total - cycleStart.current) / CYCLE_BEATS) % 1
      // Triangle wave through a smooth ease — dwells at both extremes instead of
      // crossing them at constant speed.
      let target = smooth(1 - Math.abs(1 - 2 * phase))
      if (f.drop) target = 1
      // The director's dissolve primitive can only ever pull the form further
      // APART, never hold it together — it carries visualTension, so a build
      // starts scattering the cloud before the drop lands, on top of whatever the
      // autonomous cycle was already doing. Taking the max rather than adding
      // keeps the cycle's dwell at both extremes intact.
      target = Math.max(target, anim.dissolve)
      // Drops rip it apart fast (rate 9); the autonomous cycle breathes
      // slowly (rate 2.2) -- same two rates as before, but run through
      // slew() instead of the old `Math.min(1, dt * rate)` linear step. That
      // form is a literal teleport once dt * rate >= 1 (a stall past ~111ms
      // mid-drop, ~454ms mid-cycle) -- exactly the frame-rate-dependent snap
      // engine/response.ts's header warns first-order forms are prone to.
      // slew()'s `1 - exp(-dt * rate)` is asymptotic at any dt and cannot
      // produce that jump; riseRate === fallRate here so it is exactly the
      // old exponential's intent, just correct under a stalled frame.
      //
      // Considered and declined for this spot: an underdamped SPRING for a
      // hit-then-overshoot instead of an eased arrival. uDissolve only acts
      // through the per-particle clamp in the vertex shader above, so by the
      // time a drop lands most of the 24k particles are already pinned at
      // t = 1 with no room to render an overshoot -- only the last sliver of
      // the stagger window (aRand.y near 1) could show it, as a one-frame
      // flicker invisible against the rest of the cloud. What this already
      // has -- a fast attack, then a HOLD at full scatter for the whole
      // ~0.6s `f.drop` window because target stays pinned at 1 throughout,
      // then a slow release once it lifts -- already reads as a struck
      // impact rather than an instant jump; the linear-step numerics were
      // the only real bug, and that is what this change fixes.
      dissolve.current = slew(dissolve.current, target, dt, f.drop ? 9 : 2.2, f.drop ? 9 : 2.2)

      // Kick charges the cage's rattle; strength scales the charge so a soft
      // hit barely nudges it and a hard one rings visibly longer off the same
      // spring. Stepped toward 0 every frame regardless of whether a hit just
      // landed — that is what lets it ring PAST rest and settle instead of
      // sliding straight back down. See CAGE_JOLT_STIFFNESS/DAMPING above and
      // the "Response identity" note at the top of the file for why.
      if (f.percussion.kick.trigger) {
        // `Math.max(0, ...)` before adding the new charge — 2026-09-17 fix,
        // paired with the CAGE_JOLT_DAMPING raise above. Without it, a
        // retrigger landing while the spring is still in its negative
        // undershoot (a real possibility even at the tamer damping, on a
        // fast kick pattern) added the new impulse ON TOP OF a negative
        // value, so the resulting charge — and thus how far the NEXT
        // overshoot reaches — depended on the retrigger's random phase
        // against the still-ringing spring instead of the strike strength
        // alone. Flooring at 0 first means every hit charges from a clean
        // baseline, so equal-strength kicks always produce the same-sized
        // rattle regardless of timing.
        cageJolt.current.value = Math.min(
          CAGE_JOLT_MAX,
          Math.max(0, cageJolt.current.value) + CAGE_JOLT_IMPULSE * f.percussion.kick.strength,
        )
      }
      springStep(cageJolt.current, 0, dt, CAGE_JOLT_STIFFNESS, CAGE_JOLT_DAMPING)

      // `resolution` is set by the `Wireframe` itself on every draw — see
      // WireframeHeroScene's note on its own identical cage.
      // Overdriven colour rather than low opacity — LineMaterial's alpha caps at
      // 1, so brightness has to come from the colour to read as hot phosphor
      // (same reasoning as WireframeHeroScene). The cage stays below the particle
      // cloud's brightness so the dissolving form remains the subject.
      // `max(0, jolt)` because the underdamped spring rings negative on its
      // way to rest — clamped here so that reads as the flash briefly
      // dipping rather than the colour inverting.
      cageMat.color
        .copy(col.a)
        .multiplyScalar(0.75 + b.pulse * 0.7 + b.high * 0.5 + Math.max(0, cageJolt.current.value) * CAGE_JOLT_FLASH)
      cageMat.opacity = Math.min(1, vis * 0.85)
      // Presence owns the cage's stroke weight — the frame sharpens on snares.
      cageMat.linewidth = 1.6 + b.presence * 1.6 + b.pulse * 0.6

      if (cageRef.current) {
        // Slewed rather than raw `b.mid` — found in a systematic audit
        // (2026-09-11) for the same "raw band drives an accumulating rate"
        // pattern reported live and fixed twice elsewhere this session
        // (GyroidFluxScene, JavaZoneLatticeScene). This file already uses
        // `slew()` for `dissolve` above; same primitive, same file.
        midEnv.current = slew(midEnv.current, b.mid, dt, 3, 3)
        // "Speed up on beat" — 2026-09-17 addition, user-requested. A smooth,
        // continuous multiplier on the spin RATE that peaks exactly on the
        // beat crossing and eases back to 1x by the next one, so the turn
        // visibly quickens right on the beat instead of holding one constant
        // speed. `f.beatProgress` runs 0 (just landed on a beat) to 1
        // (about to land on the next); squaring `(1 - beatProgress)` gives a
        // curve that starts at its peak and eases OUT smoothly — no discrete
        // jump on the beat and no snap back afterward, unlike gating on
        // `f.beat` (true for one frame) directly. This is deliberately a
        // multiplier on the already-smooth, monotonically-accumulating
        // rotation.y rate (never on rotation.z, the kick spring's roll) —
        // it reads as a distinct "steady turn quickens with the tempo" layer
        // sitting alongside, not competing with, the struck rattle below.
        const beatSpeedup = 1 + CAGE_BEAT_SPEEDUP * Math.pow(1 - f.beatProgress, 2)
        cageRef.current.rotation.y += dt * (0.06 + midEnv.current * 0.14) * params.speed * beatSpeedup
        // Replaces the old tempo-locked sway (`rotation.x = anim.oscillate *
        // 0.12`) — see the "Response identity" note at the top of the file.
        // That was a generic sine nodding the whole cage regardless of what
        // the track did, and being the one large-amplitude motion here it
        // read as the picture ("bounces up and down") instead of the
        // dissolve mechanic reading as the picture. Roll now rattles on the
        // kick's own spring instead: it rings through zero and settles,
        // which is a struck frame, not a metronome. Small on purpose — this
        // is secondary texture riding the steady spin, not a new primary
        // reaction.
        cageRef.current.rotation.z = cageJolt.current.value * CAGE_JOLT_ROLL
      }

      u.uDissolve.value = dissolve.current
      u.uTime.value = f.time
      u.uBass.value = b.bass
      u.uMid.value = b.mid
      u.uPresence.value = b.presence
      u.uHigh.value = b.high
      u.uPulse.value = b.pulse
      u.uTransient.value = b.transient
      // Integer per-beat seed for the jitter gate's GLSL hash -- constant
      // across a whole beat, distinct the next one, per gate()'s own
      // recommendation to key a probability off beat/bar index for a stable,
      // reproducible pattern rather than a per-frame reroll.
      u.uJitterSeed.value = f.beatIndex
      u.uEnergy.value = b.energy
      u.uFade.value = vis
      u.uColForm.value.copy(col.a)
      u.uColHot.value.copy(col.c)
      u.uColAir.value.copy(col.b)
    },
    { visCeiling: 1.3, visFloor: 0.55 },
  )

  return (
    <group>
      <group ref={cageRef}>
        <primitive object={cage} />
      </group>
      <points geometry={geometry} frustumCulled={false}>
        <primitive object={material} attach="material" />
      </points>
    </group>
  )
}
