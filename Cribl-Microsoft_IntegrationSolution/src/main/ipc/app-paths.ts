// App Paths Module
// Centralizes all file path resolution for the solution.
// The app is fully standalone -- all data lives in %APPDATA%/.cribl-microsoft/.
// An optional repo link provides access to PowerShell scripts for DCR deployment.
//
// Data layout:
//   %APPDATA%/.cribl-microsoft/
//     config/                    - azure-parameters.json, operation-parameters.json, etc.
//     packs/                     - Built Cribl packs and .crbl files
//     dcr-templates/             - Bundled DCR ARM template schemas
//     sentinel-repo/             - Local clone of Azure-Sentinel
//     vendor-cache/              - Cached vendor research data
//     registry-cache/            - Dynamic solution registry
//     change-detection/          - Build snapshots and alerts
//     auth/                      - Encrypted Cribl credentials

import fs from 'fs';
import path from 'path';
let app: { isPackaged?: boolean } = {};
try { app = require('electron').app || {}; } catch { /* web mode */ }

// ---------------------------------------------------------------------------
// Base Directories
// ---------------------------------------------------------------------------

function getAppDataRoot(): string {
  const appData = process.env.APPDATA || process.env.HOME || '';
  return path.join(appData, '.cribl-microsoft');
}

const DIRS = {
  config: 'config',
  packs: 'packs',
  dcrTemplates: 'dcr-templates',
  sentinelRepo: 'sentinel-repo',
  vendorCache: 'vendor-cache',
  registryCache: 'registry-cache',
  changeDetection: 'change-detection',
  auth: 'auth',
} as const;

// Ensure all directories exist
function ensureDirectories(): void {
  const root = getAppDataRoot();
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  for (const subdir of Object.values(DIRS)) {
    const dirPath = path.join(root, subdir);
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Public Path Getters
// ---------------------------------------------------------------------------

export function appDataRoot(): string {
  return getAppDataRoot();
}

export function configDir(): string {
  return path.join(getAppDataRoot(), DIRS.config);
}

export function packsDir(): string {
  return path.join(getAppDataRoot(), DIRS.packs);
}

export function dcrTemplatesDir(): string {
  return path.join(getAppDataRoot(), DIRS.dcrTemplates);
}

export function sentinelRepoDir(): string {
  return path.join(getAppDataRoot(), DIRS.sentinelRepo);
}

export function vendorCacheDir(): string {
  return path.join(getAppDataRoot(), DIRS.vendorCache);
}

export function registryCacheDir(): string {
  return path.join(getAppDataRoot(), DIRS.registryCache);
}

export function changeDetectionDir(): string {
  return path.join(getAppDataRoot(), DIRS.changeDetection);
}

export function authDir(): string {
  return path.join(getAppDataRoot(), DIRS.auth);
}

// ---------------------------------------------------------------------------
// Config File Paths
// ---------------------------------------------------------------------------

export function azureParametersPath(): string {
  return path.join(configDir(), 'azure-parameters.json');
}

export function operationParametersPath(): string {
  return path.join(configDir(), 'operation-parameters.json');
}

export function criblParametersPath(): string {
  return path.join(configDir(), 'cribl-parameters.json');
}

// Read a config file, return {} if it doesn't exist
export function readConfig(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { return {}; }
}

// Write a config file, preserving existing keys not in the update
export function writeConfig(filePath: string, data: Record<string, unknown>): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Optional Repo Link
// The solution can optionally link to a cloned copy of the Cribl-Microsoft
// repo to access PowerShell scripts for DCR deployment. This is NOT required
// for pack building, vendor research, or Cribl API operations.
// ---------------------------------------------------------------------------

let _linkedRepoPath: string | null = null;

function getLinkedRepoConfigPath(): string {
  return path.join(configDir(), 'linked-repo.json');
}

export function getLinkedRepo(): string | null {
  if (_linkedRepoPath) return _linkedRepoPath;

  // Check saved config
  const configPath = getLinkedRepoConfigPath();
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.repoPath && fs.existsSync(path.join(config.repoPath, 'Azure', 'CustomDeploymentTemplates'))) {
        _linkedRepoPath = config.repoPath;
        return _linkedRepoPath;
      }
    } catch { /* corrupt config */ }
  }

  // Auto-detect: walk up from the app's executable location
  let dir = app?.isPackaged ? path.dirname(process.execPath) : __dirname;
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (
      fs.existsSync(path.join(dir, 'Azure', 'CustomDeploymentTemplates')) &&
      fs.existsSync(path.join(dir, 'README.md'))
    ) {
      _linkedRepoPath = dir;
      // Save for next time
      setLinkedRepo(dir);
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

export function setLinkedRepo(repoPath: string | null): void {
  _linkedRepoPath = repoPath;
  const configPath = getLinkedRepoConfigPath();
  if (repoPath) {
    writeConfig(configPath, { repoPath });
  } else if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath);
  }
}

export function isRepoLinked(): boolean {
  return getLinkedRepo() !== null;
}

