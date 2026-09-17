import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { applyToUniforms } from '../engine/AnimationDirector'
import { slew } from '../engine/response'
import { CURL_NOISE_GLSL } from '../engine/shaderLib'
import { proceduralDispatcher } from '../engine/streaming/proceduralDispatcher'
import { useSceneFrame } from '../engine/sceneFrame'
import { useDispose } from '../engine/useDispose'

/**
 * Plasma Filament — one hot core radiating shard filaments into black.
 *
 * Built on ParticleFlowScene's closed-form curl-noise advection (stateless: the
 * position is a pure function of seed + time, so there are no ping-pong render
 * targets to allocate, sync, or leak). Three deliberate departures from that
 * scene, all of which are what turn "a cloud of dots" into a subject:
 *
 *  - Core-weighted radial seeding, so density itself builds the hot centre
 *    instead of a brightness hack.
 *  - Screen-space streak orientation: each sprite is elongated along the local
 *    curl direction, which is already computed by the advection loop. Filaments
 *    for free, no extra field evaluations.
 *  - Radial colour ramp, hot accent at the core easing out to the cool primary.
 *
 * Exposure is a hard constraint, not a taste call (docs/09_Rendering_Engine.md): only the
 * core is allowed near full brightness. Per-particle contribution stays tiny so
 * the periphery accumulates to a fraction of 1.0 and the frame reads as dead
 * black with one hot subject — never an additive haze that would flatten any
 * future grade pass.
 *
 * ## 2026-09-16 rework: glow soup -> legible field
 *
 * User complaint, verbatim: too many overlapping/too-bright filaments with wide
 * additive glow blurred everything into a formless bright mass — "glow soup" —
 * with a suggestion to try dots instead of dashes. Three changes, all load-
 * bearing (this is not a single-number tweak):
 *
 *  1. `P.density` (new Scene Contract param, see scenes/index.ts) now actually
 *     gates how much of the 70k field is drawn, on top of the existing
 *     quality/role cuts — previously nothing but those cuts existed, so the
 *     field defaulted to ~100% of COUNT and every mount was maximally dense.
 *     The new mapping (`densityFraction` below) tops out well under 100% even
 *     at the dial's max, so "glow soup" is not reachable by turning one knob
 *     back up.
 *  2. The per-particle alpha falloff (`uGlowWidth`) is pulled in hard from the
 *     old hard-coded 0.5 — that width, at 70k mostly-overlapping sprites under
 *     additive blending, is exactly what reads as haze instead of individual
 *     filaments. `P.contrast` now owns this width; even its softest setting is
 *     tighter than the old constant.
 *  3. `P.shape` sweeps the per-particle silhouette from dash (elongated
 *     streak, the old fixed look) to dot (near-isotropic), defaulted
 *     dot-leaning (0.6) per the request. This is a sweep rather than an
 *     outright replacement because the streak orientation is genuinely useful
 *     at low mid content / low shape values — the dial keeps that available.
 *
 * ## Band routing
 *
 *   bass -> curl-field advection step (the filaments whip harder on heavy low end)
 *   mid  -> fragment-shader stretch (sustained chords draw the field into strands,
 *           scaled down toward the dot end of `P.shape` so a "dots" mount does
 *           not grow dash-like the moment mids come in)
 *   onKick/pulse/drop -> a single BURST-AND-SETTLE scalar (`uBurst`), not a
 *             symmetric pulse. `slew()` (engine/response.ts) gives it a fast
 *             attack and a slow, gravity-like release, so a hit reads as one
 *             explosion with mass behind it rather than the roster's
 *             ubiquitous `exp(-dt*k)` thud that could be timed identically on
 *             the way up and down. It drives the radial expansion and, in
 *             place of the old flat pulse term, point SIZE.
 *   onKick (gated) -> a deterministic ~15% of the 70k particles (hashed off
 *             `aRand`, stable every frame since the field itself is fixed-
 *             seed) ride the same burst harder AND read further out on the
 *             radial colour ramp while it is live. `gate()`'s CPU-side
 *             probability check has no per-particle GPU equivalent to call
 *             into — running it 70k times a frame on the CPU is exactly the
 *             per-particle cost this scene cannot afford — so this re-derives
 *             the identical "hashed value < probability" test directly in the
 *             shader, off the per-particle seed the field already carries.
 *             The result is grain: the burst visibly has texture within the
 *             particle field instead of reading as one uniform blob
 *             expanding, and — unlike the roster's existing per-element
 *             examples, which are spatial/positional (a stagger across a
 *             mesh) — this differentiates a random SUBSET of one
 *             undifferentiated field.
 *   presence -> shard flare (unchanged)
 *   highs   -> ionisation flicker (unchanged)
 *   onKick/pulse/drop -> also widens `uGlowWidth` by a small, capped amount, so
 *             a hit gets a momentary flare on top of the burst's size/expansion
 *             response instead of the glow width being a purely static
 *             art-direction knob. Capped low enough that even a hit under the
 *             loosest `P.contrast` setting cannot reopen the old soup.
 *
 * None of the above touches the brightness term directly — burst and its
 * gated grain are expansion, size, colour-ramp position, and (new) glow
 * width; steady-state brightness stays driven by energy/coreBoost/presence/
 * highs as before, tightened slightly (see FRAG) now that density is no
 * longer doing all the exposure work by default.
 */
