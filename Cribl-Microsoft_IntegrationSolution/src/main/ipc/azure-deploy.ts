// Azure Deploy Module
// Handles creating custom tables, DCRs, and reading back generated Cribl
// destination configs so they can be embedded into pack outputs.yml.
//
// Leverages the existing DCR Automation PowerShell scripts in the repo
// and reads the generated output from core/cribl-dcr-configs/.

import { IpcMain } from 'electron';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  configDir as appConfigDir, azureParametersPath,
  dcrAutomationScript, dcrAutomationCwd,
} from './app-paths';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AzureParameters {
  subscriptionId: string;
  resourceGroupName: string;
  workspaceName: string;
  location: string;
  tenantId: string;
  clientId: string;
  dcrPrefix: string;
  dcrSuffix: string;
  dcePrefix: string;
  dceSuffix: string;
  ownerTag: string;
}

export interface DeployedDestination {
  id: string;
  type: string;
  dceEndpoint: string;
  dcrID: string;
  streamName: string;
  client_id: string;
  loginUrl: string;
  url: string;
  tableName: string;
}

export interface DeployResult {
  success: boolean;
  destinations: DeployedDestination[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Path Resolution
// ---------------------------------------------------------------------------

function getDcrAutomationDir(): string | null {
  return dcrAutomationCwd();
}

function getCriblConfigDir(): string {
  // Always use app data directory for destination configs.
  // The linked repo may have stale destinations from previous PowerShell deployments
  // targeting a different resource group or workspace.
  return path.join(appConfigDir(), 'cribl-dcr-configs');
}

function getDestinationsDir(): string {
  return path.join(getCriblConfigDir(), 'destinations');
}

// ---------------------------------------------------------------------------
// Read Azure Parameters (current config)
// ---------------------------------------------------------------------------

export function readAzureParameters(): AzureParameters | null {
  const paramPaths: string[] = [
    azureParametersPath(), // App data (primary)
  ];
  // Also check linked repo
  const repoDir = getDcrAutomationDir();
  if (repoDir) {
    paramPaths.push(path.join(repoDir, 'core', 'azure-parameters.json'));
    paramPaths.push(path.join(repoDir, 'dev', 'azure-parameters.json'));
  }

  for (const p of paramPaths) {
    if (fs.existsSync(p)) {
      try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
        return {
          subscriptionId: raw.subscriptionId || '',
          resourceGroupName: raw.resourceGroupName || '',
          workspaceName: raw.workspaceName || '',
          location: raw.location || '',
          tenantId: raw.tenantId || '',
          clientId: raw.clientId || '',
          dcrPrefix: raw.dcrPrefix || 'dcr-',
          dcrSuffix: raw.dcrSuffix || '',
          dcePrefix: raw.dcePrefix || 'dce-',
          dceSuffix: raw.dceSuffix || '',
          ownerTag: raw.ownerTag || '',
        };
      } catch { continue; }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Read Generated Destination Configs
// ---------------------------------------------------------------------------

export function readGeneratedDestinations(): DeployedDestination[] {
  const destsDir = getDestinationsDir();
  if (!fs.existsSync(destsDir)) return [];

  const destinations: DeployedDestination[] = [];
  const files = fs.readdirSync(destsDir).filter(
    (f) => f.endsWith('.json') && !f.includes('metadata') && !f.includes('summary')
  );

  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(destsDir, file), 'utf-8'));
      if (raw.type === 'sentinel' && raw.dcrID) {
        destinations.push({
          id: raw.id || file.replace('.json', ''),
          type: raw.type,
          dceEndpoint: raw.dceEndpoint || '',
          dcrID: raw.dcrID || '',
          streamName: raw.streamName || '',
          client_id: raw.client_id || '',
          loginUrl: raw.loginUrl || '',
          url: raw.url || '',
          tableName: extractTableFromStreamName(raw.streamName || ''),
        });
      }
    } catch { continue; }
  }

  return destinations;
}

function extractTableFromStreamName(streamName: string): string {
  // "Custom-CloudflareV2" -> "CloudflareV2"
  return streamName.replace(/^Custom-/, '').replace(/^Microsoft-/, '');
}

