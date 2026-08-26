/**
 * What a scene looks like, as numbers.
 *
 * Role assignment is manual today: sixteen scenes, each decided by a human
 * looking at it. That does not survive a marketplace, where a third-party scene
 * arrives with a *claim* about what it is and something has to check the claim.
 *
 * The basis for checking it mechanically is that every manual decision in the
 * roster was made on **pixels**, not semantics — coverage, where the light
 * sits, and whether it fights a subject. See `docs/10_Scene_Roles.md` for the
 * contract this implements.
 *
 * Pure, and separated from the renderer on purpose: everything here takes a
 * luminance field and returns numbers, so it can be tested against synthetic
 * fields whose answers are known by construction rather than only against real
 * scenes whose answers are what we are trying to establish.
 */

/** Profile sampling resolution. Small — every statistic here is a whole-field one. */
export const PROFILE_W = 64
export const PROFILE_H = 36

/**
 * Luminance above which a pixel counts as lit.
 *
 * In 0..1 output space. Low, because this roster is deliberately a bright
 * subject on true black and the interesting structure lives well below mid
 * grey — a threshold at 0.5 would call most scenes empty.
 */
export const LIT_THRESHOLD = 0.06

/** Radii, as a fraction of the half-diagonal, splitting centre / mid / edge. */
const CENTRE_R = 0.34
const MID_R = 0.68

export interface SceneProfile {
  /** Fraction of pixels above {@link LIT_THRESHOLD}. */
  fill: number
  /** Mean luminance over the whole field, 0..1. */
  meanLuma: number
  /** Share of lit ENERGY inside the centre disc. */
  centre: number
  /** Share of lit energy in the annulus between centre and edge. */
  mid: number
  /** Share of lit energy outside {@link MID_R}. */
  edge: number
  /** Mean absolute frame-to-frame luminance change, per second. */
  motion: number
  /**
   * How much of this scene's light lands where a subject already is.
   *
   * 0 = entirely complementary to a centred subject. **1 = as concentrated on
   * the subject as a canonical subject itself**, which is the top of the useful
   * range but NOT a hard ceiling: a scene with a tighter core than the
   * reference Gaussian legitimately scores above it. Measured across the
   * roster, `plasma` reads 1.65 and `wireframe` 1.40, both of which are correct
   * readings of scenes that are more centre-concentrated than the reference.
   */
  conflict: number
  /** Share of pixels that would exceed full white once summed with a subject. */
  blowout: number
  /** Frames the profile was accumulated over. */
  frames: number
}

export function emptyProfile(): SceneProfile {
  return {
    fill: 0,
    meanLuma: 0,
    centre: 0,
    mid: 0,
    edge: 0,
    motion: 0,
    conflict: 0,
    blowout: 0,
    frames: 0,
  }
}

/**
 * The canonical subject a layer has to coexist with.
 *
 * A centred Gaussian, matching the exposure doctrine in
 * `docs/09_Rendering_Engine.md`: a bright subject, centred, with a small share
 * of the frame lit. Analytic rather than a second render — there is nothing to
 * keep in sync, it is identical on every machine, and it cannot drift when the
 * roster changes.
 *
 * The peak is deliberately below 1: a real subject that already sat at full
 * white would make every layer look like a blowout risk, which would say more
 * about the reference than about the layer.
 */
export function subjectReference(x: number, y: number): number {
  const dx = (x + 0.5) / PROFILE_W - 0.5
  const dy = (y + 0.5) / PROFILE_H - 0.5
  const r2 = (dx * dx + dy * dy) / 0.5 ** 2
  return 0.75 * Math.exp(-r2 * 6)
}

/**
 * Conflict a scene shaped EXACTLY like the reference would score, before
 * normalisation. The top of the scale.
 *
 * It is not the reference's peak, and assuming it was made the metric lie. The
 * raw score is an energy-weighted mean of the reference over the scene's own
 * light: for a scene proportional to a Gaussian reference that integrates to
 * exactly HALF the peak, so a perfectly centred blob scored 0.5 on a scale
 * whose documentation promised 1. Dividing by this makes 1.0 mean "as centred
 * as a canonical subject", which is the thing the thresholds are actually
 * reasoning about.
 *
 * Computed once from the reference itself, so it cannot drift if the reference
 * is ever reshaped.
 */
