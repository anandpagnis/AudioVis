#!/usr/bin/env node
/**
 * Build corpus/tracks.json — a genre/mood-balanced sample of MTG-Jamendo track
 * ids for DSP calibration. Fetches only the dataset's metadata TSVs (a few MB),
 * never audio; `corpus/fetch.mjs` pulls the audio afterward.
 *
 * Usage:
 *   node corpus/build-manifest.mjs [--size 1500] [--per-genre 120] [--seed 42]
 *
 * The audio is licensed per-track (various CC) and the dataset as a whole is
 * "non-commercial research and academic use" only — see corpus/README.md. This
 * manifest records ids + tags + duration; it does NOT assert per-track license
 * (unlike testfolder/tracks.json's hand-verified 8). Verify before any
 * commercial use.
 */
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def
}
const SIZE = opt('size', 1500)
const PER_GENRE = opt('per-genre', 120)
let seed = opt('seed', 42)
// Deterministic PRNG so a given (size, seed) reproduces the same manifest.
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 0xffffffff
}

const BASE = 'https://raw.githubusercontent.com/MTG/mtg-jamendo-dataset/master/data'
const GENRE_TSV = `${BASE}/autotagging_genre.tsv`
const MOOD_TSV = `${BASE}/autotagging_moodtheme.tsv`

function get(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { timeout: 120_000 }, (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        }
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve(body))
      })
      .on('timeout', function () {
        this.destroy(new Error('timeout'))
      })
      .on('error', reject)
  })
}

/** Parse an MTG-Jamendo autotagging TSV: TRACK_ID ARTIST ALBUM PATH DURATION tag... */
function parseTsv(text, tagPrefix) {
  const rows = new Map()
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('TRACK_ID')) continue
    const cols = line.split('\t')
    if (cols.length < 6) continue
    const jamendoId = Number(cols[0].replace('track_', ''))
    if (!Number.isFinite(jamendoId)) continue
    const durationSec = Number(cols[4])
    const tags = cols
      .slice(5)
      .filter((t) => t.startsWith(tagPrefix))
      .map((t) => t.slice(tagPrefix.length))
    rows.set(jamendoId, { jamendoId, durationSec, tags })
  }
  return rows
}

const [genreText, moodText] = await Promise.all([get(GENRE_TSV), get(MOOD_TSV)])
const genreRows = parseTsv(genreText, 'genre---')
const moodRows = parseTsv(moodText, 'mood/theme---')

// Bucket by primary genre, then sample round-robin up to PER_GENRE each until
// SIZE is reached — keeps electronic/rock from swamping jazz/classical.
const byGenre = new Map()
for (const [id, row] of genreRows) {
  if (row.durationSec < 45 || row.durationSec > 600) continue
  const g = row.tags[0] ?? 'unknown'
  if (!byGenre.has(g)) byGenre.set(g, [])
  byGenre.get(g).push({ ...row, genres: row.tags, moodTheme: moodRows.get(id)?.tags ?? [] })
}
for (const list of byGenre.values()) {
  // Fisher–Yates with the seeded PRNG.
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[list[i], list[j]] = [list[j], list[i]]
  }
}

const genres = [...byGenre.keys()].sort()
const picked = []
let round = 0
while (picked.length < SIZE && round < PER_GENRE) {
  for (const g of genres) {
    const list = byGenre.get(g)
    if (round < list.length && picked.length < SIZE) picked.push(list[round])
  }
  round++
}

const tracks = picked.map((r) => ({
  file: `${r.jamendoId}.mp3`,
  jamendoId: r.jamendoId,
  durationSec: Math.round(r.durationSec * 10) / 10,
  genres: r.genres,
  moodTheme: r.moodTheme,
}))

const manifest = {
  source: 'MTG-Jamendo Dataset (raw_30s / audio-low)',
  sourceRepo: 'https://github.com/MTG/mtg-jamendo-dataset',
  mirror: 'https://cdn.freesound.org/mtg-jamendo/raw_30s/audio-low',
  built: { size: tracks.length, perGenre: PER_GENRE, seed: opt('seed', 42), genres: genres.length },
  terms: {
    datasetUse:
      'The MTG-Jamendo Dataset is made available solely for non-commercial research and academic use. Any other use requires prior written authorization from Jamendo S.A. (hello@jamendo.com).',
    perTrackLicense:
      'Per-track Creative Commons, NOT verified in this manifest. Unlike testfolder/tracks.json (8 hand-checked tracks), these ids were sampled programmatically. Verify licenses before any non-research use.',
    redistribution:
      'Audio, decoded frames and reference labels are gitignored. This manifest + corpus/fetch.mjs reproduce the set without redistributing audio.',
  },
  fetch:
    'For each track: https://cdn.freesound.org/mtg-jamendo/raw_30s/audio-low/<last 2 digits of jamendoId>/<jamendoId>.low.mp3',
  tracks,
}

fs.writeFileSync(path.join(root, 'tracks.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`wrote corpus/tracks.json — ${tracks.length} tracks across ${genres.length} genres`)
