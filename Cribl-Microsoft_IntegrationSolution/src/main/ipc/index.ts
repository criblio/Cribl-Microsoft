import { IpcMain, BrowserWindow } from 'electron';
import { HANDLER_MODULES } from '../../api/registry';
import { initAppPaths } from './app-paths';
import { performFullSync } from './registry-sync';
import { runChangeDetection } from './change-detection';
import { autoUpdate as autoUpdateRepo } from './sentinel-repo';
import { autoUpdateElasticRepo } from './sample-resolver';

export function registerIpcHandlers(ipcMain: IpcMain) {
  // Initialize app data directories and bundle templates if repo is detected
  initAppPaths();

  // Register every handler module from the single shared registry (same list the web
  // server uses in src/server/api-router.ts).
  for (const mod of HANDLER_MODULES) {
    mod.register(ipcMain);
  }

  // Broadcast a startup log message to the renderer
  function startupLog(message: string, level: 'info' | 'error' = 'info') {
    console.log(`[startup] ${message}`);
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('startup:log', { message, level, timestamp: Date.now() });
      }
    }
  }

  // Startup background tasks:
  // 1. Auto-update local Sentinel repo clone if stale (>12h)
  // 2. Auto-clone/update Elastic integrations repo if stale (>12h)
  // 3. Sync registry from local clone
  // 4. Run change detection
  setTimeout(async () => {
    try {
      await autoUpdateRepo();
      startupLog('Sentinel repo ready');
    } catch (err) {
      startupLog(`Sentinel repo update failed: ${err instanceof Error ? err.message : err}`, 'error');
    }
    try {
      const elasticOk = await autoUpdateElasticRepo();
      if (elasticOk) {
        startupLog('Elastic integrations repo ready');
      } else {
        startupLog('Elastic integrations repo up to date');
      }
    } catch (err) {
      startupLog(`Elastic integrations repo failed: ${err instanceof Error ? err.message : err}`, 'error');
    }
    try {
      await performFullSync({ forceRefresh: false });
    } catch {
      // Non-fatal
    }
    try {
      await runChangeDetection();
    } catch {
      // Non-fatal
    }
  }, 3000);
}
