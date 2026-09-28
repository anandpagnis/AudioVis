import { useEffect, useMemo, useRef, type CSSProperties } from 'react'
import { addAfterEffect } from '@react-three/fiber'
import { audioEngine } from '../audio/AudioEngine'
import { formatStructureLogHud, structureLog, type StructureLogExport } from '../engine/structureLog'
import { structureLogRequested } from '../engine/structureLogFlags'
import { useStore } from '../store'
import { createHotkeyGate } from './structureLogHotkeys'

/**
 * The structure-log overlay (`?structurelog`): the tap-to-mark tool that produces the ground truth for the
 * section-change engine. Mounted in the OUTPUT window only (the one that runs the engine), and renders nothing
 * at all without the flag (read once, at mount; the console's own `?structurelog` counts, see
 * `engine/structureLogFlags.ts`).
 *
 * Use: click the output window once so it has keyboard focus, type the song name into the field BEFORE pressing
 * play, then press M (or Space) at every BIG section change (a new scene) and N at every SMALL change (colours or
 * effects should react, no new scene). U undoes the last tap of either kind. E, E saves the JSON and starts the next track.
 * The keys live in `structureLogHotkeys.ts` (tested).
 *
 * DOM discipline follows `LookDebug` / `FpsMeter`: no React state and no per-frame React work. A per-frame hook
 * on the render loop (`addAfterEffect`, which runs after every director and after `SceneManager` committed
 * the frame) calls `structureLog.observe`, which allocates nothing unless a detector edge happens. A 4 Hz interval
 * writes `textContent` on one `<pre>`. The overlay never takes pointer events except on its own buttons and the
 * name field, so the show and a screen capture of it are unaffected (it IS part of that window: turn the flag
 * off before a recording).
 */

const HUD_INTERVAL_MS = 250
const FLASH_MS = 450

const ROOT: CSSProperties = {
  position: 'fixed',
  right: 8,
  bottom: 8,
  zIndex: 2147483000,
  maxWidth: 'min(560px, 70vw)',
  padding: '6px 8px',
  font: '11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  color: '#ffe9a8',
  background: 'rgba(0, 0, 0, 0.66)',
  border: '1px solid rgba(255, 233, 168, 0.3)',
  borderRadius: 3,
  pointerEvents: 'none',
  userSelect: 'none',
}

const PRE: CSSProperties = { margin: 0, whiteSpace: 'pre', font: 'inherit' }

const ROW: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }

const CONTROL: CSSProperties = {
  pointerEvents: 'auto',
  font: 'inherit',
  color: '#ffe9a8',
  background: 'rgba(255, 233, 168, 0.12)',
  border: '1px solid rgba(255, 233, 168, 0.4)',
  borderRadius: 3,
  padding: '2px 8px',
  cursor: 'pointer',
}

const INPUT: CSSProperties = {
  pointerEvents: 'auto',
  userSelect: 'text',
  font: 'inherit',
  color: '#fff',
  background: 'rgba(0, 0, 0, 0.5)',
  border: '1px solid rgba(255, 233, 168, 0.4)',
  borderRadius: 3,
  padding: '2px 6px',
  width: '100%',
  boxSizing: 'border-box',
}

