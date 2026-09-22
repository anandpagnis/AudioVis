import type { Plugin } from 'vite'

/** Build-time licence gate; see vite-commercial-gate.mjs. */
export function commercialGate(essentiaEnabled: boolean): Plugin[]
