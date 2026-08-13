import { Stage } from '../engine/Stage'
import { TacticalHUD } from '../ui/TacticalHUD'
import { HUD } from '../ui/HUD'

export function Visualizer() {
  return (
    <div className="app">
      <Stage />
      <TacticalHUD />
      <HUD />
    </div>
  )
}
