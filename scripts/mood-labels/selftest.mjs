#!/usr/bin/env node
/**
 * Self-test for the mood-labelling scripts. Plain node, no framework, no
 * network: the whole pipeline runs against a mocked global fetch and tiny fake
 * WAV files in the OS temp dir. Run: node scripts/mood-labels/selftest.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  MOODS,
  PRIMARY_MOODS,
  aggregateSamples,
  backoffDelayMs,
  buildGenerateRequest,
  buildPrompt,
  buildResponseSchema,
  compareToTags,
  estimateAudioTokens,
  estimateCostUsd,
  extractText,
  BlockedError,
  formatTable,
  mimeForFile,
  parseArgs,
  parseEnvFile,
  parseJsonText,
  parseRetryDelayMs,
  redact,
  resolveApiKey,
  reviewFlags,
  toOpenApiSchema,
  validateLabel,
  wavDurationSec,
  wavSlice,
  JAMENDO_TAG_MAP,
} from './lib.mjs'
import { run } from './label.mjs'
import { compareAll } from './compare-to-jamendo.mjs'

const FAKE_KEY = 'AIzaSyFAKEFAKEFAKEFAKEFAKEFAKE0123456789'
const tests = []
const test = (name, fn) => tests.push({ name, fn })

// ---------------------------------------------------------------- fixtures
const mkLabel = (over = {}) => ({
  rationale: 'Slow pads and soft piano over sustained major chords with no percussion.',
  lyricsInfluence: 'none',
  primaryMood: 'serene',
  secondaryMood: 'dreamy',
  valence: 6,
  arousal: 2,
  tension: 2,
  quarterArousal: [2, 2, 3, 2],
  moodTimeline: [],
  vocalPresence: 0,
  acoustic: 0.7,
  tempoFeel: 'slow',
  danceability: 0.1,
  genres: ['ambient', 'new age'],
  instruments: ['piano', 'synth pad'],
  confidence: 0.8,
  ...over,
})

function makeWav(sec, rate = 8000) {
  const n = sec * rate
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(3000 * Math.sin(i / 10)), i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVEfmt ', 8, 'ascii')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

const genOk = (label = mkLabel(), extra = {}) =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(label) }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 128, candidatesTokenCount: 300, thoughtsTokenCount: 50, totalTokenCount: 478 },
      ...extra,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
const genText = (text) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }), { status: 200 })
const genBlocked = (reason = 'RECITATION') => new Response(JSON.stringify({ candidates: [{ finishReason: reason }] }), { status: 200 })
const errResp = (status, message, extra = {}) =>
  new Response(JSON.stringify({ error: { code: status, message, status: extra.status ?? 'ERROR', details: extra.details ?? [] } }), { status })
const rate429 = (sec) =>
  errResp(429, 'Resource has been exhausted', { status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: `${sec}s` }] })

/** Mock of the Gemini REST surface. generate: array of Response|function producing one, consumed in order (last repeats). */
function makeMock({ generate = [], firstUploadProcessing = true } = {}) {
  const calls = []
  const uploaded = new Map()
  let nextFile = 1
  let gen = 0
  const fetch = async (url, init = {}) => {
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]))
    const method = init.method ?? 'GET'
    const rec = {
      method,
      url: String(url),
      headers,
      body: typeof init.body === 'string' ? init.body : null,
      bodyBytes: init.body && typeof init.body !== 'string' ? init.body.length : 0,
    }
    calls.push(rec)
    const u = String(url)
    if (u.includes('/upload/v1beta/files') && headers['x-goog-upload-command'] === 'start')
      return new Response('', { status: 200, headers: { 'x-goog-upload-url': `https://upload.mock.invalid/session/${nextFile}` } })
    if (u.startsWith('https://upload.mock.invalid/')) {
      const id = `f${nextFile++}`
      const file = {
        name: `files/${id}`,
        uri: `https://generativelanguage.googleapis.com/v1beta/files/${id}`,
        mimeType: 'audio/wav',
        state: firstUploadProcessing && nextFile === 2 ? 'PROCESSING' : 'ACTIVE',
      }
      uploaded.set(file.name, file)
      return new Response(JSON.stringify({ file }), { status: 200 })
    }
    if (method === 'DELETE') {
      const name = u.split('/v1beta/')[1]
      uploaded.delete(name)
      return new Response('{}', { status: 200 })
    }
    if (method === 'GET' && u.includes('/v1beta/files/')) {
      const f = uploaded.get(u.split('/v1beta/')[1])
      return new Response(JSON.stringify({ ...f, state: 'ACTIVE' }), { status: 200 })
    }
    if (u.includes(':generateContent')) {
      const item = generate[Math.min(gen++, generate.length - 1)]
      return typeof item === 'function' ? item(rec) : item.clone()
    }
    return new Response('unexpected', { status: 500 })
  }
  return { fetch, calls, uploaded }
}

