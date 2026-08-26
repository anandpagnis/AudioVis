import { LAYER_ROLES, useStore, type LayerRole, type Quality } from './store'
import { SCENES } from './scenes'
import { PALETTES } from './engine/palettes'
import { sanitizePreset } from './engine/presets'

/** Encode the current look as a shareable URL (Phase 8). */
export function buildShareUrl(): string {
  const s = useStore.getState()
  const look = {
    name: 'shared',
    sceneId: s.sceneId,
    layerSceneIds: s.layerSceneIds,
    paletteId: s.paletteId,
    params: s.params,
    layerFx: s.layerFx,
    ...(s.cues.length > 0 ? { cues: s.cues } : {}),
  }
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(look))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `${location.origin}${location.pathname}#look=${b64}`
}

function applySharedLook(patch: Record<string, unknown>) {
  const encoded = new URLSearchParams(window.location.hash.slice(1)).get('look')
  if (!encoded) return
  try {
    const json = decodeURIComponent(escape(atob(encoded.replace(/-/g, '+').replace(/_/g, '/'))))
    const p = sanitizePreset(JSON.parse(json))
    if (!p) return
    if (SCENES.some((s) => s.id === p.sceneId)) patch.sceneId = p.sceneId
    if (PALETTES.some((pl) => pl.id === p.paletteId)) patch.paletteId = p.paletteId
    patch.params = p.params
    patch.layerSceneIds = {
      background: p.layerSceneIds?.background ?? null,
      accent: p.layerSceneIds?.accent ?? p.accentSceneId ?? null,
      overlay: p.layerSceneIds?.overlay ?? p.overlaySceneId ?? null,
    }
    if (p.layerFx) patch.layerFx = p.layerFx
    if (p.cues) patch.cues = p.cues
  } catch {
    /* malformed share links are ignored */
  }
}

/**
 * OBS / wallpaper mode: configure the app from the URL so it can run as a
 * chromeless layer inside OBS browser sources, kiosk windows, or wallpaper
 * engines. Examples:
 *
 *   ?scene=tunnel&palette=ember          preselect scene + palette
 *   ?background=x&accent=ribbons&overlay=y  compose persistent secondary layers
 *   ?ui=hidden                           start with all chrome hidden
 *   ?quality=low                         pin render quality
 *   ?intensity=1.2&speed=0.8&reactivity=1.4
 *
 * URL values win over persisted localStorage state.
 */
export function applyUrlParams() {
  const q = new URLSearchParams(window.location.search)
  const patch: Record<string, unknown> = {}

  const scene = q.get('scene')
  if (scene && SCENES.some((s) => s.id === scene)) patch.sceneId = scene

  // Slot params only touch the slots actually named, so `?accent=ribbons`
  // leaves a persisted background alone rather than blanking the record.
  const slots: Partial<Record<LayerRole, string | null>> = {}
  for (const role of LAYER_ROLES) {
    const id = q.get(role)
    if (id === 'none' || id === 'off') slots[role] = null
    else if (id && SCENES.some((s) => s.id === id)) slots[role] = id
  }
  if (Object.keys(slots).length > 0) {
    patch.layerSceneIds = { ...useStore.getState().layerSceneIds, ...slots }
  }

  const palette = q.get('palette')
  if (palette && PALETTES.some((p) => p.id === palette)) patch.paletteId = palette

  if (q.get('ui') === 'hidden') patch.uiHidden = true

  // Mood automation toggles: ?autopilot=0|1&mooddrive=0|1&gen=0|1
  for (const [param, key] of [
    ['autopilot', 'autoPilot'],
    ['mooddrive', 'moodDrive'],
  ] as const) {
    const raw = q.get(param)
    if (raw === '1' || raw === 'true') patch[key] = true
    else if (raw === '0' || raw === 'false') patch[key] = false
  }

  const quality = q.get('quality')
  if (quality && ['auto', 'low', 'medium', 'high'].includes(quality)) {
    patch.quality = quality as Quality
  }

  const params = { ...useStore.getState().params }
  let paramsTouched = false
  for (const key of ['intensity', 'speed', 'reactivity'] as const) {
    const raw = q.get(key)
    if (raw !== null) {
      const v = Number(raw)
      if (isFinite(v)) {
        params[key] = Math.min(2, Math.max(0.2, v))
        paramsTouched = true
      }
    }
  }
  if (paramsTouched) patch.params = params

  // #look=<base64> — a shared look/performance overrides everything above.
  applySharedLook(patch)

  if (Object.keys(patch).length > 0) useStore.setState(patch)
}
