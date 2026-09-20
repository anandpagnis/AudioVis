#!/usr/bin/env node
/**
 * Unattended runner for the Gemini mood labeller: start it, go to sleep, read
 * corpus/labels/OVERNIGHT-REPORT.md in the morning.
 *
 * It only orchestrates `label.mjs` (which does the real work, per-track
 * caching and the per-request retries) and adds what a long unattended run needs:
 *
 *   COVERAGE FIRST   Stage 1 gets ONE label for every track (1 sample, low
 *                    thinking), so a stall or a dead laptop still leaves a full
 *                    set. Stage 2 then upgrades tracks to N samples one at a
 *                    time, keeping the old record if the upgrade fails.
 *   PASS LOOP        A pass over all tracks repeats until every track has a
 *                    record, the time budget runs out, or the key is rejected.
 *                    Failed tracks are never cached, so each pass retries them.
 *   BACKOFF          A pass that makes no progress (rate limit / errors) waits
 *                    5, 10, 20, 40, then 60 min (capped) before trying again.
 *   MODEL LADDER     The free tier caps each model at ~20 requests/day. When a pass
 *                    hits a daily cap, label.mjs stops at once (exit 3) and the runner
 *                    moves to the next model in the ladder (own quota bucket), re-probing
 *                    exhausted models every few hours. Records say which model made them;
 *                    the report flags a mixed set. --single-model disables rotation.
 *   SAFETY           One instance at a time (lock file), a hard time budget,
 *                    a spend cap, a per-pass timeout, restore-on-failed-upgrade,
 *                    state on disk after every track, the key never logged.
 *
 * Re-running is always safe: it resumes from whatever is cached.
 *
 * Usage:
 *   node scripts/mood-labels/overnight.mjs [--samples 3] [--budget-hours 10]
 *        [--max-usd 15] [--sources testfolder,corpus] [--models a,b,c | --single-model]
 *   Needs GEMINI_API_KEY (or GOOGLE_API_KEY) in the environment or .env.local.
 *   On Windows prefer overnight.ps1 (keeps the PC awake, asks for the key).
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DEFAULT_MODEL, discoverTracks, estimateCostUsd, redact } from './lib.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = path.resolve(HERE, '..', '..')
const MIN = 60_000

/**
 * Best first. Every model here was seen to accept audio-capable generateContent
 * calls (text probe, thinkingLevel=low) on the user's key on 2026-09-19; each has its
 * own daily bucket. gemini-2.5-flash is deliberately absent: the API answers
 * "no longer available to new users".
 */
export const DEFAULT_LADDER = [
  DEFAULT_MODEL,
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest',
]

const HELP = `Unattended Gemini mood-labelling runner (wraps label.mjs).

  --samples N            samples per track after stage 2 (default 3)
  --budget-hours H       stop starting new work after H hours (default 10)
  --max-usd X            stop when estimated spend exceeds X (default 15)
  --sources a,b          testfolder,corpus (default)
  --models a,b,c         model ladder, best first (default: ${DEFAULT_LADDER.join(', ')})
  --model M              use only this one model (same as --models M)
  --single-model         never rotate to another model; wait for the daily reset instead
  --exhaust-retry-min N  re-probe a model that hit its daily cap after N minutes (default 180)
  --thinking-level L     minimal|low|medium|high (default low)
  --pass-timeout-min N   kill a single label.mjs pass after N minutes (default 240)
  --wait-min N           first wait after a no-progress pass, minutes (default 5)
  --wait-max-min N       cap on that wait (default 60)
  --max-passes N         hard cap on label.mjs invocations (default 400)
  --skip-topup           stage 1 only
  --out DIR              label cache dir (default corpus/labels/gemini)
  --label-script PATH    label.mjs to drive (tests)
  --wait-scale X         multiply all waits by X (tests)
  --dry-run              print the plan and exit`

