import { useCallback, useEffect, useRef, useState } from 'react'
import { SCENES, canHoldRole, getEffectScenes, type SceneDef } from '../scenes'
import { LAYER_ROLES, type LayerRole } from '../store'

/**
 * The scenes a user may pick as the SUBJECT, from this surface.
 *
 * `SCENES` also holds `effect`-role scenes — punctuation `EffectDirector`
 * fires on a musical trigger, pinned as idle entries so a firing costs no
 * shader compile. `requestScene` already refuses them (F180), so a tile here
 * for one would press and do nothing, silently, forever. See `HUD.tsx`'s own
 * `PICKABLE_SCENES`, which this mirrors — the fix landed there first because
 * that surface was the one actually reported broken, and this one carries the
 * identical `SCENES.map` + `requestScene` pattern.
 */
const PICKABLE_SCENES = SCENES.filter((s) => canHoldRole(s.id, 'primary'))

/**
 * The scenes eligible for each composition slot.
 *
 * Derived from the SAME predicate `store.setLayer` guards with, so the picker
 * and the store cannot drift: every tile this surface offers is one the store
 * will accept. That already mattered when these were `<select>`s — an option
 * the store declined sat selected in the dropdown still showing the last
 * ACCEPTED scene, which reads as the click having silently failed — and it
 * matters more as tiles, because a tile that simply never lights is quieter
 * about it still.
 *
 * Written out per role rather than folded over `LAYER_ROLES` so that
 * `Record<LayerRole, …>` makes a new role a compile error here, rather than an
 * empty group that ships.
 */
const layerScenesFor = (role: LayerRole): SceneDef[] =>
  SCENES.filter((sc) => canHoldRole(sc.id, role))

const LAYER_SCENES: Record<LayerRole, SceneDef[]> = {
  background: layerScenesFor('background'),
  accent: layerScenesFor('accent'),
  overlay: layerScenesFor('overlay'),
}

/**
 * The effect scenes — shown here, never offered here.
 *
 * `EffectDirector` fires these on a musical trigger. `requestScene` refuses
 * them outright (F180) and `canHoldRole` refuses them for all three layer
 * roles, so there is no slot on this surface a person could put one in, and
 * they are rendered as inert chips rather than buttons for exactly that reason.
 * They are listed at all because "what is on screen right now" is the question
 * this column now answers, and four scenes that can appear at any moment were
 * answering it nowhere.
 */
const EFFECT_SCENES = getEffectScenes()
import { PALETTE_FAMILIES, getPalettesByFamily } from '../engine/palettes'
import { useStore } from '../store'
import { AnalyticsPanel } from './AnalyticsPanel'
import { DebugPanel } from './DebugPanel'
import { FpsMeter } from './FpsMeter'
import {
  isActiveController,
  requestDetail,
  onMirror,
  openOutput,
  outputIsOpen,
  peerControllerCount,
  readTelemetry,
  sendCommand,
  type Telemetry,
} from '../engine/outputLink'
import { isLensActive, isMirrorActive, LENS_STYLES } from '../engine/opticalRack'
import {
  filterUnusableReason,
  ISF_AUTOFIRE_ENABLED,
  ISF_FILTERS,
  isFilterSelectable,
} from '../engine/isfFilterRoster'
import { resizeAndEncodePhoto } from '../engine/limitlessPhoto'
import { selectableStyles } from '../engine/transitions'
import { DEBUG_POSTFX_KEYS, type DebugPostFx, type DebugPostFxKey } from '../store'

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
      <PassiveBanner />
      <header className="console-top">
        <Mirror />
        <Readouts tele={tele} outputOpen={outputOpen} />
        <Transport status={status} error={error} outputOpen={outputOpen} />
      </header>

      <div className="console-body">
        <Section title="Scene">
          <SceneGrid tele={tele} />
        </Section>
        {/* Shown only while `limitless` is the actual primary — a photo does
            nothing for any other scene, and a drop zone with nowhere to send
            its result reads as broken rather than merely irrelevant. Gated on
            `tele.scene` (the OUTPUT window's real current primary) rather than
            a picker's own last click, so this panel tracks what the audience
            is actually seeing through a crossfade, same as the `pill dim`
            scene readout above. */}
        {tele?.scene === 'limitless' && (
          <Section title="Photo">
            <PhotoDrop />
          </Section>
        )}
        <Section title="Colour">
          <PaletteGrid />
        </Section>
        <Section title="Look">
          <LookControls />
        </Section>
        <Section title="Post FX">
          <PostFx tele={tele} />
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
        {/* The diagnostics sit here rather than floating over the columns: this
            is the one piece of horizontal space in the header that nothing else
            wants. */}
        <Diagnostics />
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
        <AudioHealth tele={tele} />
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
        <button className="btn-huge accent" onClick={() => openOutput({ focus: true })}>
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
          {/* Commands, not local calls. The AudioContext, the MediaRecorder
              and the canvas all live in the output window; this window's copies
              are idle and empty, so calling them here stopped nothing and
              recorded nothing while the button lit up as though it had. */}
          <button className="btn-huge" onClick={() => sendCommand('stop')}>
            Stop
            <small>{sourceType}</small>
          </button>
          <button
            className={`btn-huge ${isRecording ? 'recording' : ''}`}
            onClick={() => sendCommand('toggle-record')}
          >
            {isRecording ? 'Stop rec' : 'Record'}
          </button>
          <button className="btn-huge" onClick={() => sendCommand('screenshot')}>
            Frame
            <small>save PNG</small>
          </button>
        </div>
      )}

      {status === 'starting' && (
        <p className="transport-note">
          Starting…{' '}
          <button className="link-btn" onClick={() => sendCommand('cancel-start')}>
            cancel
          </button>
        </p>
      )}
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