const isGen = (c) => c.url.includes(':generateContent')
const isDel = (c) => c.method === 'DELETE'
const isStart = (c) => c.headers['x-goog-upload-command'] === 'start'

async function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-labels-selftest-'))
  try {
    return await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** Run the CLI in-process with everything captured (ctx.log AND stray console/stdout writes). */
async function runCli(argv, { mock, root, env = { GEMINI_API_KEY: FAKE_KEY }, sleeps = [] }) {
  const logs = []
  const stray = []
  const orig = { log: console.log, error: console.error, warn: console.warn, write: process.stdout.write.bind(process.stdout) }
  console.log = console.error = console.warn = (...a) => stray.push(a.join(' '))
  process.stdout.write = (s) => (stray.push(String(s)), true)
  let result
  try {
    result = await run(argv, {
      fetch: mock?.fetch,
      env,
      root,
      log: (...a) => logs.push(a.join(' ')),
      sleep: async (ms) => void sleeps.push(ms),
      random: () => 0,
    })
  } finally {
    Object.assign(console, { log: orig.log, error: orig.error, warn: orig.warn })
    process.stdout.write = orig.write
  }
  return { ...result, logs, stray, output: [...logs, ...stray].join('\n'), sleeps }
}

function assertNoKeyLeak({ calls = [], output = '', outDir = null }) {
  assert.ok(!output.includes(FAKE_KEY), 'API key appeared in log/console output')
  for (const c of calls) {
    assert.ok(!c.url.includes(FAKE_KEY), 'API key appeared in a request URL')
    assert.ok(!(c.body ?? '').includes(FAKE_KEY), 'API key appeared in a request body')
    for (const [k, v] of Object.entries(c.headers)) if (k !== 'x-goog-api-key') assert.ok(!v.includes(FAKE_KEY), `API key appeared in header ${k}`)
  }
  if (outDir && fs.existsSync(outDir))
    for (const f of fs.readdirSync(outDir)) assert.ok(!fs.readFileSync(path.join(outDir, f), 'utf8').includes(FAKE_KEY), `API key written to ${f}`)
}

// ---------------------------------------------------------------- unit tests
test('taxonomy is the verbatim engine list', () => {
  assert.deepEqual(MOODS, ['serene', 'tender', 'dreamy', 'melancholic', 'brooding', 'mysterious', 'groove', 'playful', 'uplifting', 'euphoric', 'driving', 'tense', 'aggressive', 'epic'])
  assert.deepEqual(PRIMARY_MOODS, [...MOODS, 'silence'])
})

test('response schema: required == properties, enums, only documented keywords', () => {
  const s = buildResponseSchema()
  assert.deepEqual(new Set(s.required), new Set(Object.keys(s.properties)))
  assert.deepEqual(s.properties.primaryMood.enum, PRIMARY_MOODS)
  assert.deepEqual(s.properties.secondaryMood.enum, ['none', ...MOODS])
  assert.equal(s.properties.quarterArousal.minItems, 4)
  assert.equal(s.properties.moodTimeline.maxItems, 6)
  const allowed = new Set(['type', 'enum', 'minimum', 'maximum', 'items', 'minItems', 'maxItems', 'properties', 'required', 'description'])
  const walk = (n) => {
    // n is a schema node: check its keywords, then recurse into properties/items
    for (const k of Object.keys(n)) assert.ok(allowed.has(k), `unsupported schema keyword ${k}`)
    if (n.properties) Object.values(n.properties).forEach(walk)
    if (n.items) walk(n.items)
  }
  walk(s)
  const o = toOpenApiSchema(s)
  assert.equal(o.type, 'OBJECT')
  assert.equal(o.properties.quarterArousal.items.type, 'NUMBER')
  assert.deepEqual(o.propertyOrdering, Object.keys(s.properties))
})

test('prompt has the anchors, taxonomy, no-groove rule, no-lyrics rule, duration', () => {
  const p = buildPrompt({ durationSec: 125 })
  for (const m of PRIMARY_MOODS) assert.ok(p.includes(`- ${m}:`), `mood ${m} missing`)
  assert.match(p, /1 = bleak \/ sad \/ hostile, 5 = neutral \/ ambiguous, 9 = joyful \/ bright/)
  assert.match(p, /1 = near-still, 5 = moderate, 9 = frantic \/ very intense/)
  assert.match(p, /1 = relaxed \/ consonant, 9 = anxious \/ dissonant \/ suspenseful/)
  assert.match(p, /SOUND conveys/)
  assert.match(p, /Do not default to "groove"/)
  assert.match(p, /full 1-9 range/)
  assert.match(p, /Never transcribe, quote or reproduce lyrics/)
  assert.match(p, /125 seconds long \(2:05\)/)
  assert.match(buildPrompt({ clip: { startSec: 10, seconds: 60, physical: true } }), /60-second excerpt/)
  assert.match(buildPrompt({ clip: { startSec: 10, seconds: 60, physical: false } }), /ONLY the window from 10 s to 70 s/)
})

test('request builder: temperature omitted by default, schema styles, file part', () => {
  const base = { fileUri: 'https://x/files/a', mimeType: 'audio/mp3', prompt: 'P' }
  const r = buildGenerateRequest(base)
  assert.equal('temperature' in r.generationConfig, false)
  assert.equal(r.generationConfig.responseMimeType, 'application/json')
  assert.ok(r.generationConfig.responseSchema)
  assert.deepEqual(r.contents[0].parts[1], { fileData: { mimeType: 'audio/mp3', fileUri: 'https://x/files/a' } })
  assert.equal(buildGenerateRequest({ ...base, temperature: 0.4 }).generationConfig.temperature, 0.4)
  assert.ok(buildGenerateRequest({ ...base, schemaStyle: 'responseJsonSchema' }).generationConfig.responseJsonSchema)
  assert.ok(buildGenerateRequest({ ...base, schemaStyle: 'responseFormat' }).generationConfig.responseFormat.text.schema)
  assert.equal(buildGenerateRequest({ ...base, thinkingLevel: 'low' }).generationConfig.thinkingConfig.thinkingLevel, 'low')
  assert.throws(() => buildGenerateRequest({ ...base, schemaStyle: 'nope' }))
})

test('validator accepts a good label and orders fields', () => {
  const v = validateLabel(mkLabel())
  assert.ok(v.ok, v.errors.join(';'))
  assert.equal(Object.keys(v.value).length, Object.keys(buildResponseSchema().properties).length)
})

test('validator clamps ranges, maps "none" to null, truncates lists and rationale', () => {
  const words = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ')
  const v = validateLabel(
    mkLabel({
      valence: 12,
      arousal: 0,
      tension: '7',
      confidence: 1.4,
      secondaryMood: 'none',
      quarterArousal: [0, 5, 10, 3],
      genres: ['A', 'a', 'b', 'c', 'd'],
      instruments: ['1', '2', '3', '4', '5', '6', '7'],
      rationale: words,
      moodTimeline: [
        { startSec: 0, endSec: 30, mood: 'serene' },
        { startSec: 30, endSec: 20, mood: 'tense' }, // end <= start -> dropped
        { startSec: 20, endSec: 500, mood: 'epic' }, // clamped to duration
        { startSec: 1, endSec: 2, mood: 'bogus' }, // dropped
      ],
    }),
    { durationSec: 100 },
  )
  assert.ok(v.ok, v.errors.join(';'))
  assert.equal(v.value.valence, 9)
  assert.equal(v.value.arousal, 1)
  assert.equal(v.value.tension, 7)
  assert.equal(v.value.confidence, 1)
  assert.equal(v.value.secondaryMood, null)
  assert.deepEqual(v.value.quarterArousal, [1, 5, 9, 3])
  assert.deepEqual(v.value.genres, ['a', 'b', 'c'])
  assert.equal(v.value.instruments.length, 5)
  assert.equal(v.value.rationale.split(' ').length, 40)
  assert.deepEqual(v.value.moodTimeline, [
    { startSec: 0, endSec: 30, mood: 'serene' },
    { startSec: 20, endSec: 100, mood: 'epic' },
  ])
  assert.ok(v.warnings.length >= 5)
  assert.equal(validateLabel(mkLabel({ secondaryMood: 'serene' })).value.secondaryMood, null, 'secondary == primary -> null')
})

test('validator rejects structural problems', () => {
  for (const bad of [
    mkLabel({ primaryMood: 'happy' }),
    mkLabel({ secondaryMood: 'silence' }),
    mkLabel({ quarterArousal: [1, 2, 3] }),
    mkLabel({ valence: 'high' }),
    mkLabel({ tempoFeel: 'brisk' }),
    mkLabel({ lyricsInfluence: 'a lot' }),
    mkLabel({ moodTimeline: 'none' }),
    mkLabel({ rationale: '' }),
    mkLabel({ genres: 'rock' }),
    'not an object',
    null,
  ]) {
    const v = validateLabel(bad)
    assert.equal(v.ok, false)
    assert.equal(v.value, null)
    assert.ok(v.errors.length)
  }
  const missing = mkLabel()
  delete missing.confidence
  assert.equal(validateLabel(missing).ok, false)
})

test('parseJsonText tolerates fences; extractText handles blocks', () => {
  assert.deepEqual(parseJsonText('```json\n{"a":1}\n```'), { a: 1 })
  assert.throws(() => parseJsonText('nope'))
  assert.throws(() => extractText({ candidates: [{ finishReason: 'RECITATION' }] }), BlockedError)
  assert.throws(() => extractText({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }), BlockedError)
  assert.throws(() => extractText({ candidates: [{ content: { parts: [{ text: '  ' }] }, finishReason: 'MAX_TOKENS' }] }), /empty response/)
  assert.equal(extractText({ candidates: [{ content: { parts: [{ text: 'x', thought: true }, { text: '{"k":1}' }] } }] }), '{"k":1}')
})

test('aggregation: mean, majority mood, spread, review flags', () => {
  const a = mkLabel({ primaryMood: 'serene', secondaryMood: 'dreamy', valence: 3, arousal: 2, tension: 2, confidence: 0.9, quarterArousal: [1, 2, 3, 4] })
  const b = mkLabel({ primaryMood: 'serene', secondaryMood: null, valence: 4, arousal: 2, tension: 3, confidence: 0.7, quarterArousal: [3, 2, 3, 4] })
  const c = mkLabel({ primaryMood: 'tender', secondaryMood: 'serene', valence: 5, arousal: 4, tension: 2, confidence: 0.5, quarterArousal: [2, 2, 3, 4] })
  const { label, spread } = aggregateSamples([a, b, c].map((x) => validateLabel(x).value))
  assert.equal(label.primaryMood, 'serene')
  assert.equal(label.secondaryMood, 'dreamy')
  assert.equal(label.valence, 4)
  assert.equal(label.arousal, 2.667)
  assert.deepEqual(label.quarterArousal, [2, 2, 3, 4])
  assert.equal(label.confidence, 0.7)
  assert.equal(spread.n, 3)
  assert.equal(spread.moodAgreement, 0.667)
  assert.deepEqual(spread.moodCounts, { serene: 2, tender: 1 })
  assert.deepEqual(spread.range.arousal, [2, 4])
  assert.ok(spread.sd.valence > 0.8 && spread.sd.valence < 0.82)
  const f = reviewFlags(label, spread)
  assert.equal(f.needsReview, true)
  assert.match(f.reviewReasons.join(), /arousal range 2 > 1.5/)
  // single sample: no spread info, no flag unless confidence is low
  const one = aggregateSamples([validateLabel(a).value])
  assert.equal(one.spread.n, 1)
  assert.equal(reviewFlags(one.label, one.spread).needsReview, false)
  assert.equal(reviewFlags({ confidence: 0.2 }, one.spread).needsReview, true)
  // tie -> higher summed confidence wins
  const t = aggregateSamples([validateLabel(a).value, validateLabel(mkLabel({ primaryMood: 'epic', confidence: 0.95 })).value])
  assert.equal(t.label.primaryMood, 'epic')
  assert.throws(() => aggregateSamples([]))
})

test('tokens, cost, wav helpers, mime map', () => {
  assert.equal(estimateAudioTokens(60), 1920)
  assert.equal(estimateAudioTokens(3600), 115200)
  const c = estimateCostUsd('gemini-3.8-flash', 115200, 0, new Date('2026-09-19'))
  assert.ok(Math.abs(c - 0.0864) < 1e-9)
  assert.ok(Math.abs(estimateCostUsd('gemini-3.8-flash', 115200, 0, new Date('2027-02-01')) - 0.1728) < 1e-9)
  assert.equal(estimateCostUsd('some-unknown-model', 1000), null)
  const wav = makeWav(4)
  assert.ok(Math.abs(wavDurationSec(wav) - 4) < 1e-9)
  assert.ok(Math.abs(wavDurationSec(wav.subarray(0, 4096), wav.length) - 4) < 1e-9, 'header-only read + real file size')
  const cut = wavSlice(wav, 1, 1)
  assert.ok(Math.abs(wavDurationSec(cut) - 1) < 1e-9)
  assert.equal(wavSlice(Buffer.from('not a wav at all, definitely not a wav file header....'), 0, 1), null)
  assert.equal(mimeForFile('a/b.MP3'), 'audio/mp3')
  assert.equal(mimeForFile('x.flac'), 'audio/flac')
  assert.equal(mimeForFile('x.txt'), null)
})

test('retry helpers', () => {
  assert.equal(backoffDelayMs(0), 2000)
  assert.equal(backoffDelayMs(3), 16000)
  assert.equal(backoffDelayMs(10), 60000)
  assert.equal(parseRetryDelayMs(new Headers({ 'retry-after': '7' }), ''), 7000)
  assert.equal(parseRetryDelayMs(new Headers(), '{"retryDelay": "34s"}'), 34000)
  assert.equal(parseRetryDelayMs(new Headers(), 'nothing'), null)
})

test('key resolution order and redaction', () => {
  assert.equal(resolveApiKey({ GEMINI_API_KEY: 'a', GOOGLE_API_KEY: 'b' }, 'GEMINI_API_KEY=c').key, 'a')
  assert.equal(resolveApiKey({ GOOGLE_API_KEY: 'b' }, 'GEMINI_API_KEY=c').key, 'b')
  assert.deepEqual(resolveApiKey({}, '# c\nexport GEMINI_API_KEY="c d" # x\n'), { key: 'c d', source: '.env.local GEMINI_API_KEY' })
  assert.equal(resolveApiKey({}, 'GOOGLE_API_KEY=z\r\n').source, '.env.local GOOGLE_API_KEY')
  assert.equal(resolveApiKey({}, ''), null)
  assert.deepEqual(parseEnvFile("A=1\nB='two'\n#C=3\n"), { A: '1', B: 'two' })
  assert.equal(redact(`x ${FAKE_KEY} y ${FAKE_KEY}`, FAKE_KEY), 'x [REDACTED] y [REDACTED]')
})

test('parseArgs defaults and validation', () => {
  const d = parseArgs([])
  assert.equal(d.samples, 3)
  assert.equal(d.concurrency, 2)
  assert.equal(d.model, 'gemini-3.8-flash')
  assert.equal(d.temperature, null)
  assert.deepEqual(d.sources, ['testfolder', 'corpus'])
  const o = parseArgs(['--dir', 'x', '--samples', '5', '--temperature', '0.4', '--only', 'amb', '--limit', '2', '--model', 'gemini-2.5-pro'])
  assert.deepEqual(o.sources, ['dir'])
  assert.equal(o.samples, 5)
  assert.equal(o.temperature, 0.4)
  assert.equal(o.model, 'gemini-2.5-pro')
  assert.deepEqual(parseArgs(['--dir', 'x', '--sources', 'testfolder']).sources, ['testfolder', 'dir'])
  assert.throws(() => parseArgs(['--samples', '0']))
  assert.throws(() => parseArgs(['--bogus']))
  assert.throws(() => parseArgs(['--only']))
  assert.throws(() => parseArgs(['--schema-style', 'x']))
})

test('jamendo tag comparison', () => {
  const calmLow = mkLabel({ arousal: 2, valence: 6 })
  let c = compareToTags(calmLow, ['calm', 'advertising'])
  assert.deepEqual(c.mapped, ['calm'])
  assert.deepEqual(c.ignored, ['advertising'])
  assert.equal(c.arousal.verdict, 'ok')
  assert.equal(c.mood.verdict, 'ok') // serene compatible with calm
  c = compareToTags(mkLabel({ arousal: 8, valence: 3, primaryMood: 'aggressive', secondaryMood: null }), ['relaxing', 'happy'])
  assert.equal(c.arousal.verdict, 'X')
  assert.equal(c.valence.verdict, 'X')
  assert.equal(c.mood.verdict, 'X')
  assert.equal(compareToTags(mkLabel({ arousal: 5 }), ['calm']).arousal.verdict, '~')
  assert.equal(compareToTags(mkLabel(), ['calm', 'energetic']).arousal.verdict, '-', 'conflicting tags are not judged')
  assert.equal(compareToTags(mkLabel(), []).mood.verdict, '-')
  for (const [tag, e] of Object.entries(JAMENDO_TAG_MAP)) for (const m of e.moods ?? []) assert.ok(MOODS.includes(m), `${tag} -> unknown mood ${m}`)
  const { tally } = compareAll([{ trackId: 't', jamendoId: 1, label: mkLabel(), status: 'ok' }], new Map([[1, ['calm']]]))
  assert.equal(tally.arousal.ok, 1)
})

test('formatTable aligns columns', () => {
  const t = formatTable(['a', 'bb'], [['xxx', '1'], ['y', '22']]).split('\n')
  assert.equal(t.length, 4)
  assert.ok(t[2].startsWith('xxx  1'))
})

// ---------------------------------------------------------------- pipeline (mocked fetch)
function setup(dir, names = ['a-ambient.wav', 'b-beat.wav'], sec = 4) {
  const audio = path.join(dir, 'audio')
  const out = path.join(dir, 'out')
  const root = path.join(dir, 'root')
  fs.mkdirSync(audio)
  fs.mkdirSync(root)
  for (const n of names) fs.writeFileSync(path.join(audio, n), makeWav(sec))
  return { audio, out, root }
}
const base = (s, extra = []) => ['--dir', s.audio, '--out', s.out, '--concurrency', '1', '--i-understand-data-use', ...extra]

test('pipeline: upload once, retry on 429 + invalid JSON, cache, delete, aggregate, no key leak', () =>
  withTmp(async (dir) => {
    const s = setup(dir)
    const mock = makeMock({
      generate: [rate429(3), genOk(mkLabel()), genText('this is not json'), genOk(mkLabel({ valence: 7 })), genOk(mkLabel({ primaryMood: 'driving', arousal: 8 })), genOk(mkLabel({ primaryMood: 'driving', arousal: 8 }))],
    })
    const sleeps = []
    const r = await runCli(base(s, ['--samples', '2']), { mock, root: s.root, sleeps })
    assert.equal(r.exitCode, 0, r.output)
    assert.equal(r.failures.length, 0)
    // uploads: one start + one finalize per track, then delete per track
    assert.equal(mock.calls.filter(isStart).length, 2)
    assert.equal(mock.calls.filter((c) => c.method === 'POST' && c.url.startsWith('https://upload.mock.invalid/')).length, 2)
    assert.equal(mock.calls.filter(isDel).length, 2)
    assert.equal(mock.uploaded.size, 0, 'all uploads deleted')
    assert.ok(mock.calls.some((c) => c.method === 'GET' && c.url.includes('/v1beta/files/')), 'polled the PROCESSING file')
    // generate: 429 (+retry) + 2 ok for a (one invalid json re-request) + 2 ok for b
    const gens = mock.calls.filter(isGen)
    assert.equal(gens.length, 6)
    assert.ok(sleeps.includes(3000), `honoured server retryDelay 3s, sleeps=${sleeps}`)
    assert.match(r.output, /HTTP 429, retry 1\/6 in 3\.0s/)
    // request shape
    const body = JSON.parse(gens[1].body)
    assert.equal(body.generationConfig.responseMimeType, 'application/json')
    assert.equal(body.contents[0].parts[1].fileData.fileUri.startsWith('https://generativelanguage.googleapis.com/v1beta/files/'), true)
    assert.equal('temperature' in body.generationConfig, false)
    assert.equal(gens[1].headers['x-goog-api-key'], FAKE_KEY)
    assert.ok(mock.calls.filter((c) => c.url.startsWith('https://upload.mock.invalid/')).every((c) => !('x-goog-api-key' in c.headers)))
    // cache + aggregate
    const files = fs.readdirSync(s.out).sort()
    assert.equal(files.length, 3, files.join())
    assert.ok(files.includes('_all.json'))
    const rec = JSON.parse(fs.readFileSync(path.join(s.out, files.find((f) => f.startsWith('dir_a-ambient'))), 'utf8'))
    assert.equal(rec.samples, 2)
    assert.equal(rec.model, 'gemini-3.8-flash')
    assert.equal(rec.status, 'ok')
    assert.equal(rec.rawSamples.length, 2)
    assert.equal(rec.label.valence, 6.5)
    assert.equal(rec.usage.promptTokens, 256)
    assert.ok(rec.generatedAt && rec.spread.n === 2)
    assert.ok(!JSON.stringify(rec).includes(s.audio), 'no absolute audio path stored')
    const all = JSON.parse(fs.readFileSync(path.join(s.out, '_all.json'), 'utf8'))
    assert.equal(all.length, 2)
    assert.ok(all.every((x) => x.model && x.generatedAt && x.samples === 2 && x.spread && !('rawSamples' in x)))
    assert.match(r.output, /primary\/secondary/)
    assertNoKeyLeak({ calls: mock.calls, output: r.output, outDir: s.out })

    // second run: everything cached -> zero network calls
    const m2 = makeMock({ generate: [genOk()] })
    const r2 = await runCli(base(s, ['--samples', '2']), { mock: m2, root: s.root })
    assert.equal(m2.calls.length, 0, 'cached run must not touch the network')
    assert.match(r2.output, /cached/)
    assert.equal(r2.exitCode, 0)

    // --force + --only redoes just one track, single sample
    const m3 = makeMock({ generate: [genOk(mkLabel({ primaryMood: 'epic' }))] })
    const r3 = await runCli(base(s, ['--force', '--only', 'a-ambient', '--samples', '1']), { mock: m3, root: s.root })
    assert.equal(m3.calls.filter(isStart).length, 1)
    assert.equal(m3.calls.filter(isGen).length, 1)
    assert.equal(m3.calls.filter(isDel).length, 1)
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.out, files.find((f) => f.startsWith('dir_a-ambient'))), 'utf8')).label.primaryMood, 'epic')
    assertNoKeyLeak({ calls: m3.calls, output: r3.output, outDir: s.out })
  }))

