import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

/**
 * Prefiltered environment map, generated once per session and shared.
 *
 * Any physically-shaded metal surface needs image-based lighting to read as
 * metal at all — LightRig's three point lights alone put exactly three hard
 * specular dots on a mirror and the result looks like plastic. RoomEnvironment
 * is fixed (independent of palette, audio, and scene), so there is no reason to
 * pay PMREM generation per mount, let alone per scene.
 *
 * Deliberately never disposed: it is a session-lifetime singleton, and freeing
 * it would break the next mount and any concurrent layer still sampling it.
 */
let shared: THREE.Texture | null = null

export function getSharedEnvMap(gl: THREE.WebGLRenderer): THREE.Texture {
  if (shared) return shared
  const pmrem = new THREE.PMREMGenerator(gl)
  const room = new RoomEnvironment()
  shared = pmrem.fromScene(room, 0.04).texture
  room.dispose()
  pmrem.dispose()
  return shared
}
