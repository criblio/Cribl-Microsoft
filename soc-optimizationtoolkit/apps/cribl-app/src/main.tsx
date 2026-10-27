import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PollRegistryProvider } from '@soc/ui'
import App from './App'
// React Flow base styles (architecture data-flow canvas) first, then the
// shared @soc/ui class conventions (which override .arch-flow-*), then the
// shell-specific chrome.
import '@xyflow/react/dist/style.css'
import '@soc/ui/styles.css'
import './App.css'

// PollRegistryProvider wraps <App/> so that App's own useConsolidatedPolling
// call sits INSIDE the provider and sees every poll a screen registers
// (useMergedPolls). A screen poll registered outside it would never run.
// A duplicate poll id throws in development and logs in production.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PollRegistryProvider duplicates={import.meta.env.DEV ? 'throw' : 'log'}>
      <App />
    </PollRegistryProvider>
  </StrictMode>,
)
