# Offline mood labelling with the Gemini API

Builds **pre-labels** for evaluating the mood engine: each track is sent to Google
Gemini (audio understanding) and comes back as a structured mood label in the
engine's own taxonomy. **LLM labels are not ground truth.** Treat them as a
cheap first pass for human review; tracks whose repeated samples disagree are
flagged `needsReview`.

Nothing here runs in the app or the browser; it is a Node script (`.mjs`, no
dependencies, global `fetch`, Node >= 18).

## PRIVACY WARNING - read before sending anything

Google's Gemini API terms (https://ai.google.dev/gemini-api/terms, section
"How Google Uses Your Data") say, for **Unpaid Services** (free tier):

> "Google uses the content you submit to the Services and any generated
> responses to provide, improve, and develop Google products and services and
> machine learning technologies" ... "human reviewers may read, annotate, and
> process your API input and output"

and for **Paid Services**:

> "Google doesn't use your prompts (including associated system instructions,
> cached content, and files such as images, videos, or documents) or responses
> to improve our products"

The pricing page (https://ai.google.dev/gemini-api/docs/pricing) has the same
split per model: "Used to improve our products" is *yes* on the free tier and
*no* on the paid tier.

So: **do not send unreleased, private or third-party-confidential tracks on the
free tier.** Use a project with billing enabled. The script cannot tell which
tier your key is on; it prints a one-line warning at every start (silence with
`--i-understand-data-use` once you have checked). The Jamendo test/corpus
tracks are CC BY-NC-SA / BY-SA (dataset: non-commercial research use), which is
fine for internal evaluation; even so, prefer the paid tier if you can.
(These quotes were retrieved through a summarising fetch tool; re-read the
terms page yourself before relying on the exact wording.)

Files uploaded to the Files API are kept 48 hours by Google; the script deletes
them (`files.delete`) after each track unless you pass `--keep-uploads`, and
also on Ctrl+C.

## Getting / finding your API key

1. Go to https://aistudio.google.com/apikey . Keys created there start with `AIza`.
   Existing keys are listed there with their Google Cloud project (the same key
   also appears under "Credentials" in that project's Google Cloud console), so
   you can work out which one is yours; create a new one if in doubt.
2. Make sure the project has billing enabled if you will send private audio
   (see the warning above). AI Studio shows the plan per project (UI details may
   change; not verified).
3. Give the key to the script without putting it on the command line:
   - environment: `GEMINI_API_KEY` (fallback `GOOGLE_API_KEY`), or
   - a line `GEMINI_API_KEY=AIza...` in `.env.local` in the repo root
     (gitignored via `*.local`; verified with `git check-ignore`).
   The script never prints or writes the key; all output is passed through a
   redactor and `selftest.mjs` asserts this.

Test the key with one curl (lists models; expect HTTP 200):

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://generativelanguage.googleapis.com/v1beta/models" \
  -H "x-goog-api-key: $GEMINI_API_KEY"
```

`400 API_KEY_INVALID` = wrong key; `403` = key restricted / API not enabled for
its project. To test the model and quota with a one-token text call:

```bash
curl -s "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent" \
  -H "x-goog-api-key: $GEMINI_API_KEY" -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"Say ok"}]}]}'
```

## Usage

```bash
# What tracks exist and is the audio here?
node scripts/mood-labels/label.mjs --list

# See exactly what would be sent (no key needed, nothing is sent)
node scripts/mood-labels/label.mjs --dry-run --only ambient

# Label the 8 test tracks, 3 passes each (default), paid-tier project
node scripts/mood-labels/label.mjs --sources testfolder --i-understand-data-use

# Final eval set: 5 passes
node scripts/mood-labels/label.mjs --sources testfolder --samples 5

# Your own music (only that folder; recursive; mp3 wav flac m4a ogg opus)
node scripts/mood-labels/label.mjs --dir "D:\Music\mine" --limit 20

# Cross-check with another model
node scripts/mood-labels/label.mjs --model gemini-2.5-pro --out corpus/labels/gemini-2.5-pro --sources testfolder

# Jamendo corpus (audio must be fetched first: npm run corpus:fetch)
node scripts/mood-labels/label.mjs --sources corpus --limit 100

