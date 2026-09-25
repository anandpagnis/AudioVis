import { describe, expect, it } from 'vitest'
import { DEBOUNCE_MS, FINISH_CONFIRM_MS, createHotkeyGate, isTypingTarget } from '../structureLogHotkeys'

const key = (k: string, over: Record<string, unknown> = {}) => ({ key: k, ...over })

describe('isTypingTarget', () => {
  it('is true for text fields and contenteditable, false for everything else', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true)
    expect(isTypingTarget({ tagName: 'textarea' })).toBe(true)
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV' })).toBe(false)
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
    expect(isTypingTarget(undefined)).toBe(false)
    expect(isTypingTarget('input')).toBe(false)
    expect(isTypingTarget({})).toBe(false)
  })
})

describe('hotkey gate: mark', () => {
  it('maps m, M and space to MARK; space also blocks the page scroll', () => {
    const g = createHotkeyGate()
    expect(g.handle(key('m'), 1000)).toEqual({ action: 'mark', preventDefault: false })
    expect(g.handle(key('M'), 2000)).toEqual({ action: 'mark', preventDefault: false })
    expect(g.handle(key(' '), 3000)).toEqual({ action: 'mark', preventDefault: true })
  })

  it('ignores unrelated keys', () => {
    const g = createHotkeyGate()
    for (const k of ['a', 'f', 'h', 'x', 'Enter', 'Escape', 'ArrowRight', '1', 'Shift', 'Tab']) {
      expect(g.handle(key(k), 1000).action).toBeNull()
    }
  })

  it('drops a double-press within the debounce window and accepts the next one after it', () => {
    const g = createHotkeyGate()
    expect(g.handle(key('m'), 1000).action).toBe('mark')
    expect(g.handle(key('m'), 1000 + DEBOUNCE_MS - 1).action).toBeNull()
    expect(g.handle(key('m'), 1000 + DEBOUNCE_MS).action).toBe('mark')
  })

  it('debounces from the last ACCEPTED mark, so a stream of bounces cannot push the window forward', () => {
    const g = createHotkeyGate()
    expect(g.handle(key('m'), 0).action).toBe('mark')
    for (let t = 20; t < DEBOUNCE_MS; t += 20) expect(g.handle(key('m'), t).action).toBeNull()
    expect(g.handle(key('m'), DEBOUNCE_MS).action).toBe('mark')
  })

  it('a debounced or held space still prevents the scroll', () => {
    const g = createHotkeyGate()
    g.handle(key(' '), 0)
    expect(g.handle(key(' '), 50)).toEqual({ action: null, preventDefault: true })
    expect(g.handle(key(' ', { repeat: true }), 500)).toEqual({ action: null, preventDefault: true })
  })

  it('ignores key repeat (a held key)', () => {
    const g = createHotkeyGate()
    expect(g.handle(key('m', { repeat: true }), 1000)).toEqual({ action: null, preventDefault: false })
  })

  it('ignores every modifier combination', () => {
    const g = createHotkeyGate()
    for (const mod of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) {
      expect(g.handle(key('m', { [mod]: true }), 1000)).toEqual({ action: null, preventDefault: false })
      expect(g.handle(key(' ', { [mod]: true }), 1000).action).toBeNull()
      expect(g.handle(key('e', { [mod]: true }), 1000).action).toBeNull()
    }
    // and a refused press does not start the debounce: the next plain press works
    expect(g.handle(key('m'), 1001).action).toBe('mark')
  })

  it('ignores IME composition', () => {
    expect(createHotkeyGate().handle(key('m', { isComposing: true }), 1000).action).toBeNull()
  })

  it('ignores typing in the track-name field, and does not prevent the space there', () => {
    const g = createHotkeyGate()
    const input = { tagName: 'INPUT' }
    expect(g.handle(key('m', { target: input }), 1000)).toEqual({ action: null, preventDefault: false })
    expect(g.handle(key(' ', { target: input }), 1000)).toEqual({ action: null, preventDefault: false })
    expect(g.handle(key('e', { target: input }), 1000).action).toBeNull()
    expect(g.handle(key('u', { target: { tagName: 'TEXTAREA' } }), 1000).action).toBeNull()
    // a plain element as target is fine
    expect(g.handle(key('m', { target: { tagName: 'DIV' } }), 1000).action).toBe('mark')
  })
})

describe('hotkey gate: undo', () => {
  it('maps u to undo, with its own debounce', () => {
    const g = createHotkeyGate()
    expect(g.handle(key('u'), 1000)).toEqual({ action: 'undo', preventDefault: false })
    expect(g.handle(key('U'), 1050).action).toBeNull()
    expect(g.handle(key('u'), 1000 + DEBOUNCE_MS).action).toBe('undo')
  })

  it('a mark right after an undo is not swallowed by the undo debounce', () => {
    const g = createHotkeyGate()
    g.handle(key('u'), 1000)
    expect(g.handle(key('m'), 1010).action).toBe('mark')
  })
})

describe('hotkey gate: finish needs two presses of e', () => {
  it('the first press only arms, the second within the window finishes', () => {
    const g = createHotkeyGate()
    expect(g.handle(key('e'), 1000).action).toBe('finishArm')
    expect(g.handle(key('E'), 1500).action).toBe('finish')
  })

  it('a second press after the window re-arms instead of finishing', () => {
    const g = createHotkeyGate()
    expect(g.handle(key('e'), 1000).action).toBe('finishArm')
    expect(g.handle(key('e'), 1000 + FINISH_CONFIRM_MS + 1).action).toBe('finishArm')
    expect(g.handle(key('e'), 1000 + FINISH_CONFIRM_MS + 500).action).toBe('finish')
  })

  it('a key bounce right after arming is not a confirmation', () => {
    const g = createHotkeyGate()
    expect(g.handle(key('e'), 1000).action).toBe('finishArm')
    expect(g.handle(key('e'), 1000 + DEBOUNCE_MS - 1).action).toBeNull()
    expect(g.handle(key('e'), 1000 + DEBOUNCE_MS).action).toBe('finish')
  })

  it('finishing consumes the arm: a third press arms again', () => {
    const g = createHotkeyGate()
    g.handle(key('e'), 1000)
    expect(g.handle(key('e'), 1500).action).toBe('finish')
    expect(g.handle(key('e'), 2000).action).toBe('finishArm')
  })

  it('reset() forgets an armed finish', () => {
    const g = createHotkeyGate()
    g.handle(key('e'), 1000)
    g.reset()
    expect(g.handle(key('e'), 1500).action).toBe('finishArm')
  })

  it('other keys in between do not cancel the arm (a tap during the confirm window is still a tap)', () => {
    const g = createHotkeyGate()
    g.handle(key('e'), 1000)
    expect(g.handle(key('m'), 1200).action).toBe('mark')
    expect(g.handle(key('e'), 1600).action).toBe('finish')
  })
})
