import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useSceneFrame } from '../engine/sceneFrame'
import { useDispose } from '../engine/useDispose'

const MAX_PARTICLES = 800
const BOUNDS = 14.0
const BOUNDS_HALF = BOUNDS / 2.0

/**
 * Connection radius. Measured, not chosen by eye: at the original 2.4 this
 * scene drew ~4600 links and covered 30.8% of the frame with a mean luma of
 * 23 — a web filling the screen rather than a constellation, and well past the
 * project's ≤15%-lit / <20-mean exposure rule. Dimming alone does not fix that
 * (it barely moved lit%, since coverage is what the metric measures); the
 * radius and the per-node cap are the levers that actually do.
 *
 * This matters more here than for a primary scene: this one runs as an accent
 * or overlay, compositing ON TOP of a primary, so it has to leave the frame
 * mostly empty or it washes out whatever it is layered over.
 */
const BASE_MIN_DIST = 1.6

/**
 * Per-node connection cap. Also the thing that bounds the line buffer: since a
 * node stops accepting new links once it hits the cap, total links can never
 * exceed MAX_PARTICLES × this, regardless of how tightly the cloud clusters.
 */
const MAX_LINKS_PER_NODE = 6

/** Additive line brightness. See BASE_MIN_DIST — with ~2200 links overlapping,
 *  full-strength palette colour accumulates into haze. */
const LINE_GAIN = 0.45

/** Nodes read as the structure the links hang off, so they sit just below the
 *  links rather than competing with them. */
const POINT_GAIN = 0.8

/** Worst-case simultaneous links, and therefore the exact line-buffer size. */
const MAX_LINKS = MAX_PARTICLES * MAX_LINKS_PER_NODE