const COUNT = 70000
const SPREAD = 9.0

export const VERT = /* glsl */ `
  attribute vec4 aRand;
  uniform float uFlow;
  uniform float uBass;
  uniform float uEnergy;
  uniform float uBurst;
  uniform float uAnimExplode;
  uniform float uSize;
  // Dash (0) <-> dot (1) — see the file-level 2026-09-16 rework doc. Only
  // affects footprint here; the actual silhouette is a fragment-shader mask.
  uniform float uShape;
  varying float vRadius;
  varying vec2 vStreak;
  varying vec4 vRand;
  varying float vBurstGate;

  ${CURL_NOISE_GLSL}

  void main() {
    vRand = aRand;
    vec3 fp = position;

    // Advect through the scrolling curl field. Step scales with bass so the
    // filaments stretch and whip on heavy low end.
    float step = 0.26 + uBass * 0.26;
    vec3 dir = vec3(0.0, 1.0, 0.0);
    for (int i = 0; i < 4; i++) {
      // 0.15: Plasma's authored central-difference epsilon, unchanged.
      dir = curlNoise(fp * 0.22 + vec3(0.0, 0.0, uFlow * 0.14) + aRand.x, 0.15);
      fp += dir * step;
    }

    // Burst-and-settle: uBurst is a single JS-side scalar (asymmetric slew —
    // see the file-level Band routing doc) that snaps up fast on a hit and
    // settles slowly back down like something falling under gravity, so the
    // explosion reads as ONE event with mass rather than a symmetric pulse.
    // Explode is the separate slow counterpart: it carries the director's
    // visualTension, so the field visibly strains apart through a build —
    // while the music there may still be quiet and no band envelope moving.
    //
    // A deterministic ~15% subset of particles rides the burst harder — the
    // grain that keeps 70k particles moving together from reading as one
    // uniform blob. Hashed off aRand (stable every frame, the field is
    // fixed-seed) rather than an index, so no extra attribute is needed.
    float burstGateSeed = fract(aRand.x * 13.1 + aRand.z * 7.3);
    float burstGate = burstGateSeed < 0.15 ? 1.0 : 0.0;
    vBurstGate = burstGate;

    fp *= 1.0 + uBurst * 0.13 + uAnimExplode * 0.18 + burstGate * uBurst * 0.35;
    vRadius = length(fp);

    vec4 mv = modelViewMatrix * vec4(fp, 1.0);
    vec4 clip = projectionMatrix * mv;

    // Project the local flow direction to screen space so the fragment shader
    // can stretch the sprite ALONG the streamline. This is the filament look —
    // and dir is a byproduct of the loop above, so it costs one extra
    // transform rather than another field evaluation.
    vec4 clipB = projectionMatrix * (modelViewMatrix * vec4(fp + normalize(dir) * 0.5, 1.0));
    vec2 a = clip.xy / max(1e-4, clip.w);
    vec2 b = clipB.xy / max(1e-4, clipB.w);
    vec2 delta = b - a;
    vStreak = dot(delta, delta) > 1e-9 ? normalize(delta) : vec2(1.0, 0.0);

    gl_Position = clip;
    // Size answers the burst now, not a flat beat pulse; the gated grain
    // swells further still, same as the radial expansion above. Dots pull
    // their footprint in a little further than dashes: a dash's length comes
    // from the fragment-shader stretch, so its point sprite has to stay big
    // enough to contain that stretch, but a dot's whole silhouette lives in
    // this footprint — a smaller one is what keeps it reading as a point
    // instead of a soft ball.
    gl_PointSize = uSize * (0.45 + aRand.w) * (1.0 + uBurst * 0.5 + uEnergy * 0.35 + burstGate * uBurst * 0.4)
      * mix(1.0, 0.8, uShape)
      * (34.0 / max(1.0, -mv.z));
  }
`

