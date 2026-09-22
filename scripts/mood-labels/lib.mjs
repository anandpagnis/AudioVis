/**
 * Pure(ish) helpers for the offline Gemini mood-labelling scripts.
 * Everything here is deterministic and unit-testable (see selftest.mjs); the
 * only I/O helpers are the clearly-marked track-discovery ones at the bottom.
 *
 * No dependencies. Node >= 18 (global fetch is used by label.mjs, not here).
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// ---------------------------------------------------------------------------
// Taxonomy (verbatim from the mood engine v2 spec)
// ---------------------------------------------------------------------------

export const MOODS = [
  'serene',
  'tender',
  'dreamy',
  'melancholic',
  'brooding',
  'mysterious',
  'groove',
  'playful',
  'uplifting',
  'euphoric',
  'driving',
  'tense',
  'aggressive',
  'epic',
]
/** Primary mood may additionally be 'silence' (essentially silent track). */
export const PRIMARY_MOODS = [...MOODS, 'silence']
export const TEMPO_FEELS = ['slow', 'medium', 'fast']
export const LYRICS_INFLUENCE = ['none', 'some', 'strong']

/** Short glosses used only inside the prompt to disambiguate the ids. */
const MOOD_GLOSS = {
  serene: 'calm, peaceful, spacious, gentle, still',
  tender: 'warm, intimate, affectionate, soft, close',
  dreamy: 'hazy, floating, ethereal, washed in reverb, drifting',
  melancholic: 'sad, wistful, longing, sorrowful, bittersweet',
  brooding: 'dark, heavy, moody, simmering, introspective',
  mysterious: 'eerie, ambiguous, curious, suspended, enigmatic',
  groove: 'a steady laid-back or funky rhythmic pocket is the dominant character; head-nodding, swinging',
  playful: 'light, quirky, bouncy, humorous, whimsical',
  uplifting: 'hopeful, warm, positive, rising, inspiring',
  euphoric: 'ecstatic, rapturous, peak-energy joy, festival-like',
  driving: 'propulsive, relentless forward momentum, urgent, determined',
  tense: 'anxious, suspenseful, unresolved, dissonant, on edge',
  aggressive: 'angry, hostile, harsh, violent, confrontational',
  epic: 'grand, cinematic, triumphant, massive in scale',
  silence: 'ONLY if the track is essentially silent (no musical content)',
}

export const NUMERIC_RANGES = {
  valence: [1, 9],
  arousal: [1, 9],
  tension: [1, 9],
  vocalPresence: [0, 1],
  acoustic: [0, 1],
  danceability: [0, 1],
  confidence: [0, 1],
}
/** Fields averaged across --samples passes (quarterArousal is averaged element-wise). */
export const AVERAGED_FIELDS = Object.keys(NUMERIC_RANGES)

export const MAX_TIMELINE = 6
export const MAX_GENRES = 3
export const MAX_INSTRUMENTS = 5
export const MAX_RATIONALE_WORDS = 40

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

/** Field order also used as propertyOrdering (evidence first, then scores). */
const FIELD_ORDER = [
  'rationale',
  'lyricsInfluence',
  'primaryMood',
  'secondaryMood',
  'valence',
  'arousal',
  'tension',
  'quarterArousal',
  'moodTimeline',
  'vocalPresence',
  'acoustic',
  'tempoFeel',
  'danceability',
  'genres',
  'instruments',
  'confidence',
]

/**
 * JSON-Schema-style response schema, restricted to the subset Gemini structured
 * output documents: type, enum, minimum, maximum, items, minItems, maxItems,
 * properties, required, description. Deliberately NO nullable / type arrays /
 * anyOf / additionalProperties: the "no secondary mood" case is the enum value
 * "none", which the validator maps to null.
 */
export function buildResponseSchema() {
  const num = (min, max, description) => ({ type: 'number', minimum: min, maximum: max, description })
  const properties = {
    rationale: {
      type: 'string',
      description: `At most ${MAX_RATIONALE_WORDS} words citing audible evidence (instruments, harmony, rhythm, dynamics).`,
    },
    lyricsInfluence: {
      type: 'string',
      enum: LYRICS_INFLUENCE,
      description: 'none = label from sound alone; some = lyrics nudged it; strong = label would differ without lyrics.',
    },
    primaryMood: { type: 'string', enum: PRIMARY_MOODS, description: 'Single best mood id.' },
    secondaryMood: {
      type: 'string',
      enum: ['none', ...MOODS],
      description: 'Second mood if clearly present, otherwise "none".',
    },
    valence: num(1, 9, '1 = bleak/sad/hostile, 5 = neutral/ambiguous, 9 = joyful/bright.'),
    arousal: num(1, 9, '1 = near-still, 5 = moderate, 9 = frantic/very intense.'),
    tension: num(1, 9, '1 = relaxed/consonant, 9 = anxious/dissonant/suspenseful.'),
    quarterArousal: {
      type: 'array',
      items: { type: 'number', minimum: 1, maximum: 9 },
      minItems: 4,
      maxItems: 4,
      description: 'Arousal (1-9) of each quarter of the track in time order.',
    },
    moodTimeline: {
      type: 'array',
      maxItems: MAX_TIMELINE,
      description: `Up to ${MAX_TIMELINE} ordered segments, only if the mood clearly changes; otherwise an empty array.`,
      items: {
        type: 'object',
        properties: {
          startSec: { type: 'number', minimum: 0 },
          endSec: { type: 'number', minimum: 0 },
          mood: { type: 'string', enum: PRIMARY_MOODS },
        },
        required: ['startSec', 'endSec', 'mood'],
      },
    },
    vocalPresence: num(0, 1, 'Fraction of the track containing vocals (0 = instrumental).'),
    acoustic: num(0, 1, '0 = fully electronic/synthetic, 1 = fully acoustic.'),
    tempoFeel: { type: 'string', enum: TEMPO_FEELS, description: 'Perceived pace, not BPM.' },
    danceability: num(0, 1, 'How suitable for dancing (steady, strong beat).'),
    genres: { type: 'array', items: { type: 'string' }, maxItems: MAX_GENRES, description: 'Up to 3 lowercase genres.' },
    instruments: {
      type: 'array',
      items: { type: 'string' },
      maxItems: MAX_INSTRUMENTS,
      description: 'Up to 5 audibly present instruments.',
    },
    confidence: num(0, 1, 'Your certainty in the mood labels.'),
  }
  const ordered = {}
  for (const k of FIELD_ORDER) ordered[k] = properties[k]
  return { type: 'object', properties: ordered, required: [...FIELD_ORDER] }
}

