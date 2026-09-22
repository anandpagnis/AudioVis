#!/usr/bin/env node
/**
 * Self-test for overnight.mjs. Drives the runner against a FAKE label.mjs (no
 * network, no key, no audio) to prove the loop, backoff, model-ladder rotation,
 * upgrade-restore, key-rejection, lock and no-secret-in-logs behaviour.
 *
 *   node scripts/mood-labels/overnight-selftest.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { main, parseArgs, waitMinutes, availableModels, classifyPass, DEFAULT_LADDER } from './overnight.mjs'

const SECRET = 'AQ.fake-secret-key-for-selftest-1234567890'
let passed = 0
let failed = 0
const test = async (name, fn) => {
  try {
    await fn()
    passed++
    console.log(`  ok    ${name}`)
  } catch (e) {
    failed++
    console.log(`  FAIL  ${name}\n        ${e.message.split('\n').join('\n        ')}`)
  }
}

// A stand-in for label.mjs. Behaviour comes from a JSON plan on disk:
//   plan.tracks: string[]                         (what a pass would process, in order)
//   plan.modelLimit: { model: n }                 (daily successes allowed per model; default unlimited)
//   plan.outcome[trackId]: { default, byModel?: {model: outcome}, upgrade?: outcome, firstN?: {n, outcome} }
//   outcome: 'ok' | '429' | 'blocked' | 'keyrejected' | 'daily'
// Mirrors real exit codes: 0 ok, 1 some failed / key rejected, 3 daily quota exhausted.
const FAKE = `
import fs from 'node:fs'
import path from 'node:path'
const argv = process.argv.slice(2)
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
const out = arg('--out'), model = arg('--model'), samples = Number(arg('--samples') || 1)
const only = arg('--only'), force = argv.includes('--force')
const plan = JSON.parse(fs.readFileSync(process.env.FAKE_PLAN, 'utf8'))
const counterFile = process.env.FAKE_PLAN + '.counters'
const counters = fs.existsSync(counterFile) ? JSON.parse(fs.readFileSync(counterFile, 'utf8')) : {}
const save = () => fs.writeFileSync(counterFile, JSON.stringify(counters))
console.log('leaking on purpose: ' + (process.env.GEMINI_API_KEY || ''))
let failures = 0
for (const id of plan.tracks) {
  if (only && !id.includes(only)) continue
  const file = path.join(out, id + '.json')
  if (!force && fs.existsSync(file)) { console.log('[' + id + '] cached'); continue }
  const spec = plan.outcome[id] || { default: 'ok' }
  counters[id] = (counters[id] || 0) + 1
  let o = spec.default || 'ok'
  if (spec.byModel && spec.byModel[model]) o = spec.byModel[model]
  if (force && spec.upgrade) o = spec.upgrade
  if (spec.firstN && counters[id] <= spec.firstN.n && !force) o = spec.firstN.outcome
  const limit = plan.modelLimit && plan.modelLimit[model]
  const used = counters['m:' + model] || 0
  if (limit != null && used >= limit) o = 'daily'
  if (o === 'keyrejected') { console.log('Stopped early: 1 track(s) not attempted because the API key was rejected.'); save(); process.exit(1) }
  if (o === 'daily') {
    console.log('[' + id + '] FAILED: generateContent: HTTP 429 RESOURCE_EXHAUSTED PerDay')
    console.log('Stopped early: daily quota exhausted for ' + model + '; 0 track(s) not attempted.')
    save(); process.exit(3)
  }
  if (o === '429') { console.log('  generateContent: HTTP 429, retry 6/6'); console.log('[' + id + '] FAILED: quota'); failures++; continue }
  counters['m:' + model] = used + 1
  const base = { trackId: id, model, requestedSamples: samples, generatedAt: 'x' }
  const rec = o === 'blocked'
    ? { ...base, status: 'blocked', samples: 0, blocked: { reasons: ['RECITATION'] }, label: null, needsReview: true }
    : { ...base, status: 'ok', samples, label: { primaryMood: 'dreamy', secondaryMood: null, valence: 5, arousal: 3, tension: 2, confidence: 0.8 },
        usage: { promptTokens: 1000, outputTokens: 500, thoughtsTokens: 200, totalTokens: 1700 }, needsReview: false }
  fs.writeFileSync(file, JSON.stringify(rec))
  console.log('[' + id + '] ' + rec.status)
}
save()
process.exit(failures ? 1 : 0)
`

function setup(plan) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overnight-test-'))
  const script = path.join(dir, 'fake-label.mjs')
  fs.writeFileSync(script, FAKE)
  const planFile = path.join(dir, 'plan.json')
  fs.writeFileSync(planFile, JSON.stringify(plan))
  const out = path.join(dir, 'labels', 'gemini')
  process.env.FAKE_PLAN = planFile
  process.env.GEMINI_API_KEY = SECRET
  const base = ['--label-script', script, '--out', out, '--track-ids', plan.tracks.join(','), '--wait-scale', '0', '--budget-hours', '1']
  const read = (f) => fs.readFileSync(path.join(dir, 'labels', f), 'utf8')
  const rec = (id) => JSON.parse(fs.readFileSync(path.join(out, `${id}.json`), 'utf8'))
  return { dir, out, base, read, rec }
}
const quiet = async (fn) => {
  const log = console.log
  const err = console.error
  console.log = () => {}
  console.error = () => {}
  try {
    return await fn()
  } finally {
    console.log = log
    console.error = err
  }
}
const LADDER = 'gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash'

console.log('overnight-selftest')

await test('pure helpers: waits double and cap, ladder skips exhausted models, passes are classified', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((s) => waitMinutes(s)), [5, 10, 20, 40, 60, 60])
  const t0 = 1_000_000
  const st = { A: { exhaustedAt: t0 }, B: { disabled: true } }
  assert.deepEqual(availableModels(['A', 'B', 'C'], st, t0 + 1000, 5000), ['C'], 'A exhausted, B disabled')
  assert.deepEqual(availableModels(['A', 'B', 'C'], st, t0 + 6000, 5000), ['A', 'C'], 'A becomes probe-able after the retry window')
  assert.equal(classifyPass({ code: 1, out: 'x API key was rejected' }), 'fatal-key')
  assert.equal(classifyPass({ code: 2, out: '' }), 'fatal-config')
  assert.equal(classifyPass({ code: 3, out: '' }), 'daily-quota')
  assert.equal(classifyPass({ code: 1, out: 'Stopped early: daily quota exhausted for m' }), 'daily-quota')
  assert.equal(classifyPass({ code: 1, out: 'HTTP 429, retry' }), 'quota')
  assert.equal(classifyPass({ code: 0, out: 'HTTP 429, retry 1/6 in 19s' }), 'ok')
  assert.equal(classifyPass({ code: 1, out: '', timedOut: true }), 'timeout')
  assert.throws(() => parseArgs(['--nope']))
  assert.equal(parseArgs(['--single-model']).models.length, 1)
  assert.deepEqual(parseArgs(['--model', 'x']).models, ['x'])
  assert.ok(!DEFAULT_LADDER.includes('gemini-2.5-flash'), 'closed-to-new-users model must not be in the ladder')
})

await test('happy path: stage 1 covers everything, stage 2 upgrades to 3 samples, report written', async () => {
  const s = setup({ tracks: ['jamendo_1', 'jamendo_2', 'jamendo_3'], outcome: {} })
  const code = await quiet(() => main([...s.base, '--models', LADDER]))
  assert.equal(code, 0)
  for (const id of ['jamendo_1', 'jamendo_2', 'jamendo_3']) assert.equal(s.rec(id).samples, 3)
  const report = s.read('OVERNIGHT-REPORT.md')
  assert.match(report, /labelled ok: \*\*3\*\*/)
  assert.match(report, /3 sample\(s\): 3/)
  assert.ok(!fs.existsSync(path.join(s.out, '.overnight.lock')), 'lock is released')
})