export const FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColCore;
  uniform vec3 uColMid;
  uniform vec3 uColEdge;
  uniform float uEnergy;
  uniform float uMid;
  uniform float uPresence;
  uniform float uHigh;
  uniform float uFade;
  uniform float uSpread;
  uniform float uBurst;
  // Dash (0) <-> dot (1), see the file-level 2026-09-16 rework doc.
  uniform float uShape;
  // Alpha falloff width for the soft population, JS-resolved from
  // P.contrast plus a small burst flare — see the update() callback below.
  // Replaces what used to be a hard-coded 0.5, which at 70k overlapping
  // additive sprites was the single biggest contributor to "glow soup".
  uniform float uGlowWidth;
  varying float vRadius;
  varying vec2 vStreak;
  varying vec4 vRand;
  varying float vBurstGate;

  void main() {
    vec2 d = gl_PointCoord - 0.5;
    // Rotate into the streak frame: x runs along the flow, y across it.
    vec2 ax = vStreak;
    vec2 ay = vec2(-ax.y, ax.x);
    vec2 q = vec2(dot(d, ax), dot(d, ay));

    // Most particles are soft filaments (dash<->dot per uShape); a minority
    // are hard-edged shard fragments, which is what keeps the field from
    // reading as fog. Mid content STRETCHES the soft population (smaller
    // along-flow divisor = longer streak), so sustained chords visibly draw
    // the field into strands while a sparse kick-only passage keeps it
    // pointillist — but that stretch is scaled down toward the dot end of
    // uShape, so a "dots" mount does not grow dash-like the moment mids
    // come in (a dot that stretches on every chord is just a dash again).
    float dashStretch = 0.72 - uMid * (0.34 * (1.0 - uShape));
    float stretch = mix(dashStretch, 0.92, uShape);
    // y-axis divisor: dashes cut hard across the flow direction (thin, long
    // streak); dots relax toward round. Same uShape sweep.
    float yDivisor = mix(2.5, 1.35, uShape);
    float soft = smoothstep(uGlowWidth, 0.0, length(vec2(q.x * stretch, q.y * yDivisor)));
    float shardYDivisor = mix(2.4, 1.5, uShape);
    float shardMask = 1.0 - step(0.3, max(abs(q.x) * 0.7, abs(q.y) * shardYDivisor));
    float isShard = step(0.84, vRand.y);
    float m = mix(soft, shardMask, isShard);
    if (m < 0.01) discard;

    // Radial ramp: hot accent at the core, cool primary at the periphery. The
    // gated ~15% grain reads a step further out on the ramp while a burst is
    // live -- a colour nudge, not a brightness one, so the burst's texture
    // shows up as flecks of the edge hue seeded through the core instead of
    // an uneven glow.
    float r = clamp(vRadius / uSpread, 0.0, 1.0);
    float rampR = clamp(r + vBurstGate * uBurst * 0.22, 0.0, 1.0);
    vec3 col = mix(uColCore, uColMid, smoothstep(0.0, 0.42, rampR));
    col = mix(col, uColEdge, smoothstep(0.4, 1.0, rampR));

    // A sparse subset flickers with the highs — reads as ionisation.
    float tw = step(0.93, fract(vRand.z * 23.0 + vRadius * 0.7));
    col = mix(col, uColEdge, tw * uHigh * 0.6);

    // Exposure discipline, and the numbers matter. The base sits at roughly the
    // per-particle contribution ParticleFlowScene already runs in production at
    // this same 70k count, so total accumulation is a known quantity rather
    // than a guess. The core boost is deliberately modest on top of that,
    // because the core-weighted SEEDING is already concentrating density there
    // — brightness and density must not both be stacked, or the core clips and
    // the frame becomes the additive haze docs/09_Rendering_Engine.md warns
    // about. Tightened further in the 2026-09-16 rework (0.4 -> 0.3 radius,
    // 1.6 -> 1.2 multiplier): density is no longer pinned near 100% by
    // default, so this can no longer lean on "most of the count never draws
    // near the core anyway" the way the original numbers implicitly did.
    float coreBoost = 1.0 - smoothstep(0.0, 0.3, r);
    // Presence lights the SHARDS specifically, so snares and plucks make the
    // hard-edged fragments flare while the soft filaments stay put — two
    // populations responding to two different parts of the mix.
    float bright = (0.045 + uEnergy * 0.16) * (0.32 + vRand.w)
      * (1.0 + coreBoost * 1.2 + tw * uHigh + isShard * uPresence * 1.4);

    gl_FragColor = vec4(col * bright * m * uFade, 1.0);
  }