test('pipeline: --keep-uploads skips delete; temperature flag is sent', () =>
  withTmp(async (dir) => {
    const s = setup(dir, ['only.wav'])
    const mock = makeMock({ generate: [genOk()] })
    const r = await runCli(base(s, ['--samples', '1', '--keep-uploads', '--temperature', '0.4']), { mock, root: s.root })
    assert.equal(r.exitCode, 0, r.output)
    assert.equal(mock.calls.filter(isDel).length, 0)
    assert.equal(mock.uploaded.size, 1)
    assert.equal(JSON.parse(mock.calls.find(isGen).body).generationConfig.temperature, 0.4)
  }))

test('pipeline: persistent 500 -> track fails after backoff, upload still deleted, exit 1', () =>
  withTmp(async (dir) => {
    const s = setup(dir, ['only.wav'])
    const mock = makeMock({ generate: [errResp(500, 'Internal error', { status: 'INTERNAL' })], firstUploadProcessing: false })
    const sleeps = []
    const r = await runCli(base(s, ['--samples', '1', '--max-retries', '3']), { mock, root: s.root, sleeps })
    assert.equal(r.exitCode, 1)
    assert.equal(r.failures.length, 1)
    assert.equal(mock.calls.filter(isGen).length, 4, '1 try + 3 retries')
    assert.deepEqual(sleeps, [2000, 4000, 8000], 'exponential backoff')
    assert.equal(mock.calls.filter(isDel).length, 1, 'upload cleaned up despite failure')
    assert.ok(!fs.existsSync(path.join(s.out)) || !fs.readdirSync(s.out).some((f) => f.startsWith('dir_only')), 'failures are not cached')
    assertNoKeyLeak({ calls: mock.calls, output: r.output })
  }))

