import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  MAX_BAND_MAPPINGS,
  useStore,
  type BandSource,
  type LayerBlend,
  type LayerRole,
  type Quality,
} from '../store'
import { SCENES, getScene } from '../scenes'
import { PALETTES } from '../engine/palettes'
import { BUILTIN_PRESETS, type Preset } from '../engine/presets'
import { saveScreenshot } from '../engine/recorder'
import { buildShareUrl } from '../urlParams'
import { BpmReadout } from './BpmReadout'
import { DebugPanel } from './DebugPanel'
import { AnalyticsPanel } from './AnalyticsPanel'

// macOS Chrome can only capture a browser TAB's audio via getDisplayMedia —
// whole-screen / system audio isn't available, so the copy has to differ.
const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent)

/**
 * All 2D chrome: the start card, the top bar, the ☰ control menu, and the global
 * keyboard shortcuts.
 *
 * Deliberately outside the R3F tree — this is plain DOM over the canvas, so it
 * re-renders on React state rather than per frame. Anything that needs per-frame
 * audio values (BPM readout, debug panel, tactical overlay) lives in its own
 * component that reads `audioEngine.features` directly instead of pushing audio
 * through React state.
 *
 * Sections below, in render order:
 *   1. Keyboard shortcuts        (useEffect, window keydown)
 *   2. Start card                (shown whenever status !== 'running')
 *   3. Top bar                   (brand, source, BPM, quality)
 *   4. Control menu              (collapsible sections: look, tune, layers,
 *                                 presets, cues, automation, export)
 *
 * The start card must never trap the user: while `status === 'starting'` every
 * source button is disabled, so it always offers a Cancel plus Escape.
 */
