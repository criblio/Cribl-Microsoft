import { IpcMain } from 'electron';
import https from 'https';
import fs from 'fs';
import path from 'path';

const SENTINEL_REPO = 'Azure/Azure-Sentinel';
const SOLUTIONS_PATH = 'Solutions';
const API_BASE = 'api.github.com';
const RAW_BASE = 'raw.githubusercontent.com';

// ---------------------------------------------------------------------------
// GitHub Token Management
// ---------------------------------------------------------------------------

// GitHub token removed -- the Sentinel repo is public and cloned locally.
// Unauthenticated rate limit (60 req/hr) is sufficient for occasional API calls.

// Rate limit tracking
let rateLimitRemaining = 60;
let rateLimitReset = 0;

interface GitHubContent {
  name: string;
  path: string;
  type: string;
  sha?: string;
  size?: number;
  url?: string;
  download_url?: string | null;
}

export interface SchemaColumn {
  name: string;
  type: string;
  description?: string;
}

export interface DataConnectorSchema {
  connectorName: string;
  tableName: string;
  columns: SchemaColumn[];
  sourceFile: string;
}

export function httpsGet(hostname: string, urlPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Check rate limit before making the request
    if (hostname === API_BASE && rateLimitRemaining <= 1 && rateLimitReset > Date.now() / 1000) {
      const waitSec = Math.ceil(rateLimitReset - Date.now() / 1000);
      reject(new Error(`GitHub API rate limit reached. Resets in ${waitSec}s. The app uses the local Sentinel repo clone for most operations.`));
      return;
    }

    const headers: Record<string, string> = {
      'User-Agent': 'Cribl-Microsoft-Integration/1.0',
      'Accept': hostname === API_BASE ? 'application/vnd.github.v3+json' : '*/*',
    };

    const options: https.RequestOptions = {
      hostname,
      path: urlPath,
      method: 'GET',
      headers,
    };

    const req = https.request(options, (res) => {
      // Track rate limit headers
      if (res.headers['x-ratelimit-remaining']) {
        rateLimitRemaining = parseInt(res.headers['x-ratelimit-remaining'] as string, 10);
      }
      if (res.headers['x-ratelimit-reset']) {
        rateLimitReset = parseInt(res.headers['x-ratelimit-reset'] as string, 10);
      }

      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const url = new URL(res.headers.location);
        httpsGet(url.hostname, url.pathname + url.search).then(resolve).catch(reject);
        return;
      }

      // Handle 403 rate limit specifically
      if (res.statusCode === 403) {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (data.includes('rate limit')) {
            const resetTime = rateLimitReset > 0
              ? new Date(rateLimitReset * 1000).toLocaleTimeString()
              : 'soon';
            reject(new Error(`GitHub API rate limit exceeded. Resets at ${resetTime}. The app uses the local Sentinel repo clone for most operations.`));
          } else {
            reject(new Error(`HTTP error 403: ${data.slice(0, 200)}`));
          }
        });
        return;
      }

      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP error ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// Get current rate limit info
export function getRateLimitInfo(): { remaining: number; limit: number; resetAt: number; hasToken: boolean } {
  return {
    remaining: rateLimitRemaining,
    limit: 60,
    resetAt: rateLimitReset,
    hasToken: false,
  };
}

export function githubGet(urlPath: string): Promise<string> {
  return httpsGet(API_BASE, urlPath);
}

export function rawGet(filePath: string): Promise<string> {
  return httpsGet(RAW_BASE, `/Azure/Azure-Sentinel/master/${filePath}`);
}

export { SENTINEL_REPO, SOLUTIONS_PATH, API_BASE, RAW_BASE };
export type { GitHubContent };