test('pipeline: RECITATION block -> retry once with a clip, then record blocked', () =>
  withTmp(async (dir) => {
    const s = setup(dir, ['song.wav'], 4)
    // 1) full track blocked, clip OK
    const mock = makeMock({ generate: [genBlocked('RECITATION'), genOk()] })
    const r = await runCli(base(s, ['--samples', '1', '--fallback-clip-seconds', '1']), { mock, root: s.root })
    assert.equal(r.exitCode, 0, r.output)
    const rec = JSON.parse(fs.readFileSync(path.join(s.out, fs.readdirSync(s.out).find((f) => f.startsWith('dir_song'))), 'utf8'))
    assert.equal(rec.status, 'ok')
    assert.deepEqual(rec.fellBackToClip.originalBlockReasons, ['RECITATION'])
    assert.equal(rec.clip.seconds, 1)
    assert.equal(rec.clip.physical, true)
    const uploads = mock.calls.filter((c) => c.url.startsWith('https://upload.mock.invalid/'))
    assert.equal(uploads.length, 2)
    assert.ok(uploads[1].bodyBytes < uploads[0].bodyBytes / 2, 'clip upload is smaller')
    assert.equal(mock.calls.filter(isDel).length, 2)
    assert.match(JSON.parse(mock.calls.filter(isGen)[1].body).contents[0].parts[0].text, /1-second excerpt/)
    // 2) always blocked -> status blocked, run still succeeds
    const out2 = path.join(dir, 'out2')
    const m2 = makeMock({ generate: [genBlocked('SAFETY')] })
    const r2 = await runCli(['--dir', s.audio, '--out', out2, '--concurrency', '1', '--i-understand-data-use', '--samples', '1', '--fallback-clip-seconds', '1'], { mock: m2, root: s.root })
    assert.equal(r2.exitCode, 0, r2.output)
    const rec2 = JSON.parse(fs.readFileSync(path.join(out2, fs.readdirSync(out2).find((f) => f.startsWith('dir_song'))), 'utf8'))
    assert.equal(rec2.status, 'blocked')
    assert.equal(rec2.label, null)
    assert.deepEqual(rec2.blocked.reasons, ['SAFETY'])
    assert.match(r2.output, /BLOCKED/)
    assert.equal(m2.calls.filter(isDel).length, 2)
  }))

