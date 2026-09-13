import { useCallback, useEffect, useRef, useState } from 'react'
import { SCENES, canHoldRole, getEffectScenes, HIDDEN_PICKER_IDS, type SceneDef } from '../scenes'
import { LAYER_ROLES, type LayerRole } from '../store'

/**
 * The scenes a user may pick as the SUBJECT, background, accent, overlay, or
 * see fired as an effect — same derivation the original console and the HUD
 * both use, so a tile here is never one the store would refuse (F180).
 *
 * `HIDDEN_PICKER_IDS` excludes `djcam`: it's primary-capable for the store
 * and the DJ-cam director, but hidden from this grid — its only by-hand
 * entry is the dedicated "Cut to DJ Cam" button in the DJ Cam tab, which
 * calls `store.requestDjCam()` rather than `requestScene`.
 */
const PICKABLE_SCENES = SCENES.filter(
  (s) => canHoldRole(s.id, 'primary') && !HIDDEN_PICKER_IDS.has(s.id),
)
const layerScenesFor = (role: LayerRole): SceneDef[] =>
  SCENES.filter((sc) => canHoldRole(sc.id, role))
const LAYER_SCENES: Record<LayerRole, SceneDef[]> = {
  background: layerScenesFor('background'),
  accent: layerScenesFor('accent'),
  overlay: layerScenesFor('overlay'),
}
const EFFECT_SCENES = getEffectScenes()
import { PALETTE_FAMILIES, getPalettesByFamily } from '../engine/palettes'
import type { ExportPreset } from '../engine/recorder'
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
import { djCamSource } from '../engine/djCamSource'
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
import { SceneParamsPanel } from './SceneParamsPanel'

type RailTab = 'scene' | 'colour' | 'postfx' | 'djcam'

/**
 * The DJ-facing control surface.
 *
 * This window renders nothing of the show — it is a console plus a mirror of
 * the output window's canvas. See engine/outputLink.ts for why the show
 * renders in the other window.
 *
 * Layout: a preview column (what's on screen, and the scene/look controls an
 * operator reaches for constantly) beside a tabbed rail (Scene params /
 * Colour / Post FX / DJ Cam — the controls tuned occasionally, not every few
 * seconds).
 */
export function Console() {
  const tele = useTelemetry()
  const status = useStore((s) => s.status)
  const error = useStore((s) => s.error)
  const sourceType = useStore((s) => s.sourceType)
  const outputOpen = useOutputPresence()
  const [tab, setTab] = useState<RailTab>('scene')

  return (
    <div className="console">
      <PassiveBanner />
      <TopBar tele={tele} outputOpen={outputOpen} sourceType={sourceType} />

      <div className="body">
        <div className="col-preview">
          <PreviewHead tele={tele} />
          <Mirror />
          <StatRow tele={tele} />

          <div className="bottom-row">
            <div className="card">
              <SceneBrowser tele={tele} />
            </div>
            <div className="card">
              <h3>Quick controls</h3>
              <LookControls />
            </div>
            <div className="card">
              <h3>Performance</h3>
              <PerformanceStats tele={tele} />
            </div>
          </div>
        </div>

        <div className="col-rail">
          <div className="tabs">
            <button className={`tab ${tab === 'scene' ? 'active' : ''}`} onClick={() => setTab('scene')}>
              Scene
            </button>
            <button className={`tab ${tab === 'colour' ? 'active' : ''}`} onClick={() => setTab('colour')}>
              Colour
            </button>
            <button className={`tab ${tab === 'postfx' ? 'active' : ''}`} onClick={() => setTab('postfx')}>
              Post FX
            </button>
            <button className={`tab ${tab === 'djcam' ? 'active' : ''}`} onClick={() => setTab('djcam')}>
              DJ Cam
            </button>
          </div>

          <div className="rail-scroll">
            {tab === 'scene' && (
              <>
                <div className="card">
                  <h3>Params</h3>
                  <SceneParamsPanel />
                </div>
                {/* Only while `limitless` is the actual primary — see PhotoDrop's
                    own doc for why a drop zone with nowhere to send its result
                    would read as broken rather than merely irrelevant. */}
                {tele?.scene === 'limitless' && (
                  <div className="card">
                    <h3>Photo</h3>
                    <PhotoDrop />
                  </div>
                )}
              </>
            )}

            {tab === 'colour' && (
              <div className="card">
                <PaletteGrid />
              </div>
            )}

            {tab === 'postfx' && (
              <div className="card">
                <h3>Post FX</h3>
                <PostFx tele={tele} />
              </div>
            )}

            {tab === 'djcam' && (
              <div className="card">
                <DjCam tele={tele} />
              </div>
            )}
          </div>
        </div>
      </div>

      <Transport status={status} error={error} outputOpen={outputOpen} />
    </div>
  )
}

