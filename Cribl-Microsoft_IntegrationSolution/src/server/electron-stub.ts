// Electron API stubs for running outside Electron (web server mode).
// Modules that import from 'electron' will get these stubs instead.
// Only used when running via tsx/node, not in actual Electron.

export const app = {
  isReady: () => true,
  isPackaged: false,
  whenReady: () => Promise.resolve(),
  on: () => {},
  quit: () => {},
  getPath: (name: string) => {
    const appData = process.env.APPDATA || process.env.HOME || '/tmp';
    return appData;
  },
};

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (str: string) => Buffer.from(str),
  decryptString: (buf: Buffer) => buf.toString(),
};

export const BrowserWindow = {
  getAllWindows: () => [],
  getFocusedWindow: () => null,
};

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
};

export const ipcMain = {
  handle: () => {},
  on: () => {},
  once: () => {},
  removeHandler: () => {},
};

export const ipcRenderer = {
  invoke: () => Promise.resolve(null),
  on: () => {},
  removeListener: () => {},
};

export const contextBridge = {
  exposeInMainWorld: () => {},
};

// CJS compatibility -- ensure require('electron').app works
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { app, safeStorage, BrowserWindow, dialog, ipcMain, ipcRenderer, contextBridge };
  module.exports.default = module.exports;
}