export function parseArgs(argv) {
  const o = {
    samples: 3, budgetHours: 10, maxUsd: 15, sources: ['testfolder', 'corpus'],
    models: [...DEFAULT_LADDER], singleModel: false, exhaustRetryMin: 180, thinkingLevel: 'low',
    passTimeoutMin: 240, waitMin: 5, waitMaxMin: 60, maxPasses: 400, skipTopup: false,
    out: null, labelScript: path.join(HERE, 'label.mjs'), waitScale: 1, dryRun: false, help: false,
    trackIds: null,
  }
  const num = (name, v) => {
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} needs a non-negative number`)
    return n
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`)
      return argv[++i]
    }
    switch (a) {
      case '--samples': o.samples = Math.max(1, Math.round(num(a, val()))); break
      case '--budget-hours': o.budgetHours = num(a, val()); break
      case '--max-usd': o.maxUsd = num(a, val()); break
      case '--sources': o.sources = val().split(',').map((s) => s.trim()).filter(Boolean); break
      case '--models': o.models = val().split(',').map((s) => s.trim()).filter(Boolean); break
      case '--model': o.models = [val()]; break
      case '--single-model': o.singleModel = true; break
      case '--exhaust-retry-min': o.exhaustRetryMin = num(a, val()); break
      case '--thinking-level': o.thinkingLevel = val(); break
      case '--pass-timeout-min': o.passTimeoutMin = num(a, val()); break
      case '--wait-min': o.waitMin = num(a, val()); break
      case '--wait-max-min': o.waitMaxMin = num(a, val()); break
      case '--max-passes': o.maxPasses = Math.round(num(a, val())); break
      case '--skip-topup': o.skipTopup = true; break
      case '--out': o.out = val(); break
      case '--label-script': o.labelScript = path.resolve(val()); break
      case '--wait-scale': o.waitScale = num(a, val()); break
      case '--track-ids': o.trackIds = val().split(',').filter(Boolean); break // tests
      case '--dry-run': o.dryRun = true; break
      case '-h': case '--help': o.help = true; break
      default: throw new Error(`unknown argument: ${a}`)
    }
  }
  for (const s of o.sources) if (!['testfolder', 'corpus'].includes(s)) throw new Error(`unknown source "${s}"`)
  if (!o.models.length) throw new Error('--models needs at least one model')
  if (o.singleModel) o.models = o.models.slice(0, 1)
  return o
}

/** Wait after the Nth consecutive no-progress pass (0-based): base, 2x, 4x ... capped. */
export function waitMinutes(streak, { waitMin = 5, waitMaxMin = 60 } = {}) {
  return Math.min(waitMaxMin, waitMin * 2 ** Math.max(0, streak))
}

/**
 * Models that may be tried now, in ladder order. `state` maps model ->
 * { exhaustedAt: ms|null, disabled: bool }. A model that hit its daily cap is
 * skipped until `retryMs` has passed (then it is probed again: a still-exhausted
 * model fails after ONE request, so probing is cheap).
 */
export function availableModels(ladder, state, now, retryMs) {
  return ladder.filter((m) => {
    const s = state[m]
    if (!s) return true
    if (s.disabled) return false
    return s.exhaustedAt == null || now - s.exhaustedAt >= retryMs
  })
}

/** Classify a finished label.mjs pass from its exit code and output. */
export function classifyPass({ code, out, timedOut }) {
  const text = out ?? ''
  if (/API key was rejected|API key not valid|API_KEY_INVALID/i.test(text)) return 'fatal-key'
  if (code === 2) return 'fatal-config'
  if (timedOut) return 'timeout'
  if (code === 3 || /daily quota exhausted/i.test(text)) return 'daily-quota'
  if (/HTTP 429|RESOURCE_EXHAUSTED|quota/i.test(text)) return code === 0 ? 'ok' : 'quota'
  return code === 0 ? 'ok' : 'errors'
}

