import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { applyToUniforms } from '../engine/AnimationDirector'
import { impulseClock, sinceImpulse, type ImpulseClock } from '../engine/response'
import { useSceneFrame } from '../engine/sceneFrame'
import { TRAVELLING_PULSE_GLSL } from '../engine/shaderLib'
import { proceduralDispatcher } from '../engine/streaming/proceduralDispatcher'
import { useDispose } from '../engine/useDispose'

const COUNT = 60000
const RADIUS = 4.5
/** Fixed seed: the field is identical every mount, so recordings and
 *  screenshots of this scene are reproducible. */
const SEED = 0x5ca77e

/**
 * ## Band routing
 *
 *   bass + transient -> per-point displacement along the point's own normal
 *                        (unchanged ambient "breathing" of the shell)
 *   onKick -> a SHOCKWAVE, not a uniform explode. The old `uPulse`/`uEnergy`
 *             expansion moved every one of the 60k points outward together,
 *             on the same frame, regardless of where they sat -- indistinguishable
 *             from a brightness pop wearing a size hat. `impulseClock()` /
 *             `sinceImpulse()` (engine/response.ts) time the kick on the JS
 *             side; `uSinceKick` carries it to the GPU and `travellingPulse()`
 *             (the same function `web`/`travelling` use, engine/shaderLib.ts)
 *             turns "seconds since the kick" plus each point's OWN static
 *             radial distance from the scan origin into a 0..1 arrival gate.
 *             The result is a literal wavefront expanding through the 3D
 *             volume: points near the origin feel it first, the outer shell
 *             feels it a fraction of a second later, and a point the front
 *             hasn't reached yet just keeps breathing on bass/transient alone.
 *             This is still "propagation" as a technique but the outcome is a
 *             different kind of picture from `web` (a 2D hex lattice) or
 *             `travelling` (stacked 2D planes) -- a point cloud rippling
 *             outward in three dimensions, not a re-skin of either.
 *             The wavefront drives three things, two of them off brightness:
 *               - normal displacement (added to, not replacing, the ambient term)
 *               - point SIZE (replaces the old flat `uPulse` size term)
 *               - point-mask SHARPNESS in the fragment shader -- a struck
 *                 point reads as a tighter, higher-confidence LIDAR return,
 *                 which is what a real strong reflection actually looks like
 *             The frag shader's brightness term keeps a small, transient
 *             contribution from the wave for legibility, but it is the least
 *             of the four channels the hit now drives.
 *
 *   b.energy -> also nudges the vertical scanline's OWN sweep rate (`uTime`,
 *             the JS-side `timeRef` accumulator below). Flagged in review as
 *             the one remaining sub-effect in this scene with no audio term
 *             at all: everything above already answers bass/transient/kick/
 *             high, but the scanline swept at a flat `params.speed`-scaled
 *             rate regardless of what the track was doing. `1 + b.energy *
 *             0.6` reduces to the old behaviour exactly at b.energy == 0, so
 *             a quiet passage sweeps at the same rate it always did; a loud
 *             one sweeps up to 1.6x faster.
 */