/* ------------------------------------------------------------------ mirror */

/**
 * The output window's own canvas, as a video — `captureStream()` off the
 * canvas that already drew the frame, not a second renderer.
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

function PreviewHead({ tele }: { tele: Telemetry | null }) {
  const sceneName = tele?.scene ? (SCENES.find((s) => s.id === tele.scene)?.name ?? tele.scene) : 'No scene selected'
  return (
    <div className="preview-head">
      <span className="name">{sceneName}</span>
      <span className="badge-ar">16:9</span>
    </div>
  )
}

function StatRow({ tele }: { tele: Telemetry | null }) {
  const fps = tele && tele.frameMs > 0 ? 1000 / tele.frameMs : 0
  return (
    <div className="stat-row">
      <span>
        <span className="sdot" style={!tele ? { background: 'rgba(var(--cream-rgb), 0.3)' } : undefined} />
        fps {fps > 0 ? fps.toFixed(0) : '--'}
      </span>
      {tele && <span>tier {tele.tier}</span>}
      {tele && (
        <span style={tele.frameMs > 20 ? { color: 'var(--cream)', textShadow: '0 0 8px rgba(var(--maroon-rgb), 0.9)' } : undefined}>
          {tele.frameMs > 0 ? `${tele.frameMs.toFixed(1)} ms` : '--'}
        </span>
      )}
      {tele && <span style={{ color: 'var(--text-dimmer)' }}>{tele.scene}</span>}
    </div>
  )
}

/* ---------------------------------------------------------------- top bar */

function TopBar({
  tele,
  outputOpen,
  sourceType,
}: {
  tele: Telemetry | null
  outputOpen: boolean
  sourceType: string | null
}) {
  const status = useStore((s) => s.status)
  const bpm = tele ? Math.round(tele.bpm) : 0
  const beat = tele ? tele.beatInBar : -1
  const running = status === 'running'

  return (
    <header className="topbar">
      <span className="word">AudioVis</span>

      <div className="signal-chip">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <path d="M3 12h3l2-7 4 14 2-9 2 5h5" />
        </svg>
        <div>
          <div className="label">{running ? sourceType : 'No source'}</div>
          <div className="sub">{running ? 'running' : 'select an input below'}</div>
        </div>
      </div>

      <div className="topbar-spacer" />

      <span className={`pill2 ${outputOpen && tele ? 'good' : 'bad'}`}>
        <span className="dot" />
        {outputOpen && tele ? 'output live' : 'output down'}
      </span>
      <AudioHealth tele={tele} />
      <span className={`mood-pill mood-${tele?.mood ?? 'silence'}`}>{tele?.mood ?? 'idle'}</span>

      <div className="bpm-chip">
        <b>{bpm || '--'}</b>
        <span>BPM</span>
      </div>
      <div className="beat-row2" aria-label="beat in bar">
        {[0, 1, 2, 3].map((i) => (
          <i key={i} className={`${i === beat ? 'on' : ''} ${i === 0 ? 'down' : ''}`} />
        ))}
      </div>

      <Diagnostics />
    </header>
  )
}

/* ---------------------------------------------------------------- scene */

type SceneCategory = LayerRole | 'subject' | 'effects'

/**
 * The tile browser: subject / background / accent / overlay / effects, one
 * category shown at a time behind filter chips. Everything it renders is the
 * SAME `PICKABLE_SCENES`/`LAYER_SCENES`/`EFFECT_SCENES` derivation and the
 * same `requestScene`/`setLayer` actions the original always-visible column
 * used — only the "show one group at a time" browsing is new.
 */
function SceneBrowser({ tele }: { tele: Telemetry | null }) {
  const autoPilot = useStore((s) => s.autoPilot)
  const [category, setCategory] = useState<SceneCategory>('subject')

  const categories = (
    [
      { id: 'subject' as const, label: 'Subject', count: PICKABLE_SCENES.length },
      ...LAYER_ROLES.filter((r) => LAYER_SCENES[r].length > 0).map((r) => ({
        id: r,
        label: r[0].toUpperCase() + r.slice(1),
        count: LAYER_SCENES[r].length,
      })),
      { id: 'effects' as const, label: 'Effects', count: EFFECT_SCENES.length },
    ] satisfies { id: SceneCategory; label: string; count: number }[]
  ).filter((c) => c.count > 0)

  return (
    <>
      <h3>Scene</h3>
      <div className="filters">
        {categories.map((c) => (
          <button
            key={c.id}
            className={`fchip ${category === c.id ? 'active' : ''}`}
            onClick={() => setCategory(c.id)}
          >
            {c.label}
            <span className="cnt">{c.count}</span>
          </button>
        ))}
      </div>

      {category === 'subject' && <SubjectTiles />}
      {category !== 'subject' && category !== 'effects' && <LayerTiles role={category} tele={tele} />}
      {category === 'effects' && <EffectTiles tele={tele} />}

      <button
        className={`wide-toggle ${autoPilot ? 'on' : ''}`}
        onClick={() => useStore.getState().toggleAutoPilot()}
      >
        Autopilot
        <small>{autoPilot ? 'picking scenes for you' : 'manual'}</small>
      </button>
    </>
  )
}

