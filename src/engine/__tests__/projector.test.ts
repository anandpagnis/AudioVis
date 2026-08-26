import { beforeEach, describe, expect, it } from 'vitest'
import { LOCAL_FIELDS, mirrorInto, PUBLISH_INTERVAL_MS, STALE_MS, WIRE_FIELDS } from '../projector'
import { performanceState } from '../performanceState'
import { createEmptyFeatures } from '../../audio/types'

/**
 * The wire contract.
 *
 * Everything else about the projector needs two real windows and a live
 * `BroadcastChannel`, which is a Playwright job. What CAN be pinned here is the
 * thing most likely to rot silently: which fields travel.
 */
describe('the field split covers performanceState exactly', () => {
  it('assigns every field to the wire or to the follower, and never to both', () => {
    // The failure this exists for: someone adds a director-owned field, forgets
    // to publish it, and the projector is quietly a little wrong in a way only
    // a human looking at two screens at once could notice.
    const declared = new Set<string>([...WIRE_FIELDS, ...LOCAL_FIELDS])
    const actual = Object.keys(performanceState)

    const unclassified = actual.filter((k) => !declared.has(k))
    expect(unclassified, 'new performanceState fields must be classified').toEqual([])

    const stale = [...declared].filter((k) => !actual.includes(k))
    expect(stale, 'the lists name a field that no longer exists').toEqual([])
  })

  it('does not publish anything the follower owns', () => {
    const wire = new Set<string>(WIRE_FIELDS)
    for (const k of LOCAL_FIELDS) expect(wire.has(k), k).toBe(false)
  })

  it('keeps the follower owning exactly the scene lifecycle', () => {
    // Not an arbitrary list. These four are the ones the follower's own
    // SceneManager writes as it mounts, warms and crossfades — sending them
    // would mean one window driving another window's mount lifecycle across a
    // channel with no ordering guarantee against the frames interleaved with
    // it. Everything else is a director decision and belongs on the wire.
    expect([...LOCAL_FIELDS].sort()).toEqual(['activeScene', 'layers', 'scene', 'transition'])
  })
})

describe('the constants say what they mean', () => {
  it('caps publishing at roughly a 60 Hz display', () => {
    // A 144 Hz laptop publishing every rendered frame would push ~1.5 MB/s of
    // features at a projector that reads only the newest one.
    expect(PUBLISH_INTERVAL_MS).toBeCloseTo(1000 / 60, 3)
  })

  it('gives a leader longer to go quiet than a dropped frame or two', () => {
    // Backgrounded tabs get rAF-throttled hard. The window has to be long
    // enough that ordinary throttling does not read as a dead leader, and short
    // enough that a real one does not leave a still image in front of an
    // audience.
    expect(STALE_MS).toBeGreaterThan(1000)
    expect(STALE_MS).toBeLessThanOrEqual(3000)
  })
})

/**
 * The shape a frame has to survive being sent in, checked at the type's own
 * factory. These properties fail at runtime and silently, never at compile
 * time, so they are worth stating.
 */
describe('the shape a frame has to be mirrored into', () => {
  let features: ReturnType<typeof createEmptyFeatures>

  beforeEach(() => {
    features = createEmptyFeatures()
  })

  it('is plain data end to end, so it can cross a structured clone at all', () => {
    // The moment a class instance or a function appears anywhere in
    // AudioFeatures, `postMessage` throws DataCloneError at runtime and the
    // projector goes dark with no type error to warn anyone.
    const seen = new Set<unknown>()
    const check = (v: unknown, path: string) => {
      if (v === null || typeof v !== 'object') {
        expect(typeof v, path).not.toBe('function')
        return
      }
      if (seen.has(v)) throw new Error(`cycle at ${path}`)
      seen.add(v)
      if (ArrayBuffer.isView(v)) return
      expect(Object.getPrototypeOf(v), path).toBe(Object.prototype)
      for (const [k, child] of Object.entries(v)) check(child, `${path}.${k}`)
    }
    check(features, 'features')
  })

  it('holds nested objects a reader may have captured a reference to', () => {
    // `percussion` and `mood` are read by scenes that grabbed the reference at
    // mount. Applying a frame must write THROUGH them, not replace them, or
    // every holder keeps reading an object that stopped updating.
    expect(features.percussion).toBeTypeOf('object')
    expect(features.mood).toBeTypeOf('object')
  })

  it('carries the three sample buffers the scenes actually draw', () => {
    expect(features.waveform).toBeInstanceOf(Float32Array)
    expect(features.spectrum).toBeInstanceOf(Float32Array)
    expect(features.midWaveform).toBeInstanceOf(Float32Array)
  })
})

/**
 * `mirrorInto` is how a frame lands, and its pruning rule is the part that
 * already broke once.
 */
describe('mirrorInto', () => {
  it('does NOT delete the fields a subset payload leaves out', () => {
    // The regression, exactly. A performanceState payload carries WIRE_FIELDS
    // only, so pruning at the caller's level deletes `scene`, `layers` and
    // `transition` — the three the follower owns. Measured before the fix:
    // "cannot read 'effects' of undefined" on every frame, projector blank.
    const dst: Record<string, unknown> = {
      bloom: 0,
      layers: { background: null, effects: [] },
      scene: 'wireframe',
    }
    mirrorInto(dst, { bloom: 1.5 })
    expect(dst.bloom).toBe(1.5)
    expect(dst.layers).toEqual({ background: null, effects: [] })
    expect(dst.scene).toBe('wireframe')
  })

  it('DOES prune inside a nested object, one level down', () => {
    // `sceneParams` is a sparse steer block whose keys come and go. A key the
    // leader withdrew has to go, or it stands as a permanent instruction.
    const dst: Record<string, unknown> = { sceneParams: { speed: 2, warp: 1 } }
    mirrorInto(dst, { sceneParams: { speed: 3 } })
    expect(dst.sceneParams).toEqual({ speed: 3 })
  })

  it('writes through nested objects rather than replacing them', () => {
    // Scenes capture `features.percussion` and `performanceState.mirror` at
    // mount and hold them for the session. Replacing the object would leave
    // every holder reading one that stopped updating — silently.
    const inner = { segments: 0, tiles: 0 }
    const dst: Record<string, unknown> = { mirror: inner }
    mirrorInto(dst, { mirror: { segments: 6, tiles: 3 } })
    expect(dst.mirror).toBe(inner)
    expect(inner).toEqual({ segments: 6, tiles: 3 })
  })

  it('copies into an existing Float32Array of the same length', () => {
    const buf = new Float32Array(4)
    const dst: Record<string, unknown> = { waveform: buf }
    mirrorInto(dst, { waveform: new Float32Array([1, 2, 3, 4]) })
    expect(dst.waveform).toBe(buf)
    expect([...buf]).toEqual([1, 2, 3, 4])
  })

  it('reallocates when the buffer length changed rather than half-copying', () => {
    const dst: Record<string, unknown> = { waveform: new Float32Array(2) }
    mirrorInto(dst, { waveform: new Float32Array([1, 2, 3, 4]) })
    expect([...(dst.waveform as Float32Array)]).toEqual([1, 2, 3, 4])
  })
})
