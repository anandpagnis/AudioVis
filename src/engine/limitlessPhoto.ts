/**
 * The `limitless` photo pipeline's shared constants and encoder.
 *
 * A separate module rather than living in `LimitlessScene.tsx` (which
 * declares the constants a scene like this normally would) for one reason:
 * `Console.tsx` — the control window — needs `resizeAndEncodePhoto` to build
 * its drop/picker panel, and `Console.tsx` and `LimitlessScene.tsx` are
 * different bundle entry points in this app's two-window split (see
 * `outputLink.ts`'s own header). `LimitlessScene.tsx` imports `* as THREE`
 * at module scope; a Console import of anything from that file would pull
 * three.js and the whole shader source into the control window's bundle for
 * a JPEG resize. This file imports neither three nor React, so either window
 * can take it for free.
 *
 * `LimitlessScene.tsx` imports `PHOTO_MAX_EDGE` from here too (not its own
 * copy) — the two constants only need to agree with EACH OTHER, not with any
 * particular consumer, so there is exactly one place they live.
 */

/**
 * Longest edge, in pixels, a dropped photo is resized to before it is
 * encoded.
 *
 * Past this the data URL only inflates the cross-window `postMessage` (see
 * `outputLink.ts`'s `LOOK_FIELDS` entry for `limitlessPhoto`) — at typical
 * output resolutions the extra pixels are never resolved, and the scene
 * renders below native anyway (see its own `pixelBudget`).
 */
export const PHOTO_MAX_EDGE = 1600

/** JPEG quality the dropped photo is re-encoded at. */
export const PHOTO_JPEG_QUALITY = 0.85

/**
 * Decode a dropped/picked image file, downscale to {@link PHOTO_MAX_EDGE}'s
 * longest edge (never upscale — a smaller source stays its own size), and
 * re-encode as a JPEG data URL at {@link PHOTO_JPEG_QUALITY}.
 *
 * Runs entirely on `<canvas>` + `Image`, so it works identically in whichever
 * window calls it. Rejects on a file that fails to decode (corrupt data, an
 * unsupported format) rather than resolving to a blank photo — the caller
 * decides how to tell the operator, this function does not silently degrade.
 */
export function resizeAndEncodePhoto(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const w = img.naturalWidth || img.width
      const h = img.naturalHeight || img.height
      if (!w || !h) {
        reject(new Error('decoded image has no dimensions'))
        return
      }
      const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(w, h))
      const outW = Math.max(1, Math.round(w * scale))
      const outH = Math.max(1, Math.round(h * scale))
      const canvas = document.createElement('canvas')
      canvas.width = outW
      canvas.height = outH
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('2D canvas context unavailable'))
        return
      }
      ctx.drawImage(img, 0, 0, outW, outH)
      resolve(canvas.toDataURL('image/jpeg', PHOTO_JPEG_QUALITY))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('image failed to decode'))
    }
    img.src = url
  })
}
