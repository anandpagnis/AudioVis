import type { CharacterMood } from '../../audio/characterTypes'
import {
  createNeutralRow,
  LENS,
  LENS_STYLE_COUNT,
  LOOK_CAMERA_MODES,
  LOOK_TRANSITIONS,
  MIRROR_MODES,
  ROW_ARRAY_KEYS,
  SEGMENT_CHOICES,
  type LookRow,
} from './lookRow'

/**
 * The AUTHORED look of each of the 14 character moods (plan: "Authored rows").
 *
 * ## What these numbers are (and are not)
 *
 * They are ART-DIRECTION HYPOTHESES. The research gives AXES, not per-mood effect pairings:
 *  - Colour and motion follow the perceived EMOTION (Palmer 2013, Whiteford 2018): arousal to saturation,
 *    speed, contrast and warmth; valence to lightness and warm vs cool. When the audio and visual arousal
 *    channels disagree, perceived emotion follows the higher-arousal one, so a low-arousal row NEVER gets
 *    extra saturation, a fast camera or hard effects.
 *  - Which lens material / mirror / feedback length goes with which mood (pixel sort with harsh audio,
 *    kaleidoscope with complex audio, long feedback with sparse audio) is practitioner convention. There is
 *    no published validation, so none of it is asserted as fact here.
 *
 * What matters, and what `moodRows.test.ts` pins, is the ORDERING between moods (aggressive is harsher,
 * faster, crisper and more saturated than serene; melancholic is cooler and darker than tender; ...) and the
 * LEGIBILITY of the differences (no two moods look alike across at least four of the eight families). The
 * absolute values are meant to be tuned by eye with `?lookforce=<mood>` and the look overlay, so change them
 * freely as long as the tests still say the same story.
 *
 * ## Rules that shaped the table (user decisions)
 *  - Bold and legible: rows use the full design ranges in `lookRow.ts`, and stay inside them.
 *  - Pixel sort and glitch dominate the lens weights of the harsh moods (aggressive, tense, driving).
 *  - Mirrors are rare: melancholic never mirrors, aggressive and driving hardly do, and where a harsh mood
 *    (aggressive, tense, driving) does mirror it is VORTEX ONLY (kaleido weight 0). Kaleidoscopes on 6 / 8
 *    segments belong to dreamy, mysterious, euphoric and epic, the four moods that mirror most. (The slow,
 *    dark brooding row keeps the plan's slow vortex, the one non-harsh row that leans that way.)
 *  - Serene, tender and melancholic: long trails, no chromatic aberration, soft lens styles only (ribs, fan,
 *    anamorphic, melt), never glitch or pixel sort.
 *  - Melancholic, brooding, mysterious and tense are cool and dark (gradeTemp <= 0, heavy vignette);
 *    aggressive, euphoric, uplifting, playful and tender are warm.
 *  - Strobe is 0 for every calm mood and never above 0.8; mirror spin never above 0.7 (no new flash sources).
 *  - `tempoCoupling` (how far the song's BPM pulls motion speed) follows how much the mood is ABOUT the pulse:
 *    driving and aggressive 1.0, groove 0.9, euphoric 0.85, playful 0.8, uplifting 0.75, tense 0.7, epic 0.6
 *    (grand and heavy, so it follows tempo only partly), mysterious 0.4, brooding 0.45, melancholic 0.35, tender
 *    and dreamy 0.3, serene 0.2. A fast dreamy track therefore stays floaty; a fast driving one races.
 *
 * ## Authoring conventions
 * Every field is written out for every row (nothing silently inherits the neutral row). The `row()` helper
 * starts from `createNeutralRow()` only so the type is complete and so the arrays are fresh copies: no two
 * rows, and no row and the neutral row, ever share an array. The weight builders (`lens`, `mirrorMode`,
 * `mirrorSegs`, `camera`, `transitions`) take named relative weights and normalise them to sum 1, so a row
 * can be read as percentages and the linear blend of rows is a proper marginal probability.
 *
 * Known limits of the contract, kept out of the numbers on purpose:
 *  - `trailsZoom` is a magnitude. Whether a feedback zooms in or out is the consumer's decision (the plan's
 *    "zoom-out" moods are melancholic, uplifting and epic; "forward zoom" is driving).
 *  - `cameraSpeed` bottoms out at 0.6 in the contract, so melancholic's "0.55x" is authored as 0.6.
 */

type LensName = Exclude<keyof typeof LENS, 'flyEye'>

const normalise = (v: number[]): number[] => {
  let sum = 0
  for (const x of v) sum += x
  return sum > 0 ? v.map((x) => x / sum) : v
}