export const PCD_VERT = /* glsl */ `
  attribute vec4 aRand;
  uniform float uTime;
  uniform float uBass;
  uniform float uTransient;
  uniform float uEnergy;
  uniform float uSize;
  uniform float uSinceKick;
  uniform float uKickAmp;
  varying float vScanProgress;
  varying float vRadius;
  varying float vWave;
  varying vec4 vRand;

  ${TRAVELLING_PULSE_GLSL}

  void main() {
    vRand = aRand;
    vec3 fp = position;

    // Static radial distance from the scan origin, BEFORE any displacement --
    // the wavefront times off where a point actually sits in the field, not
    // off where a previous frame's shock already pushed it.
    float r0 = length(fp);
    vec3 dir = r0 > 1e-5 ? fp / r0 : vec3(0.0, 1.0, 0.0);

    // Shockwave: travellingPulse() turns "seconds since the kick" and this
    // point's own radius into a 0..1 arrival gate, so the wave genuinely
    // crosses the shell outward from the scan origin rather than lighting up
    // everywhere on the same frame. See the file-level Band routing doc.
    const float waveSpeed = 3.4; // spans (of RADIUS) per second
    const float waveDecay = 5.0; // trailing falloff behind the front
    float wave = travellingPulse(uSinceKick, r0 / ${RADIUS.toFixed(1)}, waveSpeed, waveDecay) * uKickAmp;
    vWave = wave;

    // Bass & transient still breathe the field along its own normals; the
    // wavefront ADDS to that per point rather than replacing it, so a point
    // the front hasn't reached yet only carries the ambient breathing.
    float displacement = (uBass * 0.35 + uTransient * 0.45) * (0.6 + aRand.x * 0.8)
      + wave * (0.9 + aRand.x * 0.6);
    fp += dir * displacement;

    // Ambient volumetric breathing only. The old flat "explode everything at
    // once" multiply on uPulse/uEnergy is gone -- a kick's punch now lives in
    // the shockwave above, which depends on WHERE a point is, not just WHEN
    // the kick landed.
    fp *= 1.0 + uEnergy * 0.05;

    vRadius = length(fp);

    // Vertical scanline effect that travels through the cloud
    float scanHeight = mod(uTime * 2.5, ${RADIUS.toFixed(1)} * 2.5) - ${RADIUS.toFixed(1)} * 1.25;
    vScanProgress = smoothstep(1.2, 0.0, abs(fp.y - scanHeight));

    vec4 mv = modelViewMatrix * vec4(fp, 1.0);
    gl_Position = projectionMatrix * mv;

    // PCD style: sharp, crisp points with depth attenuation. Size answers the
    // shockwave now, not a flat beat pulse -- points the front has just
    // crossed visibly swell.
    gl_PointSize = uSize * (0.6 + aRand.w * 0.8) * (1.0 + vScanProgress * 0.6 + wave * 0.5)
      * (26.0 / max(1.0, -mv.z));
  }
`

export const PCD_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColCore;
  uniform vec3 uColMid;
  uniform vec3 uColEdge;
  uniform float uHigh;
  uniform float uEnergy;
  uniform float uFade;
  varying float vScanProgress;
  varying float vRadius;
  varying float vWave;
  varying vec4 vRand;

  void main() {
    // Sharp circular point mask for authentic LIDAR/PCD point aesthetic. A
    // point mid-shockwave reads as a tighter, higher-confidence return -- a
    // real strong reflection sharpens exactly like this -- rather than simply
    // glowing brighter.
    vec2 coord = gl_PointCoord - 0.5;
    float maskR = mix(0.25, 0.16, clamp(vWave, 0.0, 1.0));
    if (dot(coord, coord) > maskR) discard;

    // Depth/Radius color ramp: core accent -> mid primary -> edge cool
    float r = clamp(vRadius / ${RADIUS.toFixed(1)}, 0.0, 1.0);
    vec3 col = mix(uColCore, uColMid, smoothstep(0.0, 0.45, r));
    col = mix(col, uColEdge, smoothstep(0.4, 1.0, r));

    // Traveling scanline brightens and shifts color toward core accent
    col = mix(col, uColCore, vScanProgress * 0.55);

    // High frequencies trigger sparkle across random points
    float sparkle = step(0.92, fract(vRand.z * 31.0 + vRadius * 1.3));
    col = mix(col, uColEdge, sparkle * uHigh * 0.8);

    // Exposure discipline, and the numbers are measured, not guessed. 60k
    // additive points over a shell fill far more of the frame than Plasma's
    // core-weighted field does, so the per-particle contribution has to be
    // LOWER than Plasma's, not equal to it — at the original 0.08 base this
    // scene measured 32.7% of frame lit with a mean luma of 32, i.e. exactly
    // the additive haze docs/09_Rendering_Engine.md warns about (vs Plasma's
    // 15.9% / 8.5 at the same camera and audio state).
    //
    // depthFade is what buys most of it back: the shell's far side dims toward
    // black instead of stacking onto the near side. It also happens to read as
    // real depth falloff, which is what a LIDAR return actually does.
    float depthFade = 1.0 - smoothstep(0.3, 1.0, r) * 0.92;
    // vWave's contribution here is deliberately the smallest of its three
    // effects (mask sharpness and point size above are the other two) and is
    // transient + localized to whichever points the front currently sits
    // on -- it does not shift the steady-state exposure profile measured
    // above, since most of the 60k points are not on the wavefront on any
    // given frame.
    float bright = depthFade * (0.04 + uEnergy * 0.14) * (0.5 + vRand.w * 0.5)
      * (1.0 + vScanProgress * 1.2 + sparkle * uHigh * 1.4 + vWave * 0.5);

    gl_FragColor = vec4(col * bright * uFade, 1.0);
  }