// Read a specific destination for a table name
export function findDestinationForTable(tableName: string): DeployedDestination | null {
  const all = readGeneratedDestinations();
  const stripped = tableName.replace(/_CL$/i, '');
  return all.find((d) => {
    const dTable = d.tableName.replace(/_CL$/i, '');
    return dTable.toLowerCase() === stripped.toLowerCase() ||
           dTable.toLowerCase().includes(stripped.toLowerCase()) ||
           stripped.toLowerCase().includes(dTable.toLowerCase());
  }) || null;
}

// ---------------------------------------------------------------------------
// Generate Outputs YAML with Real Destination Config
// ---------------------------------------------------------------------------

// Build outputs.yml content using real deployed destination data.
// Only the secret field is left as a placeholder.
export function generateOutputsYmlFromDestinations(
  destinations: DeployedDestination[],
  azureParams: AzureParameters | null,
): string {
  if (destinations.length === 0) {
    return '# No deployed destinations found. Run DCR Automation first.\noutputs: {}\n';
  }

  const lines: string[] = ['outputs:'];

  for (const dest of destinations) {
    const clientId = dest.client_id || (azureParams?.clientId ? `'${azureParams.clientId}'` : "'<YOUR-CLIENT-ID>'");
    const loginUrl = dest.loginUrl || (azureParams?.tenantId
      ? `https://login.microsoftonline.com/${azureParams.tenantId}/oauth2/v2.0/token`
      : 'https://login.microsoftonline.com/<YOUR-TENANT-ID>/oauth2/v2.0/token');

    lines.push(
      `  ${dest.id}:`,
      '    systemFields: []',
      '    streamtags: []',
      '    keepAlive: true',
      '    concurrency: 5',
      '    maxPayloadSizeKB: 1000',
      '    maxPayloadEvents: 0',
      '    compress: true',
      '    rejectUnauthorized: true',
      '    timeoutSec: 30',
      '    flushPeriodSec: 1',
      '    useRoundRobinDns: false',
      '    failedRequestLoggingMode: none',
      '    safeHeaders: []',
      '    responseRetrySettings: []',
      '    timeoutRetrySettings:',
      '      timeoutRetry: false',
      '    responseHonorRetryAfterHeader: false',
      '    onBackpressure: drop',
      '    scope: https://monitor.azure.com/.default',
      '    endpointURLConfiguration: ID',
      '    type: sentinel',
      `    dceEndpoint: ${dest.dceEndpoint}`,
      `    dcrID: ${dest.dcrID}`,
      `    streamName: ${dest.streamName}`,
      `    client_id: ${clientId}`,
      '    secret: "!{sentinel_client_secret}"',
      `    loginUrl: "${loginUrl}"`,
      `    url: "${dest.url}"`,
      '',
    );
  }

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Deploy DCRs for Specific Tables
// ---------------------------------------------------------------------------

interface DeployOptions {
  tables: string[];          // Table names to deploy (e.g., ["CloudflareV2_CL"])
  mode: 'DirectBoth' | 'DirectNative' | 'DirectCustom' | 'DCENative' | 'DCECustom' | 'DCEBoth';
  templateOnly: boolean;     // true = generate templates without deploying
}

// ---------------------------------------------------------------------------
// Auto-generate custom table schema files from Sentinel repo
// ---------------------------------------------------------------------------
// The PS DCR automation script needs schema files in custom-table-schemas/
// to create _CL tables. This function reads the Sentinel repo's table
// definition JSON files and converts them to the format the PS script expects.

async function generateCustomTableSchemas(tables: string[]): Promise<number> {
  let sentinelRepo: typeof import('./sentinel-repo') | null = null;
  try { sentinelRepo = await import('./sentinel-repo'); } catch { return 0; }
  if (!sentinelRepo.isRepoReady()) return 0;

  // Determine where to write schema files
  const cwd = dcrAutomationCwd();
  if (!cwd) return 0;
  const schemasDir = path.join(cwd, 'core', 'custom-table-schemas');
  if (!fs.existsSync(schemasDir)) fs.mkdirSync(schemasDir, { recursive: true });

  let generated = 0;

  for (const tableName of tables) {
    // Skip if schema file already exists
    const schemaPath = path.join(schemasDir, `${tableName}.json`);
    if (fs.existsSync(schemaPath)) continue;

    // Search for the table definition in the Sentinel repo
    const solutions = sentinelRepo.listSolutions();
    let columns: Array<{ name: string; type: string; description?: string }> | null = null;

    for (const sol of solutions) {
      const connectors = sentinelRepo.listConnectorFiles(sol.name);
      // Look for a file named like the table
      const tableFile = connectors.find((f) =>
        f.name.toLowerCase() === `${tableName.toLowerCase()}.json`
      );
      if (!tableFile) continue;

      const content = sentinelRepo.readRepoFile(tableFile.path);
      if (!content) continue;

      try {
        const parsed = JSON.parse(content);
        const schemaCols = parsed.properties?.schema?.columns
          || parsed.properties?.schema?.tableDefinition?.columns;
        if (schemaCols && Array.isArray(schemaCols)) {
          columns = schemaCols.map((col: any) => ({
            name: col.name,
            type: mapColumnType(col.type || 'string'),
            description: col.description || '',
          }));
          break;
        }
      } catch { continue; }
    }

    if (!columns || columns.length === 0) continue;

    // Write schema file in the format the PS script expects
    const schema = {
      name: tableName,
      description: `Auto-generated from Sentinel Content Hub for ${tableName}`,
      retentionInDays: 30,
      totalRetentionInDays: 90,
      columns,
    };

    fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2));
    generated++;
  }

  return generated;
}