/**
 * Convert to the OpenAPI-subset flavour used by `responseSchema`: upper-case
 * Type enum names ("OBJECT", "STRING", ...) and propertyOrdering on objects.
 */
export function toOpenApiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toOpenApiSchema)
  if (schema === null || typeof schema !== 'object') return schema
  const out = {}
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'type' && typeof v === 'string') out.type = v.toUpperCase()
    else if (k === 'properties') {
      out.properties = {}
      for (const [pk, pv] of Object.entries(v)) out.properties[pk] = toOpenApiSchema(pv)
      out.propertyOrdering = Object.keys(v)
    } else if (k === 'items') out.items = toOpenApiSchema(v)
    else out[k] = v
  }
  return out
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export function formatDuration(sec) {
  const s = Math.round(sec)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * @param {{durationSec?: number|null, durationExact?: boolean,
 *          clip?: {startSec: number, seconds: number, physical: boolean}|null}} [opts]
 *   clip.physical = the uploaded file already is the excerpt; otherwise the
 *   whole file is uploaded and the model is told to look at one window only.
 */
export function buildPrompt(opts = {}) {
  const { durationSec = null, durationExact = true, clip = null } = opts
  let dur
  if (clip && clip.physical) {
    dur = `The attached audio is a ${Math.round(clip.seconds)}-second excerpt of a longer track. Label the excerpt; use seconds from the start of the excerpt for any timestamps.`
  } else if (clip) {
    dur = `Analyse ONLY the window from ${Math.round(clip.startSec)} s to ${Math.round(clip.startSec + clip.seconds)} s of the attached file and ignore the rest. Use seconds from the start of that window for any timestamps, and split "quarters" within that window.`
  } else if (durationSec && durationSec > 0) {
    dur = `The track is ${durationExact ? '' : 'roughly '}${Math.round(durationSec)} seconds long (${formatDuration(durationSec)}). Use seconds from the start of the track for any timestamps.`
  } else {
    dur = 'The track duration is not given; infer timestamps in seconds from the start of the track.'
  }
  const moods = PRIMARY_MOODS.map((m) => `- ${m}: ${MOOD_GLOSS[m]}`).join('\n')
  return [
    'You are a music-perception annotator producing ground-truth labels to evaluate an automatic mood-detection engine. Listen to the whole attached audio track and label the mood it conveys.',
    '',
    'WHAT TO RATE: rate what the SOUND conveys - timbre, harmony, rhythm, tempo, dynamics and texture. Lyrics, if there are any, are secondary evidence only: they may nudge a label but must not override what the music itself sounds like. Report lyricsInfluence as "none" if your labels rest on the sound alone, "some" if lyrics shifted them slightly, "strong" if the labels would clearly differ without the lyrics.',
    '',
    dur,
    '',
    'MOOD TAXONOMY - primaryMood must be exactly one of these ids; secondaryMood is optional (use "none" if there is no clear second mood; never repeat the primary; never "silence"):',
    moods,
    '',
    'SCALES (numbers, decimals allowed):',
    '- valence 1-9: 1 = bleak / sad / hostile, 5 = neutral / ambiguous, 9 = joyful / bright.',
    '- arousal 1-9: 1 = near-still, 5 = moderate, 9 = frantic / very intense.',
    '- tension 1-9: 1 = relaxed / consonant, 9 = anxious / dissonant / suspenseful.',
    '- quarterArousal: four arousal ratings (1-9) for the first, second, third and fourth quarter of the track by time.',
    '- vocalPresence 0-1: fraction of the track containing a voice (0 = instrumental).',
    '- acoustic 0-1: 0 = fully electronic / synthetic, 1 = fully acoustic.',
    '- danceability 0-1: how suitable the track is for dancing (steady, strong beat).',
    '- confidence 0-1: how sure you are of the mood labels.',
    '- tempoFeel: perceived pace (slow / medium / fast), not a BPM measurement.',
    '',
    'RULES:',
    '- Use the full 1-9 range. Do not cluster ratings around 5; commit to what you hear.',
    '- Do not default to "groove". Choose groove only when a steady, laid-back or funky rhythmic pocket is genuinely the dominant character of the track.',
    `- moodTimeline: only if the mood clearly changes during the track, give up to ${MAX_TIMELINE} ordered, non-overlapping segments {startSec, endSec, mood}; otherwise return an empty array.`,
    `- genres: up to ${MAX_GENRES} lowercase genres. instruments: up to ${MAX_INSTRUMENTS} instruments you can actually hear.`,
    `- rationale: at most ${MAX_RATIONALE_WORDS} words, citing audible evidence (instruments, harmony, rhythm, dynamics). Do not guess the artist or title.`,
    '- Never transcribe, quote or reproduce lyrics, and do not identify the song: output the mood analysis JSON only.',
    '- If the track is essentially silent, use primaryMood "silence" with valence 5, arousal 1, tension 1.',
    '',
    'Respond with the JSON object only.',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Request building / response parsing
// ---------------------------------------------------------------------------

export const API_BASE = 'https://generativelanguage.googleapis.com'
export const SCHEMA_STYLES = ['responseSchema', 'responseJsonSchema', 'responseFormat']

/**
 * Build the generateContent request body.
 * schemaStyle:
 *  - responseSchema     generationConfig.responseMimeType + responseSchema (OpenAPI subset, upper-case types)
 *  - responseJsonSchema generationConfig.responseMimeType + responseJsonSchema (JSON Schema)
 *  - responseFormat     generationConfig.responseFormat.text.{mimeType, schema} (newer docs; unverified here)
 */
export function buildGenerateRequest({
  fileUri,
  mimeType,
  prompt,
  temperature = null,
  schemaStyle = 'responseSchema',
  maxOutputTokens = null,
  thinkingLevel = null,
}) {
  const schema = buildResponseSchema()
  // Temperature is omitted unless asked for: Google "strongly recommend[s]
  // keeping the temperature parameter at its default value of 1.0" on Gemini 3.
  const generationConfig = {}
  if (temperature !== null && temperature !== undefined) generationConfig.temperature = temperature
  if (maxOutputTokens) generationConfig.maxOutputTokens = maxOutputTokens
  if (thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel }
  if (schemaStyle === 'responseSchema') {
    generationConfig.responseMimeType = 'application/json'
    generationConfig.responseSchema = toOpenApiSchema(schema)
  } else if (schemaStyle === 'responseJsonSchema') {
    generationConfig.responseMimeType = 'application/json'
    generationConfig.responseJsonSchema = schema
  } else if (schemaStyle === 'responseFormat') {
    generationConfig.responseFormat = { text: { mimeType: 'application/json', schema } }
  } else {
    throw new Error(`unknown schema style: ${schemaStyle}`)
  }
  return {
    contents: [{ role: 'user', parts: [{ text: prompt }, { fileData: { mimeType, fileUri } }] }],
    generationConfig,
  }
}

export function generateUrl(model) {
  return `${API_BASE}/v1beta/models/${String(model).replace(/^models\//, '')}:generateContent`
}

/** finishReason values that mean the content filter (not us) stopped the answer. */
export const BLOCK_FINISH_REASONS = ['RECITATION', 'SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'LANGUAGE']

/** Thrown when a response was blocked/filtered (finishReason or promptFeedback). */
export class BlockedError extends Error {
  constructor(reason, where) {
    super(`response blocked: ${reason} (${where})`)
    this.name = 'BlockedError'
    this.reason = reason
  }
}

/** Pull the JSON text out of a generateContent response; throws BlockedError on filter blocks. */
export function extractText(resp) {
  const br = resp?.promptFeedback?.blockReason
  if (br && br !== 'BLOCK_REASON_UNSPECIFIED') throw new BlockedError(br, 'promptFeedback.blockReason')
  const cand = resp?.candidates?.[0]
  if (!cand) throw new Error('response has no candidates')
  if (BLOCK_FINISH_REASONS.includes(cand.finishReason)) throw new BlockedError(cand.finishReason, 'finishReason')
  const text = (cand.content?.parts ?? [])
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('')
  if (!text.trim()) throw new Error(`empty response text (finishReason=${cand.finishReason ?? 'unknown'})`)
  return text
}

/** Parse model text into an object, tolerating ```json fences. Throws on failure. */
export function parseJsonText(text) {
  let t = String(text).trim()
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fence) t = fence[1]
  return JSON.parse(t)
}

// ---------------------------------------------------------------------------
// Validation (with clamping)
// ---------------------------------------------------------------------------

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))
const round3 = (x) => Math.round(x * 1000) / 1000

function toNumber(x) {
  if (typeof x === 'number') return Number.isFinite(x) ? x : null
  if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x)
  return null
}

