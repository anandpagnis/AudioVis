import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { applyToUniforms } from '../engine/AnimationDirector'
import { useSceneFrame } from '../engine/sceneFrame'
import { proceduralDispatcher } from '../engine/streaming/proceduralDispatcher'
import { useDispose } from '../engine/useDispose'

const COUNT = 60000
const RADIUS = 4.5
/** Fixed seed: the field is identical every mount, so recordings and
 *  screenshots of this scene are reproducible. */
const SEED = 0x5ca77e

export const PCD_VERT = /* glsl */ `
  attribute vec4 aRand;
  uniform float uTime;
  uniform float uBass;
  uniform float uTransient;
  uniform float uPulse;
  uniform float uEnergy;
  uniform float uSize;
  varying float vScanProgress;
  varying float vRadius;
  varying vec4 vRand;

  void main() {
    vRand = aRand;
    vec3 fp = position;

    // Normal vector from origin for radial displacement
    vec3 dir = length(fp) > 1e-5 ? normalize(fp) : vec3(0.0, 1.0, 0.0);
    
    // Bass & transient displace points outward along their normals (volumetric "breathing")
    float displacement = (uBass * 0.35 + uTransient * 0.45) * (0.6 + aRand.x * 0.8);
    fp += dir * displacement;

    // Explode outward with pulse
    fp *= 1.0 + uPulse * 0.08 + uEnergy * 0.05;

    vRadius = length(fp);

    // Vertical scanline effect that travels through the cloud
    float scanHeight = mod(uTime * 2.5, ${RADIUS.toFixed(1)} * 2.5) - ${RADIUS.toFixed(1)} * 1.25;
    vScanProgress = smoothstep(1.2, 0.0, abs(fp.y - scanHeight));

    vec4 mv = modelViewMatrix * vec4(fp, 1.0);
    gl_Position = projectionMatrix * mv;

    // PCD style: sharp, crisp points with depth attenuation
    gl_PointSize = uSize * (0.6 + aRand.w * 0.8) * (1.0 + vScanProgress * 0.6 + uPulse * 0.4)
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
  varying vec4 vRand;

  void main() {
    // Sharp circular point mask for authentic LIDAR/PCD point aesthetic
    vec2 coord = gl_PointCoord - 0.5;
    if (dot(coord, coord) > 0.25) discard;

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
    float bright = depthFade * (0.04 + uEnergy * 0.14) * (0.5 + vRand.w * 0.5)
      * (1.0 + vScanProgress * 1.2 + sparkle * uHigh * 1.4);

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
                    uPulse: { value: 0 },
                    uEnergy: { value: 0 },
                    uHigh: { value: 0 },
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
        ({ dt, b, col, vis, params, state }) => {
            const u = material.uniforms
            // Density budget comes through the performance-state seam, not the
            // quality governor directly, so a director can thin the cloud for
            // creative reasons too. Draws nothing until the worker's field lands.
            geometry.setDrawRange(0, filled.current ? Math.floor(COUNT * state.particleDensity) : 0)

            timeRef.current += dt * params.speed

            u.uTime.value = timeRef.current
            u.uBass.value = b.bass
            u.uTransient.value = b.transient
            u.uPulse.value = b.pulse
            u.uEnergy.value = b.energy
            u.uHigh.value = b.high
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