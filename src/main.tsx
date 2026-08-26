import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applyUrlParams } from './urlParams'
import { startProjectorLink } from './engine/projector'
import './styles.css'
import './styles/marketing.css'

applyUrlParams()
// Before React, deliberately. A projector window's join has to reach the
// leader early enough that the answer beats the first render, or the output
// window opens on boot defaults and stays there. See engine/projector.ts.
startProjectorLink()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
