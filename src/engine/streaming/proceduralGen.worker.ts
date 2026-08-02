/// <reference lib="webworker" />
import {
  generateDissolveField,
  generatePlasmaField,
  type DissolveGenParams,
  type DissolveGenResult,
  type PlasmaGenParams,
  type PlasmaGenResult,
} from './proceduralGen'

/**
 * Thin RPC wrapper around the pure generators. The only file in the streaming
 * system that needs the `webworker` lib — see tsconfig.worker.json, which
 * typechecks it as an independent program because `dom` and `webworker`
 * declare incompatible globals and cannot share one TypeScript program.
 *
 * Results are posted back with their buffers in the `transfer` list, so the
 * typed arrays move to the main thread with zero copying. That matters at
 * these sizes: Plasma's two arrays are ~2MB together.
 */

export type ProceduralRequest =
  | { kind: 'plasma'; id: number; params: PlasmaGenParams }
  | { kind: 'dissolve'; id: number; params: DissolveGenParams }

export type ProceduralResponse =
  | { kind: 'plasma'; id: number; result: PlasmaGenResult }
  | { kind: 'dissolve'; id: number; result: DissolveGenResult }
  | { kind: 'error'; id: number; message: string }

self.onmessage = (e: MessageEvent<ProceduralRequest>) => {
  const req = e.data
  try {
    if (req.kind === 'plasma') {
      const result = generatePlasmaField(req.params)
      const response: ProceduralResponse = { kind: 'plasma', id: req.id, result }
      self.postMessage(response, { transfer: [result.positions.buffer, result.rand.buffer] })
    } else {
      const result = generateDissolveField(req.params)
      const response: ProceduralResponse = { kind: 'dissolve', id: req.id, result }
      self.postMessage(response, {
        transfer: [result.formed.buffer, result.scattered.buffer, result.rand.buffer],
      })
    }
  } catch (err) {
    const response: ProceduralResponse = {
      kind: 'error',
      id: req.id,
      message: err instanceof Error ? err.message : String(err),
    }
    self.postMessage(response)
  }
}
