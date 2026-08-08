#!/usr/bin/env node
/**
 * Copy TF.js's WASM binaries out of node_modules into public/tfjs/.
 *
 * The voice worker calls setWasmPaths('/tfjs/'). The default would fetch them
 * from a CDN, which this app must never do — it runs offline and a blocked
 * request would silently disable voice detection.
 *
 * Gitignored output; rerun after upgrading @tensorflow/tfjs-backend-wasm.
 * Usage: node scripts/setup-tfjs-wasm.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(root, 'node_modules', '@tensorflow', 'tfjs-backend-wasm', 'dist')
const dst = path.join(root, 'public', 'tfjs')

if (!fs.existsSync(src)) {
  console.error(`Missing ${src} — run npm install first.`)
  process.exit(1)
}

fs.mkdirSync(dst, { recursive: true })
// All three variants: tfjs picks simd / threaded-simd / plain at runtime from
// what the browser actually supports, so shipping only one breaks somewhere.
const files = fs.readdirSync(src).filter((f) => f.endsWith('.wasm'))
if (files.length === 0) {
  console.error('No .wasm files found in the backend package.')
  process.exit(1)
}
let total = 0
for (const f of files) {
  const out = path.join(dst, f)
  fs.copyFileSync(path.join(src, f), out)
  const size = fs.statSync(out).size
  total += size
  console.log(`${f}  ${(size / 1024).toFixed(0)} KB`)
}
console.log(`\n${files.length} files, ${(total / 1024 / 1024).toFixed(2)} MB -> public/tfjs/`)