const SELF_CONFLICT = (() => {
  let num = 0
  let den = 0
  for (let y = 0; y < PROFILE_H; y++) {
    for (let x = 0; x < PROFILE_W; x++) {
      const r = subjectReference(x, y)
      num += r * r
      den += r
    }
  }
  return den > 0 ? num / den : 1
})()

/** Normalised radius 0..1 from the centre of the field. */
function radius(x: number, y: number): number {
  const dx = (x + 0.5) / PROFILE_W - 0.5
  const dy = (y + 0.5) / PROFILE_H - 0.5
  return Math.min(1, Math.sqrt(dx * dx + dy * dy) / 0.5)
}

/**
 * Accumulator. Fed one luminance field per frame; produces a profile at the end.
 *
 * Kept as a class with reused scratch because it runs inside the bench's render
 * loop, and a benchmark that allocates per frame is measuring its own garbage.
 */
export class ProfileAccumulator {
  private readonly prev = new Float32Array(PROFILE_W * PROFILE_H)
  private hasPrev = false
  private frames = 0
  private sumFill = 0
  private sumMean = 0
  private sumCentre = 0
  private sumMid = 0
  private sumEdge = 0
  private sumMotion = 0
  private sumConflict = 0
  private sumBlowout = 0

  reset(): void {
    this.hasPrev = false
    this.frames = 0
    this.sumFill = 0
    this.sumMean = 0
    this.sumCentre = 0
    this.sumMid = 0
    this.sumEdge = 0
    this.sumMotion = 0
    this.sumConflict = 0
    this.sumBlowout = 0
  }

  /**
   * One frame's luminance field, 0..1, row-major, `PROFILE_W * PROFILE_H`.
   *
   * `dt` in seconds, so motion is a rate rather than a per-frame delta — a
   * scene must not read as calmer merely because the machine ran faster.
   */
  push(luma: Float32Array, dt: number): void {
    let lit = 0
    let sum = 0
    let eCentre = 0
    let eMid = 0
    let eEdge = 0
    let conflictNum = 0
    let conflictDen = 0
    let blown = 0
    let motion = 0

    for (let y = 0; y < PROFILE_H; y++) {
      for (let x = 0; x < PROFILE_W; x++) {
        const i = y * PROFILE_W + x
        const v = luma[i]
        sum += v
        if (v > LIT_THRESHOLD) lit++

        const r = radius(x, y)
        if (r < CENTRE_R) eCentre += v
        else if (r < MID_R) eMid += v
        else eEdge += v

        // Conflict: this scene's light, weighted by how much subject is already
        // there. Normalised by the scene's own total, so a dim scene and a
        // bright one with the same DISTRIBUTION score the same — the question
        // is where the light goes, not how much of it there is.
        const ref = subjectReference(x, y)
        conflictNum += v * ref
        conflictDen += v
        if (v + ref > 1) blown++

        if (this.hasPrev) motion += Math.abs(v - this.prev[i])
        this.prev[i] = v
      }
    }

    const n = PROFILE_W * PROFILE_H
    const energy = eCentre + eMid + eEdge || 1
    this.sumFill += lit / n
    this.sumMean += sum / n
    this.sumCentre += eCentre / energy
    this.sumMid += eMid / energy
    this.sumEdge += eEdge / energy
    // Divided by SELF_CONFLICT, not by the reference's peak: a scene shaped
    // like the subject should score 1, and against the peak it scored 0.5.
    this.sumConflict += conflictDen > 0 ? conflictNum / conflictDen / SELF_CONFLICT : 0
    this.sumBlowout += blown / n
    if (this.hasPrev && dt > 0) this.sumMotion += motion / n / dt
    this.hasPrev = true
    this.frames++
  }