/**
 * Page a list without scrolling it — the operator's own request: everything
 * should be reachable behind a click, never behind a scrollbar (which, on
 * this rig, effectively never fires inside a nested panel anyway).
 */
function usePager(total: number, pageSize: number) {
  const [page, setPage] = useState(0)
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const clamped = Math.min(page, pageCount - 1)
  return { page: clamped, pageCount, setPage, start: clamped * pageSize, end: clamped * pageSize + pageSize }
}

function Pager({ page, pageCount, onChange }: { page: number; pageCount: number; onChange: (p: number) => void }) {
  if (pageCount <= 1) return null
  return (
    <div className="pager">
      <button className="pager-btn" disabled={page === 0} onClick={() => onChange(page - 1)} aria-label="Previous page">
        ‹
      </button>
      <span className="pager-label">
        {page + 1} / {pageCount}
      </span>
      <button
        className="pager-btn"
        disabled={page === pageCount - 1}
        onClick={() => onChange(page + 1)}
        aria-label="Next page"
      >
        ›
      </button>
    </div>
  )
}

function SubjectTiles() {
  const sceneId = useStore((s) => s.sceneId)
  const pendingSceneId = useStore((s) => s.pendingSceneId)
  const { page, pageCount, setPage, start, end } = usePager(PICKABLE_SCENES.length, 12)
  return (
    <>
      <div className="tile-grid">
        {PICKABLE_SCENES.slice(start, end).map((s) => (
          <button
            key={s.id}
            className={`tile ${sceneId === s.id ? 'on' : ''} ${pendingSceneId === s.id ? 'pending' : ''}`}
            onClick={() => useStore.getState().requestScene(s.id)}
          >
            {s.name}
          </button>
        ))}
      </div>
      <Pager page={page} pageCount={pageCount} onChange={setPage} />
    </>
  )
}

/**
 * One composition slot. "Requested" (the store's desire) and "live" (what
 * telemetry says is actually mounted) are different questions — see the
 * original SceneGrid's own doc on `performanceState.mountedLayers` for why a
 * layer desire can be withdrawn without ever drawing anything.
 */
