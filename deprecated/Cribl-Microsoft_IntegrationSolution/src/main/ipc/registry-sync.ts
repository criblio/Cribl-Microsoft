// Registry Sync Module
// Scans the Microsoft Sentinel Solutions GitHub repo on app startup to
// automatically discover and index all available vendor solutions.
// Builds a dynamic registry that supplements the curated static entries
// in vendor-research.ts.
//
// Flow:
//   1. On startup (or manual trigger), fetch Solutions/ directory listing
//   2. For each solution, scan Data Connectors for JSON schema files
//   3. Parse schemas to extract table names, columns, and log type info
//   4. Build a DynamicRegistryEntry per solution and cache to disk
//   5. vendor-research.ts merges dynamic entries with static curated data

import { IpcMain, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import { githubGet, rawGet, SENTINEL_REPO, SOLUTIONS_PATH, GitHubContent } from './github';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DynamicLogType {
  id: string;
  name: string;
  description: string;
  fields: Array<{
    name: string;
    type: string;
    description: string;
  }>;
}

export interface DynamicRegistryEntry {
  vendor: string;
  displayName: string;
  solutionPath: string;
  logTypes: DynamicLogType[];
  dataConnectorFiles: string[];
  lastSynced: number;
}

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'done' | 'error';
  total: number;
  completed: number;
  currentSolution: string;
  errorMessage: string;
  lastSyncTime: number;
  entriesFound: number;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const SYNC_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function getCacheDir(): string {
  const appData = process.env.APPDATA || process.env.HOME || '';
  const cacheDir = path.join(appData, '.cribl-microsoft', 'registry-cache');
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  return cacheDir;
}

function getIndexPath(): string {
  return path.join(getCacheDir(), '_index.json');
}

interface RegistryIndex {
  lastFullSync: number;
  entries: Record<string, DynamicRegistryEntry>;
}

function readIndex(): RegistryIndex {
  const indexPath = getIndexPath();
  if (fs.existsSync(indexPath)) {
    try {
      return JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    } catch {
      // Corrupt, start fresh
    }
  }
  return { lastFullSync: 0, entries: {} };
}

function writeIndex(index: RegistryIndex): void {
  try {
    fs.writeFileSync(getIndexPath(), JSON.stringify(index, null, 2));
  } catch {
    // Non-fatal
  }
}

// ---------------------------------------------------------------------------
// Schema Extraction (lightweight version for bulk scanning)
// ---------------------------------------------------------------------------

function normalizeType(type: string): string {
  const map: Record<string, string> = {
    string: 'string', int: 'int', integer: 'int', int32: 'int',
    long: 'long', int64: 'long', real: 'real', double: 'real', float: 'real',
    number: 'real', decimal: 'real', bool: 'boolean', boolean: 'boolean',
    datetime: 'datetime', timestamp: 'datetime', date: 'datetime',
    dynamic: 'dynamic', object: 'dynamic', json: 'dynamic', array: 'dynamic',
    guid: 'string', uuid: 'string',
  };
  return map[(type || 'string').toLowerCase()] || 'string';
}

function extractLogTypesFromConnector(json: Record<string, unknown>): DynamicLogType[] {
  const logTypes: DynamicLogType[] = [];

  // Format 1: tables[] with columns[]
  if (Array.isArray(json.tables)) {
    for (const table of json.tables) {
      const t = table as Record<string, unknown>;
      if (!t.name) continue;
      const columns = Array.isArray(t.columns) ? t.columns as Array<Record<string, string>> : [];
      logTypes.push({
        id: String(t.name).replace(/[^a-zA-Z0-9_]/g, '_'),
        name: String(t.name),
        description: String(t.description || t.name),
        fields: columns
          .filter((c) => c.name || c.columnName)
          .map((c) => ({
            name: c.name || c.columnName,
            type: normalizeType(c.type || c.columnType || 'string'),
            description: c.description || '',
          })),
      });
    }
  }

  // Format 2: ARM resources with streamDeclarations
  if (Array.isArray(json.resources)) {
    for (const resource of json.resources) {
      const r = resource as Record<string, unknown>;
      const props = r.properties as Record<string, unknown> | undefined;
      if (!props?.streamDeclarations) continue;
      const streams = props.streamDeclarations as Record<string, { columns?: Array<Record<string, string>> }>;
      for (const [streamName, streamDef] of Object.entries(streams)) {
        if (!Array.isArray(streamDef.columns)) continue;
        const tableName = streamName.replace(/^Custom-/, '');
        if (logTypes.some((lt) => lt.name === tableName)) continue;
        logTypes.push({
          id: tableName.replace(/[^a-zA-Z0-9_]/g, '_'),
          name: tableName,
          description: `${tableName} stream`,
          fields: streamDef.columns
            .filter((c) => c.name)
            .map((c) => ({
              name: c.name,
              type: normalizeType(c.type || 'string'),
              description: '',
            })),
        });
      }
    }
  }

  // Format 3: dataTypes[]
  if (logTypes.length === 0 && Array.isArray(json.dataTypes)) {
    for (const dt of json.dataTypes) {
      const d = dt as Record<string, unknown>;
      if (d.name) {
        logTypes.push({
          id: String(d.name).replace(/[^a-zA-Z0-9_]/g, '_'),
          name: String(d.name),
          description: String(d.name),
          fields: [],
        });
      }
    }
  }

  // Format 4: connectorUiConfig.dataTypes
  if (logTypes.length === 0 && json.properties) {
    const props = json.properties as Record<string, unknown>;
    const uiConfig = props.connectorUiConfig as Record<string, unknown> | undefined;
    if (uiConfig && Array.isArray(uiConfig.dataTypes)) {
      for (const dt of uiConfig.dataTypes) {
        const d = dt as Record<string, unknown>;
        if (d.name) {
          logTypes.push({
            id: String(d.name).replace(/[^a-zA-Z0-9_]/g, '_'),
            name: String(d.name),
            description: String(d.name),
            fields: [],
          });
        }
      }
    }
  }

  return logTypes;
}

// ---------------------------------------------------------------------------
// Sync Engine
// ---------------------------------------------------------------------------

let currentStatus: SyncStatus = {
  state: 'idle',
  total: 0,
  completed: 0,
  currentSolution: '',
  errorMessage: '',
  lastSyncTime: 0,
  entriesFound: 0,
};

// Broadcast sync progress to all renderer windows
function broadcastStatus(status: SyncStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('registry:sync-progress', status);
    }
  }
}