/**
 * Validate + normalise one label object. Numeric ranges are clamped (recorded
 * as warnings); structural problems (missing/invalid enum, wrong array length)
 * are errors.
 * @returns {{ok: boolean, errors: string[], warnings: string[], value: object|null}}
 */
export function validateLabel(raw, { durationSec = null } = {}) {
  const errors = []
  const warnings = []
  if (!isObj(raw)) return { ok: false, errors: ['label is not a JSON object'], warnings, value: null }
  const v = {}

  const enumField = (key, allowed) => {
    const x = typeof raw[key] === 'string' ? raw[key].trim().toLowerCase() : raw[key]
    if (!allowed.includes(x)) {
      errors.push(`${key}: expected one of [${allowed.join(', ')}], got ${JSON.stringify(raw[key])}`)
      return null
    }
    return x
  }

  v.primaryMood = enumField('primaryMood', PRIMARY_MOODS)

  // secondaryMood: null | 'none' | mood id
  const sm = raw.secondaryMood
  if (sm === null || sm === undefined || (typeof sm === 'string' && ['none', 'null', ''].includes(sm.trim().toLowerCase()))) {
    v.secondaryMood = null
  } else if (typeof sm === 'string' && MOODS.includes(sm.trim().toLowerCase())) {
    const s = sm.trim().toLowerCase()
    if (s === v.primaryMood) {
      warnings.push('secondaryMood equalled primaryMood; set to null')
      v.secondaryMood = null
    } else v.secondaryMood = s
  } else {
    errors.push(`secondaryMood: expected null/none or one of [${MOODS.join(', ')}], got ${JSON.stringify(sm)}`)
  }

  for (const [key, [lo, hi]] of Object.entries(NUMERIC_RANGES)) {
    const n = toNumber(raw[key])
    if (n === null) {
      errors.push(`${key}: expected a number, got ${JSON.stringify(raw[key])}`)
      continue
    }
    const c = clamp(n, lo, hi)
    if (c !== n) warnings.push(`${key}: ${n} clamped to ${c}`)
    v[key] = round3(c)
  }

  if (!Array.isArray(raw.quarterArousal) || raw.quarterArousal.length !== 4) {
    errors.push('quarterArousal: expected an array of exactly 4 numbers')
  } else {
    const q = raw.quarterArousal.map(toNumber)
    if (q.some((x) => x === null)) errors.push('quarterArousal: all 4 entries must be numbers')
    else {
      v.quarterArousal = q.map((x) => {
        const c = clamp(x, 1, 9)
        if (c !== x) warnings.push(`quarterArousal: ${x} clamped to ${c}`)
        return round3(c)
      })
    }
  }

  v.tempoFeel = enumField('tempoFeel', TEMPO_FEELS)
  v.lyricsInfluence = enumField('lyricsInfluence', LYRICS_INFLUENCE)

  // moodTimeline
  if (!Array.isArray(raw.moodTimeline)) {
    errors.push('moodTimeline: expected an array (empty if the mood does not change)')
  } else {
    const segs = []
    for (const [i, s] of raw.moodTimeline.entries()) {
      const a = toNumber(s?.startSec)
      const b = toNumber(s?.endSec)
      const m = typeof s?.mood === 'string' ? s.mood.trim().toLowerCase() : null
      if (a === null || b === null || !PRIMARY_MOODS.includes(m)) {
        warnings.push(`moodTimeline[${i}] malformed; dropped`)
        continue
      }
      const start = Math.max(0, a)
      let end = Math.max(0, b)
      if (durationSec && durationSec > 0) end = Math.min(end, durationSec)
      if (!(end > start)) {
        warnings.push(`moodTimeline[${i}] has end <= start; dropped`)
        continue
      }
      segs.push({ startSec: round3(start), endSec: round3(end), mood: m })
    }
    segs.sort((x, y) => x.startSec - y.startSec)
    if (segs.length > MAX_TIMELINE) warnings.push(`moodTimeline truncated to ${MAX_TIMELINE}`)
    v.moodTimeline = segs.slice(0, MAX_TIMELINE)
  }

  const strList = (key, max) => {
    if (!Array.isArray(raw[key])) {
      errors.push(`${key}: expected an array of strings`)
      return
    }
    const list = raw[key]
      .filter((x) => typeof x === 'string' && x.trim())
      .map((x) => x.trim().toLowerCase())
    const uniq = [...new Set(list)]
    if (uniq.length > max) warnings.push(`${key} truncated to ${max}`)
    v[key] = uniq.slice(0, max)
  }
  strList('genres', MAX_GENRES)
  strList('instruments', MAX_INSTRUMENTS)

  if (typeof raw.rationale !== 'string' || !raw.rationale.trim()) errors.push('rationale: expected a non-empty string')
  else {
    const words = raw.rationale.trim().split(/\s+/)
    if (words.length > MAX_RATIONALE_WORDS) {
      warnings.push(`rationale truncated from ${words.length} to ${MAX_RATIONALE_WORDS} words`)
      v.rationale = words.slice(0, MAX_RATIONALE_WORDS).join(' ')
    } else v.rationale = words.join(' ')
  }

  if (errors.length) return { ok: false, errors, warnings, value: null }
  const ordered = {}
  for (const k of FIELD_ORDER) ordered[k] = v[k]
  return { ok: true, errors, warnings, value: ordered }
}