function LayerTiles({ role, tele }: { role: LayerRole; tele: Telemetry | null }) {
  const requested = useStore((s) => s.layerSceneIds[role])
  const scenes = LAYER_SCENES[role]
  const mounted = tele?.mountedLayers?.[role] ?? null
  const { page, pageCount, setPage, start, end } = usePager(scenes.length, 12)

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
    <>
      <p className={`scene-note ${noteCls}`}>{note}</p>
      <div className="tile-grid">
        {scenes.slice(start, end).map((sc) => {
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
      <Pager page={page} pageCount={pageCount} onChange={setPage} />
    </>
  )
}

/**
 * Effect scenes: shown, never pressed. `EffectDirector` fires these on a
 * musical trigger — a tile here would look pressable and do nothing (F180).
 */
function EffectTiles({ tele }: { tele: Telemetry | null }) {
  const firing = tele?.activeEffects ?? []
  const { page, pageCount, setPage, start, end } = usePager(EFFECT_SCENES.length, 12)
  return (
    <>
      <p className="scene-note">
        Fired by the director on a musical trigger — not hand-picked. ·{' '}
        {tele ? (firing.length > 0 ? `${firing.length} firing` : 'idle') : 'output down'}
      </p>
      <div className="tile-grid">
        {EFFECT_SCENES.slice(start, end).map((s) => (
          <span
            key={s.id}
            className={`tile tile-status ${firing.includes(s.id) ? 'on' : ''}`}
            title={`${s.name} — punctuation the director fires on a musical trigger; it cannot be picked by hand, and lights here while it fires`}
          >
            {s.name}
          </span>
        ))}
      </div>
      <Pager page={page} pageCount={pageCount} onChange={setPage} />
    </>
  )
}

/* ---------------------------------------------------------------- colour */

/**
 * Palette swatches, one FAMILY at a time behind filter chips — the real
 * roster (30 palettes across 5 families; see engine/palettes.ts's own doc on
 * why `PaletteFamily` exists: "lets a picker of thirty palettes stay
 * legible"). Same swatch-shows-all-five-slots reasoning as before: a name is
 * not a colour, so the strip shows the real proportions.
 */
function PaletteGrid() {
  const paletteId = useStore((s) => s.paletteId)
  const moodDrive = useStore((s) => s.moodDrive)
  const [family, setFamily] = useState(PALETTE_FAMILIES[0])
  const familyPalettes = getPalettesByFamily(family)
  const { page, pageCount, setPage, start, end } = usePager(familyPalettes.length, 6)

  return (
    <>
      <h3>Colour</h3>
      <div className="filters">
        {PALETTE_FAMILIES.map((f) => (
          <button
            key={f}
            className={`fchip ${family === f ? 'active' : ''}`}
            onClick={() => {
              setFamily(f)
              setPage(0)
            }}
          >
            {f[0].toUpperCase() + f.slice(1)}
            <span className="cnt">{getPalettesByFamily(f).length}</span>
          </button>
        ))}
      </div>
      <div className="gel-row">
        {familyPalettes.slice(start, end).map((p) => (
          <button
            key={p.id}
            className={`gel ${paletteId === p.id ? 'on' : ''}`}
            title={p.name}
            onClick={() => useStore.getState().setPalette(p.id)}
          >
            <span className="gel-strip">
              <i style={{ background: p.slots.bg, flex: 1.4 }} />
              <i style={{ background: p.slots.shadow }} />
              <i style={{ background: p.slots.mid }} />
              <i style={{ background: p.slots.accent, flex: 1.3 }} />
              <i style={{ background: p.slots.glow, flex: 1.3 }} />
            </span>
            <span className="gel-name">{p.name}</span>
          </button>
        ))}
      </div>
      <Pager page={page} pageCount={pageCount} onChange={setPage} />
      <button
        className={`wide-toggle ${moodDrive ? 'on' : ''}`}
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
 * Drop, or pick, the photo the `limitless` scene warps. Only ever mounted
 * while that scene is actually the output's current primary (gated in
 * `Console()` above) — a drop zone with nowhere to send its result would
 * read as broken rather than merely irrelevant.
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
          <span className="photo-drop-hint">{busy ? 'encoding…' : 'drop a photo, or click to choose'}</span>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="photo-drop-input"
          onChange={(e) => {
            acceptFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      </div>
      {failed && <small className="photo-drop-error">that file could not be read as an image</small>}
      {photo && (
        <button
          className="wide-toggle"
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

/* ------------------------------------------------------------------- look */

function LookControls() {
  const params = useStore((s) => s.params)
  const quality = useStore((s) => s.quality)
  return (
    <>
      <QcSlider label="Intensity" value={params.intensity} onChange={(v) => useStore.getState().setParam('intensity', v)} />
      <QcSlider label="Speed" value={params.speed} onChange={(v) => useStore.getState().setParam('speed', v)} />
      <QcSlider label="Reactivity" value={params.reactivity} onChange={(v) => useStore.getState().setParam('reactivity', v)} />
      <div className="quality-row">
        <span className="meter-label">quality</span>
        <div className="segmented">
          {(['auto', 'low', 'medium', 'high'] as const).map((q) => (
            <button key={q} className={quality === q ? 'on' : ''} onClick={() => useStore.getState().setQuality(q)}>
              {q}
            </button>
          ))}
        </div>
      </div>
    </>
  )
}

/** Same range as the original BigSlider (0.2..2), same onWheel-blur guard. */
function QcSlider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="qc-row">
      <span className="lbl">{label}</span>
      <input
        type="range"
        min={0.2}
        max={2}
        step={0.01}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onWheel={(e) => e.currentTarget.blur()}
      />
      <span className="val">{value.toFixed(2)}</span>
    </label>
  )
}

/* ------------------------------------------------------------- performance */

function PerformanceStats({ tele }: { tele: Telemetry | null }) {
  if (!tele) return <p className="param-note">output down — no performance data</p>
  const fps = tele.frameMs > 0 ? 1000 / tele.frameMs : 0
  return (
    <div className="perf-stats">
      <div className="perf-stat">
        <span>FPS</span>
        <b>{fps > 0 ? fps.toFixed(0) : '--'}</b>
      </div>
      <div className="perf-stat">
        <span>Tier</span>
        <b>{tele.tier}</b>
      </div>
      <div className={`perf-stat ${tele.frameMs > 20 ? 'warn' : ''}`}>
        <span>Frame time</span>
        <b>{tele.frameMs > 0 ? `${tele.frameMs.toFixed(1)} ms` : '--'}</b>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- dj cam --- */

/**
 * DJ Cam — punch to a live camera of the DJ, and see when the cutaway is up.
 *
 * The **fire** is a request on the cross-window wire: `requestDjCam()` sets
 * `pendingDjCam`, and `DjCamDirector` in the OUTPUT window consumes it and
 * commits the cutaway — a `djcam` takeover has to go through the director
 * that owns the hard-cut in, the scene-owned dip out, the exposure freeze
 * and the suppression of the other directors. The **readout** — `Cut to DJ
 * Cam` <-> `Return to scenes` — comes off `tele.djCamActive`, not a local
 * guess: whether `djcam` is the scene on screen is a fact only the window
 * running the show has.
 *
 * The auto toggle (`djCamEnabled`) governs the AUTOMATIC trigger alone. A
 * hand punch works with it off — the operator is asking explicitly — exactly
 * as `FilterDirector` still fires a hand pick with `ISF_AUTOFIRE_ENABLED`
 * false.
 *
 * The camera is acquired HERE, inside the operator's click, and handed to
 * the output window by direct reference: a freshly opened output window has
 * no user activation to call `getUserMedia` with — the same constraint that
 * puts audio acquisition in this window. See engine/djCamSource.ts.
 */
function DjCam({ tele }: { tele: Telemetry | null }) {
  const enabled = useStore((s) => s.djCamEnabled)
  const deviceId = useStore((s) => s.djCamDeviceId)
  const devices = useStore((s) => s.djCamDevices)
  const active = tele?.djCamActive ?? false

  // `djCamSource` is a plain module singleton — no store, no subscription,
  // the same posture as `performanceState`. Poll it so the punch button's
  // disabled state and the error line track the real stream rather than a
  // stale copy.
  const [ready, setReady] = useState(false)
  const [srcError, setSrcError] = useState<string | null>(null)
  useEffect(() => {
    const poll = () => {
      setReady(djCamSource.ready)
      setSrcError(djCamSource.status.error)
    }
    poll()
    const id = window.setInterval(poll, 250)
    return () => window.clearInterval(id)
  }, [])

  // The device list only carries real labels once a camera permission has
  // been granted, so refresh on mount and again after every acquire.
  useEffect(() => {
    void useStore.getState().refreshDjCamDevices()
  }, [])

  const connect = useCallback(() => {
    void djCamSource
      .acquire(useStore.getState().djCamDeviceId ?? undefined)
      .then(() => useStore.getState().refreshDjCamDevices())
      .catch(() => {})
  }, [])

  return (
    <>
      <h3>DJ Cam{enabled ? '' : ' · autofire off'}</h3>

      <DjCamPreview />

      <button
        className={`punch-btn ${active ? 'on' : ''}`}
        disabled={!ready}
        title={
          ready
            ? active
              ? 'cut back to the scene rotation now'
              : 'punch to the live camera now — ignores the auto cooldown and warm-up'
            : 'connect a camera first'
        }
        onClick={() => useStore.getState().requestDjCam()}
      >
        {active ? 'Return to scenes' : 'Cut to DJ Cam'}
        <small>{ready ? (active ? 'cutaway is live' : 'manual punch') : 'no camera connected'}</small>
      </button>

      <div className="setup-row">
        <button className="btn3" onClick={connect}>
          {ready ? 'Reconnect camera' : 'Connect camera'}
        </button>
        {devices.length > 0 ? (
          <select
            className="sel3"
            value={deviceId ?? ''}
            onChange={(e) => useStore.getState().setDjCamDevice(e.target.value)}
          >
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="sel3">no device</span>
        )}
      </div>

      <button
        className={`wide-toggle ${enabled ? 'on' : ''}`}
        onClick={() => useStore.getState().toggleDjCam()}
      >
        DJ Cam autofire
        <small>{enabled ? 'director cuts away on a rare big drop' : 'manual punch only'}</small>
      </button>

      {srcError && <p className="djcam-note error">{srcError}</p>}
    </>
  )
}

/**
 * A live thumbnail of the camera the DJ will be cut to.
 *
 * Pointed at the stream `djCamSource` holds on its own shared `<video>`
 * rather than at the output canvas. A second sink on one `MediaStream` costs
 * nothing, so the DJ can frame the shot with the cutaway down. Polled, not
 * subscribed, for the same reason the parent is.
 */
function DjCamPreview() {
  const ref = useRef<HTMLVideoElement>(null)
  const [live, setLive] = useState(false)

  useEffect(() => {
    const sync = () => {
      const v = ref.current
      if (!v) return
      const stream = (djCamSource.video.srcObject as MediaStream | null) ?? null
      if (v.srcObject !== stream) {
        v.srcObject = stream
        if (stream) void v.play().catch(() => {})
      }
      setLive(djCamSource.ready)
    }
    sync()
    const id = window.setInterval(sync, 250)
    return () => window.clearInterval(id)
  }, [])

  return (
    <div className={`cam-preview ${live ? 'live' : ''}`}>
      <video ref={ref} autoPlay muted playsInline />
      {!live && <span className="cam-empty">no camera</span>}
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
  const exportPreset = useStore((s) => s.exportPreset)
  const fileRef = useRef<HTMLInputElement>(null)
  const running = status === 'running'

  /** One gesture opens the output window and acquires the source — see the
   *  original Transport's own doc: a popup needs a user gesture, and so does
   *  a capture prompt, so they cannot be separated into two clicks. */
  const start = useCallback((kind: 'system' | 'mic' | 'file') => {
    openOutput()
    if (kind === 'file') fileRef.current?.click()
    else void useStore.getState().startAudio(kind)
  }, [])

  return (
    <div className="transport-bar">
      {!outputOpen && (
        <button className="tbtn2 accent" onClick={() => openOutput({ focus: true })}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="13" rx="2" />
            <path d="M8 21h8M12 17v4" />
          </svg>
          Open output window
        </button>
      )}
      {!running ? (
        <>
          <button className="tbtn2" onClick={() => start('system')} disabled={status === 'starting'}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v12M6 9l6-6 6 6M5 21h14" />
            </svg>
            System audio
          </button>
          <button className="tbtn2" onClick={() => start('file')} disabled={status === 'starting'}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
              <path d="M14 2v6h6" />
            </svg>
            Audio file
          </button>
          <button className="tbtn2" onClick={() => start('mic')} disabled={status === 'starting'}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="2" width="6" height="12" rx="3" />
              <path d="M5 10a7 7 0 0014 0M12 19v3" />
            </svg>
            Microphone
          </button>
        </>
      ) : (
        <>
          {/* Commands, not local calls — the AudioContext, MediaRecorder and
              canvas all live in the OUTPUT window; see the original's own doc. */}
          <button className="tbtn2" onClick={() => sendCommand('stop')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
            Stop
            <small>{sourceType}</small>
          </button>
          <button className={`tbtn2 ${isRecording ? 'recording' : ''}`} onClick={() => sendCommand('toggle-record')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="12" r="7" />
            </svg>
            {isRecording ? 'Stop rec' : 'Record'}
          </button>
          <select
            className="sel3"
            value={exportPreset}
            disabled={isRecording}
            title="Export shape for the next recording"
            onChange={(e) =>
              useStore.getState().setExportPreset(e.target.value as ExportPreset)
            }
          >
            <option value="native">Native (current view)</option>
            <option value="9:16">9:16 — Reels / TikTok / Stories</option>
            <option value="1:1">1:1 — IG feed</option>
            <option value="16:9">16:9 — YouTube</option>
            <option value="4:5">4:5 — IG portrait feed</option>
          </select>
          <button className="tbtn2" onClick={() => sendCommand('screenshot')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 7h3l2-3h6l2 3h3v12H4z" />
              <circle cx="12" cy="13" r="3.5" />
            </svg>
            Frame
            <small>save PNG</small>
          </button>
        </>
      )}

      {status === 'starting' && (
        <p className="transport-note">
          Starting…{' '}
          <button
            className="link-btn"
            onClick={() => {
              // Two resets, not one — see the original Transport's own doc:
              // `sendCommand` tears down the OUTPUT window's real state, but
              // this window's own "Starting…" card is driven by its own
              // `status`, which that command never touches.
              sendCommand('cancel-start')
              useStore.getState().cancelStartAudio()
            }}
          >
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

/* -------------------------------------------------------------- plumbing */

/** Poll the output window's telemetry — see the original's own doc on why
 *  this is polled rather than pushed into React state per packet. */
function useTelemetry(): Telemetry | null {
  const [tele, setTele] = useState<Telemetry | null>(null)
  useEffect(() => {
    const id = window.setInterval(() => setTele(readTelemetry()), 100)
    return () => window.clearInterval(id)
  }, [])
  return tele
}

/** Whether the output window is open — polled; there is no close event. */
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
 * The post chain, exposed directly. Every field checks its OWN override flag
 * taken the moment its slider/select is touched — see the original's own doc
 * on why a single master switch froze the whole column for anyone reviving a
 * stale `enabled: true` from localStorage.
 */
function PostFx({ tele }: { tele: Telemetry | null }) {
  const fx = useStore((s) => s.debugPostFx)
  const overrides = useStore((s) => s.debugPostFxOverrides)
  const setValue = <K extends DebugPostFxKey>(key: K, value: DebugPostFx[K]) => {
    useStore.getState().setDebugPostFx({ [key]: value } as Partial<DebugPostFx>)
    useStore.getState().setDebugPostFxOverride(key, true)
  }
  const resetField = (key: DebugPostFxKey) => useStore.getState().setDebugPostFxOverride(key, false)
  const allOverridden = DEBUG_POSTFX_KEYS.every((k) => overrides[k])

  return (
    <>
      {/* ISF filters scoped to Limitless (FilterDirector.tsx's own gate) —
          same reasoning PhotoDrop's gate above gives. */}
      {tele?.scene === 'limitless' && <IsfFilters tele={tele} />}
      <PostFxLive tele={tele} />

      <button
        className={`wide-toggle ${allOverridden ? 'on' : ''}`}
        onClick={() => useStore.getState().setAllDebugPostFxOverrides(!allOverridden)}
      >
        Manual post FX (all)
        <small>{allOverridden ? 'you are driving everything' : 'directors are driving'}</small>
      </button>

      <div className="fx-block">
        <FxSlider label="bloom" value={fx.bloom} min={0} max={2} overridden={!!overrides.bloom} onChange={(v) => setValue('bloom', v)} onReset={() => resetField('bloom')} />
        <FxSlider label="threshold" value={fx.bloomThreshold} min={0} max={1} overridden={!!overrides.bloomThreshold} onChange={(v) => setValue('bloomThreshold', v)} onReset={() => resetField('bloomThreshold')} />
        <FxSlider label="glitch" value={fx.glitch} min={0} max={1} overridden={!!overrides.glitch} onChange={(v) => setValue('glitch', v)} onReset={() => resetField('glitch')} />
        <FxSlider label="vignette" value={fx.vignette} min={0} max={1} overridden={!!overrides.vignette} onChange={(v) => setValue('vignette', v)} onReset={() => resetField('vignette')} />
        <FxSlider label="fog" value={fx.fog} min={0} max={1} overridden={!!overrides.fog} onChange={(v) => setValue('fog', v)} onReset={() => resetField('fog')} />
        <FxSlider label="trails" value={fx.trails} min={0} max={1} overridden={!!overrides.trails} onChange={(v) => setValue('trails', v)} onReset={() => resetField('trails')} />
        <FxSlider label="echo" value={fx.echo} min={0} max={1} overridden={!!overrides.echo} onChange={(v) => setValue('echo', v)} onReset={() => resetField('echo')} />

        <h4 className="fx-head">mirror</h4>
        <FxSlider label="segments" value={fx.mirrorSegments} min={0} max={12} step={1} overridden={!!overrides.mirrorSegments} onChange={(v) => setValue('mirrorSegments', v)} onReset={() => resetField('mirrorSegments')} />
        <FxSlider label="twist" value={fx.mirrorTwist} min={-3.14} max={3.14} overridden={!!overrides.mirrorTwist} onChange={(v) => setValue('mirrorTwist', v)} onReset={() => resetField('mirrorTwist')} />
        <FxSlider label="spin" value={fx.mirrorSpin} min={-2} max={2} overridden={!!overrides.mirrorSpin} onChange={(v) => setValue('mirrorSpin', v)} onReset={() => resetField('mirrorSpin')} />

        <h4 className="fx-head">lens</h4>
        <FxSlider label="amount" value={fx.lensAmount} min={0} max={1} overridden={!!overrides.lensAmount} onChange={(v) => setValue('lensAmount', v)} onReset={() => resetField('lensAmount')} />
        <FxSelect label="material" overridden={!!overrides.lensStyle} onReset={() => resetField('lensStyle')}>
          <select value={fx.lensStyle} onChange={(e) => setValue('lensStyle', Number(e.target.value))}>
            {LENS_STYLES.map((name, i) => (
              <option key={name} value={i}>
                {name}
              </option>
            ))}
          </select>
        </FxSelect>

        <h4 className="fx-head">transition</h4>
        <FxSelect label="next change" overridden={!!overrides.transitionStyle} onReset={() => resetField('transitionStyle')}>
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

/** ISF post-processing filters: fire one by hand, and see which one is firing. */
function IsfFilters({ tele }: { tele: Telemetry | null }) {
  const firing = tele?.filterId ?? null
  const mix = tele?.filterMix ?? 0
  return (
    <>
      <h4 className="fx-head fx-head-first">filters{ISF_AUTOFIRE_ENABLED ? '' : ' · autofire off'}</h4>
      <div className="pad-grid2">
        {ISF_FILTERS.map((f) => {
          const broken = filterUnusableReason(f.id)
          return (
            <button
              key={f.id}
              className={`pad2 ${firing === f.id ? 'on' : ''} ${
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
      <div className="firing-row">
        <span className="firing-label">firing</span>
        <span className={`fname ${firing ? '' : 'dim'}`}>{firing ?? 'nothing'}</span>
        <span className="fbar">
          <span className="ffill" style={{ transform: `scaleX(${Math.max(0, Math.min(1, mix))})` }} />
        </span>
        <span className="fpct">{Math.round(Math.max(0, Math.min(1, mix)) * 100)}%</span>
      </div>
    </>
  )
}

/** Live readout of the rest of the post-fx chain, reported off telemetry —
 *  this window runs no FilterDirector/PerformanceStateBridge of its own. */
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
      {tele.echo > 0.01 && <FxLiveBar label="echo" value={tele.echo} max={1} />}
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
 * A compact override slider. `onWheel` blurs rather than doing nothing — see
 * the original's own doc on Safari changing a focused range input's value on
 * wheel/trackpad scroll. Clicking the label takes/releases manual control —
 * unchanged interaction from the original FxSlider.
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
          // Colour comes from `.fx-slider .fx-label:not(:disabled)` in
          // console.css (crimson) — not set here, so it can't drift out of
          // sync with the rest of the "on/manual" palette.
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

/** The `<select>` equivalent of {@link FxSlider}'s auto/manual label. */
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

/** Say so when this console is not the one driving the output. */
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

/** Seconds as m:ss, so a running recorder reads as a stopwatch. */
function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${(s / 60) | 0}:${String(s % 60).padStart(2, '0')}`
}

/**
 * The three operator tools plus the session log, as an icon row. Docked
 * panels drop from the row rather than floating over the console. See the
 * original's own doc on `requestDetail` — the output window sends spectrum/
 * waveform detail only while a panel here actually wants it.
 */
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
    return () => requestDetail(false)
  }, [wanted])

  return (
    <div className="icon-row">
      <button
        className={`icon-btn ${debugOpen ? 'on' : ''}`}
        title="Debug — spectrum · bands · beat grid"
        onClick={() => useStore.getState().toggleDebug()}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <line x1="4" y1="18" x2="4" y2="10" />
          <line x1="9" y1="18" x2="9" y2="6" />
          <line x1="14" y1="18" x2="14" y2="12" />
          <line x1="19" y1="18" x2="19" y2="8" />
        </svg>
      </button>
      <button
        className={`icon-btn ${fpsMeter ? 'on' : ''}`}
        title="FPS — frame time · tier · budget"
        onClick={() => useStore.getState().toggleFpsMeter()}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 16a8 8 0 1116 0" />
          <line x1="12" y1="16" x2="15" y2="11" />
        </svg>
      </button>
      <button
        className={`icon-btn ${analyticsOpen ? 'on' : ''}`}
        title="Analytics — transitions · accuracy"
        onClick={() => useStore.getState().toggleAnalytics()}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4,15 9,9 13,12 20,5" />
        </svg>
      </button>
      <button
        className={`icon-btn ${logging ? 'on recording' : ''}`}
        title={logging ? `Recording ${mmss(logSec)} — press to stop and save` : 'Session log — capture everything'}
        onClick={() => sendCommand('toggle-session-log')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="12" r="7" />
          <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
        </svg>
      </button>

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
 * Why the output window is silent, when it is — a suspended AudioContext and
 * "no source ever arrived" need different things from the operator, so this
 * distinguishes them rather than leaving a flat BPM of 0 to interpret.
 */
function AudioHealth({ tele }: { tele: Telemetry | null }) {
  if (!tele) return null
  if (tele.audioState === 'suspended') {
    return (
      <span className="pill2 bad">
        <span className="dot" />
        click the output window to start audio
      </span>
    )
  }
  if (!tele.hasSource && tele.status === 'running') {
    return (
      <span className="pill2 warn">
        <span className="dot" />
        output has no audio source
      </span>
    )
  }
  if (tele.status === 'starting') {
    return (
      <span className="pill2 warn">
        <span className="dot" />
        output starting…
      </span>
    )
  }
  if (tele.status === 'error') {
    return (
      <span className="pill2 bad">
        <span className="dot" />
        output error
      </span>
    )
  }
  return null
}
