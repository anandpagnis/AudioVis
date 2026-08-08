/**
 * essentia.js ships no usable types for its deep dist imports; the API surface
 * we touch is tiny and wrapped in one worker file, so `any` is contained.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
declare module 'essentia.js/dist/essentia-wasm.es.js' {
  export const EssentiaWASM: any
  const _default: any
  export default _default
}
declare module 'essentia.js/dist/essentia.js-core.es.js' {
  export const Essentia: any
  const _default: any
  export default _default
}
