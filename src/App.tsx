import { Stage } from './engine/Stage'
import { TacticalHUD } from './ui/TacticalHUD'
import { HUD } from './ui/HUD'
//hello
export default function App() {
  return (
    <div className="app">
      <Stage />
      <TacticalHUD />
      <HUD />
    </div>
  )
}