  result(): SceneProfile {
    const f = this.frames || 1
    // Motion has one fewer sample than the rest: the first frame has nothing to
    // difference against. Dividing it by `f` too would under-report every scene
    // by the same small factor, which is harmless but wrong.
    const m = Math.max(1, this.frames - 1)
    return {
      fill: this.sumFill / f,
      meanLuma: this.sumMean / f,
      centre: this.sumCentre / f,
      mid: this.sumMid / f,
      edge: this.sumEdge / f,
      motion: this.sumMotion / m,
      conflict: this.sumConflict / f,
      blowout: this.sumBlowout / f,
      frames: this.frames,
    }
  }
}

/* ------------------------------------------------------------- eligibility */

/** A role a profile either supports or refuses, with the reason it refused. */
export interface RoleVerdict {
  ok: boolean
  why: string
}

/**
 * Starting thresholds. Deliberately named and exported so validation can move
 * them in one place, and so a disagreement with a human call points at a number
 * rather than at a branch.
 */
export const T = {
  /** Below this fill, a scene has too little on screen to hold a frame alone. */
  primaryMinFill: 0.02,
  /** Above this, a scene covers so much that nothing can sit over it. */
  layerMaxFill: 0.42,
  /** Above this share of energy on the subject, a layer saturates it. */
  layerMaxConflict: 0.55,
  /** A background sits under everything for a whole section. */
  backgroundMaxConflict: 0.42,
  backgroundMaxMotion: 0.55,
  /** A ground layer that is mostly centred is a second subject. */
  backgroundMaxCentre: 0.5,
  /** Summed with a subject, this much of the frame going white is too much. */
  maxBlowout: 0.06,
}

/** Can this profile hold the subject? */
export function canBePrimary(p: SceneProfile): RoleVerdict {
  if (p.fill < T.primaryMinFill) {
    return { ok: false, why: `fill ${p.fill.toFixed(3)} — too little on screen to carry a frame` }
  }
  return { ok: true, why: '' }
}

/** Can this profile sit OVER a subject (accent or overlay)? */
export function canBeLayer(p: SceneProfile): RoleVerdict {
  if (p.fill > T.layerMaxFill) {
    return { ok: false, why: `fill ${p.fill.toFixed(3)} — covers the frame, nothing can sit under it` }
  }
  // Conflict before blowout, deliberately. Both can be true of a centred
  // scene, and "its light lands where the subject already is" is the reason an
  // author can act on; "it saturates" is a consequence of it.
  if (p.conflict > T.layerMaxConflict) {
    return {
      ok: false,
      why: `conflict ${p.conflict.toFixed(2)} — its light lands where the subject already is`,
    }
  }
  if (p.blowout > T.maxBlowout) {
    return { ok: false, why: `blowout ${p.blowout.toFixed(3)} — saturates when summed with a subject` }
  }
  return { ok: true, why: '' }
}

/** Can this profile be the ground everything else sits on? */
export function canBeBackground(p: SceneProfile): RoleVerdict {
  const layer = canBeLayer(p)
  if (!layer.ok) return layer
  if (p.conflict > T.backgroundMaxConflict) {
    return { ok: false, why: `conflict ${p.conflict.toFixed(2)} — too close to the subject to sit under it` }
  }
  if (p.centre > T.backgroundMaxCentre) {
    return { ok: false, why: `centre ${p.centre.toFixed(2)} — a centred ground is a second subject` }
  }
  if (p.motion > T.backgroundMaxMotion) {
    return { ok: false, why: `motion ${p.motion.toFixed(2)} — a ground that moves this fast competes` }
  }
  return { ok: true, why: '' }
}

/**
 * Every role the profile supports.
 *
 * `effect` is absent by construction, and that is a limit rather than an
 * omission: the role's binding requirement is a CONTRACT — the scene must drive
 * itself to visual zero by `slotProgress` 1, because SceneManager retires it
 * there and does not fade it out — and a contract cannot be inferred from a
 * still frame. It stays declared-and-verified.
 */
export function eligibleRoles(p: SceneProfile): Record<string, RoleVerdict> {
  return {
    primary: canBePrimary(p),
    accent: canBeLayer(p),
    overlay: canBeLayer(p),
    background: canBeBackground(p),
  }
}