function downloadText(text: string, fileName: string): boolean {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
    return true
  } catch {
    return false
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // no clipboard permission or no focus: fall back to a transient textarea
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

interface StructureLogActions {
  mark: () => void
  markSmall: () => void
  undo: () => void
  finish: () => void
  copy: () => void
  prev: () => void
}

export function StructureLog() {
  const enabled = useMemo(() => structureLogRequested(), [])
  const rootRef = useRef<HTMLDivElement>(null)
  const hudRef = useRef<HTMLPreElement>(null)
  const statusRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const prevBtnRef = useRef<HTMLButtonElement>(null)
  // The effect below owns the state (timers, the hotkey gate); the buttons call its actions through this.
  const actionsRef = useRef<StructureLogActions | null>(null)

  useEffect(() => {
    if (!enabled) return
    structureLog.enabled = true
    // Feed the per-beat feature cells into the log so a retuned detector can be replayed on this song without its audio.
    audioEngine.setCellSink((c, f) => structureLog.noteCell(c, f))
    const gate = createHotkeyGate()
    let lastFrameWall = performance.now()
    let statusUntil = 0
    let flashUntil = 0

    const say = (text: string, ms = 4000) => {
      const el = statusRef.current
      if (el) el.textContent = text
      statusUntil = performance.now() + ms
    }

    const observe = () => {
      structureLog.observe(audioEngine.features, useStore.getState())
      lastFrameWall = performance.now()
    }

    const doMark = (small = false) => {
      if (!structureLog.isRunning()) {
        say('No audio is running yet: mark ignored.')
        return
      }
      const cur = structureLog.now()
      // The last frame is up to one frame old; carry the clock forward by the wall time since then.
      const t = cur.t + Math.min(0.1, Math.max(0, (performance.now() - lastFrameWall) / 1000))
      const m = small ? structureLog.markSmall(t, cur.beat) : structureLog.mark(t, cur.beat)
      if (m) {
        flashUntil = performance.now() + FLASH_MS
        if (rootRef.current) rootRef.current.style.borderColor = '#7dff9a'
        say(`${small ? 'SMALL' : 'BIG'} mark #${structureLog.summary(0).marks} at ${m.t.toFixed(1)} s, beat ${m.beat}`, 2500)
      }
    }

    const doUndo = () => {
      const m = structureLog.undoLastMark()
      say(m ? `Undid the ${m.kind === 'small' ? 'SMALL' : 'BIG'} mark at ${m.t.toFixed(1)} s.` : 'No mark to undo.', 2500)
    }

    const save = (out: StructureLogExport): void => {
      const ok = downloadText(out.text, out.fileName)
      const n = out.json.marks.length
      say(
        ok
          ? `Saved ${out.fileName} (${n} marks). Next track: type its name, then play.`
          : `Download blocked. Use Copy, or Prev to retry (${n} marks kept).`,
        8000,
      )
    }

    const doFinish = () => {
      save(structureLog.finish())
      gate.reset()
      const input = inputRef.current
      if (input) input.value = structureLog.getTrackHint()
    }

    const doCopy = () => {
      const out = structureLog.snapshotForExport()
      void copyText(out.text).then((ok) =>
        say(ok ? `Copied ${out.json.marks.length} marks (JSON).` : 'Copy failed: use Finish + save.'),
      )
    }

    const doPrev = () => {
      const out = structureLog.latestArchived()
      if (out) save(out)
    }
    actionsRef.current = { mark: () => doMark(false), markSmall: () => doMark(true), undo: doUndo, finish: doFinish, copy: doCopy, prev: doPrev }

    const onKey = (e: KeyboardEvent) => {
      const res = gate.handle(e, performance.now())
      if (res.preventDefault) e.preventDefault()
      switch (res.action) {
        case 'mark':
          doMark(false)
          break
        case 'markSmall':
          doMark(true)
          break
        case 'undo':
          doUndo()
          break
        case 'finishArm':
          say('Press E again within 3 s to finish this track and save.', 3000)
          break
        case 'finish':
          doFinish()
          break
        default:
          break
      }
    }

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (structureLog.unsavedCount() === 0) return
      e.preventDefault()
      e.returnValue = ''
    }

    const paint = () => {
      const now = performance.now()
      const hud = hudRef.current
      if (hud) hud.textContent = formatStructureLogHud(structureLog.summary()).join('\n')
      if (flashUntil !== 0 && now >= flashUntil) {
        flashUntil = 0
        if (rootRef.current) rootRef.current.style.borderColor = ''
      }
      if (statusUntil !== 0 && now >= statusUntil) {
        statusUntil = 0
        if (statusRef.current) statusRef.current.textContent = ''
      }
      const prev = prevBtnRef.current
      if (prev) prev.style.display = structureLog.archivedCount() > 0 ? '' : 'none'
      // Keep the name field in step with the log (a finished track clears it) without fighting typing.
      const input = inputRef.current
      if (input && document.activeElement !== input) {
        const hint = structureLog.getTrackHint()
        if (input.value !== hint) input.value = hint
      }
    }

    const removeObserve = addAfterEffect(observe)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('beforeunload', onBeforeUnload)
    paint()
    const id = window.setInterval(paint, HUD_INTERVAL_MS)
    return () => {
      removeObserve()
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('beforeunload', onBeforeUnload)
      window.clearInterval(id)
      actionsRef.current = null
      audioEngine.setCellSink(null)
      structureLog.enabled = false
    }
  }, [enabled])

  if (!enabled) return null

  // Buttons never take focus (mousedown is swallowed), so a later Space cannot re-press one.
  const noFocus = (e: { preventDefault: () => void }) => e.preventDefault()

  return (
    <div ref={rootRef} style={ROOT} role="region" aria-label="Structure log">
      <pre ref={hudRef} style={PRE} />
      <input
        ref={inputRef}
        style={INPUT}
        type="text"
        placeholder="song name (type it BEFORE you press play)"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => structureLog.setTrackHint(e.target.value)}
        onKeyDown={(e) => {
          // Enter / Escape hand the keyboard back to the tap keys.
          if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
        }}
      />
      <div style={ROW}>
        <button type="button" tabIndex={-1} style={CONTROL} onMouseDown={noFocus} onClick={() => actionsRef.current?.mark()}>
          MARK (big)
        </button>
        <button type="button" tabIndex={-1} style={CONTROL} onMouseDown={noFocus} onClick={() => actionsRef.current?.markSmall()}>
          N (small)
        </button>
        <button type="button" tabIndex={-1} style={CONTROL} onMouseDown={noFocus} onClick={() => actionsRef.current?.undo()}>
          Undo
        </button>
        <button type="button" tabIndex={-1} style={CONTROL} onMouseDown={noFocus} onClick={() => actionsRef.current?.finish()}>
          Finish + save
        </button>
        <button type="button" tabIndex={-1} style={CONTROL} onMouseDown={noFocus} onClick={() => actionsRef.current?.copy()}>
          Copy JSON
        </button>
        <button
          ref={prevBtnRef}
          type="button"
          tabIndex={-1}
          style={CONTROL}
          onMouseDown={noFocus}
          onClick={() => actionsRef.current?.prev()}
        >
          Prev track
        </button>
      </div>
      <div ref={statusRef} style={{ marginTop: 4, minHeight: '1.35em' }} />
    </div>
  )
}