// ---------------------------------------------------------------------------
// Aggregation across --samples passes
// ---------------------------------------------------------------------------

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
const popSd = (xs) => {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)))
}

/** Most frequent item; ties broken by `tieScore` (higher wins) then first seen. */
function majority(items, tieScore = () => 0) {
  const counts = new Map()
  items.forEach((it, i) => {
    const c = counts.get(it) ?? { n: 0, score: 0, first: i }
    c.n += 1
    c.score += tieScore(i)
    counts.set(it, c)
  })
  let best = null
  for (const [k, c] of counts) {
    if (!best || c.n > best.c.n || (c.n === best.c.n && (c.score > best.c.score || (c.score === best.c.score && c.first < best.c.first))))
      best = { k, c }
  }
  return { value: best.k, counts: Object.fromEntries([...counts].map(([k, c]) => [k, c.n])) }
}

/** Frequency-ranked union of string lists. */
function topStrings(lists, max) {
  const counts = new Map()
  lists.flat().forEach((s, i) => {
    const c = counts.get(s) ?? { n: 0, first: i }
    c.n += 1
    counts.set(s, c)
  })
  return [...counts]
    .sort((a, b) => b[1].n - a[1].n || a[1].first - b[1].first)
    .slice(0, max)
    .map(([s]) => s)
}

/**
 * Combine validated label objects into one label + spread.
 * Numeric fields (incl. quarterArousal element-wise) are averaged; primaryMood,
 * tempoFeel, lyricsInfluence are majority votes (mood ties -> higher summed
 * confidence). moodTimeline/rationale come from the most confident sample that
 * agrees with the winning primary mood.
 * @returns {{label: object, spread: object}}
 */
export function aggregateSamples(labels) {
  if (!labels?.length) throw new Error('aggregateSamples: no samples')
  const n = labels.length
  const conf = (i) => labels[i].confidence
  const primary = majority(labels.map((l) => l.primaryMood), conf)

  const label = {}
  label.primaryMood = primary.value

  const secs = labels.map((l, i) => ({ s: l.secondaryMood, i })).filter((x) => x.s && x.s !== primary.value)
  label.secondaryMood = secs.length ? majority(secs.map((x) => x.s), (j) => conf(secs[j].i)).value : null

  for (const f of AVERAGED_FIELDS) label[f] = round3(mean(labels.map((l) => l[f])))
  label.quarterArousal = [0, 1, 2, 3].map((q) => round3(mean(labels.map((l) => l.quarterArousal[q]))))
  label.tempoFeel = majority(labels.map((l) => l.tempoFeel), conf).value
  label.lyricsInfluence = majority(labels.map((l) => l.lyricsInfluence), conf).value
  label.genres = topStrings(labels.map((l) => l.genres), MAX_GENRES)
  label.instruments = topStrings(labels.map((l) => l.instruments), MAX_INSTRUMENTS)

  let rep = -1
  labels.forEach((l, i) => {
    if (l.primaryMood === primary.value && (rep < 0 || l.confidence > labels[rep].confidence)) rep = i
  })
  label.moodTimeline = labels[rep].moodTimeline
  label.rationale = labels[rep].rationale

  const ordered = {}
  for (const k of FIELD_ORDER) ordered[k] = label[k]

  const spread = {
    n,
    moodAgreement: round3(primary.counts[primary.value] / n),
    moodCounts: primary.counts,
    sd: {
      valence: round3(popSd(labels.map((l) => l.valence))),
      arousal: round3(popSd(labels.map((l) => l.arousal))),
      tension: round3(popSd(labels.map((l) => l.tension))),
    },
    range: {
      valence: [Math.min(...labels.map((l) => l.valence)), Math.max(...labels.map((l) => l.valence))],
      arousal: [Math.min(...labels.map((l) => l.arousal)), Math.max(...labels.map((l) => l.arousal))],
      tension: [Math.min(...labels.map((l) => l.tension)), Math.max(...labels.map((l) => l.tension))],
    },
  }
  return { label: ordered, spread }
}