test('pipeline: schema style falls back on a 400 about the schema field', () =>
  withTmp(async (dir) => {
    const s = setup(dir, ['x.wav', 'y.wav'])
    const mock = makeMock({ generate: [errResp(400, 'Invalid JSON payload received. Unknown name "responseSchema" at generation_config', { status: 'INVALID_ARGUMENT' }), genOk()] })
    const r = await runCli(base(s, ['--samples', '1']), { mock, root: s.root })
    assert.equal(r.exitCode, 0, r.output)
    const gens = mock.calls.filter(isGen).map((c) => JSON.parse(c.body).generationConfig)
    assert.ok(gens[0].responseSchema)
    assert.ok(gens[1].responseJsonSchema && !gens[1].responseSchema)
    assert.ok(gens.slice(1).every((g) => g.responseJsonSchema), 'chosen style sticks for later requests')
  }))

test('pipeline: rejected key stops the run early and is never echoed', () =>
  withTmp(async (dir) => {
    const s = setup(dir, ['x.wav', 'y.wav'])
    const mock = makeMock({ generate: [errResp(400, `API key not valid. Please pass a valid API key. (${FAKE_KEY})`, { status: 'INVALID_ARGUMENT' })] })
    const r = await runCli(base(s, ['--samples', '1']), { mock, root: s.root })
    assert.equal(r.exitCode, 1)
    assert.match(r.output, /API key rejected/)
    assert.equal(mock.calls.filter(isStart).length, 1, 'second track never attempted')
    assert.equal(mock.calls.filter(isDel).length, 1)
    assertNoKeyLeak({ calls: mock.calls, output: r.output, outDir: s.out })
  }))

