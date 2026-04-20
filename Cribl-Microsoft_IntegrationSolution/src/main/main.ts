import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { registerIpcHandlers } from './ipc/index';
import { startDevServer } from './dev-server';

let mainWindow: BrowserWindow | null = null;

const DIST = path.join(__dirname, '..');
const RENDERER_DEV_URL = process.env.VITE_DEV_SERVER_URL;
const RENDERER_DIST = path.join(DIST, '../dist');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: 'Cribl SOC Optimization Toolkit for Microsoft Sentinel',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (RENDERER_DEV_URL) {
    mainWindow.loadURL(RENDERER_DEV_URL);
  } else {
    mainWindow.loadFile(path.join(RENDERER_DIST, 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  registerIpcHandlers(ipcMain);
  // Dev-only: start the localhost diagnostic HTTP server used by tests/debugging.
  // Never runs in packaged builds (no need for a sidecar HTTP server in production).
  if (!app.isPackaged) {
    startDevServer();
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