/**
 * Flag tracks whose samples disagree (LLM labels are pre-labels for human
 * review, not ground truth). Needs >= 2 samples to say anything about spread.
 * @returns {{needsReview: boolean, reviewReasons: string[]}}
 */
export function reviewFlags(label, spread, { rangeThreshold = 1.5 } = {}) {
  const reasons = []
  if (spread.n >= 2) {
    const r = (k) => spread.range[k][1] - spread.range[k][0]
    if (r('arousal') > rangeThreshold) reasons.push(`arousal range ${round3(r('arousal'))} > ${rangeThreshold}`)
    if (r('valence') > rangeThreshold) reasons.push(`valence range ${round3(r('valence'))} > ${rangeThreshold}`)
    if (spread.n >= 3 && spread.moodAgreement < 0.5) reasons.push(`primary mood agreement only ${spread.moodAgreement}`)
  }
  if (label.confidence < 0.4) reasons.push(`low mean confidence ${label.confidence}`)
  return { needsReview: reasons.length > 0, reviewReasons: reasons }
}

// ---------------------------------------------------------------------------
// Audio / token / cost helpers
// ---------------------------------------------------------------------------

export const AUDIO_EXTS = ['.mp3', '.wav', '.flac', '.m4a', '.ogg', '.opus']
const MIME_BY_EXT = {
  '.mp3': 'audio/mp3',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/m4a',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
}
export const mimeForFile = (file) => MIME_BY_EXT[path.extname(file).toLowerCase()] ?? null
export const isAudioFile = (file) => AUDIO_EXTS.includes(path.extname(file).toLowerCase())

/** Documented rate: 32 tokens per second of audio. */
export const TOKENS_PER_SECOND = 32
export const estimateAudioTokens = (sec) => Math.round(sec * TOKENS_PER_SECOND)

/** USD per 1M tokens (standard paid tier). `until` = last day of the price. */
const PRICING = [
  { model: 'gemini-3.8-flash', tiers: [{ until: '2026-12-31', in: 0.75, out: 3.75 }, { until: null, in: 1.5, out: 7.5 }] },
  { model: 'gemini-3.5-flash-lite', tiers: [{ until: null, in: 0.3, out: 2.5 }] },
  { model: 'gemini-2.5-flash', tiers: [{ until: null, in: 1.0, out: 2.5 }] }, // audio input price
]
export function priceFor(model, date = new Date()) {
  const key = String(model).replace(/^models\//, '')
  const row = PRICING.find((p) => p.model === key)
  if (!row) return null
  const day = date.toISOString().slice(0, 10)
  return row.tiers.find((t) => t.until === null || day <= t.until) ?? null
}
/** Rough output size per label incl. some thinking; used only for dry-run estimates. */
export const ASSUMED_OUTPUT_TOKENS = 1500
export function estimateCostUsd(model, inputTokens, outputTokens = ASSUMED_OUTPUT_TOKENS, date = new Date()) {
  const p = priceFor(model, date)
  return p ? (inputTokens * p.in + outputTokens * p.out) / 1e6 : null
}

/** WAV header duration; returns null if not a parseable PCM/RIFF file. */
export function wavDurationSec(buf, fileSize = buf.length) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null
  let off = 12
  let byteRate = 0
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ' && off + 20 <= buf.length) byteRate = buf.readUInt32LE(off + 16)
    if (id === 'data') {
      const dataBytes = Math.min(size, fileSize - off - 8)
      return byteRate ? dataBytes / byteRate : null
    }
    off += 8 + size + (size % 2)
  }
  return null
}

/**
 * Slice a PCM WAV to [startSec, startSec+seconds) and return a new valid WAV
 * buffer, or null if the buffer is not a parseable WAV.
 */
export function wavSlice(buf, startSec, seconds) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null
  let off = 12
  let fmt = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') fmt = { chunk: buf.subarray(off, off + 8 + size), byteRate: buf.readUInt32LE(off + 16), blockAlign: buf.readUInt16LE(off + 20) }
    if (id === 'data' && fmt) {
      const data = buf.subarray(off + 8, Math.min(buf.length, off + 8 + size))
      const align = fmt.blockAlign || 1
      const from = Math.min(data.length, Math.floor((startSec * fmt.byteRate) / align) * align)
      const to = Math.min(data.length, from + Math.floor((seconds * fmt.byteRate) / align) * align)
      const slice = data.subarray(from, to)
      const head = Buffer.alloc(12)
      head.write('RIFF', 0, 'ascii')
      head.writeUInt32LE(4 + fmt.chunk.length + 8 + slice.length, 4)
      head.write('WAVE', 8, 'ascii')
      const dh = Buffer.alloc(8)
      dh.write('data', 0, 'ascii')
      dh.writeUInt32LE(slice.length, 4)
      return Buffer.concat([head, fmt.chunk, dh, slice])
    }
    off += 8 + size + (size % 2)
  }
  return null
}