// Scan a single solution's Data Connectors directory
async function scanSolution(solutionName: string, solutionPath: string): Promise<DynamicRegistryEntry | null> {
  const logTypes: DynamicLogType[] = [];
  const connectorFiles: string[] = [];

  // Try both "Data Connectors" and "DataConnectors" directories
  const dirNames = ['Data%20Connectors', 'DataConnectors'];
  let connectorContents: GitHubContent[] = [];

  for (const dirName of dirNames) {
    try {
      const urlPath = `/repos/${SENTINEL_REPO}/contents/${solutionPath}/${dirName}`;
      const response = await githubGet(urlPath);
      connectorContents = JSON.parse(response);
      break;
    } catch {
      continue;
    }
  }

  if (connectorContents.length === 0) return null;

  // Process JSON files (limit to 10 per solution to avoid rate limits)
  const jsonFiles = connectorContents
    .filter((f) => f.type === 'file' && f.name.endsWith('.json'))
    .slice(0, 10);

  for (const file of jsonFiles) {
    try {
      const content = await rawGet(file.path);
      const parsed = JSON.parse(content);
      const extracted = extractLogTypesFromConnector(parsed);

      for (const lt of extracted) {
        if (!logTypes.some((existing) => existing.id === lt.id)) {
          logTypes.push(lt);
        }
      }
      connectorFiles.push(file.name);
    } catch {
      // Skip unparseable files
    }
  }

  // Also check subdirectories (template_*, connector_*)
  const subDirs = connectorContents
    .filter((f) => f.type === 'dir')
    .slice(0, 5);

  for (const dir of subDirs) {
    try {
      const urlPath = `/repos/${SENTINEL_REPO}/contents/${dir.path}`;
      const response = await githubGet(urlPath);
      const subFiles: GitHubContent[] = JSON.parse(response);
      const subJsonFiles = subFiles
        .filter((f) => f.type === 'file' && f.name.endsWith('.json'))
        .slice(0, 5);

      for (const file of subJsonFiles) {
        try {
          const content = await rawGet(file.path);
          const parsed = JSON.parse(content);
          const extracted = extractLogTypesFromConnector(parsed);
          for (const lt of extracted) {
            if (!logTypes.some((existing) => existing.id === lt.id)) {
              logTypes.push(lt);
            }
          }
          connectorFiles.push(`${dir.name}/${file.name}`);
        } catch {
          // Skip
        }
      }
    } catch {
      // Skip
    }
  }

  if (logTypes.length === 0 && connectorFiles.length === 0) return null;

  return {
    vendor: solutionName.toLowerCase().replace(/[^a-z0-9]/g, '_'),
    displayName: solutionName,
    solutionPath,
    logTypes,
    dataConnectorFiles: connectorFiles,
    lastSynced: Date.now(),
  };
}