// Extract table schemas from Sentinel Data Connector JSON files.
// These files use various formats - we handle the common patterns:
// 1. dataTypes[].name + lastDataReceivedQuery (table name from query)
// 2. dataTypes[].name directly as table name
// 3. tables[] with columns[] array (newer format)
function extractSchemasFromConnector(connectorJson: Record<string, unknown>, sourceFile: string): DataConnectorSchema[] {
  const schemas: DataConnectorSchema[] = [];
  const connectorName = (connectorJson.title as string) || (connectorJson.name as string) || 'Unknown';

  // Format 1: "tables" array with explicit columns (newer ARM-based connectors)
  if (Array.isArray(connectorJson.tables)) {
    for (const table of connectorJson.tables) {
      const t = table as Record<string, unknown>;
      if (t.name && Array.isArray(t.columns)) {
        schemas.push({
          connectorName,
          tableName: t.name as string,
          columns: (t.columns as Array<Record<string, string>>).map((c) => ({
            name: c.name || c.columnName || '',
            type: normalizeDcrType(c.type || c.columnType || 'string'),
            description: c.description || '',
          })).filter((c) => c.name),
          sourceFile,
        });
      }
    }
  }

  // Format 2: ARM template resources with dataCollectionRules containing streamDeclarations
  if (Array.isArray(connectorJson.resources)) {
    for (const resource of connectorJson.resources) {
      const r = resource as Record<string, unknown>;
      const props = r.properties as Record<string, unknown> | undefined;
      if (!props?.streamDeclarations) continue;

      const streams = props.streamDeclarations as Record<string, { columns?: Array<Record<string, string>> }>;
      for (const [streamName, streamDef] of Object.entries(streams)) {
        if (!Array.isArray(streamDef.columns)) continue;
        const tableName = streamName.replace(/^Custom-/, '');
        schemas.push({
          connectorName,
          tableName,
          columns: streamDef.columns.map((c) => ({
            name: c.name,
            type: normalizeDcrType(c.type || 'string'),
          })).filter((c) => c.name),
          sourceFile,
        });
      }
    }
  }

  // Format 3: dataTypes array - extract table names (columns not inline, but useful for routing)
  if (schemas.length === 0 && Array.isArray(connectorJson.dataTypes)) {
    for (const dt of connectorJson.dataTypes) {
      const d = dt as Record<string, unknown>;
      const name = (d.name as string) || '';
      if (name) {
        schemas.push({
          connectorName,
          tableName: name,
          columns: [],
          sourceFile,
        });
      }
    }
  }

  // Format 4: properties.connectorDefinitionName + dataTypes in nested connector config
  if (schemas.length === 0 && connectorJson.properties) {
    const props = connectorJson.properties as Record<string, unknown>;
    if (props.connectorUiConfig) {
      const uiConfig = props.connectorUiConfig as Record<string, unknown>;
      if (Array.isArray(uiConfig.dataTypes)) {
        for (const dt of uiConfig.dataTypes) {
          const d = dt as Record<string, unknown>;
          const name = (d.name as string) || '';
          if (name) {
            schemas.push({
              connectorName,
              tableName: name,
              columns: [],
              sourceFile,
            });
          }
        }
      }
    }
  }

  return schemas;
}

function normalizeDcrType(type: string): string {
  const lower = type.toLowerCase();
  const typeMap: Record<string, string> = {
    'string': 'string',
    'int': 'int',
    'int32': 'int',
    'integer': 'int',
    'long': 'long',
    'int64': 'long',
    'bigint': 'long',
    'real': 'real',
    'double': 'real',
    'float': 'real',
    'decimal': 'real',
    'bool': 'boolean',
    'boolean': 'boolean',
    'datetime': 'datetime',
    'timestamp': 'datetime',
    'date': 'datetime',
    'time': 'datetime',
    'dynamic': 'dynamic',
    'object': 'dynamic',
    'json': 'dynamic',
    'guid': 'string',
    'uniqueidentifier': 'string',
    'uuid': 'string',
  };
  return typeMap[lower] || 'string';
}

