#!/usr/bin/env node
/**
 * Fetch human-rated valence/arousal datasets into corpus/emotion/ (gitignored) so
 * the mood engine's valence and arousal can be checked against real listeners,
 * without any LLM or API key.
 *
 *   node corpus/fetch-emotion-sets.mjs --deam-annotations   # Zenodo, CC BY 4.0, 4.7 MB, md5-checked
 *   node corpus/fetch-emotion-sets.mjs --deam-audio         # official host (see notes: currently unreachable)
 *   node corpus/fetch-emotion-sets.mjs --pmemo              # Hugging Face community mirror, ~680 MB
 *   node corpus/fetch-emotion-sets.mjs --all
 *
 * SOURCES AND WHAT IS (NOT) VERIFIED  (checked 2026-09-19)
 *  DEAM annotations  zenodo.org/records/11400122, licence cc-by-4.0 per the Zenodo API. VERIFIED.
 *  DEAM audio        cvml.unige.ch/databases/DEAM/DEAM_audio.zip is the official host but refused every
 *                    connection from here (curl and the web-fetch service). If it stays down: get the audio
 *                    from the Kaggle mirror (imsparsh/deam-mediaeval-dataset-emotional-analysis-in-music,
 *                    needs a free Kaggle login) and put DEAM_audio.zip in corpus/emotion/deam/, then re-run
 *                    with --deam-audio: it will extract it.
 *  PMEmo             huggingface.co/datasets/csdhbg/PMEmo2019 is a COMMUNITY re-upload of PMEmo (794 chorus
 *                    clips, valence/arousal). It has no dataset card or licence. Provenance and licence are
 *                    UNVERIFIED; the original PMEmo terms are not confirmed here either.
 *
 * INTERNAL EVALUATION ONLY. These sets are non-commercial research data. Never train weights that ship in
 * the product on them, and never redistribute the audio (corpus/emotion/ is gitignored).
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(root, 'emotion')
const args = new Set(process.argv.slice(2))
const all = args.has('--all')
const want = {
  deamAnnotations: all || args.has('--deam-annotations'),
  deamAudio: all || args.has('--deam-audio'),
  pmemo: all || args.has('--pmemo'),
}
if (!Object.values(want).some(Boolean)) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*|^ \* ?/gm, ''))
  process.exit(0)
}

const mb = (n) => (n / 1e6).toFixed(1)

async function download(url, dest, { expectMd5 = null, timeoutMs = 30 * 60_000 } = {}) {
  if (fs.existsSync(dest)) {
    console.log(`  have ${path.relative(root, dest)} (${mb(fs.statSync(dest).size)} MB), skipping download`)
    return true
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.part`
  let res
  try {
    res = await fetch(url, {
      redirect: 'follow',
      // Zenodo answers 403 to the bare default 'node' user agent.
      headers: { 'user-agent': 'AudioVis-eval/1.0 (internal research evaluation)' },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    console.log(`  FAILED to connect: ${e.cause?.code ?? e.name}: ${e.message}`)
    return false
  }
  if (!res.ok || !res.body) {
    console.log(`  FAILED: HTTP ${res.status} for ${url}`)
    return false
  }
  const total = Number(res.headers.get('content-length')) || 0
  let got = 0
  let nextMark = 10
  const hash = crypto.createHash('md5')
  const body = Readable.fromWeb(res.body)
  body.on('data', (c) => {
    got += c.length
    hash.update(c)
    if (total && (got / total) * 100 >= nextMark) {
      console.log(`  ${Math.min(100, Math.floor((got / total) * 100))}%  ${mb(got)} / ${mb(total)} MB`)
      nextMark += 10
    }
  })
  try {
    await pipeline(body, fs.createWriteStream(tmp))
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    console.log(`  FAILED mid-download: ${e.message}`)
    return false
  }
  if (total && got !== total) {
    fs.rmSync(tmp, { force: true })
    console.log(`  FAILED: got ${got} bytes, expected ${total}`)
    return false
  }
  const md5 = hash.digest('hex')
  if (expectMd5 && md5 !== expectMd5) {
    fs.rmSync(tmp, { force: true })
    console.log(`  FAILED: md5 ${md5} != expected ${expectMd5}`)
    return false
  }
  fs.renameSync(tmp, dest)
  console.log(`  saved ${path.relative(root, dest)} (${mb(got)} MB${expectMd5 ? ', md5 verified' : ''})`)
  return true
}

/** Extract a zip with the OS `tar` (bsdtar ships with Windows 10+ and macOS; GNU tar on Linux may lack zip support). */
function unzip(zip, into) {
  fs.mkdirSync(into, { recursive: true })
  // Git Bash's GNU tar reads "C:\..." as a remote host, so use Windows' own bsdtar there.
  const tarBin = process.platform === 'win32' && process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar'
  const r = spawnSync(tarBin, ['-xf', zip, '-C', into], { stdio: 'inherit' })
  if (r.status !== 0) {
    console.log(`  could not extract with tar (exit ${r.status}); unzip ${zip} into ${into} yourself`)
    return false
  }
  return true
}

const done = []

if (want.deamAnnotations) {
  console.log('DEAM annotations (Zenodo 11400122, cc-by-4.0)')
  const zip = path.join(out, 'deam', 'DEAM_Annotations.zip')
  const ok = await download('https://zenodo.org/records/11400122/files/DEAM_Annotations.zip?download=1', zip, {
    expectMd5: '31731747c2a52a3332c17f9dc9a4b1e8',
  })
  const dir = path.join(out, 'deam', 'annotations')
  const extracted = ok && (fs.existsSync(dir) && fs.readdirSync(dir).length > 0 ? true : unzip(zip, dir))
  done.push(['DEAM annotations', extracted])
}

if (want.deamAudio) {
  console.log('DEAM audio (official host)')
  const zip = path.join(out, 'deam', 'DEAM_audio.zip')
  let ok = fs.existsSync(zip)
  if (!ok) ok = await download('https://cvml.unige.ch/databases/DEAM/DEAM_audio.zip', zip, { timeoutMs: 20 * 60_000 })
  if (ok) {
    if (!fs.existsSync(path.join(out, 'deam', 'audio'))) unzip(zip, path.join(out, 'deam', 'audio'))
  } else {
    console.log('  The official host is unreachable. Manual route: download DEAM_audio.zip from the Kaggle mirror')
    console.log('  (imsparsh/deam-mediaeval-dataset-emotional-analysis-in-music), put it at')
    console.log(`  ${path.relative(process.cwd(), zip)} and run this again.`)
  }
  done.push(['DEAM audio', ok])
}

if (want.pmemo) {
  console.log('PMEmo (Hugging Face community mirror csdhbg/PMEmo2019; provenance and licence UNVERIFIED)')
  const zip = path.join(out, 'pmemo', 'PMEmo2019.zip')
  const ok = await download('https://huggingface.co/datasets/csdhbg/PMEmo2019/resolve/main/PMEmo2019.zip', zip)
  const dir = path.join(out, 'pmemo', 'extracted')
  const extracted = ok && (fs.existsSync(dir) && fs.readdirSync(dir).length > 0 ? true : unzip(zip, dir))
  done.push(['PMEmo', extracted])
}

console.log('')
for (const [name, ok] of done) console.log(`${ok ? 'ok    ' : 'FAILED'} ${name}`)
console.log('\nInternal evaluation only: non-commercial research data. Not for training shipped weights; do not redistribute.')
process.exitCode = done.every(([, ok]) => ok) ? 0 : 1
