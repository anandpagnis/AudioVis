import { useCallback, useEffect, useRef, useState } from 'react'
import { SCENES } from '../scenes'
import { LAYER_ROLES, type LayerRole } from '../store'
import { PALETTE_FAMILIES, getPalettesByFamily } from '../engine/palettes'
import { useStore } from '../store'
import { onMirror, openOutput, outputIsOpen, readTelemetry, type Telemetry } from '../engine/outputLink'

/**
 * The DJ-facing control surface.
 *
 * This window renders nothing of the show — it is a console plus a mirror of
 * the output window's canvas. The layout is a console rather than a menu on
 * purpose: during a set the operator is looking at the room, not at the screen,
 * so every control that matters is on one screen, at a size that can be hit
 * without aiming, with no scrolling and nothing behind a disclosure triangle.
 *
 * See engine/outputLink.ts for why the show renders in the other window.
 */
export function Console() {
  const tele = useTelemetry()
  const status = useStore((s) => s.status)
  const error = useStore((s) => s.error)
  const outputOpen = useOutputPresence()

  return (
    <div className="console">
      <header className="console-top">
        <Mirror />
        <Readouts tele={tele} outputOpen={outputOpen} />
        <Transport status={status} error={error} outputOpen={outputOpen} />
      </header>

      <div className="console-body">
        <Section title="Scene">
          <SceneGrid />
        </Section>
        <Section title="Colour">
          <PaletteGrid />
        </Section>
        <Section title="Look">
          <LookControls />
        </Section>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ mirror */

/**
 * The output window's own canvas, as a video.
 *
 * Not a second renderer, and that is the whole point of the two-window split:
 * the stream is `captureStream()` off the canvas that already drew the frame,
 * so watching it costs a frame copy rather than a frame. When the output window
 * is closed there is nothing to show, and saying so plainly beats a black
 * rectangle the operator has to interpret.
 */
function Mirror() {
  const ref = useRef<HTMLVideoElement>(null)
  const [live, setLive] = useState(false)

  useEffect(
    () =>
      onMirror((stream) => {
        const v = ref.current
        if (!v) return
        v.srcObject = stream
        setLive(!!stream)
        if (stream) void v.play().catch(() => {})
      }),
    [],
  )

  return (
    <div className={`mirror ${live ? 'live' : ''}`}>
      <video ref={ref} autoPlay muted playsInline />
      {!live && <span className="mirror-empty">no output</span>}
    </div>
  )
}

/* ---------------------------------------------------------------- readouts */

function Readouts({ tele, outputOpen }: { tele: Telemetry | null; outputOpen: boolean }) {
  const bpm = tele ? Math.round(tele.bpm) : 0
  const beat = tele ? tele.beatInBar : -1
  return (
    <div className="readouts">
      <div className="readout-main">
        <span className="big-number">{bpm || '--'}</span>
        <span className="unit">BPM</span>
        <span className={`mood mood-${tele?.mood ?? 'silence'}`}>{tele?.mood ?? 'idle'}</span>
      </div>

      <div className="beat-dots" aria-label="beat in bar">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={`dot ${i === beat ? 'on' : ''} ${i === 0 ? 'downbeat' : ''}`} />
        ))}
      </div>

      <Meter label="energy" value={tele?.energy ?? 0} />
      <Meter label="phrase" value={tele?.phraseProgress ?? 0} />

      <div className="readout-row">
        <span className={`pill ${outputOpen && tele ? 'good' : 'bad'}`}>
          {outputOpen && tele ? 'output live' : 'output down'}
        </span>
        {tele && (
          <>
            <span className="pill">tier {tele.tier}</span>
            <span className={`pill ${tele.frameMs > 20 ? 'warn' : ''}`}>
              {tele.frameMs > 0 ? `${tele.frameMs.toFixed(1)} ms` : '--'}
            </span>
            <span className="pill dim">{tele.scene}</span>
          </>
        )}
      </div>
    </div>
  )
}

