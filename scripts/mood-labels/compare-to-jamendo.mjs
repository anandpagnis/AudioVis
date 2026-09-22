#!/usr/bin/env node
/**
 * Coarse agreement check: Gemini mood labels (corpus/labels/gemini/_all.json)
 * vs the weak, uploader-supplied Jamendo `moodTheme` tags in
 * testfolder/tracks.json and corpus/tracks.json.
 *
 * The tag -> expectation map is the constant JAMENDO_TAG_MAP in lib.mjs. It is
 * COARSE: many Jamendo tags carry no mood information, uploaders tag loosely,
 * and most tracks have few or no mood tags. Treat the table as a smoke test
 * for gross disagreements, not as accuracy.
 *
 * Usage: node scripts/mood-labels/compare-to-jamendo.mjs [--labels <_all.json>] [--only <substr>]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compareToTags, formatTable, truncate } from './lib.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function loadTagIndex(root) {
  const idx = new Map()
  for (const p of [path.join(root, 'testfolder', 'tracks.json'), path.join(root, 'corpus', 'tracks.json')]) {
    if (!fs.existsSync(p)) continue
    for (const t of JSON.parse(fs.readFileSync(p, 'utf8')).tracks ?? []) {
      if (t.jamendoId != null && !idx.has(t.jamendoId)) idx.set(t.jamendoId, (t.moodTheme ?? []).map((s) => String(s).trim()).filter(Boolean))
    }
  }
  return idx
}

export function compareAll(records, tagIndex) {
  const rows = []
  const tally = { arousal: { ok: 0, X: 0, '~': 0 }, valence: { ok: 0, X: 0, '~': 0 }, mood: { ok: 0, X: 0 } }
  let noTags = 0
  let skipped = 0
  for (const r of records) {
    if (r.status && r.status !== 'ok') {
      skipped++
      continue
    }
    const tags = r.jamendoId != null && tagIndex.has(r.jamendoId) ? tagIndex.get(r.jamendoId) : r.jamendoTags ?? []
    const c = compareToTags(r.label, tags)
    if (!c.mapped.length) noTags++
    for (const axis of ['arousal', 'valence', 'mood']) if (tally[axis][c[axis].verdict] !== undefined) tally[axis][c[axis].verdict]++
    rows.push([
      truncate(r.title ?? r.trackId, 26),
      truncate(tags.join(',') || '(none)', 28),
      c.mapped.length ? String(c.mapped.length) : '0',
      `${r.label.primaryMood}${r.label.secondaryMood ? `/${r.label.secondaryMood}` : ''}`,
      r.label.valence.toFixed(1),
      r.label.arousal.toFixed(1),
      c.arousal.verdict,
      c.valence.verdict,
      c.mood.verdict,
    ])
  }
  return { rows, tally, noTags, skipped }
}

function main() {
  const argv = process.argv.slice(2)
  const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null)
  const labelsPath = path.resolve(arg('--labels') ?? path.join(ROOT, 'corpus', 'labels', 'gemini', '_all.json'))
  if (!fs.existsSync(labelsPath)) {
    console.error(`No labels at ${labelsPath}. Run: node scripts/mood-labels/label.mjs (see README).`)
    process.exitCode = 1
    return
  }
  const only = arg('--only')?.toLowerCase()
  const records = JSON.parse(fs.readFileSync(labelsPath, 'utf8')).filter((r) => !only || `${r.trackId} ${r.title}`.toLowerCase().includes(only))
  const { rows, tally, noTags, skipped } = compareAll(records, loadTagIndex(ROOT))
  console.log(formatTable(['track', 'jamendo moodTheme', '#map', 'gemini mood', 'V', 'A', 'A?', 'V?', 'mood?'], rows))
  console.log('\nLegend: ok = agrees with the tag-implied side, X = disagrees, ~ = Gemini rating is mid-scale (strictly between 4 and 6, not judged), - = no mapped tag implies anything.')
  console.log('A?/V? judge arousal/valence low (<=4) vs high (>=6); mood? checks primary/secondary against the tag-compatible mood set.')
  const pct = (a, n) => (n ? `${((100 * a) / n).toFixed(0)}%` : 'n/a')
  for (const axis of ['arousal', 'valence']) {
    const t = tally[axis]
    console.log(`${axis.padEnd(8)} judged ${t.ok + t.X + t['~']}: ok ${t.ok}, X ${t.X}, mid ${t['~']}  -> agreement among decided: ${pct(t.ok, t.ok + t.X)}`)
  }
  console.log(`mood     judged ${tally.mood.ok + tally.mood.X}: ok ${tally.mood.ok}, X ${tally.mood.X}  -> agreement: ${pct(tally.mood.ok, tally.mood.ok + tally.mood.X)}`)
  console.log(`${noTags} of ${rows.length} tracks have no mood tag that the map can interpret; ${skipped} blocked/non-ok record(s) skipped.`)
  console.log('CAUTION: the map (JAMENDO_TAG_MAP in lib.mjs) is coarse and Jamendo tags are weak; a disagreement is a prompt to look at the track, not proof that either side is wrong.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