`

/**
 * Empty shell, populated from the procedural worker once it lands.
 *
 * Seeding 60k points is ~the same order of work as Plasma's 70k, and building
 * it synchronously in `useMemo` would block the frame that mounts this scene —
 * the exact main-thread stall the worker path exists to avoid. Draw range
 * starts at 0 so the un-generated field never renders.
 */
function buildEmptyGeometry(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3))
    geo.setAttribute('aRand', new THREE.BufferAttribute(new Float32Array(4), 4))
    geo.setDrawRange(0, 0)
    return geo
}

export function PointCloudScanScene() {
    const timeRef = useRef(0)
    /** JS half of the shockwave: when the last kick fired, in engine seconds. */
    const kickClock = useRef<ImpulseClock>(impulseClock())
    /** Strength of that kick, latched at the moment it fires (see `update`
     *  below) so the wave it launches doesn't fade with the kick's own
     *  envelope while it is still crossing the shell. */
    const hitAmp = useRef(0)
    const geometry = useMemo(() => buildEmptyGeometry(), [])
    /** False until the worker's field has been swapped in — gates the draw
     *  range so the placeholder (all points at the origin) never renders as one
     *  blinding dot at frame centre. */
    const filled = useRef(false)

    useEffect(() => {
        let cancelled = false
        void proceduralDispatcher
            .requestPointCloud({ count: COUNT, radius: RADIUS, seed: SEED })
            .then(({ positions, rand }) => {
                if (cancelled) return
                // Adopt the transferred buffers directly — they arrive owned by
                // this thread, so there is nothing to copy.
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
                vertexShader: PCD_VERT,
                fragmentShader: PCD_FRAG,
                transparent: true,
                depthWrite: false,
                blending: THREE.AdditiveBlending,
                uniforms: {
                    uTime: { value: 0 },
                    uBass: { value: 0 },
                    uTransient: { value: 0 },
                    uEnergy: { value: 0 },
                    uHigh: { value: 0 },
                    // 1e4 = sinceImpulse()'s "never fired" sentinel, so the
                    // first frame shows an already-spent wave rather than one
                    // mid-flight through the shell.
                    uSinceKick: { value: 1e4 },
                    uKickAmp: { value: 0 },
                    // 1.7, not 2.0: point size drives coverage quadratically,
                    // so it is the cheapest remaining lever on lit-area once
                    // brightness is already calibrated. See the exposure note
                    // in PCD_FRAG.
                    uSize: { value: 1.7 },
                    uFade: { value: 0 },
                    uColCore: { value: new THREE.Color('#00ffa3') },
                    uColMid: { value: new THREE.Color('#00e5ff') },
                    uColEdge: { value: new THREE.Color('#7c4dff') },
                },
            }),
        []
    )

    useDispose(material, geometry)

    useSceneFrame(
        ({ f, dt, b, col, vis, params, state }) => {
            const u = material.uniforms
            // Density budget comes through the performance-state seam, not the
            // quality governor directly, so a director can thin the cloud for
            // creative reasons too. Draws nothing until the worker's field lands.
            geometry.setDrawRange(0, filled.current ? Math.floor(COUNT * state.particleDensity) : 0)

            timeRef.current += dt * params.speed

            u.uTime.value = timeRef.current
            u.uBass.value = b.bass
            u.uTransient.value = b.transient
            u.uEnergy.value = b.energy
            u.uHigh.value = b.high

            // Latch the hit's strength at the moment it fires -- the wave it
            // launches keeps that amplitude for its whole crossing rather than
            // fading with the kick envelope's own (much faster) decay.
            if (f.percussion.kick.trigger) {
                hitAmp.current = Math.min(1.5, Math.max(0.5, f.percussion.kick.strength))
            }
            // f.time, not timeRef.current: the wave must be timed in engine
            // seconds. The scene clock above is speed-scaled, so timing the
            // wave on it would make the speed dial silently retune how long a
            // kick takes to cross the shell.
            u.uSinceKick.value = sinceImpulse(kickClock.current, f.time, f.percussion.kick.trigger)
            u.uKickAmp.value = hitAmp.current

            applyToUniforms(u)
            u.uFade.value = vis

            u.uColCore.value.copy(col.c)
            u.uColMid.value.copy(col.a)
            u.uColEdge.value.copy(col.b)
        },
        { visCeiling: 1, visFloor: 0 }
    )

    return (
        <points geometry={geometry} frustumCulled={false}>
            <primitive object={material} attach="material" />
        </points>
    )
}