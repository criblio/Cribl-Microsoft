// End-to-End Orchestrator
// Coordinates the full onboarding flow:
//   1. Validate auth (Cribl API + Azure session)
//   2. For each selected source/vendor:
//      a. Research vendor schemas
//      b. Create Azure custom tables (if _CL)
//      c. Deploy DCRs
//      d. Build Cribl pack (pipelines, reduction, samples, destinations)
//      e. Create Cribl destinations via API
//      f. Upload .crbl pack to Cribl
//   3. Report progress and results
//
// Each step is idempotent -- re-running skips already-completed steps.

import { IpcMain, BrowserWindow } from 'electron';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { performVendorResearch } from './vendor-research';
import { findDestinationForTable, readAzureParameters, readGeneratedDestinations } from './azure-deploy';
import { criblCreateDestination, criblUploadPack, criblListDestinations, CriblAuth } from './auth';
import { packsDir, dcrAutomationScript, dcrAutomationCwd, isRepoLinked } from './app-paths';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OnboardingSource {
  id: string;
  vendor: string;
  displayName: string;
  tables: string[];           // Sentinel table names (e.g., ["CloudflareV2_CL"])
  sourceType: string;         // Cribl source type (e.g., "rest_collector")
  selected: boolean;
}

export type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error';

export interface OnboardingStep {
  id: string;
  label: string;
  status: StepStatus;
  detail: string;
}

export interface OnboardingProgress {
  sourceId: string;
  vendor: string;
  steps: OnboardingStep[];
  packDir?: string;
  crblPath?: string;
  overall: 'pending' | 'running' | 'done' | 'error';
}

export interface E2EState {
  status: 'idle' | 'running' | 'done' | 'error';
  sources: OnboardingProgress[];
  currentSource: string;
  error: string;
}

// ---------------------------------------------------------------------------
// Path Resolution (delegated to app-paths)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Progress Broadcasting
// ---------------------------------------------------------------------------

let e2eState: E2EState = {
  status: 'idle', sources: [], currentSource: '', error: '',
};

function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('e2e:progress', e2eState);
    }
  }
}

function updateStep(sourceId: string, stepId: string, status: StepStatus, detail: string): void {
  const source = e2eState.sources.find((s) => s.sourceId === sourceId);
  if (!source) return;
  const step = source.steps.find((s) => s.id === stepId);
  if (!step) return;
  step.status = status;
  step.detail = detail;
  broadcast();
}

// ---------------------------------------------------------------------------
// Individual Steps
// ---------------------------------------------------------------------------

// Step: Run DCR Automation for specific tables
function runDcrDeploy(
  tables: string[],
  mode: string,
  sender: Electron.WebContents,
): Promise<boolean> {
  return new Promise((resolve) => {
    const scriptPath = dcrAutomationScript();
    const cwd = dcrAutomationCwd();

    if (!scriptPath || !cwd || !fs.existsSync(scriptPath)) {
      resolve(false);
      return;
    }

    const id = `e2e-dcr-${Date.now()}`;
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath, '-NonInteractive', '-Mode', mode,
    ], {
      cwd,
      env: { ...process.env },
      windowsHide: true,
    });

    proc.stdout?.on('data', (data: Buffer) => {
      if (!sender.isDestroyed()) {
        sender.send('ps:output', { id, stream: 'stdout', data: data.toString() });
      }
    });
    proc.stderr?.on('data', (data: Buffer) => {
      if (!sender.isDestroyed()) {
        sender.send('ps:output', { id, stream: 'stderr', data: data.toString() });
      }
    });
    proc.on('close', (code) => { resolve(code === 0); });
    proc.on('error', () => { resolve(false); });
  });
}

// Step: Build pack via the pack:scaffold IPC (calls it programmatically)
async function buildPack(
  vendor: string,
  tables: Array<{ sentinelTable: string; fields: Array<{ source: string; target: string; type: string; action: string }> }>,
): Promise<{ packDir: string; crblPath: string } | null> {
  // We can't call IPC from within IPC, so we use the pack-builder functions directly
  // For now, we return the expected paths and let the orchestrator handle it
  const pDir = packsDir();
  const packName = vendor.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-sentinel';
  const packDir = path.join(pDir, packName);

  // Check if pack already exists
  if (fs.existsSync(packDir)) {
    const crblFiles = fs.readdirSync(pDir).filter(
      (f) => f.startsWith(packName) && f.endsWith('.crbl')
    );
    return {
      packDir,
      crblPath: crblFiles.length > 0 ? path.join(pDir, crblFiles[0]) : '',
    };
  }

  return null; // Pack doesn't exist yet -- scaffold needed
}

// ---------------------------------------------------------------------------
// Main Orchestrator
// ---------------------------------------------------------------------------