`

/**
 * Fixed seed, so the field is identical every mount. Previously each mount
 * reseeded from `Math.random()`; a stable seed is what makes a recording or
 * screenshot reproducible.
 */
const SEED = 0x51a5

/**
 * An empty shell with correctly-shaped (zero-filled) attributes and a zero
 * draw range. The 70k-particle field itself is generated on a worker and
 * swapped in when it arrives — see the effect below. Allocating the arrays
 * here is a memset, microseconds; it is the per-particle rejection-sampling
 * loop that used to cost milliseconds on the mounting frame.
 */
function buildEmptyGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3))
  geo.setAttribute('aRand', new THREE.BufferAttribute(new Float32Array(COUNT * 4), 4))
  geo.setDrawRange(0, 0)
  return geo
}

export function PlasmaFilamentScene() {
  const flow = useRef(0)
  /** Slewed `f.energy` — see the flow-clock update below. */
  const energyEnv = useRef(0)
  /** Burst-and-settle scalar (asymmetric slew, see the file-level Band
   *  routing doc) — a single JS-side float, not per-particle work. */
  const burst = useRef(0)
  const geometry = useMemo(() => buildEmptyGeometry(), [])
  /** False until the worker's field has been swapped in; gates the draw range
   *  so the un-generated (all-at-origin) placeholder never renders as one
   *  blindingly bright dot at the centre of the frame. */
  const filled = useRef(false)

  useEffect(() => {
    let cancelled = false
    void proceduralDispatcher
      .requestPlasma({ count: COUNT, spread: SPREAD, seed: SEED })
      .then(({ positions, rand }) => {
        if (cancelled) return
        // Adopt the transferred buffers directly rather than copying into the
        // placeholders — the worker's arrays arrive owned by this thread.
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
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
          uFlow: { value: 0 },
          uBass: { value: 0 },
          uMid: { value: 0 },
          uPresence: { value: 0 },
          uHigh: { value: 0 },
          uEnergy: { value: 0 },
          uBurst: { value: 0 },
          uAnimExplode: { value: 0 },
          // Base point size trimmed from the pre-rework 2.1 — smaller sprites
          // overlap less at a given density, which is half of what un-soups
          // the field. `P.fill` scales this further at update time.
          uSize: { value: 1.7 },
          uShape: { value: 0.6 },
          uGlowWidth: { value: 0.35 },
          uFade: { value: 0 },
          uSpread: { value: SPREAD },
          // Non-black defaults so nothing is invisible before the first frame.
          uColCore: { value: new THREE.Color('#00ffa3') },
          uColMid: { value: new THREE.Color('#00e5ff') },
          uColEdge: { value: new THREE.Color('#7c4dff') },
        },
      }),
    [],
  )

  useDispose(material, geometry)

  useSceneFrame(
    ({ f, dt, b, col, vis, params, p: P, state, role }) => {
      const u = material.uniforms

      // The particle budget, read from the performance state rather than the
      // quality governor directly — the governor is only its current author, and
      // going through the seam is what lets a director thin the field for
      // creative reasons too. Seeds are generated in random order, so the first
      // N are already an unbiased subset of the whole field. Draws nothing at
      // all until the worker's field has landed.
      //
      // `roleScalable` (F89): as an accent or overlay this is not the subject,
      // so it is cut further, to ROLE_SCALED_FRACTION (slotBudget.ts) — declared
      // in scenes/index.ts and honoured here, not just claimed. `setDrawRange`
      // is a genuine cost cut, not a cosmetic one: fewer particles is fewer
      // vertex-shader invocations (each one runs the 4-step curl-noise
      // advection above) and fewer sprites for the fragment shader/rasterizer
      // to touch, unlike a uniform that only changes how something looks.
      // Seeds stay an unbiased random subset either way, so thinning further
      // here costs density, not a different-looking field.
      //
      // `P.density` (Scene Contract, added in the 2026-09-16 glow-soup rework)
      // now sits underneath both of the above cuts rather than the field
      // defaulting to ~100% of COUNT with nothing but quality/role thinning
      // it. Linear, not `drastic()`: this is a fraction of a fixed-size
      // buffer, not a magnitude that can overshoot 1x. Range 0.18..0.73 so
      // even the dial's max stays well short of the old "always full field"
      // baseline, and the default (0.5) lands at ~45%.
      const densityFraction = 0.18 + P.density * 0.55
      const roleDensity = role === 'primary' ? 1 : 0.6
      geometry.setDrawRange(
        0,
        filled.current
          ? Math.floor(COUNT * state.particleDensity * roleDensity * densityFraction)
          : 0,
      )

      // `P.fill` ("how much of the frame it occupies") scales point size
      // directly. `P.shape` (dash<->dot) additionally trims the vertex
      // shader's own footprint for dots — see VERT.
      u.uSize.value = 1.7 * (0.6 + P.fill * 0.8)
      u.uShape.value = P.shape

      // `f.energy` slewed before it multiplies in — found in a systematic
      // audit (2026-09-11) for the "raw band drives an accumulating rate"
      // pattern reported live and fixed twice elsewhere this session
      // (GyroidFluxScene, JavaZoneLatticeScene); the reactive swing here
      // (0.9 against a 0.22 base — over 400%) is the largest of any
      // continuous term in this file. `f.drop` stays a raw boolean step
      // deliberately — a drop is meant to read as instantaneous, not eased.
      energyEnv.current = slew(energyEnv.current, f.energy, dt, 3, 3)
      flow.current += dt * (0.22 + energyEnv.current * 0.9 + (f.drop ? 1.3 : 0)) * params.speed

      u.uFlow.value = flow.current
      u.uBass.value = b.bass
      u.uMid.value = b.mid
      u.uPresence.value = b.presence
      u.uHigh.value = b.high
      u.uEnergy.value = b.energy

      // Burst-and-settle: fast attack (rise) so a hit is felt immediately,
      // slow release (fall) so it settles like something under gravity
      // instead of an instant snap-back — see slew()'s own doc for why this
      // asymmetry is what makes a hit read as a physical event. Target is the
      // sharpest available "something just happened" signal; drop pins it to
      // 1 outright since a drop is exactly the moment this scene should read
      // as detonating.
      const burstTarget = Math.max(b.pulse, b.transient, f.drop ? 1 : 0)
      burst.current = slew(burst.current, burstTarget, dt, 46, 3.2)
      u.uBurst.value = burst.current

      // `P.contrast` owns the alpha falloff width — see FRAG for why this
      // replaced a hard-coded 0.5. Range 0.24 (hard dot, contrast=1) .. 0.46
      // (softest, contrast=0) — both ends tighter than the old constant, so
      // there is no dial position that reopens the soup. A live hit widens it
      // a little further still (the burst's own flare), capped at +0.06 for
      // the same reason.
      u.uGlowWidth.value = 0.46 - P.contrast * 0.22 + burst.current * 0.06

      applyToUniforms(u)
      u.uFade.value = vis
      // Accent burns at the core, primary through the body, secondary at the rim.
      u.uColCore.value.copy(col.c)
      u.uColMid.value.copy(col.a)
      u.uColEdge.value.copy(col.b)
    },
    // No readability floor: this scene is a particle field, not line art, so it
    // is allowed to fall away entirely in the quiet.
    { visCeiling: 1, visFloor: 0 },
  )

  return (
    <points geometry={geometry} frustumCulled={false}>
      <primitive object={material} attach="material" />
    </points>
  )
}