# Agreement with the (weak) Jamendo mood tags
node scripts/mood-labels/compare-to-jamendo.mjs
```

Flags (`--help` for the full list): `--only <substr>`, `--limit N`,
`--samples N` (default 3), `--model <id>`, `--temperature T` (default: omitted),
`--thinking-level minimal|low|medium|high`, `--concurrency N` (default 2),
`--force`, `--keep-uploads`, `--clip-seconds N --clip-start S`,
`--fallback-clip-seconds N` (default 60), `--max-retries N` (default 6),
`--schema-style ...`, `--out <dir>`, `--dir <path>` (repeatable; alias
`--calibration-dir`), `--sources testfolder,corpus,dir`.

Sources: `testfolder/tracks.json` + `testfolder/*.mp3`; every `--dir`;
`corpus/tracks.json` with audio in `corpus/audio/<file>` (where
`corpus/fetch.mjs` puts it; when absent `--list` says "audio missing (run npm
run corpus:fetch)"). Without `--dir` the default sources are testfolder+corpus;
with `--dir` and no `--sources`, only your folder is used. The same Jamendo id
appearing in testfolder and corpus is labelled once. (Tag strings in
`corpus/tracks.json` contain stray `\r`; they are trimmed.)

### What happens per track

1. Upload once via the Files API (resumable REST). Poll until `ACTIVE`.
2. `--samples N` independent `generateContent` passes reference the file.
   Invalid JSON / schema failures are re-requested once. `429`/`408`/`5xx`/network
   errors retry with exponential backoff (2 s, 4 s, ... capped at 60 s, honouring
   the server's `Retry-After` / `retryDelay`, max 120 s per wait).
3. Numeric fields are averaged, the majority `primaryMood` wins (ties: higher
   summed confidence), spread (per-field SD and range, mood agreement) is
   recorded. `needsReview` is set when the valence or arousal range across
   samples exceeds 1.5, mood agreement is below 50 % (n >= 3), or mean
   confidence < 0.4. With `--samples 1` no spread can be measured.
4. Written to `corpus/labels/gemini/<trackId>.json` (skipped next time unless
   `--force`). Track ids: `jamendo_<id>` or `dir_<name>_<hash>`. The upload is
   deleted.
5. After the run `_all.json` (all cached tracks, without `rawSamples`) and a
   summary table (track, mood, V/A/T, confidence, mood agreement, flag) are written.

Content-filter blocks (`finishReason` RECITATION / SAFETY / PROHIBITED_CONTENT /
BLOCKLIST / SPII / LANGUAGE, or a prompt block) are handled: if all passes are
blocked, the track is retried once with a 60 s clip (middle of the track; WAV is
cut in pure JS, other formats use `ffmpeg` if on PATH, otherwise the full file
is re-used with an instruction to analyse only that window). Still blocked ->
record with `"status": "blocked"` (run continues, exit code unaffected). The
prompt never asks for lyrics or transcription. Failures that are not blocks
(after retries) are reported and exit code 1; failed tracks are not cached.

## Label schema (per pass)

`rationale` (<= 40 words), `lyricsInfluence` none|some|strong, `primaryMood`,
`secondaryMood|null`, `valence` 1-9, `arousal` 1-9, `tension` 1-9,
`quarterArousal[4]`, `moodTimeline` (<= 6 `{startSec,endSec,mood}`),
`vocalPresence` 0-1, `acoustic` 0-1, `tempoFeel` slow|medium|fast,
`danceability` 0-1, `genres` (<= 3), `instruments` (<= 5), `confidence` 0-1.
Moods: serene, tender, dreamy, melancholic, brooding, mysterious, groove,
playful, uplifting, euphoric, driving, tense, aggressive, epic (+ `silence` as
primary). The prompt carries the anchors (valence 1 = bleak/sad/hostile, 5 =
neutral, 9 = joyful/bright; arousal 1 = near-still ... 9 = frantic; tension 1 =
relaxed/consonant ... 9 = anxious/dissonant), tells the model to rate what the
*sound* conveys, use the full scale, and not default to `groove`. The one-line
mood glosses in the prompt are ours (not from the taxonomy spec).

Design notes: `rationale` is the *first* property so the model states its
audible evidence before scoring; "no secondary mood" is the enum value `none`
(mapped to `null`) because nullable types are outside the documented schema
subset; ranges are clamped and structural errors re-requested by our own
validator, since the schema cannot enforce everything.

## Cost estimate

Audio is 32 tokens/s = 1,920 per minute = **115,200 input tokens per hour of
audio per pass**. Paid-tier list price for `gemini-3.8-flash` (pricing page):
$0.75 / 1M input and $3.75 / 1M output tokens through 2026-12-31, doubling to
$1.50 / $7.50 from 2027-01-01. Per pass that is about **$0.086 per audio hour**
(from 2027: $0.173) plus roughly 1-2k output tokens per label (~$0.006, thinking
tokens are billed as output). Examples at the 2026 price, 3 passes: one hour of
audio ~ $0.26 + ~$0.02 per track; the 8 test tracks (~18 min) ~ $0.10; the full
1,500-track corpus (97.6 h, avg 234 s) ~ $50. `--dry-run` prints the estimate for
your selection. Free tier has no charge but has strict rate/daily limits and the
data-use terms above. Other models the script prices: `gemini-3.5-flash-lite`
($0.30 in / $2.50 out), `gemini-2.5-flash` ($1.00 audio in / $2.50 out); others
show `n/a`.

## Calibrate before trusting

Before labelling the corpus, label ~20 tracks that already have human ratings
(DEAM / emoMusic if you have them; point `--dir` - alias `--calibration-dir` -
at that folder) and check the correlation of Gemini valence/arousal with the
human values. Published work (GlobalMood) reports r ~ 0.50 for `gemini-2.5-pro`
against human ratings (secondhand; we did not verify it), so expect noisy labels
and use `--samples 5` plus `--model gemini-2.5-pro` cross-checks for the final
set. Review every `needsReview` track by ear.

## Verified vs assumed (docs read 2026-09-19)

Verified in ai.google.dev docs (via a summarising fetch tool, so exact wording
should be spot-checked):
- Model ids `gemini-3.8-flash` (stable; recommended in the audio docs), `gemini-3.5-flash`,
  `gemini-3.5-flash-lite`, `gemini-2.5-flash`, `gemini-2.5-pro` listed on
  https://ai.google.dev/gemini-api/docs/models ; `gemini-2.0-flash` is shut down.
  Default `--model gemini-3.8-flash`.
- Audio: https://ai.google.dev/gemini-api/docs/generate-content/audio - MIME types
  `audio/wav|mp3|aiff|aac|ogg|flac|mpeg|m4a|l16|opus|alaw|mulaw|webm`, 32 tokens/s,
  9.5 h max per prompt, inline limit 20 MB total request, downsampled to 16 kbps,
  Files API for anything bigger; `fileData:{mimeType,fileUri}` part shape.
- Files API (https://ai.google.dev/gemini-api/docs/files, https://ai.google.dev/api/files):
  resumable REST headers (`X-Goog-Upload-Protocol/Command/Header-Content-Length/
  Header-Content-Type/Offset`), `x-goog-upload-url` response header, finalize returns
  `{"file":{name,uri,mimeType,state}}`, states PROCESSING/ACTIVE/FAILED,
  `GET|DELETE /v1beta/files/{id}`, 2 GB per file, 20 GB per project, 48 h retention.
- `generateContent` "remains fully supported" though the docs steer new work to the
  Interactions API (https://ai.google.dev/gemini-api/docs/migrate-to-interactions).
  We use `generateContent`; the Interactions API is not used.
- Gemini 3 temperature: "we strongly recommend keeping the temperature parameter at
  its default value of `1.0`" (https://ai.google.dev/gemini-api/docs/gemini-3), so
  temperature is omitted unless `--temperature` is given; averaging over `--samples`
  gives the stability instead. Gemini 3 Flash thinks at level `high` by default;
  `--thinking-level` exposes `thinkingConfig.thinkingLevel` (value set as per that page).
- Rate limits (https://ai.google.dev/gemini-api/docs/rate-limits): per project (not key)
  RPM/TPM/RPD, exceeding gives `429 RESOURCE_EXHAUSTED`, daily quota resets midnight
  Pacific; the docs give no per-model numbers (see AI Studio). A daily-quota 429 will
  not clear within our backoff; the run then fails those tracks; re-run tomorrow (cache
  keeps finished work).
- FinishReason values incl. RECITATION, SAFETY, PROHIBITED_CONTENT (API reference).
- Pricing and the free/paid data-use split (pricing page). The pricing page lists no
  separate audio price for `gemini-3.8-flash` (a separate $1.00 audio price is listed for
  `gemini-2.5-flash`); we assume audio input is billed at the text input rate.

Assumed / not verified (no key available while building; only mocked-fetch tests):
- The exact request field for structured output on `gemini-3.8-flash`. Docs pages
  disagree: the API reference and long-standing docs show `generationConfig.responseMimeType`
  + `responseSchema`; the newer generate-content structured-output page shows
  `generationConfig.responseFormat.text.{mimeType,schema}`; JSON Schema goes in
  `responseJsonSchema`. The script starts with `--schema-style responseSchema` and, on a
  400 that mentions the schema fields, automatically tries the other two styles
  (and remembers the winner). Upper- vs lower-case type names in `responseSchema` is
  likewise unverified (we send upper-case there, lower-case JSON Schema elsewhere).
- Whether the API returns the RetryInfo `retryDelay` on every 429 (we also back off blindly).
- That `thinkingLevel` accepts all four values on every model.
- The GlobalMood r ~ 0.50 figure and any claim about your key's tier.
- Real-world behaviour of a full end-to-end call (upload -> label): first real run
  should be `--only <one track> --samples 1 --dry-run`, then without `--dry-run`.

## Tests

```bash
node scripts/mood-labels/selftest.mjs
```

Pure functions (prompt, schema, validator, aggregation, tag map, retry maths, key
resolution) plus the full pipeline against a mocked `fetch` and tiny fake WAV files in
the OS temp dir: caching, retry on 429, upload/delete calls, block -> clip fallback,
schema-style fallback, key never in logs/requests/files.

## Suggested npm scripts

```json
"labels:list": "node scripts/mood-labels/label.mjs --list",
"labels:gemini": "node scripts/mood-labels/label.mjs",
"labels:compare": "node scripts/mood-labels/compare-to-jamendo.mjs",
"labels:selftest": "node scripts/mood-labels/selftest.mjs"
```

## Overnight (unattended) run

`overnight.mjs` wraps `label.mjs` for a long unattended run. Start it before bed
and read `corpus/labels/OVERNIGHT-REPORT.md` in the morning.

```powershell
cd C:\Users\aryan\anand_project_2\AudioVis
powershell -ExecutionPolicy Bypass -File scripts\mood-labels\overnight.ps1
```

`overnight.ps1` asks for the key (hidden, never written to disk), keeps Windows
from idle-sleeping while it runs, and clears the key afterwards. Run it in a normal
PowerShell window, not inside Claude Code. Plug in the laptop and leave the lid
open (closing it can still suspend the PC). It is fully resumable: if the window
closes or the machine restarts, run the same command again.

**Free-tier reality (verified on this key, 2026-09-19).** The API reported
`GenerateRequestsPerDayPerProjectPerModel-FreeTier`, limit **20 per day per model**. One
label needs one request per sample, so a single model labels about 20 tracks a day. The
runner therefore keeps a **model ladder** (`gemini-3.8-flash` first, then 3.7, 3.6, 3.5,
3.1-flash-lite, 3.5-flash-lite, flash-lite-latest; `gemini-2.5-flash` is closed to new
users). When a model's daily cap is hit, `label.mjs` stops at once (exit code 3) and the
runner moves to the next model. A model that hit its cap is probed again after 3 hours
(`--exhaust-retry-min`); quotas reset daily (Pacific midnight, i.e. about 12:30 IST).

What that means in practice:
- Stage 1 gets **one label per track** (1 sample, `--thinking-level low`) so coverage is
  complete first. Stage 2 then upgrades tracks to 3 samples with the model that labelled
  each, keeping the old label if an upgrade fails.
- Labels from different models are less comparable. The report says how many came from
  each model and marks the set **MIXED MODELS**. Use `--single-model` for a consistent set
  (it then waits for the daily reset and takes several days on the free tier).
- Enabling billing on the Google Cloud project removes the daily cap and the data-use
  caveat; the whole set then costs a few dollars.

Safety rails: one instance at a time (lock file), `--budget-hours` (default 10),
`--max-usd` spend cap (default 15, estimated from token usage), a per-pass timeout,
bounded waiting, and a blocked or failed upgrade never overwrites a working label.

Test the runner itself (no network, no key): `npm run labels:overnight-test`.
