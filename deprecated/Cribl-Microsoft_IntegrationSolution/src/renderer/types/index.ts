export interface DepStatus {
  name: string;
  description: string;
  required: boolean;
  installed: boolean;
  version: string;
  installHint: string;
}

export interface PsOutputEvent {
  id: string;
  stream: 'stdout' | 'stderr';
  data: string;
}

export interface PsExitEvent {
  id: string;
  code: number | null;
}

export interface ConfigFile {
  filePath: string;
  data: Record<string, unknown>;
}

export interface SentinelSolution {
  name: string;
  path: string;
  type: string;
  description?: string;
  dataConnectors?: string[];
}

export interface CrblFile {
  path: string;
  name: string;
  size: number;
  createdAt: number;
}

export interface PackInfo {
  name: string;
  version: string;
  path: string;
  displayName?: string;
  author?: string;
  description?: string;
  packaged?: boolean;
  crblPath?: string;
  crblSize?: number;
  createdAt?: number;
  crblFiles?: CrblFile[];
  tables?: string[];
}

export interface FieldMapping {
  source: string;
  target: string;
  type: string;
  action: 'rename' | 'keep' | 'coerce' | 'drop';
}

export interface VendorSample {
  tableName: string;
  format: string;
  rawEvents: string[];
  source: string;
}