/**
 * Best-known duration: manifest value, else WAV header, else a 128 kbps size
 * guess flagged as inexact (only used for prompts/estimates).
 */
export function estimateDuration({ metaDurationSec, filePath, sizeBytes }) {
  if (metaDurationSec > 0) return { sec: metaDurationSec, exact: true }
  if (path.extname(filePath).toLowerCase() === '.wav') {
    try {
      const fd = fs.openSync(filePath, 'r')
      const head = Buffer.alloc(4096)
      const n = fs.readSync(fd, head, 0, 4096, 0)
      fs.closeSync(fd)
      const s = wavDurationSec(head.subarray(0, n), sizeBytes)
      if (s) return { sec: s, exact: true }
    } catch {
      /* fall through */
    }
  }
  return { sec: sizeBytes / 16000, exact: false } // 128 kbps = 16000 B/s
}

// ---------------------------------------------------------------------------
// Retry / errors / secrets
// ---------------------------------------------------------------------------

export const RETRYABLE_STATUS = [408, 429, 500, 502, 503, 504]

/** Exponential backoff with cap; attempt is 0-based. jitter in [0,1). */
export function backoffDelayMs(attempt, { baseMs = 2000, capMs = 60000, jitter = 0 } = {}) {
  return Math.min(capMs, baseMs * 2 ** attempt) + Math.round(jitter * 1000)
}

/**
 * Server-suggested wait (ms) from a Retry-After header or a google.rpc.RetryInfo
 * detail ("retryDelay": "34s") in an error body; null if none.
 */
export function parseRetryDelayMs(headers, bodyText) {
  const ra = headers?.get?.('retry-after')
  if (ra) {
    const secs = Number(ra)
    if (Number.isFinite(secs)) return Math.round(secs * 1000)
    const d = Date.parse(ra)
    if (!Number.isNaN(d)) return Math.max(0, d - Date.now())
  }
  const m = /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(bodyText ?? '')
  return m ? Math.round(Number(m[1]) * 1000) : null
}

/** Replace every occurrence of the secret in a string (defence in depth for logs). */
export function redact(text, secret) {
  if (!secret || typeof text !== 'string') return text
  return text.split(secret).join('[REDACTED]')
}

/** Short human message from a Google API error body. */
export function apiErrorMessage(status, bodyText) {
  try {
    const e = JSON.parse(bodyText)?.error
    if (e?.message) return `HTTP ${status} ${e.status ?? ''}: ${String(e.message).slice(0, 400)}`.replace(/\s+/g, ' ')
  } catch {
    /* not JSON */
  }
  return `HTTP ${status}: ${String(bodyText ?? '').slice(0, 200).replace(/\s+/g, ' ')}`
}

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------

