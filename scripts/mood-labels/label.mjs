#!/usr/bin/env node
/**
 * Offline mood labelling via the Google Gemini API (audio understanding).
 * Sends each track once to the Files API, asks generateContent for STRUCTURED
 * mood labels, caches one JSON per track in corpus/labels/gemini/, deletes the
 * uploads again, and writes an aggregate _all.json.
 *
 * LLM labels are PRE-LABELS for human review, not ground truth.
 * Full usage, key setup and the privacy warning: scripts/mood-labels/README.md
 *
 * No dependencies; uses the global fetch of Node >= 18.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  API_BASE,
  BlockedError,
  SCHEMA_STYLES,
  aggregateSamples,
  backoffDelayMs,
  buildGenerateRequest,
  buildPrompt,
  estimateAudioTokens,
  estimateCostUsd,
  estimateDuration,
  extractText,
  formatTable,
  generateUrl,
  ASSUMED_OUTPUT_TOKENS,
  discoverTracks,
  apiErrorMessage,
  mimeForFile,
  parseArgs,
  parseJsonText,
  parseRetryDelayMs,
  priceFor,
  redact,
  resolveApiKey,
  reviewFlags,
  truncate,
  validateLabel,
  wavSlice,
} from './lib.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = path.resolve(HERE, '..', '..')
const MAX_WAIT_MS = 120_000
const GENERATE_TIMEOUT_MS = 600_000
const UPLOAD_TIMEOUT_MS = 900_000

const DATA_USE_WARNING =
  'WARNING: on the Gemini API FREE tier Google may use submitted audio/prompts to improve its products and human reviewers may read them; the PAID tier does not. ' +
  'Use a billing-enabled project for unreleased/private music. (Cannot detect your tier; silence with --i-understand-data-use.)'

const HELP = `Usage: node scripts/mood-labels/label.mjs [options]

Track selection
  --list                   list every known track and whether its audio exists locally
  --dir <path>             also/only (see --sources) label all audio files under <path> (repeatable; alias --calibration-dir)
  --sources <a,b>          testfolder,corpus,dir (default testfolder,corpus; with --dir the default is just dir)
  --only <substring>       keep tracks whose id/title/artist/file contains the substring
  --limit N                at most N tracks (after --only; only tracks with audio)

Labelling
  --samples N              independent passes per track (default 3; use 5 for the final eval set)
  --model <id>             Gemini model id (default gemini-3.8-flash; e.g. gemini-2.5-pro for a cross-check)
  --temperature T          sampling temperature (default: omitted = model default, which Google recommends for Gemini 3)
  --thinking-level L       minimal|low|medium|high (default: model default)
  --concurrency N          tracks in flight at once (default 2)
  --force                  re-label tracks that already have a cached JSON
  --keep-uploads           do not delete uploaded files at the end (they expire after 48 h anyway)
  --clip-seconds N         analyse only N seconds ...
  --clip-start S           ... starting at S seconds (default 0)
  --fallback-clip-seconds  clip length used when a full-track response is blocked (default 60)
  --max-retries N          HTTP retries on 429/5xx with exponential backoff (default 6)
  --schema-style S         responseSchema | responseJsonSchema | responseFormat (auto-falls-back on a 400)
  --out <dir>              output directory (default corpus/labels/gemini)
  --i-understand-data-use  silence the free-tier data-use warning

Other
  --dry-run                print the request payload, file sizes, token/cost estimates; nothing is sent
  --verbose                extra output
`

/** Error for a non-2xx HTTP response. */
export class HttpError extends Error {
  constructor(status, body, what) {
    super(`${what}: ${apiErrorMessage(status, body)}`)
    this.name = 'HttpError'
    this.status = status
    this.body = body
  }
}

const SCHEMA_ERR_RE = /response_?(mime_?type|schema|json_?schema|format)|unknown name|invalid json payload|schema/i
const AUTH_ERR_RE = /api key|API_KEY_INVALID|PERMISSION_DENIED|UNAUTHENTICATED/i

