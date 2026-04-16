import { contextBridge, ipcRenderer } from 'electron';

export interface PsOutputEvent {
  id: string;
  stream: 'stdout' | 'stderr';
  data: string;
}

export interface PsExitEvent {
  id: string;
  code: number | null;
}

contextBridge.exposeInMainWorld('api', {
  deps: {
    check: (): Promise<Array<{
      name: string; description: string; required: boolean;
      installed: boolean; version: string; installHint: string;
    }>> => ipcRenderer.invoke('deps:check'),
    install: (command: string): Promise<{ success: boolean; output: string }> =>
      ipcRenderer.invoke('deps:install', { command }),
  },
  powershell: {
    execute: (script: string, args: string[]): Promise<{ id: string; pid: number }> =>
      ipcRenderer.invoke('ps:execute', { script, args }),
    cancel: (id: string): Promise<void> =>
      ipcRenderer.invoke('ps:cancel', { id }),
    onOutput: (callback: (event: PsOutputEvent) => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: PsOutputEvent) => callback(data);
      ipcRenderer.on('ps:output', handler);
      return () => ipcRenderer.removeListener('ps:output', handler);
    },
    onExit: (callback: (event: PsExitEvent) => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: PsExitEvent) => callback(data);
      ipcRenderer.on('ps:exit', handler);
      return () => ipcRenderer.removeListener('ps:exit', handler);
    },
  },
  config: {
    read: (filePath: string): Promise<Record<string, unknown>> =>
      ipcRenderer.invoke('config:read', { filePath }),
    write: (filePath: string, data: Record<string, unknown>): Promise<void> =>
      ipcRenderer.invoke('config:write', { filePath, data }),
    getRepoRoot: (): Promise<string> =>
      ipcRenderer.invoke('config:repo-root'),
  },
  github: {
    fetchSentinelSolutions: (): Promise<Array<{ name: string; path: string; type: string }>> =>
      ipcRenderer.invoke('github:sentinel-solutions'),
    fetchSolutionDetails: (solutionPath: string): Promise<unknown> =>
      ipcRenderer.invoke('github:solution-details', { solutionPath }),
    fetchSolutionSchemas: (solutionPath: string): Promise<unknown[]> =>
      ipcRenderer.invoke('github:solution-schemas', { solutionPath }),
    fetchVendorSamples: (solutionPath: string): Promise<Array<{
      tableName: string; format: string; rawEvents: string[]; source: string;
    }>> => ipcRenderer.invoke('github:vendor-samples', { solutionPath }),
    rateLimit: (): Promise<{ remaining: number; limit: number; resetAt: number; hasToken: boolean }> =>
      ipcRenderer.invoke('github:rate-limit'),
  },
  sentinelRepo: {
    status: (): Promise<{
      state: string; localPath: string; lastUpdated: number;
      lastCommit: string; solutionCount: number; error: string;
    }> => ipcRenderer.invoke('sentinel-repo:status'),
    sync: (): Promise<{ started: boolean; reason?: string }> =>
      ipcRenderer.invoke('sentinel-repo:sync'),
    reclone: (): Promise<{ started: boolean }> =>
      ipcRenderer.invoke('sentinel-repo:reclone'),
    solutions: (): Promise<Array<{ name: string; path: string }>> =>
      ipcRenderer.invoke('sentinel-repo:solutions'),
    connectors: (solutionName: string): Promise<Array<{ name: string; path: string; size: number }>> =>
      ipcRenderer.invoke('sentinel-repo:connectors', { solutionName }),
    readFile: (relativePath: string): Promise<string | null> =>
      ipcRenderer.invoke('sentinel-repo:read-file', { relativePath }),
    onStatus: (callback: (status: { state: string; solutionCount: number; error: string }) => void) => {
      const handler = (_: unknown, data: Parameters<typeof callback>[0]) => callback(data);
      ipcRenderer.on('sentinel-repo:status', handler);
      return () => ipcRenderer.removeListener('sentinel-repo:status', handler);
    },
    onProgress: (callback: (data: string) => void) => {
      const handler = (_: unknown, data: string) => callback(data);
      ipcRenderer.on('sentinel-repo:progress', handler);
      return () => ipcRenderer.removeListener('sentinel-repo:progress', handler);
    },
  },
  packBuilder: {
    scaffold: (options: unknown): Promise<{ packDir: string; crblPath: string }> =>
      ipcRenderer.invoke('pack:scaffold', options),
    package: (packDir: string): Promise<{ packDir: string; crblPath: string }> =>
      ipcRenderer.invoke('pack:package', { packDir }),
    list: (): Promise<Array<{ name: string; version: string; path: string }>> =>
      ipcRenderer.invoke('pack:list'),
    exportArtifacts: (options: { packDir: string; crblPath?: string; exportDir?: string; tables: string[]; solutionName: string; packName: string }): Promise<{
      exportPath: string; artifacts: string[];
    }> => ipcRenderer.invoke('pack:export-artifacts', options),
    delete: (packName: string): Promise<void> =>
      ipcRenderer.invoke('pack:delete', { packName }),
    deleteCrbl: (crblName: string): Promise<void> =>
      ipcRenderer.invoke('pack:delete-crbl', { crblName }),
    clean: (): Promise<{ removed: string[]; freedBytes: number }> =>
      ipcRenderer.invoke('pack:clean'),
    storageInfo: (): Promise<{
      packsDir: string; totalSize: number; packCount: number;
      crblCount: number; orphanedCrblCount: number; oldVersionCount: number;
    }> => ipcRenderer.invoke('pack:storage-info'),
    parseRuleYaml: (yamlContents: Array<{ fileName: string; content: string }>): Promise<{
      success: boolean; rules: Array<{ name: string; severity: string; requiredFields: string[]; fileName: string }>; error?: string;
    }> => ipcRenderer.invoke('pack:parse-rule-yaml', { yamlContents }),
    ruleCoverage: (solutionName: string, sourceFields: string[], destFields?: string[], customRules?: Array<{ name: string; severity: string; requiredFields: string[]; fileName: string }>, destTable?: string, destTables?: string[]): Promise<{
      rules: Array<{ name: string; severity: string; tactics: string[]; totalFields: number; coveredFields: string[]; missingFields: string[]; coverage: number; custom?: boolean; query?: string }>;
      summary: { totalRules: number; fullyCovered: number; partiallyCovered: number; missingFieldsAcrossRules: string[]; ruleReferencedFields: string[] };
    }> => ipcRenderer.invoke('pack:rule-coverage', { solutionName, sourceFields, destFields, customRules, destTable, destTables }),
    getDcrSchema: (tableName: string): Promise<Array<{ name: string; type: string }>> =>
      ipcRenderer.invoke('pack:dcr-schema', { tableName }),
    getAvailableTables: (): Promise<string[]> =>
      ipcRenderer.invoke('pack:available-tables'),
    getSourceTypes: (): Promise<Array<{
      id: string; name: string; description: string; category: string;
      criblType: string; fields: unknown[]; hasDiscovery: boolean;
      discoveryDescription: string; discoveryFields: unknown[];
      vendorPresets: Array<{ key: string; label: string; description: string }>;
    }>> => ipcRenderer.invoke('pack:source-types'),
    suggestSource: (solutionName: string, tableName: string): Promise<{
      sourceType: string; preset?: string;
    } | null> => ipcRenderer.invoke('pack:suggest-source', { solutionName, tableName }),
    analyzeSamples: (solutionName: string, samples: Array<{ logType: string; tableName: string; rawEvents: string[] }>): Promise<{
      tables: Array<{ tableName: string; logType: string; fieldCount: number; matchRate: number; overflowCount: number }>;
    }> => ipcRenderer.invoke('pack:analyze-samples', { solutionName, samples }),
  },
  vendorResearch: {
    list: (): Promise<Array<{
      vendor: string; displayName: string; description: string; sourceType: string;
    }>> => ipcRenderer.invoke('vendor:list'),
    research: (vendorName: string): Promise<{
      vendor: string; displayName: string; description: string;
      logTypes: Array<{
        id: string; name: string; description: string;
        fields: Array<{ name: string; type: string; description: string; required: boolean; example?: string; logType?: string }>;
        sourcetypePattern?: string; timestampField?: string;
      }>;
      sourceType: string; sourcePreset?: string;
      documentationUrl: string; fetchedAt: number; fromCache: boolean;
    } | null> => ipcRenderer.invoke('vendor:research', { vendorName }),
    clearCache: (vendorName: string): Promise<void> =>
      ipcRenderer.invoke('vendor:clear-cache', { vendorName }),
  },
  paramForms: {
    list: (): Promise<Array<{
      id: string; name: string; description: string; configPath: string;
      exists: boolean;
      fields: Array<{
        key: string; label: string; type: string; description: string;
        group: string; required: boolean; placeholder?: string;
        default?: string | number | boolean; sensitive?: boolean;
        options?: Array<{ value: string; label: string }>;
      }>;
    }>> => ipcRenderer.invoke('params:list'),
    get: (formId: string): Promise<{
      form: { id: string; name: string; description: string; configPath: string; fields: unknown[] };
      values: Record<string, unknown>;
    }> => ipcRenderer.invoke('params:get', { formId }),
    save: (formId: string, values: Record<string, unknown>): Promise<{ success: boolean; path: string }> =>
      ipcRenderer.invoke('params:save', { formId, values }),
  },
  azureDeploy: {
    parameters: (): Promise<{
      subscriptionId: string; resourceGroupName: string; workspaceName: string;
      location: string; tenantId: string; clientId: string;
      dcrPrefix: string; dcrSuffix: string; dcePrefix: string; dceSuffix: string;
      ownerTag: string;
    } | null> => ipcRenderer.invoke('azure:parameters'),
    checkExisting: (tables: string[]): Promise<Record<string, unknown>> =>
      ipcRenderer.invoke('azure:check-existing', { tables }),
    previewResources: (options: { tables: string[]; subscription: string; resourceGroup: string; workspace: string; location: string }): Promise<{
      resources: Array<{ type: string; name: string; table: string; exists: boolean; armTemplate?: any }>;
    }> => ipcRenderer.invoke('azure:preview-resources', options),
    deployDcrs: (options: {
      tables: string[];
      mode: string;
      templateOnly: boolean;
    }): Promise<{
      success: boolean;
      destinations: Array<{
        id: string; type: string; dceEndpoint: string; dcrID: string;
        streamName: string; client_id: string; loginUrl: string; url: string; tableName: string;
      }>;
      error?: string;
    }> => ipcRenderer.invoke('azure:deploy-dcrs', options),
    destinations: (): Promise<Array<{
      id: string; type: string; dceEndpoint: string; dcrID: string;
      streamName: string; client_id: string; loginUrl: string; url: string; tableName: string;
    }>> => ipcRenderer.invoke('azure:destinations'),
    embedDestinations: (packDir: string, tables: string[]): Promise<{
      success: boolean; destinations: unknown[]; error?: string; message?: string;
    }> => ipcRenderer.invoke('azure:embed-destinations', { packDir, tables }),
    assignDcrRole: (objectId: string, dcrResourceIds: string[]): Promise<{
      results: Array<{ dcr: string; success: boolean; error?: string }>; assigned: number; total: number;
    }> => ipcRenderer.invoke('azure:assign-dcr-role', { objectId, dcrResourceIds }),
    getDcrIds: (tables: string[]): Promise<Array<{ table: string; resourceId: string }>> =>
      ipcRenderer.invoke('azure:get-dcr-ids', { tables }),
    refreshDestinations: (tables: string[]): Promise<{
      success: boolean; saved: string[]; total: number; error?: string;
    }> => ipcRenderer.invoke('azure:refresh-destinations', { tables }),
  },
  registrySync: {
    status: (): Promise<{
      state: string; total: number; completed: number;
      currentSolution: string; errorMessage: string;
      lastSyncTime: number; entriesFound: number;
    }> => ipcRenderer.invoke('registry:status'),
    sync: (forceRefresh?: boolean): Promise<{ started: boolean; reason?: string }> =>
      ipcRenderer.invoke('registry:sync', { forceRefresh: forceRefresh ?? false }),
    search: (query: string): Promise<Array<{
      vendor: string; displayName: string; solutionPath: string;
      logTypes: Array<{ id: string; name: string; description: string; fields: unknown[] }>;
      dataConnectorFiles: string[]; lastSynced: number;
    }>> => ipcRenderer.invoke('registry:search', { query }),
    lookup: (vendorName: string): Promise<{
      vendor: string; displayName: string; solutionPath: string;
      logTypes: Array<{ id: string; name: string; description: string; fields: unknown[] }>;
      dataConnectorFiles: string[]; lastSynced: number;
    } | null> => ipcRenderer.invoke('registry:lookup', { vendorName }),
    stats: (): Promise<{
      lastFullSync: number; totalSolutions: number; totalLogTypes: number;
      totalFields: number; solutionsWithSchemas: number; solutionsWithoutSchemas: number;
    }> => ipcRenderer.invoke('registry:stats'),
    onProgress: (callback: (event: {
      state: string; total: number; completed: number;
      currentSolution: string; entriesFound: number;
    }) => void) => {
      const handler = (_: unknown, data: Parameters<typeof callback>[0]) => callback(data);
      ipcRenderer.on('registry:sync-progress', handler);
      return () => ipcRenderer.removeListener('registry:sync-progress', handler);
    },
  },
  changeDetection: {
    // Get current status + all alerts
    status: (): Promise<{
      status: string;
      lastCheckTime: number;
      alerts: Array<{
        packName: string; solutionName: string; buildTime: number; checkTime: number;
        hasChanges: boolean; totalChanges: number;
        criticalCount: number; warningCount: number; infoCount: number;
        changes: Array<{
          category: string; severity: string; description: string;
          fileName?: string; logTypeName?: string;
          oldValue?: string | number; newValue?: string | number;
        }>;
      }>;
      summary: {
        totalPacks: number; packsWithChanges: number;
        criticalCount: number; warningCount: number;
      };
    }> => ipcRenderer.invoke('changes:status'),
    // Trigger change detection for all packs
    check: (): Promise<{ started: boolean; reason?: string }> =>
      ipcRenderer.invoke('changes:check'),
    // Get alerts for a specific pack
    packAlerts: (packName: string): Promise<unknown> =>
      ipcRenderer.invoke('changes:pack-alerts', { packName }),
    // Get full diff for a specific pack (live check)
    packDiff: (packName: string): Promise<{
      packName: string; solutionName: string; buildTime: number;
      daysSinceBuild: number; buildCommit: string; currentCommit: string;
      changes: Array<{
        category: string; severity: string; description: string;
        fileName?: string; logTypeName?: string;
        oldValue?: string | number; newValue?: string | number;
      }>;
      gitLog: Array<{ hash: string; date: string; subject: string; author: string }>;
      fileDiffs: Array<{ file: string; status: string; additions: number; deletions: number }>;
      recommendation: string;
    } | null> => ipcRenderer.invoke('changes:pack-diff', { packName }),
    gitLog: (solutionPath: string, sinceCommit?: string, maxEntries?: number): Promise<
      Array<{ hash: string; date: string; subject: string; author: string }>
    > => ipcRenderer.invoke('changes:git-log', { solutionPath, sinceCommit, maxEntries }),
    fileDiffs: (solutionPath: string, sinceCommit: string): Promise<
      Array<{ file: string; status: string; additions: number; deletions: number }>
    > => ipcRenderer.invoke('changes:file-diffs', { solutionPath, sinceCommit }),
    // Get all snapshots
    snapshots: (): Promise<Record<string, unknown>> =>
      ipcRenderer.invoke('changes:snapshots'),
    // Dismiss changes for a pack
    dismiss: (packName: string): Promise<void> =>
      ipcRenderer.invoke('changes:dismiss', { packName }),
    // Subscribe to status broadcasts
    onStatus: (callback: (event: {
      status: string; alertCount: number;
      criticalCount: number; warningCount: number; lastCheckTime: number;
    }) => void) => {
      const handler = (_: unknown, data: Parameters<typeof callback>[0]) => callback(data);
      ipcRenderer.on('changes:status', handler);
      return () => ipcRenderer.removeListener('changes:status', handler);
    },
  },
  auth: {
    status: (): Promise<{
      cribl: { connected: boolean; baseUrl: string; error?: string };
      azure: { loggedIn: boolean; accountId: string; subscriptionId: string; subscriptionName: string; tenantId: string; error?: string };
    }> => ipcRenderer.invoke('auth:status'),
    criblConnect: (config: {
      clientId: string; clientSecret: string; baseUrl: string;
      deploymentType: 'cloud' | 'self-managed'; organizationId?: string;
    }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('auth:cribl-connect', config),
    criblDisconnect: (): Promise<void> => ipcRenderer.invoke('auth:cribl-disconnect'),
    criblReconnect: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('auth:cribl-reconnect'),
    criblSaved: (): Promise<{
      clientId: string; deploymentType: string; baseUrl: string;
      organizationId: string; hasSecret: boolean;
    } | null> => ipcRenderer.invoke('auth:cribl-saved'),
    azureStatus: (): Promise<{
      loggedIn: boolean; accountId: string; subscriptionId: string; subscriptionName: string; tenantId: string;
    }> => ipcRenderer.invoke('auth:azure-status'),
    azureLogin: (): Promise<{
      loggedIn: boolean; accountId: string; subscriptionId: string; subscriptionName: string; tenantId: string;
    }> => ipcRenderer.invoke('auth:azure-login'),
    azureSetSubscription: (subscriptionId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('auth:azure-set-subscription', { subscriptionId }),
    azureSubscriptions: (): Promise<{
      success: boolean;
      subscriptions: Array<{ id: string; name: string; state: string }>;
      error?: string;
    }> => ipcRenderer.invoke('auth:azure-subscriptions'),
    azureWorkspaces: (subscriptionId?: string): Promise<{
      success: boolean;
      workspaces: Array<{ name: string; resourceGroup: string; location: string; customerId: string; sku: string }>;
      error?: string;
    }> => ipcRenderer.invoke('auth:azure-workspaces', { subscriptionId }),
    azureCreateResourceGroup: (name: string, location: string, subscriptionId?: string): Promise<{
      success: boolean; error?: string;
    }> => ipcRenderer.invoke('auth:azure-create-resource-group', { name, location, subscriptionId }),
    azureResourceGroups: (subscriptionId?: string): Promise<{
      success: boolean;
      resourceGroups: Array<{ name: string; location: string }>;
      error?: string;
    }> => ipcRenderer.invoke('auth:azure-resource-groups', { subscriptionId }),
    azureSelectWorkspace: (workspace: {
      workspaceName: string; resourceGroupName: string; location: string; subscriptionId: string;
    }): Promise<{ success: boolean }> => ipcRenderer.invoke('auth:azure-select-workspace', workspace),
    criblCreateDestination: (destination: Record<string, unknown>, workerGroup?: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('auth:cribl-create-destination', { destination, workerGroup }),
    criblUploadPack: (crblPath: string, workerGroup?: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('auth:cribl-upload-pack', { crblPath, workerGroup }),
    criblListDestinations: (workerGroup?: string): Promise<{ success: boolean; destinations: string[]; error?: string }> =>
      ipcRenderer.invoke('auth:cribl-list-destinations', { workerGroup }),
    criblWorkspaces: (): Promise<{ success: boolean; workspaces: Array<{ id: string; name: string; description: string }>; error?: string }> =>
      ipcRenderer.invoke('auth:cribl-workspaces'),
    criblWorkerGroups: (workspaceId?: string): Promise<{ success: boolean; groups: Array<{ id: string; name: string; workerCount: number; description: string }>; error?: string }> =>
      ipcRenderer.invoke('auth:cribl-worker-groups', { workspaceId }),
    criblListPacks: (workerGroup?: string): Promise<{ success: boolean; packs: Array<{ id: string; name: string; version: string }>; error?: string }> =>
      ipcRenderer.invoke('auth:cribl-list-packs', { workerGroup }),
    criblDeployMulti: (crblPath: string, workerGroups: string[]): Promise<{
      results: Array<{ group: string; success: boolean; error?: string }>;
      error?: string;
    }> => ipcRenderer.invoke('auth:cribl-deploy-multi', { crblPath, workerGroups }),
    // Live data sources and routes
    criblSources: (workerGroup?: string): Promise<{
      success: boolean; sources: Array<{ id: string; type: string; disabled: boolean; description: string }>; error?: string;
    }> => ipcRenderer.invoke('auth:cribl-sources', { workerGroup }),
    criblRoutes: (workerGroup?: string): Promise<{
      success: boolean; routes: Array<{ id: string; name: string; description: string }>; error?: string;
    }> => ipcRenderer.invoke('auth:cribl-routes', { workerGroup }),
    // Live capture from a source
    criblCapture: (workerGroup: string, sourceId: string, count?: number, durationMs?: number): Promise<{
      success: boolean; events: Array<Record<string, unknown>>; error?: string;
    }> => ipcRenderer.invoke('auth:cribl-capture', { workerGroup, sourceId, count, durationMs }),
    // Preview pipeline with events
    criblPreview: (workerGroup: string, pipelineConf: Record<string, unknown>, sampleEvents: Array<Record<string, unknown>>): Promise<{
      success: boolean; events: Array<Record<string, unknown>>; error?: string;
    }> => ipcRenderer.invoke('auth:cribl-preview', { workerGroup, pipelineConf, sampleEvents }),
    // Cribl Search (Lake query)
    criblSearch: (query: string, earliest?: string, latest?: string, maxResults?: number): Promise<{
      success: boolean; events: Array<Record<string, unknown>>; error?: string;
    }> => ipcRenderer.invoke('auth:cribl-search', { query, earliest, latest, maxResults }),
    // List Lake datasets
    criblDatasets: (): Promise<{
      success: boolean; datasets: Array<{ id: string; name: string }>; error?: string;
    }> => ipcRenderer.invoke('auth:cribl-datasets'),
    criblCreateDataset: (datasetId: string, description?: string): Promise<{
      success: boolean; error?: string;
    }> => ipcRenderer.invoke('auth:cribl-create-dataset', { datasetId, description }),
    azureQuery: (query: string, timespan?: string): Promise<{
      success: boolean; rows: Array<Record<string, unknown>>; error?: string;
    }> => ipcRenderer.invoke('auth:azure-query', { query, timespan }),
    criblTestUrl: (urlPath: string): Promise<{ status: number; body: string; url?: string }> =>
      ipcRenderer.invoke('auth:cribl-test-url', { urlPath }),
    criblCreateBreaker: (workerGroup: string, breakerId: string, breakerConfig: Record<string, unknown>): Promise<{
      success: boolean; error?: string;
    }> => ipcRenderer.invoke('auth:cribl-create-breaker', { workerGroup, breakerId, breakerConfig }),
    criblCreateSecret: (workerGroup: string, secretId: string, secretValue: string, description?: string): Promise<{
      success: boolean; error?: string;
    }> => ipcRenderer.invoke('auth:cribl-create-secret', { workerGroup, secretId, secretValue, description }),
    criblCreateRoute: (workerGroup: string, routeId: string, name: string, filter: string, packId: string, output?: string, description?: string, final?: boolean): Promise<{
      success: boolean; error?: string;
    }> => ipcRenderer.invoke('auth:cribl-create-route', { workerGroup, routeId, name, filter, packId, output, description, final: final }),
    criblCommit: (message: string): Promise<{
      success: boolean; error?: string;
    }> => ipcRenderer.invoke('auth:cribl-commit', { message }),
    criblDeployConfig: (workerGroup: string): Promise<{
      success: boolean; error?: string;
    }> => ipcRenderer.invoke('auth:cribl-deploy-config', { workerGroup }),
  },
  sampleParser: {
    parseContent: (content: string, sourceName?: string): Promise<{
      format: string; eventCount: number;
      fields: Array<{ name: string; type: string; sampleValues: string[]; occurrence: number; required: boolean }>;
      rawEvents: string[]; sourceName: string; timestampField: string; errors: string[];
    }> => ipcRenderer.invoke('samples:parse-content', { content, sourceName }),
    parseFiles: (): Promise<Array<{
      format: string; eventCount: number;
      fields: Array<{ name: string; type: string; sampleValues: string[]; occurrence: number; required: boolean }>;
      rawEvents: string[]; sourceName: string; timestampField: string; errors: string[];
    }>> => ipcRenderer.invoke('samples:parse-files'),
    parseFeedConfig: (configText: string): Promise<{
      vendor: string; feedType: string; format: string;
      fields: string[]; transportProtocol: string; port: number; rawConfig: string;
    }> => ipcRenderer.invoke('samples:parse-feed-config', { configText }),
    tagSample: (vendor: string, logType: string, content: string, sourceName?: string): Promise<{
      vendor: string; logType: string; format: string; eventCount: number;
      fieldCount: number; timestampField: string; errors: string[];
    }> => ipcRenderer.invoke('samples:tag-sample', { vendor, logType, content, sourceName }),
    getTagged: (vendor: string): Promise<Array<{
      vendor: string; logType: string; format: string; eventCount: number; fieldCount: number;
      fields: Array<{ name: string; type: string; sampleValues: string[]; occurrence: number; required: boolean }>;
      rawEvents: string[]; timestampField: string;
    }>> => ipcRenderer.invoke('samples:get-tagged', { vendor }),
    listTaggedVendors: (): Promise<Array<{ vendor: string; logTypes: string[]; totalEvents: number }>> =>
      ipcRenderer.invoke('samples:list-tagged-vendors'),
    autoDetectTypes: (content: string): Promise<{
      logTypes: Array<{ name: string; eventCount: number; discriminator: string; value: string }>;
      discriminatorField: string;
    }> => ipcRenderer.invoke('samples:auto-detect-types', { content }),
  },
  e2e: {
    status: (): Promise<{
      status: string; sources: unknown[]; currentSource: string; error: string;
    }> => ipcRenderer.invoke('e2e:status'),
    start: (options: {
      sources: Array<{ id: string; vendor: string; displayName: string; tables: string[]; sourceType: string; selected: boolean }>;
      criblAuth: { clientId: string; clientSecret: string; baseUrl: string; deploymentType: string } | null;
      workerGroup: string;
    }): Promise<{ started: boolean; reason?: string }> =>
      ipcRenderer.invoke('e2e:start', options),
    availableSources: (): Promise<Array<{
      id: string; vendor: string; displayName: string; tables: string[]; sourceType: string; selected: boolean;
    }>> => ipcRenderer.invoke('e2e:available-sources'),
    reset: (): Promise<void> => ipcRenderer.invoke('e2e:reset'),
    onProgress: (callback: (state: unknown) => void) => {
      const handler = (_: unknown, data: unknown) => callback(data);
      ipcRenderer.on('e2e:progress', handler);
      return () => ipcRenderer.removeListener('e2e:progress', handler);
    },
  },
  permissions: {
    check: (workerGroup?: string): Promise<{
      cribl: {
        connected: boolean; role: string;
        canManagePacks: boolean; canManageOutputs: boolean;
        canManageInputs: boolean; canManageRoutes: boolean;
        canCaptureSamples: boolean; canSearch: boolean;
        permissions: Array<{ resource: string; action: string; granted: boolean; detail: string }>;
        error: string;
      };
      azure: {
        loggedIn: boolean; canCreateDcr: boolean; canCreateDce: boolean;
        canCreateTable: boolean; canWriteResourceGroup: boolean; canReadWorkspace: boolean;
        permissions: Array<{ resource: string; action: string; granted: boolean; detail: string }>;
        error: string;
      };
      canDeploy: boolean;
      summary: string;
    }> => ipcRenderer.invoke('permissions:check', { workerGroup }),
  },
  defaultSamples: {
    availableVendors: (): Promise<Array<{
      vendor: string; displayName: string; logTypeCount: number; fieldCount: number; source: string;
    }>> => ipcRenderer.invoke('samples:available-vendors'),
    generate: (vendorName: string, eventsPerLogType?: number): Promise<{
      vendor: string; displayName: string;
      logTypes: Array<{
        logTypeId: string; logTypeName: string; vendor: string;
        eventCount: number;
        fields: Array<{ name: string; type: string }>;
        events: Array<Record<string, unknown>>;
        rawEvents: string[];
        timestampField: string;
      }>;
      totalEvents: number; totalFields: number;
    } | null> => ipcRenderer.invoke('samples:generate-defaults', { vendorName, eventsPerLogType }),
    sentinelRepoSamples: (solutionName: string): Promise<{
      success: boolean;
      samples: Array<{
        vendor: string; logType: string; format: string;
        eventCount: number; fieldCount: number; rawEvents: string[];
        timestampField: string; source: string;
        fields: Array<{ name: string; type: string; sampleValues: string[] }>;
      }>;
      filesSearched?: number;
      message?: string;
      error?: string;
    }> => ipcRenderer.invoke('samples:sentinel-repo-samples', { solutionName }),
  },
  fieldMatcher: {
    match: (
      sourceFields: Array<{ name: string; type: string; sampleValue?: string }>,
      destFields: Array<{ name: string; type: string }>,
      vendorMappings?: Array<{ sourceName: string; destName: string; sourceType: string; destType: string; action: string }>,
    ): Promise<{
      matched: Array<{
        sourceName: string; sourceType: string; destName: string; destType: string;
        confidence: string; action: string; needsCoercion: boolean; description: string; sampleValue?: string;
      }>;
      unmatchedSource: Array<{ name: string; type: string }>;
      unmatchedDest: Array<{ name: string; type: string }>;
      totalSource: number; totalDest: number; matchRate: number;
    }> => ipcRenderer.invoke('fields:match', { sourceFields, destFields, vendorMappings }),
    matchToSchema: (
      sampleFields: Array<{ name: string; type: string; sampleValues?: string[] }>,
      tableName: string,
      vendorMappings?: Array<{ sourceName: string; destName: string; sourceType: string; destType: string; action: string }>,
    ): Promise<{
      matched: Array<{
        sourceName: string; sourceType: string; destName: string; destType: string;
        confidence: string; action: string; needsCoercion: boolean; description: string;
      }>;
      unmatchedSource: Array<{ name: string; type: string }>;
      unmatchedDest: Array<{ name: string; type: string }>;
      totalSource: number; totalDest: number; matchRate: number;
    }> => ipcRenderer.invoke('fields:match-to-schema', { sampleFields, tableName, vendorMappings }),
  },
  siemMigration: {
    parse: (content: string, platform: 'splunk' | 'qradar', fileName?: string): Promise<{
      success: boolean; plan: unknown; error?: string;
    }> => ipcRenderer.invoke('siem:parse', { content, platform, fileName }),
    buildPack: (solutionName: string, packName?: string, userSamples?: Array<{ logType: string; content: string; fileName: string }>): Promise<{
      success: boolean; solutionName?: string; packName?: string; tables?: string[]; error?: string;
      sampleInfo?: { tier: string; eventCount: number; sources: string[] };
    }> => ipcRenderer.invoke('siem:build-pack', { solutionName, packName, userSamples }),
    exportReport: (plan: unknown): Promise<{
      success: boolean; filePath: string; report: string; error?: string;
    }> => ipcRenderer.invoke('siem:export-report', { plan }),
  },
  sampleResolver: {
    listAvailable: (solutionName: string): Promise<Array<{
      id: string; tier: string; source: string; logType: string;
      format: string; eventCount: number; fileName: string;
    }>> => ipcRenderer.invoke('samples:list-available', { solutionName }),
    loadSelected: (solutionName: string, selectedIds: string[]): Promise<Array<{
      tableName: string; format: string; rawEvents: string[];
      source: string; tier: string; logType?: string;
    }>> => ipcRenderer.invoke('samples:load-selected', { solutionName, selectedIds }),
  },
  elasticRepo: {
    status: (): Promise<{ state: string; packageCount: number; lastUpdated: number; error: string }> =>
      ipcRenderer.invoke('elastic-repo:status'),
    clone: (): Promise<boolean> =>
      ipcRenderer.invoke('elastic-repo:clone'),
    onStatus: (callback: (status: { state: string; packageCount: number; error: string }) => void) => {
      const handler = (_: unknown, data: Parameters<typeof callback>[0]) => callback(data);
      ipcRenderer.on('elastic-repo:status', handler);
      return () => ipcRenderer.removeListener('elastic-repo:status', handler);
    },
  },
  onStartupLog: (callback: (log: { message: string; level: string; timestamp: number }) => void) => {
    const handler = (_: unknown, data: Parameters<typeof callback>[0]) => callback(data);
    ipcRenderer.on('startup:log', handler);
    return () => ipcRenderer.removeListener('startup:log', handler);
  },
});
