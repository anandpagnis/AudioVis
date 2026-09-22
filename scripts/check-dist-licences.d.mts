// Types for scripts/check-dist-licences.mjs (plain ESM, no build step) so the
// unit test under src/ can import it under `strict`.
export interface LicenceHit {
  rule: string
  file: string
  detail: string
}
export interface ScanResult {
  ok: boolean
  scanned: number
  hits: LicenceHit[]
}
export interface ScanOptions {
  allowEssentia?: boolean
  audioAllowlist?: string[]
}
export const AUDIO_ALLOWLIST: string[]
export const TEXT_EXTENSIONS: Set<string>
export const AUDIO_EXTENSIONS: Set<string>
export function scanDist(distDir: string, opts?: ScanOptions): ScanResult
export function formatReport(result: ScanResult, distDir: string): string
