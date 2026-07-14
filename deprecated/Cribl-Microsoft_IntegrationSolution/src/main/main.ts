import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { registerIpcHandlers } from './ipc/index';

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

app.whenReady().then(async () => {
  registerIpcHandlers(ipcMain);
  if (!app.isPackaged) {
    try {
      // Dynamic path prevents Vite from resolving at build time.
      // dev-server.ts only exists on dev workstations (gitignored).
      const mod = './dev-' + 'server';
      const { startDevServer } = await import(/* @vite-ignore */ mod);
      startDevServer();
    } catch { /* dev-server.ts not present -- skip */ }
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
