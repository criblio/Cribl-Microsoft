// Electron main process = the desktop composition root. In Phase 1 it constructs the
// concrete adapters and injects them into core usecases, then exposes them over IPC.
// Phase 0: just open a stub window so the launcher (Start-App-Windows.bat) works end to end.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    title: 'SOC Optimization Toolkit for Microsoft Sentinel',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
