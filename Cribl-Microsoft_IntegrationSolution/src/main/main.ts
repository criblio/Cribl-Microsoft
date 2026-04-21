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

app.whenReady().then(() => {
  registerIpcHandlers(ipcMain);
  if (!app.isPackaged) {
    try {
      const { startDevServer } = await import('./dev-server');
      startDevServer();
    } catch { /* dev-server.ts only exists on dev workstations */ }
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