// Full sync: enumerate all solutions and scan each one.
// Uses batching with delays to respect GitHub API rate limits (60 req/hr unauthenticated).
export async function performFullSync(
  options?: { forceRefresh?: boolean; batchSize?: number; delayMs?: number },
): Promise<RegistryIndex> {
  const forceRefresh = options?.forceRefresh ?? false;
  const batchSize = options?.batchSize ?? 5;
  const delayMs = options?.delayMs ?? 1500;

  const index = readIndex();

  // Check if a full sync is already recent enough
  if (!forceRefresh && (Date.now() - index.lastFullSync) < SYNC_CACHE_TTL_MS) {
    currentStatus = {
      state: 'done',
      total: Object.keys(index.entries).length,
      completed: Object.keys(index.entries).length,
      currentSolution: '',
      errorMessage: '',
      lastSyncTime: index.lastFullSync,
      entriesFound: Object.keys(index.entries).length,
    };
    broadcastStatus(currentStatus);
    return index;
  }

  currentStatus = {
    state: 'syncing',
    total: 0,
    completed: 0,
    currentSolution: 'Fetching solutions list...',
    errorMessage: '',
    lastSyncTime: 0,
    entriesFound: 0,
  };
  broadcastStatus(currentStatus);

  // Fetch the top-level Solutions directory
  let solutions: GitHubContent[] = [];
  try {
    const response = await githubGet(`/repos/${SENTINEL_REPO}/contents/${SOLUTIONS_PATH}`);
    solutions = (JSON.parse(response) as GitHubContent[]).filter((s) => s.type === 'dir');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    currentStatus = {
      ...currentStatus,
      state: 'error',
      errorMessage: `Failed to list solutions: ${msg}`,
    };
    broadcastStatus(currentStatus);
    return index;
  }

  currentStatus.total = solutions.length;
  broadcastStatus(currentStatus);

  // Process solutions in batches to avoid rate limiting
  for (let i = 0; i < solutions.length; i += batchSize) {
    const batch = solutions.slice(i, i + batchSize);

    const batchPromises = batch.map(async (solution) => {
      const name = solution.name;

      // Skip if recently synced and not forcing refresh
      const existing = index.entries[name.toLowerCase().replace(/[^a-z0-9]/g, '_')];
      if (!forceRefresh && existing && (Date.now() - existing.lastSynced) < SYNC_CACHE_TTL_MS) {
        return existing;
      }

      try {
        return await scanSolution(name, solution.path);
      } catch {
        return null;
      }
    });

    const results = await Promise.all(batchPromises);

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result) {
        index.entries[result.vendor] = result;
        currentStatus.entriesFound++;
      }
      currentStatus.completed++;
      currentStatus.currentSolution = batch[j]?.name || '';
    }

    broadcastStatus(currentStatus);

    // Rate limit delay between batches (skip on last batch)
    if (i + batchSize < solutions.length) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  index.lastFullSync = Date.now();
  writeIndex(index);

  currentStatus = {
    state: 'done',
    total: solutions.length,
    completed: solutions.length,
    currentSolution: '',
    errorMessage: '',
    lastSyncTime: index.lastFullSync,
    entriesFound: Object.keys(index.entries).length,
  };
  broadcastStatus(currentStatus);

  return index;
}

