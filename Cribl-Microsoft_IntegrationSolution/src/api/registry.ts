// Handler-module registry -- the single ordered list of IPC handler modules.
//
// Both transports consume this list: the Electron main process (src/main/ipc/index.ts) and
// the web server (src/server/api-router.ts). Driving both from one array makes the two
// registration lists impossible to drift apart (the bug that previously left 7 channels
// 404ing in web mode). Add a new handler module here exactly once.
//
// Renderer code must never import this file -- it pulls in every main-process handler module.

import type { IpcMain } from 'electron';

import { registerAppPathsHandlers } from '../main/ipc/app-paths';
import { registerDepsHandlers } from '../main/ipc/deps';
import { registerPowerShellHandlers } from '../main/ipc/powershell';
import { registerConfigHandlers } from '../main/ipc/config';
import { registerGitHubHandlers } from '../main/ipc/github';
import { registerPackBuilderHandlers } from '../main/ipc/pack-builder';
import { registerVendorResearchHandlers } from '../main/ipc/vendor-research';
import { registerRegistrySyncHandlers } from '../main/ipc/registry-sync';
import { registerChangeDetectionHandlers } from '../main/ipc/change-detection';
import { registerAzureDeployHandlers } from '../main/ipc/azure-deploy';
import { registerParamFormHandlers } from '../main/ipc/param-forms';
import { registerAuthHandlers } from '../main/ipc/auth';
import { registerE2EHandlers } from '../main/ipc/e2e-orchestrator';
import { registerSentinelRepoHandlers } from '../main/ipc/sentinel-repo';
import { registerSampleParserHandlers } from '../main/ipc/sample-parser';
import { registerPermissionCheckHandlers } from '../main/ipc/permission-check';
import { registerDefaultSampleHandlers } from '../main/ipc/default-samples';
import { registerFieldMatcherHandlers } from '../main/ipc/field-matcher';
import { registerSiemMigrationHandlers } from '../main/ipc/siem-migration';
import { registerSampleResolverHandlers } from '../main/ipc/sample-resolver';

export interface ModuleRegistration {
  /** Short module name, matching the source file (e.g. 'pack-builder'). */
  name: string;
  /** Registers this module's ipcMain.handle() channels. */
  register: (ipcMain: IpcMain) => void;
}

// Order is cosmetic (channel names are unique), but preserved from the original index.ts.
export const HANDLER_MODULES: readonly ModuleRegistration[] = [
  { name: 'app-paths', register: registerAppPathsHandlers },
  { name: 'deps', register: registerDepsHandlers },
  { name: 'powershell', register: registerPowerShellHandlers },
  { name: 'config', register: registerConfigHandlers },
  { name: 'github', register: registerGitHubHandlers },
  { name: 'pack-builder', register: registerPackBuilderHandlers },
  { name: 'vendor-research', register: registerVendorResearchHandlers },
  { name: 'registry-sync', register: registerRegistrySyncHandlers },
  { name: 'change-detection', register: registerChangeDetectionHandlers },
  { name: 'azure-deploy', register: registerAzureDeployHandlers },
  { name: 'param-forms', register: registerParamFormHandlers },
  { name: 'auth', register: registerAuthHandlers },
  { name: 'e2e', register: registerE2EHandlers },
  { name: 'sentinel-repo', register: registerSentinelRepoHandlers },
  { name: 'sample-parser', register: registerSampleParserHandlers },
  { name: 'permission-check', register: registerPermissionCheckHandlers },
  { name: 'default-samples', register: registerDefaultSampleHandlers },
  { name: 'field-matcher', register: registerFieldMatcherHandlers },
  { name: 'siem-migration', register: registerSiemMigrationHandlers },
  { name: 'sample-resolver', register: registerSampleResolverHandlers },
];
