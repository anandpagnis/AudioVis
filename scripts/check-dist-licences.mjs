#!/usr/bin/env node
/**
 * Licence gate for a production build.
 *
 * Commercial builds (accounts / Pro tier) must contain NO AGPL code and NO
 * non-commercial models. Known offenders:
 *   - essentia.js (AGPL-3.0: the JS wrapper and the bundled WASM core)
 *   - the MusiCNN weights in public/models (CC BY-NC-SA 4.0)
 * Both are behind the VITE_ENABLE_ESSENTIA build flag (default off, see
 * src/audio/intel/index.ts and vite.config.ts). This script scans `dist/` and
 * FAILS (exit 1) if any of it leaked through, so a bad build can never deploy.
 *
 * Usage:
 *   node scripts/check-dist-licences.mjs                  # scan ./dist
 *   node scripts/check-dist-licences.mjs --dist some/dir  # scan another dir
 *   node scripts/check-dist-licences.mjs --allow-essentia # internal builds only
 *
 * `--allow-essentia` skips the Essentia checks (Affero, essentia, musicnn, a
 * models/ directory, model shards) for internal / non-distributed builds made
 * with VITE_ENABLE_ESSENTIA=1. The audio-file check always runs.
 *
 * No dependencies; ESM. The scan is exported as a pure function for the tests
 * in src/audio/__tests__/checkDistLicences.test.ts.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Audio files permitted in dist/, as posix paths relative to dist/. Anything
 * else with an audio extension fails the gate: shipping a track needs a
 * licence, so every one has to be a deliberate, reviewed entry here.
 */
export const AUDIO_ALLOWLIST = [
  // TODO: licence unresolved - landing/fractures.mp3 is bundled from
  // public/landing but has no verified licence. Do not remove the file; clear
  // this TODO (or replace the track) before a commercial launch.
  'landing/fractures.mp3',
]

/** Extensions scanned as text. Everything else (images, wasm, fonts) is only
 * checked by name. */
export const TEXT_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.html',
  '.htm',
  '.css',
  '.json',
  '.map',
  '.txt',
  '.svg',
  '.webmanifest',
])

export const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.wav',
  '.ogg',
  '.oga',
  '.opus',
  '.flac',
  '.m4a',
  '.aac',
  '.aif',
  '.aiff',
  '.wma',
  '.weba',
])

const MODEL_SHARD_EXTENSIONS = new Set(['.pb', '.bin'])

/** `essentia` case-insensitively, but not the English word "essential(ly)". */
const ESSENTIA_RE = /essentia(?!l)/i

/** Content patterns. `essentiaOnly` rules are skipped by --allow-essentia. */
const CONTENT_RULES = [
  { rule: 'affero', re: /affero/i, essentiaOnly: true, why: 'AGPL licence text' },
  { rule: 'essentia', re: ESSENTIA_RE, essentiaOnly: true, why: 'essentia.js is AGPL-3.0' },
  { rule: 'musicnn', re: /musicnn/i, essentiaOnly: true, why: 'MusiCNN weights are CC BY-NC-SA' },
]

/** Same patterns applied to file / directory names. */
const NAME_RULES = [
  { rule: 'essentia-name', re: ESSENTIA_RE, essentiaOnly: true, why: 'essentia.js is AGPL-3.0' },
  {
    rule: 'musicnn-name',
    re: /musicnn/i,
    essentiaOnly: true,
    why: 'MusiCNN weights are CC BY-NC-SA',
  },
]

function* walk(dir, base = dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) yield* walk(full, base)
    else
      yield {
        full,
        rel: full
          .slice(base.length + 1)
          .split(sep)
          .join('/'),
      }
  }
}

