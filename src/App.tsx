import { useState } from 'react'
import { isMobileDevice, supportsWebGL2 } from './audio/capabilities'
import { Stage } from './engine/Stage'
import { TacticalHUD } from './ui/TacticalHUD'
import { HUD } from './ui/HUD'
import { UnsupportedScreen } from './ui/UnsupportedScreen'

export default function App() {
  // Checked once per load, not on resize — a phone rotated to landscape is
  // still a phone. Lazy initializer keeps the (cheap but non-trivial) checks
  // out of the render path on every re-render.
  const [gate] = useState<'mobile' | 'webgl' | null>(() => {
    if (isMobileDevice(navigator)) return 'mobile'
    if (!supportsWebGL2()) return 'webgl'
    return null
  })

  if (gate) return <UnsupportedScreen reason={gate} />

  return (
    <div className="app">
      <Stage />
      <TacticalHUD />
      <HUD />
    </div>
  )
}
