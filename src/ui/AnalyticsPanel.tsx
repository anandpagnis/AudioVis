import { useEffect, useRef } from 'react'
import { audioEngine } from '../audio/AudioEngine'
import { essentiaBridge } from '../audio/essentia/EssentiaBridge'
import { voiceBridge } from '../audio/essentia/VoiceBridge'
import { keyPaletteTracker } from '../engine/keyPalette'
import { performanceState } from '../engine/performanceState'
import type { MoodState } from '../audio/types'
import { analytics } from '../engine/analyticsMetrics'
import { frameTimeWindow } from '../engine/PerfMonitor'
import type { RollingWindow } from '../engine/RollingWindow'
import { transitionMetrics } from '../engine/transitionMetrics'

const W = 320
const H = 352

/**
 * Redraw rate, in Hz.
 *
 * This panel was the only unthrottled readout in the app (F188): a plain rAF
 * with no interval gate, redrawing four full sparklines, a per-point scatter
 * and ~12 `fillText` calls sixty times a second, on the same main thread as
 * the render loop. `ISSUES.md` and `FpsMeter.tsx` both already warned that it
 * was "a per-frame canvas heavy enough to distort the reading" — an instrument
 * that changes what it measures. F10 deleted a per-frame full-viewport canvas
 * for exactly this.
 *
 * 10 Hz rather than `FpsMeter`'s 5 Hz because this panel is read while
 * something is being adjusted and its numbers settle — a beat-accuracy score
 * or a mood confidence that lags a third of a second behind the change you
 * just made is annoyingly slow to a human eye. It is not 60 because nothing
 * here is a fast-moving bar: the sparklines cover 30 s, so at 10 Hz each pixel
 * column still gets several redraws' worth of new samples, and the numeric
 * fields are settling values that are less readable when they flicker — the
 * same argument `BpmReadout` makes for its own 10 Hz.
 *
 * Unlike `FpsMeter`/`BpmReadout` there is no per-field diffing to do — a
 * canvas has no retained nodes to leave undirtied — so the interval gates the
 * WHOLE draw, and the per-frame array allocations that used to feed it
 * (`history.slice(-4).reverse()`, a `.map()` spread into `Math.max`, a rebuilt
 * mood-head tuple array) are gone rather than merely six times rarer.
 */
const HZ = 10
const INTERVAL_MS = 1000 / HZ

/**
 * Age past which a transition row stops being reported as current activity.
 *
 * The history is capped at 50 and the panel shows the last four forever, so
 * with no age at all a show that stopped twenty minutes ago still displays
 * four scene changes and reads as one that is running (F190). A minute is
 * comfortably longer than any real gap between transitions during a show —
 * the directors fire far more often than that — so a row older than this is
 * evidence of nothing happening, not of something happening.
 */
const STALE_TRANSITION_SEC = 60

/** Amber marker for anything the panel is showing that is NOT live. */
const STALE_TAG = 'rgba(255, 193, 90, 0.9)'
const HELD_TAG_TEXT = '  HELD'

const LABEL_LIVE = 'rgba(255,255,255,0.6)'
const LABEL_HELD = 'rgba(255,255,255,0.22)'

const TX_ROW = 'rgba(255,255,255,0.65)'
const TX_ROW_STALE = 'rgba(255,255,255,0.26)'
const TX_FLAG = 'rgba(255, 138, 101, 0.9)'
const TX_FLAG_STALE = 'rgba(255, 138, 101, 0.35)'

const MOOD_ORDER: MoodState[] = [
  'silence',
  'ambient',
  'mellow',
  'groove',
  'building',
  'peak',
  'aggressive',
]
const MOOD_LABEL: Record<MoodState, string> = {
  silence: 'sil',
  ambient: 'amb',
  mellow: 'mel',
  groove: 'grv',
  building: 'bld',
  peak: 'pek',
  aggressive: 'agr',
}

/**
 * The four classifier heads, hoisted out of the draw.
 *
 * These used to be built as a `[string, number][]` literal inside the loop —
 * five array allocations every frame to print four bars.
 */
