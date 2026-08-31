#!/usr/bin/env node
/**
 * Fetch the calibration corpus audio described by corpus/tracks.json into
 * corpus/audio/ (gitignored). Skips files already present unless --force.
 * Mirrors scripts/fetch-test-tracks.mjs; run corpus/build-manifest.mjs first.
 *
 * Usage: node corpus/fetch.mjs [--force] [--limit 200]
 */
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const dir = path.join(root, 'audio')
const manifestPath = path.join(root, 'tracks.json')
const force = process.argv.includes('--force')
const limIdx = process.argv.indexOf('--limit')
const limit = limIdx >= 0 ? Number(process.argv[limIdx + 1]) : Infinity

if (!fs.existsSync(manifestPath)) {
  console.error('No corpus/tracks.json — run `node corpus/build-manifest.mjs` first.')
  process.exit(1)
}
fs.mkdirSync(dir, { recursive: true })
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const BASE = manifest.mirror

function download(url, dest) {
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
        file.on('finish', () =>
          file.close(() => (fs.renameSync(tmp, dest), resolve(fs.statSync(dest).size))),
        )
        file.on('error', reject)
      })
      .on('timeout', function () {
        this.destroy(new Error('timeout'))
      })
      .on('error', reject)
  })
}

const CONCURRENCY = 6
const queue = manifest.tracks.slice(0, limit)
let ok = 0
let failed = 0
let bytes = 0

async function worker() {
  while (queue.length) {
    const t = queue.shift()
    const dest = path.join(dir, t.file)
    if (!force && fs.existsSync(dest)) {
      bytes += fs.statSync(dest).size
      ok++
      continue
    }
    const sub = String(t.jamendoId).slice(-2)
    try {
      bytes += await download(`${BASE}/${sub}/${t.jamendoId}.low.mp3`, dest)
      ok++
      if (ok % 100 === 0) console.log(`  ${ok} fetched…`)
    } catch (err) {
      failed++
      console.error(`FAIL ${t.file}: ${err.message}`)
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker))
console.log(`\n${ok} ok, ${failed} failed, ${(bytes / 1024 / 1024).toFixed(0)} MB in corpus/audio/`)
console.log(manifest.terms.datasetUse)
if (failed > queue.length * 0.5) process.exit(1)