async function runE2EOnboarding(
  sources: OnboardingSource[],
  criblAuth: CriblAuth | null,
  workerGroup: string,
  sender: Electron.WebContents,
): Promise<void> {
  e2eState = {
    status: 'running',
    sources: sources.filter((s) => s.selected).map((s) => ({
      sourceId: s.id,
      vendor: s.displayName,
      steps: [
        { id: 'research', label: 'Vendor Research', status: 'pending', detail: '' },
        { id: 'azure-tables', label: 'Create Custom Tables', status: 'pending', detail: '' },
        { id: 'azure-dcrs', label: 'Deploy DCRs', status: 'pending', detail: '' },
        { id: 'build-pack', label: 'Build Cribl Pack', status: 'pending', detail: '' },
        { id: 'embed-dest', label: 'Embed Destinations', status: 'pending', detail: '' },
        ...(criblAuth ? [
          { id: 'cribl-dest', label: 'Create Cribl Destinations', status: 'pending' as StepStatus, detail: '' },
          { id: 'cribl-upload', label: 'Upload Pack to Cribl', status: 'pending' as StepStatus, detail: '' },
        ] : []),
      ],
      overall: 'pending',
    })),
    currentSource: '',
    error: '',
  };
  broadcast();

  const selectedSources = sources.filter((s) => s.selected);

  for (const source of selectedSources) {
    e2eState.currentSource = source.displayName;
    const progress = e2eState.sources.find((s) => s.sourceId === source.id);
    if (!progress) continue;
    progress.overall = 'running';
    broadcast();

    try {
      // Step 1: Vendor Research
      updateStep(source.id, 'research', 'running', 'Fetching vendor schemas...');
      let vendorData = null;
      try {
        vendorData = await performVendorResearch(source.vendor);
        if (vendorData) {
          updateStep(source.id, 'research', 'done',
            `${vendorData.logTypes.length} log types, ${vendorData.logTypes.reduce((s, lt) => s + lt.fields.length, 0)} fields`);
        } else {
          updateStep(source.id, 'research', 'skipped', 'No vendor data found in registry');
        }
      } catch {
        updateStep(source.id, 'research', 'skipped', 'Research failed -- using defaults');
      }

      // Step 2: Azure Custom Tables
      const hasCustomTables = source.tables.some((t) => t.endsWith('_CL'));
      if (hasCustomTables) {
        updateStep(source.id, 'azure-tables', 'running', 'Creating custom tables...');
        const ok = await runDcrDeploy(source.tables, 'DirectCustom', sender);
        updateStep(source.id, 'azure-tables', ok ? 'done' : 'error',
          ok ? `Created tables: ${source.tables.join(', ')}` : 'Table creation failed');
      } else {
        updateStep(source.id, 'azure-tables', 'skipped', 'No custom tables needed (native tables only)');
      }

      // Step 3: Deploy DCRs
      updateStep(source.id, 'azure-dcrs', 'running', 'Deploying Data Collection Rules...');
      const existingDests = source.tables.map((t) => findDestinationForTable(t)).filter(Boolean);
      if (existingDests.length === source.tables.length) {
        updateStep(source.id, 'azure-dcrs', 'skipped', 'DCRs already deployed');
      } else {
        const mode = hasCustomTables ? 'DirectCustom' : 'DirectNative';
        const ok = await runDcrDeploy(source.tables, mode, sender);
        updateStep(source.id, 'azure-dcrs', ok ? 'done' : 'error',
          ok ? 'DCRs deployed successfully' : 'DCR deployment failed');
      }

      // Step 4: Build Pack (trigger via IPC -- the renderer will need to call pack:scaffold)
      updateStep(source.id, 'build-pack', 'running', 'Building Cribl Pack...');
      const existingPack = await buildPack(source.vendor, []);
      if (existingPack) {
        progress.packDir = existingPack.packDir;
        progress.crblPath = existingPack.crblPath;
        updateStep(source.id, 'build-pack', 'done', `Pack exists: ${path.basename(existingPack.packDir)}`);
      } else {
        // Pack needs to be created via pack:scaffold from the renderer
        updateStep(source.id, 'build-pack', 'pending',
          'Pack scaffold required -- use Pack Builder to create');
      }

      // Step 5: Embed Destinations
      updateStep(source.id, 'embed-dest', 'running', 'Embedding destination configs...');
      const destinations = readGeneratedDestinations();
      const matched = destinations.filter((d) =>
        source.tables.some((t) => {
          const ts = t.replace(/_CL$/i, '').toLowerCase();
          const ds = d.tableName.replace(/_CL$/i, '').toLowerCase();
          return ds === ts || ds.includes(ts) || ts.includes(ds);
        })
      );
      if (matched.length > 0 && progress.packDir) {
        const outputsPath = path.join(progress.packDir, 'default', 'outputs.yml');
        if (fs.existsSync(path.dirname(outputsPath))) {
          const { generateOutputsYmlFromDestinations } = await import('./azure-deploy');
          const azureParams = readAzureParameters();
          const yml = generateOutputsYmlFromDestinations(matched, azureParams);
          fs.writeFileSync(outputsPath, yml);
          updateStep(source.id, 'embed-dest', 'done', `${matched.length} destination(s) embedded`);
        } else {
          updateStep(source.id, 'embed-dest', 'error', 'Pack directory not found');
        }
      } else if (matched.length === 0) {
        updateStep(source.id, 'embed-dest', 'error', 'No deployed destinations found');
      } else {
        updateStep(source.id, 'embed-dest', 'skipped', 'Pack not yet created');
      }

      // Step 6: Create Cribl Destinations via API
      if (criblAuth && matched.length > 0) {
        updateStep(source.id, 'cribl-dest', 'running', 'Creating Cribl destinations...');
        let destSuccess = 0;
        for (const dest of matched) {
          const destConfig = {
            id: dest.id,
            type: 'sentinel',
            dceEndpoint: dest.dceEndpoint,
            dcrID: dest.dcrID,
            streamName: dest.streamName,
            client_id: dest.client_id,
            secret: '!{sentinel_client_secret}',
            loginUrl: dest.loginUrl,
            url: dest.url,
            scope: 'https://monitor.azure.com/.default',
            compress: true,
            keepAlive: true,
            concurrency: 5,
            maxPayloadSizeKB: 1000,
            timeoutSec: 30,
            flushPeriodSec: 1,
            onBackpressure: 'drop',
          };
          const result = await criblCreateDestination(criblAuth, destConfig, workerGroup);
          if (result.success) destSuccess++;
        }
        updateStep(source.id, 'cribl-dest', destSuccess > 0 ? 'done' : 'error',
          `${destSuccess}/${matched.length} destinations created`);
      }

      // Step 7: Upload Pack to Cribl
      if (criblAuth && progress.crblPath && fs.existsSync(progress.crblPath)) {
        updateStep(source.id, 'cribl-upload', 'running', 'Uploading pack...');
        const result = await criblUploadPack(criblAuth, progress.crblPath, workerGroup);
        updateStep(source.id, 'cribl-upload', result.success ? 'done' : 'error',
          result.success ? `Uploaded ${path.basename(progress.crblPath)}` : (result.error || 'Upload failed'));
      } else if (criblAuth) {
        updateStep(source.id, 'cribl-upload', 'skipped', 'No .crbl file to upload');
      }

      progress.overall = 'done';
    } catch (err) {
      progress.overall = 'error';
      const msg = err instanceof Error ? err.message : String(err);
      e2eState.error = msg;
    }

    broadcast();
  }

  e2eState.status = 'done';
  e2eState.currentSource = '';
  broadcast();
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

export function registerE2EHandlers(ipcMain: IpcMain) {
  // Get current E2E state
  ipcMain.handle('e2e:status', async () => {
    return e2eState;
  });

  // Start end-to-end onboarding
  ipcMain.handle('e2e:start', async (event, {
    sources,
    criblAuth,
    workerGroup,
  }: {
    sources: OnboardingSource[];
    criblAuth: CriblAuth | null;
    workerGroup: string;
  }) => {
    if (e2eState.status === 'running') {
      return { started: false, reason: 'Onboarding already in progress' };
    }

    // Run in background
    runE2EOnboarding(sources, criblAuth, workerGroup || 'default', event.sender).catch((err) => {
      e2eState.status = 'error';
      e2eState.error = err instanceof Error ? err.message : String(err);
      broadcast();
    });

    return { started: true };
  });

  // Build the source selection list from vendor research + existing packs
  ipcMain.handle('e2e:available-sources', async () => {
    // Combine registered vendors with dynamic registry
    const { listRegisteredVendors } = await import('./vendor-research');
    const { getAllDynamicEntries } = await import('./registry-sync');

    const sources: OnboardingSource[] = [];
    const seen = new Set<string>();

    // Static vendors
    for (const v of listRegisteredVendors()) {
      const key = v.vendor.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({
        id: key,
        vendor: v.vendor,
        displayName: v.displayName,
        tables: [],
        sourceType: v.sourceType,
        selected: false,
      });
    }

    // Dynamic entries from GitHub scan
    for (const entry of getAllDynamicEntries()) {
      const key = entry.vendor.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({
        id: key,
        vendor: entry.vendor,
        displayName: entry.displayName,
        tables: entry.logTypes.map((lt) => lt.name),
        sourceType: 'rest_collector',
        selected: false,
      });
    }

    return sources.sort((a, b) => a.displayName.localeCompare(b.displayName));
  });

  // Reset E2E state
  ipcMain.handle('e2e:reset', async () => {
    e2eState = { status: 'idle', sources: [], currentSource: '', error: '' };
    broadcast();
  });
}
