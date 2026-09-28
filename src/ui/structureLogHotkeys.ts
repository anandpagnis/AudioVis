/**
 * The keyboard map of the structure-log overlay (`ui/StructureLog.tsx`), as a pure function so it is tested
 * without a DOM. It lives in the OUTPUT window only, which has no other keyboard map (the DJ shortcuts in
 * `ui/HUD.tsx` belong to the control window), so `m` / `u` / `e` / space collide with nothing there.
 *
 *  - `m` or Space   MARK a BIG change: "a real section change is happening now" (worth a new scene)
 *  - `n`            MARK a SMALL change: colours / post-FX / layers / effects should react, but NOT a new scene
 *  - `u`            undo the last mark (a mis-tap)
 *  - `e`, `e`       finish the track and save its JSON: the first press only ARMS it (so a stray key never ends
 *                   a track), the second within {@link FINISH_CONFIRM_MS} does it
 *
 * Ignored: key repeat (a held key), any modifier (ctrl / meta / alt / shift, so browser shortcuts and Shift+M
 * type nothing), IME composition, and anything typed into an input / textarea / select / contenteditable (the
 * track-name field must not fire marks). A second press of the same kind (MARK, MARK SMALL or UNDO) within
 * {@link DEBOUNCE_MS} of an accepted one is a double-press and is dropped. The debounce is tracked PER KIND, so `m`
 * then `n` within the window are both accepted.
 */

export type StructureLogKeyAction = 'mark' | 'markSmall' | 'undo' | 'finishArm' | 'finish'

export interface StructureLogKeyEvent {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  repeat?: boolean
  isComposing?: boolean
  target?: unknown
}

export interface StructureLogKeyResult {
  action: StructureLogKeyAction | null
  /** Space must not scroll the page even when the press is debounced or ignored as a repeat. */
  preventDefault: boolean
}

export const DEBOUNCE_MS = 150
export const FINISH_CONFIRM_MS = 3000

/** Is the event's target somewhere the user is typing? Duck-typed so it works on a plain object in node. */
export function isTypingTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false
  const t = target as { tagName?: unknown; isContentEditable?: unknown }
  if (t.isContentEditable === true) return true
  if (typeof t.tagName !== 'string') return false
  const tag = t.tagName.toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

type BaseKey = 'mark' | 'markSmall' | 'undo' | 'finish'

function baseAction(key: string): BaseKey | null {
  switch (key) {
    case 'm':
    case 'M':
    case ' ':
    case 'Spacebar': // very old engines
      return 'mark'
    case 'n':
    case 'N':
      return 'markSmall'
    case 'u':
    case 'U':
      return 'undo'
    case 'e':
    case 'E':
      return 'finish'
    default:
      return null
  }
}

export interface StructureLogHotkeyGate {
  handle(e: StructureLogKeyEvent, nowMs: number): StructureLogKeyResult
  /** Forget the armed-finish and the debounce state (after the finish ran, or on a track change). */
  reset(): void
}

const NONE: StructureLogKeyResult = { action: null, preventDefault: false }
const NONE_PREVENT: StructureLogKeyResult = { action: null, preventDefault: true }

/** A stateful gate (debounce + the two-press finish). One per overlay instance. */
export function createHotkeyGate(debounceMs = DEBOUNCE_MS, finishConfirmMs = FINISH_CONFIRM_MS): StructureLogHotkeyGate {
  let lastMark = -Infinity
  let lastSmall = -Infinity
  let lastUndo = -Infinity
  let finishArmedAt = -Infinity

  return {
    handle(e, nowMs) {
      const base = baseAction(e.key)
      if (base === null) return NONE
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return NONE
      if (e.isComposing) return NONE
      if (isTypingTarget(e.target)) return NONE
      const space = base === 'mark' && (e.key === ' ' || e.key === 'Spacebar')
      if (e.repeat) return space ? NONE_PREVENT : NONE
      const prevent = space
      switch (base) {
        case 'mark':
          if (nowMs - lastMark < debounceMs) return prevent ? NONE_PREVENT : NONE
          lastMark = nowMs
          return { action: 'mark', preventDefault: prevent }
        case 'markSmall':
          if (nowMs - lastSmall < debounceMs) return NONE
          lastSmall = nowMs
          return { action: 'markSmall', preventDefault: false }
        case 'undo':
          if (nowMs - lastUndo < debounceMs) return NONE
          lastUndo = nowMs
          return { action: 'undo', preventDefault: false }
        case 'finish': {
          const dt = nowMs - finishArmedAt
          if (dt < debounceMs) return NONE // a key bounce right after arming is not a confirmation
          if (dt <= finishConfirmMs) {
            finishArmedAt = -Infinity
            return { action: 'finish', preventDefault: false }
          }
          finishArmedAt = nowMs
          return { action: 'finishArm', preventDefault: false }
        }
      }
    },
    reset() {
      lastMark = -Infinity
      lastSmall = -Infinity
      lastUndo = -Infinity
      finishArmedAt = -Infinity
    },
  }
}