const fmtMB = (b) => (b == null ? '?' : `${(b / 1024 / 1024).toFixed(2)} MB`)
const fmtSec = (s) => (s == null ? '?' : `${s.toFixed(1)}s`)
const usd = (x) => (x == null ? 'n/a' : `$${x.toFixed(4)}`)
const posix = (p) => p.split(path.sep).join('/')

let ffmpegChecked = null
function hasFfmpeg() {
  if (ffmpegChecked === null) {
    try {
      ffmpegChecked = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
    } catch {
      ffmpegChecked = false
    }
  }
  return ffmpegChecked
}

/** Predict how a clip would be produced: 'wav' (sliced in JS), 'ffmpeg', or 'prompt' (whole file + instruction). */
function clipModeFor(track) {
  if (path.extname(track.audioPath).toLowerCase() === '.wav') return 'wav'
  return hasFfmpeg() ? 'ffmpeg' : 'prompt'
}

/**
 * Programmatic entry point (used by selftest.mjs with a mocked fetch).
 * @param {string[]} argv
 * @param {object} [ctx] {fetch, env, log, sleep, root, random, installSigint}
 * @returns {Promise<{exitCode: number, records: object[], failures: object[]}>}
 */
export async function run(argv, ctx = {}) {
  const doFetch = ctx.fetch ?? globalThis.fetch
  const env = ctx.env ?? process.env
  const sleep = ctx.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const random = ctx.random ?? Math.random
  const root = ctx.root ?? DEFAULT_ROOT
  const rawLog = ctx.log ?? ((...a) => console.log(...a))
  let secret = null
  const say = (...a) => rawLog(redact(a.join(' '), secret))

  let opts
  try {
    opts = parseArgs(argv)
  } catch (e) {
    say(`error: ${e.message}\n\n${HELP}`)
    return { exitCode: 2, records: [], failures: [] }
  }
  if (opts.help) {
    say(HELP)
    return { exitCode: 0, records: [], failures: [] }
  }

  // ---- discover + filter --------------------------------------------------
  let all
  try {
    all = discoverTracks({ root, sources: opts.sources, dirs: opts.dirs })
  } catch (e) {
    say(`error: ${e.message}`)
    return { exitCode: 2, records: [], failures: [] }
  }
  const needle = opts.only?.toLowerCase()
  const matches = needle
    ? all.filter((t) =>
        [t.trackId, t.title, t.artist ?? '', path.basename(t.audioPath), t.source].some((f) => f.toLowerCase().includes(needle)),
      )
    : all
  const outDir = opts.out ? path.resolve(opts.out) : path.join(root, 'corpus', 'labels', 'gemini')
  const cachePath = (t) => path.join(outDir, `${t.trackId}.json`)
  const isCached = (t) => fs.existsSync(cachePath(t))

  // ---- --list -------------------------------------------------------------
  if (opts.list) {
    const shown = Number.isFinite(opts.limit) ? matches.slice(0, opts.limit) : matches
    const rows = shown.map((t) => [
      t.source,
      t.trackId,
      t.metaDurationSec ? `${t.metaDurationSec.toFixed(0)}s` : '',
      t.exists ? fmtMB(t.sizeBytes) : '',
      isCached(t) ? 'labelled' : '',
      t.exists ? truncate(t.title, 44) : t.missingHint ?? 'audio missing',
    ])
    say(formatTable(['source', 'trackId', 'dur', 'size', 'cache', 'title / status'], rows))
    const bySource = {}
    for (const t of matches) {
      const b = (bySource[t.source] ??= { total: 0, present: 0, labelled: 0 })
      b.total++
      if (t.exists) b.present++
      if (isCached(t)) b.labelled++
    }
    say('')
    for (const [s, b] of Object.entries(bySource)) say(`${s}: ${b.total} tracks, ${b.present} with audio present, ${b.labelled} already labelled`)
    say(`cache dir: ${posix(path.relative(root, outDir)) || outDir}`)
    return { exitCode: 0, records: [], failures: [] }
  }

  // ---- select runnable tracks ---------------------------------------------
  const withAudio = matches.filter((t) => t.exists)
  const missing = matches.length - withAudio.length
  const selected = Number.isFinite(opts.limit) ? withAudio.slice(0, opts.limit) : withAudio
  if (!selected.length) {
    say(`No tracks with local audio matched (${matches.length} matched, ${missing} without audio).`)
    if (missing) say('For the Jamendo corpus run: npm run corpus:fetch')
    return { exitCode: 1, records: [], failures: [] }
  }

  // ---- shared per-track helpers ---------------------------------------------
  const durationOf = (t) => estimateDuration({ metaDurationSec: t.metaDurationSec, filePath: t.audioPath, sizeBytes: t.sizeBytes })
  const clipFor = (t, dur) => {
    if (!opts.clipSeconds) return null
    const start = opts.clipStart
    const seconds = dur.exact ? Math.max(1, Math.min(opts.clipSeconds, dur.sec - start)) : opts.clipSeconds
    return { startSec: start, seconds }
  }
  const fallbackClipFor = (dur) => {
    const n = opts.fallbackClipSeconds
    if (!(dur.sec > n * 1.05)) return null // already short: a clip would not change anything
    return { startSec: Math.max(0, Math.floor((dur.sec - n) / 2)), seconds: n }
  }
  const promptFor = (t, dur, clip, mode) => {
    if (clip) return buildPrompt({ clip: { ...clip, physical: mode !== 'prompt' } })
    return buildPrompt({ durationSec: dur.sec, durationExact: dur.exact })
  }

  // ---- --dry-run -----------------------------------------------------------
  if (opts.dryRun) {
    const style = opts.schemaStyle
    say('DRY RUN: nothing is uploaded or sent; no API key is needed.')
    say(`model=${opts.model}  samples=${opts.samples}  temperature=${opts.temperature ?? 'default (omitted)'}  schemaStyle=${style}  concurrency=${opts.concurrency}`)
    say(`selected ${selected.length} track(s) with audio; ${missing} matched track(s) skipped because audio is missing.`)
    const first = selected[0]
    const dur0 = durationOf(first)
    const clip0 = clipFor(first, dur0)
    const mode0 = clip0 ? clipModeFor(first) : null
    const payload = buildGenerateRequest({
      fileUri: '<uri returned by the Files API upload>',
      mimeType: mimeForFile(first.audioPath) ?? 'audio/mp3',
      prompt: promptFor(first, dur0, clip0, mode0),
      temperature: opts.temperature,
      schemaStyle: style,
      thinkingLevel: opts.thinkingLevel,
    })
    say('')
    say('Step 1  POST ' + `${API_BASE}/upload/v1beta/files   (resumable start)`)
    say('        headers: x-goog-api-key: <redacted>, X-Goog-Upload-Protocol: resumable, X-Goog-Upload-Command: start,')
    say('                 X-Goog-Upload-Header-Content-Length: <bytes>, X-Goog-Upload-Header-Content-Type: <mime>, Content-Type: application/json')
    say(`        body: ${JSON.stringify({ file: { display_name: first.trackId } })}`)
    say('Step 2  POST <x-goog-upload-url from step 1>   headers: X-Goog-Upload-Offset: 0, X-Goog-Upload-Command: upload, finalize')
    say('        body: <raw audio bytes, omitted>')
    say(`Step 3  GET  ${API_BASE}/v1beta/<file.name>   (poll until state ACTIVE)`)
    say(`Step 4  POST ${generateUrl(opts.model)}   (x${opts.samples} samples per track)`)
    say('        headers: x-goog-api-key: <redacted>, Content-Type: application/json')
    say(`        body (example for ${first.trackId}):`)
    say(JSON.stringify(payload, null, 2))
    say(`Step 5  DELETE ${API_BASE}/v1beta/<file.name>${opts.keepUploads ? '   (SKIPPED: --keep-uploads)' : ''}`)
    say('')
    let totalSec = 0
    let totalIn = 0
    let totalCost = 0
    let priced = true
    const rows = selected.map((t) => {
      const dur = durationOf(t)
      const clip = clipFor(t, dur)
      const mode = clip ? clipModeFor(t) : null
      const billedSec = clip && mode !== 'prompt' ? clip.seconds : dur.sec
      const tokens = estimateAudioTokens(billedSec)
      const cost = estimateCostUsd(opts.model, tokens * opts.samples, ASSUMED_OUTPUT_TOKENS * opts.samples)
      totalSec += billedSec
      totalIn += tokens * opts.samples
      if (cost == null) priced = false
      else totalCost += cost
      return [
        t.trackId,
        `${fmtSec(billedSec)}${dur.exact ? '' : '~'}`,
        fmtMB(t.sizeBytes),
        tokens,
        usd(cost),
        [isCached(t) && !opts.force ? 'cached: would skip' : '', clip ? `clip ${clip.startSec}+${clip.seconds}s (${mode})` : ''].filter(Boolean).join('; '),
      ]
    })
    say(formatTable(['trackId', 'audio', 'file size', 'audio tokens/pass', `est. cost x${opts.samples}`, 'note'], rows))
    say('')
    say(
      `Total: ${(totalSec / 60).toFixed(1)} min of audio, ${totalIn.toLocaleString('en-US')} input tokens across ${opts.samples} pass(es) at 32 tokens/s` +
        (priced ? `, estimated ${usd(totalCost)} on the paid tier (assumes ~${ASSUMED_OUTPUT_TOKENS} output tokens/pass incl. thinking; upper bound if cached tracks are skipped)` : ', cost unknown for this model (no verified price in lib.mjs)') +
        '.',
    )
    if (priceFor(opts.model, new Date('2027-01-02')) && priceFor(opts.model, new Date()) !== priceFor(opts.model, new Date('2027-01-02')))
      say('Note: gemini-3.8-flash list prices double on 2027-01-01 (docs: $0.75/$3.75 through 2026-12-31, $1.50/$7.50 after, per 1M input/output tokens).')
    if (opts.dirs.length) say('Files in --dir folders that are not audio (mp3/wav/flac/m4a/ogg/opus) are ignored.')
    return { exitCode: 0, records: [], failures: [] }
  }

  // ---- real run: resolve key ---------------------------------------------------
  let envFileText = null
  try {
    envFileText = fs.readFileSync(path.join(root, '.env.local'), 'utf8')
  } catch {
    /* no .env.local */
  }
  const found = resolveApiKey(env, envFileText)
  if (!found) {
    say('error: no API key. Set GEMINI_API_KEY (or GOOGLE_API_KEY) in the environment, or put GEMINI_API_KEY=... in the gitignored .env.local at the repo root.')
    say('Create/find a key at https://aistudio.google.com/apikey  (see scripts/mood-labels/README.md).')
    return { exitCode: 2, records: [], failures: [] }
  }
  const key = found.key
  secret = key
  say(`API key: using ${found.source}` + (key.startsWith('AIza') ? '' : "  (note: does not start with 'AIza', unusual for an AI Studio key)"))
  if (!opts.ackDataUse) say(DATA_USE_WARNING)
  say(`model=${opts.model}  samples=${opts.samples}  temperature=${opts.temperature ?? 'default'}  concurrency=${opts.concurrency}  tracks=${selected.length}${missing ? `  (skipped ${missing} without audio)` : ''}`)
  fs.mkdirSync(outDir, { recursive: true })

  const state = { schemaStyle: opts.schemaStyle, fatal: false, quotaExhausted: false }
  const pendingUploads = new Set()

  // ---- HTTP with retry -----------------------------------------------------------
  async function fetchRetry(url, init, what, timeoutMs = GENERATE_TIMEOUT_MS) {
    for (let attempt = 0; ; attempt++) {
      let resp = null
      let netErr = null
      try {
        resp = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
      } catch (e) {
        netErr = e
      }
      if (resp?.ok) return resp
      const status = resp?.status ?? 0
      const bodyText = resp ? await resp.text().catch(() => '') : ''
      // A PER-DAY quota will not clear in seconds: retrying only burns minutes. Fail fast so
      // the caller (overnight.mjs) can rotate to another model or wait for the reset.
      if (status === 429 && /PerDay/i.test(bodyText)) {
        const err = new HttpError(status, bodyText, what)
        err.dailyQuota = true
        // Set the flag HERE: callers (samplePass) swallow per-sample errors into "all passes failed",
        // which would lose it. The worker loop reads state.quotaExhausted and stops the pass.
        state.quotaExhausted = true
        throw err
      }
      const retryable = netErr ? true : [408, 429, 500, 502, 503, 504].includes(status)
      if (!retryable || attempt >= opts.maxRetries) {
        if (netErr) throw new Error(`${what}: network error: ${netErr.cause?.code ?? netErr.name}: ${netErr.message}`)
        throw new HttpError(status, bodyText, what)
      }
      const server = resp ? parseRetryDelayMs(resp.headers, bodyText) : null
      const delay = Math.min(MAX_WAIT_MS, Math.max(server ?? 0, backoffDelayMs(attempt, { jitter: random() })))
      say(`  ${what}: ${netErr ? `network error (${netErr.name})` : `HTTP ${status}`}, retry ${attempt + 1}/${opts.maxRetries} in ${(delay / 1000).toFixed(1)}s`)
      await sleep(delay)
    }
  }

  // ---- Files API -------------------------------------------------------------------
  async function uploadFile(bytes, mime, displayName) {
    const start = await fetchRetry(
      `${API_BASE}/upload/v1beta/files`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': key,
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': String(bytes.length),
          'X-Goog-Upload-Header-Content-Type': mime,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ file: { display_name: displayName } }),
      },
      'upload(start)',
      60_000,
    )
    const uploadUrl = start.headers.get('x-goog-upload-url')
    if (!uploadUrl) throw new Error('upload(start): response had no x-goog-upload-url header')
    const fin = await fetchRetry(
      uploadUrl,
      { method: 'POST', headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' }, body: bytes },
      'upload(finalize)',
      UPLOAD_TIMEOUT_MS,
    )
    let file = (await fin.json())?.file
    if (!file?.name || !file?.uri) throw new Error('upload(finalize): response had no file.name/file.uri')
    pendingUploads.add(file.name)
    for (let i = 0; file.state === 'PROCESSING' && i < 90; i++) {
      await sleep(2000)
      const r = await fetchRetry(`${API_BASE}/v1beta/${file.name}`, { method: 'GET', headers: { 'x-goog-api-key': key } }, 'files.get', 60_000)
      file = await r.json()
    }
    if (file.state && file.state !== 'ACTIVE') throw new Error(`uploaded file is in state ${file.state}`)
    return file
  }

  async function deleteFile(name) {
    try {
      await fetchRetry(`${API_BASE}/v1beta/${name}`, { method: 'DELETE', headers: { 'x-goog-api-key': key } }, 'files.delete', 60_000)
    } catch (e) {
      say(`  warning: could not delete ${name}: ${e.message} (it expires on its own after 48 h)`)
    } finally {
      pendingUploads.delete(name)
    }
  }

  if (ctx.installSigint) {
    process.once('SIGINT', async () => {
      say(`\nInterrupted; deleting ${pendingUploads.size} uploaded file(s)...`)
      await Promise.all([...pendingUploads].map(deleteFile))
      process.exit(130)
    })
  }

  // ---- generateContent -----------------------------------------------------------------
  async function callGenerate(fileUri, mime, prompt) {
    const tried = new Set()
    for (;;) {
      tried.add(state.schemaStyle)
      const body = buildGenerateRequest({
        fileUri,
        mimeType: mime,
        prompt,
        temperature: opts.temperature,
        schemaStyle: state.schemaStyle,
        thinkingLevel: opts.thinkingLevel,
      })
      try {
        const resp = await fetchRetry(
          generateUrl(opts.model),
          { method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
          'generateContent',
        )
        return await resp.json()
      } catch (e) {
        if (e instanceof HttpError && e.status === 400 && SCHEMA_ERR_RE.test(e.body) && !AUTH_ERR_RE.test(e.body)) {
          const next = SCHEMA_STYLES.find((s) => !tried.has(s))
          if (next) {
            say(`  schema style "${state.schemaStyle}" was rejected by the API (${apiErrorMessage(e.status, e.body).slice(0, 160)}); trying "${next}"`)
            state.schemaStyle = next
            continue
          }
        }
        throw e
      }
    }
  }

  /** One labelling pass. Returns {label, warnings, usage, finishReason}; throws BlockedError or Error. */
  async function samplePass(fileUri, mime, prompt, durationForClamp) {
    let lastProblem = ''
    for (let attempt = 0; attempt < 2; attempt++) {
      const resp = await callGenerate(fileUri, mime, prompt)
      const usage = resp.usageMetadata ?? {}
      const finishReason = resp.candidates?.[0]?.finishReason ?? null
      let text
      try {
        text = extractText(resp)
      } catch (e) {
        if (e instanceof BlockedError) throw e
        lastProblem = e.message
        continue
      }
      let parsed
      try {
        parsed = parseJsonText(text)
      } catch (e) {
        lastProblem = `invalid JSON (${e.message.slice(0, 80)})`
        continue
      }
      const v = validateLabel(parsed, { durationSec: durationForClamp })
      if (!v.ok) {
        lastProblem = `schema validation failed: ${v.errors.join('; ')}`
        continue
      }
      return { label: v.value, warnings: v.warnings, usage, finishReason }
    }
    throw new Error(`no valid label after retry: ${lastProblem}`)
  }

  /** Materialise the audio (or clip) to upload. */
  function prepareSource(t, clip) {
    const mime = mimeForFile(t.audioPath)
    const whole = () => ({ bytes: fs.readFileSync(t.audioPath), mime, physical: false, mode: 'full' })
    if (!clip) return { ...whole(), mode: 'full' }
    const mode = clipModeFor(t)
    if (mode === 'wav') {
      const sliced = wavSlice(fs.readFileSync(t.audioPath), clip.startSec, clip.seconds)
      if (sliced) return { bytes: sliced, mime: 'audio/wav', physical: true, mode: 'wav' }
    } else if (mode === 'ffmpeg') {
      const tmp = path.join(os.tmpdir(), `mood-clip-${process.pid}-${Date.now()}${path.extname(t.audioPath)}`)
      const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(clip.startSec), '-t', String(clip.seconds), '-i', t.audioPath, '-vn', '-c', 'copy', tmp], { stdio: 'ignore' })
      try {
        if (r.status === 0 && fs.existsSync(tmp)) return { bytes: fs.readFileSync(tmp), mime, physical: true, mode: 'ffmpeg' }
      } finally {
        fs.rmSync(tmp, { force: true })
      }
    }
    return { ...whole(), mode: 'prompt' } // whole file + "analyse only this window" instruction
  }

  /**
   * Upload once, run all passes, delete the upload. Returns aggregated result or
   * {blocked:true,...} when every pass was filtered.
   */
  async function analyse(t, dur, clip) {
    const src = prepareSource(t, clip)
    const clipInfo = clip ? { ...clip, physical: src.physical, mode: src.mode } : null
    const prompt = clip ? buildPrompt({ clip: { ...clip, physical: src.physical } }) : buildPrompt({ durationSec: dur.sec, durationExact: dur.exact })
    const clampSec = clip ? clip.seconds : dur.exact ? dur.sec : null
    const file = await uploadFile(src.bytes, src.mime, t.trackId)
    const passes = []
    const notes = []
    const blockedReasons = []
    let failedPasses = 0
    try {
      for (let i = 0; i < opts.samples; i++) {
        try {
          passes.push(await samplePass(file.uri, file.mimeType ?? src.mime, prompt, clampSec))
        } catch (e) {
          if (e instanceof BlockedError) {
            blockedReasons.push(e.reason)
            notes.push(`pass ${i + 1}: blocked (${e.reason})`)
          } else if (e instanceof HttpError && (e.status === 401 || e.status === 403 || (e.status === 400 && AUTH_ERR_RE.test(e.body)))) {
            state.fatal = true
            throw new Error(`${e.message} - API key rejected; check GEMINI_API_KEY (see README "Testing your key")`)
          } else {
            failedPasses++
            notes.push(`pass ${i + 1}: ${e.message}`)
            if (!passes.length && failedPasses >= 2) throw e // do not burn more passes on a track that keeps failing
          }
        }
      }
    } finally {
      if (!opts.keepUploads) await deleteFile(file.name)
    }
    return { passes, notes, blockedReasons, failedPasses, bytes: src.bytes.length, clip: clipInfo }
  }

  // ---- per-track pipeline ---------------------------------------------------------------
  const records = []
  const failures = []

  async function processTrack(t) {
    const tag = `[${t.trackId}]`
    if (!opts.force && isCached(t)) {
      const rec = JSON.parse(fs.readFileSync(cachePath(t), 'utf8'))
      records.push(rec)
      say(`${tag} cached (${rec.model}, ${rec.samples} samples); use --force to redo`)
      return
    }
    const dur = durationOf(t)
    say(`${tag} labelling ${truncate(t.title, 40)}  (${fmtSec(dur.sec)}${dur.exact ? '' : ' est.'}, ${fmtMB(t.sizeBytes)}, ${opts.samples} pass(es))`)
    try {
      let res = await analyse(t, dur, clipFor(t, dur))
      let fellBack = null
      if (!res.passes.length && res.blockedReasons.length && !opts.clipSeconds) {
        const clip = fallbackClipFor(dur)
        if (clip) {
          say(`${tag} blocked (${[...new Set(res.blockedReasons)].join(', ')}); retrying once with a ${clip.seconds}s clip from ${clip.startSec}s`)
          fellBack = { originalBlockReasons: [...new Set(res.blockedReasons)] }
          const second = await analyse(t, dur, clip)
          second.notes = [...res.notes.map((n) => `full track: ${n}`), ...second.notes.map((n) => `clip: ${n}`)]
          res = second
        }
      }
      const base = {
        schemaVersion: 1,
        trackId: t.trackId,
        source: t.source,
        title: t.title,
        artist: t.artist,
        file: t.source === 'dir' ? t.title : posix(path.relative(root, t.audioPath)),
        jamendoId: t.jamendoId,
        jamendoTags: t.moodTheme,
        model: opts.model,
        generatedAt: (ctx.now ? ctx.now() : new Date()).toISOString(),
        requestedSamples: opts.samples,
        temperature: opts.temperature ?? 'default',
        thinkingLevel: opts.thinkingLevel ?? 'default',
        durationSec: dur.sec,
        durationExact: dur.exact,
        audioBytes: res.bytes,
        clip: res.clip,
        fellBackToClip: fellBack,
      }
      let rec
      if (!res.passes.length) {
        if (!res.blockedReasons.length) throw new Error(`all passes failed: ${res.notes.join(' | ')}`)
        rec = { ...base, status: 'blocked', samples: 0, blocked: { reasons: [...new Set(res.blockedReasons)], notes: res.notes }, label: null, spread: null, needsReview: true, reviewReasons: ['blocked by the API content filter'] }
        say(`${tag} BLOCKED by the API (${rec.blocked.reasons.join(', ')}); recorded as blocked, not failed`)
      } else {
        const { label, spread } = aggregateSamples(res.passes.map((p) => p.label))
        const flags = reviewFlags(label, spread)
        const usage = res.passes.reduce(
          (a, p) => ({
            promptTokens: a.promptTokens + (p.usage.promptTokenCount ?? 0),
            outputTokens: a.outputTokens + (p.usage.candidatesTokenCount ?? 0),
            thoughtsTokens: a.thoughtsTokens + (p.usage.thoughtsTokenCount ?? 0),
            totalTokens: a.totalTokens + (p.usage.totalTokenCount ?? 0),
          }),
          { promptTokens: 0, outputTokens: 0, thoughtsTokens: 0, totalTokens: 0 },
        )
        rec = {
          ...base,
          status: 'ok',
          samples: res.passes.length,
          failedSamples: res.failedPasses,
          blockedSamples: res.blockedReasons.length,
          finishReasons: res.passes.map((p) => p.finishReason),
          usage,
          label,
          spread,
          ...flags,
          warnings: [...new Set(res.passes.flatMap((p) => p.warnings)), ...res.notes],
          rawSamples: res.passes.map((p) => p.label),
        }
        say(`${tag} ok: ${label.primaryMood}${label.secondaryMood ? `/${label.secondaryMood}` : ''}  V${label.valence.toFixed(1)} A${label.arousal.toFixed(1)} T${label.tension.toFixed(1)}  conf ${label.confidence.toFixed(2)}${flags.needsReview ? '  NEEDS REVIEW' : ''}`)
      }
      const tmp = `${cachePath(t)}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n')
      fs.renameSync(tmp, cachePath(t))
      records.push(rec)
    } catch (e) {
      if (e.dailyQuota) state.quotaExhausted = true
      failures.push({ trackId: t.trackId, error: redact(e.message, key) })
      say(`${tag} FAILED: ${e.message}`)
    }
  }

  const queue = [...selected]
  const workers = Array.from({ length: Math.min(opts.concurrency, queue.length) }, async () => {
    while (queue.length && !state.fatal && !state.quotaExhausted) await processTrack(queue.shift())
  })
  await Promise.all(workers)
  if (state.quotaExhausted) say(`Stopped early: daily quota exhausted for ${opts.model}; ${queue.length} track(s) not attempted.`)
  if (state.fatal && queue.length) say(`Stopped early: ${queue.length} track(s) not attempted because the API key was rejected.`)

  // ---- aggregate _all.json + summary --------------------------------------------------------
  const allRecords = fs
    .readdirSync(outDir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort()
    .map((f) => {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'))
        delete r.rawSamples
        return r
      } catch {
        return null
      }
    })
    .filter(Boolean)
  fs.writeFileSync(path.join(outDir, '_all.json'), JSON.stringify(allRecords, null, 2) + '\n')

  const rows = records
    .slice()
    .sort((a, b) => a.trackId.localeCompare(b.trackId, undefined, { numeric: true }))
    .map((r) =>
      r.status === 'blocked'
        ? [truncate(r.title ?? r.trackId, 30), 'BLOCKED', '', '', '', r.blocked.reasons.join(',')]
        : [
            truncate(r.title ?? r.trackId, 30),
            r.label.primaryMood + (r.label.secondaryMood ? `/${r.label.secondaryMood}` : ''),
            `${r.label.valence.toFixed(1)}/${r.label.arousal.toFixed(1)}/${r.label.tension.toFixed(1)}`,
            r.label.confidence.toFixed(2),
            `${Math.round(r.spread.moodAgreement * r.spread.n)}/${r.spread.n}`,
            r.needsReview ? `REVIEW: ${r.reviewReasons.join('; ')}` : '',
          ],
    )
  say('')
  say(formatTable(['track', 'primary/secondary', 'V/A/T', 'conf', 'mood agree', 'flag'], rows))
  say('')
  const nBlocked = records.filter((r) => r.status === 'blocked').length
  const nReview = records.filter((r) => r.needsReview && r.status === 'ok').length
  say(`${records.length} record(s) this run, ${failures.length} failed, ${nBlocked} blocked, ${nReview} need review. Wrote ${posix(path.relative(root, path.join(outDir, '_all.json'))) || '_all.json'} (${allRecords.length} tracks).`)
  say('Reminder: these are LLM pre-labels for human review, not ground truth.')
  if (failures.length) for (const f of failures) say(`  failed: ${f.trackId}: ${f.error}`)
  // Exit codes: 0 all fine, 1 some failed / key rejected, 3 daily quota exhausted for this model.
  return { exitCode: state.fatal ? 1 : state.quotaExhausted ? 3 : failures.length ? 1 : 0, records, failures }
}

// ---- CLI --------------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2), { installSigint: true }).then(
    (r) => {
      process.exitCode = r.exitCode
    },
    (e) => {
      console.error(`fatal: ${e?.stack ?? e}`.replace(process.env.GEMINI_API_KEY ?? '\u0000', '[REDACTED]').replace(process.env.GOOGLE_API_KEY ?? '\u0000', '[REDACTED]'))
      process.exitCode = 1
    },
  )
}