export async function main(argv, ctx = {}) {
  let o
  try {
    o = parseArgs(argv)
  } catch (e) {
    console.error(`error: ${e.message}\n\n${HELP}`)
    return 2
  }
  if (o.help) {
    console.log(HELP)
    return 0
  }
  const root = ctx.root ?? DEFAULT_ROOT
  const outDir = path.resolve(o.out ?? path.join(root, 'corpus', 'labels', 'gemini'))
  const labelsDir = path.dirname(outDir)
  fs.mkdirSync(outDir, { recursive: true })
  const logPath = path.join(labelsDir, 'overnight.log')
  const reportPath = path.join(labelsDir, 'OVERNIGHT-REPORT.md')
  const lockPath = path.join(outDir, '.overnight.lock')
  const sleep = ctx.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const secrets = () => [process.env.GEMINI_API_KEY, process.env.GOOGLE_API_KEY].filter(Boolean)
  const log = (msg) => {
    let line = `${new Date().toISOString()}  ${msg}`
    for (const s of secrets()) line = redact(line, s)
    console.log(line)
    try {
      fs.appendFileSync(logPath, line + '\n')
    } catch {
      /* logging must never kill the run */
    }
  }

  // ---- tracks --------------------------------------------------------------
  let tracks
  if (o.trackIds) tracks = o.trackIds.map((trackId) => ({ trackId, title: trackId, tags: [] }))
  else {
    tracks = discoverTracks({ root, sources: o.sources })
      .filter((t) => t.exists)
      .map((t) => ({ trackId: t.trackId, title: t.title, tags: t.moodTheme ?? [], source: t.source }))
  }
  if (!tracks.length) {
    console.error('No tracks with local audio found. Run `node corpus/select-eval-set.mjs` first.')
    return 2
  }
  const recPath = (id) => path.join(outDir, `${id}.json`)
  const readRec = (id) => {
    try {
      return JSON.parse(fs.readFileSync(recPath(id), 'utf8'))
    } catch {
      return null
    }
  }
  const pending = () => tracks.filter((t) => !fs.existsSync(recPath(t.trackId)))

  if (o.dryRun) {
    console.log(`Plan: ${tracks.length} tracks (${pending().length} without a label yet); models: ${o.models.join(' > ')}; ` +
      `stage 2 -> ${o.samples} samples${o.skipTopup ? ' (skipped)' : ''}; budget ${o.budgetHours} h / $${o.maxUsd}.`)
    return 0
  }

  // ---- single instance -----------------------------------------------------
  if (fs.existsSync(lockPath)) {
    let pid = 0
    try {
      pid = JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid
    } catch {
      /* corrupt lock: treat as stale */
    }
    let alive = false
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0)
        alive = true
      } catch {
        alive = false
      }
    }
    if (alive) {
      console.error(`Another overnight run is active (pid ${pid}). Stop it first, or delete ${lockPath} if it is stale.`)
      return 2
    }
  }
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }))

  const started = Date.now()
  const deadline = started + o.budgetHours * 60 * MIN
  const stats = { passes: 0, quotaPasses: 0, upgrades: 0, upgradeFailures: 0, restored: 0, fatal: null, stopped: null }
  const modelState = {}
  const retryMs = o.exhaustRetryMin * MIN
  let idle = 0 // waits taken; counted against --max-passes so a wait loop can never spin forever
  /** Minutes until the earliest exhausted model may be probed again (>= 1). */
  const minutesUntilRetry = (cap) => {
    const times = Object.values(modelState).filter((s) => s.exhaustedAt != null && !s.disabled).map((s) => s.exhaustedAt + retryMs - Date.now())
    const until = times.length ? Math.ceil(Math.min(...times) / MIN) : cap
    return Math.max(1, Math.min(cap, until))
  }
  const exhaust = (m) => {
    modelState[m] = { ...(modelState[m] ?? {}), exhaustedAt: Date.now() }
    log(`model ${m}: daily quota exhausted; rotating (will re-probe in ${o.exhaustRetryMin} min)`)
  }
  const usable = () => availableModels(o.models, modelState, Date.now(), retryMs)
  let child = null
  let aborted = false
  const onSignal = (sig) => {
    aborted = true
    stats.stopped = `signal ${sig}`
    log(`received ${sig}; stopping after the current step`)
    if (child) child.kill()
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  const timeLeft = () => deadline - Date.now()
  const spend = () => {
    let usd = 0
    for (const t of tracks) {
      const r = readRec(t.trackId)
      const u = r?.usage
      if (u) usd += estimateCostUsd(r.model, u.promptTokens ?? 0, (u.outputTokens ?? 0) + (u.thoughtsTokens ?? 0))
    }
    return usd
  }

  function spawnLabel(args, timeoutMs) {
    return new Promise((resolve) => {
      stats.passes++
      const c = spawn(process.execPath, ['--max-old-space-size=768', o.labelScript, ...args], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: root,
      })
      child = c
      let out = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        c.kill()
      }, Math.max(1000, timeoutMs))
      let buf = ''
      const feed = (chunk) => {
        const s = chunk.toString()
        out = (out + s).slice(-200_000)
        buf += s
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trimEnd()
          buf = buf.slice(nl + 1)
          if (line) log(`  | ${line}`)
        }
      }
      c.stdout.on('data', feed)
      c.stderr.on('data', feed)
      c.on('error', (e) => {
        clearTimeout(timer)
        child = null
        resolve({ code: 2, out: `${out}\nspawn error: ${e.message}`, timedOut: false })
      })
      c.on('close', (code) => {
        clearTimeout(timer)
        child = null
        resolve({ code: code ?? 1, out, timedOut })
      })
    })
  }

  const baseArgs = (model, samples) => [
    '--sources', o.sources.join(','), '--samples', String(samples), '--concurrency', '1',
    '--max-retries', '6', '--i-understand-data-use', '--model', model, '--out', outDir,
    '--thinking-level', o.thinkingLevel,
  ]

  // ---- stage 1: coverage ---------------------------------------------------
  log(`overnight start: ${tracks.length} tracks, ${pending().length} unlabelled, models ${o.models.join(' > ')}, ` +
    `budget ${o.budgetHours} h, cap $${o.maxUsd}`)
  let streak = 0
  while (!aborted && !stats.fatal && pending().length && stats.passes + idle < o.maxPasses) {
    if (timeLeft() <= 0) {
      stats.stopped = 'time budget reached during stage 1'
      break
    }
    if (spend() > o.maxUsd) {
      stats.stopped = `spend cap $${o.maxUsd} reached`
      break
    }
    const ready = usable()
    if (!ready.length) {
      const w = minutesUntilRetry(waitMinutes(streak, o))
      streak++
      idle++
      log(`every model is at its daily cap; waiting ${w} min (quotas reset daily)`)
      writeReport()
      await sleep(w * MIN * o.waitScale)
      continue
    }
    const model = ready[0]
    const before = pending().length
    log(`stage 1 pass ${stats.passes + 1}: ${before} track(s) unlabelled, model ${model}${model !== o.models[0] ? ' (LADDER FALLBACK)' : ''}`)
    const res = await spawnLabel(baseArgs(model, 1), Math.min(o.passTimeoutMin * MIN, timeLeft()))
    const kind = classifyPass(res)
    const progress = before - pending().length
    log(`stage 1 pass result: ${kind}, +${progress} label(s), ${pending().length} left`)
    if (kind === 'fatal-key') {
      stats.fatal = 'the API key was rejected'
      break
    }
    if (kind === 'fatal-config') {
      stats.fatal = 'label.mjs reported a configuration error (exit 2); see the log'
      break
    }
    if (kind === 'daily-quota') {
      stats.quotaPasses++
      exhaust(model)
      streak = 0
      continue // try the next model straight away
    }
    if (kind === 'quota') stats.quotaPasses++
    if (!pending().length) break
    if (progress > 0) {
      streak = 0
      await sleep(30_000 * o.waitScale)
    } else {
      const w = waitMinutes(streak, o)
      streak++
      idle++
      log(`no progress (${kind}); waiting ${w} min before the next pass`)
      writeReport()
      await sleep(w * MIN * o.waitScale)
    }
  }

  // ---- stage 2: upgrade to N samples (each track with the model that labelled it) ----
  if (!aborted && !stats.fatal && !o.skipTopup && o.samples > 1 && !pending().length) {
    const upgradeTries = {}
    let waitStreak = 0
    while (!aborted && !stats.fatal && stats.passes + idle < o.maxPasses) {
      const need = tracks.filter((t) => {
        const r = readRec(t.trackId)
        return r?.status === 'ok' && (r.samples ?? 1) < o.samples && (upgradeTries[t.trackId] ?? 0) < 3
      })
      if (!need.length) break
      log(`stage 2: ${need.length} track(s) still below ${o.samples} samples`)
      let progressed = false
      for (const t of need) {
        if (aborted || stats.fatal) break
        if (timeLeft() <= 5 * MIN) {
          stats.stopped = 'time budget reached during stage 2 (stage 1 coverage is complete)'
          break
        }
        if (spend() > o.maxUsd) {
          stats.stopped = `spend cap $${o.maxUsd} reached during stage 2`
          break
        }
        const backup = fs.readFileSync(recPath(t.trackId), 'utf8')
        const model = readRec(t.trackId)?.model ?? o.models[0]
        if (!availableModels([model], modelState, Date.now(), retryMs).length) continue // its bucket is empty
        const res = await spawnLabel(
          [...baseArgs(model, o.samples), '--only', t.trackId, '--force'],
          Math.min(o.passTimeoutMin * MIN, timeLeft()),
        )
        const kind = classifyPass(res)
        const now = readRec(t.trackId)
        if (now?.status === 'ok' && (now.samples ?? 0) >= o.samples) {
          stats.upgrades++
          progressed = true
        } else {
          // The upgrade failed or was blocked: put the working stage-1 record back.
          fs.writeFileSync(recPath(t.trackId), backup)
          stats.upgradeFailures++
          stats.restored++
          if (kind === 'daily-quota') {
            stats.quotaPasses++
            exhaust(model)
          } else {
            upgradeTries[t.trackId] = (upgradeTries[t.trackId] ?? 0) + 1
          }
          log(`stage 2: ${t.trackId} upgrade did not succeed (${kind}); kept the earlier label`)
        }
        if (kind === 'fatal-key') stats.fatal = 'the API key was rejected'
      }
      if (stats.stopped || stats.fatal || aborted) break
      if (!progressed) {
        // Nothing moved: every needed bucket is empty or every try failed. Wait, then re-probe.
        const w = minutesUntilRetry(waitMinutes(waitStreak++, o))
        idle++
        if (timeLeft() <= (w + 5) * MIN * o.waitScale) {
          stats.stopped = 'time budget reached while waiting for quota to reset (stage 1 coverage is complete)'
          break
        }
        log(`stage 2: no upgrade possible right now; waiting ${w} min`)
        writeReport()
        await sleep(w * MIN * o.waitScale)
      } else {
        waitStreak = 0
      }
    }
  }

  // ---- report --------------------------------------------------------------
  function writeReport(final = false) {
    const recs = tracks.map((t) => ({ t, r: readRec(t.trackId) }))
    const ok = recs.filter((x) => x.r?.status === 'ok')
    const blocked = recs.filter((x) => x.r?.status === 'blocked')
    const missing = recs.filter((x) => !x.r)
    const review = ok.filter((x) => x.r.needsReview)
    const models = {}
    for (const x of ok) models[x.r.model] = (models[x.r.model] ?? 0) + 1
    const sampleCounts = {}
    for (const x of ok) sampleCounts[x.r.samples] = (sampleCounts[x.r.samples] ?? 0) + 1
    const exhausted = Object.entries(modelState).filter(([, s]) => s.exhaustedAt != null).map(([m]) => m)
    const lines = []
    lines.push('# Overnight labelling report', '')
    lines.push(`Generated ${new Date().toISOString()}${final ? '' : ' (interim)'} | elapsed ${((Date.now() - started) / 3600_000).toFixed(2)} h | ${stats.passes} label.mjs pass(es)`, '')
    lines.push(`- **Tracks:** ${tracks.length}  |  labelled ok: **${ok.length}**  |  blocked by API: ${blocked.length}  |  no label: **${missing.length}**`)
    lines.push(`- **Need human review** (samples disagree by >1.5 or mood agreement low): ${review.length}`)
    lines.push(`- **Samples per track:** ${Object.entries(sampleCounts).map(([k, v]) => `${k} sample(s): ${v}`).join(', ') || 'n/a'}`)
    lines.push(`- **Models used:** ${Object.entries(models).map(([k, v]) => `${k}: ${v}`).join(', ') || 'n/a'}${Object.keys(models).length > 1 ? '  **(MIXED MODELS: the free tier caps each at ~20 requests/day, so the run rotated; labels are less consistent across models)**' : ''}`)
    if (exhausted.length) lines.push(`- **Models that hit their daily cap:** ${exhausted.join(', ')}`)
    lines.push(`- **Estimated spend:** $${spend().toFixed(2)} (from recorded token usage; the API bill is the truth)`)
    lines.push(`- **Quota-limited passes:** ${stats.quotaPasses}  |  stage-2 upgrades: ${stats.upgrades}, failed and restored: ${stats.restored}`)
    if (stats.fatal) lines.push(`- **STOPPED EARLY:** ${stats.fatal}`)
    else if (stats.stopped) lines.push(`- **Stopped:** ${stats.stopped}`)
    if (missing.length) lines.push(`- **Unlabelled tracks** (re-run the same command to retry): ${missing.map((x) => x.t.trackId).join(', ')}`)
    lines.push('', '## All tracks', '', '| track | title | Jamendo tags | mood | V / A / T | conf | n | model | flag |', '|---|---|---|---|---|---|---|---|---|')
    for (const { t, r } of recs) {
      if (!r) {
        lines.push(`| ${t.trackId} | ${String(t.title).slice(0, 30)} | ${(t.tags ?? []).join(', ')} | - | - | - | 0 | - | NO LABEL |`)
      } else if (r.status === 'blocked') {
        lines.push(`| ${t.trackId} | ${String(t.title).slice(0, 30)} | ${(t.tags ?? []).join(', ')} | BLOCKED | - | - | 0 | ${r.model} | ${(r.blocked?.reasons ?? []).join(',')} |`)
      } else {
        const l = r.label
        lines.push(`| ${t.trackId} | ${String(t.title).slice(0, 30)} | ${(t.tags ?? []).join(', ')} | ${l.primaryMood}${l.secondaryMood ? `/${l.secondaryMood}` : ''} | ${l.valence.toFixed(1)} / ${l.arousal.toFixed(1)} / ${l.tension.toFixed(1)} | ${l.confidence.toFixed(2)} | ${r.samples} | ${r.model} | ${r.needsReview ? 'REVIEW' : ''} |`)
      }
    }
    lines.push('', 'These are LLM pre-labels for human review, not ground truth. Arousal is the most reliable field; valence is noisy (see the sample spread in each JSON).', '')
    lines.push('Next: `npm run labels:compare` (agreement with Jamendo tags), then review the REVIEW rows.')
    fs.writeFileSync(reportPath, lines.join('\n') + '\n')
  }

  writeReport(true)
  const remaining = pending().length
  log(`overnight done: ${tracks.length - remaining}/${tracks.length} labelled; report: ${path.relative(root, reportPath) || reportPath}` +
    `${stats.fatal ? `; STOPPED: ${stats.fatal}` : stats.stopped ? `; stopped: ${stats.stopped}` : ''}`)
  process.off('SIGINT', onSignal)
  process.off('SIGTERM', onSignal)
  try {
    fs.rmSync(lockPath, { force: true })
  } catch {
    /* ignore */
  }
  return stats.fatal || remaining ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (c) => {
      process.exitCode = c
    },
    (e) => {
      console.error(`fatal: ${e?.stack ?? e}`)
      process.exitCode = 1
    },
  )
}