/** Minimal .env parser: KEY=VALUE, optional `export`, quotes, # comments. */
export function parseEnvFile(text) {
  const out = {}
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m || line.trim().startsWith('#')) continue
    let val = m[2]
    const q = /^(["'])(.*)\1/.exec(val)
    if (q) val = q[2]
    else val = val.replace(/\s+#.*$/, '')
    out[m[1]] = val
  }
  return out
}

/**
 * @returns {{key: string, source: string}|null}  source names where it came
 * from (never the key itself).
 */
export function resolveApiKey(env, envFileText) {
  const file = envFileText ? parseEnvFile(envFileText) : {}
  for (const [name, bag, label] of [
    ['GEMINI_API_KEY', env, 'env GEMINI_API_KEY'],
    ['GOOGLE_API_KEY', env, 'env GOOGLE_API_KEY'],
    ['GEMINI_API_KEY', file, '.env.local GEMINI_API_KEY'],
    ['GOOGLE_API_KEY', file, '.env.local GOOGLE_API_KEY'],
  ]) {
    const v = bag?.[name]
    if (typeof v === 'string' && v.trim()) return { key: v.trim(), source: label }
  }
  return null
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL = 'gemini-3.8-flash'

export function parseArgs(argv) {
  const o = {
    list: false,
    dryRun: false,
    force: false,
    keepUploads: false,
    verbose: false,
    help: false,
    only: null,
    limit: Infinity,
    samples: 3,
    concurrency: 2,
    model: DEFAULT_MODEL,
    dirs: [],
    sources: null,
    out: null,
    maxRetries: 6,
    temperature: null,
    thinkingLevel: null,
    schemaStyle: 'responseSchema',
    ackDataUse: false,
    clipSeconds: null,
    clipStart: 0,
    fallbackClipSeconds: 60,
  }
  const bad = (msg) => {
    throw new Error(msg)
  }
  const posInt = (name, s, min = 1) => {
    const n = Number(s)
    if (!Number.isInteger(n) || n < min) bad(`${name} must be an integer >= ${min}, got "${s}"`)
    return n
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => {
      if (i + 1 >= argv.length) bad(`${a} needs a value`)
      return argv[++i]
    }
    switch (a) {
      case '--list': o.list = true; break
      case '--dry-run': o.dryRun = true; break
      case '--force': o.force = true; break
      case '--keep-uploads': o.keepUploads = true; break
      case '--verbose': o.verbose = true; break
      case '--i-understand-data-use': o.ackDataUse = true; break
      case '--help': case '-h': o.help = true; break
      case '--only': o.only = val(); break
      case '--limit': o.limit = posInt('--limit', val(), 1); break
      case '--samples': o.samples = posInt('--samples', val(), 1); break
      case '--concurrency': o.concurrency = posInt('--concurrency', val(), 1); break
      case '--max-retries': o.maxRetries = posInt('--max-retries', val(), 0); break
      case '--model': o.model = val(); break
      case '--dir': case '--calibration-dir': o.dirs.push(val()); break
      case '--clip-seconds': o.clipSeconds = posInt('--clip-seconds', val(), 1); break
      case '--clip-start': o.clipStart = posInt('--clip-start', val(), 0); break
      case '--fallback-clip-seconds': o.fallbackClipSeconds = posInt('--fallback-clip-seconds', val(), 1); break
      case '--thinking-level': {
        const t = val()
        if (!['minimal', 'low', 'medium', 'high'].includes(t)) bad('--thinking-level must be minimal|low|medium|high')
        o.thinkingLevel = t
        break
      }
      case '--sources': o.sources = val().split(',').map((s) => s.trim()).filter(Boolean); break
      case '--out': o.out = val(); break
      case '--temperature': {
        const t = Number(val())
        if (!Number.isFinite(t) || t < 0 || t > 2) bad('--temperature must be between 0 and 2')
        o.temperature = t
        break
      }
      case '--schema-style': {
        const s = val()
        if (!SCHEMA_STYLES.includes(s)) bad(`--schema-style must be one of ${SCHEMA_STYLES.join(', ')}`)
        o.schemaStyle = s
        break
      }
      default:
        bad(`unknown argument: ${a}`)
    }
  }
  if (o.sources === null) o.sources = o.dirs.length ? [] : ['testfolder', 'corpus']
  if (o.dirs.length && !o.sources.includes('dir')) o.sources.push('dir')
  for (const s of o.sources) if (!['testfolder', 'corpus', 'dir', 'none'].includes(s)) bad(`unknown source "${s}"`)
  o.sources = o.sources.filter((s) => s !== 'none')
  // temperature stays null (= omitted = model default) unless --temperature is given.
  return o
}

// ---------------------------------------------------------------------------
// Jamendo tag -> coarse expectation map (used by compare-to-jamendo.mjs)
// ---------------------------------------------------------------------------

/**
 * COARSE and heuristic. Jamendo moodTheme tags are uploader-supplied and many
 * (advertising, background, film, ...) say nothing about mood, so those are
 * simply absent here. Each entry states what the tag would *typically* imply:
 *   arousal: 'low' | 'high'    (Gemini arousal <= 4 counts as low, >= 6 as high)
 *   valence: 'low' | 'high'    (same thresholds)
 *   moods:   engine mood ids that would be consistent with the tag
 */
export const JAMENDO_TAG_MAP = {
  calm: { arousal: 'low', moods: ['serene', 'tender', 'dreamy'] },
  relaxing: { arousal: 'low', moods: ['serene', 'tender', 'dreamy', 'groove'] },
  meditative: { arousal: 'low', moods: ['serene', 'dreamy', 'mysterious'] },
  soft: { arousal: 'low', moods: ['serene', 'tender', 'dreamy'] },
  mellow: { arousal: 'low', moods: ['serene', 'tender', 'dreamy', 'melancholic'] },
  slow: { arousal: 'low', moods: ['serene', 'tender', 'melancholic', 'brooding', 'dreamy'] },
  ballad: { arousal: 'low', moods: ['tender', 'melancholic', 'serene'] },
  dream: { moods: ['dreamy', 'serene', 'mysterious'] },
  sad: { valence: 'low', arousal: 'low', moods: ['melancholic', 'brooding', 'tender'] },
  melancholic: { valence: 'low', moods: ['melancholic', 'brooding', 'tender'] },
  emotional: { moods: ['melancholic', 'tender', 'epic', 'uplifting'] },
  romantic: { valence: 'high', moods: ['tender', 'dreamy', 'serene'] },
  love: { valence: 'high', moods: ['tender', 'uplifting', 'dreamy'] },
  dark: { valence: 'low', moods: ['brooding', 'mysterious', 'tense', 'aggressive'] },
  deep: { moods: ['brooding', 'mysterious', 'dreamy', 'groove'] },
  horror: { valence: 'low', moods: ['tense', 'mysterious', 'brooding'] },
  dramatic: { moods: ['epic', 'tense', 'brooding', 'melancholic'] },
  drama: { moods: ['epic', 'tense', 'brooding', 'melancholic'] },
  happy: { valence: 'high', moods: ['uplifting', 'playful', 'euphoric', 'groove'] },
  positive: { valence: 'high', moods: ['uplifting', 'playful', 'euphoric', 'groove'] },
  upbeat: { valence: 'high', arousal: 'high', moods: ['uplifting', 'playful', 'euphoric', 'driving', 'groove'] },
  fun: { valence: 'high', moods: ['playful', 'uplifting', 'euphoric', 'groove'] },
  funny: { valence: 'high', moods: ['playful'] },
  hopeful: { valence: 'high', moods: ['uplifting', 'tender', 'serene'] },
  inspiring: { valence: 'high', moods: ['uplifting', 'epic', 'euphoric'] },
  motivational: { valence: 'high', arousal: 'high', moods: ['uplifting', 'epic', 'driving', 'euphoric'] },
  uplifting: { valence: 'high', moods: ['uplifting', 'euphoric', 'epic'] },
  energetic: { arousal: 'high', moods: ['driving', 'euphoric', 'aggressive', 'uplifting', 'playful', 'groove'] },
  fast: { arousal: 'high', moods: ['driving', 'euphoric', 'aggressive', 'playful', 'tense'] },
  action: { arousal: 'high', moods: ['driving', 'aggressive', 'epic', 'tense'] },
  powerful: { arousal: 'high', moods: ['epic', 'driving', 'aggressive', 'euphoric'] },
  heavy: { arousal: 'high', moods: ['aggressive', 'brooding', 'driving', 'epic'] },
  party: { valence: 'high', arousal: 'high', moods: ['euphoric', 'groove', 'playful', 'driving'] },
  sport: { arousal: 'high', moods: ['driving', 'euphoric', 'uplifting'] },
  epic: { moods: ['epic', 'uplifting', 'driving'] },
  adventure: { moods: ['epic', 'uplifting', 'driving', 'mysterious'] },
  groovy: { moods: ['groove', 'playful', 'driving'] },
  cool: { moods: ['groove', 'brooding', 'mysterious'] },
  sexy: { moods: ['groove', 'brooding', 'tender'] },
}

const LOW_MAX = 4
const HIGH_MIN = 6

function judgeAxis(expected, value) {
  if (!expected) return { verdict: '-', note: '' }
  if (value > LOW_MAX && value < HIGH_MIN) return { verdict: '~', note: 'mid' }
  const side = value <= LOW_MAX ? 'low' : 'high'
  return side === expected ? { verdict: 'ok', note: '' } : { verdict: 'X', note: '' }
}

/**
 * Compare one Gemini label against a track's Jamendo moodTheme tags.
 * Conflicting tags (e.g. calm + energetic) leave that axis unjudged.
 * @returns {{mapped: string[], ignored: string[], arousal: object, valence: object, mood: object}}
 */
export function compareToTags(label, tags) {
  const clean = (tags ?? []).map((t) => String(t).trim().toLowerCase()).filter(Boolean)
  const mapped = clean.filter((t) => JAMENDO_TAG_MAP[t])
  const ignored = clean.filter((t) => !JAMENDO_TAG_MAP[t])
  const axis = (key) => {
    const vals = new Set(mapped.map((t) => JAMENDO_TAG_MAP[t][key]).filter(Boolean))
    return vals.size === 1 ? [...vals][0] : null
  }
  const compat = new Set(mapped.flatMap((t) => JAMENDO_TAG_MAP[t].moods ?? []))
  const moodVerdict = !compat.size
    ? { verdict: '-', note: '' }
    : { verdict: compat.has(label.primaryMood) || (label.secondaryMood && compat.has(label.secondaryMood)) ? 'ok' : 'X', note: '' }
  return {
    mapped,
    ignored,
    arousal: judgeAxis(axis('arousal'), label.arousal),
    valence: judgeAxis(axis('valence'), label.valence),
    mood: moodVerdict,
  }
}

// ---------------------------------------------------------------------------
// Track discovery (filesystem; used by label.mjs)
// ---------------------------------------------------------------------------

const cleanTag = (s) => String(s).replace(/[\r\n]+/g, '').trim()
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'track'

function walk(dir) {
  const out = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walk(p))
    else if (ent.isFile() && isAudioFile(ent.name)) out.push(p)
  }
  return out.sort()
}

