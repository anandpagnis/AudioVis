interface UnsupportedScreenProps {
  reason: 'mobile' | 'webgl'
}

/**
 * Full-app gate for environments the engine cannot run in at all — rendered
 * instead of Stage/HUD so nothing spins up an audio graph or a WebGL context
 * that would immediately fail. Distinct from the start card's per-source
 * capability messaging (HUD.tsx), which handles browsers that CAN run the
 * app but can't do one particular audio source.
 */
export function UnsupportedScreen({ reason }: UnsupportedScreenProps) {
  return (
    <div className="overlay">
      <div className="start-card glass">
        <h1>AudioVis</h1>
        <p className="tagline">Real-time generative visuals, driven by your music.</p>
        <p className="error">
          {reason === 'mobile'
            ? "AudioVis isn't available on mobile yet — it needs a desktop browser to capture audio and drive the GPU visuals."
            : "Your browser doesn't support WebGL2, which AudioVis requires to render."}
        </p>
        <p className="hint">
          {reason === 'mobile'
            ? 'Open this link on a laptop or desktop computer, in Chrome or Edge, to run it.'
            : 'Try the latest Chrome, Edge, or Firefox on a desktop computer.'}
        </p>
      </div>
    </div>
  )
}