test('pipeline: a PER-DAY quota 429 is not retried, stops the pass, and exits 3 (regression)', () =>
  withTmp(async (dir) => {
    const s = setup(dir, ['x.wav', 'y.wav', 'z.wav'])
    const daily = errResp(429, 'You exceeded your current quota, please check your plan and billing details.', {
      status: 'RESOURCE_EXHAUSTED',
      details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '20' }] }],
    })
    const mock = makeMock({ generate: [daily], firstUploadProcessing: false })
    const sleeps = []
    const r = await runCli(base(s, ['--samples', '1']), { mock, root: s.root, sleeps })
    assert.equal(r.exitCode, 3, 'exit 3 = daily quota exhausted, so a caller can rotate models')
    assert.match(r.output, /daily quota exhausted for/)
    assert.equal(mock.calls.filter(isGen).length, 1, 'no retries against a limit that will not clear')
    assert.deepEqual(sleeps, [], 'no backoff sleeps')
    assert.equal(mock.calls.filter(isStart).length, 1, 'remaining tracks are not attempted')
    assert.equal(mock.calls.filter(isDel).length, 1, 'upload cleaned up')
    assertNoKeyLeak({ calls: mock.calls, output: r.output, outDir: s.out })
  }))

test('key from .env.local; missing key is a clean error', () =>
  withTmp(async (dir) => {
    const s = setup(dir, ['x.wav'])
    fs.writeFileSync(path.join(s.root, '.env.local'), `GEMINI_API_KEY=${FAKE_KEY}\n`)
    const mock = makeMock({ generate: [genOk()] })
    const r = await runCli(base(s, ['--samples', '1']), { mock, root: s.root, env: {} })
    assert.equal(r.exitCode, 0, r.output)
    assert.match(r.output, /using \.env\.local GEMINI_API_KEY/)
    assert.equal(mock.calls.find(isGen).headers['x-goog-api-key'], FAKE_KEY)
    assertNoKeyLeak({ calls: mock.calls, output: r.output, outDir: s.out })
    fs.rmSync(path.join(s.root, '.env.local'))
    const m2 = makeMock()
    const r2 = await runCli(base(s, ['--force']), { mock: m2, root: s.root, env: {} })
    assert.equal(r2.exitCode, 2)
    assert.match(r2.output, /no API key/)
    assert.equal(m2.calls.length, 0)
  }))

