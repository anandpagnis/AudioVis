/**
 * Loudness-invariant band normalization.
 *
 * ## The property this exists to guarantee
 *
 * Visual reactivity must depend on the MUSIC, not on how loud it is being
 * played. Turning up the source's volume must not turn up the visuals.
 *
 * The mechanism is division by a slow-decaying running maximum: scale the input
 * by k and both `raw` and `peak` scale by k, so `raw / peak` is unchanged. That
 * is scale-invariance, and `bandNormalizer.test.ts` asserts it directly over
 * real music at 0.1x / 1x / 10x.
 *
 * ## Why it is a SLOW reference, not an instantaneous one
 *
 * Normalizing against the instantaneous level would flatten the music: a quiet
 * breakdown and a loud drop would render identically, destroying the dynamics
 * the visuals exist to express. The separation is one of TIME CONSTANT — the
 * reference tracks program loudness over tens of seconds (what a volume knob
 * looks like), while short-term envelopes swing freely against it (what music
 * looks like).
 *
 * ## The bug this replaces
 *
 * The previous implementation clamped the reference to an absolute floor of
 * 0.02:
 *
 *     band.peak = Math.max(raw, band.peak * (1 - delta * 0.04), 0.02)
 *
 * Band values are MEAN LINEAR MAGNITUDE PER BIN, and measured over the eight
 * MTG-Jamendo reference tracks their medians run 0.0099 (bass) down to 9.8e-5
 * (air) — so 0.02 sat above the entire operating range of every band from `mid`
 * upward. For those bands the floor was the binding term on 58% of frames, the
 * reference never tracked the signal, and `raw / 0.02` was a plain linear
 * function of input level. Measured volume dependence over a 16x gain change,
 * where scale-invariance would give 1.00x:
 *
 *     sub 1.95x · bass 2.48x · mid 11.8x · presence 15.9x · high 15.6x
 *     vocal 15.5x · air 13.1x
 *
 * Bass and sub partly escaped it (their peaks do exceed 0.02), which is why the
 * failure read as the picture getting BRIGHTER and harsher with volume rather
 * than uniformly stronger — the timbral balance shifted, not just the level.
 *
 * The floor's real job was to stop the reference walking down onto the noise
 * floor during silence and then amplifying room tone to full scale. That job is
 * now done properly, by holding the reference while silent instead of clamping
 * it — see {@link BandNormalizer.update}.
 */

/**
 * Divide-by-zero guard only — deliberately far below any real band value.
 *
 * Not a floor in the old sense: at 1e-6 it still grazed `air` at low input
 * levels (measured 1.37x residual gain dependence instead of 1.00x), because
 * air's magnitudes are ~1e-4 at unity and scale down from there. Anything that
 * can bind on real signal reintroduces exactly the bug this file exists to fix.
 */
export const PEAK_GUARD = 1e-9

/**
 * Reference decay, as a fraction per second (~4.6 s half-life).
 *
 * The reference is a running maximum, `max(raw, peak * decay)`: instant on the
 * way up, this rate on the way down.
 *
 * **Why instant attack is correct, despite looking like the bug.** Turning the
 * volume up makes `raw` exceed the reference, and ANY level-relative normalizer
 * reads "much louder than anything recently" as full scale - the ratio clips at
 * 1.0 whether the reference rises instantly or not. Slew-limiting the rise does
 * not remove that overshoot, it PROLONGS it, because the ratio stays clipped
 * until the reference catches up. An instant rise makes the excursion as short
 * as it can be. A two-stage symmetric reference was tried first and measured
 * worse on both brightness and flicker.
 *
 * **The decay is the half that was genuinely broken.** At the original 0.04
 * (a 17 s half-life) a volume reduction left the show dim and sluggish for the
 * best part of a minute. At 0.15 an 8x reduction is back to normal in ~14 s
 * instead of ~52 s.
 *
 * Faster still would track the volume knob better, but the reference would then
 * chase musical dynamics: a breakdown is indistinguishable from someone turning
 * the volume down, so anything quick enough to hide one erases the other. This
 * sits above the bar timescale and below the section timescale.
 */
export const REF_RATE = 0.15

/**
 * Response curve applied to the normalized value. **This is the sensitivity
 * dial — turn it up to calm the show down, down to make it more aggressive.**
 *
 * Fixing the normalizer restored bands that had been crushed toward zero, and
 * the jump was large: measured median output went 0.026 -> 0.409 for `high`
 * (16x), 0.120 -> 0.483 for `mid` (4x), while `bass` moved only 0.293 -> 0.385.
 * Correct, but far more reactive than the scenes were art-directed against —
 * upper-band content that used to barely register now drives them at full
 * strength, which reads as harsh.
 *
 * An exponent rather than a scale factor, because it should soften the ordinary
 * middle of the range without flattening the peaks: on 0..1, `x^g` pulls the
 * median down while leaving a full-scale hit at 1.0 untouched. A linear gain
 * would dull the accents too.
 *
 * Tuned by eye against the running app, in steps of measured median band
 * output over the eight reference tracks:
 *
 *     1.3 -> mean median 0.46   still too bright, and flickery
 *     2.0 -> mean median 0.29   still too bright
 *     2.8 -> mean median 0.22   current
 *     3.2 -> mean median 0.20   next notch down if needed
 *
 * Because the curve is steepest at the bottom it damps small frame-to-frame
 * wobble as well as overall level, so it doubles as the flicker control. Quiet
 * content deliberately gets much darker - "less sensitive" means only louder
 * material drives the visuals hard.
 *
 * Worth knowing when tuning further: at 2.8 the LOW bands sit slightly below
 * where they were before any of this work (sub 0.151 vs 0.226, bass 0.208 vs
 * 0.293) while the upper bands sit well above (high 0.226 vs 0.026). That is
 * the honest consequence of a single global curve - the upper bands were the
 * broken ones, and dimming everything to calm them also thins the low end. If
 * the bass ever starts feeling weak, the fix is a per-band trim rather than
 * more gamma.
 *
 * Safe with respect to loudness invariance: it is a pure function of an already
 * scale-invariant value, so `f(raw/peak)` is invariant for any `f`. The tests
 * assert this directly rather than taking it on trust.
 *
 * It is NOT free with respect to the structure thresholds — `energy` is a
 * weighted sum of these values, so `drop`/`buildUp`/mood thresholds are derived
 * against a specific value here. Change it and re-derive them (the method is
 * recorded in AudioEngine's threshold comments).
 */