function excerpt(text, index, len) {
  const start = Math.max(0, index - 30)
  return text
    .slice(start, index + len + 30)
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Scan a build output directory.
 *
 * @param {string} distDir directory to scan
 * @param {{ allowEssentia?: boolean, audioAllowlist?: string[] }} [opts]
 * @returns {{ ok: boolean, scanned: number, hits: { rule: string, file: string, detail: string }[] }}
 */
export function scanDist(distDir, opts = {}) {
  const { allowEssentia = false, audioAllowlist = AUDIO_ALLOWLIST } = opts
  const hits = []
  const seenModelsDir = new Set()
  let scanned = 0

  if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
    return {
      ok: false,
      scanned: 0,
      hits: [
        {
          rule: 'no-dist',
          file: distDir,
          detail: 'directory does not exist - run the build first',
        },
      ],
    }
  }

  const allow = new Set(audioAllowlist.map((p) => p.split('\\').join('/')))
  const skipEssentia = (r) => allowEssentia && r.essentiaOnly

  for (const { full, rel } of walk(distDir)) {
    scanned++
    const ext = extname(rel).toLowerCase()
    const segments = rel.split('/')

    // --- file / directory names ---
    for (const r of NAME_RULES) {
      if (!skipEssentia(r) && r.re.test(rel)) hits.push({ rule: r.rule, file: rel, detail: r.why })
    }
    if (!allowEssentia) {
      const idx = segments.findIndex(
        (s, i) => i < segments.length - 1 && s.toLowerCase() === 'models',
      )
      if (idx >= 0) {
        const dir = segments.slice(0, idx + 1).join('/')
        if (!seenModelsDir.has(dir)) {
          seenModelsDir.add(dir)
          hits.push({
            rule: 'models-dir',
            file: dir + '/',
            detail: 'a models/ directory must not ship',
          })
        }
        if (MODEL_SHARD_EXTENSIONS.has(ext)) {
          hits.push({ rule: 'model-shard', file: rel, detail: `${ext} model shard under models/` })
        }
      }
    }

    // --- audio files ---
    if (AUDIO_EXTENSIONS.has(ext) && !allow.has(rel)) {
      hits.push({
        rule: 'audio-not-allowlisted',
        file: rel,
        detail: 'audio file not on the allowlist in scripts/check-dist-licences.mjs',
      })
    }

    // --- text content ---
    if (TEXT_EXTENSIONS.has(ext)) {
      const text = readFileSync(full, 'utf8')
      for (const r of CONTENT_RULES) {
        if (skipEssentia(r)) continue
        const m = r.re.exec(text)
        if (m)
          hits.push({
            rule: r.rule,
            file: rel,
            detail: `${r.why}: ...${excerpt(text, m.index, m[0].length)}...`,
          })
      }
    }
  }

  return { ok: hits.length === 0, scanned, hits }
}

/** Human-readable failure report (also used by the tests). */
export function formatReport(result, distDir) {
  if (result.ok)
    return `check-dist-licences: OK - ${result.scanned} files scanned in ${distDir}, no licence problems.`
  const lines = [
    `check-dist-licences: FAIL - ${result.hits.length} problem(s) in ${distDir} (${result.scanned} files scanned):`,
  ]
  for (const h of result.hits) lines.push(`  [${h.rule}] ${h.file}  ${h.detail}`)
  lines.push(
    '',
    'Commercial builds must not contain essentia.js (AGPL-3.0) or the MusiCNN models (CC BY-NC-SA).',
    'Build without VITE_ENABLE_ESSENTIA, or pass --allow-essentia for an internal, non-distributed build.',
  )
  return lines.join('\n')
}

function main(argv) {
  const allowEssentia = argv.includes('--allow-essentia')
  const i = argv.indexOf('--dist')
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const distDir = i >= 0 && argv[i + 1] ? resolve(argv[i + 1]) : join(root, 'dist')
  const result = scanDist(distDir, { allowEssentia })
  const report = formatReport(result, distDir)
  if (result.ok) {
    console.log(report + (allowEssentia ? ' (Essentia checks skipped: --allow-essentia)' : ''))
    return 0
  }
  console.error(report)
  return 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