export function registerGitHubHandlers(ipcMain: IpcMain) {
  ipcMain.handle('github:sentinel-solutions', async () => {
    // Try local repo first
    const { isRepoReady, listSolutions } = await import('./sentinel-repo');
    if (isRepoReady()) {
      return listSolutions().map((s) => ({
        name: s.name, path: s.path, type: 'dir',
        deprecated: s.deprecated, deprecationReason: s.deprecationReason,
      }));
    }

    // Fallback to GitHub API
    const urlPath = `/repos/${SENTINEL_REPO}/contents/${SOLUTIONS_PATH}`;
    const response = await githubGet(urlPath);
    const contents: GitHubContent[] = JSON.parse(response);
    return contents
      .filter((item) => item.type === 'dir')
      .map((item) => ({
        name: item.name,
        path: item.path,
        type: item.type,
      }));
  });

  ipcMain.handle('github:solution-details', async (_event, { solutionPath }: { solutionPath: string }) => {
    const urlPath = `/repos/${SENTINEL_REPO}/contents/${solutionPath}`;
    const response = await githubGet(urlPath);
    const contents: GitHubContent[] = JSON.parse(response);

    const result: Record<string, GitHubContent[]> = {};
    for (const item of contents) {
      if (item.type === 'dir') {
        try {
          const subPath = `/repos/${SENTINEL_REPO}/contents/${item.path}`;
          const subResponse = await githubGet(subPath);
          result[item.name] = JSON.parse(subResponse);
        } catch {
          result[item.name] = [];
        }
      }
    }

    return {
      name: solutionPath.split('/').pop(),
      path: solutionPath,
      directories: contents.filter((c) => c.type === 'dir').map((c) => c.name),
      files: contents.filter((c) => c.type === 'file').map((c) => c.name),
      details: result,
    };
  });

  // Fetch and parse Data Connector files from a Sentinel solution to extract table schemas
  ipcMain.handle('github:solution-schemas', async (_event, { solutionPath }: { solutionPath: string }) => {
    const allSchemas: DataConnectorSchema[] = [];

    // Try local repo first
    const { isRepoReady, listConnectorFiles, readConnectorJson } = await import('./sentinel-repo');
    if (isRepoReady()) {
      const solutionName = solutionPath.replace(/^Solutions\//, '');
      const connFiles = listConnectorFiles(solutionName);
      for (const file of connFiles) {
        const parsed = readConnectorJson(file.path);
        if (parsed) {
          const schemas = extractSchemasFromConnector(parsed, file.name);
          allSchemas.push(...schemas);
        }
      }
      return allSchemas;
    }

    // Fallback to GitHub API
    let connectorFiles: GitHubContent[] = [];

    try {
      const encodedPath = encodeURIComponent('Data Connectors');
      const urlPath = `/repos/${SENTINEL_REPO}/contents/${solutionPath}/${encodedPath}`;
      const response = await githubGet(urlPath);
      connectorFiles = JSON.parse(response);
    } catch {
      try {
        const urlPath = `/repos/${SENTINEL_REPO}/contents/${solutionPath}/DataConnectors`;
        const response = await githubGet(urlPath);
        connectorFiles = JSON.parse(response);
      } catch {
        // No data connectors directory found
      }
    }

    const jsonFiles = connectorFiles.filter(
      (f) => f.type === 'file' && f.name.endsWith('.json')
    );

    for (const file of jsonFiles) {
      try {
        const content = await rawGet(file.path);
        const parsed = JSON.parse(content);
        const schemas = extractSchemasFromConnector(parsed, file.name);
        allSchemas.push(...schemas);
      } catch {
        // Skip
      }
    }

    // Also check for nested template directories (some solutions have template_* subdirs)
    const templateDirs = connectorFiles.filter(
      (f) => f.type === 'dir' && (f.name.toLowerCase().includes('template') || f.name.toLowerCase().includes('connector'))
    );
    for (const dir of templateDirs) {
      try {
        const urlPath = `/repos/${SENTINEL_REPO}/contents/${dir.path}`;
        const response = await githubGet(urlPath);
        const subFiles: GitHubContent[] = JSON.parse(response);
        const subJsonFiles = subFiles.filter((f) => f.type === 'file' && f.name.endsWith('.json'));
        for (const file of subJsonFiles) {
          try {
            const content = await rawGet(file.path);
            const parsed = JSON.parse(content);
            const schemas = extractSchemasFromConnector(parsed, file.name);
            allSchemas.push(...schemas);
          } catch {
            // Skip
          }
        }
      } catch {
        // Skip
      }
    }

    return allSchemas;
  });

  // Fetch vendor sample data and log format documentation from a Sentinel solution.
  // Looks in: SampleData/, Sample Data/, Data Connectors (sampleQueries/instructionSteps),
  // and connector JSON files for example payloads.
  ipcMain.handle('github:vendor-samples', async (_event, { solutionPath }: { solutionPath: string }) => {
    const samples: Array<{
      tableName: string;
      format: string;
      rawEvents: string[];
      source: string;
    }> = [];

    // 1. Check for SampleData or Sample Data directories
    const sampleDirNames = ['SampleData', 'Sample Data', 'sample_data', 'sampledata'];
    for (const dirName of sampleDirNames) {
      try {
        const encoded = dirName.includes(' ') ? encodeURIComponent(dirName) : dirName;
        const urlPath = `/repos/${SENTINEL_REPO}/contents/${solutionPath}/${encoded}`;
        const response = await githubGet(urlPath);
        const files: GitHubContent[] = JSON.parse(response);

        for (const file of files) {
          if (file.type !== 'file') continue;
          try {
            const content = await rawGet(file.path);
            const tableName = file.name.replace(/\.(json|csv|log|txt|xml)$/i, '');

            if (file.name.endsWith('.json')) {
              // Parse JSON sample - could be array or single object
              try {
                const parsed = JSON.parse(content);
                const events = Array.isArray(parsed) ? parsed : [parsed];
                samples.push({
                  tableName,
                  format: 'json',
                  rawEvents: events.slice(0, 5).map((e: unknown) => JSON.stringify(e)),
                  source: `SampleData/${file.name}`,
                });
              } catch {
                // Treat as raw text
                samples.push({
                  tableName,
                  format: 'raw',
                  rawEvents: content.split('\n').filter((l: string) => l.trim()).slice(0, 5),
                  source: `SampleData/${file.name}`,
                });
              }
            } else {
              // CSV, log, txt, xml - take first few lines as raw events
              const lines = content.split('\n').filter((l: string) => l.trim());
              samples.push({
                tableName,
                format: file.name.endsWith('.csv') ? 'csv' : file.name.endsWith('.xml') ? 'xml' : 'raw',
                rawEvents: lines.slice(0, 5),
                source: `SampleData/${file.name}`,
              });
            }
          } catch {
            // Skip unreadable files
          }
        }
      } catch {
        // Directory doesn't exist, try next
      }
    }

    // 2. Extract sampleQueries and example data from Data Connector JSON files
    const connectorDirNames = ['Data Connectors', 'DataConnectors'];
    for (const dirName of connectorDirNames) {
      let connectorFiles: GitHubContent[] = [];
      try {
        const encoded = dirName.includes(' ') ? encodeURIComponent(dirName) : dirName;
        const urlPath = `/repos/${SENTINEL_REPO}/contents/${solutionPath}/${encoded}`;
        const response = await githubGet(urlPath);
        connectorFiles = JSON.parse(response);
      } catch {
        continue;
      }

      for (const file of connectorFiles) {
        if (file.type !== 'file' || !file.name.endsWith('.json')) continue;
        try {
          const content = await rawGet(file.path);
          const parsed = JSON.parse(content) as Record<string, unknown>;

          // Extract sampleQueries - often contain KQL with example field values
          const sampleQueries = extractNestedField(parsed, 'sampleQueries') as Array<Record<string, string>> | null;
          if (Array.isArray(sampleQueries)) {
            for (const sq of sampleQueries) {
              if (sq.query || sq.description) {
                // KQL queries reveal field names and expected value patterns
                const query = sq.query || '';
                const tableName = extractTableFromKql(query) || file.name.replace('.json', '');
                // If we already have samples for this table from SampleData, skip
                if (!samples.some((s) => s.tableName === tableName && s.source.includes('SampleData'))) {
                  samples.push({
                    tableName,
                    format: 'kql_hint',
                    rawEvents: [query],
                    source: `DataConnector/${file.name}:sampleQueries`,
                  });
                }
              }
            }
          }

          // Extract instructionSteps which sometimes contain example log lines
          const instructions = extractNestedField(parsed, 'instructionSteps') as Array<Record<string, unknown>> | null;
          if (Array.isArray(instructions)) {
            for (const step of instructions) {
              const desc = (step.description as string) || '';
              // Look for code blocks or JSON examples in instruction text
              const codeBlocks = desc.match(/```[\s\S]*?```/g) || [];
              const jsonBlocks = desc.match(/\{[\s\S]*?\}/g) || [];
              const exampleLines = [...codeBlocks, ...jsonBlocks]
                .map((b) => b.replace(/```\w*/g, '').trim())
                .filter((b) => b.length > 10 && b.length < 5000);

              if (exampleLines.length > 0) {
                const tableName = file.name.replace('.json', '');
                samples.push({
                  tableName,
                  format: 'doc_example',
                  rawEvents: exampleLines.slice(0, 3),
                  source: `DataConnector/${file.name}:instructionSteps`,
                });
              }
            }
          }
        } catch {
          // Skip
        }
      }
    }

    return samples;
  });

  ipcMain.handle('github:rate-limit', async () => {
    return getRateLimitInfo();
  });
}

// Walk an object tree to find a field by name (case-insensitive)
function extractNestedField(obj: Record<string, unknown>, fieldName: string): unknown {
  const lower = fieldName.toLowerCase();
  for (const [key, value] of Object.entries(obj)) {
    if (key.toLowerCase() === lower) return value;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const found = extractNestedField(value as Record<string, unknown>, fieldName);
      if (found !== null) return found;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object') {
          const found = extractNestedField(item as Record<string, unknown>, fieldName);
          if (found !== null) return found;
        }
      }
    }
  }
  return null;
}

// Extract table name from a KQL query (first word before | or where)
function extractTableFromKql(query: string): string | null {
  const match = query.trim().match(/^(\w+)/);
  if (match && match[1] && !['let', 'union', 'search', 'find'].includes(match[1].toLowerCase())) {
    return match[1];
  }
  return null;
}
