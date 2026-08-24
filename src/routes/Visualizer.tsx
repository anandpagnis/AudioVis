import { Stage } from '../engine/Stage'
import { HUD } from '../ui/HUD'

export function Visualizer() {
  return (
    <div className="app">
      <Stage />
      <HUD />
    </div>
  )
}
