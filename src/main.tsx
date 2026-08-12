import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applyUrlParams } from './urlParams'
import './styles.css'
import './styles/marketing.css'

applyUrlParams()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
