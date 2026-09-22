#!/usr/bin/env node
/**
 * Pick a small, mood-diverse evaluation subset from corpus/tracks.json (only
 * tracks that carry MTG-Jamendo `moodTheme` tags), write it to
 * corpus/eval-set.json, and download just those clips into corpus/audio/
 * (gitignored) using the same mirror URL scheme as corpus/fetch.mjs.
 *
 * Selection is round-robin over tags, rarest first, preferring tracks with few
 * tags, so the set spans the taxonomy instead of mirroring the corpus's own
 * skew. Deterministic (seeded), so re-running picks the same tracks.
 *
 * INTERNAL EVALUATION ONLY: the dataset is non-commercial research use (see
 * corpus/tracks.json `terms`). Never train shipped weights on these labels.
 *
 * Usage: node corpus/select-eval-set.mjs [--n 90] [--per-tag 4] [--no-download] [--seed 42]
 */
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const num = (flag, dflt) => {
  const i = args.indexOf(flag)
  return i >= 0 ? Number(args[i + 1]) : dflt
}
const N = num('--n', 90)
const PER_TAG = num('--per-tag', 4)
const SEED = num('--seed', 42)
const download = !args.includes('--no-download')

// Theme/occasion tags say nothing about how the music sounds; keep them out of
// the stratification so they don't crowd out real mood tags.
const NON_MOOD = new Set([
  'christmas', 'holiday', 'children', 'advertising', 'corporate', 'commercial',
  'documentary', 'film', 'movie', 'travel', 'game', 'background', 'trailer',
])

function mulberry32(a) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tracks.json'), 'utf8'))
const rand = mulberry32(SEED)
const clean = (s) => s.trim().toLowerCase()

const tagged = manifest.tracks
  .map((t) => ({ ...t, moodTheme: (t.moodTheme ?? []).map(clean).filter(Boolean) }))
  .map((t) => ({ ...t, moods: t.moodTheme.filter((m) => !NON_MOOD.has(m)) }))
  .filter((t) => t.moods.length > 0)

const byTag = new Map()
for (const t of tagged) for (const m of t.moods) (byTag.get(m) ?? byTag.set(m, []).get(m)).push(t)

// Rarest tags first, so they aren't starved; within a tag, fewer-tag tracks
// first (cleaner label), ties broken by the seeded RNG.
const tagOrder = [...byTag.entries()].sort((a, b) => a[1].length - b[1].length)
for (const [, list] of tagOrder) {
  list.sort((a, b) => a.moods.length - b.moods.length || rand() - 0.5)
}

const picked = new Map()
const perTagCount = new Map()
for (let round = 0; round < PER_TAG && picked.size < N; round++) {
  for (const [tag, list] of tagOrder) {
    if (picked.size >= N) break
    const next = list.find((t) => !picked.has(t.jamendoId))
    if (!next) continue
    picked.set(next.jamendoId, next)
    perTagCount.set(tag, (perTagCount.get(tag) ?? 0) + 1)
  }
}

const tracks = [...picked.values()].map((t) => ({
  file: t.file,
  jamendoId: t.jamendoId,
  durationSec: t.durationSec,
  genres: (t.genres ?? []).map(clean),
  moodTheme: t.moods,
}))

const tagCoverage = {}
for (const t of tracks) for (const m of t.moodTheme) tagCoverage[m] = (tagCoverage[m] ?? 0) + 1
const out = {
  purpose: 'Mood evaluation subset (internal use only; MTG-Jamendo is non-commercial research data).',
  seed: SEED,
  count: tracks.length,
  tagCoverage,
  terms: manifest.terms,
  tracks,
}
fs.writeFileSync(path.join(root, 'eval-set.json'), JSON.stringify(out, null, 2))
console.log(`selected ${tracks.length} tracks covering ${Object.keys(tagCoverage).length} mood tags -> corpus/eval-set.json`)
console.log(
  Object.entries(tagCoverage)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(' '),
)

if (!download) process.exit(0)

const dir = path.join(root, 'audio')
fs.mkdirSync(dir, { recursive: true })
const BASE = manifest.mirror

function get(url, dest) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { timeout: 120_000 }, (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error(`HTTP ${res.statusCode}`))
        }
        const tmp = `${dest}.part`
        const file = fs.createWriteStream(tmp)
        res.pipe(file)
        file.on('finish', () => file.close(() => (fs.renameSync(tmp, dest), resolve(fs.statSync(dest).size))))
        file.on('error', reject)
      })
      .on('timeout', function () {
        this.destroy(new Error('timeout'))
      })
      .on('error', reject)
  })
}

let ok = 0
let failed = 0
let bytes = 0
const queue = [...tracks]
async function worker() {
  while (queue.length) {
    const t = queue.shift()
    const dest = path.join(dir, t.file)
    if (fs.existsSync(dest)) {
      bytes += fs.statSync(dest).size
      ok++
      continue
    }
    const sub = String(t.jamendoId).slice(-2)
    try {
      bytes += await get(`${BASE}/${sub}/${t.jamendoId}.low.mp3`, dest)
      ok++
    } catch (err) {
      failed++
      console.error(`FAIL ${t.file}: ${err.message}`)
    }
  }
}
await Promise.all(Array.from({ length: 4 }, worker))
console.log(`\n${ok} ok, ${failed} failed, ${(bytes / 1024 / 1024).toFixed(1)} MB in corpus/audio/`)
console.log(manifest.terms.datasetUse)