/** Lens style weights by name (`flyEye` is retired and cannot be named), normalised to sum 1. */
const lens = (w: Partial<Record<LensName, number>>): number[] => {
  const out = new Array<number>(LENS_STYLE_COUNT).fill(0)
  for (const k of Object.keys(w) as LensName[]) out[LENS[k]] = w[k] ?? 0
  return normalise(out)
}

const mirrorMode = (w: Partial<Record<(typeof MIRROR_MODES)[number], number>>): number[] =>
  normalise(MIRROR_MODES.map((m) => w[m] ?? 0))

const mirrorSegs = (w: Partial<Record<(typeof SEGMENT_CHOICES)[number], number>>): number[] =>
  normalise(SEGMENT_CHOICES.map((n) => w[n] ?? 0))

const camera = (w: Partial<Record<(typeof LOOK_CAMERA_MODES)[number], number>>): number[] =>
  normalise(LOOK_CAMERA_MODES.map((m) => w[m] ?? 0))

const transitions = (w: Partial<Record<(typeof LOOK_TRANSITIONS)[number], number>>): number[] =>
  normalise(LOOK_TRANSITIONS.map((m) => w[m] ?? 0))

/** Neutral row with `over` applied. Array fields are always copied, so rows never share references. */
function row(over: Partial<LookRow>): LookRow {
  const out: LookRow = { ...createNeutralRow(), ...over }
  for (const k of Object.keys(ROW_ARRAY_KEYS) as (keyof typeof ROW_ARRAY_KEYS)[]) {
    out[k] = [...(over[k] ?? out[k])]
  }
  return out
}

