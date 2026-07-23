import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
// React Flow base styles (architecture data-flow canvas) first, then the
// shared @soc/ui class conventions (which override .arch-flow-*), then the
// shell-specific chrome.
import '@xyflow/react/dist/style.css'
import '@soc/ui/styles.css'
import './App.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
