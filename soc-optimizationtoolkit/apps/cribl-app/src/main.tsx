import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
// Shared @soc/ui class conventions first, then the shell-specific chrome.
import '@soc/ui/styles.css'
import './App.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