// Get a path within the linked repo (returns null if no repo linked)
export function repoPath(...segments: string[]): string | null {
  const repo = getLinkedRepo();
  if (!repo) return null;
  return path.join(repo, ...segments);
}

// Get the DCR Automation script path (null if no repo)
export function dcrAutomationScript(): string | null {
  return repoPath('Azure', 'CustomDeploymentTemplates', 'DCR-Automation', 'Run-DCRAutomation.ps1');
}

// Get the DCR Automation working directory (null if no repo)
export function dcrAutomationCwd(): string | null {
  return repoPath('Azure', 'CustomDeploymentTemplates', 'DCR-Automation');
}

// ---------------------------------------------------------------------------
// DCR Template Schema Bundling
// When the app first links to a repo (or on first run), copy DCR template
// schemas into the app data so they're available even without the repo.
// ---------------------------------------------------------------------------

export function bundleDcrTemplates(): number {
  const repo = getLinkedRepo();
  if (!repo) return 0;

  const sourceDir = path.join(repo, 'Azure', 'CustomDeploymentTemplates', 'DCR-Templates', 'SentinelNativeTables');
  const destDir = dcrTemplatesDir();

  if (!fs.existsSync(sourceDir)) return 0;

  let count = 0;
  const subDirs = ['DataCollectionRules(DCE)', 'DataCollectionRules(NoDCE)'];

  for (const subDir of subDirs) {
    const srcSubDir = path.join(sourceDir, subDir);
    const dstSubDir = path.join(destDir, subDir);

    if (!fs.existsSync(srcSubDir)) continue;
    if (!fs.existsSync(dstSubDir)) fs.mkdirSync(dstSubDir, { recursive: true });

    for (const file of fs.readdirSync(srcSubDir)) {
      if (!file.endsWith('.json')) continue;
      const srcFile = path.join(srcSubDir, file);
      const dstFile = path.join(dstSubDir, file);
      // Only copy if newer or doesn't exist
      if (!fs.existsSync(dstFile) || fs.statSync(srcFile).mtimeMs > fs.statSync(dstFile).mtimeMs) {
        fs.copyFileSync(srcFile, dstFile);
        count++;
      }
    }
  }

  // Also copy custom table schemas if they exist
  const customSchemaDir = path.join(repo, 'Azure', 'CustomDeploymentTemplates', 'DCR-Automation', 'core', 'custom-table-schemas');
  if (fs.existsSync(customSchemaDir)) {
    const dstCustomDir = path.join(destDir, 'custom-table-schemas');
    if (!fs.existsSync(dstCustomDir)) fs.mkdirSync(dstCustomDir, { recursive: true });
    for (const file of fs.readdirSync(customSchemaDir)) {
      if (!file.endsWith('.json')) continue;
      fs.copyFileSync(path.join(customSchemaDir, file), path.join(dstCustomDir, file));
      count++;
    }
  }

  return count;
}

// Migrate config files from repo to app data (one-time on first link)
export function migrateRepoConfigs(): void {
  const repo = getLinkedRepo();
  if (!repo) return;

  const migrations: Array<{ src: string; dst: string }> = [
    {
      src: path.join(repo, 'Azure', 'CustomDeploymentTemplates', 'DCR-Automation', 'core', 'azure-parameters.json'),
      dst: azureParametersPath(),
    },
    {
      src: path.join(repo, 'Azure', 'CustomDeploymentTemplates', 'DCR-Automation', 'core', 'operation-parameters.json'),
      dst: operationParametersPath(),
    },
    {
      src: path.join(repo, 'Azure', 'CustomDeploymentTemplates', 'DCR-Automation', 'core', 'cribl-parameters.json'),
      dst: criblParametersPath(),
    },
  ];

  for (const { src, dst } of migrations) {
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
    }
  }
}

// ---------------------------------------------------------------------------
// Initialization (call once on app startup)
// ---------------------------------------------------------------------------

export function initAppPaths(): void {
  ensureDirectories();

  // If repo is detected, bundle templates and migrate configs
  if (getLinkedRepo()) {
    bundleDcrTemplates();
    migrateRepoConfigs();
  }
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

export function registerAppPathsHandlers(ipcMain: import('electron').IpcMain): void {
  ipcMain.handle('app:paths', async () => ({
    appDataRoot: appDataRoot(),
    configDir: configDir(),
    packsDir: packsDir(),
    dcrTemplatesDir: dcrTemplatesDir(),
    linkedRepo: getLinkedRepo(),
    isRepoLinked: isRepoLinked(),
  }));

  ipcMain.handle('app:link-repo', async (_event, { repoPath: rp }: { repoPath: string }) => {
    if (!fs.existsSync(path.join(rp, 'Azure', 'CustomDeploymentTemplates'))) {
      return { success: false, error: 'Not a valid Cribl-Microsoft repository' };
    }
    setLinkedRepo(rp);
    const templateCount = bundleDcrTemplates();
    migrateRepoConfigs();
    return { success: true, templateCount };
  });

  ipcMain.handle('app:unlink-repo', async () => {
    setLinkedRepo(null);
    return { success: true };
  });
}
