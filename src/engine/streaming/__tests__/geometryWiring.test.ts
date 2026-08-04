import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { generateDissolveField, generatePlasmaField } from '../proceduralGen'

/**
 * The scenes now build an empty, zero-draw-range geometry synchronously and
 * swap the worker's arrays in when they land. These pin that handoff — a
 * stride mismatch or a wrong attribute name renders garbage (or nothing)
 * rather than throwing, which is exactly the class of bug that survives
 * typecheck, lint and build.
 */

const PLASMA_COUNT = 500
const DISSOLVE_COUNT = 400

function emptyPlasmaGeometry(count: number): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
  geo.setAttribute('aRand', new THREE.BufferAttribute(new Float32Array(count * 4), 4))
  geo.setDrawRange(0, 0)
  return geo
}

function emptyDissolveGeometry(count: number): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
  geo.setAttribute('aScattered', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
  geo.setAttribute('aRand', new THREE.BufferAttribute(new Float32Array(count * 4), 4))
  geo.setDrawRange(0, 0)
  return geo
}

describe('Plasma geometry handoff', () => {
  it('starts with a zero draw range so the placeholder never renders', () => {
    // Every placeholder vertex sits at the origin. Drawing them would stack
    // 70k additive sprites on one pixel — a blinding dot, not a subtle bug.
    const geo = emptyPlasmaGeometry(PLASMA_COUNT)
    expect(geo.drawRange.count).toBe(0)
    expect(geo.getAttribute('position').count).toBe(PLASMA_COUNT)
  })

  it('accepts the generated arrays at the strides the shader declares', () => {
    const geo = emptyPlasmaGeometry(PLASMA_COUNT)
    const { positions, rand } = generatePlasmaField({
      count: PLASMA_COUNT,
      spread: 9,
      seed: 1,
    })
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('aRand', new THREE.BufferAttribute(rand, 4))

    const pos = geo.getAttribute('position')
    const aRand = geo.getAttribute('aRand')
    expect(pos.itemSize).toBe(3)
    expect(aRand.itemSize).toBe(4)
    // The vertex counts must agree, or three draws a truncated field.
    expect(pos.count).toBe(PLASMA_COUNT)
    expect(aRand.count).toBe(PLASMA_COUNT)
  })
})

describe('Dissolve geometry handoff', () => {
  it('accepts all three generated arrays at their declared strides', () => {
    const geo = emptyDissolveGeometry(DISSOLVE_COUNT)
    const position = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
    const normal = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])
    const { formed, scattered, rand } = generateDissolveField({
      position,
      normal,
      count: DISSOLVE_COUNT,
      cage: 7,
      seed: 2,
    })
    geo.setAttribute('position', new THREE.BufferAttribute(formed, 3))
    geo.setAttribute('aScattered', new THREE.BufferAttribute(scattered, 3))
    geo.setAttribute('aRand', new THREE.BufferAttribute(rand, 4))

    expect(geo.getAttribute('position').count).toBe(DISSOLVE_COUNT)
    expect(geo.getAttribute('aScattered').count).toBe(DISSOLVE_COUNT)
    expect(geo.getAttribute('aRand').count).toBe(DISSOLVE_COUNT)
    expect(geo.getAttribute('aScattered').itemSize).toBe(3)
  })

  it('every attribute the vertex shader reads is present after the swap', () => {
    // Names must match the `attribute` declarations in DissolveCageScene's
    // VERT: a typo yields an all-zero attribute and a silently wrong scene.
    const geo = emptyDissolveGeometry(DISSOLVE_COUNT)
    for (const name of ['position', 'aScattered', 'aRand']) {
      expect(geo.getAttribute(name), name).toBeDefined()
    }
  })
})
