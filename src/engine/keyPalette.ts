/**
 * Turns the key estimate into a *stable* palette preference.
 *
 * Key detection works, but its raw output is far too jittery to drive a
 * palette directly: measured window-to-window agreement on real tracks was
 * only 43-65%. Wiring it naively would strobe the colour scheme.
 *
 * The saving detail is *which* readings disagree. Nearly all of the
 * disagreement is musically adjacent — the dominant (a fifth away), the
 * relative major/minor, or the parallel — and only 0-8% of windows landed on a
 * genuinely unrelated key. Those adjacent readings are the same tonal centre
 * described differently, so collapsing them into one *family* removes most of
 * the churn before any smoothing is applied. What survives that is handled by
 * a vote over recent reads plus a minimum dwell, the same shape as
 * MoodEstimator's dwell lock.
 *
 * Two layers, in order:
 *   1. `keyFamily()`  — 24 keys → 6 families, fifths/relatives/parallels
 *                        collapsing onto the same family by construction.
 *   2. `KeyPaletteTracker` — votes over a rolling history and refuses to
 *                        switch before a minimum dwell has elapsed.
 */

/** Pitch classes, sharps and flats both spelled since Essentia emits either. */
const PITCH_CLASS: Record<string, number> = {
  C: 0,
  'B#': 0,
  'C#': 1,
  Db: 1,
  D: 2,
  'D#': 3,
  Eb: 3,
  E: 4,
  Fb: 4,
  F: 5,
  'E#': 5,
  'F#': 6,
  Gb: 6,
  G: 7,
  'G#': 8,
  Ab: 8,
  A: 9,
  'A#': 10,
  Bb: 10,
  B: 11,
  Cb: 11,
}

/**
 * Family per pitch class, indexed by the MAJOR-key tonic.
 *
 * Ordered around the circle of fifths rather than chromatically, so that keys
 * a fifth apart — the single most common disagreement — land in the same or an
 * adjacent family instead of opposite ends of the palette list. A minor key is
 * mapped through its relative major (+3 semitones) before lookup, which makes
 * the relative-major/minor confusion collapse to the same family for free.
 */
const FAMILY_BY_MAJOR_TONIC: string[] = [
  'aurora', // C
  'violet', // C#/Db
  'ocean', // D
  'mono', // D#/Eb
  'solar', // E
  'ember', // F
  'aurora', // F#/Gb
  'ocean', // G
  'violet', // G#/Ab
  'solar', // A
  'mono', // A#/Bb
  'ember', // B
]

/** Neutral answer when the key is unknown — callers treat it as "no opinion". */
export const NO_KEY_FAMILY = ''

/**
 * Palette family for a key, or {@link NO_KEY_FAMILY} when unreadable.
 *
 * Minor keys resolve through their relative major, so `A minor` and `C major`
 * — which share a pitch-class set and are the classic KeyExtractor confusion —
 * deliberately return the SAME family. That is the point, not a rounding error.
 */
export function keyFamily(key: string, scale: string): string {
  if (!key) return NO_KEY_FAMILY
  const pc = PITCH_CLASS[key.trim()]
  if (pc === undefined) return NO_KEY_FAMILY
  // Relative major of a minor key sits 3 semitones up.
  const majorTonic = scale === 'minor' ? (pc + 3) % 12 : pc
  return FAMILY_BY_MAJOR_TONIC[majorTonic]
}

/** Votes pooled before the tracker will express any opinion at all. */
const MIN_VOTES = 3
/** How many recent votes are pooled. At the interval below, ~48s of memory. */
const HISTORY = 8
/**
 * Seconds between votes.
 *
 * This samples the CURRENT belief on a timer rather than counting distinct
 * key values, and the difference matters: the classifier only refreshes every
 * ~12s while this runs every frame, but a track that sits solidly in one key
 * reports that same key on every refresh. Deduplicating by value would let
 * such a track cast exactly one vote and never reach a majority — stability,
 * the very thing we want to reward, would read as insufficient evidence.
 * Sampling on a timer means a steady key accumulates agreement the way it
 * should, while per-frame repeats still cannot stuff the ballot.
 */
const VOTE_INTERVAL_SEC = 6
/** Seconds a committed family must hold before another can replace it. */
const MIN_DWELL_SEC = 25
/** Share of the pooled votes a challenger needs to take over. */
const MAJORITY = 0.5

/**
 * Rolling vote over recent key reads with a minimum dwell.
 *
 * Deliberately conservative in both directions: it says nothing until it has
 * seen `MIN_VOTES` reads, and once it commits it will not move again for
 * `MIN_DWELL_SEC` even if the vote flips. A palette that changes on a
 * mis-heard bar is worse than one that changes a section late.
 */
export class KeyPaletteTracker {
  private history: string[] = []
  private committed = NO_KEY_FAMILY
  private committedAt = -Infinity
  private lastVoteAt = -Infinity

  reset(): void {
    this.history = []
    this.committed = NO_KEY_FAMILY
    this.committedAt = -Infinity
    this.lastVoteAt = -Infinity
  }

  /** The family currently worth acting on; empty means "no opinion yet". */
  get family(): string {
    return this.committed
  }

  /**
   * Feed the current key estimate. Safe to call every frame — votes are taken
   * on a timer (see {@link VOTE_INTERVAL_SEC}), so the per-frame call rate
   * cannot influence the outcome.
   */
  update(key: string, scale: string, nowSec: number): string {
    // A new source restarts the engine clock at 0. Self-detecting that here
    // avoids AudioEngine (the audio layer) having to import this (an engine
    // layer concern) purely to call reset — the dependency only runs one way.
    // Without it, a second track inherits the first's committed family and
    // holds it for a full dwell.
    if (nowSec < this.lastVoteAt || nowSec < this.committedAt) this.reset()

    if (nowSec - this.lastVoteAt >= VOTE_INTERVAL_SEC) {
      const fam = keyFamily(key, scale)
      // An unreadable key casts no vote, but still advances the clock so a
      // silent stretch doesn't bank up votes to spend the moment one lands.
      this.lastVoteAt = nowSec
      if (fam !== NO_KEY_FAMILY) {
        this.history.push(fam)
        if (this.history.length > HISTORY) this.history.shift()
      }
    }
    if (this.history.length < MIN_VOTES) return this.committed

    let winner = NO_KEY_FAMILY
    let best = 0
    const counts = new Map<string, number>()
    for (const f of this.history) {
      const n = (counts.get(f) ?? 0) + 1
      counts.set(f, n)
      if (n > best) {
        best = n
        winner = f
      }
    }
    // A clear majority, not just a plurality — three-way splits hold position.
    if (winner === this.committed || best / this.history.length <= MAJORITY) return this.committed
    if (nowSec - this.committedAt < MIN_DWELL_SEC) return this.committed

    this.committed = winner
    this.committedAt = nowSec
    return this.committed
  }
}

export const keyPaletteTracker = new KeyPaletteTracker()