// Map Sentinel column types to Log Analytics table types
function mapColumnType(sentinelType: string): string {
  const lower = sentinelType.toLowerCase();
  if (lower === 'datetime' || lower === 'datetimeoffset') return 'datetime';
  if (lower === 'int' || lower === 'int32') return 'int';
  if (lower === 'long' || lower === 'int64') return 'long';
  if (lower === 'real' || lower === 'double' || lower === 'float') return 'real';
  if (lower === 'bool' || lower === 'boolean') return 'boolean';
  if (lower === 'dynamic' || lower === 'object' || lower === 'array') return 'dynamic';
  if (lower === 'guid') return 'guid';
  return 'string';
}

// ---------------------------------------------------------------------------
// DCR Automation Runner
// ---------------------------------------------------------------------------

function runDcrAutomation(
  options: DeployOptions,
  sender: Electron.WebContents,
): Promise<DeployResult> {
  return new Promise((resolve) => {
    const scriptPath = dcrAutomationScript();
    const cwd = dcrAutomationCwd();

    if (!scriptPath || !fs.existsSync(scriptPath)) {
      resolve({
        success: false, destinations: [],
        error: 'DCR Automation script not found. Link the Cribl-Microsoft repository in Settings to enable DCR deployment.',
      });
      return;
    }

    const id = `deploy-${Date.now()}`;

    // Read Azure parameters from the app config and pass as CLI overrides
    // This decouples the Integration Solution from the repo's config files
    const azParams = readAzureParameters();
    const psArgs = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-NonInteractive',
      '-Mode', options.mode,
    ];

    // Pass Azure context as CLI parameters (overrides azure-parameters.json)
    if (azParams) {
      if (azParams.subscriptionId)    psArgs.push('-SubscriptionId', azParams.subscriptionId);
      if (azParams.resourceGroupName) psArgs.push('-ResourceGroupName', azParams.resourceGroupName);
      if (azParams.workspaceName)     psArgs.push('-WorkspaceName', azParams.workspaceName);
      if (azParams.location)          psArgs.push('-Location', azParams.location);
      if (azParams.tenantId)          psArgs.push('-TenantId', azParams.tenantId);
      if (azParams.clientId)          psArgs.push('-ClientId', azParams.clientId);
      if (azParams.ownerTag)          psArgs.push('-OwnerTag', azParams.ownerTag);
      if (azParams.dcrPrefix)         psArgs.push('-DcrPrefix', azParams.dcrPrefix);
      if (azParams.dcrSuffix)         psArgs.push('-DcrSuffix', azParams.dcrSuffix);
    }

    if (!sender.isDestroyed()) {
      sender.send('ps:output', { id, stream: 'stdout', data: `> Running DCR Automation: ${options.mode}\n` });
      sender.send('ps:output', { id, stream: 'stdout', data: `> Tables: ${options.tables.join(', ')}\n` });
      if (azParams) {
        sender.send('ps:output', { id, stream: 'stdout', data: `> Resource Group: ${azParams.resourceGroupName}\n` });
        sender.send('ps:output', { id, stream: 'stdout', data: `> Workspace: ${azParams.workspaceName}\n` });
      }
    }

    // Use pwsh (PowerShell 7+) because Create-TableDCRs.ps1 uses ?? null-coalescing operator
    const proc = spawn('pwsh', psArgs, {
      cwd: cwd || undefined,
      env: { ...process.env },
      windowsHide: true,
    });

    let output = '';

    proc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      output += text;
      if (!sender.isDestroyed()) {
        sender.send('ps:output', { id, stream: 'stdout', data: text });
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      output += text;
      if (!sender.isDestroyed()) {
        sender.send('ps:output', { id, stream: 'stderr', data: text });
      }
    });

    proc.on('close', (code: number | null) => {
      if (!sender.isDestroyed()) {
        sender.send('ps:exit', { id, code });
      }

      if (code === 0) {
        // Read generated destinations
        const destinations = readGeneratedDestinations();
        // Filter to only the tables we deployed
        const relevant = destinations.filter((d) =>
          options.tables.some((t) => {
            const tStripped = t.replace(/_CL$/i, '').toLowerCase();
            const dStripped = d.tableName.replace(/_CL$/i, '').toLowerCase();
            return dStripped === tStripped || dStripped.includes(tStripped) || tStripped.includes(dStripped);
          })
        );
        resolve({ success: true, destinations: relevant });
      } else {
        resolve({ success: false, destinations: [], error: `DCR Automation exited with code ${code}` });
      }
    });

    proc.on('error', (err: Error) => {
      if (!sender.isDestroyed()) {
        sender.send('ps:output', { id, stream: 'stderr', data: `Error: ${err.message}\n` });
        sender.send('ps:exit', { id, code: -1 });
      }
      resolve({ success: false, destinations: [], error: err.message });
    });
  });
}