export const RESPONSE_GAMMA = 2.8

export interface BandState {
  /** Running-max loudness reference: instant attack, {@link REF_RATE} decay. */
  peak: number
  /** Smoothed, normalized output. */
  value: number
  /** False until the first real sample, so the reference starts from the signal. */
  seeded: boolean
}

export function makeBandState(): BandState {
  // Deliberately NOT a positive constant. The old code seeded peak at 0.15 —
  // ~18x the median bass value and ~1500x the median air value — and decayed at
  // 4%/s, so a band from `mid` upward needed over a minute to converge. Every
  // source change spent that minute visibly under-reactive. Seeding from the
  // first real sample makes convergence immediate instead.
  return { peak: 0, value: 0, seeded: false }
}

export class BandNormalizer {
  readonly state: BandState = makeBandState()

  /**
   * `gamma` is injectable purely so tests and the offline threshold-derivation
   * harness can compare curves without editing the constant. Production always
   * uses the default.
   */
  constructor(
    private readonly gamma: number = RESPONSE_GAMMA,
    private readonly refRate: number = REF_RATE,
  ) {}

  reset(): void {
    this.state.peak = 0
    this.state.value = 0
    this.state.seeded = false
  }

  /**
   * Fold one frame in and return the normalized, smoothed band value.
   *
   * `silent` freezes the reference. During silence `raw` collapses toward the
   * noise floor, and a decaying reference would follow it down — so when the
   * music returned, or worse while only room tone was present, `raw / peak`
   * would read near 1.0 and the visuals would fire at full strength on
   * nothing. Holding the reference is what the old absolute floor was really
   * for, done in the one place where it does not also distort the operating
   * range of every band.
   */
  update(raw: number, delta: number, silent: boolean, attack: number, release: number): number {
    const s = this.state
    if (!s.seeded) {
      if (raw <= PEAK_GUARD) return s.value
      s.seeded = true
      s.peak = raw
    } else if (!silent) {
      // Both stages are linear in `raw`, so the whole reference scales with the
      // input and `raw / peak` stays invariant — the property the tests pin.
      s.peak = Math.max(raw, s.peak * (1 - delta * this.refRate))
    }
    // While silent both stages HOLD: a decaying reference would walk down onto
    // the noise floor and then amplify room tone to full scale.
    s.peak = Math.max(s.peak, PEAK_GUARD)

    // Curve applied to the ratio, before smoothing, so the smoothing operates
    // on the value scenes actually see.
    const target = Math.pow(Math.min(1, raw / s.peak), this.gamma)
    const rate = target > s.value ? 22 * attack : 5 * release
    s.value += (target - s.value) * Math.min(1, delta * rate)
    return s.value
  }
}

/**
 * Slow program-loudness reference for the silence gate.
 *
 * The gate used to be `rmsRaw > 0.008`, an absolute threshold — so at a quarter
 * volume a genuinely playing track fell under it and the whole show gated off
 * (`f.silence` suppresses AutoPilot, PerformanceDirector, EffectDirector and the
 * scene fade). Measured on the reference tracks, `hiphop-vocals__585146` sits
 * below 0.008 in its quietest 5% of frames even at FULL volume.
 *
 * Silence is therefore judged relatively — has the signal collapsed against its
 * own recent program level — with an absolute floor kept only for true digital
 * silence, where there is no program level to be relative to.
 */
export class ProgramLevel {
  private level = 0
  private seeded = false
  /** Latched so the two ratio thresholds can act as hysteresis. */
  private silent = true

  reset(): void {
    this.level = 0
    this.seeded = false
    this.silent = true
  }

  get value(): number {
    return this.level
  }

  /** True when this frame carries real signal. */
  update(rmsRaw: number, delta: number, cfg: SilenceConfig): boolean {
    if (rmsRaw > DIGITAL_SILENCE) {
      if (!this.seeded) {
        this.seeded = true
        this.level = rmsRaw
      } else {
        this.level = Math.max(rmsRaw, this.level * (1 - delta * REF_RATE))
      }
    }
    if (rmsRaw <= DIGITAL_SILENCE || this.level <= 0) {
      this.silent = true
      return false
    }
    const ratio = rmsRaw / this.level
    // Hysteresis: a passage hovering near the boundary must not chatter the
    // gate, because `f.silence` hard-stops every automatic director.
    this.silent = this.silent ? ratio < cfg.exitRatio : ratio < cfg.enterRatio
    return !this.silent
  }
}

/** No signal at all — below this there is no program level to be relative to. */
export const DIGITAL_SILENCE = 1e-4

export interface SilenceConfig {
  /** Below this share of program level, a playing track becomes "silent". */
  enterRatio: number
  /** Above this share, it becomes "playing" again. Higher than enterRatio. */
  exitRatio: number
}
