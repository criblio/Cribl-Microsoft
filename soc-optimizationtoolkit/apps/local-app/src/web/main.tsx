// Local-shell web entry: mounts the LocalApp root under React StrictMode.
// Stylesheet order matters: the shared @soc/ui class conventions first, then
// the shell-specific page chrome.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LocalApp } from './local-app';
import '@xyflow/react/dist/style.css';
import '@soc/ui/styles.css';
import './local.css';

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('index.html is missing the #root element');
}
createRoot(rootElement).render(
  <StrictMode>
    <LocalApp />
  </StrictMode>
);
