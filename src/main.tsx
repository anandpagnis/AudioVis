import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applyUrlParams } from './urlParams'
import { installMirrorHook, isDemoWindow, startLink } from './engine/outputLink'
import { initAuth } from './auth/authStore'
import { initAnalytics } from './lib/posthogClient'
import './styles.css'
import './styles/marketing.css'
import './styles/home.css'
import './styles/account.css'
import './styles/accountMenu.css'
import './styles/sign-in.css'
import './styles/help.css'
import './styles/demo.css'
import './styles/console.css'

applyUrlParams()
// Both before React, deliberately.
//
// The mirror hook has to exist before the output window is ever opened: that
// window publishes its canvas as soon as it has drawn, and a hook installed
// later would miss the call. The channel has to be joined before the first
// render for the same reason in the other direction — an output window opens
// on whatever `persist` restored until the control window answers its hello.
//
// Skipped entirely on /demo: that window is not a controller (see
// isDemoWindow's doc) and must never announce itself as one over the shared
// BroadcastChannel — a demo tab open alongside a real DJ's control window, in
// another tab of the same browser, could otherwise win the controller
// election and hijack their output window's look state.
if (!isDemoWindow()) {
  installMirrorHook()
  startLink()
}
initAuth()
initAnalytics()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
