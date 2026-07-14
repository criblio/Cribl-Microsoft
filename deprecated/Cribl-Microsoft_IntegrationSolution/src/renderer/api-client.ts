// API Client - Replaces window.api (Electron preload) with fetch() calls.
// Every method matches the same signature as the preload bridge.

const API_BASE = '/api';

async function call(channel: string, args?: unknown): Promise<any> {
  // Convert colon-separated channel to URL path: auth:status -> auth/status
  const urlPath = channel.replace(/:/g, '/');
  const resp = await fetch(`${API_BASE}/${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: args !== undefined ? JSON.stringify(args) : '{}',
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
    throw new Error(err.error || `API error ${resp.status}`);
  }
  return resp.json();
}

// Server-Sent Events listener for push events
export function subscribeToEvents(callback: (channel: string, data: unknown) => void): () => void {
  const es = new EventSource(`${API_BASE}/events`);
  es.onmessage = (event) => {
    try {
      const parsed = JSON.parse(event.data);
      if (parsed.channel) {
        callback(parsed.channel, parsed.data);
      }
    } catch { /* skip */ }
  };
  return () => es.close();
}

// Build the same API surface as window.api but using fetch()
export function createApiClient() {
  // Helper for event subscriptions
  const eventListeners = new Map<string, Set<(data: any) => void>>();

  function onEvent(channel: string, callback: (data: any) => void): () => void {
    if (!eventListeners.has(channel)) eventListeners.set(channel, new Set());
    eventListeners.get(channel)!.add(callback);
    return () => { eventListeners.get(channel)?.delete(callback); };
  }

  // Start SSE connection
  subscribeToEvents((channel, data) => {
    const listeners = eventListeners.get(channel);
    if (listeners) {
      for (const cb of listeners) cb(data);
    }
  });

  return {
    deps: {
      check: () => call('deps:check'),
      install: (command: string) => call('deps:install', { command }),
    },
    powershell: {
      execute: (script: string, args: string[]) => call('ps:execute', { script, args }),
      cancel: (id: string) => call('ps:cancel', { id }),
      onOutput: (cb: (event: any) => void) => onEvent('ps:output', cb),
      onExit: (cb: (event: any) => void) => onEvent('ps:exit', cb),
    },
    config: {
      read: (filePath: string) => call('config:read', { filePath }),
      write: (filePath: string, data: Record<string, unknown>) => call('config:write', { filePath, data }),
      getRepoRoot: () => call('config:repo-root'),
    },
    github: {
      fetchSentinelSolutions: () => call('github:sentinel-solutions'),
      fetchSolutionDetails: (solutionPath: string) => call('github:solution-details', { solutionPath }),
      fetchSolutionSchemas: (solutionPath: string) => call('github:solution-schemas', { solutionPath }),
      fetchVendorSamples: (solutionPath: string) => call('github:vendor-samples', { solutionPath }),
      // setToken removed -- local repo clone used instead of GitHub API token
      rateLimit: () => call('github:rate-limit'),
      // hasToken removed -- local repo clone used instead of GitHub API token
    },
    sentinelRepo: {
      status: () => call('sentinel-repo:status'),
      sync: () => call('sentinel-repo:sync'),
      reclone: () => call('sentinel-repo:reclone'),
      solutions: () => call('sentinel-repo:solutions'),
      connectors: (solutionName: string) => call('sentinel-repo:connectors', { solutionName }),
      readFile: (relativePath: string) => call('sentinel-repo:read-file', { relativePath }),
      onStatus: (cb: (status: any) => void) => onEvent('sentinel-repo:status', cb),
      onProgress: (cb: (data: string) => void) => onEvent('sentinel-repo:progress', cb),
    },
    packBuilder: {
      scaffold: (options: unknown) => call('pack:scaffold', options),
      package: (packDir: string) => call('pack:package', { packDir }),
      list: () => call('pack:list'),
      exportArtifacts: (options: { packDir: string; crblPath?: string; exportDir?: string; tables: string[]; solutionName: string; packName: string }) =>
        call('pack:export-artifacts', options),
      delete: (packName: string) => call('pack:delete', { packName }),
      deleteCrbl: (crblName: string) => call('pack:delete-crbl', { crblName }),
      clean: () => call('pack:clean'),
      storageInfo: () => call('pack:storage-info'),
      parseRuleYaml: (yamlContents: Array<{ fileName: string; content: string }>) => call('pack:parse-rule-yaml', { yamlContents }),
      ruleCoverage: (solutionName: string, sourceFields: string[], destFields?: string[], customRules?: Array<{ name: string; severity: string; requiredFields: string[]; fileName: string }>, destTable?: string, destTables?: string[]) => call('pack:rule-coverage', { solutionName, sourceFields, destFields, customRules, destTable, destTables }),
      getDcrSchema: (tableName: string) => call('pack:dcr-schema', { tableName }),
      getAvailableTables: () => call('pack:available-tables'),
      getSourceTypes: () => call('pack:source-types'),
      suggestSource: (solutionName: string, tableName: string) => call('pack:suggest-source', { solutionName, tableName }),
      analyzeSamples: (solutionName: string, samples: Array<{ logType: string; tableName: string; rawEvents: string[] }>) => call('pack:analyze-samples', { solutionName, samples }),
    },
    paramForms: {
      list: () => call('params:list'),
      get: (formId: string) => call('params:get', { formId }),
      save: (formId: string, values: Record<string, unknown>) => call('params:save', { formId, values }),
    },
    azureDeploy: {
      parameters: () => call('azure:parameters'),
      checkExisting: (tables: string[]) => call('azure:check-existing', { tables }),
      previewResources: (options: { tables: string[]; subscription: string; resourceGroup: string; workspace: string; location: string }) =>
        call('azure:preview-resources', options),
      deployDcrs: (options: any) => call('azure:deploy-dcrs', options),
      destinations: () => call('azure:destinations'),
      refreshDestinations: (tables: string[]) => call('azure:refresh-destinations', { tables }),
      embedDestinations: (packDir: string, tables: string[]) => call('azure:embed-destinations', { packDir, tables }),
      assignDcrRole: (objectId: string, dcrResourceIds: string[]) => call('azure:assign-dcr-role', { objectId, dcrResourceIds }),
      getDcrIds: (tables: string[]) => call('azure:get-dcr-ids', { tables }),
    },
    vendorResearch: {
      list: () => call('vendor:list'),
      research: (vendorName: string) => call('vendor:research', { vendorName }),
      clearCache: (vendorName: string) => call('vendor:clear-cache', { vendorName }),
    },
    registrySync: {
      status: () => call('registry:status'),
      sync: (forceRefresh?: boolean) => call('registry:sync', { forceRefresh }),
      search: (query: string) => call('registry:search', { query }),
      lookup: (vendorName: string) => call('registry:lookup', { vendorName }),
      stats: () => call('registry:stats'),
      onProgress: (cb: (event: any) => void) => onEvent('registry:sync-progress', cb),
    },
    changeDetection: {
      status: () => call('changes:status'),
      check: () => call('changes:check'),
      packAlerts: (packName: string) => call('changes:pack-alerts', { packName }),
      packDiff: (packName: string) => call('changes:pack-diff', { packName }),
      gitLog: (solutionPath: string, sinceCommit?: string, maxEntries?: number) => call('changes:git-log', { solutionPath, sinceCommit, maxEntries }),
      fileDiffs: (solutionPath: string, sinceCommit: string) => call('changes:file-diffs', { solutionPath, sinceCommit }),
      snapshots: () => call('changes:snapshots'),
      dismiss: (packName: string) => call('changes:dismiss', { packName }),
      onStatus: (cb: (event: any) => void) => onEvent('changes:status', cb),
    },
    auth: {
      status: () => call('auth:status'),
      criblConnect: (config: any) => call('auth:cribl-connect', config),
      criblDisconnect: () => call('auth:cribl-disconnect'),
      criblReconnect: () => call('auth:cribl-reconnect'),
      criblSaved: () => call('auth:cribl-saved'),
      githubSaved: () => call('auth:github-saved'),
      githubSave: (pat: string) => call('auth:github-save', { pat }),
      githubClear: () => call('auth:github-clear'),
      azureStatus: () => call('auth:azure-status'),
      azureLogin: () => call('auth:azure-login'),
      azureSetSubscription: (subscriptionId: string) => call('auth:azure-set-subscription', { subscriptionId }),
      azureSubscriptions: () => call('auth:azure-subscriptions'),
      azureWorkspaces: (subscriptionId?: string) => call('auth:azure-workspaces', { subscriptionId }),
      azureCreateResourceGroup: (name: string, location: string, subscriptionId?: string) => call('auth:azure-create-resource-group', { name, location, subscriptionId }),
      azureResourceGroups: (subscriptionId?: string) => call('auth:azure-resource-groups', { subscriptionId }),
      azureSelectWorkspace: (workspace: any) => call('auth:azure-select-workspace', workspace),
      criblCreateDestination: (destination: Record<string, unknown>, workerGroup?: string) => call('auth:cribl-create-destination', { destination, workerGroup }),
      criblUploadPack: (crblPath: string, workerGroup?: string) => call('auth:cribl-upload-pack', { crblPath, workerGroup }),
      criblListDestinations: (workerGroup?: string) => call('auth:cribl-list-destinations', { workerGroup }),
      criblWorkspaces: () => call('auth:cribl-workspaces'),
      criblWorkerGroups: (workspaceId?: string) => call('auth:cribl-worker-groups', { workspaceId }),
      criblListPacks: (workerGroup?: string) => call('auth:cribl-list-packs', { workerGroup }),
      criblDeployMulti: (crblPath: string, workerGroups: string[]) => call('auth:cribl-deploy-multi', { crblPath, workerGroups }),
      criblSources: (workerGroup?: string) => call('auth:cribl-sources', { workerGroup }),
      criblRoutes: (workerGroup?: string) => call('auth:cribl-routes', { workerGroup }),
      criblCapture: (workerGroup: string, sourceId: string, count?: number, durationMs?: number) => call('auth:cribl-capture', { workerGroup, sourceId, count, durationMs }),
      criblPreview: (workerGroup: string, pipelineConf: Record<string, unknown>, sampleEvents: Array<Record<string, unknown>>) => call('auth:cribl-preview', { workerGroup, pipelineConf, sampleEvents }),
      criblSearch: (query: string, earliest?: string, latest?: string, maxResults?: number) => call('auth:cribl-search', { query, earliest, latest, maxResults }),
      criblDatasets: () => call('auth:cribl-datasets'),
      criblCreateDataset: (datasetId: string, description?: string) => call('auth:cribl-create-dataset', { datasetId, description }),
      criblTestUrl: (urlPath: string) => call('auth:cribl-test-url', { urlPath }),
      criblCreateBreaker: (workerGroup: string, breakerId: string, breakerConfig: Record<string, unknown>) => call('auth:cribl-create-breaker', { workerGroup, breakerId, breakerConfig }),
      criblCreateSecret: (workerGroup: string, secretId: string, secretValue: string, description?: string) => call('auth:cribl-create-secret', { workerGroup, secretId, secretValue, description }),
      criblCreateRoute: (workerGroup: string, routeId: string, name: string, filter: string, packId: string, output?: string, description?: string, final?: boolean) =>
        call('auth:cribl-create-route', { workerGroup, routeId, name, filter, packId, output, description, final }),
      criblCommit: (message: string) => call('auth:cribl-commit', { message }),
      criblDeployConfig: (workerGroup: string) => call('auth:cribl-deploy-config', { workerGroup }),
      azureQuery: (query: string, timespan?: string) => call('auth:azure-query', { query, timespan }),
    },
    sampleParser: {
      parseContent: (content: string, sourceName?: string) => call('samples:parse-content', { content, sourceName }),
      parseFiles: async () => {
        // In web mode, use an HTML file input to select files, then upload via multipart
        return new Promise<any[]>((resolve) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.multiple = true;
          input.accept = '.json,.log,.txt,.csv,.xml,.ndjson,*';
          input.onchange = async () => {
            if (!input.files || input.files.length === 0) { resolve([]); return; }
            const formData = new FormData();
            for (const file of Array.from(input.files)) {
              formData.append('files', file);
            }
            try {
              const resp = await fetch(`${API_BASE}/samples/upload-files`, { method: 'POST', body: formData });
              if (resp.ok) { resolve(await resp.json()); } else { resolve([]); }
            } catch { resolve([]); }
          };
          input.oncancel = () => resolve([]);
          input.click();
        });
      },
      parseFeedConfig: (configText: string) => call('samples:parse-feed-config', { configText }),
      tagSample: (vendor: string, logType: string, content: string, sourceName?: string) =>
        call('samples:tag-sample', { vendor, logType, content, sourceName }),
      getTagged: (vendor: string) => call('samples:get-tagged', { vendor }),
      listTaggedVendors: () => call('samples:list-tagged-vendors'),
      autoDetectTypes: (content: string) => call('samples:auto-detect-types', { content }),
    },
    e2e: {
      status: () => call('e2e:status'),
      start: (options: any) => call('e2e:start', options),
      availableSources: () => call('e2e:available-sources'),
      reset: () => call('e2e:reset'),
      onProgress: (cb: (state: unknown) => void) => onEvent('e2e:progress', cb),
    },
    permissions: {
      check: (workerGroup?: string) => call('permissions:check', { workerGroup }),
    },
    defaultSamples: {
      availableVendors: () => call('samples:available-vendors'),
      generate: (vendorName: string, eventsPerLogType?: number) => call('samples:generate-defaults', { vendorName, eventsPerLogType }),
      sentinelRepoSamples: (solutionName: string) => call('samples:sentinel-repo-samples', { solutionName }),
    },
    fieldMatcher: {
      match: (sourceFields: any[], destFields: any[], vendorMappings?: any[]) => call('fields:match', { sourceFields, destFields, vendorMappings }),
      matchToSchema: (sampleFields: any[], tableName: string, vendorMappings?: any[]) => call('fields:match-to-schema', { sampleFields, tableName, vendorMappings }),
    },
    siemMigration: {
      parse: (content: string, platform: 'splunk' | 'qradar', fileName?: string) => call('siem:parse', { content, platform, fileName }),
      buildPack: (solutionName: string, packName?: string, userSamples?: Array<{ logType: string; content: string; fileName: string }>) => call('siem:build-pack', { solutionName, packName, userSamples }),
      exportReport: (plan: unknown) => call('siem:export-report', { plan }),
    },
  };
}
