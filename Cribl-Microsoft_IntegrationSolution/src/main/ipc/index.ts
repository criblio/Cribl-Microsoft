import { IpcMain, BrowserWindow } from 'electron';
import { initAppPaths, registerAppPathsHandlers } from './app-paths';
import { registerPowerShellHandlers } from './powershell';
import { registerConfigHandlers } from './config';
import { registerGitHubHandlers } from './github';
import { registerPackBuilderHandlers } from './pack-builder';
import { registerDepsHandlers } from './deps';
import { registerVendorResearchHandlers } from './vendor-research';
import { registerRegistrySyncHandlers, performFullSync } from './registry-sync';
import { registerChangeDetectionHandlers, runChangeDetection } from './change-detection';
import { registerAzureDeployHandlers } from './azure-deploy';
import { registerParamFormHandlers } from './param-forms';
import { registerAuthHandlers } from './auth';
import { registerE2EHandlers } from './e2e-orchestrator';
import { registerSentinelRepoHandlers, autoUpdate as autoUpdateRepo } from './sentinel-repo';
import { registerSampleParserHandlers } from './sample-parser';
import { registerPermissionCheckHandlers } from './permission-check';
import { registerDefaultSampleHandlers } from './default-samples';
import { registerFieldMatcherHandlers } from './field-matcher';
import { registerSiemMigrationHandlers } from './siem-migration';
import { autoUpdateElasticRepo, registerSampleResolverHandlers } from './sample-resolver';

export function registerIpcHandlers(ipcMain: IpcMain) {
  // Initialize app data directories and bundle templates if repo is detected
  initAppPaths();

  registerAppPathsHandlers(ipcMain);
  registerDepsHandlers(ipcMain);
  registerPowerShellHandlers(ipcMain);
  registerConfigHandlers(ipcMain);
  registerGitHubHandlers(ipcMain);
  registerPackBuilderHandlers(ipcMain);
  registerVendorResearchHandlers(ipcMain);
  registerRegistrySyncHandlers(ipcMain);
  registerChangeDetectionHandlers(ipcMain);
  registerAzureDeployHandlers(ipcMain);
  registerParamFormHandlers(ipcMain);
  registerAuthHandlers(ipcMain);
  registerE2EHandlers(ipcMain);
  registerSentinelRepoHandlers(ipcMain);
  registerSampleParserHandlers(ipcMain);
  registerPermissionCheckHandlers(ipcMain);
  registerDefaultSampleHandlers(ipcMain);
  registerFieldMatcherHandlers(ipcMain);
  registerSiemMigrationHandlers(ipcMain);
  registerSampleResolverHandlers(ipcMain);

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
