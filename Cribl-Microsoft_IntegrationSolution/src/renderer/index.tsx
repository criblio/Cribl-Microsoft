import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter, BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles/global.css';
import { createApiClient } from './api-client';

// Detect if running in Electron or web browser
const isElectron = !!(window as any).api;

// In web mode, create the API client and attach it to window.api
// so all existing components work without modification
if (!isElectron) {
  (window as any).api = createApiClient();
}

// Use BrowserRouter for web mode, HashRouter for Electron
const Router = isElectron ? HashRouter : BrowserRouter;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Router>
      <App />
    </Router>
  </React.StrictMode>
);