export function NetworkConstellationScene() {
    const pointsRef = useRef<THREE.Points>(null)
    const linesRef = useRef<THREE.LineSegments>(null)

    // Stable particle state stored in raw arrays to prevent GC pauses
    const pState = useMemo(() => {
        const pos = new Float32Array(MAX_PARTICLES * 3)
        const vel = new Float32Array(MAX_PARTICLES * 3)
        for (let i = 0; i < MAX_PARTICLES; i++) {
            pos[i * 3] = (Math.random() - 0.5) * BOUNDS
            pos[i * 3 + 1] = (Math.random() - 0.5) * BOUNDS
            pos[i * 3 + 2] = (Math.random() - 0.5) * BOUNDS

            vel[i * 3] = (Math.random() - 0.5) * 0.04
            vel[i * 3 + 1] = (Math.random() - 0.5) * 0.04
            vel[i * 3 + 2] = (Math.random() - 0.5) * 0.04
        }
        return { pos, vel }
    }, [])

    /** Per-node link tally, reused every frame (see the connection loop). */
    const linkCounts = useRef(new Uint8Array(MAX_PARTICLES))

    // Geometries for points and dynamic connection lines
    const { pointGeo, lineGeo } = useMemo(() => {
        const pGeo = new THREE.BufferGeometry()
        pGeo.setAttribute('position', new THREE.BufferAttribute(pState.pos, 3).setUsage(THREE.DynamicDrawUsage))
        pGeo.setDrawRange(0, MAX_PARTICLES)

        // Two vertices per link, three floats each. Sized from the real cap
        // (MAX_LINKS) rather than the naive MAX_PARTICLES² pair count — the
        // per-node cap makes the quadratic bound unreachable, and allocating
        // for it would cost ~15MB of buffers to hold at most ~9600 links.
        const lGeo = new THREE.BufferGeometry()
        const linePos = new Float32Array(MAX_LINKS * 6)
        const lineCol = new Float32Array(MAX_LINKS * 6)

        lGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3).setUsage(THREE.DynamicDrawUsage))
        lGeo.setAttribute('color', new THREE.BufferAttribute(lineCol, 3).setUsage(THREE.DynamicDrawUsage))
        lGeo.setDrawRange(0, 0)

        return { pointGeo: pGeo, lineGeo: lGeo }
    }, [pState])

    const { pointMat, lineMat } = useMemo(() => {
        const pMat = new THREE.PointsMaterial({
            color: 0xffffff,
            size: 0.12,
            blending: THREE.AdditiveBlending,
            transparent: true,
            sizeAttenuation: true,
        })

        const lMat = new THREE.LineBasicMaterial({
            vertexColors: true,
            blending: THREE.AdditiveBlending,
            transparent: true,
            opacity: 0.75,
        })

        return { pointMat: pMat, lineMat: lMat }
    }, [])

    useDispose(pointGeo, lineGeo, pointMat, lineMat)

    useSceneFrame(
        ({ dt, b, col, vis, params, state }) => {
            const activeCount = Math.floor(MAX_PARTICLES * state.particleDensity)
            pointGeo.setDrawRange(0, activeCount)

            const posAttr = pointGeo.attributes.position as THREE.BufferAttribute
            const linePosAttr = lineGeo.attributes.position as THREE.BufferAttribute
            const lineColAttr = lineGeo.attributes.color as THREE.BufferAttribute

            const positions = posAttr.array as Float32Array
            const linePositions = linePosAttr.array as Float32Array
            const lineColors = lineColAttr.array as Float32Array
            const velocities = pState.vel

            // Bass & transient boost particle velocity
            const speedMult = (1.0 + b.bass * 2.5 + b.transient * 4.0) * params.speed * (dt * 60)

            // Mid frequencies extend the search radius for connections
            const currentMinDist = BASE_MIN_DIST * (1.0 + b.mid * 0.8 + b.energy * 0.4)
            const minDistSq = currentMinDist * currentMinDist

            // 1. Advect particles & bounce off bounding box
            for (let i = 0; i < activeCount; i++) {
                const idx = i * 3
                positions[idx] += velocities[idx] * speedMult
                positions[idx + 1] += velocities[idx + 1] * speedMult
                positions[idx + 2] += velocities[idx + 2] * speedMult

                if (positions[idx] < -BOUNDS_HALF || positions[idx] > BOUNDS_HALF) velocities[idx] *= -1
                if (positions[idx + 1] < -BOUNDS_HALF || positions[idx + 1] > BOUNDS_HALF) velocities[idx + 1] *= -1
                if (positions[idx + 2] < -BOUNDS_HALF || positions[idx + 2] > BOUNDS_HALF) velocities[idx + 2] *= -1
            }

            // 2. Evaluate distance threshold and generate connecting segments
            let vertexPos = 0
            let colorPos = 0
            let numConnected = 0

            // Reused across frames rather than reallocated — this loop is the
            // scene's hot path and a fresh Uint8Array every frame is exactly
            // the GC pressure the raw-array particle state exists to avoid.
            const connectionsCount = linkCounts.current
            connectionsCount.fill(0, 0, activeCount)

            const colCore = col.c
            const colEdge = col.b

            for (let i = 0; i < activeCount; i++) {
                if (connectionsCount[i] >= MAX_LINKS_PER_NODE) continue
                const i3 = i * 3

                for (let j = i + 1; j < activeCount; j++) {
                    // Re-check i inside the inner loop, not just at the top of
                    // the outer one: without this a node in a dense cluster
                    // keeps accepting links for the rest of its pass, blowing
                    // past the cap and making MAX_LINKS an unsound bound.
                    if (connectionsCount[i] >= MAX_LINKS_PER_NODE) break
                    if (connectionsCount[j] >= MAX_LINKS_PER_NODE) continue
                    const j3 = j * 3

                    const dx = positions[i3] - positions[j3]
                    const dy = positions[i3 + 1] - positions[j3 + 1]
                    const dz = positions[i3 + 2] - positions[j3 + 2]
                    const distSq = dx * dx + dy * dy + dz * dz

                    if (distSq < minDistSq) {
                        connectionsCount[i]++
                        connectionsCount[j]++

                        const dist = Math.sqrt(distSq)
                        const alpha = (1.0 - dist / currentMinDist) * vis

                        linePositions[vertexPos++] = positions[i3]
                        linePositions[vertexPos++] = positions[i3 + 1]
                        linePositions[vertexPos++] = positions[i3 + 2]

                        linePositions[vertexPos++] = positions[j3]
                        linePositions[vertexPos++] = positions[j3 + 1]
                        linePositions[vertexPos++] = positions[j3 + 2]

                        // Blend vertex color from Core accent to Edge palette based on line length
                        const r = colCore.r * alpha + colEdge.r * (1 - alpha)
                        const g = colCore.g * alpha + colEdge.g * (1 - alpha)
                        const bCol = colCore.b * alpha + colEdge.b * (1 - alpha)

                        const w = alpha * LINE_GAIN
                        for (let k = 0; k < 2; k++) {
                            lineColors[colorPos++] = r * w
                            lineColors[colorPos++] = g * w
                            lineColors[colorPos++] = bCol * w
                        }

                        numConnected++
                    }
                }
            }

            lineGeo.setDrawRange(0, numConnected * 2)
            posAttr.needsUpdate = true
            linePosAttr.needsUpdate = true
            lineColAttr.needsUpdate = true

            pointMat.color.copy(col.a).multiplyScalar(POINT_GAIN)
            pointMat.opacity = vis
        },
        { visCeiling: 1, visFloor: 0 }
    )

    return (
        <group>
            <points ref={pointsRef} geometry={pointGeo} material={pointMat} frustumCulled={false} />
            <lineSegments ref={linesRef} geometry={lineGeo} material={lineMat} frustumCulled={false} />
        </group>
    )
}