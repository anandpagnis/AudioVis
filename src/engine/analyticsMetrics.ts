import type { AudioFeatures } from '../audio/types'
import { RollingWindow } from './RollingWindow'

/** Rolling accuracy/confidence trends behind the live Analytics panel. */
export const analytics = {
  bpmAccuracy: new RollingWindow(30),
  moodConfidence: new RollingWindow(30),
  moodAmbiguity: new RollingWindow(30),
  sectionStrength: new RollingWindow(30),
}

/**
 * Feeds the rolling analytics windows once per frame. Called from
 * SceneManager rather than AudioEngine.update() itself — `src/audio` has zero
 * dependency on `src/engine` by design (portability), and this is engine-side
 * instrumentation, not analysis.
 */
export function sampleAnalytics(f: AudioFeatures): void {
  analytics.bpmAccuracy.push(f.time, f.beatGridAccuracy)
  analytics.moodConfidence.push(f.time, f.mood.confidence)
  analytics.moodAmbiguity.push(f.time, f.mood.ambiguity)
  if (f.sectionChangeStrength > 0) analytics.sectionStrength.push(f.time, f.sectionChangeStrength)
}