await test('transient rate limit: a track that fails two passes is retried until it lands', async () => {
  const s = setup({ tracks: ['jamendo_1', 'jamendo_2'], outcome: { jamendo_2: { default: 'ok', firstN: { n: 2, outcome: '429' } } } })
  const code = await quiet(() => main([...s.base, '--skip-topup', '--models', LADDER]))
  assert.equal(code, 0)
  assert.equal(s.rec('jamendo_2').status, 'ok')
  assert.match(s.read('overnight.log'), /no progress/)
})

await test('daily cap on the first model: the run rotates down the ladder and flags the mixed set', async () => {
  const s = setup({ tracks: ['jamendo_1', 'jamendo_2', 'jamendo_3', 'jamendo_4', 'jamendo_5'], outcome: {},
    modelLimit: { 'gemini-3.8-flash': 2, 'gemini-3.7-flash': 2 } })
  const code = await quiet(() => main([...s.base, '--skip-topup', '--models', LADDER]))
  assert.equal(code, 0)
  const models = ['jamendo_1', 'jamendo_2', 'jamendo_3', 'jamendo_4', 'jamendo_5'].map((id) => s.rec(id).model)
  assert.deepEqual(models, ['gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.7-flash', 'gemini-3.6-flash'])
  const report = s.read('OVERNIGHT-REPORT.md')
  assert.match(report, /MIXED MODELS/)
  assert.match(report, /daily cap:\*\* gemini-3.8-flash, gemini-3.7-flash/)
})