export function HUD() {
  const status = useStore((s) => s.status)
  const sourceType = useStore((s) => s.sourceType)
  const error = useStore((s) => s.error)
  const sceneId = useStore((s) => s.sceneId)
  const accentSceneId = useStore((s) => s.accentSceneId)
  const overlaySceneId = useStore((s) => s.overlaySceneId)
  const pendingSceneId = useStore((s) => s.pendingSceneId)
  const paletteId = useStore((s) => s.paletteId)
  const uiHidden = useStore((s) => s.uiHidden)
  const debugOpen = useStore((s) => s.debugOpen)
  const analyticsOpen = useStore((s) => s.analyticsOpen)
  const params = useStore((s) => s.params)
  const quality = useStore((s) => s.quality)
  const autoPilot = useStore((s) => s.autoPilot)
  const moodDrive = useStore((s) => s.moodDrive)
  const generative = useStore((s) => s.generative)
  const tacticalHud = useStore((s) => s.tacticalHud)
  const layerFx = useStore((s) => s.layerFx)
  const responseTuning = useStore((s) => s.responseTuning)
  const bandMappings = useStore((s) => s.bandMappings)
  const cues = useStore((s) => s.cues)
  const cueFollow = useStore((s) => s.cueFollow)
  const midiSync = useStore((s) => s.midiSync)
  const isRecording = useStore((s) => s.isRecording)
  const userPresets = useStore((s) => s.userPresets)
  const favoriteIds = useStore((s) => s.favoriteIds)
  const micDevices = useStore((s) => s.micDevices)
  const micDeviceId = useStore((s) => s.micDeviceId)

  const [idle, setIdle] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [openSection, setOpenSection] = useState<string | null>('scene')
  const [presetName, setPresetName] = useState('')
  const [shared, setShared] = useState(false)
  const idleTimer = useRef<number>(0)
  const fileRef = useRef<HTMLInputElement>(null)
  const audioFileRef = useRef<HTMLInputElement>(null)

  // Auto-hide chrome when the mouse goes quiet (but never while the menu is open).
  useEffect(() => {
    const poke = () => {
      setIdle(false)
      window.clearTimeout(idleTimer.current)
      idleTimer.current = window.setTimeout(() => setIdle(true), 3200)
    }
    poke()
    window.addEventListener('pointermove', poke)
    window.addEventListener('pointerdown', poke)
    return () => {
      window.removeEventListener('pointermove', poke)
      window.removeEventListener('pointerdown', poke)
      window.clearTimeout(idleTimer.current)
    }
  }, [])

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen()
  }, [])

  // Keyboard shortcuts. Digits 1–9 map to scenes 1–9, 0 to scene 10.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      const s = useStore.getState()
      if (/^[0-9]$/.test(e.key)) {
        const idx = e.key === '0' ? 9 : Number(e.key) - 1
        if (idx < SCENES.length) s.requestScene(SCENES[idx].id)
      } else if (e.key === 'f' || e.key === 'F') {
        toggleFullscreen()
      } else if (e.key === 'h' || e.key === 'H') {
        s.toggleUi()
      } else if (e.key === 'd' || e.key === 'D') {
        s.toggleDebug()
      } else if (e.key === 't' || e.key === 'T') {
        setMenuOpen(true)
        setOpenSection('look')
      } else if (e.key === 'b' || e.key === 'B') {
        setMenuOpen(true)
        setOpenSection('presets')
      } else if (e.key === 'Escape') {
        setMenuOpen(false)
        // Escape is what people press when a dialog has left them stuck, so it
        // also backs out of a start that's waiting on permission.
        if (s.status === 'starting') s.cancelStartAudio()
      } else if (e.key === 'p' || e.key === 'P') {
        const i = PALETTES.findIndex((p) => p.id === s.paletteId)
        s.setPalette(PALETTES[(i + 1) % PALETTES.length].id)
      } else if (e.key === 'a' || e.key === 'A') {
        s.toggleAutoPilot()
      } else if (e.key === 'm' || e.key === 'M') {
        s.toggleMoodDrive()
      } else if (e.key === 'g' || e.key === 'G') {
        s.toggleGenerative()
      } else if (e.key === 'c' || e.key === 'C') {
        if (s.status === 'running') s.captureCue()
      } else if (e.key === 'r' || e.key === 'R') {
        if (s.status === 'running' || s.isRecording) s.toggleRecording()
      } else if (e.key === 's' || e.key === 'S') {
        saveScreenshot()
      } else if (e.key === 'j' || e.key === 'J') {
        s.toggleTacticalHud()
      } else if (e.key === 'y' || e.key === 'Y') {
        s.toggleAnalytics()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleFullscreen])

  const exportPresets = useCallback(() => {
    const data = JSON.stringify(useStore.getState().userPresets, null, 2)
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'audiovis-presets.json'
    a.click()
    URL.revokeObjectURL(url)
  }, [])

  const onImportFile = useCallback(async (file: File | undefined) => {
    if (!file) return
    const text = await file.text()
    useStore.getState().importPresets(text)
  }, [])

  // Keep the chrome (and the open menu) visible while the menu is open.
  const chromeHidden = (uiHidden || (idle && status === 'running')) && !menuOpen

  const allPresets: Preset[] = [...BUILTIN_PRESETS, ...userPresets].sort((a, b) => {
    const fa = favoriteIds.includes(a.id) ? 0 : 1
    const fb = favoriteIds.includes(b.id) ? 0 : 1
    return fa - fb
  })

  // Per-layer intensity + blend controls, shown when the layer is active.
  const layerFxRow = (role: LayerRole) => (
    <div className="layer-fx-row">
      <span className="layer-label" />
      <input
        type="range"
        min={0}
        max={1.5}
        step={0.05}
        value={layerFx[role].intensity}
        onChange={(e) =>
          useStore.getState().setLayerFx(role, { intensity: Number(e.target.value) })
        }
      />
      <em>{layerFx[role].intensity.toFixed(2)}×</em>
      {(['add', 'screen', 'normal', 'multiply'] as LayerBlend[]).map((b) => (
        <button
          key={b}
          className={`chip ${layerFx[role].blend === b ? 'active' : ''}`}
          onClick={() => useStore.getState().setLayerFx(role, { blend: b })}
        >
          {b}
        </button>
      ))}
    </div>
  )

  // One collapsible section of the corner menu. Returns plain JSX (not a
  // component type) so inputs inside keep focus across renders.
  const section = (id: string, label: string, body: ReactNode) => (
    <div className="menu-section">
      <button
        className={`menu-head ${openSection === id ? 'open' : ''}`}
        onClick={() => setOpenSection(openSection === id ? null : id)}
      >
        <span>{label}</span>
        <span className="menu-caret">{openSection === id ? '▾' : '▸'}</span>
      </button>
      {openSection === id && <div className="menu-body">{body}</div>}
    </div>
  )

  return (
    <>
      {status !== 'running' && (
        <div className="overlay">
          <div className="start-card glass">
            <h1>AudioVis</h1>
            <p className="tagline">Real-time generative visuals, driven by your music.</p>
            <div className="start-buttons">
              <button
                className="btn primary"
                disabled={status === 'starting'}
                onClick={() => void useStore.getState().startAudio('system')}
              >
                <span className="btn-title">{IS_MAC ? 'Browser-tab audio' : 'System audio'}</span>
                <span className="btn-sub">
                  {IS_MAC
                    ? 'Play music in a Chrome tab (Spotify, YouTube…), then in the picker choose that tab and tick “Share tab audio”. macOS can’t capture whole-screen audio.'
                    : 'Spotify, YouTube, anything playing — choose “Entire Screen” with “Also share system audio”, or a browser tab with “Share tab audio”.'}
                </span>
              </button>
              <button
                className="btn"
                disabled={status === 'starting'}
                onClick={() => void useStore.getState().startAudio('mic')}
              >
                <span className="btn-title">Microphone / line-in</span>
                <span className="btn-sub">
                  Live instruments, DJ sets, USB interfaces (virtual cables like BlackHole appear
                  here too). Note: Bluetooth headphones drop to call-quality audio while their mic
                  is open — prefer System audio for music
                </span>
              </button>
              <button
                className="btn"
                disabled={status === 'starting'}
                onClick={() => audioFileRef.current?.click()}
              >
                <span className="btn-title">Audio file</span>
                <span className="btn-sub">
                  Play a local track through your speakers while it drives the visuals — ideal for
                  rehearsing a set or authoring cue timelines
                </span>
              </button>
              <input
                ref={audioFileRef}
                type="file"
                accept="audio/*"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) void useStore.getState().startAudioFile(file)
                  e.target.value = ''
                }}
              />
            </div>
            {micDevices.length > 0 && (
              <select
                className="device-select"
                value={micDeviceId ?? ''}
                onChange={(e) => useStore.getState().setMicDevice(e.target.value)}
              >
                {micDevices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
            )}
            {error && <p className="error">{error}</p>}
            {status === 'starting' && (
              <div className="starting-row">
                <p className="hint">
                  Waiting for permission — pick a source in the browser dialog.
                </p>
                <button
                  className="btn ghost"
                  onClick={() => useStore.getState().cancelStartAudio()}
                >
                  Cancel
                </button>
              </div>
            )}
            <p className="hint keys">
              Runs on autopilot by default — open the ☰ menu to customize. 1–0 scenes · A autopilot
              · P palette · C cue · R record · S shot · J HUD · Y analytics · F fullscreen · H hide
            </p>
          </div>
        </div>
      )}

      <div className={`chrome ${chromeHidden ? 'hidden' : ''}`}>
        <div className="top-bar">
          <div className="brand glass">
            AudioVis
            {sourceType && (
              <button className="chip stop" onClick={() => useStore.getState().stopAudio()}>
                ■ {sourceType}
              </button>
            )}
          </div>
          <BpmReadout />
        </div>

        {debugOpen && <DebugPanel />}
        {analyticsOpen && <AnalyticsPanel />}

        {/* ---- Collapsible corner menu: all customization lives here ---- */}
        <div className="menu-dock">
          {menuOpen && (
            <div className="menu-panel glass">
              <div className="menu-title">
                <span>Controls</span>
                <button className="menu-x" title="Close (Esc)" onClick={() => setMenuOpen(false)}>
                  ✕
                </button>
              </div>

              {section(
                'scene',
                'Scene & palette',
                <>
                  <div className="menu-chips">
                    {SCENES.map((s) => (
                      <button
                        key={s.id}
                        className={`chip ${s.id === sceneId ? 'active' : ''} ${s.id === pendingSceneId ? 'pending' : ''}`}
                        onClick={() => useStore.getState().requestScene(s.id)}
                      >
                        {s.name}
                      </button>
                    ))}
                  </div>
                  <div className="menu-sublabel">Palette (P)</div>
                  <div className="menu-chips">
                    {PALETTES.map((p) => (
                      <button
                        key={p.id}
                        className={`chip swatch ${p.id === paletteId ? 'active' : ''}`}
                        title={p.name}
                        onClick={() => useStore.getState().setPalette(p.id)}
                      >
                        {p.colors.map((c) => (
                          <i key={c} style={{ background: c }} />
                        ))}
                      </button>
                    ))}
                  </div>
                </>,
              )}

              {section(
                'automation',
                'Automation',
                <div className="menu-chips">
                  <button
                    className={`chip ${autoPilot ? 'active' : ''}`}
                    title="Mood engine picks scenes & palettes (A)"
                    onClick={() => useStore.getState().toggleAutoPilot()}
                  >
                    autopilot
                  </button>
                  <button
                    className={`chip ${moodDrive ? 'active' : ''}`}
                    title="Mood scales intensity/speed/reactivity (M)"
                    onClick={() => useStore.getState().toggleMoodDrive()}
                  >
                    mood drive
                  </button>
                  <button
                    className={`chip ${tacticalHud ? 'active' : ''}`}
                    title="Tactical HUD overlay (J)"
                    onClick={() => useStore.getState().toggleTacticalHud()}
                  >
                    tactical HUD
                  </button>
                  <button
                    className={`chip ${generative ? 'active' : ''}`}
                    title="AI mood textures from the local backend (G)"
                    onClick={() => useStore.getState().toggleGenerative()}
                  >
                    AI textures
                  </button>
                  <button
                    className={`chip ${midiSync ? 'active' : ''}`}
                    title="Lock the beat grid to an external MIDI clock"
                    onClick={() => void useStore.getState().toggleMidiSync()}
                  >
                    MIDI clock
                  </button>
                </div>,
              )}

              {section(
                'look',
                'Look',
                <>
                  {(
                    [
                      ['intensity', 'Intensity'],
                      ['speed', 'Speed'],
                      ['reactivity', 'Reactivity'],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key} className="param-row">
                      <span>{label}</span>
                      <input
                        type="range"
                        min={0.2}
                        max={2}
                        step={0.05}
                        value={params[key]}
                        onChange={(e) => useStore.getState().setParam(key, Number(e.target.value))}
                      />
                      <em>{params[key].toFixed(2)}×</em>
                    </label>
                  ))}
                  <div className="param-row">
                    <span>Quality</span>
                    <div className="quality-row">
                      {(['auto', 'low', 'medium', 'high'] as Quality[]).map((q) => (
                        <button
                          key={q}
                          className={`chip ${quality === q ? 'active' : ''}`}
                          onClick={() => useStore.getState().setQuality(q)}
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                </>,
              )}

              {section(
                'response',
                'Response & routing',
                <>
                  {(
                    [
                      ['attack', 'Attack'],
                      ['release', 'Release'],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key} className="param-row">
                      <span>{label}</span>
                      <input
                        type="range"
                        min={0.25}
                        max={3}
                        step={0.05}
                        value={responseTuning[key]}
                        onChange={(e) =>
                          useStore.getState().setResponseTuning({ [key]: Number(e.target.value) })
                        }
                      />
                      <em>{responseTuning[key].toFixed(2)}×</em>
                    </label>
                  ))}
                  <div className="param-row">
                    <span>Pulse</span>
                    <div className="quality-row">
                      {(
                        [
                          [0.5, '½×'],
                          [1, '1×'],
                          [2, '2×'],
                          [4, '4×'],
                        ] as const
                      ).map(([value, label]) => (
                        <button
                          key={value}
                          className={`chip ${responseTuning.subdivision === value ? 'active' : ''}`}
                          title="Beat pulses per grid beat (½ = half-time)"
                          onClick={() =>
                            useStore.getState().setResponseTuning({ subdivision: value })
                          }
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="param-row">
                    <span>Routing</span>
                    <div className="quality-row">
                      <button
                        className="chip"
                        disabled={bandMappings.length >= MAX_BAND_MAPPINGS}
                        title="Route an audio band to a visual parameter"
                        onClick={() => useStore.getState().addBandMapping()}
                      >
                        + add
                      </button>
                    </div>
                  </div>
                  {bandMappings.map((m) => (
                    <div key={m.id} className="map-row">
                      <select
                        value={m.source}
                        onChange={(e) =>
                          useStore
                            .getState()
                            .updateBandMapping(m.id, { source: e.target.value as BandSource })
                        }
                      >
                        {(
                          [
                            'sub',
                            'bass',
                            'mid',
                            'presence',
                            'high',
                            'vocal',
                            'energy',
                            'transient',
                            'beatPulse',
                          ] as const
                        ).map((src) => (
                          <option key={src} value={src}>
                            {src}
                          </option>
                        ))}
                      </select>
                      <span className="map-arrow">→</span>
                      <select
                        value={m.target}
                        onChange={(e) =>
                          useStore.getState().updateBandMapping(m.id, {
                            target: e.target.value as 'intensity' | 'speed' | 'reactivity',
                          })
                        }
                      >
                        {(['intensity', 'speed', 'reactivity'] as const).map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                      <input
                        type="range"
                        min={-1}
                        max={1}
                        step={0.05}
                        value={m.amount}
                        onChange={(e) =>
                          useStore
                            .getState()
                            .updateBandMapping(m.id, { amount: Number(e.target.value) })
                        }
                      />
                      <em>
                        {m.amount >= 0 ? '+' : ''}
                        {m.amount.toFixed(2)}
                      </em>
                      <button
                        className="preset-del"
                        title="Remove mapping"
                        onClick={() => useStore.getState().removeBandMapping(m.id)}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </>,
              )}

              {section(
                'layers',
                'Composition layers',
                <>
                  <div className="layer-row">
                    <span className="layer-label">accent</span>
                    <button
                      className={`chip ${accentSceneId === null ? 'active' : ''}`}
                      onClick={() => useStore.getState().setLayer('accent', null)}
                    >
                      none
                    </button>
                    {SCENES.filter((s) => s.metadata.roles.includes('accent')).map((s) => (
                      <button
                        key={`accent-${s.id}`}
                        className={`chip ${accentSceneId === s.id ? 'active' : ''}`}
                        onClick={() => useStore.getState().setLayer('accent', s.id)}
                      >
                        {s.name}
                      </button>
                    ))}
                  </div>
                  {accentSceneId && layerFxRow('accent')}
                  <div className="layer-row">
                    <span className="layer-label">overlay</span>
                    <button
                      className={`chip ${overlaySceneId === null ? 'active' : ''}`}
                      onClick={() => useStore.getState().setLayer('overlay', null)}
                    >
                      none
                    </button>
                    {SCENES.filter((s) => s.metadata.roles.includes('overlay')).map((s) => (
                      <button
                        key={`overlay-${s.id}`}
                        className={`chip ${overlaySceneId === s.id ? 'active' : ''}`}
                        onClick={() => useStore.getState().setLayer('overlay', s.id)}
                      >
                        {s.name}
                      </button>
                    ))}
                  </div>
                  {overlaySceneId && layerFxRow('overlay')}
                </>,
              )}

              {section(
                'cues',
                'Performance cues',
                <>
                  <div className="layer-row">
                    <button
                      className="chip"
                      disabled={status !== 'running'}
                      title="Capture the current look at the current beat (C)"
                      onClick={() => useStore.getState().captureCue()}
                    >
                      + capture (C)
                    </button>
                    <button
                      className={`chip ${cueFollow ? 'active' : ''}`}
                      title="Play authored cues back as their beats arrive"
                      onClick={() => useStore.getState().toggleCueFollow()}
                    >
                      follow
                    </button>
                    {cues.length > 0 && (
                      <button className="chip" onClick={() => useStore.getState().clearCues()}>
                        clear
                      </button>
                    )}
                  </div>
                  {cues.map((c) => (
                    <div key={c.id} className="cue-row">
                      <span className="cue-beat">bar {Math.floor(c.beat / 4) + 1}</span>
                      <span className="cue-scene">{getScene(c.sceneId).name}</span>
                      <span className="cue-extra">
                        {[
                          c.accentSceneId && `+${getScene(c.accentSceneId).name}`,
                          c.overlaySceneId && `+${getScene(c.overlaySceneId).name}`,
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      </span>
                      <button
                        className="preset-del"
                        title="Delete cue"
                        onClick={() => useStore.getState().deleteCue(c.id)}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </>,
              )}

              {section(
                'presets',
                'Presets',
                <>
                  <div className="preset-list">
                    {allPresets.map((p) => (
                      <div key={p.id} className="preset-row">
                        <button
                          className={`star ${favoriteIds.includes(p.id) ? 'on' : ''}`}
                          title="Favorite"
                          onClick={() => useStore.getState().toggleFavorite(p.id)}
                        >
                          ★
                        </button>
                        <button
                          className="preset-name"
                          onClick={() => useStore.getState().applyPreset(p)}
                        >
                          {p.name}
                        </button>
                        {p.builtIn ? (
                          <span className="preset-tag">built-in</span>
                        ) : (
                          <button
                            className="preset-del"
                            title="Delete"
                            onClick={() => useStore.getState().deletePreset(p.id)}
                          >
                            ×
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="preset-actions">
                    <input
                      type="text"
                      placeholder="Preset name…"
                      value={presetName}
                      onChange={(e) => setPresetName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && presetName.trim()) {
                          useStore.getState().saveCurrentPreset(presetName)
                          setPresetName('')
                        }
                      }}
                    />
                    <button
                      className="chip"
                      onClick={() => {
                        if (presetName.trim()) {
                          useStore.getState().saveCurrentPreset(presetName)
                          setPresetName('')
                        }
                      }}
                    >
                      save
                    </button>
                    <button className="chip" onClick={() => fileRef.current?.click()}>
                      import
                    </button>
                    <button className="chip" onClick={exportPresets}>
                      export
                    </button>
                    <button
                      className="chip"
                      title="Copy a URL that reproduces this look (and cues) on load"
                      onClick={() => {
                        void navigator.clipboard.writeText(buildShareUrl()).then(() => {
                          setShared(true)
                          window.setTimeout(() => setShared(false), 1600)
                        })
                      }}
                    >
                      {shared ? 'copied ✓' : 'share'}
                    </button>
                    <input
                      ref={fileRef}
                      type="file"
                      accept="application/json"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        void onImportFile(e.target.files?.[0])
                        e.target.value = ''
                      }}
                    />
                  </div>
                </>,
              )}

              {section(
                'export',
                'Capture & view',
                <div className="menu-chips">
                  <button
                    className={`chip rec ${isRecording ? 'on' : ''}`}
                    disabled={status !== 'running' && !isRecording}
                    title="Record canvas + audio to .webm (R)"
                    onClick={() => useStore.getState().toggleRecording()}
                  >
                    {isRecording ? '■ rec' : '● rec'}
                  </button>
                  <button className="chip" title="Save a PNG (S)" onClick={() => saveScreenshot()}>
                    screenshot
                  </button>
                  <button className="chip" title="Fullscreen (F)" onClick={toggleFullscreen}>
                    fullscreen
                  </button>
                  <button
                    className={`chip ${debugOpen ? 'active' : ''}`}
                    title="Audio-analysis debug panel (D)"
                    onClick={() => useStore.getState().toggleDebug()}
                  >
                    debug
                  </button>
                  <button
                    className={`chip ${analyticsOpen ? 'active' : ''}`}
                    title="Numeric accuracy/smoothness analytics: beat-tracking accuracy, mood confidence, transition timing (Y)"
                    onClick={() => useStore.getState().toggleAnalytics()}
                  >
                    analytics
                  </button>
                  <button
                    className="chip"
                    title="Hide all UI (H)"
                    onClick={() => useStore.getState().toggleUi()}
                  >
                    hide UI
                  </button>
                </div>,
              )}
            </div>
          )}

          <div className="menu-bar">
            <button
              className={`chip auto-chip ${autoPilot ? 'active' : ''}`}
              title="Autopilot: mood picks the scenes (A)"
              onClick={() => useStore.getState().toggleAutoPilot()}
            >
              auto
            </button>
            <button
              className={`menu-fab glass ${menuOpen ? 'open' : ''}`}
              title={menuOpen ? 'Close menu (Esc)' : 'Open controls'}
              onClick={() => setMenuOpen((o) => !o)}
            >
              {menuOpen ? '✕' : '☰'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
