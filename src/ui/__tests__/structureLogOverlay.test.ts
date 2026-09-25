import { describe, expect, it } from 'vitest'
import STRUCTURE_LOG_SRC from '../StructureLog.tsx?raw'
import HOTKEYS_SRC from '../structureLogHotkeys.ts?raw'
import RECORDER_SRC from '../../engine/structureLog.ts?raw'
import VISUALIZER_SRC from '../../routes/Visualizer.tsx?raw'

/**
 * Source pins for the `?structurelog` overlay, in the style of `look/__tests__/lookDebug.test.ts`: the component is
 * DOM, so what can be pinned without a browser is its plumbing (where it is mounted, that it is click-through,
 * that no per-frame React state exists) and that it goes through the tested pure pieces.
 */
describe('StructureLog overlay plumbing', () => {
  it('is a fixed, click-through, monospace corner overlay whose only interactive parts are its own controls', () => {
    expect(STRUCTURE_LOG_SRC).toMatch(/position:\s*'fixed'/)
    expect(STRUCTURE_LOG_SRC).toMatch(/monospace/)
    // the root swallows no pointer events ...
    const root = STRUCTURE_LOG_SRC.slice(STRUCTURE_LOG_SRC.indexOf('const ROOT'), STRUCTURE_LOG_SRC.indexOf('const PRE'))
    expect(root).toMatch(/pointerEvents:\s*'none'/)
    // ... and only the buttons and the name field opt back in
    const control = STRUCTURE_LOG_SRC.slice(STRUCTURE_LOG_SRC.indexOf('const CONTROL'), STRUCTURE_LOG_SRC.indexOf('function downloadText'))
    expect(control.match(/pointerEvents:\s*'auto'/g)).toHaveLength(2)
    expect(STRUCTURE_LOG_SRC.match(/pointerEvents:\s*'auto'/g)).toHaveLength(2)
  })

  it('has no per-frame React state: refs, an interval for the text, and one render-loop hook for observe()', () => {
    expect(STRUCTURE_LOG_SRC).not.toMatch(/useState|useFrame|requestAnimationFrame|useReducer/)
    expect(STRUCTURE_LOG_SRC).toMatch(/window\.setInterval\(paint,\s*HUD_INTERVAL_MS\)/)
    expect(STRUCTURE_LOG_SRC).toMatch(/addAfterEffect\(observe\)/)
    expect(STRUCTURE_LOG_SRC).toMatch(/structureLog\.observe\(audioEngine\.features,\s*useStore\.getState\(\)\)/)
    expect(STRUCTURE_LOG_SRC).toMatch(/textContent/)
  })

  it('renders nothing without the flag (read once, at mount, from the window or its opener) and switches the recorder on only then', () => {
    expect(STRUCTURE_LOG_SRC).toMatch(/useMemo\(\(\) => structureLogRequested\(\), \[\]\)/)
    expect(STRUCTURE_LOG_SRC).toMatch(/if \(!enabled\) return null/)
    expect(STRUCTURE_LOG_SRC).toMatch(/if \(!enabled\) return\n/)
    expect(STRUCTURE_LOG_SRC).toMatch(/structureLog\.enabled = true/)
    expect(STRUCTURE_LOG_SRC).toMatch(/structureLog\.enabled = false/)
  })

  it('takes its keys from the tested gate, listens in the capture phase, and guards against losing unsaved marks', () => {
    expect(STRUCTURE_LOG_SRC).toMatch(/createHotkeyGate\(\)/)
    expect(STRUCTURE_LOG_SRC).toMatch(/gate\.handle\(e,\s*performance\.now\(\)\)/)
    expect(STRUCTURE_LOG_SRC).toMatch(/addEventListener\('keydown',\s*onKey,\s*true\)/)
    expect(STRUCTURE_LOG_SRC).toMatch(/beforeunload/)
    expect(STRUCTURE_LOG_SRC).toMatch(/structureLog\.unsavedCount\(\)/)
    // no key literals of its own: the map lives in structureLogHotkeys.ts
    expect(STRUCTURE_LOG_SRC).not.toMatch(/e\.key ===\s*'(m|u|e| )'/)
  })

  it('exports as a downloaded Blob named structurelog-*.json, and can copy to the clipboard', () => {
    expect(STRUCTURE_LOG_SRC).toMatch(/new Blob\(\[text\],\s*\{\s*type:\s*'application\/json'\s*\}\)/)
    expect(STRUCTURE_LOG_SRC).toMatch(/a\.download = fileName/)
    expect(STRUCTURE_LOG_SRC).toMatch(/navigator\.clipboard\.writeText/)
    expect(RECORDER_SRC).toMatch(/`structurelog-\$\{/)
  })

  it('buttons never take keyboard focus, so a later Space cannot re-press one', () => {
    expect(STRUCTURE_LOG_SRC).toMatch(/onMouseDown=\{noFocus\}/)
    expect(STRUCTURE_LOG_SRC.match(/tabIndex=\{-1\}/g)?.length).toBeGreaterThanOrEqual(5)
  })

  it('the name field hands the keyboard back to the tap keys on Enter / Escape', () => {
    expect(STRUCTURE_LOG_SRC).toMatch(/e\.key === 'Enter' \|\| e\.key === 'Escape'\) e\.currentTarget\.blur\(\)/)
  })
})

describe('StructureLog mount', () => {
  it('is mounted in the OUTPUT surface (the window that runs the engine), once, and nowhere else', () => {
    const output = VISUALIZER_SRC.slice(
      VISUALIZER_SRC.indexOf('function OutputSurface'),
      VISUALIZER_SRC.indexOf('function usePrefetchScenes'),
    )
    expect(output).toMatch(/<StructureLog \/>/)
    expect(VISUALIZER_SRC.match(/<StructureLog \/>/g)).toHaveLength(1)
    const demo = VISUALIZER_SRC.slice(VISUALIZER_SRC.indexOf('function DemoSurface'), VISUALIZER_SRC.indexOf('function OutputSurface'))
    expect(demo).not.toMatch(/StructureLog/)
    const control = VISUALIZER_SRC.slice(VISUALIZER_SRC.indexOf('function ControlSurface'), VISUALIZER_SRC.indexOf('function useHandedSource'))
    expect(control).not.toMatch(/StructureLog/)
  })
})

describe('the keys collide with nothing in the output window', () => {
  it('the hotkey map is m / space / u / e only, in the tested module', () => {
    for (const k of ["'m'", "'M'", "' '", "'u'", "'U'", "'e'", "'E'"]) expect(HOTKEYS_SRC).toContain(`case ${k}:`)
    // seven single-character keys and nothing else (the long case is the legacy 'Spacebar' name)
    expect((HOTKEYS_SRC.match(/case '.':/g) ?? []).length).toBe(7)
  })
})