await test('--single-model does not rotate: it stops instead of mixing models', async () => {
  const s = setup({ tracks: ['jamendo_1', 'jamendo_2', 'jamendo_3'], outcome: {}, modelLimit: { 'gemini-3.8-flash': 1 } })
  const code = await quiet(() => main([...s.base, '--skip-topup', '--models', LADDER, '--single-model', '--max-passes', '6']))
  assert.equal(code, 1)
  assert.equal(s.rec('jamendo_1').model, 'gemini-3.8-flash')
  assert.ok(!fs.existsSync(path.join(s.out, 'jamendo_2.json')))
  assert.match(s.read('overnight.log'), /every model is at its daily cap/)
})

await test('every model at its daily cap: bounded waiting, then a clear report of what is missing (no hang)', async () => {
  const s = setup({ tracks: ['jamendo_1', 'jamendo_2'], outcome: {}, modelLimit: { 'gemini-3.8-flash': 0, 'gemini-3.7-flash': 0 } })
  const code = await quiet(() => main([...s.base, '--models', 'gemini-3.8-flash,gemini-3.7-flash', '--max-passes', '8']))
  assert.equal(code, 1)
  assert.match(s.read('OVERNIGHT-REPORT.md'), /Unlabelled tracks.*jamendo_1.*jamendo_2/)
})

await test('a blocked track is recorded once and does not loop the run forever', async () => {
  const s = setup({ tracks: ['jamendo_1', 'jamendo_2'], outcome: { jamendo_2: { default: 'blocked' } } })
  const code = await quiet(() => main([...s.base, '--skip-topup', '--models', LADDER]))
  assert.equal(code, 0)
  assert.equal(s.rec('jamendo_2').status, 'blocked')
  assert.match(s.read('OVERNIGHT-REPORT.md'), /blocked by API: 1/)
})

await test('failed stage-2 upgrade restores the working stage-1 label', async () => {
  const s = setup({ tracks: ['jamendo_1', 'jamendo_2'], outcome: { jamendo_2: { default: 'ok', upgrade: 'blocked' } } })
  const code = await quiet(() => main([...s.base, '--models', LADDER]))
  assert.equal(code, 0)
  assert.equal(s.rec('jamendo_1').samples, 3)
  const kept = s.rec('jamendo_2')
  assert.equal(kept.status, 'ok', 'blocked upgrade must not replace the good record')
  assert.equal(kept.samples, 1)
})