function Meter({ label, value }: { label: string; value: number }) {
  return (
    <div className="meter">
      <span className="meter-label">{label}</span>
      <div className="meter-track">
        <div className="meter-fill" style={{ width: `${Math.min(1, Math.max(0, value)) * 100}%` }} />
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- transport */

function Transport({
  status,
  error,
  outputOpen,
}: {
  status: string
  error: string | null
  outputOpen: boolean
}) {
  const sourceType = useStore((s) => s.sourceType)
  const isRecording = useStore((s) => s.isRecording)
  const fileRef = useRef<HTMLInputElement>(null)
  const running = status === 'running'

  /**
   * One gesture opens the output window and acquires the source.
   *
   * They cannot be separated: a popup needs a user gesture, and so does a
   * capture prompt. Opening first also means the window exists by the time the
   * source is ready to hand over.
   */
  const start = useCallback((kind: 'system' | 'mic' | 'file') => {
    openOutput()
    if (kind === 'file') fileRef.current?.click()
    else void useStore.getState().startAudio(kind)
  }, [])

  return (
    <div className="transport">
      {!outputOpen && (
        <button className="btn-huge accent" onClick={() => openOutput()}>
          Open output window
          <small>the show runs there</small>
        </button>
      )}

      {!running ? (
        <div className="source-buttons">
          <button className="btn-huge" onClick={() => start('system')} disabled={status === 'starting'}>
            System audio
          </button>
          <button className="btn-huge" onClick={() => start('file')} disabled={status === 'starting'}>
            Audio file
          </button>
          <button className="btn-huge" onClick={() => start('mic')} disabled={status === 'starting'}>
            Microphone
          </button>
        </div>
      ) : (
        <div className="source-buttons">
          <button className="btn-huge" onClick={() => useStore.getState().stopAudio()}>
            Stop
            <small>{sourceType}</small>
          </button>
          <button
            className={`btn-huge ${isRecording ? 'recording' : ''}`}
            onClick={() => useStore.getState().toggleRecording()}
          >
            {isRecording ? 'Stop rec' : 'Record'}
          </button>
        </div>
      )}

      {status === 'starting' && <p className="transport-note">Waiting for permission…</p>}
      {error && <p className="transport-error">{error}</p>}

      <input
        ref={fileRef}
        type="file"
        accept="audio/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void useStore.getState().startAudioFile(f)
          e.target.value = ''
        }}
      />
    </div>
  )
}

/* ---------------------------------------------------------------- sections */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="console-section">
      <h2>{title}</h2>
      {children}
    </section>
  )
}

function SceneGrid() {
  const sceneId = useStore((s) => s.sceneId)
  const pendingSceneId = useStore((s) => s.pendingSceneId)
  const autoPilot = useStore((s) => s.autoPilot)
  return (
    <>
      <div className="tile-grid">
        {SCENES.map((s) => (
          <button
            key={s.id}
            // Two states, because a scene press is not instant: the switch is
            // held for the next downbeat once the incoming scene has warmed.
            // Showing only what is live would leave the operator's press with
            // no feedback for up to a bar, which reads as a dropped input.
            className={`tile ${sceneId === s.id ? 'on' : ''} ${
              pendingSceneId === s.id ? 'pending' : ''
            }`}
            onClick={() => useStore.getState().requestScene(s.id)}
          >
            {s.name}
          </button>
        ))}
      </div>
      <button
        className={`toggle-wide ${autoPilot ? 'on' : ''}`}
        onClick={() => useStore.getState().toggleAutoPilot()}
      >
        Autopilot
        <small>{autoPilot ? 'picking scenes for you' : 'manual'}</small>
      </button>
    </>
  )
}

/**
 * Palettes, grouped by family and shown as their actual five slots.
 *
 * A name is not a colour. The whole reason the palette system is five named
 * slots is that a look is a relationship between them, so the swatch shows all
 * five in their real proportions rather than one representative dot.
 */
