import type { Camera, Scene, WebGLRenderer, WebGLRenderTarget } from 'three'
import { RenderPass } from 'postprocessing'
import { setFrameRect } from './frameRect'

/**
 * The composer's scene pass, aimed at the frame's sub-rect (F272 stage 5).
 *
 * Every pass after it reads the rect off `inputBuffer`/`outputBuffer`'s `viewport` (frameRect.ts), so this
 * is the one place the rect is written, and it has to be written after anything that could reset it and
 * before the first draw of the frame. Both hold here by construction:
 *
 *  - `EffectComposer.setSize` is the only thing that touches the composer buffers' viewports (three's
 *    `RenderTarget.setSize` resets viewport and scissor to the full size, whether or not the size changed).
 *    `@react-three/postprocessing` calls it from its own `useFrame` just before `composer.render()`, and
 *    `PostFXChain` from its priority-0 frame hook; both run before the composer renders.
 *  - This pass is the first in the chain (the wrapper adds it before any child) and is always enabled, so its
 *    `render` is the first thing `composer.render()` does.
 *
 * Both buffers are aimed, not just the one drawn into: the passes ping-pong between them, and each reads its
 * input's rect from whichever buffer arrives as `inputBuffer`. The scissor makes `RenderPass`'s own clear
 * touch only the rect; outside it the buffers keep older frames' pixels, which no pass samples.
 */
export class RectRenderPass extends RenderPass {
  render(
    renderer: WebGLRenderer,
    inputBuffer: WebGLRenderTarget | null,
    outputBuffer: WebGLRenderTarget | null,
    deltaTime?: number,
    stencilTest?: boolean,
  ): void {
    if (inputBuffer) setFrameRect(inputBuffer)
    if (outputBuffer) setFrameRect(outputBuffer)
    super.render(renderer, inputBuffer, outputBuffer, deltaTime, stencilTest)
  }
}

/**
 * The `renderPass` factory `<EffectComposer>` takes. Module-level on purpose: the wrapper lists it as a
 * dependency of the effect that builds the composer, so a function recreated per render would rebuild the
 * whole composer on every re-render.
 */
export function createRectRenderPass(scene: Scene, camera: Camera): RectRenderPass {
  return new RectRenderPass(scene, camera)
}
