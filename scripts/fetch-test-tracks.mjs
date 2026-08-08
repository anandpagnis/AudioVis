#!/usr/bin/env node
/**
 * Re-fetch the MTG-Jamendo test set described by testfolder/tracks.json.
 *
 * The audio is gitignored (see that file's `terms.redistribution`), so this is
 * how a fresh clone gets it back. Skips anything already present.
 *
 * Usage: node scripts/fetch-test-tracks.mjs [--force]
 */
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, 'testfolder')
const manifestPath = path.join(dir, 'tracks.json')
const force = process.argv.includes('--force')

if (!fs.existsSync(manifestPath)) {
  console.error(`No manifest at ${manifestPath}`)
  process.exit(1)
}
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
          file.close(() => {
            fs.renameSync(tmp, dest)
            resolve(fs.statSync(dest).size)
          }),
        )
        file.on('error', reject)
      })
      .on('timeout', function () {
        this.destroy(new Error('timeout'))
      })
      .on('error', reject)
  })
}

let total = 0
let failed = 0
for (const t of manifest.tracks) {
  const dest = path.join(dir, t.file)
  if (!force && fs.existsSync(dest)) {
    total += fs.statSync(dest).size
    console.log(`skip  ${t.file} (present)`)
    continue
  }
  // Mirror layout: <last two digits of id>/<id>.low.mp3
  const sub = String(t.jamendoId).slice(-2)
  try {
    const size = await download(`${BASE}/${sub}/${t.jamendoId}.low.mp3`, dest)
    total += size
    console.log(`ok    ${t.file}  ${(size / 1024 / 1024).toFixed(2)} MB  [${t.license}]`)
  } catch (err) {
    failed++
    console.error(`FAIL  ${t.file}: ${err.message}`)
  }
}
console.log(`\n${manifest.tracks.length - failed}/${manifest.tracks.length} tracks, ${(total / 1024 / 1024).toFixed(1)} MB`)
console.log(manifest.terms.datasetUse)
if (failed) process.exit(1)