function PaletteGrid() {
  const paletteId = useStore((s) => s.paletteId)
  const moodDrive = useStore((s) => s.moodDrive)
  return (
    <>
      <div className="palette-families">
        {PALETTE_FAMILIES.map((family) => (
          <div key={family} className="palette-family">
            <h3>{family}</h3>
            <div className="swatch-row">
              {getPalettesByFamily(family).map((p) => (
                <button
                  key={p.id}
                  className={`swatch ${paletteId === p.id ? 'on' : ''}`}
                  title={p.name}
                  onClick={() => useStore.getState().setPalette(p.id)}
                >
                  <span className="swatch-strip">
                    <i style={{ background: p.slots.bg }} />
                    <i style={{ background: p.slots.shadow }} />
                    <i style={{ background: p.slots.mid }} />
                    <i style={{ background: p.slots.accent }} />
                    <i style={{ background: p.slots.glow }} />
                  </span>
                  <span className="swatch-name">{p.name}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <button
        className={`toggle-wide ${moodDrive ? 'on' : ''}`}
        onClick={() => useStore.getState().toggleMoodDrive()}
      >
        Mood drive
        <small>{moodDrive ? 'mood scales your sliders' : 'sliders as set'}</small>
      </button>
    </>
  )
}

function LookControls() {
  const params = useStore((s) => s.params)
  const quality = useStore((s) => s.quality)
  return (
    <>
      <BigSlider
        label="Intensity"
        value={params.intensity}
        onChange={(v) => useStore.getState().setParam('intensity', v)}
      />
      <BigSlider
        label="Speed"
        value={params.speed}
        onChange={(v) => useStore.getState().setParam('speed', v)}
      />
      <BigSlider
        label="Reactivity"
        value={params.reactivity}
        onChange={(v) => useStore.getState().setParam('reactivity', v)}
      />
      <LayerSlots />

      <div className="quality-row">
        <span className="meter-label">quality</span>
        <div className="segmented">
          {(['auto', 'low', 'medium', 'high'] as const).map((q) => (
            <button
              key={q}
              className={quality === q ? 'on' : ''}
              onClick={() => useStore.getState().setQuality(q)}
            >
              {q}
            </button>
          ))}
        </div>
      </div>
    </>
  )
}

/**
 * The three composition slots, as plain selects.
 *
 * Deliberately not tiles: a layer is picked rarely and read often, and three
 * more grids of sixteen would crowd out the controls that get touched during a
 * set. They cross to the output window on the existing look wire, because
 * `layerSceneIds` is ordinary store state — the output window's SceneManager
 * mounts and budgets them exactly as if they had been chosen there.
 */
function LayerSlots() {
  const layerSceneIds = useStore((s) => s.layerSceneIds)
  return (
    <div className="layer-slots">
      <span className="meter-label">layers</span>
      {LAYER_ROLES.map((role: LayerRole) => (
        <label key={role} className="layer-slot">
          <span>{role}</span>
          <select
            value={layerSceneIds[role] ?? ''}
            onChange={(e) => useStore.getState().setLayer(role, e.target.value || null)}
          >
            <option value="">none</option>
            {SCENES.map((sc) => (
              <option key={sc.id} value={sc.id}>
                {sc.name}
              </option>
            ))}
          </select>
        </label>
      ))}
    </div>
  )
}

/**
 * A slider sized to be hit without looking at it.
 *
 * The value readout is deliberately large and always present: on stage the
 * question is "where is this set", and a handle position does not answer it
 * from a metre away.
 */
function BigSlider({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (v: number) => void
}) {
  return (
    <label className="big-slider">
      <span className="slider-head">
        <span className="slider-label">{label}</span>
        <span className="slider-value">{value.toFixed(2)}</span>
      </span>
      <input
        type="range"
        min={0.2}
        max={2}
        step={0.01}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  )
}

/* -------------------------------------------------------------- plumbing */

/**
 * Poll the output window's telemetry.
 *
 * Polled rather than pushed into React state per packet: at 10 Hz a `setState`
 * per message is fine, but the readouts are the only consumer and re-rendering
 * the whole console for a BPM digit is not. One interval, one state write.
 */
function useTelemetry(): Telemetry | null {
  const [tele, setTele] = useState<Telemetry | null>(null)
  useEffect(() => {
    const id = window.setInterval(() => setTele(readTelemetry()), 100)
    return () => window.clearInterval(id)
  }, [])
  return tele
}

/**
 * Whether the output window is open.
 *
 * There is no event for "the user closed that window", so this is polled. It
 * gates the most important thing on the surface — an operator whose output
 * window has gone needs to know before they wonder why the room went dark.
 */
function useOutputPresence(): boolean {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const id = window.setInterval(() => setOpen(outputIsOpen()), 400)
    return () => window.clearInterval(id)
  }, [])
  return open
}