/**
 * Everything that can be on screen at once, in the order it composes.
 *
 * One flat grid of primary-capable scenes used to be the whole section. That
 * grid is right about what it offers — `PICKABLE_SCENES` is the F180 fix and
 * stays — but it is only a fifth of the picture: the roster's `background`-only
 * scenes were reachable solely through three `<select>`s parked in the Look
 * column, and its `effect` scenes were reachable nowhere at all. The show is a
 * stack, so the control for it is a stack too, and each group reports its own
 * slot.
 *
 * ## "Requested" and "live" are two different questions
 *
 * For the subject the store answers both (`sceneId` / `pendingSceneId`). For a
 * layer it answers only the first: `layerSceneIds[role]` is a DESIRE, and
 * between that desire and a lit pixel sit two gates — `resolveLayerIds` can
 * refuse a layer that no longer fits the frame budget, and an admitted layer
 * still mounts invisibly at `dir: 0` until its shader finishes compiling. The
 * doc on `performanceState.mountedLayers` records a session in which 12 of 22
 * layer desires were withdrawn within 20-90 ms having never drawn anything.
 *
 * So the two get two states, and they are the subject grid's existing `on` /
 * `pending` pair rather than a second vocabulary for the same distinction.
 * Collapsing them into one highlight would report a layer as being on screen
 * that the viewer never saw.
 */