await test('stage 2 with the labelling model out of quota: keeps the stage-1 label, waits boundedly, does not hang', async () => {
  // limit 3 = the three stage-1 labels use the whole bucket, so every upgrade hits the daily cap
  const s = setup({ tracks: ['jamendo_1', 'jamendo_2', 'jamendo_3'], outcome: {}, modelLimit: { 'gemini-3.8-flash': 3 } })
  const code = await quiet(() => main([...s.base, '--models', 'gemini-3.8-flash', '--max-passes', '10']))
  assert.equal(code, 0, 'stage 1 coverage is complete, so the run is a success')
  for (const id of ['jamendo_1', 'jamendo_2', 'jamendo_3']) {
    assert.equal(s.rec(id).status, 'ok')
    assert.equal(s.rec(id).samples, 1, 'restored, not overwritten')
  }
})

await test('a rejected key stops the run immediately instead of looping all night', async () => {
  const s = setup({ tracks: ['jamendo_1', 'jamendo_2'], outcome: { jamendo_1: { default: 'keyrejected' } } })
  const code = await quiet(() => main([...s.base, '--models', LADDER]))
  assert.equal(code, 1)
  const log = s.read('overnight.log')
  assert.equal((log.match(/stage 1 pass \d+:/g) ?? []).length, 1)
  assert.match(s.read('OVERNIGHT-REPORT.md'), /STOPPED EARLY:\*\* the API key was rejected/)
})

await test('gives up at the pass cap when nothing ever works, and says what is missing', async () => {
  const s = setup({ tracks: ['jamendo_1'], outcome: { jamendo_1: { default: '429' } } })
  const code = await quiet(() => main([...s.base, '--max-passes', '4', '--models', 'gemini-3.8-flash']))
  assert.equal(code, 1)
  assert.match(s.read('OVERNIGHT-REPORT.md'), /Unlabelled tracks.*jamendo_1/)
})

await test('a live lock file from another process refuses a second instance', async () => {
  const s = setup({ tracks: ['jamendo_1'], outcome: {} })
  fs.mkdirSync(s.out, { recursive: true })
  fs.writeFileSync(path.join(s.out, '.overnight.lock'), JSON.stringify({ pid: process.ppid }))
  const code = await quiet(() => main([...s.base]))
  assert.equal(code, 2)
  assert.ok(!fs.existsSync(path.join(s.out, 'jamendo_1.json')))
})

await test('a stale lock (dead pid) is taken over', async () => {
  const s = setup({ tracks: ['jamendo_1'], outcome: {} })
  fs.mkdirSync(s.out, { recursive: true })
  fs.writeFileSync(path.join(s.out, '.overnight.lock'), JSON.stringify({ pid: 999999 }))
  const code = await quiet(() => main([...s.base, '--skip-topup', '--models', LADDER]))
  assert.equal(code, 0)
})

await test('the API key never reaches the log or the report, even if a child prints it', async () => {
  const s = setup({ tracks: ['jamendo_1'], outcome: {} })
  await quiet(() => main([...s.base, '--models', LADDER]))
  assert.ok(!s.read('overnight.log').includes(SECRET), 'log leaked the key')
  assert.ok(!s.read('OVERNIGHT-REPORT.md').includes(SECRET), 'report leaked the key')
  assert.ok(!fs.readFileSync(path.join(s.out, 'jamendo_1.json'), 'utf8').includes(SECRET))
})

await test('spend cap stops stage 2 but keeps stage-1 coverage', async () => {
  const s = setup({ tracks: ['jamendo_1', 'jamendo_2'], outcome: {} })
  const code = await quiet(() => main([...s.base, '--models', LADDER, '--max-usd', '0']))
  assert.equal(code, 0)
  assert.equal(s.rec('jamendo_1').status, 'ok')
  assert.match(s.read('OVERNIGHT-REPORT.md'), /spend cap/)
})

delete process.env.GEMINI_API_KEY
delete process.env.FAKE_PLAN
console.log(`\n${passed}/${passed + failed} tests passed`)
process.exitCode = failed ? 1 : 0
