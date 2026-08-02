import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { resourceCache } from './streaming/resourceCache'

/**
 * Prefiltered environment map, generated once per session and shared.
 *
 * Any physically-shaded metal surface needs image-based lighting to read as
 * metal at all — LightRig's three point lights alone put exactly three hard
 * specular dots on a mirror and the result looks like plastic. RoomEnvironment
 * is fixed (independent of palette, audio, and scene), so there is no reason to
 * pay PMREM generation per mount, let alone per scene.
 *
 * Routed through the shared {@link resourceCache} as a PINNED entry — pinned
 * because it is a genuine session-lifetime singleton, same semantics as the
 * bare module-level singleton this replaced ("never disposed by design,
 * freeing it would break the next mount or a concurrent layer still sampling
 * it"). The one thing that changes: a WebGL context loss now actually
 * invalidates it (via `resourceCache.invalidateAll()`, wired in Stage.tsx),
 * where the old bare singleton had no invalidation path at all and would
 * hand out a texture pointing at dead GPU state after a restore.
 */
const ENV_MAP_KEY = 'envMap:room'

export function getSharedEnvMap(gl: THREE.WebGLRenderer): THREE.Texture {
  return resourceCache.acquire(
    ENV_MAP_KEY,
    () => {
      const pmrem = new THREE.PMREMGenerator(gl)
      const room = new RoomEnvironment()
      const tex = pmrem.fromScene(room, 0.04).texture
      room.dispose()
      pmrem.dispose()
      return tex
    },
    { pinned: true },
  )
}

/** Release a reference obtained from {@link getSharedEnvMap}. Safe to call
 *  even though the entry is pinned — pinned entries just ignore reaching a
 *  zero refcount rather than disposing, same as never releasing at all. */
export function releaseSharedEnvMap(): void {
  resourceCache.release(ENV_MAP_KEY)
}
