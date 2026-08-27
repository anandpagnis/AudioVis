import { useMemo, useState } from 'react'
import {
  DEFAULT_PARAM_VALUE,
  resolveSceneParams,
  visibleSceneParams,
  type SceneModeSpec,
} from '../engine/sceneParams'
import { LAYER_ROLES, useStore } from '../store'
import { getScene } from '../scenes'

/**
 * Per-scene controls: the canonical seven-key vocabulary plus the scene's named
 * modes.
 *
 * Generic by construction — it reads what the scene declared and renders that,
 * with no per-scene knowledge anywhere in here. That is the whole payoff of a
 * fixed vocabulary: one panel drives every scene, including scenes that do not
 * exist yet.
 *
 * The target selector covers the primary *and* any mounted layer, because a
 * layer is a scene with its own parameters and tuning the ground separately from
 * the subject is most of what makes a layered composition worth having.
 */
export function SceneParamsPanel() {
  const sceneId = useStore((s) => s.sceneId)
  const layerSceneIds = useStore((s) => s.layerSceneIds)
  const sceneParams = useStore((s) => s.sceneParams)
  const [targetOverride, setTargetOverride] = useState<string | null>(null)

  /** Primary first, then whichever layers are actually mounted. */
  const targets = useMemo(() => {
    const out = [{ role: 'primary', id: sceneId }]
    for (const role of LAYER_ROLES) {
      const id = layerSceneIds[role]
      if (id) out.push({ role, id })
    }
    return out
  }, [sceneId, layerSceneIds])

  // A layer can be dropped while its panel is open, so the override is only a
  // preference — it never decides what is editable.
  const target = targets.find((t) => t.id === targetOverride) ?? targets[0]
  const scene = getScene(target.id)
  // From the contract envelope; see the note in engine/sceneParams.ts on why
  // the two branches' parallel designs merged this way round.
  //
  // The writes below go through the engine's own actions rather than the
  // patch-style `setSceneParams(id, patch | null)` this panel arrived with.
  // They are not equivalent: `setSceneParam` round-trips each value through the
  // contract's sanitizer, which is the only thing that knows which keys the
  // scene honours in the CURRENT mode, and `setSceneMode` backs AutoPilot off
  // the way a manual scene or palette change does. A raw patch would have
  // stored inert keys that came back to life on a mode switch, and would have
  // let the director keep overriding a mode the operator had just chosen.
  const { params: declared, modes, paramLabels } = scene.metadata.contract ?? {}

  const spec: SceneModeSpec | undefined = modes ? { modes, paramLabels } : undefined
  const resolved = resolveSceneParams(declared, sceneParams?.[target.id], spec)
  const rows = visibleSceneParams(declared, resolved.mode, spec)
  const overridden = sceneParams?.[target.id]

  if (targets.length === 1 && rows.length === 0 && !modes) {
    return (
      <p className="param-note">
        {scene.name} has no parameters of its own — it is driven entirely by band routing. Scenes
        ported from the lilim vocabulary declare their own controls here.
      </p>
    )
  }

  return (
    <>
      {targets.length > 1 && (
        <div className="param-row">
          <span>Target</span>
          <div className="quality-row">
            {targets.map((t) => (
              <button
                key={t.role}
                className={`chip ${t.id === target.id ? 'active' : ''}`}
                title={getScene(t.id).name}
                onClick={() => setTargetOverride(t.id)}
              >
                {t.role}
              </button>
            ))}
          </div>
        </div>
      )}

      {modes && (
        <div className="param-row">
          <span>Mode</span>
          <div className="quality-row">
            {modes.map((m) => (
              <button
                key={m}
                className={`chip ${resolved.mode === m ? 'active' : ''}`}
                onClick={() => useStore.getState().setSceneMode(target.id, m)}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      )}

      {rows.map(({ key, label }) => (
        <label key={key} className="param-row">
          <span>{label}</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={resolved[key]}
            onChange={(e) =>
              useStore.getState().setSceneParam(target.id, key, Number(e.target.value))
            }
            // lilim's convention, and worth keeping: a control you can put back
            // is a control you will actually reach for mid-performance.
            title="Double-click to reset"
            onDoubleClick={() =>
              useStore.getState().setSceneParam(target.id, key, declared?.[key] ?? DEFAULT_PARAM_VALUE)
            }
          />
          <em>{resolved[key].toFixed(2)}</em>
        </label>
      ))}

      {rows.length === 0 && !modes && (
        <p className="param-note">{scene.name} declares no parameters.</p>
      )}

      {overridden && (
        <div className="param-row">
          <span />
          <button
            className="chip"
            title="Return every slider to the value the scene was authored at"
            onClick={() => useStore.getState().resetSceneParams(target.id)}
          >
            reset {scene.name}
          </button>
        </div>
      )}
    </>
  )
}