// One line per family keeps each mood readable as a column of the plan's table, so keep prettier off it.
// prettier-ignore
export const MOOD_ROWS: Record<CharacterMood, LookRow> = {
  // Stillness. Longest, slowest, airiest look: hazy veil, no chromatic aberration, ribbed and fan glass,
  // hover camera, cross-dissolves, the lowest steer speed of any mood.
  serene: row({
    bloomBase: 0.34, bloomReact: 0.55, caBase: 0, caReact: 0.5, vignette: 0.8, fogBase: 0.38,
    trailsBase: 1, trailsZoom: 0.5, trailsRotate: 0.4, trailsSwirl: 1.4, trailsWobble: 0.3, echoGate: 0,
    lensEngage: 0.25, lensAmountFloor: 0.15, lensAmountCeil: 0.2, lensWeights: lens({ ribs: 0.55, fan: 0.45 }),
    mirrorEngage: 0.2, mirrorMode: mirrorMode({ kaleido: 1 }), mirrorSegments: mirrorSegs({ 6: 0.8, 8: 0.2 }),
    mirrorSpinMin: 0.05, mirrorSpinMax: 0.15, mirrorTwistMax: 0.4, mirrorMix: 0.7, mirrorBusyGain: 0.3,
    steerSpeed: 0.2, steerComplexity: 0.3, steerDensity: 0.3, steerFill: 0.4, steerContrast: 0.3,
    tempoCoupling: 0.2,
    cameraWeights: camera({ hover: 0.6, orbit: 0.15, pull: 0.1, locked: 0.05, spiral: 0.05, cinematic: 0.05 }),
    cameraSpeed: 0.6, cameraShake: 0, cameraCutRate: 0.1,
    transitionWeights: transitions({ dissolve: 0.4, smear: 0.15, inkDissolve: 0.45 }),
    gradeSat: 0.92, gradeTemp: 0.1, gradeContrast: 0.97,
    traitTempo: 0.1, traitAngular: 0.1, traitBusy: 0.15, traitRadial: 0.35, traitStrength: 0.55,
    fxShock: 0, fxFlare: 0.3, fxSpark: 0.1, fxStrobe: 0,
  }),

  // Warmth and closeness. Long soft trails, a little beat echo, fan and anamorphic glass, the warmest of the
  // calm moods, a gentle orbit.
  tender: row({
    bloomBase: 0.46, bloomReact: 0.8, caBase: 0, caReact: 0.5, vignette: 0.86, fogBase: 0.14,
    trailsBase: 0.88, trailsZoom: 0.9, trailsRotate: 0.8, trailsSwirl: 0.9, trailsWobble: 0.8, echoGate: 0.15,
    lensEngage: 0.25, lensAmountFloor: 0.15, lensAmountCeil: 0.22, lensWeights: lens({ fan: 0.55, anamorphic: 0.45 }),
    mirrorEngage: 0.15, mirrorMode: mirrorMode({ kaleido: 1 }), mirrorSegments: mirrorSegs({ 4: 0.2, 6: 0.8 }),
    mirrorSpinMin: 0.05, mirrorSpinMax: 0.2, mirrorTwistMax: 0.4, mirrorMix: 0.7, mirrorBusyGain: 0.3,
    steerSpeed: 0.34, steerComplexity: 0.32, steerDensity: 0.3, steerFill: 0.4, steerContrast: 0.4,
    tempoCoupling: 0.3,
    cameraWeights: camera({ orbit: 0.5, hover: 0.25, cinematic: 0.1, pull: 0.1, spiral: 0.05 }),
    cameraSpeed: 0.7, cameraShake: 0.05, cameraCutRate: 0.2,
    transitionWeights: transitions({ dissolve: 0.3, smear: 0.3, inkDissolve: 0.4 }),
    gradeSat: 0.95, gradeTemp: 0.3, gradeContrast: 1,
    traitTempo: 0.15, traitAngular: 0.1, traitBusy: 0.2, traitRadial: 0.3, traitStrength: 0.5,
    fxShock: 0, fxFlare: 0.4, fxSpark: 0.25, fxStrobe: 0,
  }),

  // Haze. Steady glow, swirl and wobble at 1.5x, melting glass, and the mirror that leans kaleidoscope (6 / 8).
  dreamy: row({
    bloomBase: 0.5, bloomReact: 0.7, caBase: 0.0012, caReact: 0.7, vignette: 0.82, fogBase: 0.4,
    trailsBase: 1, trailsZoom: 0.8, trailsRotate: 0.9, trailsSwirl: 1.5, trailsWobble: 1.5, echoGate: 0.2,
    lensEngage: 0.35, lensAmountFloor: 0.16, lensAmountCeil: 0.28, lensWeights: lens({ melt: 0.55, fan: 0.3, anamorphic: 0.15 }),
    mirrorEngage: 0.45, mirrorMode: mirrorMode({ kaleido: 0.7, vortex: 0.3 }), mirrorSegments: mirrorSegs({ 6: 0.5, 8: 0.5 }),
    mirrorSpinMin: 0.05, mirrorSpinMax: 0.25, mirrorTwistMax: 0.6, mirrorMix: 0.8, mirrorBusyGain: 0.5,
    steerSpeed: 0.28, steerComplexity: 0.35, steerDensity: 0.3, steerFill: 0.42, steerContrast: 0.35,
    tempoCoupling: 0.3,
    cameraWeights: camera({ spiral: 0.5, orbit: 0.2, hover: 0.15, pull: 0.1, cinematic: 0.05 }),
    cameraSpeed: 0.7, cameraShake: 0.05, cameraCutRate: 0.2,
    transitionWeights: transitions({ smear: 0.3, melt: 0.2, dissolve: 0.1, inkDissolve: 0.25, irisWipe: 0.15 }),
    gradeSat: 1, gradeTemp: -0.15, gradeContrast: 0.98,
    traitTempo: 0.2, traitAngular: 0.1, traitBusy: 0.35, traitRadial: 0.8, traitStrength: 0.6,
    fxShock: 0.1, fxFlare: 0.5, fxSpark: 0.3, fxStrobe: 0,
  }),

  // Wistful. The coolest, most desaturated, dimmest look: low bloom, heavy vignette, sparse steer, melting
  // and ribbed glass, a slow pulling camera, and no mirror at all.
  melancholic: row({
    bloomBase: 0.3, bloomReact: 0.5, caBase: 0, caReact: 0.5, vignette: 0.93, fogBase: 0.22,
    trailsBase: 0.8, trailsZoom: 0.5, trailsRotate: 0.3, trailsSwirl: 0.5, trailsWobble: 0.3, echoGate: 0,
    lensEngage: 0.2, lensAmountFloor: 0.15, lensAmountCeil: 0.19, lensWeights: lens({ ribs: 0.4, melt: 0.6 }),
    mirrorEngage: 0, mirrorMode: mirrorMode({ kaleido: 1 }), mirrorSegments: mirrorSegs({ 6: 1 }),
    mirrorSpinMin: 0.05, mirrorSpinMax: 0.1, mirrorTwistMax: 0.2, mirrorMix: 0.5, mirrorBusyGain: 0,
    steerSpeed: 0.24, steerComplexity: 0.24, steerDensity: 0.16, steerFill: 0.2, steerContrast: 0.48,
    tempoCoupling: 0.35,
    cameraWeights: camera({ hover: 0.5, pull: 0.25, locked: 0.15, orbit: 0.1 }),
    cameraSpeed: 0.6, cameraShake: 0, cameraCutRate: 0.1,
    transitionWeights: transitions({ dissolve: 0.45, smear: 0.1, inkDissolve: 0.45 }),
    gradeSat: 0.78, gradeTemp: -0.35, gradeContrast: 1.05,
    traitTempo: 0.1, traitAngular: 0.2, traitBusy: 0.1, traitRadial: 0.25, traitStrength: 0.55,
    fxShock: 0, fxFlare: 0.15, fxSpark: 0.1, fxStrobe: 0,
  }),

  // Weight without release. The darkest edges (with tense), low rotate, slow vortex, a heavy push camera with
  // a little shake, cool grade at high contrast.
  brooding: row({
    bloomBase: 0.4, bloomReact: 0.8, caBase: 0.0008, caReact: 0.8, vignette: 0.98, fogBase: 0.26,
    trailsBase: 0.7, trailsZoom: 0.8, trailsRotate: 0.4, trailsSwirl: 0.7, trailsWobble: 0.9, echoGate: 0.3,
    lensEngage: 0.25, lensAmountFloor: 0.17, lensAmountCeil: 0.28, lensWeights: lens({ melt: 0.45, anamorphic: 0.3, glitch: 0.25 }),
    mirrorEngage: 0.2, mirrorMode: mirrorMode({ kaleido: 0.25, vortex: 0.75 }), mirrorSegments: mirrorSegs({ 4: 0.4, 6: 0.4, 8: 0.2 }),
    mirrorSpinMin: 0.05, mirrorSpinMax: 0.2, mirrorTwistMax: 0.8, mirrorMix: 0.7, mirrorBusyGain: 0.4,
    steerSpeed: 0.4, steerComplexity: 0.45, steerDensity: 0.35, steerFill: 0.4, steerContrast: 0.7,
    tempoCoupling: 0.45,
    cameraWeights: camera({ push: 0.5, cinematic: 0.15, hover: 0.15, locked: 0.1, orbit: 0.1 }),
    cameraSpeed: 0.7, cameraShake: 0.3, cameraCutRate: 0.25,
    // A small sortSlice residual — the one CALM mood besides mysterious whose lens already touches glitch,
    // so a rare harsh-directional streak isn't out of character; mosaic stays 0 (no `pixels` in the lens mix).
    transitionWeights: transitions({ smear: 0.4, dissolve: 0.15, melt: 0.2, sortSlice: 0.05, datamosh: 0.2 }),
    gradeSat: 0.88, gradeTemp: -0.1, gradeContrast: 1.15,
    traitTempo: 0.3, traitAngular: 0.7, traitBusy: 0.4, traitRadial: 0.3, traitStrength: 0.55,
    fxShock: 0.3, fxFlare: 0.2, fxSpark: 0.2, fxStrobe: 0,
  }),

  // Eerie suspension. Cool, veiled, radial: kaleidoscope at 6 / 8 segments, fan and ribs, a little pixel sort.
  mysterious: row({
    bloomBase: 0.36, bloomReact: 0.7, caBase: 0.0006, caReact: 0.8, vignette: 0.95, fogBase: 0.42,
    trailsBase: 0.85, trailsZoom: 0.9, trailsRotate: 0.9, trailsSwirl: 1.2, trailsWobble: 1, echoGate: 0.25,
    lensEngage: 0.3, lensAmountFloor: 0.16, lensAmountCeil: 0.26, lensWeights: lens({ fan: 0.4, ribs: 0.3, pixelSort: 0.2, melt: 0.1 }),
    mirrorEngage: 0.55, mirrorMode: mirrorMode({ kaleido: 0.9, vortex: 0.1 }), mirrorSegments: mirrorSegs({ 6: 0.5, 8: 0.5 }),
    mirrorSpinMin: 0.05, mirrorSpinMax: 0.3, mirrorTwistMax: 0.5, mirrorMix: 0.9, mirrorBusyGain: 0.6,
    steerSpeed: 0.3, steerComplexity: 0.55, steerDensity: 0.35, steerFill: 0.4, steerContrast: 0.55,
    tempoCoupling: 0.4,
    cameraWeights: camera({ orbit: 0.5, spiral: 0.15, topdown: 0.1, hover: 0.1, pull: 0.1, cinematic: 0.05 }),
    cameraSpeed: 0.8, cameraShake: 0.1, cameraCutRate: 0.25,
    // sortSlice residual tracks this row's own pixelSort lens share (0.2, the only CALM mood carrying it);
    // mosaic stays 0 — mysterious has no `pixels` in its lens mix, so a chunky LED read would be off-character.
    transitionWeights: transitions({ smear: 0.42, dissolve: 0.15, melt: 0.1, sortSlice: 0.08, irisWipe: 0.25 }),
    gradeSat: 0.85, gradeTemp: -0.3, gradeContrast: 1.05,
    traitTempo: 0.3, traitAngular: 0.35, traitBusy: 0.65, traitRadial: 0.85, traitStrength: 0.6,
    fxShock: 0.2, fxFlare: 0.3, fxSpark: 0.3, fxStrobe: 0,
  }),

  // The pocket. Pulse-locked and the closest to the neutral row: a steady beat echo, anamorphic glass and LED
  // pixels, orbit camera, dissolves and melts.
  groove: row({
    bloomBase: 0.47, bloomReact: 1, caBase: 0.0012, caReact: 1, vignette: 0.88, fogBase: 0.1,
    trailsBase: 0.78, trailsZoom: 1, trailsRotate: 0.8, trailsSwirl: 0.8, trailsWobble: 1, echoGate: 0.55,
    lensEngage: 0.3, lensAmountFloor: 0.17, lensAmountCeil: 0.26, lensWeights: lens({ anamorphic: 0.55, pixels: 0.45 }),
    mirrorEngage: 0.35, mirrorMode: mirrorMode({ kaleido: 0.7, vortex: 0.3 }), mirrorSegments: mirrorSegs({ 4: 0.6, 8: 0.4 }),
    mirrorSpinMin: 0.15, mirrorSpinMax: 0.4, mirrorTwistMax: 0.8, mirrorMix: 0.8, mirrorBusyGain: 0.5,
    steerSpeed: 0.5, steerComplexity: 0.5, steerDensity: 0.52, steerFill: 0.5, steerContrast: 0.55,
    tempoCoupling: 0.9,
    cameraWeights: camera({ orbit: 0.4, spiral: 0.15, push: 0.1, pull: 0.1, handheld: 0.1, hover: 0.05, topdown: 0.05, cinematic: 0.05 }),
    cameraSpeed: 1, cameraShake: 0.3, cameraCutRate: 0.5,
    // mosaic (LED pixels) fits groove's own anamorphic+pixels lens mix directly — carved out of dissolve/melt/
    // collapse, not added as extra mass. sortSlice stays 0: groove's lens never touches pixelSort or glitch.
    transitionWeights: transitions({ dissolve: 0.35, melt: 0.25, smear: 0.1, collapse: 0.05, mosaic: 0.25 }),
    gradeSat: 0.98, gradeTemp: 0.05, gradeContrast: 1.08,
    traitTempo: 0.55, traitAngular: 0.35, traitBusy: 0.5, traitRadial: 0.35, traitStrength: 0.5,
    fxShock: 0.6, fxFlare: 0.5, fxSpark: 0.7, fxStrobe: 0,
  }),

  // Bounce. Short bouncy trails with a busy beat echo, LED pixels with a light glitch, handheld camera,
  // simple bright shapes, collapse cuts, saturated and warm at flat contrast.
  playful: row({
    bloomBase: 0.5, bloomReact: 1.05, caBase: 0.001, caReact: 1, vignette: 0.8, fogBase: 0.04,
    trailsBase: 0.55, trailsZoom: 1.1, trailsRotate: 1.3, trailsSwirl: 0.7, trailsWobble: 1.5, echoGate: 0.7,
    lensEngage: 0.35, lensAmountFloor: 0.18, lensAmountCeil: 0.28, lensWeights: lens({ pixels: 0.6, glitch: 0.25, anamorphic: 0.15 }),
    mirrorEngage: 0.4, mirrorMode: mirrorMode({ kaleido: 0.85, vortex: 0.15 }), mirrorSegments: mirrorSegs({ 4: 0.5, 6: 0.5 }),
    mirrorSpinMin: 0.2, mirrorSpinMax: 0.5, mirrorTwistMax: 0.6, mirrorMix: 0.8, mirrorBusyGain: 0.6,
    steerSpeed: 0.66, steerComplexity: 0.45, steerDensity: 0.5, steerFill: 0.62, steerContrast: 0.45,
    tempoCoupling: 0.8,
    cameraWeights: camera({ handheld: 0.35, spiral: 0.2, orbit: 0.2, push: 0.1, topdown: 0.1, pull: 0.05 }),
    cameraSpeed: 1.1, cameraShake: 0.5, cameraCutRate: 0.6,
    // The highest mosaic share of any mood — playful's lens is 60% `pixels`, the top share in the table — carved
    // mostly out of collapse. A small sortSlice residual too: the only one of the three mosaic-led moods whose
    // lens also carries glitch (0.25), so an occasional harsh streak among the bounce isn't out of character.
    transitionWeights: transitions({ collapse: 0.3, melt: 0.15, dissolve: 0.1, smear: 0.05, mosaic: 0.35, sortSlice: 0.05 }),
    gradeSat: 1.15, gradeTemp: 0.25, gradeContrast: 1,
    traitTempo: 0.65, traitAngular: 0.3, traitBusy: 0.6, traitRadial: 0.35, traitStrength: 0.5,
    fxShock: 0.5, fxFlare: 0.7, fxSpark: 1, fxStrobe: 0.1,
  }),

  // Rising hope. Bright open zoom-out trails, anamorphic and fan glass, 8-segment kaleidoscope, push and spiral.
  uplifting: row({
    bloomBase: 0.62, bloomReact: 1.1, caBase: 0.0008, caReact: 1, vignette: 0.8, fogBase: 0.04,
    trailsBase: 0.9, trailsZoom: 1.5, trailsRotate: 0.7, trailsSwirl: 0.9, trailsWobble: 0.6, echoGate: 0.45,
    lensEngage: 0.3, lensAmountFloor: 0.18, lensAmountCeil: 0.28, lensWeights: lens({ anamorphic: 0.45, fan: 0.25, pixels: 0.3 }),
    mirrorEngage: 0.35, mirrorMode: mirrorMode({ kaleido: 0.9, vortex: 0.1 }), mirrorSegments: mirrorSegs({ 6: 0.2, 8: 0.8 }),
    mirrorSpinMin: 0.15, mirrorSpinMax: 0.4, mirrorTwistMax: 0.5, mirrorMix: 0.85, mirrorBusyGain: 0.5,
    steerSpeed: 0.64, steerComplexity: 0.62, steerDensity: 0.6, steerFill: 0.68, steerContrast: 0.58,
    tempoCoupling: 0.75,
    cameraWeights: camera({ push: 0.3, spiral: 0.3, orbit: 0.15, cinematic: 0.1, handheld: 0.1, pull: 0.05 }),
    cameraSpeed: 1.1, cameraShake: 0.3, cameraCutRate: 0.55,
    // mosaic carved entirely out of collapse's dominant share — uplifting's lens carries a real `pixels` slice
    // (0.3). sortSlice stays 0: no pixelSort or glitch in this row's lens at all.
    transitionWeights: transitions({ collapse: 0.18, smear: 0.2, dissolve: 0.1, melt: 0.1, mosaic: 0.22, irisWipe: 0.2 }),
    gradeSat: 1.12, gradeTemp: 0.32, gradeContrast: 1.05,
    traitTempo: 0.8, traitAngular: 0.3, traitBusy: 0.55, traitRadial: 0.5, traitStrength: 0.6,
    fxShock: 0.7, fxFlare: 1, fxSpark: 0.9, fxStrobe: 0.2,
  }),

  // Peak joy. Brightest bloom, the most saturated grade, a full-strength beat echo, the most mirrored look
  // (kaleidoscope, mix 1), fast spiral camera, collapse and melt cuts.
  euphoric: row({
    bloomBase: 0.75, bloomReact: 1.4, caBase: 0.002, caReact: 1.4, vignette: 0.8, fogBase: 0.04,
    trailsBase: 0.6, trailsZoom: 1.6, trailsRotate: 1.4, trailsSwirl: 1.3, trailsWobble: 1, echoGate: 1,
    lensEngage: 0.4, lensAmountFloor: 0.2, lensAmountCeil: 0.34, lensWeights: lens({ anamorphic: 0.4, pixels: 0.4, glitch: 0.2 }),
    mirrorEngage: 0.6, mirrorMode: mirrorMode({ kaleido: 0.85, vortex: 0.15 }), mirrorSegments: mirrorSegs({ 6: 0.4, 8: 0.6 }),
    mirrorSpinMin: 0.25, mirrorSpinMax: 0.55, mirrorTwistMax: 0.7, mirrorMix: 1, mirrorBusyGain: 0.7,
    steerSpeed: 0.78, steerComplexity: 0.78, steerDensity: 0.75, steerFill: 0.8, steerContrast: 0.7,
    tempoCoupling: 0.85,
    cameraWeights: camera({ spiral: 0.45, push: 0.2, orbit: 0.15, handheld: 0.1, topdown: 0.05, cinematic: 0.05 }),
    cameraSpeed: 1.3, cameraShake: 0.5, cameraCutRate: 0.7,
    // Secondary mosaic mood (behind groove/playful/uplifting), carved out of collapse/melt — euphoric's lens
    // still carries a real `pixels` share (0.4). A tiny sortSlice residual tracks its glitch share (0.2).
    transitionWeights: transitions({ collapse: 0.32, melt: 0.2, smear: 0.1, mosaic: 0.18, sortSlice: 0.03, irisWipe: 0.17 }),
    gradeSat: 1.25, gradeTemp: 0.2, gradeContrast: 1.1,
    traitTempo: 0.9, traitAngular: 0.4, traitBusy: 0.85, traitRadial: 0.8, traitStrength: 0.7,
    fxShock: 1.3, fxFlare: 1.4, fxSpark: 1.3, fxStrobe: 0.6,
  }),

  // Relentless. Forward-zoom crisp feedback, pixel sort + glitch, vortex only, fast pushing camera, collapse cuts.
  driving: row({
    bloomBase: 0.62, bloomReact: 1.2, caBase: 0.0025, caReact: 1.6, vignette: 0.9, fogBase: 0.04,
    trailsBase: 0.5, trailsZoom: 1.8, trailsRotate: 0.5, trailsSwirl: 0.4, trailsWobble: 0.6, echoGate: 0.8,
    lensEngage: 0.5, lensAmountFloor: 0.22, lensAmountCeil: 0.36, lensWeights: lens({ pixelSort: 0.45, glitch: 0.4, pixels: 0.1, anamorphic: 0.05 }),
    mirrorEngage: 0.2, mirrorMode: mirrorMode({ vortex: 1 }), mirrorSegments: mirrorSegs({ 4: 1, 6: 1, 8: 1 }),
    mirrorSpinMin: 0.3, mirrorSpinMax: 0.6, mirrorTwistMax: 1, mirrorMix: 0.8, mirrorBusyGain: 0.3,
    steerSpeed: 0.78, steerComplexity: 0.7, steerDensity: 0.65, steerFill: 0.65, steerContrast: 0.72,
    tempoCoupling: 1,
    cameraWeights: camera({ push: 0.6, handheld: 0.15, spiral: 0.1, topdown: 0.1, orbit: 0.05 }),
    cameraSpeed: 1.5, cameraShake: 0.4, cameraCutRate: 0.75,
    // sortSlice carved out of collapse's dominant share (0.85 -> 0.45) — driving's pixelSort lens share (0.45)
    // is the second-highest of any mood after aggressive. A small mosaic residual too: the only one of the
    // three harsh moods whose lens still carries a `pixels` sliver (0.1).
    transitionWeights: transitions({ collapse: 0.25, melt: 0.1, dissolve: 0.05, sortSlice: 0.35, mosaic: 0.05, datamosh: 0.2 }),
    gradeSat: 1.1, gradeTemp: -0.05, gradeContrast: 1.15,
    traitTempo: 0.9, traitAngular: 0.8, traitBusy: 0.6, traitRadial: 0.2, traitStrength: 0.75,
    fxShock: 1, fxFlare: 0.6, fxSpark: 1, fxStrobe: 0.5,
  }),

  // On edge. The darkest edges (with brooding) and the most chromatic aberration after aggressive, wobble x1.6,
  // jittery handheld camera at full shake, cool desaturated grade at high contrast, glitch + pixel sort + melt,
  // tight vortex.
  tense: row({
    bloomBase: 0.5, bloomReact: 1, caBase: 0.003, caReact: 1.5, vignette: 0.98, fogBase: 0.14,
    trailsBase: 0.4, trailsZoom: 0.9, trailsRotate: 1.1, trailsSwirl: 0.8, trailsWobble: 1.6, echoGate: 0.5,
    lensEngage: 0.5, lensAmountFloor: 0.22, lensAmountCeil: 0.36, lensWeights: lens({ glitch: 0.4, pixelSort: 0.4, melt: 0.2 }),
    mirrorEngage: 0.3, mirrorMode: mirrorMode({ vortex: 1 }), mirrorSegments: mirrorSegs({ 4: 1, 6: 1, 8: 1 }),
    mirrorSpinMin: 0.2, mirrorSpinMax: 0.5, mirrorTwistMax: 1.2, mirrorMix: 0.7, mirrorBusyGain: 0.4,
    steerSpeed: 0.55, steerComplexity: 0.75, steerDensity: 0.6, steerFill: 0.5, steerContrast: 0.8,
    tempoCoupling: 0.7,
    cameraWeights: camera({ handheld: 0.55, push: 0.2, locked: 0.1, topdown: 0.1, orbit: 0.05 }),
    cameraSpeed: 1, cameraShake: 1, cameraCutRate: 0.6,
    // sortSlice takes tense's whole (small) collapse share, plus a trim off smear, to reach a real presence —
    // tense's lens is 40% pixelSort. mosaic stays 0: no `pixels` anywhere in this row's lens mix.
    transitionWeights: transitions({ smear: 0.35, dissolve: 0.1, melt: 0.1, sortSlice: 0.25, datamosh: 0.2 }),
    gradeSat: 0.85, gradeTemp: -0.2, gradeContrast: 1.2,
    traitTempo: 0.7, traitAngular: 0.85, traitBusy: 0.8, traitRadial: 0.25, traitStrength: 0.65,
    fxShock: 0.8, fxFlare: 0.3, fxSpark: 0.6, fxStrobe: 0.3,
  }),

  // Harsh. Crispest frame (least feedback), the strongest lens at its highest amount range, pixel sort first,
  // a rare vortex-only mirror, handheld at 1.4x with 1.4 shake, a hot high-contrast grade, and the highest odds
  // of shock and spark effects.
  aggressive: row({
    bloomBase: 0.68, bloomReact: 1.35, caBase: 0.0035, caReact: 2, vignette: 0.92, fogBase: 0,
    trailsBase: 0.3, trailsZoom: 1.2, trailsRotate: 0.8, trailsSwirl: 0.4, trailsWobble: 1.3, echoGate: 0.9,
    lensEngage: 0.65, lensAmountFloor: 0.28, lensAmountCeil: 0.42, lensWeights: lens({ pixelSort: 0.55, glitch: 0.35, melt: 0.1 }),
    mirrorEngage: 0.15, mirrorMode: mirrorMode({ vortex: 1 }), mirrorSegments: mirrorSegs({ 4: 1, 6: 1, 8: 1 }),
    mirrorSpinMin: 0.3, mirrorSpinMax: 0.65, mirrorTwistMax: 1.3, mirrorMix: 0.6, mirrorBusyGain: 0.2,
    steerSpeed: 0.74, steerComplexity: 0.78, steerDensity: 0.74, steerFill: 0.7, steerContrast: 0.84,
    tempoCoupling: 1,
    cameraWeights: camera({ handheld: 0.6, push: 0.2, topdown: 0.1, spiral: 0.05, orbit: 0.05 }),
    cameraSpeed: 1.4, cameraShake: 1.4, cameraCutRate: 0.9,
    // The strongest sortSlice of any mood, carved entirely out of collapse (0.65 -> 0.25, melt untouched) —
    // aggressive's lens is 55% pixelSort, the highest share in the table. mosaic stays 0: no `pixels` at all here.
    transitionWeights: transitions({ collapse: 0.15, melt: 0.35, sortSlice: 0.4, datamosh: 0.1 }),
    gradeSat: 1.2, gradeTemp: 0.35, gradeContrast: 1.25,
    traitTempo: 0.95, traitAngular: 0.95, traitBusy: 0.8, traitRadial: 0.15, traitStrength: 0.8,
    fxShock: 1.5, fxFlare: 0.9, fxSpark: 1.2, fxStrobe: 0.7,
  }),

  // Grand. Big bloom, zoom-out trails, anamorphic glass, kaleidoscope at 6 / 8, cinematic camera, smear and collapse.
  epic: row({
    bloomBase: 0.66, bloomReact: 1.3, caBase: 0.002, caReact: 1.3, vignette: 0.9, fogBase: 0.16,
    trailsBase: 0.7, trailsZoom: 1.5, trailsRotate: 0.7, trailsSwirl: 1, trailsWobble: 0.5, echoGate: 0.5,
    lensEngage: 0.4, lensAmountFloor: 0.2, lensAmountCeil: 0.34, lensWeights: lens({ anamorphic: 0.7, melt: 0.15, pixels: 0.15 }),
    mirrorEngage: 0.5, mirrorMode: mirrorMode({ kaleido: 0.9, vortex: 0.1 }), mirrorSegments: mirrorSegs({ 6: 0.5, 8: 0.5 }),
    mirrorSpinMin: 0.1, mirrorSpinMax: 0.35, mirrorTwistMax: 0.6, mirrorMix: 0.8, mirrorBusyGain: 0.6,
    steerSpeed: 0.6, steerComplexity: 0.7, steerDensity: 0.68, steerFill: 0.82, steerContrast: 0.65,
    tempoCoupling: 0.6,
    cameraWeights: camera({ cinematic: 0.5, pull: 0.2, push: 0.15, orbit: 0.1, spiral: 0.05 }),
    cameraSpeed: 1, cameraShake: 0.15, cameraCutRate: 0.35,
    // A small mosaic residual — epic's lens still carries a `pixels` sliver (0.15) — carved off smear/collapse.
    // sortSlice stays 0: no pixelSort or glitch in this row's lens at all.
    transitionWeights: transitions({ smear: 0.25, collapse: 0.2, dissolve: 0.1, melt: 0.05, mosaic: 0.05, irisWipe: 0.35 }),
    gradeSat: 1.1, gradeTemp: 0.15, gradeContrast: 1.15,
    traitTempo: 0.55, traitAngular: 0.5, traitBusy: 0.65, traitRadial: 0.85, traitStrength: 0.6,
    fxShock: 1.3, fxFlare: 1.4, fxSpark: 1.1, fxStrobe: 0.5,
  }),
}