export interface PackScaffoldOptions {
  solutionName: string;
  packName: string;
  version: string;
  autoPackage: boolean;
  vendorSamples: VendorSample[];
  tables: Array<{
    sentinelTable: string;
    criblStream: string;
    fields: FieldMapping[];
    logType?: string;
  }>;
  fieldMappingOverrides?: Record<string, Array<{
    source: string; dest: string; sourceType: string; destType: string;
    confidence: string; action: string; needsCoercion: boolean;
    description: string; sampleValue?: string;
  }>>;
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

export interface ToolConfig {
  label: string;
  scriptPath: string;
  configPaths: string[];
  modes: string[];
}

declare global {
  interface Window {
    api: {
      deps: {
        check: () => Promise<DepStatus[]>;
        install: (command: string) => Promise<{ success: boolean; output: string }>;
      };
      powershell: {
        execute: (script: string, args: string[]) => Promise<{ id: string; pid: number }>;
        cancel: (id: string) => Promise<void>;
        onOutput: (callback: (event: PsOutputEvent) => void) => () => void;
        onExit: (callback: (event: PsExitEvent) => void) => () => void;
      };
      config: {
        read: (filePath: string) => Promise<Record<string, unknown>>;
        write: (filePath: string, data: Record<string, unknown>) => Promise<void>;
        getRepoRoot: () => Promise<string>;
      };
      github: {
        fetchSentinelSolutions: () => Promise<Array<{ name: string; path: string; type: string }>>;
        fetchSolutionDetails: (solutionPath: string) => Promise<unknown>;
        fetchSolutionSchemas: (solutionPath: string) => Promise<DataConnectorSchema[]>;
        fetchVendorSamples: (solutionPath: string) => Promise<VendorSample[]>;
        rateLimit: () => Promise<{ remaining: number; limit: number; resetAt: number; hasToken: boolean }>;
      };
      sentinelRepo: {
        status: () => Promise<{ state: string; localPath: string; lastUpdated: number; lastCommit: string; solutionCount: number; error: string; blockedCount: number; fetchedCount: number }>;
        sync: () => Promise<{ started: boolean; reason?: string }>;
        reclone: () => Promise<{ started: boolean }>;
        solutions: () => Promise<Array<{ name: string; path: string }>>;
        connectors: (solutionName: string) => Promise<Array<{ name: string; path: string; size: number }>>;
        readFile: (relativePath: string) => Promise<string | null>;
        blocklist: () => Promise<Array<{ name: string; reason: string; source: string }>>;
        blocklistRetry: (solutionName: string) => Promise<{ removed: boolean; blocklist: Array<{ name: string; reason: string; source: string }> }>;
        blocklistAdd: (solutionName: string, reason: string) => Promise<{ added: boolean; blocklist: Array<{ name: string; reason: string; source: string }> }>;
        onStatus: (callback: (status: { state: string; solutionCount: number; error: string; blockedCount: number; fetchedCount: number }) => void) => () => void;
        onProgress: (callback: (data: string) => void) => () => void;
      };
      packBuilder: {
        scaffold: (options: PackScaffoldOptions) => Promise<{ packDir: string; crblPath: string }>;
        package: (packDir: string) => Promise<{ packDir: string; crblPath: string }>;
        list: () => Promise<PackInfo[]>;
        delete: (packName: string) => Promise<void>;
        deleteCrbl: (crblName: string) => Promise<void>;
        clean: () => Promise<{ removed: string[]; freedBytes: number }>;
        storageInfo: () => Promise<{
          packsDir: string; totalSize: number; packCount: number;
          crblCount: number; orphanedCrblCount: number; oldVersionCount: number;
        }>;
        parseRuleYaml: (yamlContents: Array<{ fileName: string; content: string }>) => Promise<{
          success: boolean; rules: Array<{ name: string; severity: string; requiredFields: string[]; fileName: string }>; error?: string;
        }>;
        ruleCoverage: (solutionName: string, sourceFields: string[], destFields?: string[], customRules?: Array<{ name: string; severity: string; requiredFields: string[]; fileName: string }>, destTable?: string, destTables?: string[]) => Promise<{
          rules: Array<{ name: string; severity: string; tactics: string[]; totalFields: number; coveredFields: string[]; missingFields: string[]; coverage: number; custom?: boolean; query?: string }>;
          summary: { totalRules: number; fullyCovered: number; partiallyCovered: number; missingFieldsAcrossRules: string[]; ruleReferencedFields: string[] };
        }>;
        getDcrSchema: (tableName: string) => Promise<SchemaColumn[]>;
        getAvailableTables: () => Promise<string[]>;
        getSourceTypes: () => Promise<unknown[]>;
        suggestSource: (solutionName: string, tableName: string) => Promise<{ sourceType: string; preset?: string } | null>;
        analyzeSamples: (solutionName: string, samples: Array<{ logType: string; tableName: string; rawEvents: string[] }>) => Promise<{ success: boolean; analyses: unknown[]; error?: string }>;
        exportArtifacts: (options: { packDir: string; crblPath?: string; exportDir?: string; tables: string[]; solutionName: string; packName: string }) => Promise<{ exportPath: string; artifacts: string[] }>;
      };
      paramForms: {
        list: () => Promise<Array<{
          id: string; name: string; description: string; configPath: string; exists: boolean;
          fields: Array<{
            key: string; label: string; type: string; description: string;
            group: string; required: boolean; placeholder?: string;
            default?: string | number | boolean; sensitive?: boolean;
            options?: Array<{ value: string; label: string }>;
          }>;
        }>>;
        get: (formId: string) => Promise<{ form: unknown; values: Record<string, unknown> }>;
        save: (formId: string, values: Record<string, unknown>) => Promise<{ success: boolean; path: string }>;
      };
      azureDeploy: {
        parameters: () => Promise<{
          subscriptionId: string; resourceGroupName: string; workspaceName: string;
          location: string; tenantId: string; clientId: string;
          dcrPrefix: string; dcrSuffix: string; dcePrefix: string; dceSuffix: string;
          ownerTag: string;
        } | null>;
        checkExisting: (tables: string[]) => Promise<Record<string, unknown>>;
        previewResources: (options: { tables: string[]; subscription: string; resourceGroup: string; workspace: string; location: string }) => Promise<{
          resources: Array<{ type: string; name: string; table: string; exists: boolean; armTemplate?: any }>;
        }>;
        deployDcrs: (options: { tables: string[]; mode: string; templateOnly: boolean }) => Promise<{
          success: boolean;
          destinations: Array<{ id: string; type: string; dceEndpoint: string; dcrID: string; streamName: string; client_id: string; loginUrl: string; url: string; tableName: string }>;
          error?: string;
        }>;
        destinations: () => Promise<Array<{ id: string; type: string; dceEndpoint: string; dcrID: string; streamName: string; client_id: string; loginUrl: string; url: string; tableName: string }>>;
        refreshDestinations: (tables: string[]) => Promise<{ success: boolean; saved: string[]; total: number; error?: string }>;
        embedDestinations: (packDir: string, tables: string[]) => Promise<{ success: boolean; destinations: unknown[]; error?: string; message?: string }>;
        assignDcrRole: (objectId: string, dcrResourceIds: string[]) => Promise<{ results: Array<{ dcr: string; success: boolean; error?: string }>; assigned: number; total: number }>;
        getDcrIds: (tables: string[]) => Promise<Array<{ table: string; resourceId: string }>>;
      };
      vendorResearch: {
        list: () => Promise<Array<{ vendor: string; displayName: string; description: string; sourceType: string }>>;
        research: (vendorName: string) => Promise<unknown>;
        clearCache: (vendorName: string) => Promise<void>;
      };
      registrySync: {
        status: () => Promise<{ state: string; total: number; completed: number; lastSyncTime: number; entriesFound: number }>;
        sync: (forceRefresh?: boolean) => Promise<{ started: boolean; reason?: string }>;
        search: (query: string) => Promise<unknown[]>;
        lookup: (vendorName: string) => Promise<unknown>;
        stats: () => Promise<{ lastFullSync: number; totalSolutions: number; totalLogTypes: number; totalFields: number }>;
        onProgress: (callback: (event: { state: string; total: number; completed: number; currentSolution: string; entriesFound: number }) => void) => () => void;
      };
      changeDetection: {
        status: () => Promise<{
          status: string;
          lastCheckTime: number;
          alerts: Array<{
            packName: string; solutionName: string; buildTime: number; checkTime: number;
            hasChanges: boolean; totalChanges: number;
            criticalCount: number; warningCount: number; infoCount: number;
            changes: Array<{ category: string; severity: string; description: string; fileName?: string; logTypeName?: string; oldValue?: string | number; newValue?: string | number }>;
          }>;
          summary: { totalPacks: number; packsWithChanges: number; criticalCount: number; warningCount: number };
        }>;
        check: () => Promise<{ started: boolean; reason?: string }>;
        packAlerts: (packName: string) => Promise<unknown>;
        packDiff: (packName: string) => Promise<{
          packName: string; solutionName: string; buildTime: number; daysSinceBuild: number;
          buildCommit: string; currentCommit: string;
          changes: Array<{ category: string; severity: string; description: string; fileName?: string; logTypeName?: string; oldValue?: string | number; newValue?: string | number }>;
          gitLog: Array<{ hash: string; date: string; subject: string; author: string }>;
          fileDiffs: Array<{ file: string; status: string; additions: number; deletions: number }>;
          recommendation: string;
        } | null>;
        gitLog: (solutionPath: string, sinceCommit?: string, maxEntries?: number) => Promise<Array<{ hash: string; date: string; subject: string; author: string }>>;
        fileDiffs: (solutionPath: string, sinceCommit: string) => Promise<Array<{ file: string; status: string; additions: number; deletions: number }>>;
        snapshots: () => Promise<Record<string, unknown>>;
        dismiss: (packName: string) => Promise<void>;
        onStatus: (callback: (event: { status: string; alertCount: number; criticalCount: number; warningCount: number; lastCheckTime: number }) => void) => () => void;
      };
      auth: {
        status: () => Promise<{
          cribl: { connected: boolean; baseUrl: string; deploymentType?: string; error?: string };
          azure: { loggedIn: boolean; accountId: string; subscriptionId: string; subscriptionName: string; tenantId: string; error?: string };
        }>;
        criblConnect: (config: { clientId: string; clientSecret: string; baseUrl: string; deploymentType: 'cloud' | 'self-managed'; organizationId?: string; saveCredentials?: boolean }) => Promise<{ success: boolean; error?: string }>;
        criblDisconnect: () => Promise<void>;
        criblReconnect: (overrides?: { deploymentType?: 'cloud' | 'self-managed'; baseUrl?: string; organizationId?: string; clientId?: string }) => Promise<{ success: boolean; error?: string }>;
        criblSaved: () => Promise<{
          clientId: string; deploymentType: string; baseUrl: string; organizationId: string; hasSecret: boolean;
          cloud: { clientId: string; organizationId: string; hasSecret: boolean } | null;
          selfManaged: { clientId: string; baseUrl: string; hasSecret: boolean } | null;
        } | null>;
        azureStatus: () => Promise<{ loggedIn: boolean; accountId: string; subscriptionId: string; subscriptionName: string; tenantId: string }>;
        azureLogin: () => Promise<{ loggedIn: boolean; accountId: string; subscriptionId: string; subscriptionName: string; tenantId: string }>;
        azureSetSubscription: (subscriptionId: string) => Promise<{ success: boolean }>;
        azureSubscriptions: () => Promise<{ success: boolean; subscriptions: Array<{ id: string; name: string; state: string }>; error?: string }>;
        azureWorkspaces: (subscriptionId?: string) => Promise<{ success: boolean; workspaces: Array<{ name: string; resourceGroup: string; location: string; customerId: string; sku: string }>; error?: string }>;
        azureCreateResourceGroup: (name: string, location: string, subscriptionId?: string) => Promise<{ success: boolean; error?: string }>;
        azureCreateWorkspace: (name: string, resourceGroup: string, location: string, subscriptionId?: string) => Promise<{ success: boolean; customerId?: string; error?: string }>;
        azureEnableSentinel: (workspaceName: string, resourceGroup: string, subscriptionId?: string) => Promise<{ success: boolean; alreadyEnabled?: boolean; error?: string }>;
        azureResourceGroups: (subscriptionId?: string) => Promise<{ success: boolean; resourceGroups: Array<{ name: string; location: string }>; error?: string }>;
        azureSelectWorkspace: (workspace: { workspaceName: string; resourceGroupName: string; location: string; subscriptionId: string }) => Promise<{ success: boolean }>;
        criblCreateDestination: (destination: Record<string, unknown>, workerGroup?: string) => Promise<{ success: boolean; error?: string }>;
        criblUploadPack: (crblPath: string, workerGroup?: string) => Promise<{ success: boolean; error?: string }>;
        criblListDestinations: (workerGroup?: string) => Promise<{ success: boolean; destinations: string[]; error?: string }>;
        criblWorkspaces: () => Promise<{ success: boolean; workspaces: Array<{ id: string; name: string; description: string }>; error?: string }>;
        criblWorkerGroups: (workspaceId?: string) => Promise<{ success: boolean; groups: Array<{ id: string; name: string; workerCount: number; description: string }>; error?: string }>;
        criblListPacks: (workerGroup?: string) => Promise<{ success: boolean; packs: Array<{ id: string; name: string; version: string }>; error?: string }>;
        criblDeployMulti: (crblPath: string, workerGroups: string[]) => Promise<{ results: Array<{ group: string; success: boolean; error?: string }>; error?: string }>;
        criblSources: (workerGroup?: string) => Promise<{ success: boolean; sources: Array<{ id: string; type: string; disabled: boolean; description: string }>; error?: string }>;
        criblRoutes: (workerGroup?: string) => Promise<{ success: boolean; routes: Array<{ id: string; name: string; description: string }>; error?: string }>;
        criblCapture: (workerGroup: string, sourceId: string, count?: number, durationMs?: number) => Promise<{ success: boolean; events: Array<Record<string, unknown>>; error?: string }>;
        criblPreview: (workerGroup: string, pipelineConf: Record<string, unknown>, sampleEvents: Array<Record<string, unknown>>) => Promise<{ success: boolean; events: Array<Record<string, unknown>>; error?: string }>;
        criblSearch: (query: string, earliest?: string, latest?: string, maxResults?: number) => Promise<{ success: boolean; events: Array<Record<string, unknown>>; error?: string }>;
        criblDatasets: () => Promise<{ success: boolean; datasets: Array<{ id: string; name: string }>; error?: string }>;
        criblCreateDataset: (datasetId: string, description?: string) => Promise<{ success: boolean; error?: string }>;
        azureQuery: (query: string, timespan?: string) => Promise<{ success: boolean; rows: Array<Record<string, unknown>>; error?: string }>;
        criblTestUrl: (urlPath: string) => Promise<{ status: number; body: string; url?: string }>;
        criblCreateBreaker: (workerGroup: string, breakerId: string, breakerConfig: Record<string, unknown>) => Promise<{ success: boolean; action?: string; error?: string }>;
        criblCreateSecret: (workerGroup: string, secretId: string, secretValue: string, description?: string) => Promise<{ success: boolean; action?: string; error?: string }>;
        criblCreateRoute: (workerGroup: string, routeId: string, name: string, filter: string, packId: string, output?: string, description?: string, final?: boolean) => Promise<{ success: boolean; error?: string }>;
        criblCommit: (message: string) => Promise<{ success: boolean; error?: string }>;
        criblDeployConfig: (workerGroup: string) => Promise<{ success: boolean; error?: string }>;
      };
      sampleParser: {
        parseContent: (content: string, sourceName?: string) => Promise<{
          format: string; eventCount: number;
          fields: Array<{ name: string; type: string; sampleValues: string[]; occurrence: number; required: boolean }>;
          rawEvents: string[]; sourceName: string; timestampField: string; errors: string[];
        }>;
        parseFiles: () => Promise<Array<{
          format: string; eventCount: number;
          fields: Array<{ name: string; type: string; sampleValues: string[]; occurrence: number; required: boolean }>;
          rawEvents: string[]; sourceName: string; timestampField: string; errors: string[];
        }>>;
        parseFeedConfig: (configText: string) => Promise<{
          vendor: string; feedType: string; format: string;
          fields: string[]; transportProtocol: string; port: number; rawConfig: string;
        }>;
        parseCsvWithHeaders: (csvContent: string, headers: string[], skipFirstRow: boolean) => Promise<{
          format: string; eventCount: number;
          fields: Array<{ name: string; type: string; sampleValues: string[]; occurrence: number; required: boolean }>;
          rawEvents: string[]; sourceName: string; timestampField: string; errors: string[];
        }>;
        tagSample: (vendor: string, logType: string, content: string, sourceName?: string) => Promise<{
          vendor: string; logType: string; format: string; eventCount: number; fieldCount: number; timestampField: string; errors: string[];
        }>;
        getTagged: (vendor: string) => Promise<Array<{
          vendor: string; logType: string; format: string; eventCount: number; fieldCount: number;
          fields: Array<{ name: string; type: string; sampleValues: string[]; occurrence: number; required: boolean }>;
          rawEvents: string[]; timestampField: string;
        }>>;
        listTaggedVendors: () => Promise<Array<{ vendor: string; logTypes: string[]; totalEvents: number }>>;
        autoDetectTypes: (content: string) => Promise<{
          logTypes: Array<{ name: string; eventCount: number; discriminator: string; value: string }>;
          discriminatorField: string;
        }>;
      };
      e2e: {
        status: () => Promise<{ status: string; sources: unknown[]; currentSource: string; error: string }>;
        start: (options: {
          sources: Array<{ id: string; vendor: string; displayName: string; tables: string[]; sourceType: string; selected: boolean }>;
          criblAuth: { clientId: string; clientSecret: string; baseUrl: string; deploymentType: string } | null;
          workerGroup: string;
        }) => Promise<{ started: boolean; reason?: string }>;
        availableSources: () => Promise<Array<{ id: string; vendor: string; displayName: string; tables: string[]; sourceType: string; selected: boolean }>>;
        reset: () => Promise<void>;
        onProgress: (callback: (state: unknown) => void) => () => void;
      };
      permissions: {
        check: (workerGroup?: string) => Promise<{
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
          canDeploy: boolean; summary: string;
        }>;
      };
      defaultSamples: {
        availableVendors: () => Promise<Array<{ vendor: string; displayName: string; logTypeCount: number; fieldCount: number; source: string }>>;
        generate: (vendorName: string, eventsPerLogType?: number) => Promise<{
          vendor: string; displayName: string;
          logTypes: Array<{
            logTypeId: string; logTypeName: string; vendor: string; eventCount: number;
            fields: Array<{ name: string; type: string }>;
            events: Array<Record<string, unknown>>; rawEvents: string[]; timestampField: string;
          }>;
          totalEvents: number; totalFields: number;
        } | null>;
        sentinelRepoSamples: (solutionName: string) => Promise<{
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
        }>;
      };
      fieldMatcher: {
        match: (
          sourceFields: Array<{ name: string; type: string; sampleValue?: string }>,
          destFields: Array<{ name: string; type: string }>,
          vendorMappings?: Array<{ sourceName: string; destName: string; sourceType: string; destType: string; action: string }>,
        ) => Promise<{
          matched: Array<{
            sourceName: string; sourceType: string; destName: string; destType: string;
            confidence: string; action: string; needsCoercion: boolean; description: string; sampleValue?: string;
          }>;
          unmatchedSource: Array<{ name: string; type: string }>;
          unmatchedDest: Array<{ name: string; type: string }>;
          totalSource: number; totalDest: number; matchRate: number;
        }>;
        matchToSchema: (
          sampleFields: Array<{ name: string; type: string; sampleValues?: string[] }>,
          tableName: string,
          vendorMappings?: Array<{ sourceName: string; destName: string; sourceType: string; destType: string; action: string }>,
        ) => Promise<{
          matched: Array<{
            sourceName: string; sourceType: string; destName: string; destType: string;
            confidence: string; action: string; needsCoercion: boolean; description: string;
          }>;
          unmatchedSource: Array<{ name: string; type: string }>;
          unmatchedDest: Array<{ name: string; type: string }>;
          totalSource: number; totalDest: number; matchRate: number;
        }>;
      };
      siemMigration: {
        parse: (content: string, platform: 'splunk' | 'qradar', fileName?: string) => Promise<{
          success: boolean;
          plan: {
            platform: string; fileName: string; totalRules: number; enabledRules: number; buildingBlocks: number;
            dataSources: Array<{
              id: string; name: string; platform: string; platformIdentifiers: string[];
              ruleCount: number; rules: string[]; mitreTactics: string[]; mitreTechniques: string[];
              sentinelSolution: string; sentinelTable: string; confidence: string;
              sentinelAnalyticRules: Array<{ name: string; severity: string; tactics: string[]; query: string }>;
            }>;
            unmappedRules: Array<{ name: string; dataSources: string[]; rawSearch: string }>;
            mitreCoverage: Array<{ tactic: string; techniqueCount: number; ruleCount: number }>;
            totalSentinelRules: number;
          } | null;
          error?: string;
        }>;
        buildPack: (solutionName: string, packName?: string, userSamples?: Array<{ logType: string; content: string; fileName: string }>) => Promise<{
          success: boolean; solutionName?: string; packName?: string; tables?: string[]; error?: string;
          sampleInfo?: { tier: string; eventCount: number; sources: string[] };
        }>;
        exportReport: (plan: unknown) => Promise<{
          success: boolean; filePath: string; report: string; error?: string;
        }>;
      };
    };
  }
}