const MOOD_HEAD_LABEL = ['hap', 'agg', 'par', 'rel'] as const
const MOOD_HEAD_KEY = ['happy', 'aggressive', 'party', 'relaxed'] as const

/**
 * Compact age for a transition row: `4s`, `47s`, `12m`, `3h`.
 *
 * Deliberately low resolution. The question a reader has is "did this just
 * happen, or is this a leftover", and a whole-minute answer settles it.
 */
function formatAge(sec: number): string {
  if (sec < 60) return `${sec.toFixed(0)}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  return `${Math.floor(sec / 3600)}h`
}

/**
 * Draw a window's samples as a sparkline.
 *
 * Takes the `RollingWindow` itself rather than a materialised array: the window
 * stores its samples in typed arrays with no `{t, v}` objects behind them, and
 * building that array here would allocate one object per sample on every frame
 * the panel is open — reintroducing, in the reader, exactly the garbage the
 * window was rewritten to stop producing.
 */
function sparkline(
  ctx: CanvasRenderingContext2D,
  win: RollingWindow,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  scale = 1,
) {
  const n = win.count()
  if (n < 2) return
  const t0 = win.timeAt(0)
  const span = Math.max(0.001, win.timeAt(n - 1) - t0)
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.beginPath()
  for (let i = 0; i < n; i++) {
    const px = x + ((win.timeAt(i) - t0) / span) * w
    const py = y + h - Math.max(0, Math.min(1, win.valueAt(i) / scale)) * h
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.stroke()
}

/**
 * Numeric replacement/supplement for the "does it beatmatch, transition
 * smoothly, and pick up the vibe" manual checks (HANDOFF §8): rolling
 * beat-tracking accuracy, mood confidence/ambiguity and the live 7-state
 * score distribution, section-boundary strength, frame-time percentiles, and
 * a recent-transitions table with target vs. actual fade timing.
 *
 * No React state: a rAF-driven canvas reading the analytics singletons
 * directly. The redraw is gated to {@link HZ} — see that constant for why.
 *
 * ## Held values are marked, not hidden
 *
 * During silence the engine is correct and deliberately stops working:
 * `EssentiaBridge`, `VoiceBridge`, `StructureBridge`, the onset feed and
 * `PhraseDetector` all gate on `f.silence`. Every field they own therefore
 * keeps its last value, and this panel used to render those latched numbers
 * with no marker at all — a stopped show displayed a full analysis stack
 * running confidently on digital silence. That is not a cosmetic problem: it
 * is what made the F186/F187 frame-time investigation open on a false premise
 * and chase the analysis instead of the frame budget (F190).
 *
 * So each row that is gated off is dimmed AND tagged `HELD`. The tag is the
 * part that matters — dimming alone is a judgement call a reader can miss, a
 * word is not. The distinction is drawn per row rather than per panel because
 * it is genuinely per row: the mood estimator scores `silence` as a state and
 * runs throughout, and `lufsShortTerm` is a live absolute-scale reading that
 * merely agrees with the silence gate, so neither is marked. Marking those
 * would be as wrong as marking nothing.
 *
 * Nothing here changes engine behaviour. The gating is correct; only the
 * presentation of it was lying.
 */
export function AnalyticsPanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let raf = 0
    let lastAt = 0

    /**
     * One label row, dimmed and tagged when the analysis behind it is gated
     * off right now. Defined once here rather than inside `draw` so it is not
     * a closure allocated per redraw.
     */
    const row = (text: string, y: number, live: string, dim: string, held: boolean) => {
      ctx.fillStyle = held ? dim : live
      ctx.fillText(text, 6, y)
      if (held) {
        ctx.fillStyle = STALE_TAG
        ctx.fillText(HELD_TAG_TEXT, 6 + ctx.measureText(text).width, y)
      }
    }

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      if (now - lastAt < INTERVAL_MS) return
      lastAt = now

      const f = audioEngine.features
      // The single fact every HELD tag below is derived from. Read once so one
      // redraw cannot show half the panel as live and half as held.
      const silent = f.silence

      ctx.clearRect(0, 0, W, H)
      ctx.font = '9px ui-monospace, monospace'

      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      ctx.fillText('ANALYTICS', 6, 12)
      if (silent) {
        ctx.fillStyle = STALE_TAG
        ctx.fillText('SILENCE — HELD rows are frozen, not live', 66, 12)
      }

      // --- Frame time distribution (percentiles, not just the EMA) ---
      // Untagged: the renderer does not stop when the music does, so these
      // stay live through silence.
      const meanMs = frameTimeWindow.mean()
      const p95Ms = frameTimeWindow.percentile(0.95)
      const maxMs = frameTimeWindow.max()
      ctx.fillStyle = p95Ms > 20 ? 'rgba(255, 138, 101, 0.9)' : 'rgba(255,255,255,0.7)'
      ctx.fillText(
        `frame  mean ${meanMs.toFixed(1)}ms  p95 ${p95Ms.toFixed(1)}ms  max ${maxMs.toFixed(1)}ms`,
        6,
        24,
      )

      // --- Beat-grid accuracy ---
      // `beatGridAccuracy` only moves inside `addOnset`, and the onset feed is
      // gated on `!f.silence` (AudioEngine.ts:956) — so during silence this is
      // a score from the last audible passage. The sparkline flatlines at it
      // rather than emptying, because `sampleAnalytics` keeps pushing the
      // frozen value every frame, which is exactly why the number needs a tag.
      row(
        `beat accuracy  ${(f.beatGridAccuracy * 100).toFixed(0)}%`,
        40,
        LABEL_LIVE,
        LABEL_HELD,
        silent,
      )
      sparkline(
        ctx,
        analytics.bpmAccuracy,
        6,
        44,
        W - 12,
        22,
        silent ? 'rgba(120, 200, 255, 0.25)' : 'rgba(120, 200, 255, 0.9)',
      )

      // --- Mood confidence / ambiguity ---
      // Untagged: the mood estimator runs through silence and scores `silence`
      // as a state (MoodEstimator.ts:330), so these are live.
      ctx.fillStyle = LABEL_LIVE
      ctx.fillText(
        `mood confidence ${(f.mood.confidence * 100).toFixed(0)}%  ambiguity ${(f.mood.ambiguity * 100).toFixed(0)}%`,
        6,
        84,
      )
      sparkline(ctx, analytics.moodConfidence, 6, 88, W - 12, 22, 'rgba(130, 255, 190, 0.9)')
      sparkline(ctx, analytics.moodAmbiguity, 6, 88, W - 12, 22, 'rgba(255, 214, 130, 0.7)')

      // --- Live mood-score distribution (how close was the runner-up?) ---
      ctx.fillStyle = LABEL_LIVE
      ctx.fillText('mood scores', 6, 128)
      const scores = f.mood.scores
      // Plain loop: this was `Math.max(0.01, ...MOOD_ORDER.map(...))`, which
      // allocated an array and spread it, per frame, to find one maximum.
      let maxScore = 0.01
      for (let i = 0; i < MOOD_ORDER.length; i++) {
        const v = scores[MOOD_ORDER[i]]
        if (v > maxScore) maxScore = v
      }
      const barW = (W - 12) / MOOD_ORDER.length
      const barBase = 156
      const barMaxH = 24
      for (let i = 0; i < MOOD_ORDER.length; i++) {
        const s = MOOD_ORDER[i]
        const bh = (scores[s] / maxScore) * barMaxH
        const x = 6 + i * barW
        ctx.fillStyle = s === f.mood.state ? 'rgba(130, 255, 190, 0.9)' : 'rgba(255,255,255,0.25)'
        ctx.fillRect(x, barBase - bh, barW - 3, bh)
        ctx.fillStyle = 'rgba(255,255,255,0.5)'
        ctx.fillText(MOOD_LABEL[s], x, barBase + 10)
      }

      // --- Section-change strength vs. its 0.45 firing threshold ---
      // `PhraseDetector` only writes `sectionChangeStrength` on a downbeat with
      // `!f.silence` (PhraseDetector.ts:50), so this holds through silence.
      row(
        `section strength  ${f.sectionChangeStrength.toFixed(2)} (fires > 0.45)`,
        182,
        LABEL_LIVE,
        LABEL_HELD,
        silent,
      )
      const secY = 186
      const secH = 18
      const secScale = 1.2
      ctx.strokeStyle = 'rgba(255,255,255,0.25)'
      ctx.beginPath()
      const thresholdY = secY + secH - (0.45 / secScale) * secH
      ctx.moveTo(6, thresholdY)
      ctx.lineTo(W - 6, thresholdY)
      ctx.stroke()
      const sec = analytics.sectionStrength
      const secN = sec.count()
      if (secN > 0) {
        const t0 = sec.timeAt(0)
        const span = Math.max(0.001, sec.timeAt(secN - 1) - t0)
        ctx.fillStyle = silent ? 'rgba(179, 136, 255, 0.22)' : 'rgba(179, 136, 255, 0.9)'
        // One path for the whole scatter. This was a `beginPath`/`arc`/`fill`
        // triple PER POINT (F188); the `moveTo` before each `arc` is what keeps
        // the dots from being strung together by the shared subpath.
        ctx.beginPath()
        for (let i = 0; i < secN; i++) {
          const px = 6 + ((sec.timeAt(i) - t0) / span) * (W - 12)
          const py = secY + secH - (Math.min(secScale, sec.valueAt(i)) / secScale) * secH
          ctx.moveTo(px + 2, py)
          ctx.arc(px, py, 2, 0, Math.PI * 2)
        }
        ctx.fill()
      }

      // --- Essentia worker: key / danceability (surfaced, not yet wired) ---
      const ess = essentiaBridge.status
      if (ess.error) {
        ctx.fillStyle = 'rgba(255, 138, 101, 0.9)'
        ctx.fillText(`essentia  ${ess.error.slice(0, 40)}`, 6, 212)
      } else if (ess.keyRuns === 0 && ess.danceRuns === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.35)'
        ctx.fillText('essentia  (awaiting first 12s window)', 6, 212)
      } else {
        const keyTxt = f.key ? `${f.key} ${f.scale}` : '—'
        // The bridge refuses to spend the worker during silence
        // (EssentiaBridge.ts:205) because silence produces degenerate reads, so
        // every field on this row simply holds its last value.
        row(
          `key ${keyTxt.padEnd(9)} str ${f.keyConfidence.toFixed(2)}  dance ${f.danceability.toFixed(2)} (raw)`,
          212,
          'rgba(179, 136, 255, 0.9)',
          'rgba(179, 136, 255, 0.3)',
          silent,
        )
        ctx.fillStyle = 'rgba(255,255,255,0.4)'
        // `runs … lifetime` is load-bearing wording, not decoration: these are
        // cumulative counters reset only by `detach()`, and printed bare as
        // `12ms/17` they read as work happening now (F190).
        //
        // The LUFS figure rides along untagged on purpose. It is the BS.1770
        // K-weighted short-term loudness — an absolute-scale readout the app
        // otherwise lacks, recomputed every frame and therefore genuinely live
        // even in silence, where it is a real -70 rather than a held one.
        // `f.silence` is relative-RMS with hysteresis, so the two agree here by
        // independent measurement rather than by derivation.
        ctx.fillText(
          `  ${ess.keyMs.toFixed(0)}/${ess.danceMs.toFixed(0)}ms per run · ` +
            `${ess.keyRuns}/${ess.danceRuns} runs lifetime · ${f.lufsShortTerm.toFixed(1)} LUFS`,
          6,
          224,
        )
      }

      // --- Voice / mood classifier (surfaced, not wired) ---
      const vs = voiceBridge.status
      if (vs.runs > 0) {
        const m = f.moods
        // `VoiceBridge` returns early on `f.silence` (:120), so the vocal
        // presence and all four heads are the last audible classification.
        row(
          `voice ${(f.vocalPresence * 100).toFixed(0)}% of recent segments`,
          238,
          'rgba(255, 183, 197, 0.9)',
          'rgba(255, 183, 197, 0.3)',
          silent,
        )
        // Four mood heads as small bars — they share one embedding, so this
        // whole row costs ~1.5 ms on top of the voice read.
        const headFill = silent ? 'rgba(255, 183, 197, 0.28)' : 'rgba(255, 183, 197, 0.9)'
        const headLabel = silent ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.55)'
        for (let i = 0; i < MOOD_HEAD_LABEL.length; i++) {
          const v = m[MOOD_HEAD_KEY[i]]
          const x = 6 + i * 76
          ctx.fillStyle = 'rgba(255,255,255,0.12)'
          ctx.fillRect(x + 22, 244, 46, 5)
          ctx.fillStyle = headFill
          ctx.fillRect(x + 22, 244, 46 * Math.max(0, Math.min(1, v)), 5)
          ctx.fillStyle = headLabel
          ctx.fillText(MOOD_HEAD_LABEL[i], x, 249)
        }
        ctx.fillStyle = 'rgba(255,255,255,0.4)'
        // What the signals are actually DOING, not just what they read —
        // these four are wired now, so the panel shows the downstream effect.
        // Untagged: these are live director outputs, which keep responding (by
        // suppressing) while their inputs are held.
        ctx.fillText(
          `focus ${performanceState.voiceFocus.toFixed(2)}  bloom ${performanceState.bloom.toFixed(2)}  ` +
            `fog ${performanceState.fog.toFixed(2)}  key→${keyPaletteTracker.family || '—'}`,
          6,
          262,
        )
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.35)'
        ctx.fillText(
          vs.error
            ? vs.missing
              ? 'ML: off (no weights) — CC BY-NC-SA, see HANDOFF §6'
              : `ML: error — ${vs.error.slice(0, 30)}`
            : 'voice: (awaiting first classification)',
          6,
          238,
        )
      }

      // --- Recent transitions: age, target vs. actual duration, p95 ---
      ctx.fillStyle = LABEL_LIVE
      ctx.fillText('recent transitions  (age · newest first)', 6, 280)
      const hist = transitionMetrics.history
      // Walk backwards from the end instead of `slice(-4).reverse()`, which
      // allocated two arrays per redraw to look at four elements (F188).
      const rowCount = Math.min(4, hist.length)
      if (rowCount === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.35)'
        ctx.fillText('(switch scenes to populate)', 6, 294)
      }
      const nowMs = Date.now()
      for (let i = 0; i < rowCount; i++) {
        const r = hist[hist.length - 1 - i]
        const y = 294 + i * 14
        // A hard cut has a target of 0 and lands in ~0, so the duration check
        // is meaningless for it — only its frame cost is worth flagging.
        const off = r.hardCut
          ? 0
          : Math.abs(r.actualDurationSec - r.targetDurationSec) /
            Math.max(0.01, r.targetDurationSec)
        const flagged = off > 0.25 || r.frameMsDuringFade.p95 > 20
        // Age leads the row so the four of them read as a column, and leads it
        // because "is any of this recent" is the question that decides whether
        // the rest of the row means anything at all.
        const ageSec = Math.max(0, (nowMs - r.atMs) / 1000)
        const stale = ageSec > STALE_TRANSITION_SEC
        ctx.fillStyle = stale
          ? flagged
            ? TX_FLAG_STALE
            : TX_ROW_STALE
          : flagged
            ? TX_FLAG
            : TX_ROW
        const label = `${r.fromScene ?? '–'}→${r.toScene}`.slice(0, 20).padEnd(20)
        ctx.fillText(
          `${formatAge(ageSec).padStart(4)} ${label} ${r.hardCut ? 'cut' : r.style} ` +
            `${r.targetDurationSec.toFixed(1)}/${r.actualDurationSec.toFixed(1)}s ` +
            `p95:${r.frameMsDuringFade.p95.toFixed(0)}ms`,
          6,
          y,
        )
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="analytics-panel glass">
      <canvas ref={canvasRef} width={W} height={H} />
    </div>
  )
}