function SceneGrid({ tele }: { tele: Telemetry | null }) {
  const sceneId = useStore((s) => s.sceneId)
  const pendingSceneId = useStore((s) => s.pendingSceneId)
  const autoPilot = useStore((s) => s.autoPilot)
  return (
    <>
      <div className="scene-groups">
        <div className="scene-group">
          <h3 className="fx-head">subject</h3>
          <div className="tile-grid">
            {PICKABLE_SCENES.map((s) => (
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
        </div>

        {LAYER_ROLES.map((role: LayerRole) => (
          <LayerGroup key={role} role={role} tele={tele} />
        ))}

        <EffectGroup tele={tele} />
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
 * One composition slot, as tiles.
 *
 * Was a `<select>` in the Look column, on the reasoning that a layer is picked
 * rarely and read often so three more grids would crowd out the controls a set
 * actually touches. Both halves of that turned out to be wrong here: a
 * dropdown is the one control whose current value you cannot read without
 * opening it, and "what is drawing" is precisely what this column is for.
 *
 * Re-selecting the lit tile clears the slot. With the `<select>` gone so is its
 * "none" option, and a layer you cannot turn off is worse than one you cannot
 * turn on — hence the title on every tile saying so, since a second press
 * meaning "off" is not something a tile grid announces on its own.
 */
function LayerGroup({ role, tele }: { role: LayerRole; tele: Telemetry | null }) {
  const requested = useStore((s) => s.layerSceneIds[role])
  const scenes = LAYER_SCENES[role]

  /**
   * What is ACTUALLY drawing here — a fact only the output window has, so it is
   * read off telemetry and not inferred locally. `null` when that window is
   * down: nothing is known to be live then, and a highlight held over from the
   * last packet would be a claim about a renderer that is no longer running.
   *
   * Optional at every step because telemetry is a message from another
   * window's build, not a local object — an output window one deploy behind
   * simply does not send this field.
   */
  const mounted = tele?.mountedLayers?.[role] ?? null

  // A role nothing is authored for gets no control, rather than an empty
  // heading implying there is a choice to be made. Mirrors HUD's own rule.
  if (scenes.length === 0) return null

  // Note and highlight tell the same story: blue is on screen, amber is asked
  // for but unconfirmed. With the output window down only the store's own half
  // is knowable, so it says "requested" and claims nothing about the frame.
  let note = 'empty'
  let noteCls = ''
  if (mounted && requested && mounted !== requested) {
    note = 'swapping'
    noteCls = 'is-pending'
  } else if (mounted) {
    note = 'live'
    noteCls = 'is-live'
  } else if (requested) {
    note = tele ? 'requested · not drawing' : 'requested'
    noteCls = 'is-pending'
  }

  return (
    <div className="scene-group">
      <h3 className="fx-head">
        {role}
        <span className={`scene-group-note ${noteCls}`}>{note}</span>
      </h3>
      <div className="tile-grid">
        {scenes.map((sc) => {
          const live = mounted === sc.id
          const wanted = requested === sc.id
          return (
            <button
              key={sc.id}
              className={`tile ${live ? 'on' : ''} ${wanted && !live ? 'pending' : ''}`}
              title={
                wanted
                  ? `${sc.name} — press again to clear the ${role} slot${
                      live ? '' : tele ? ' · requested, not drawing yet' : ' · output down'
                    }`
                  : live
                    ? `${sc.name} — drawing in ${role}`
                    : `${sc.name} — use as ${role}`
              }
              onClick={() => useStore.getState().setLayer(role, wanted ? null : sc.id)}
            >
              {sc.name}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/**
 * The effect scenes, as a status readout.
 *
 * Chips and not buttons, deliberately. Nothing on this surface can fire one —
 * `EffectDirector` picks them off musical triggers — so a tile here would look
 * pressable and do nothing, forever, which is the failure F180 was and the one
 * `.chip-disabled`'s `pointer-events` note in styles.css is still arguing
 * about. They are `<span>`s: there is no click to swallow, no disabled button
 * to explain, and the only thing they do is light up while they fire.
 */
function EffectGroup({ tele }: { tele: Telemetry | null }) {
  if (EFFECT_SCENES.length === 0) return null
  // Same honesty as the layers: with no telemetry nothing is known to be
  // firing, and an empty list is the truthful answer rather than a stale one.
  const firing = tele?.activeEffects ?? []

  return (
    <div className="scene-group">
      <h3 className="fx-head">
        effects
        <span className={`scene-group-note ${firing.length > 0 ? 'is-live' : ''}`}>
          {tele ? (firing.length > 0 ? `${firing.length} firing` : 'idle') : 'output down'}
        </span>
      </h3>
      <p className="scene-note">Fired by the director on a musical trigger — not hand-picked.</p>
      <div className="tile-grid">
        {EFFECT_SCENES.map((s) => (
          <span
            key={s.id}
            className={`tile tile-status ${firing.includes(s.id) ? 'on' : ''}`}
            title={`${s.name} — punctuation the director fires on a musical trigger; it cannot be picked by hand, and lights here while it fires`}
          >
            {s.name}
          </span>
        ))}
      </div>
    </div>
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

/* --------------------------------------------------------------- limitless */

/**
 * Drop, or pick, the photo the `limitless` scene warps.
 *
 * Only ever mounted while that scene is actually the output's current
 * primary (see `Console()`'s own gate above) — a drop zone with nowhere to
 * send its result would read as broken rather than merely irrelevant.
 *
 * `resizeAndEncodePhoto` does the real work (resize, JPEG, data URL); this
 * component is the drop/pick surface plus the preview and the two failure
 * modes a person can actually hit — a non-image file, and a corrupt one.
 * `busy`/`failed` are local `useState`, deliberately not store state: they
 * describe THIS panel's own in-flight encode, never anything the output
 * window needs to know about, and both self-clear on the next attempt.
 */
function PhotoDrop() {
  const photo = useStore((s) => s.limitlessPhoto)
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  const acceptFile = useCallback((file: File | undefined) => {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setFailed(true)
      return
    }
    setBusy(true)
    setFailed(false)
    resizeAndEncodePhoto(file)
      .then((dataUrl) => {
        useStore.getState().setLimitlessPhoto(dataUrl)
        setBusy(false)
      })
      .catch(() => {
        setBusy(false)
        setFailed(true)
      })
  }, [])

  return (
    <div className="photo-drop-wrap">
      <div
        className={`photo-drop ${dragOver ? 'drag' : ''} ${photo ? 'has-photo' : ''}`}
        role="button"
        tabIndex={0}
        aria-label="Drop a photo, or press Enter to choose one"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            inputRef.current?.click()
          }
        }}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          acceptFile(e.dataTransfer.files[0])
        }}
      >
        {photo ? (
          <img className="photo-drop-preview" src={photo} alt="" />
        ) : (
          <span className="photo-drop-hint">
            {busy ? 'encoding…' : 'drop a photo, or click to choose'}
          </span>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="photo-drop-input"
          onChange={(e) => {
            acceptFile(e.target.files?.[0])
            // Reset so choosing the SAME file twice in a row still fires
            // onChange — the input's own value otherwise short-circuits it.
            e.target.value = ''
          }}
        />
      </div>
      {failed && <small className="photo-drop-error">that file could not be read as an image</small>}
      {photo && (
        <button
          className="toggle-wide"
          onClick={() => {
            setFailed(false)
            useStore.getState().setLimitlessPhoto(null)
          }}
        >
          Clear photo
          <small>back to the generated placeholder</small>
        </button>
      )}
    </div>
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
      {/* The three layer `<select>`s used to sit here. They are tiles in the
          Scene column now, next to the subject grid they compose with — see
          `LayerGroup`. Two controls for one slot is one more than the number
          that can be right. */}

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
        // Blurs rather than doing nothing — see FxSlider's onWheel comment.
        onWheel={(e) => e.currentTarget.blur()}
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

/* ------------------------------------------------------------------ post fx */

/**
 * The post chain, exposed directly.
 *
 * Every value here is normally owned by the directors. Used to sit behind one
 * master switch — `PerformanceStateBridge` copied this whole block over its
 * own output when `enabled` was set, and ignored it entirely otherwise — but
 * that meant dragging ANY one slider froze the other thirteen (nothing else
 * could be half-overridden without first flipping the master on), and a
 * stale `enabled: true` reviving from an older install's `localStorage` (see
 * `debugPostFxOverrides`'s own doc on `AppState`) froze the WHOLE column with
 * no switch anywhere in this UI to notice, let alone flip back off. Now each
 * field checks its OWN override flag, taken the moment its slider/select is
 * touched — see every `setValue` call below — and "Manual post FX (all)" is
 * only the bulk convenience for taking or releasing every field at once.
 *
 * It reaches the output window on the ordinary look wire, because
 * `debugPostFx` is plain store state — `debugPostFxOverrides` is NOT
 * currently mirrored the same way (it is deliberately absent from
 * `outputLink.ts`'s `LOOK_FIELDS`, which this file does not own), so a field
 * overridden from THIS window will not yet reach the output window's copy of
 * `PerformanceStateBridge`. See this session's report for the follow-up.
 */
function PostFx({ tele }: { tele: Telemetry | null }) {
  const fx = useStore((s) => s.debugPostFx)
  const overrides = useStore((s) => s.debugPostFxOverrides)
  // Sets the VALUE and takes manual control of that one field in the same
  // gesture — touching a control IS the act of overriding it, no master
  // switch to flip first. See `DebugPostFx`'s own doc for why those are two
  // separate store calls rather than one.
  const setValue = <K extends DebugPostFxKey>(key: K, value: DebugPostFx[K]) => {
    useStore.getState().setDebugPostFx({ [key]: value } as Partial<DebugPostFx>)
    useStore.getState().setDebugPostFxOverride(key, true)
  }
  const resetField = (key: DebugPostFxKey) => useStore.getState().setDebugPostFxOverride(key, false)
  const allOverridden = DEBUG_POSTFX_KEYS.every((k) => overrides[k])

  return (
    <>
      {/* Filters lead this column, ahead of the override toggle and its
          sliders, because they are the one control here used DURING a show:
          everything below is a manual override you set up and then leave
          alone, while a filter is fired on a moment. Putting them after
          fourteen sliders in a scrolling column would bury the live control
          under the static one. They also sit OUTSIDE the `fx-block` below,
          because a filter fire is not a Post FX override at all — the
          director fires these whether or not anyone is driving the chain by
          hand, and a hand fire is one more flourish through the same queue. */}
      <IsfFilters tele={tele} />
      {/* Live readout of everything below, reported rather than computed for
          the same reason `IsfFilters` above is: this window cannot see
          `performanceState` (it runs in a separate window with no engine at
          all — see outputLink.ts's own header), so a value it did not just
          set by hand can only ever be a fact the output window tells it. */}
      <PostFxLive tele={tele} />

      <button
        className={`toggle-wide ${allOverridden ? 'on' : ''}`}
        onClick={() => useStore.getState().setAllDebugPostFxOverrides(!allOverridden)}
      >
        Manual post FX (all)
        <small>{allOverridden ? 'you are driving everything' : 'directors are driving'}</small>
      </button>

      <div className="fx-block">
        <FxSlider
          label="bloom"
          value={fx.bloom}
          min={0}
          max={2}
          overridden={!!overrides.bloom}
          onChange={(v) => setValue('bloom', v)}
          onReset={() => resetField('bloom')}
        />
        <FxSlider
          label="threshold"
          value={fx.bloomThreshold}
          min={0}
          max={1}
          overridden={!!overrides.bloomThreshold}
          onChange={(v) => setValue('bloomThreshold', v)}
          onReset={() => resetField('bloomThreshold')}
        />
        <FxSlider
          label="glitch"
          value={fx.glitch}
          min={0}
          max={1}
          overridden={!!overrides.glitch}
          onChange={(v) => setValue('glitch', v)}
          onReset={() => resetField('glitch')}
        />
        <FxSlider
          label="vignette"
          value={fx.vignette}
          min={0}
          max={1}
          overridden={!!overrides.vignette}
          onChange={(v) => setValue('vignette', v)}
          onReset={() => resetField('vignette')}
        />
        <FxSlider
          label="fog"
          value={fx.fog}
          min={0}
          max={1}
          overridden={!!overrides.fog}
          onChange={(v) => setValue('fog', v)}
          onReset={() => resetField('fog')}
        />
        <FxSlider
          label="trails"
          value={fx.trails}
          min={0}
          max={1}
          overridden={!!overrides.trails}
          onChange={(v) => setValue('trails', v)}
          onReset={() => resetField('trails')}
        />

        <h3 className="fx-head">mirror</h3>
        {/* `segments` is an integer: 0 off / 1 mirror-x / 2 quad / >=3 n-fold.
            A fractional value between two of those is not a half-way look, it
            is the wrong one.

            No `tiles` or `slice` here — both retired (F108). The engine gates
            them to zero in PerformanceStateBridge regardless of override, so
            leaving the sliders would leave two controls that move and do
            nothing, which is worse than a missing control: it reads as a
            broken renderer rather than as a deliberate absence. */}
        <FxSlider
          label="segments"
          value={fx.mirrorSegments}
          min={0}
          max={12}
          step={1}
          overridden={!!overrides.mirrorSegments}
          onChange={(v) => setValue('mirrorSegments', v)}
          onReset={() => resetField('mirrorSegments')}
        />
        <FxSlider
          label="twist"
          value={fx.mirrorTwist}
          min={-3.14}
          max={3.14}
          overridden={!!overrides.mirrorTwist}
          onChange={(v) => setValue('mirrorTwist', v)}
          onReset={() => resetField('mirrorTwist')}
        />
        <FxSlider
          label="spin"
          value={fx.mirrorSpin}
          min={-2}
          max={2}
          overridden={!!overrides.mirrorSpin}
          onChange={(v) => setValue('mirrorSpin', v)}
          onReset={() => resetField('mirrorSpin')}
        />

        <h3 className="fx-head">lens</h3>
        <FxSlider
          label="amount"
          value={fx.lensAmount}
          min={0}
          max={1}
          overridden={!!overrides.lensAmount}
          onChange={(v) => setValue('lensAmount', v)}
          onReset={() => resetField('lensAmount')}
        />
        <FxSelect
          label="material"
          overridden={!!overrides.lensStyle}
          onReset={() => resetField('lensStyle')}
        >
          <select value={fx.lensStyle} onChange={(e) => setValue('lensStyle', Number(e.target.value))}>
            {LENS_STYLES.map((name, i) => (
              <option key={name} value={i}>
                {name}
              </option>
            ))}
          </select>
        </FxSelect>

        <h3 className="fx-head">transition</h3>
        <FxSelect
          label="next change"
          overridden={!!overrides.transitionStyle}
          onReset={() => resetField('transitionStyle')}
        >
          {/* `selectableStyles()` and not the whole list: `cut` is disabled, and
              offering a style the engine will refuse is worse than not
              offering it. */}
          <select
            value={fx.transitionStyle}
            onChange={(e) => setValue('transitionStyle', e.target.value as DebugPostFx['transitionStyle'])}
          >
            {selectableStyles().map((st) => (
              <option key={st} value={st}>
                {st}
              </option>
            ))}
          </select>
        </FxSelect>
      </div>
    </>
  )
}

/**
 * The ISF post-processing filters: fire one by hand, and see which one is
 * firing.
 *
 * Lives at the top of the Post FX column rather than in a column of its own.
 * A fifth `Section` looked like the obvious home, but `.console-body` is a
 * deliberately FOUR-column grid on widescreen ("Four columns is the widescreen
 * case", console.css) — a fifth wrapped onto a second row and left three
 * quarters of it empty. Same family of control, so it belongs in this column
 * anyway.
 *
 * ## Why the readout comes off telemetry
 *
 * This window renders none of the show and runs no `FilterDirector`, so its
 * `performanceState` is an idle copy that never fires anything (see the note
 * on the mirrored singletons below). What is on screen is a fact only the
 * output window has, so it reports it — the same reasoning `Telemetry.status`
 * already carries. At `TELEMETRY_INTERVAL_MS` (100 ms) a ~3.5 s flourish gets
 * ~35 updates, which is enough for the bar to read as moving rather than
 * stepping.
 */
function IsfFilters({ tele }: { tele: Telemetry | null }) {
  const firing = tele?.filterId ?? null
  const mix = tele?.filterMix ?? 0
  return (
    <>
      <h3 className="fx-head fx-head-first">
        filters{ISF_AUTOFIRE_ENABLED ? '' : ' · autofire off'}
      </h3>
      <div className="tile-grid tile-grid-filters">
        {ISF_FILTERS.map((f) => {
          // Three states, not two, and the difference is the whole point:
          // off-roster is a taste call a person may override by hand, so those
          // stay clickable; unusable is broken on this platform, so those do
          // not, and the title says which it is rather than leaving a dead
          // control to be discovered by clicking it.
          const broken = filterUnusableReason(f.id)
          return (
            <button
              key={f.id}
              className={`tile ${firing === f.id ? 'on' : ''} ${
                broken ? 'tile-broken' : isFilterSelectable(f.id) ? '' : 'tile-off-roster'
              }`}
              disabled={broken !== undefined}
              title={
                (broken
                  ? `${f.id} — unavailable: ${broken}`
                  : isFilterSelectable(f.id)
                    ? f.id
                    : `${f.id} — excluded from autonomous rotation; click to fire it by hand`) +
                (f.credit ? `\n${f.credit}` : '') +
                (f.description ? `\n${f.description}` : '')
              }
              onClick={() => useStore.getState().requestFilter(f.id)}
            >
              {f.id}
            </button>
          )
        })}
      </div>
      <div className="filter-now">
        <span className="filter-now-label">firing</span>
        <span className={`filter-now-name ${firing ? '' : 'dim'}`}>{firing ?? 'nothing'}</span>
        <span className="filter-now-bar">
          <span
            className="filter-now-fill"
            style={{ transform: `scaleX(${Math.max(0, Math.min(1, mix))})` }}
          />
        </span>
        <span className="filter-now-mix">{Math.round(Math.max(0, Math.min(1, mix)) * 100)}%</span>
      </div>
    </>
  )
}

/**
 * Live readout of the rest of the post-fx chain — bloom, chromatic
 * aberration, vignette, fog, feedback trails, the mirror/lens optical racks,
 * and which effect-scene flourish is currently firing.
 *
 * Sibling to `IsfFilters` above and built the same way (an ordinary function
 * component re-rendering on the 10Hz-ish `tele` poll `useTelemetry` already
 * drives — NOT the imperative `requestAnimationFrame`-plus-ref-diffing
 * pattern `FilterIndicator`/`FpsMeter` use in the OUTPUT window's own 60fps
 * render loop; that discipline exists to protect a hot path this component
 * is nowhere near). `isMirrorActive`/`isLensActive` (`engine/opticalRack.ts`)
 * are reused rather than re-derived, so "is it active" can never drift from
 * what the engine itself considers active.
 *
 * Returns `null` before the first telemetry packet arrives, same as
 * `IsfFilters`'s own `tele?.` optional-chaining does implicitly — there is
 * nothing honest to show about a chain this window has not yet heard from.
 */
function PostFxLive({ tele }: { tele: Telemetry | null }) {
  if (!tele) return null

  const mirrorOn = isMirrorActive({
    segments: tele.mirrorSegments,
    tiles: tele.mirrorTiles,
    twist: tele.mirrorTwist,
    slice: tele.mirrorSlice,
    spin: tele.mirrorSpin,
    mix: tele.mirrorMix,
  })
  const lensOn = isLensActive({ amount: tele.lensAmount, style: tele.lensStyle })

  return (
    <div className="fx-live">
      <FxLiveBar label="bloom" value={tele.bloom} max={2} />
      <FxLiveBar label="vignette" value={tele.vignette} max={1} />
      {tele.glitch > 0.01 && <FxLiveBar label="CA" value={tele.glitch} max={1} />}
      {tele.fog > 0.01 && <FxLiveBar label="fog" value={tele.fog} max={1} />}
      {tele.trails > 0.01 && <FxLiveBar label="trails" value={tele.trails} max={1} />}
      {mirrorOn && (
        <div className="fx-live-row">
          <span className="fx-label">mirror</span>
          <span className="fx-live-summary">
            {Math.round(tele.mirrorSegments)}-fold · spin {tele.mirrorSpin.toFixed(2)}
          </span>
        </div>
      )}
      {lensOn && (
        <div className="fx-live-row">
          <span className="fx-label">lens</span>
          <span className="fx-live-summary">{LENS_STYLES[tele.lensStyle] ?? '—'}</span>
        </div>
      )}
      {tele.activeEffects.length > 0 && (
        <div className="fx-live-row">
          <span className="fx-label">fx</span>
          <span className="fx-live-summary">{tele.activeEffects.join(', ')}</span>
        </div>
      )}
    </div>
  )
}

/** One bar row of {@link PostFxLive} — same `.fx-slider` grid columns (see
 *  console.css) so the live readout lines up with the override sliders right
 *  below it, just with a bar/percent in place of a draggable input. */
function FxLiveBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = Math.max(0, Math.min(1, value / max))
  return (
    <div className="fx-live-row">
      <span className="fx-label">{label}</span>
      <span className="fx-live-bar">
        <span className="fx-live-fill" style={{ transform: `scaleX(${pct})` }} />
      </span>
      <span className="fx-value">{Math.round(pct * 100)}%</span>
    </div>
  )
}

/**
 * A compact slider. Same idea as {@link BigSlider} — the number is always
 * visible — at a density that fits fourteen of them in a column.
 *
 * `onWheel` blurs rather than doing nothing: Safari changes a FOCUSED range
 * input's value on mouse-wheel/trackpad scroll instead of letting the scroll
 * reach the section underneath, and the console's densest columns (Colour,
 * Post FX) are exactly where a slider sits under the cursor while scrolling
 * that column. Blurring on the first wheel tick over it hands that and every
 * later tick back to the scrollable section.
 *
 * `overridden`/`onReset` fold the auto/manual indicator into the label
 * itself, rather than adding a fourth element: `.fx-slider` is a fixed
 * three-column grid (label / input / value, see console.css), so a new grid
 * item would either overflow the 42px value column or fall into a stray
 * implicit row. The label already IS the one column with room to spare, and
 * "click the label to let go of what you just took hold of" mirrors the
 * slider gesture that took hold of it in the first place.
 */
function FxSlider({
  label,
  value,
  min,
  max,
  step = 0.01,
  overridden,
  onChange,
  onReset,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  overridden: boolean
  onChange: (v: number) => void
  onReset: () => void
}) {
  return (
    <label className="fx-slider">
      <button
        type="button"
        className="fx-label"
        disabled={!overridden}
        onClick={onReset}
        title={overridden ? `${label} — manual, click to return to auto` : `${label} — auto (director-driven)`}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          font: 'inherit',
          textAlign: 'left',
          cursor: overridden ? 'pointer' : 'default',
          color: overridden ? 'rgba(130, 205, 255, 0.9)' : undefined,
        }}
      >
        {label}
      </button>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onWheel={(e) => e.currentTarget.blur()}
      />
      <span className="fx-value">{step >= 1 ? value.toFixed(0) : value.toFixed(2)}</span>
    </label>
  )
}

/**
 * The `<select>` equivalent of {@link FxSlider}'s auto/manual label.
 *
 * `.fx-select` is a fixed TWO-column grid (label / control, see console.css,
 * and note `.fx-select > span` is a child-combinator rule scoped to a literal
 * `<span>` — turning the label itself into a button here would silently drop
 * that styling). So instead of touching the label, the control column wraps
 * the real `<select>` (passed as `children`, unmodified) together with a
 * small reset chip in a plain flex `<div>` — still exactly one grid item,
 * exactly like the bare `<select>` it replaces.
 */
function FxSelect({
  label,
  overridden,
  onReset,
  children,
}: {
  label: string
  overridden: boolean
  onReset: () => void
  children: React.ReactNode
}) {
  return (
    <label className="fx-select">
      <span>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
        <button
          type="button"
          className={`chip ${overridden ? 'active' : 'chip-disabled'}`}
          style={{ padding: '2px 7px', fontSize: 9, flexShrink: 0 }}
          title={overridden ? `${label} — manual, click to return to auto` : `${label} — auto (director-driven)`}
          onClick={onReset}
        >
          {overridden ? 'manual' : 'auto'}
        </button>
      </div>
    </label>
  )
}

/* -------------------------------------------------------------- arbitration */

/**
 * Say so when this console is not the one driving.
 *
 * Two control windows both publishing means the output takes whichever message
 * landed last, and the show flickers between two people's idea of it. The
 * election is silent and automatic (lowest id wins), so the only thing left to
 * do is tell the person whose controls have quietly stopped mattering.
 */
function PassiveBanner() {
  const [state, setState] = useState({ active: true, peers: 0 })
  useEffect(() => {
    const id = window.setInterval(
      () => setState({ active: isActiveController(), peers: peerControllerCount() }),
      600,
    )
    return () => window.clearInterval(id)
  }, [])
  if (state.active) return null
  return (
    <div className="passive-banner">
      Another console window is driving this output — controls here are inactive.
      {state.peers > 1 && ` (${state.peers} others open)`}
    </div>
  )
}

/* ------------------------------------------------------------- diagnostics */

/**
 * The three operator tools, and the switch that pays for them.
 *
 * They belong on the console rather than the output window for the obvious
 * reason — the output window is what an audience is looking at — but every
 * singleton they read lives over there. So the output window ships those
 * singletons and this window mirrors them into its own idle copies, which is
 * why the panels below are the original components, unmodified.
 *
 * `requestDetail` is what makes that affordable. The packet carries a 512-bin
 * spectrum and two 1024-sample waveforms; for most of a set nobody is looking
 * at any of it, so the output window sends nothing until asked and stops again
 * the moment the last panel closes.
 */
/** Seconds as m:ss, so a running recorder reads as a stopwatch. */
function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${(s / 60) | 0}:${String(s % 60).padStart(2, '0')}`
}

function Diagnostics() {
  const tele = useTelemetry()
  const logging = tele?.logging ?? false
  const logSec = tele?.logSec ?? 0
  const debugOpen = useStore((s) => s.debugOpen)
  const fpsMeter = useStore((s) => s.fpsMeter)
  const analyticsOpen = useStore((s) => s.analyticsOpen)
  const wanted = debugOpen || fpsMeter || analyticsOpen

  useEffect(() => {
    requestDetail(wanted)
    // Asked for again on unmount as `false`: a console that closes without
    // saying so would leave the output window publishing detail to nobody.
    return () => requestDetail(false)
  }, [wanted])

  return (
    <div className="diag-dock">
      <div className="tool-col">
        <button
          className={`tool-btn ${debugOpen ? 'on' : ''}`}
          onClick={() => useStore.getState().toggleDebug()}
        >
          Debug
          <small>spectrum · bands · beat grid</small>
        </button>
        <button
          className={`tool-btn ${fpsMeter ? 'on' : ''}`}
          onClick={() => useStore.getState().toggleFpsMeter()}
        >
          FPS
          <small>frame time · tier · budget</small>
        </button>
        <button
          className={`tool-btn ${analyticsOpen ? 'on' : ''}`}
          onClick={() => useStore.getState().toggleAnalytics()}
        >
          Analytics
          <small>transitions · accuracy</small>
        </button>
        {/* The flight recorder. Unlike the three above it changes nothing about
            what is on screen — it writes down what happened so a diagnosis does
            not depend on a person reading numbers off a panel mid-set. State
            and elapsed time come off telemetry, from the window actually doing
            the recording. */}
        <button
          className={`tool-btn ${logging ? 'on recording' : ''}`}
          onClick={() => sendCommand('toggle-session-log')}
        >
          {logging ? `Recording ${mmss(logSec)}` : 'Session log'}
          <small>{logging ? 'press to stop and save' : 'capture everything'}</small>
        </button>
      </div>

      {wanted && (
        <div className="diag-panels">
          {debugOpen && <DebugPanel />}
          {fpsMeter && <FpsMeter />}
          {analyticsOpen && <AnalyticsPanel />}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------ audio health */

/**
 * Why the output window is silent, when it is.
 *
 * There are two very different silences and they used to look identical from
 * here. **No graph** means the source never arrived — the hand-off failed, or
 * nothing was ever started. **A suspended context** means the source arrived
 * and the browser has not let it start: the output window is opened
 * programmatically, so it can easily have never received a user gesture, and a
 * suspended AudioContext reads as perfect silence with no error anywhere.
 *
 * They need different things from the operator (start a source vs. click the
 * output window once), so the console has to distinguish them rather than
 * showing a flat BPM of 120 and leaving them to guess.
 */
function AudioHealth({ tele }: { tele: Telemetry | null }) {
  if (!tele) return null
  if (tele.audioState === 'suspended') {
    return <span className="pill bad">click the output window to start audio</span>
  }
  if (!tele.hasSource && tele.status === 'running') {
    return <span className="pill warn">output has no audio source</span>
  }
  if (tele.status === 'starting') return <span className="pill warn">output starting…</span>
  if (tele.status === 'error') return <span className="pill bad">output error</span>
  return null
}