// Quick lookup: get a dynamic registry entry by vendor name
export function lookupDynamicEntry(vendorName: string): DynamicRegistryEntry | null {
  const index = readIndex();
  const lower = vendorName.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Exact key match
  for (const [key, entry] of Object.entries(index.entries)) {
    if (key.replace(/[^a-z0-9]/g, '') === lower) return entry;
  }

  // Display name match
  for (const entry of Object.values(index.entries)) {
    const display = entry.displayName.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (display === lower || display.includes(lower) || lower.includes(display)) {
      return entry;
    }
  }

  return null;
}

// Get all synced entries (for search/browse UI)
export function getAllDynamicEntries(): DynamicRegistryEntry[] {
  const index = readIndex();
  return Object.values(index.entries).sort((a, b) =>
    a.displayName.localeCompare(b.displayName)
  );
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

export function registerRegistrySyncHandlers(ipcMain: IpcMain) {
  // Get current sync status
  ipcMain.handle('registry:status', async () => {
    const index = readIndex();
    return {
      ...currentStatus,
      lastSyncTime: index.lastFullSync,
      entriesFound: Object.keys(index.entries).length,
    };
  });

  // Trigger a full sync (non-blocking -- progress via registry:sync-progress events)
  ipcMain.handle('registry:sync', async (_event, { forceRefresh }: { forceRefresh?: boolean } = {}) => {
    // Don't start a new sync if one is already running
    if (currentStatus.state === 'syncing') {
      return { started: false, reason: 'Sync already in progress' };
    }

    // Run in background -- don't await
    performFullSync({ forceRefresh: forceRefresh ?? false }).catch(() => {
      currentStatus.state = 'error';
      currentStatus.errorMessage = 'Sync failed unexpectedly';
      broadcastStatus(currentStatus);
    });

    return { started: true };
  });

  // Search the dynamic registry
  ipcMain.handle('registry:search', async (_event, { query }: { query: string }) => {
    const all = getAllDynamicEntries();
    if (!query || query.trim().length === 0) return all;

    const lower = query.toLowerCase();
    return all.filter((entry) =>
      entry.displayName.toLowerCase().includes(lower) ||
      entry.vendor.includes(lower) ||
      entry.logTypes.some((lt) => lt.name.toLowerCase().includes(lower))
    );
  });

  // Get a single entry by vendor name
  ipcMain.handle('registry:lookup', async (_event, { vendorName }: { vendorName: string }) => {
    return lookupDynamicEntry(vendorName);
  });

  // Get full index stats
  ipcMain.handle('registry:stats', async () => {
    const index = readIndex();
    const entries = Object.values(index.entries);
    const totalLogTypes = entries.reduce((sum, e) => sum + e.logTypes.length, 0);
    const totalFields = entries.reduce(
      (sum, e) => sum + e.logTypes.reduce((s, lt) => s + lt.fields.length, 0), 0
    );
    const withSchemas = entries.filter((e) => e.logTypes.some((lt) => lt.fields.length > 0)).length;

    return {
      lastFullSync: index.lastFullSync,
      totalSolutions: entries.length,
      totalLogTypes,
      totalFields,
      solutionsWithSchemas: withSchemas,
      solutionsWithoutSchemas: entries.length - withSchemas,
    };
  });
}