test('startup warns about free-tier data use unless acknowledged', () =>
  withTmp(async (dir) => {
    const s = setup(dir, ['x.wav'])
    const noAck = base(s, ['--samples', '1']).filter((a) => a !== '--i-understand-data-use')
    const r = await runCli(noAck, { mock: makeMock({ generate: [genOk()] }), root: s.root })
    assert.match(r.output, /FREE tier Google may use submitted audio/)
    const r2 = await runCli(base(s, ['--samples', '1', '--force']), { mock: makeMock({ generate: [genOk()] }), root: s.root })
    assert.doesNotMatch(r2.output, /FREE tier/)
  }))

test('--dry-run and --list never touch the network or need a key', () =>
  withTmp(async (dir) => {
    const s = setup(dir, ['x.wav'])
    const mock = makeMock()
    const r = await runCli(['--dir', s.audio, '--out', s.out, '--dry-run', '--samples', '3'], { mock, root: s.root, env: {} })
    assert.equal(r.exitCode, 0, r.output)
    assert.equal(mock.calls.length, 0)
    assert.match(r.output, /"fileUri": "<uri returned by the Files API upload>"/)
    assert.match(r.output, /audio tokens\/pass/)
    assert.match(r.output, /Total: .*input tokens/)
    assert.ok(!fs.existsSync(s.out), 'dry run writes nothing')
    const l = await runCli(['--dir', s.audio, '--out', s.out, '--list'], { mock, root: s.root, env: {} })
    assert.equal(l.exitCode, 0)
    assert.match(l.output, /dir_x_/)
    assert.equal(mock.calls.length, 0)
    // real repo: 1500 corpus tracks report missing audio (repo root = default)
  }))

// ---------------------------------------------------------------- runner
let failed = 0
for (const t of tests) {
  try {
    await t.fn()
    console.log(`  ok    ${t.name}`)
  } catch (e) {
    failed++
    console.log(`  FAIL  ${t.name}\n        ${String(e.stack ?? e).split('\n').slice(0, 6).join('\n        ')}`)
  }
}
console.log(`\n${tests.length - failed}/${tests.length} tests passed`)
process.exitCode = failed ? 1 : 0