function statSize(p) {
  try {
    return fs.statSync(p).size
  } catch {
    return null
  }
}

/**
 * @typedef {object} Track
 * @property {string} trackId   cache key / file name (jamendo_<id> or dir_<slug>_<hash>)
 * @property {string} source    'testfolder' | 'corpus' | 'dir'
 * @property {string} title
 * @property {string|null} artist
 * @property {string} audioPath absolute path (may not exist)
 * @property {boolean} exists
 * @property {number|null} sizeBytes
 * @property {number|null} metaDurationSec
 * @property {number|null} jamendoId
 * @property {string[]} moodTheme
 * @property {string[]} genres
 * @property {string|null} missingHint
 */

/** Discover tracks from the requested sources. Deduplicates by trackId, preferring an entry whose audio exists. */
export function discoverTracks({ root, sources, dirs = [] }) {
  const tracks = []
  const jamendo = (source, baseDir, hint) => {
    const manifestPath = path.join(baseDir, 'tracks.json')
    if (!fs.existsSync(manifestPath)) return
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    for (const t of manifest.tracks ?? []) {
      const audioPath = source === 'corpus' ? path.join(baseDir, 'audio', t.file) : path.join(baseDir, t.file)
      const sizeBytes = statSize(audioPath)
      tracks.push({
        trackId: `jamendo_${t.jamendoId}`,
        source,
        title: t.title ?? String(t.file),
        artist: t.artist ?? null,
        audioPath,
        exists: sizeBytes !== null,
        sizeBytes,
        metaDurationSec: t.durationSec ?? null,
        jamendoId: t.jamendoId ?? null,
        moodTheme: (t.moodTheme ?? []).map(cleanTag).filter(Boolean),
        genres: (t.genres ?? []).map(cleanTag).filter(Boolean),
        missingHint: hint,
      })
    }
  }
  for (const s of sources) {
    if (s === 'testfolder') jamendo('testfolder', path.join(root, 'testfolder'), 'audio missing (see testfolder/README.md)')
    else if (s === 'corpus') jamendo('corpus', path.join(root, 'corpus'), 'audio missing (run npm run corpus:fetch)')
    else if (s === 'dir') {
      for (const d of dirs) {
        const abs = path.resolve(d)
        if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`--dir is not a directory: ${d}`)
        for (const p of walk(abs)) {
          const rel = path.relative(abs, p)
          const hash = crypto.createHash('sha1').update(p.toLowerCase()).digest('hex').slice(0, 6)
          const sizeBytes = statSize(p)
          tracks.push({
            trackId: `dir_${slug(path.basename(p, path.extname(p)))}_${hash}`,
            source: 'dir',
            title: rel,
            artist: null,
            audioPath: p,
            exists: sizeBytes !== null,
            sizeBytes,
            metaDurationSec: null,
            jamendoId: null,
            moodTheme: [],
            genres: [],
            missingHint: null,
          })
        }
      }
    }
  }
  const byId = new Map()
  for (const t of tracks) {
    const prev = byId.get(t.trackId)
    if (!prev || (!prev.exists && t.exists)) byId.set(t.trackId, prev ? { ...t } : t)
  }
  return [...byId.values()]
}

// ---------------------------------------------------------------------------
// Plain-text table
// ---------------------------------------------------------------------------

/** Left-aligned fixed-width table. rows: arrays of strings/numbers. */
export function formatTable(header, rows) {
  const all = [header, ...rows].map((r) => r.map((c) => String(c ?? '')))
  const widths = header.map((_, i) => Math.max(...all.map((r) => r[i].length)))
  const line = (r) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd()
  return [line(all[0]), widths.map((w) => '-'.repeat(w)).join('  '), ...all.slice(1).map(line)].join('\n')
}

export const truncate = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}~` : String(s))
