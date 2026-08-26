import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applyUrlParams } from './urlParams'
import { installMirrorHook, startLink } from './engine/outputLink'
import './styles.css'
import './styles/marketing.css'
import './styles/console.css'

applyUrlParams()
// Both before React, deliberately.
//
// The mirror hook has to exist before the output window is ever opened: that
// window publishes its canvas as soon as it has drawn, and a hook installed
// later would miss the call. The channel has to be joined before the first
// render for the same reason in the other direction — an output window opens
// on whatever `persist` restored until the control window answers its hello.
installMirrorHook()
startLink()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