// Update a pack's outputs.yml with real deployed destination configs
function updatePackOutputs(packDir: string, destinations: DeployedDestination[]): void {
  const azureParams = readAzureParameters();
  const outputsYml = generateOutputsYmlFromDestinations(destinations, azureParams);
  const outputsPath = path.join(packDir, 'default', 'outputs.yml');
  fs.writeFileSync(outputsPath, outputsYml);
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

export function registerAzureDeployHandlers(ipcMain: IpcMain) {
  // Get current Azure parameters (to show user what's configured)
  ipcMain.handle('azure:parameters', async () => {
    return readAzureParameters();
  });

  // Check if Azure resources already exist for specific tables
  // (looks for existing destination configs in cribl-dcr-configs/)
  ipcMain.handle('azure:check-existing', async (_event, { tables }: { tables: string[] }) => {
    // Live check against Azure -- look for DCRs in the currently selected resource group.
    // Don't use cached destination files (they may be from a different deployment).
    const params = readAzureParameters();
    const results: Record<string, DeployedDestination | null> = {};

    if (!params?.resourceGroupName) {
      // No workspace selected -- can't check Azure
      for (const table of tables) results[table] = null;
      return results;
    }

    try {
      const { execFileSync } = require('child_process');
      const rg = params.resourceGroupName;
      // List all DCRs in the resource group
      const cmd = params.subscriptionId
        ? `Set-AzContext -Subscription '${params.subscriptionId}' | Out-Null; ` +
          `Get-AzResource -ResourceGroupName '${rg}' -ResourceType 'Microsoft.Insights/dataCollectionRules' | ForEach-Object { $_.Name + '|' + $_.ResourceId }`
        : `Get-AzResource -ResourceGroupName '${rg}' -ResourceType 'Microsoft.Insights/dataCollectionRules' | ForEach-Object { $_.Name + '|' + $_.ResourceId }`;
      const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], {
        timeout: 60000, windowsHide: true, encoding: 'utf-8',
      });
      const dcrList = (output || '').trim().split('\n').filter(Boolean).map((line: string) => {
        const [name, resourceId] = line.split('|');
        return { name: (name || '').trim(), resourceId: (resourceId || '').trim() };
      });

      for (const table of tables) {
        const stripped = table.replace(/_CL$/i, '').toLowerCase();
        const match = dcrList.find((d: { name: string }) =>
          d.name.toLowerCase().includes(stripped) || stripped.includes(d.name.toLowerCase().replace(/^dcr-/, ''))
        );
        if (match) {
          results[table] = {
            id: match.name,
            type: 'sentinel',
            dceEndpoint: '',
            dcrID: match.resourceId || match.name,
            streamName: `Custom-${table}`,
            client_id: '',
            loginUrl: '',
            url: '',
            tableName: table,
          };
        } else {
          results[table] = null;
        }
      }
    } catch {
      // Azure check failed -- return null (no cached fallback)
      for (const table of tables) results[table] = null;
    }

    return results;
  });

  // Deploy DCRs and custom tables for specific tables
  // For custom _CL tables:
  //   1. Auto-generate schema files from the Sentinel repo
  //   2. Write the table names to CustomTableList.json (so PS script processes them)
  //   3. Run the PS DCR automation
  ipcMain.handle('azure:deploy-dcrs', async (event, options: DeployOptions) => {
    const customTables = options.tables.filter((t) => t.endsWith('_CL'));
    const nativeTables = options.tables.filter((t) => !t.endsWith('_CL'));

    if (customTables.length > 0) {
      const cwd = dcrAutomationCwd();
      if (cwd) {
        // Generate schema files from Sentinel repo
        try {
          const generated = await generateCustomTableSchemas(customTables);
          if (generated > 0 && !event.sender.isDestroyed()) {
            event.sender.send('ps:output', {
              id: `pre-${Date.now()}`, stream: 'stdout',
              data: `> Generated ${generated} custom table schema(s) from Sentinel Content Hub\n`,
            });
          }
        } catch { /* non-fatal */ }

        // Write custom tables to CustomTableList.json so the PS script processes them
        const customListPath = path.join(cwd, 'core', 'CustomTableList.json');
        fs.writeFileSync(customListPath, JSON.stringify(customTables, null, 4));
      }
    }

    if (nativeTables.length > 0) {
      const cwd = dcrAutomationCwd();
      if (cwd) {
        // Write native tables to NativeTableList.json
        const nativeListPath = path.join(cwd, 'core', 'NativeTableList.json');
        fs.writeFileSync(nativeListPath, JSON.stringify(nativeTables, null, 4));
      }
    }

    return runDcrAutomation(options, event.sender);
  });

  // Preview Azure resources that would be created for given tables
  // Returns resource list + DCR ARM template JSON for each table
  ipcMain.handle('azure:preview-resources', async (_event, {
    tables, subscription, resourceGroup, workspace, location,
  }: {
    tables: string[]; subscription: string; resourceGroup: string;
    workspace: string; location: string;
  }) => {
    const resources: Array<{
      type: string; name: string; table: string;
      exists: boolean; armTemplate?: any;
    }> = [];

    for (const table of tables) {
      const isCustom = table.endsWith('_CL');

      // Check if DCR already exists
      const existing = findDestinationForTable(table);

      // Load ARM template from bundled templates
      let armTemplate: any = null;
      const cwd = getDcrAutomationDir();
      if (cwd) {
        // Try NoDCE template first (Direct DCR)
        const noDcePath = path.join(cwd, '..', 'DCR-Templates', 'SentinelNativeTables',
          'DataCollectionRules(NoDCE)', `${table}.json`);
        const dcePath = path.join(cwd, '..', 'DCR-Templates', 'SentinelNativeTables',
          'DataCollectionRules(DCE)', `${table}.json`);
        // Also check generated templates
        const genPath = path.join(cwd, 'core', 'generated-templates', `${table}-latest.json`);

        for (const tplPath of [genPath, noDcePath, dcePath]) {
          if (fs.existsSync(tplPath)) {
            try {
              armTemplate = JSON.parse(fs.readFileSync(tplPath, 'utf8'));
              break;
            } catch { /* skip */ }
          }
        }
      }

      // Custom table schema
      let customSchema: any = null;
      if (isCustom && cwd) {
        const schemaPath = path.join(cwd, 'core', 'custom-table-schemas', `${table}.json`);
        if (fs.existsSync(schemaPath)) {
          try { customSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')); } catch { /* skip */ }
        }
      }

      // DCR resource
      const params = readAzureParameters();
      const prefix = params?.dcrPrefix || 'dcr-';
      const dcrName = `${prefix}${table.toLowerCase().replace(/_cl$/i, '').slice(0, 20)}-${(params?.dcrSuffix || location).slice(0, 10)}`;
      resources.push({
        type: 'Microsoft.Insights/dataCollectionRules',
        name: dcrName,
        table,
        exists: !!existing,
        armTemplate,
      });

      // Custom table resource
      if (isCustom) {
        resources.push({
          type: 'Microsoft.OperationalInsights/workspaces/tables',
          name: `${workspace}/${table}`,
          table,
          exists: !!existing,
          armTemplate: customSchema,
        });
      }
    }

    return {
      subscription,
      resourceGroup,
      workspace,
      location,
      resources,
    };
  });

  // Read all generated destination configs
  ipcMain.handle('azure:destinations', async () => {
    return readGeneratedDestinations();
  });

  // Query Azure for DCR info and save as destination config files
  // This is used when the PS script deploys DCRs but doesn't generate destination files
  ipcMain.handle('azure:refresh-destinations', async (_event, { tables }: { tables: string[] }) => {
    const azParams = readAzureParameters();
    if (!azParams) return { success: false, error: 'No Azure parameters configured' };

    const destsDir = getDestinationsDir();
    if (!fs.existsSync(destsDir)) fs.mkdirSync(destsDir, { recursive: true });

    const saved: string[] = [];
    for (const table of tables) {
      // Check if destination file already exists
      const existing = findDestinationForTable(table);
      if (existing) { saved.push(table); continue; }

      // Query Azure for the DCR
      const tableStripped = table.replace(/_CL$/i, '');
      const streamName = `Custom-${tableStripped}`;
      try {
        const { execFileSync } = require('child_process');
        // Find DCR by name pattern
        const dcrListCmd = execFileSync('pwsh', [
          '-NoProfile', '-Command',
          `Get-AzDataCollectionRule -ResourceGroupName '${azParams.resourceGroupName}' | ` +
          `Where-Object { $_.Name -like '*${tableStripped.substring(0, 20).toLowerCase()}*' } | ` +
          `Select-Object -First 1 -Property Name,Id,ImmutableId,DataCollectionEndpointId | ConvertTo-Json -Compress`,
        ], { timeout: 30000, windowsHide: true, encoding: 'utf-8' }) as string;

        const dcr = JSON.parse(dcrListCmd.trim());
        if (!dcr || !dcr.ImmutableId) continue;

        // Get the DCE endpoint
        let dceEndpoint = '';
        if (dcr.DataCollectionEndpointId) {
          try {
            const dceCmd = execFileSync('pwsh', [
              '-NoProfile', '-Command',
              `Get-AzDataCollectionEndpoint -ResourceGroupName '${azParams.resourceGroupName}' | ` +
              `Where-Object { $_.Id -eq '${dcr.DataCollectionEndpointId}' } | ` +
              `Select-Object -First 1 -Property LogsIngestionEndpoint | ConvertTo-Json -Compress`,
            ], { timeout: 15000, windowsHide: true, encoding: 'utf-8' }) as string;
            const dce = JSON.parse(dceCmd.trim());
            dceEndpoint = dce?.LogsIngestionEndpoint || '';
          } catch { /* DCE lookup failed, use empty */ }
        }

        // If no DCE, try to find by resource group
        if (!dceEndpoint) {
          try {
            const dceCmd = execFileSync('pwsh', [
              '-NoProfile', '-Command',
              `Get-AzDataCollectionEndpoint -ResourceGroupName '${azParams.resourceGroupName}' | ` +
              `Select-Object -First 1 -Property LogsIngestionEndpoint | ConvertTo-Json -Compress`,
            ], { timeout: 15000, windowsHide: true, encoding: 'utf-8' }) as string;
            const dce = JSON.parse(dceCmd.trim());
            dceEndpoint = dce?.LogsIngestionEndpoint || '';
          } catch { /* fallback */ }
        }

        const destConfig = {
          id: `MS-Sentinel-${tableStripped}-dest`,
          type: 'sentinel',
          dceEndpoint,
          dcrID: dcr.ImmutableId,
          streamName,
          client_id: azParams.clientId || '',
          loginUrl: `https://login.microsoftonline.com/${azParams.tenantId}/oauth2/v2.0/token`,
          url: `${dceEndpoint}/dataCollectionRules/${dcr.ImmutableId}/streams/${streamName}?api-version=2021-11-01-preview`,
        };

        const destPath = path.join(destsDir, `${destConfig.id}.json`);
        fs.writeFileSync(destPath, JSON.stringify(destConfig, null, 2));
        saved.push(table);
      } catch { /* skip this table */ }
    }

    return { success: true, saved, total: saved.length };
  });

  // Embed deployed destinations into a pack's outputs.yml and repackage
  ipcMain.handle('azure:embed-destinations', async (event, {
    packDir,
    tables,
  }: {
    packDir: string;
    tables: string[];
  }) => {
    // Find destinations for the requested tables
    const allDests = readGeneratedDestinations();
    const matched = allDests.filter((d) =>
      tables.some((t) => {
        const tStripped = t.replace(/_CL$/i, '').toLowerCase();
        const dStripped = d.tableName.replace(/_CL$/i, '').toLowerCase();
        return dStripped === tStripped || dStripped.includes(tStripped) || tStripped.includes(dStripped);
      })
    );

    if (matched.length === 0) {
      return {
        success: false,
        error: 'No matching destination configs found. Run DCR Automation first.',
        destinations: [],
      };
    }

    // Update the pack's outputs.yml
    updatePackOutputs(packDir, matched);

    return {
      success: true,
      destinations: matched,
      message: `Embedded ${matched.length} destination(s) into pack. Only client secret needs to be updated.`,
    };
  });

  // Assign "Monitoring Metrics Publisher" role to a service principal on DCR resources
  ipcMain.handle('azure:assign-dcr-role', async (_event, {
    objectId, dcrResourceIds,
  }: {
    objectId: string;
    dcrResourceIds: string[];
  }) => {
    const results: Array<{ dcr: string; success: boolean; error?: string }> = [];
    const roleDefId = '3913510d-42f4-4e42-8a64-420c390055eb'; // Monitoring Metrics Publisher

    for (const dcrId of dcrResourceIds) {
      try {
        const ps = `
          $ErrorActionPreference = 'Stop'
          $existing = Get-AzRoleAssignment -ObjectId '${objectId}' -RoleDefinitionId '${roleDefId}' -Scope '${dcrId}' -ErrorAction SilentlyContinue
          if ($existing) {
            Write-Output 'ALREADY_ASSIGNED'
          } else {
            New-AzRoleAssignment -ObjectId '${objectId}' -RoleDefinitionId '${roleDefId}' -Scope '${dcrId}' | Out-Null
            Write-Output 'ASSIGNED'
          }
        `;
        const output = await new Promise<string>((resolve, reject) => {
          let out = '';
          const proc = spawn('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true });
          proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
          proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
          proc.on('close', (code) => code === 0 ? resolve(out.trim()) : reject(new Error(out.trim())));
          proc.on('error', reject);
        });
        const dcrName = dcrId.split('/').pop() || dcrId;
        results.push({
          dcr: dcrName,
          success: true,
          error: output.includes('ALREADY_ASSIGNED') ? 'Already assigned' : undefined,
        });
      } catch (err) {
        const dcrName = dcrId.split('/').pop() || dcrId;
        results.push({ dcr: dcrName, success: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return { results, assigned: results.filter((r) => r.success).length, total: dcrResourceIds.length };
  });

  // Get DCR resource IDs for deployed tables (so we can scope role assignments)
  ipcMain.handle('azure:get-dcr-ids', async (_event, { tables }: { tables: string[] }) => {
    const dcrIds: Array<{ table: string; resourceId: string }> = [];
    try {
      const ps = `
        $ErrorActionPreference = 'Stop'
        $dcrs = Get-AzDataCollectionRule -ErrorAction Stop
        $results = @()
        foreach ($dcr in $dcrs) {
          $results += [PSCustomObject]@{
            Name = $dcr.Name
            Id = $dcr.Id
          }
        }
        $results | ConvertTo-Json -Compress
      `;
      const output = await new Promise<string>((resolve, reject) => {
        let out = '';
        const proc = spawn('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true });
        proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
        proc.stderr?.on('data', (d: Buffer) => { /* ignore stderr */ });
        proc.on('close', (code) => code === 0 ? resolve(out.trim()) : reject(new Error(out.trim())));
        proc.on('error', reject);
      });

      const parsed = JSON.parse(output.startsWith('[') ? output : `[${output}]`);
      for (const dcr of Array.isArray(parsed) ? parsed : [parsed]) {
        const dcrNameLower = (dcr.Name || '').toLowerCase();
        for (const table of tables) {
          const tableLower = table.toLowerCase().replace(/_cl$/i, '');
          if (dcrNameLower.includes(tableLower)) {
            dcrIds.push({ table, resourceId: dcr.Id });
            break;
          }
        }
      }
    } catch { /* non-fatal */ }
    return dcrIds;
  });
}
