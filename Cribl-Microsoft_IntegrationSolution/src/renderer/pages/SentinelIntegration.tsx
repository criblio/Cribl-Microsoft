// Cribl Sentinel Integration - Unified page for the complete integration workflow
// All sections on one page: Solution, Samples, Azure Resources, Config, Deploy

import { useState, useEffect, useCallback } from 'react';
import DataFlowView from '../components/DataFlowView';
import InfoTip from '../components/InfoTip';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Solution { name: string; path: string; deprecated?: boolean; deprecationReason?: string }
interface Workspace { name: string; resourceGroup: string; location: string; customerId: string }
interface Subscription { id: string; name: string }
interface WorkerGroup { id: string; name: string; workerCount: number }
interface TaggedSample {
  vendor: string; logType: string; format: string; eventCount: number; fieldCount: number;
  rawEvents?: string[];
  fields?: Array<{ name: string; type: string; sampleValues: string[]; occurrence: number; required: boolean }>;
  timestampField?: string;
}

interface FieldMappingEntry {
  source: string; dest: string; sourceType: string; destType: string;
  confidence: string; action: string; needsCoercion: boolean;
  description: string; sampleValue?: string;
}

interface SampleAnalysis {
  tableName: string;
  logType: string;
  sourceFieldCount: number;
  destFieldCount: number;
  passthroughCount: number;
  dcrHandledCount: number;
  criblHandledCount: number;
  overflowCount: number;
  dcrRenames: Array<{ source: string; dest: string }>;
  dcrCoercions: Array<{ field: string; toType: string }>;
  criblRenames: Array<{ source: string; dest: string; reason: string }>;
  criblCoercions: Array<{ field: string; fromType: string; toType: string }>;
  routeCondition: string;
  fieldMappings?: FieldMappingEntry[];
  destSchema?: Array<{ name: string; type: string }>;
}

interface IntegrationState {
  // Step 1: Solution
  selectedSolution: string;
  // Step 2: Samples
  samples: TaggedSample[];
  // Step 3: Azure
  subscription: string;
  resourceGroup: string;
  workspace: string;
  location: string;
  enableDcrMetrics: boolean;
  enableDce: boolean;
  assignDcrPermissions: boolean;
  enterpriseAppObjectId: string;
  // Step 4: Cribl
  workerGroups: string[];
  packName: string;
  // Step 5: Deploy status
  deploying: boolean;
  deployLog: string[];
  deployComplete: boolean;
  // Step 6: Source Wiring
  selectedSource: string;
  enableLakeFederation: boolean;
  selectedDataset: string;
  wiring: boolean;
  wiringLog: string[];
  wiringComplete: boolean;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const s = {
  page: { maxWidth: '1100px', paddingBottom: '40px' } as React.CSSProperties,
  header: { marginBottom: '24px' } as React.CSSProperties,
  title: { fontSize: '22px', fontWeight: 700 } as React.CSSProperties,
  subtitle: { fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px' } as React.CSSProperties,

  section: {
    background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
    borderRadius: 'var(--radius)', padding: '20px', marginBottom: '16px',
  } as React.CSSProperties,
  sectionTitle: {
    fontSize: '14px', fontWeight: 700, marginBottom: '4px',
    display: 'flex', alignItems: 'center', gap: '8px',
  } as React.CSSProperties,
  sectionDesc: { fontSize: '12px', color: 'var(--text-muted)', marginBottom: '16px' } as React.CSSProperties,
  sectionNum: {
    width: '24px', height: '24px', borderRadius: '50%', display: 'inline-flex',
    alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 700,
    background: 'var(--accent-blue)', color: '#fff', flexShrink: 0,
  } as React.CSSProperties,
  sectionNumDone: {
    width: '24px', height: '24px', borderRadius: '50%', display: 'inline-flex',
    alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 700,
    background: 'var(--accent-green)', color: '#fff', flexShrink: 0,
  } as React.CSSProperties,

  row: { display: 'flex', gap: '12px', alignItems: 'flex-start', marginBottom: '12px' } as React.CSSProperties,
  field: { flex: 1, minWidth: 0 } as React.CSSProperties,
  label: { fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' } as React.CSSProperties,
  select: {
    width: '100%', padding: '8px 10px', fontSize: '12px', background: 'var(--bg-input)',
    border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)',
  } as React.CSSProperties,
  input: {
    width: '100%', padding: '8px 10px', fontSize: '12px', fontFamily: 'var(--font-mono)',
    background: 'var(--bg-input)', border: '1px solid var(--border-color)',
    borderRadius: '4px', color: 'var(--text-primary)', boxSizing: 'border-box' as const,
  } as React.CSSProperties,
  textarea: {
    width: '100%', minHeight: '100px', padding: '8px 10px', fontSize: '11px',
    fontFamily: 'var(--font-mono)', background: 'var(--bg-input)',
    border: '1px solid var(--border-color)', borderRadius: '4px',
    color: 'var(--text-primary)', resize: 'vertical' as const, boxSizing: 'border-box' as const,
  } as React.CSSProperties,
  toggle: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: 'pointer' } as React.CSSProperties,

  sampleTag: {
    display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 10px',
    background: 'var(--bg-input)', border: '1px solid var(--border-color)',
    borderRadius: '12px', fontSize: '11px', marginRight: '6px', marginBottom: '6px',
  } as React.CSSProperties,
  sampleCount: { fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', fontSize: '10px' } as React.CSSProperties,

  deployBtn: {
    padding: '12px 32px', fontSize: '14px', fontWeight: 700,
  } as React.CSSProperties,
  deployLog: {
    background: 'var(--bg-input)', borderRadius: '4px', padding: '12px',
    fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-secondary)',
    maxHeight: '300px', overflow: 'auto', whiteSpace: 'pre-wrap' as const,
    marginTop: '12px',
  } as React.CSSProperties,
  deployItem: (ok: boolean) => ({
    padding: '2px 0', color: ok ? 'var(--accent-green)' : 'var(--text-secondary)',
  } as React.CSSProperties),
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function SentinelIntegration() {
  const [solutions, setSolutions] = useState<Solution[]>([]);
  const [solutionSearch, setSolutionSearch] = useState('');
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [resourceGroups, setResourceGroups] = useState<Array<{ name: string; location: string }>>([]);
  const [newRgName, setNewRgName] = useState('');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workerGroups, setWorkerGroups] = useState<WorkerGroup[]>([]);
  const [criblConnected, setCriblConnected] = useState(false);
  const [criblDeploymentType, setCriblDeploymentType] = useState<string>('cloud');
  const [azureConnected, setAzureConnected] = useState(false);
  const [integrationMode, setIntegrationMode] = useState<string>('full');

  const hasAzure = integrationMode === 'full' || integrationMode === 'azure-only';
  const hasCribl = integrationMode === 'full' || integrationMode === 'cribl-only';
  const [pasteContent, setPasteContent] = useState('');
  const [pasteLogType, setPasteLogType] = useState('');
  const [analyses, setAnalyses] = useState<SampleAnalysis[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  // User overrides to field mappings (keyed by tableName)
  const [mappingEdits, setMappingEdits] = useState<Record<string, FieldMappingEntry[]>>({});
  // Track which tables have had their mappings approved (keyed by tableName)
  const [approvedMappings, setApprovedMappings] = useState<Set<string>>(new Set());
  // Analytics rule field coverage analysis
  const [ruleCoverage, setRuleCoverage] = useState<{
    rules: Array<{ name: string; severity: string; tactics: string[]; totalFields: number; coveredFields: string[]; missingFields: string[]; coverage: number; custom?: boolean; query?: string }>;
    summary: { totalRules: number; fullyCovered: number; partiallyCovered: number; missingFieldsAcrossRules: string[]; ruleReferencedFields: string[] };
  } | null>(null);
  // Custom analytics rules uploaded by user
  const [customRules, setCustomRules] = useState<Array<{ name: string; severity: string; requiredFields: string[]; fileName: string }>>([]);
  const [repoState, setRepoState] = useState<'loading' | 'cloning' | 'updating' | 'ready' | 'error' | 'not_cloned'>('loading');
  const [repoProgress, setRepoProgress] = useState('');
  const [repoSolutionCount, setRepoSolutionCount] = useState(0);
  const [elasticRepoState, setElasticRepoState] = useState<{ state: string; packageCount: number }>({ state: 'unknown', packageCount: 0 });

  const [state, setState] = useState<IntegrationState>({
    selectedSolution: '', samples: [],
    subscription: '', resourceGroup: '', workspace: '', location: '', enableDcrMetrics: false, enableDce: false, assignDcrPermissions: false, enterpriseAppObjectId: '',
    workerGroups: [], packName: '',
    deploying: false, deployLog: [], deployComplete: false,
    selectedSource: '', enableLakeFederation: false, selectedDataset: '',
    wiring: false, wiringLog: [], wiringComplete: false,
  });
  const [wiringSources, setWiringSources] = useState<Array<{ id: string; type: string; disabled: boolean }>>([]);
  const [resourcePreview, setResourcePreview] = useState<{
    resources: Array<{ type: string; name: string; table: string; exists: boolean; armTemplate?: any }>;
  } | null>(null);
  const [expandedResource, setExpandedResource] = useState<string | null>(null);
  const [lakeDatasets, setLakeDatasets] = useState<Array<{ id: string; name: string }>>([]);
  const [newDatasetName, setNewDatasetName] = useState('');
  const [azurePermissions, setAzurePermissions] = useState<{
    checked: boolean; checking: boolean;
    canCreateDcr: boolean; canCreateDce: boolean; canCreateTable: boolean;
    canWriteResourceGroup: boolean; canReadWorkspace: boolean;
    canDeploy: boolean; roles: string[]; error: string;
  }>({ checked: false, checking: false, canCreateDcr: false, canCreateDce: false, canCreateTable: false,
    canWriteResourceGroup: false, canReadWorkspace: false, canDeploy: false, roles: [], error: '' });

  const update = (partial: Partial<IntegrationState>) => setState((prev) => ({ ...prev, ...partial }));

  // Load initial data -- respects integration mode
  useEffect(() => {
    if (!window.api) return;
    const init = async () => {
      try {
        // Check integration mode before making any auth calls
        let mode = 'full';
        try {
          const mc = await window.api.config.read('integration-mode.json') as any;
          mode = mc?.mode || 'full';
        } catch { /* no config yet */ }
        setIntegrationMode(mode);

        const skipAzure = mode === 'air-gapped' || mode === 'cribl-only';
        const skipCribl = mode === 'air-gapped' || mode === 'azure-only';

        if (mode === 'air-gapped') {
          setCriblConnected(false);
          setAzureConnected(false);
        } else {
          const auth = await window.api.auth.status();
          setCriblConnected(!skipCribl && auth.cribl.connected);
          if (auth.cribl.deploymentType) setCriblDeploymentType(auth.cribl.deploymentType);
          setAzureConnected(!skipAzure && auth.azure.loggedIn);

          if (!skipAzure && auth.azure.loggedIn) {
            const subs = await window.api.auth.azureSubscriptions();
            if (subs.success) setSubscriptions(subs.subscriptions);
            if (auth.azure.subscriptionId) {
              update({ subscription: auth.azure.subscriptionId });
            }
          }

          if (!skipCribl && auth.cribl.connected) {
            const groups = await window.api.auth.criblWorkerGroups();
            if (groups.success) {
              setWorkerGroups(groups.groups);
              if (groups.groups.length > 0) update({ workerGroups: [groups.groups[0].id] });
            }
          }
        }

        // Check repo status first, then load solutions
        try {
          const repoStatus = await window.api.sentinelRepo.status();
          setRepoState(repoStatus.state as typeof repoState);
          setRepoSolutionCount(repoStatus.solutionCount || 0);

          if (repoStatus.state === 'ready') {
            const sols = await window.api.github.fetchSentinelSolutions();
            setSolutions(sols);
          } else if (repoStatus.state === 'not_cloned' || repoStatus.state === 'error') {
            // Auto-trigger sync if repo not cloned
            setRepoState('cloning');
            setRepoProgress('Starting Sentinel repo clone...');
            await window.api.sentinelRepo.sync();
          }
          // If cloning/updating, the status listener will handle it
        } catch {
          // Fallback: try loading solutions directly (GitHub API)
          setRepoState('loading');
          try {
            const sols = await window.api.github.fetchSentinelSolutions();
            setSolutions(sols);
            setRepoState('ready');
          } catch { setRepoState('error'); }
        }
      } catch { /* skip */ }
    };
    init();
  }, []);

  // Listen for repo status and progress updates
  useEffect(() => {
    if (!window.api?.sentinelRepo?.onStatus) return;
    const unsubStatus = window.api.sentinelRepo.onStatus((status: any) => {
      setRepoState(status.state);
      setRepoSolutionCount(status.solutionCount || 0);
      if (status.state === 'ready') {
        // Repo just became ready -- load solutions
        window.api.github.fetchSentinelSolutions()
          .then((sols: Solution[]) => setSolutions(sols))
          .catch(() => {});
        setRepoProgress('');
      } else if (status.error) {
        setRepoProgress(status.error);
      }
    });
    const unsubProgress = window.api.sentinelRepo.onProgress?.((msg: string) => {
      setRepoProgress(msg);
    });
    // Elastic repo status
    (window.api as any).elasticRepo?.status().then((s: any) => setElasticRepoState(s)).catch(() => {});
    const unsubElastic = (window.api as any).elasticRepo?.onStatus?.((s: any) => setElasticRepoState(s));
    return () => { unsubStatus?.(); unsubProgress?.(); unsubElastic?.(); };
  }, []);

  // Load workspaces and resource groups when subscription changes
  useEffect(() => {
    if (!window.api || !state.subscription) return;
    const load = async () => {
      const [wsResult, rgResult] = await Promise.all([
        window.api.auth.azureWorkspaces(state.subscription),
        window.api.auth.azureResourceGroups(state.subscription),
      ]);
      if (wsResult.success) setWorkspaces(wsResult.workspaces);
      if (rgResult.success) setResourceGroups(rgResult.resourceGroups);
    };
    load();
  }, [state.subscription]);

  // Check Azure permissions when workspace is selected
  useEffect(() => {
    if (!window.api || !state.workspace || !azureConnected) {
      setAzurePermissions((p) => ({ ...p, checked: false }));
      return;
    }
    const check = async () => {
      setAzurePermissions((p) => ({ ...p, checking: true, checked: false, error: '' }));
      try {
        const report = await window.api.permissions.check(state.workerGroups[0]);
        const az = report.azure;
        const roles = az.permissions
          .filter((p: any) => p.resource === 'RBAC Role' && p.granted)
          .map((p: any) => p.detail);
        // Evaluate Azure deploy readiness independently (not gated on Cribl status)
        const azureCanDeploy = az.loggedIn && az.canCreateDcr && az.canReadWorkspace && az.canWriteResourceGroup;
        setAzurePermissions({
          checked: true, checking: false,
          canCreateDcr: az.canCreateDcr, canCreateDce: az.canCreateDce,
          canCreateTable: az.canCreateTable, canWriteResourceGroup: az.canWriteResourceGroup,
          canReadWorkspace: az.canReadWorkspace, canDeploy: azureCanDeploy,
          roles, error: az.error,
        });
      } catch (err) {
        setAzurePermissions((p) => ({
          ...p, checking: false, checked: true,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    };
    check();
  }, [state.workspace, azureConnected]);

  // Load Azure resource preview when workspace + samples are ready (only in Azure-connected modes)
  useEffect(() => {
    if (!hasAzure || !window.api || !state.workspace || !state.subscription || state.samples.length === 0 || !state.selectedSolution) {
      setResourcePreview(null);
      return;
    }
    const loadPreview = async () => {
      try {
        // Determine destination tables from vendor research or samples
        let destTables: string[] = [];
        try {
          const research = await window.api.vendorResearch.research(state.selectedSolution) as any;
          if (research?.logTypes?.length > 0) {
            destTables = [...new Set(research.logTypes.filter((t: any) => t.destTable).map((t: any) => t.destTable))] as string[];
          }
        } catch { /* skip */ }
        if (destTables.length === 0) destTables = ['CommonSecurityLog'];

        const preview = await window.api.azureDeploy.previewResources({
          tables: destTables,
          subscription: state.subscription,
          resourceGroup: state.resourceGroup,
          workspace: state.workspace,
          location: state.location,
        });
        setResourcePreview(preview);
      } catch { /* non-fatal */ }
    };
    loadPreview();
  }, [hasAzure, state.workspace, state.subscription, state.samples.length, state.selectedSolution]);

  // Auto-generate pack name from solution
  // Accept pre-populated solution from SIEM Migration page via URL hash params
  useEffect(() => {
    const hash = window.location.hash;
    const match = hash.match(/[?&]solution=([^&]+)/);
    if (match) {
      const solution = decodeURIComponent(match[1]);
      update({ selectedSolution: solution });
      // Clean the hash to avoid re-triggering
      window.location.hash = window.location.hash.replace(/[?&]solution=[^&]+/, '');
    }
  }, []);

  useEffect(() => {
    if (state.selectedSolution) {
      const name = state.selectedSolution.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-') + '-sentinel';
      update({ packName: name });
    }
  }, [state.selectedSolution]);

  // Auto-analyze samples when they change -- runs gap analysis against DCR.
  // The destination table(s) come from the Sentinel Content Hub solution's
  // Data Connector definitions (via vendor research), NOT from sample log type
  // names. All sample events are grouped by destination table and their fields
  // are merged, so a vendor like Palo Alto that sends TRAFFIC, THREAT, CONFIG
  // etc. all to CommonSecurityLog shows as one gap analysis row.
  useEffect(() => {
    if (!window.api || state.samples.length === 0 || !state.selectedSolution) {
      setAnalyses([]);
      setApprovedMappings(new Set());
      setRuleCoverage(null);
      return;
    }
    const runAnalysis = async () => {
      setAnalyzing(true);
      try {
        // Get destination tables from vendor research (sourced from Sentinel Content Hub)
        const research = await window.api.vendorResearch.research(state.selectedSolution) as any;
        const researchLogTypes: any[] = research?.logTypes || [];

        // Collect all unique destination tables from vendor research
        const destTables = new Set<string>();
        for (const lt of researchLogTypes) {
          if (lt.destTable) destTables.add(lt.destTable);
        }

        // If no dest tables found in research, fall back to checking if the
        // solution has custom _CL tables defined (CrowdStrike, Cloudflare, etc.)
        if (destTables.size === 0) {
          // Use sample log type names as custom table guesses
          for (const s of state.samples) {
            destTables.add(s.logType.replace(/[^a-zA-Z0-9]/g, '_') + '_CL');
          }
        }

        // Build one analysis input per log type so each gets its own field mapping.
        // Each log type (Traffic, Threat, AUTH) has different fields even if they
        // all target the same destination table (CommonSecurityLog).
        const sampleInputs: Array<{ logType: string; tableName: string; rawEvents: string[] }> = [];
        const defaultTable = Array.from(destTables)[0] || 'CommonSecurityLog';

        for (const s of state.samples as any[]) {
          if (!s.rawEvents?.length) continue;
          const sNorm = s.logType.toLowerCase().replace(/[_ \-]/g, '');

          // Match sample to its destination table via vendor research
          let matchedTable = defaultTable;
          if (destTables.size > 1) {
            for (const lt of researchLogTypes) {
              if (!lt.destTable) continue;
              const idNorm = (lt.id || '').toLowerCase().replace(/[_ \-]/g, '');
              const nameNorm = (lt.name || '').toLowerCase().replace(/[_ \-]/g, '');
              if (idNorm === sNorm || nameNorm === sNorm ||
                  (idNorm.length > 3 && sNorm.includes(idNorm)) ||
                  (sNorm.length > 3 && idNorm.includes(sNorm)) ||
                  (nameNorm.length > 3 && sNorm.includes(nameNorm)) ||
                  (sNorm.length > 3 && nameNorm.includes(sNorm))) {
                matchedTable = lt.destTable;
                break;
              }
            }
          }

          sampleInputs.push({
            logType: s.logType,
            tableName: matchedTable,
            rawEvents: s.rawEvents,
          });
        }

        const result = await window.api.packBuilder.analyzeSamples(state.selectedSolution, sampleInputs);
        if (result.success) {
          setAnalyses(result.analyses as SampleAnalysis[]);
          setApprovedMappings(new Set());

          // Run rule coverage analysis with discovered source + mapped dest fields
          try {
            // Collect fields that will exist in the destination table:
            // - keep/rename/coerce: the dest field name will be a column
            // - overflow: source name stored as key inside overflow field (extractable via parse_kv)
            // - drop: removed entirely
            const mappedDestFields = [...new Set(
              (result.analyses as SampleAnalysis[]).flatMap((a) =>
                (a.fieldMappings || []).flatMap((m) => {
                  if (m.action === 'drop') return [];
                  if (m.action === 'overflow') return [m.dest, m.source];
                  return [m.dest];
                })
              )
            )];
            const allDestTables = [...new Set((result.analyses as SampleAnalysis[]).map((a) => a.tableName))];
            // Always run coverage (even with empty fields) so the section shows rule status
            const coverage = await window.api.packBuilder.ruleCoverage(
              state.selectedSolution, mappedDestFields, undefined,
              customRules.length > 0 ? customRules : undefined,
              undefined, allDestTables,
            );
            setRuleCoverage(coverage);
          } catch (coverageErr) {
            console.warn('Rule coverage analysis failed:', coverageErr);
          }
        }
      } catch (e) { /* non-fatal */ }
      setAnalyzing(false);
    };
    runAnalysis();
  }, [state.samples, state.selectedSolution]);

  // Tag a sample
  const handleTagSample = async () => {
    if (!window.api || !pasteContent.trim() || !pasteLogType.trim() || !state.selectedSolution) return;
    try {
      const result = await window.api.sampleParser.tagSample(
        state.selectedSolution, pasteLogType, pasteContent, `${state.selectedSolution}_${pasteLogType}`
      );
      if (result.eventCount > 0) {
        const tagged = await window.api.sampleParser.getTagged(state.selectedSolution);
        update({ samples: tagged });
        setPasteContent('');
        setPasteLogType('');
      }
    } catch { /* skip */ }
  };

  // Upload files -- auto-detect log type from filename or sourcetype in events
  const handleUploadFiles = async () => {
    if (!window.api) return;
    try {
      const results = await window.api.sampleParser.parseFiles();
      if (results.length > 0 && state.selectedSolution) {
        for (const r of results) {
          // Try to extract a meaningful log type name:
          // 1. User-entered log type field
          // 2. Detect from filename: "cloudflare_dns_sample.json" -> "DNS"
          // 3. Detect from sourcetype in events: "cloudflare:dns:zones" -> "DNS"
          // 4. Fallback to filename without extension
          let lt = pasteLogType;
          if (!lt) {
            const fname = r.sourceName.replace(/\.[^.]+$/, '').toLowerCase();
            // Extract log type keywords from filename
            const typeKeywords = ['dns', 'http', 'waf', 'traffic', 'threat', 'url', 'system', 'audit', 'firewall', 'auth', 'utm'];
            const found = typeKeywords.find((kw) => fname.includes(kw));
            if (found) {
              lt = found.charAt(0).toUpperCase() + found.slice(1);
            }
          }
          if (!lt && r.fields) {
            // Check for sourcetype field
            const stField = r.fields.find((f) => f.name === 'sourcetype');
            if (stField?.sampleValues?.[0]) {
              const st = stField.sampleValues[0];
              // "cloudflare:dns:zones" -> "DNS"
              const parts = st.split(':');
              lt = parts.length > 1 ? parts[parts.length - 1].replace(/[^a-zA-Z]/g, '') : parts[0];
              lt = lt.charAt(0).toUpperCase() + lt.slice(1);
            }
          }
          if (!lt) {
            lt = r.sourceName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]/g, '_');
          }

          await window.api.sampleParser.tagSample(state.selectedSolution, lt, r.rawEvents.join('\n'), r.sourceName);
        }
        const tagged = await window.api.sampleParser.getTagged(state.selectedSolution);
        update({ samples: tagged });
      }
    } catch { /* skip */ }
  };

  // Auto-load sample data from Sentinel repo + local vendor sample libraries
  const [autoLoading, setAutoLoading] = useState(false);
  const [preIngestedWarning, setPreIngestedWarning] = useState('');
  const [expandedSample, setExpandedSample] = useState<string | null>(null);
  // Preserve original format from auto-load (CEF/LEEF/KV) since tagSample re-parses to NDJSON
  const [originalSampleFormats, setOriginalSampleFormats] = useState<Record<string, string>>({});
  const handleAutoLoadSamples = async () => {
    if (!window.api || !state.selectedSolution) return;
    setAutoLoading(true);
    setPreIngestedWarning('');
    try {
      const result = await window.api.defaultSamples.sentinelRepoSamples(state.selectedSolution);
      if (result.success) {
        // Show warning if pre-ingested samples were skipped
        const skipped = (result as any).skippedPreIngested || 0;
        if (result.samples.length === 0 && skipped === 0) {
          setPreIngestedWarning(
            `No sample data found in the Sentinel repository for this solution. ` +
            `Upload raw vendor samples (CEF/syslog/JSON from the source device), ` +
            `paste sample events, or capture live data from Cribl.`
          );
        } else if (skipped > 0 && result.samples.length > 0) {
          setPreIngestedWarning(
            `Skipped ${skipped} sample(s) in Sentinel table schema (post-ingestion format). ` +
            `Loaded ${result.samples.length} raw vendor sample(s) suitable for pipeline building.`
          );
        } else if (skipped > 0 && result.samples.length === 0) {
          setPreIngestedWarning(
            `All ${skipped} sample(s) found are in Sentinel table schema (post-ingestion format), ` +
            `not raw vendor format. These were skipped because they cannot inform pipeline transforms. ` +
            `Upload raw vendor samples (CEF/syslog/JSON from the source device) or capture live data from Cribl.`
          );
        }
        // Preserve original format per log type before tagging (tagSample re-parses to NDJSON)
        const formats: Record<string, string> = { ...originalSampleFormats };
        for (const sample of result.samples) {
          if (sample.format && sample.format !== 'ndjson' && sample.format !== 'json') {
            formats[sample.logType.toLowerCase()] = sample.format;
          }
          const content = sample.rawEvents.join('\n');
          await window.api.sampleParser.tagSample(
            state.selectedSolution, sample.logType, content, sample.source
          );
        }
        setOriginalSampleFormats(formats);
        const tagged = await window.api.sampleParser.getTagged(state.selectedSolution);
        update({ samples: tagged });
      } else {
        setPreIngestedWarning(
          (result as any).error || 'No sample data found for this solution. Upload samples manually.'
        );
      }
    } catch {
      setPreIngestedWarning('Failed to search for samples. Upload samples manually.');
    }
    setAutoLoading(false);
  };

  // Deploy everything
  const handleDeploy = async () => {
    if (!window.api) return;
    update({ deploying: true, deployLog: [], deployComplete: false });
    const log = (msg: string) => update({ deployLog: [...state.deployLog, msg] });
    // Use a mutable array since state updates are async
    const logs: string[] = [];
    const addLog = (msg: string) => { logs.push(msg); setState((p) => ({ ...p, deployLog: [...logs] })); };

    // Check integration mode to skip cloud operations
    let deployMode = 'full';
    try {
      const mc = await window.api.config.read('integration-mode.json') as any;
      deployMode = mc?.mode || 'full';
    } catch { /* default full */ }
    const skipAzure = deployMode === 'air-gapped' || deployMode === 'cribl-only';
    const skipCribl = deployMode === 'air-gapped' || deployMode === 'azure-only';
    if (deployMode !== 'full') addLog(`Mode: ${deployMode}`);

    try {
      // 0. Create resource group if new (skip in air-gapped/cribl-only)
      if (newRgName && state.resourceGroup && state.location && !skipAzure) {
        addLog(`Creating resource group: ${state.resourceGroup} (${state.location})`);
        const rgResult = await window.api.auth.azureCreateResourceGroup(
          state.resourceGroup, state.location, state.subscription,
        );
        if (rgResult.success) {
          addLog('  Resource group created');
        } else {
          addLog(`  Resource group creation: ${rgResult.error || 'failed'}`);
        }
      }

      // 1. Select workspace (skip in air-gapped/cribl-only)
      if (state.workspace && !skipAzure) {
        addLog(`Selecting workspace: ${state.workspace} (DCR target: ${state.resourceGroup})`);
        await window.api.auth.azureSelectWorkspace({
          workspaceName: state.workspace, resourceGroupName: state.resourceGroup,
          location: state.location, subscriptionId: state.subscription,
        });
        addLog('  Workspace selected');
      }

      // 2. Research vendor to find correct Sentinel table(s)
      addLog('Researching vendor schemas...');
      let destTables: string[] = [];
      let defaultDestTable = 'CommonSecurityLog';
      try {
        const research = await window.api.vendorResearch.research(state.selectedSolution) as any;
        if (research?.logTypes?.length > 0) {
          // Collect all unique destination tables from vendor research
          const tables = research.logTypes
            .filter((t: any) => t.destTable)
            .map((t: any) => t.destTable as string);
          destTables = [...new Set(tables)] as string[];
          if (destTables.length > 0) {
            defaultDestTable = destTables[0];
            addLog(`  ${destTables.length} destination table(s): ${destTables.join(', ')}`);
          } else {
            addLog(`  Using default table: ${defaultDestTable}`);
          }
        }
      } catch {
        addLog('  Vendor research unavailable, using default table');
      }
      if (destTables.length === 0) destTables = [defaultDestTable];

      // 3. Check for existing DCRs, deploy only if needed (skip in air-gapped/cribl-only)
      if (skipAzure) {
        addLog('Skipping Azure DCR deployment (offline mode)');
      }
      for (const destTable of skipAzure ? [] : destTables) {
        const isCustomTable = destTable.endsWith('_CL');
        addLog(`Checking for existing DCR for ${destTable}...`);
        const existingDests = await window.api.azureDeploy.checkExisting([destTable]);
        const existingDest = existingDests?.[destTable];

        if (existingDest && typeof existingDest === 'object' && 'dcrID' in (existingDest as any)) {
          const dest = existingDest as any;
          addLog(`  Found existing DCR: ${dest.dcrID}`);
          addLog('  Skipping -- using existing');
        } else {
          addLog(`  No existing DCR found, deploying${state.enableDce ? ' with DCE' : ''}...`);
          const dcrMode = state.enableDce
            ? (isCustomTable ? 'DCECustom' : 'DCENative')
            : (isCustomTable ? 'DirectCustom' : 'DirectNative');
          const dcrResult = await window.api.azureDeploy.deployDcrs({
            tables: [destTable], mode: dcrMode, templateOnly: false,
          });
          if (dcrResult.success) {
            addLog(`  DCR deployed for ${destTable}`);
          } else {
            addLog(`  DCR deployment: ${dcrResult.error || 'failed'}`);
          }
        }
      }

      // 3b. Assign Monitoring Metrics Publisher role to Cribl service principal (if enabled)
      if (state.assignDcrPermissions && state.enterpriseAppObjectId && !skipAzure) {
        addLog('');
        addLog(`Assigning DCR permissions to service principal ${state.enterpriseAppObjectId.slice(0, 8)}...`);
        try {
          const dcrIds = await window.api.azureDeploy.getDcrIds(destTables);
          if (dcrIds.length > 0) {
            addLog(`  Found ${dcrIds.length} DCR(s) to assign: ${dcrIds.map((d) => d.table).join(', ')}`);
            const roleResult = await window.api.azureDeploy.assignDcrRole(
              state.enterpriseAppObjectId,
              dcrIds.map((d) => d.resourceId),
            );
            for (const r of roleResult.results) {
              addLog(`  ${r.dcr}: ${r.success ? (r.error === 'Already assigned' ? 'Already assigned' : 'Assigned') : 'Failed -- ' + r.error}`);
            }
            addLog(`  ${roleResult.assigned}/${roleResult.total} DCR(s) assigned Monitoring Metrics Publisher role`);
          } else {
            addLog('  No DCR resource IDs found -- role assignment skipped');
          }
        } catch (err) {
          addLog(`  Role assignment error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const streamName = `Custom-${defaultDestTable.replace(/_CL$/i, '')}`;

      // 4. Build pack -- use vendor research for per-logtype pipelines
      addLog(`Building pack: ${state.packName}`);
      const vendorName = state.selectedSolution.replace(/[^a-zA-Z0-9]/g, '_');

      // Create a table entry per log type from vendor research
      // Each gets its own pipeline name but all target the same destination table
      const tables: Array<{ sentinelTable: string; criblStream: string; fields: never[] }> = [];
      let research: any = null;
      try { research = await window.api.vendorResearch.research(state.selectedSolution); } catch { /* skip */ }

      // Build table entries from BOTH vendor research AND loaded samples.
      // Vendor research provides field definitions and sourcetype filters;
      // loaded samples provide additional log types the research may not cover.
      const seenLogTypes = new Set<string>();
      // Normalize log type names for dedup: strip _logs/_events/_data suffixes,
      // remove non-alphanumeric, lowercase. "Traffic_Logs" and "TRAFFIC" both -> "traffic"
      const normalizeLogType = (name: string) =>
        name.toLowerCase()
          .replace(/[^a-z0-9]/g, '')
          .replace(/(logs|events|data|samples)$/g, '');

      if (research?.logTypes?.length > 0) {
        for (const lt of research.logTypes) {
          if (lt.fields?.length > 0) {
            const logType = lt.name?.replace(/[^a-zA-Z0-9_]/g, '_') || lt.id;
            seenLogTypes.add(normalizeLogType(logType));
            tables.push({
              sentinelTable: lt.destTable || defaultDestTable,
              criblStream: streamName,
              logType,
              sourcetypeFilter: lt.sourcetypePattern ? `sourcetype == '${lt.sourcetypePattern}'` : 'true',
              fields: [],
            } as any);
          }
        }
      }

      // Add sample log types not already covered by vendor research
      if (state.samples.length > 0) {
        for (const sample of state.samples) {
          const sampleKey = normalizeLogType(sample.logType);
          if (!seenLogTypes.has(sampleKey)) {
            seenLogTypes.add(sampleKey);
            tables.push({
              sentinelTable: defaultDestTable,
              criblStream: streamName,
              logType: sample.logType,
              fields: [],
            } as any);
          }
        }
      }

      if (tables.length === 0) {
        tables.push({ sentinelTable: defaultDestTable, criblStream: streamName, fields: [] });
        addLog('  1 log type (default)');
      } else {
        addLog(`  ${tables.length} log type(s): ${tables.map((t: any) => t.logType || t.sentinelTable).join(', ')}`);
      }

      // Convert tagged samples into VendorSample format for the pack builder
      // Match each sample to its table by logType name if possible
      const vendorSamples = state.samples.map((s: any) => {
        // Try to match sample logType to a table entry
        const matchedTable = tables.find((t: any) =>
          t.logType && s.logType && t.logType.toLowerCase().includes(s.logType.toLowerCase().replace(/[_ ]/g, ''))
        ) as any;
        // Detect format from multiple sources (tagSample re-parses CEF to NDJSON, losing format)
        let detectedFormat = originalSampleFormats[s.logType.toLowerCase()] || s.format || 'json';
        // If format looks like JSON but raw events contain CEF/LEEF markers, override
        if ((detectedFormat === 'json' || detectedFormat === 'ndjson') && s.rawEvents?.length > 0) {
          const firstRaw = s.rawEvents[0] || '';
          // Check the raw event -- if it was parsed FROM CEF, the JSON will have CEF header fields
          try {
            const parsed = JSON.parse(firstRaw);
            if (parsed.CEFVersion !== undefined && parsed.DeviceVendor) detectedFormat = 'cef';
            else if (parsed.LEEFVersion !== undefined) detectedFormat = 'leef';
          } catch { /* not JSON, check raw string */
            if (firstRaw.includes('CEF:')) detectedFormat = 'cef';
            else if (firstRaw.includes('LEEF:')) detectedFormat = 'leef';
          }
        }
        return {
          tableName: matchedTable?.sentinelTable || defaultDestTable,
          format: detectedFormat,
          rawEvents: s.rawEvents || [],
          source: `${vendorName}:${s.logType}`,
        };
      });

      // Auto-increment version if pack already exists
      let packVersion = '1.0.0';
      try {
        const existingPacks = await window.api.packBuilder.list();
        const existing = existingPacks?.find((p: any) => p.name === state.packName || p.id === state.packName);
        if (existing?.version) {
          const parts = existing.version.split('.').map(Number);
          parts[2] = (parts[2] || 0) + 1; // bump patch
          packVersion = parts.join('.');
          addLog(`  Incrementing version: ${existing.version} -> ${packVersion}`);
        }
      } catch { /* first build */ }

      const buildResult = await window.api.packBuilder.scaffold({
        solutionName: vendorName,
        packName: state.packName,
        version: packVersion,
        autoPackage: false,
        vendorSamples,
        tables,
        fieldMappingOverrides: Object.keys(mappingEdits).length > 0 ? mappingEdits : undefined,
      });
      addLog(`  Pack directory: ${buildResult.packDir}`);

      // 5. Refresh destination configs from Azure (skip in air-gapped/cribl-only)
      if (!skipAzure) {
        addLog('Refreshing destination configs from Azure...');
        const refreshResult = await window.api.azureDeploy.refreshDestinations(destTables);
        addLog(`  ${refreshResult.total || 0} destination(s) resolved`);

        // 5b. Embed destinations
        addLog('Embedding destination configs...');
        const embedResult = await window.api.azureDeploy.embedDestinations(buildResult.packDir, destTables);
        addLog(`  ${embedResult.message || embedResult.error || 'Done'}`);
      } else {
        addLog('Skipping Azure destination refresh (offline mode)');
      }

      // 5. Package .crbl
      addLog('Packaging .crbl...');
      const pkgResult = await window.api.packBuilder.package(buildResult.packDir);
      addLog(`  Created: ${pkgResult.crblPath}`);

      // 6. Deploy event breaker + pack to Cribl worker groups (skip in air-gapped/azure-only)
      if (!skipCribl && criblConnected && state.workerGroups.length > 0) {
        const isCrowdStrike = vendorName.toLowerCase().includes('crowdstrike');

        // Deploy FDR event breaker at the worker group level (for Cribl Insights _time accuracy)
        if (isCrowdStrike) {
          addLog('Creating CrowdStrike FDR event breaker on worker group(s)...');
          const fdrBreaker = {
            id: 'CrowdStrike_FDR',
            lib: 'custom',
            description: 'CrowdStrike FDR event breaker. Anchors timestamp extraction directly on the "timestamp" field (epoch ms) to handle varying field positions across event types. 768KB max for ScriptContent events.',
            tags: 'CrowdStrike,FDR,Sentinel',
            rules: [
              {
                name: 'CrowdStrike FDR JSON',
                type: 'json_array',
                condition: '/crowdstrike/i.test(source) || /crowdstrike/i.test(sourcetype)',
                timestampAnchorRegex: '/"timestamp":\\s*"/',
                timestamp: { type: 'format', length: 150, format: '%s%L' },
                timestampTimezone: 'utc',
                maxEventBytes: 786432,
                jsonExtractAll: true,
              },
            ],
          };
          for (const group of state.workerGroups) {
            const bkResult = await window.api.auth.criblCreateBreaker(group, 'CrowdStrike_FDR', fdrBreaker);
            addLog(`  ${group}: ${bkResult.success ? bkResult.action || 'OK' : bkResult.error}`);
          }
        }

        addLog(`Uploading pack to ${state.workerGroups.length} worker group(s)...`);
        for (const group of state.workerGroups) {
          addLog(`  Uploading to ${group}...`);
          const uploadResult = await window.api.auth.criblUploadPack(pkgResult.crblPath, group);
          addLog(`    ${uploadResult.error || (uploadResult.success ? 'OK' : 'Failed')}`);
        }
      } else {
        addLog('Skipping Cribl upload (not connected or no worker groups selected)');
      }

      // 7. Post-deploy validation (skip in air-gapped/azure-only)
      if (!skipCribl && criblConnected && state.workerGroups.length > 0 && state.samples.length > 0) {
        addLog('Validating pipeline transformation...');
        const testGroup = state.workerGroups[0];
        const testSample = state.samples[0];
        if (testSample.rawEvents && testSample.rawEvents.length > 0) {
          try {
            const testEvent = JSON.parse(testSample.rawEvents[0]);
            const pipelineConf = {
              functions: [
                { id: 'serde', conf: { mode: 'extract', type: 'json', srcField: '_raw' } },
                { id: 'eval', conf: { add: [{ name: '_time', value: 'Number(timestamp) / 1000 || Date.now() / 1000' }] } },
              ],
            };
            const previewResult = await window.api.auth.criblPreview(
              testGroup, pipelineConf, [{ _raw: JSON.stringify(testEvent), _time: Date.now() / 1000 }]
            );
            if (previewResult.success && previewResult.events?.length > 0) {
              const outEvent = previewResult.events[0];
              const outFields = Object.keys(outEvent).filter((k) => !k.startsWith('_') && !k.startsWith('cribl'));
              addLog('  Validation passed: ' + outFields.length + ' fields extracted from test event');
            } else {
              addLog('  Validation: pipeline preview returned no events (non-blocking)');
            }
          } catch (valErr) {
            addLog('  Validation skipped: ' + (valErr instanceof Error ? valErr.message : String(valErr)));
          }
        }
      }

      // Export artifacts in air-gapped or partial modes
      if (skipAzure || skipCribl) {
        addLog('');
        addLog('Exporting deployment artifacts...');
        try {
          const exportResult = await window.api.packBuilder.exportArtifacts({
            packDir: buildResult.packDir,
            crblPath: pkgResult.crblPath,
            exportDir: 'downloads',
            tables: destTables,
            solutionName: vendorName,
            packName: state.packName,
          });
          addLog(`  Exported to: ${exportResult.exportPath}`);
          for (const a of exportResult.artifacts.slice(0, 10)) addLog(`    ${a}`);
          if (exportResult.artifacts.length > 10) addLog(`    ... and ${exportResult.artifacts.length - 10} more`);
        } catch (ex) {
          addLog(`  Export error: ${ex instanceof Error ? ex.message : String(ex)}`);
        }
      }

      addLog('');
      addLog(skipAzure && skipCribl ? 'Build complete (air-gapped mode).' :
             skipAzure ? 'Build complete (Azure skipped).' :
             skipCribl ? 'Deployment complete (Cribl skipped).' :
             'Deployment complete.');
      if (analyses.length > 0) {
        const totalPassthrough = analyses.reduce((s, a) => s + a.passthroughCount, 0);
        const totalDcr = analyses.reduce((s, a) => s + a.dcrHandledCount, 0);
        const totalCribl = analyses.reduce((s, a) => s + a.criblHandledCount, 0);
        addLog('Summary: ' + totalPassthrough + ' passthrough, ' + totalDcr + ' DCR-handled, ' + totalCribl + ' Cribl-handled fields');
      }
      if (!skipCribl && !skipAzure) {
        addLog('Update the client secret in the Cribl Sentinel destination to start data flow.');
      } else {
        addLog('See exported artifacts for manual deployment instructions.');
      }
      update({ deployComplete: true });
    } catch (err) {
      addLog(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
    update({ deploying: false });
  };

  // Load sources when deploy completes (for source wiring)
  useEffect(() => {
    if (!state.deployComplete || !window.api || !criblConnected || state.workerGroups.length === 0) return;
    const load = async () => {
      try {
        const result = await window.api.auth.criblSources(state.workerGroups[0]);
        if (result.success) setWiringSources(result.sources.filter((s: any) => !s.disabled));
      } catch { /* skip */ }
    };
    load();
  }, [state.deployComplete, state.workerGroups, criblConnected]);

  // Load Lake datasets when federation is toggled on
  useEffect(() => {
    if (!state.enableLakeFederation || !window.api || !criblConnected) return;
    const load = async () => {
      try {
        const result = await window.api.auth.criblDatasets();
        if (result.success) setLakeDatasets(result.datasets);
      } catch { /* skip */ }
    };
    load();
  }, [state.enableLakeFederation, criblConnected]);

  // Wire source to pack: create routes, commit, deploy
  const handleWireSource = async () => {
    if (!window.api || !state.selectedSource || !state.packName) return;
    update({ wiring: true, wiringLog: [], wiringComplete: false });
    const logs: string[] = [];
    const addLog = (msg: string) => { logs.push(msg); setState((p) => ({ ...p, wiringLog: [...logs] })); };

    try {
      const group = state.workerGroups[0];
      const sourceFilter = `__inputId=='${state.selectedSource}'`;

      // 1. Create Sentinel route first (will be position 0 after unshift)
      addLog(`Creating Sentinel route: ${state.selectedSource} -> ${state.packName}...`);
      const sentinelResult = await window.api.auth.criblCreateRoute(
        group,
        `${state.packName}-sentinel`,
        `${state.packName} to Sentinel`,
        sourceFilter,
        state.packName,
        undefined,  // output: default (pack's embedded output)
        `Routes ${state.selectedSource} through ${state.packName} pack to Sentinel`,
        true,       // final
      );
      addLog(`  ${sentinelResult.success ? 'OK' : sentinelResult.error}`);

      // 2. If Lake federation enabled, create dataset (if new) and route
      const effectiveDataset = newDatasetName || state.selectedDataset;
      if (state.enableLakeFederation && effectiveDataset) {
        // Create new dataset if name was entered
        if (newDatasetName) {
          addLog(`Creating Cribl Lake dataset: ${newDatasetName}...`);
          const dsResult = await window.api.auth.criblCreateDataset(
            newDatasetName, `Full fidelity data from ${state.packName}`
          );
          addLog(`  ${dsResult.success ? (dsResult.error || 'Created') : dsResult.error}`);
        }

        addLog(`Creating Cribl Lake route: ${state.selectedSource} -> ${effectiveDataset}...`);
        const lakeResult = await window.api.auth.criblCreateRoute(
          group,
          `${state.packName}-lake`,
          `${state.packName} full fidelity to Lake`,
          sourceFilter,
          'passthru',
          `cribl_lake:${effectiveDataset}`,
          `Full fidelity copy of ${state.selectedSource} to Cribl Lake dataset ${effectiveDataset}`,
          false,  // non-final: let data continue to Sentinel route
        );
        addLog(`  ${lakeResult.success ? 'OK' : lakeResult.error}`);
      }

      // 3. Commit configuration
      addLog('Committing configuration...');
      const commitResult = await window.api.auth.criblCommit(
        `Wired source ${state.selectedSource} to pack ${state.packName}${state.enableLakeFederation ? ' + Cribl Lake' : ''}`
      );
      addLog(`  ${commitResult.success ? 'Committed' : commitResult.error || 'No pending changes'}`);

      // 4. Deploy to each worker group
      for (const g of state.workerGroups) {
        addLog(`Deploying to ${g}...`);
        const deployResult = await window.api.auth.criblDeployConfig(g);
        addLog(`  ${deployResult.success ? 'Deployed' : deployResult.error}`);
      }

      addLog('Source wiring complete. Data should now flow from source through the pack to Sentinel.');
      update({ wiringComplete: true });
    } catch (err) {
      addLog(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
    update({ wiring: false });
  };

  const filteredSolutions = solutions.filter((sol) =>
    !solutionSearch || sol.name.toLowerCase().includes(solutionSearch.toLowerCase())
  ).slice(0, 50);

  const hasMappings = analyses.length > 0 && analyses.some((a) => a.fieldMappings && a.fieldMappings.length > 0);
  const tablesWithMappings = analyses.filter((a) => a.fieldMappings && a.fieldMappings.length > 0).map((a) => a.logType);
  const allMappingsReviewed = hasMappings && tablesWithMappings.every((t) => approvedMappings.has(t));
  const canDeploy = state.selectedSolution && state.packName && !state.deploying
    && (hasAzure ? !!state.workspace : true)
    && (hasCribl ? state.workerGroups.length > 0 : true)
    && (!hasMappings || allMappingsReviewed);

  const sectionDone = (n: number) => {
    if (n === 1) return !!state.selectedSolution;
    if (n === 2) return state.samples.length > 0;
    if (n === 3) return hasAzure ? !!state.workspace : true;
    if (n === 4) return (hasCribl ? state.workerGroups.length > 0 : true) && !!state.packName;
    if (n === 5) return state.deployComplete;
    if (n === 6) return state.wiringComplete;
    return false;
  };

  return (
    <div style={s.page}>
      <div style={s.header}>
        <h1 style={s.title}>Cribl Sentinel Integration</h1>
        <p style={s.subtitle}>Configure and deploy a complete Cribl-to-Sentinel integration pipeline</p>
      </div>

      {/* Repo status bar */}
      <div style={{
        display: 'flex', gap: '16px', marginBottom: '12px', padding: '8px 14px',
        background: 'var(--bg-secondary)', borderRadius: 'var(--radius)',
        border: '1px solid var(--border-color)', fontSize: '11px', fontFamily: 'var(--font-mono)',
        alignItems: 'center',
      }}>
        <span style={{ color: 'var(--text-muted)', fontWeight: 600, fontSize: '10px' }}>REPOS</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          <span style={{
            width: '7px', height: '7px', borderRadius: '50%', display: 'inline-block',
            background: repoState === 'ready' ? 'var(--accent-green)'
              : (repoState === 'cloning' || repoState === 'updating') ? 'var(--accent-blue)'
              : repoState === 'error' ? 'var(--accent-red)' : 'var(--text-muted)',
          }} />
          <span style={{ color: repoState === 'ready' ? 'var(--accent-green)' : 'var(--text-muted)' }}>
            Sentinel {repoState === 'ready' ? `(${repoSolutionCount} solutions)` : repoState}
          </span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          <span style={{
            width: '7px', height: '7px', borderRadius: '50%', display: 'inline-block',
            background: elasticRepoState.state === 'ready' ? 'var(--accent-green)'
              : elasticRepoState.state === 'cloning' ? 'var(--accent-blue)'
              : elasticRepoState.state === 'error' ? 'var(--accent-red)' : 'var(--text-muted)',
          }} />
          <span style={{ color: elasticRepoState.state === 'ready' ? 'var(--accent-green)' : 'var(--text-muted)' }}>
            Elastic {elasticRepoState.state === 'ready' ? `(${elasticRepoState.packageCount} packages)` : elasticRepoState.state}
          </span>
        </span>
      </div>

      {/* Section 1: Sentinel Solution */}
      <div style={s.section}>
        <div style={s.sectionTitle}>
          <span style={sectionDone(1) ? s.sectionNumDone : s.sectionNum}>1</span>
          Sentinel Solution
          <InfoTip text="Select the vendor solution from the Microsoft Sentinel content hub. The solution determines which destination tables, field schemas, and analytics rules apply. Solutions are loaded from a local clone of the Azure-Sentinel GitHub repository." />
        </div>
        <div style={s.sectionDesc}>Select the vendor or solution to integrate with Microsoft Sentinel</div>

        {/* Repo status indicator */}
        {repoState !== 'ready' && repoState !== 'loading' && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: '10px',
            padding: '10px 14px', marginBottom: '12px', borderRadius: '4px',
            background: repoState === 'error'
              ? 'rgba(239, 83, 80, 0.08)' : 'rgba(79, 195, 247, 0.08)',
            border: `1px solid ${repoState === 'error'
              ? 'rgba(239, 83, 80, 0.2)' : 'rgba(79, 195, 247, 0.2)'}`,
            fontSize: '12px',
          }}>
            {(repoState === 'cloning' || repoState === 'updating') && (
              <div style={{
                width: '14px', height: '14px', borderRadius: '50%',
                border: '2px solid rgba(79, 195, 247, 0.3)',
                borderTopColor: 'var(--accent-blue)',
                animation: 'repoSpin 1s linear infinite', flexShrink: 0,
              }} />
            )}
            <div style={{ flex: 1 }}>
              <div style={{
                fontWeight: 600,
                color: repoState === 'error' ? 'var(--accent-red)' : 'var(--accent-blue)',
              }}>
                {repoState === 'cloning' && 'Cloning Azure-Sentinel repository...'}
                {repoState === 'updating' && 'Updating Azure-Sentinel repository...'}
                {repoState === 'not_cloned' && 'Sentinel repository not available'}
                {repoState === 'error' && 'Repository sync failed'}
              </div>
              {repoProgress && (
                <div style={{
                  fontSize: '11px', color: 'var(--text-muted)', marginTop: '3px',
                  fontFamily: 'var(--font-mono)',
                }}>
                  {repoProgress}
                </div>
              )}
              {(repoState === 'cloning' || repoState === 'updating') && (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                  This downloads solution definitions for field mapping. Usually completes in 1-2 minutes.
                </div>
              )}
              {repoState === 'cloning' && (
                <div style={{
                  fontSize: '10px', color: 'var(--accent-orange)', marginTop: '6px',
                  padding: '6px 10px', borderRadius: '4px',
                  background: 'rgba(255, 167, 38, 0.08)', border: '1px solid rgba(255, 167, 38, 0.15)',
                }}>
                  Security notice: The Sentinel repository contains analytics rules with IOC data
                  (malicious IPs, file hashes, domains) used for threat detection. Your antivirus
                  or EDR software may flag these files during the clone. This is expected behavior
                  -- the files are detection rules from Microsoft, not malware.
                </div>
              )}
            </div>
            {(repoState === 'error' || repoState === 'not_cloned') && (
              <button
                className="btn-secondary"
                style={{ fontSize: '11px', padding: '4px 12px', flexShrink: 0 }}
                onClick={async () => {
                  if (!window.api) return;
                  setRepoState('cloning');
                  setRepoProgress('Starting clone...');
                  try { await window.api.sentinelRepo.sync(); } catch { setRepoState('error'); }
                }}
              >
                Retry Sync
              </button>
            )}
          </div>
        )}

        {/* Loading state for solutions */}
        {repoState === 'loading' && solutions.length === 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '10px 14px', marginBottom: '12px',
            fontSize: '12px', color: 'var(--text-muted)',
          }}>
            <div style={{
              width: '12px', height: '12px', borderRadius: '50%',
              border: '2px solid rgba(255,255,255,0.1)',
              borderTopColor: 'var(--text-muted)',
              animation: 'repoSpin 1s linear infinite', flexShrink: 0,
            }} />
            Loading solutions...
          </div>
        )}

        <style>{`@keyframes repoSpin { to { transform: rotate(360deg); } }`}</style>

        <div style={s.row}>
          <div style={s.field}>
            <div style={s.label}>Search Solutions</div>
            <input
              style={s.input}
              value={solutionSearch}
              onChange={(e) => setSolutionSearch(e.target.value)}
              placeholder={
                repoState === 'cloning' || repoState === 'updating'
                  ? 'Waiting for repository sync...'
                  : 'Search Sentinel Content Hub (e.g., Palo Alto, CrowdStrike, Fortinet...)'
              }
              disabled={repoState === 'cloning' || repoState === 'updating'}
            />
          </div>
          <div style={s.field}>
            <div style={s.label}>
              Selected Solution
              {solutions.length > 0 && (() => {
                const depCount = solutions.filter((s) => s.deprecated).length;
                const activeCount = solutions.length - depCount;
                return (
                  <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: '6px' }}>
                    ({activeCount} active{depCount > 0 ? `, ${depCount} deprecated` : ''})
                  </span>
                );
              })()}
            </div>
            <select
              style={s.select}
              value={state.selectedSolution}
              onChange={(e) => update({ selectedSolution: e.target.value, samples: [] })}
              disabled={solutions.length === 0}
            >
              <option value="">
                {solutions.length === 0
                  ? (repoState === 'cloning' ? '-- Syncing repository... --' :
                     repoState === 'loading' ? '-- Loading... --' :
                     '-- No solutions available --')
                  : '-- Select a solution --'}
              </option>
              {filteredSolutions.map((sol) => (
                <option key={sol.name} value={sol.name}>
                  {sol.deprecated ? '[Deprecated] ' : ''}{sol.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {state.selectedSolution && (() => {
          const sel = solutions.find((s) => s.name === state.selectedSolution);
          return (
            <>
              {sel?.deprecated ? (
                <div style={{
                  padding: '10px 14px', borderRadius: '4px', marginTop: '4px',
                  background: 'rgba(255, 167, 38, 0.08)',
                  border: '1px solid rgba(255, 167, 38, 0.25)',
                  fontSize: '12px', lineHeight: 1.5,
                }}>
                  <span style={{ fontWeight: 700, color: 'var(--accent-orange)' }}>
                    Deprecated Solution:
                  </span>
                  <span style={{ color: 'var(--text-secondary)', marginLeft: '6px' }}>
                    {sel.deprecationReason || 'This solution has been deprecated by Microsoft.'}{' '}
                    The connector or data format may be outdated. Check the Sentinel Content Hub for a
                    newer replacement before deploying.
                  </span>
                </div>
              ) : (
                <div style={{ fontSize: '12px', color: 'var(--accent-green)' }}>
                  Selected: {state.selectedSolution}
                </div>
              )}
            </>
          );
        })()}
      </div>

      {/* Section 2: Sample Data */}
      <div style={s.section}>
        <div style={s.sectionTitle}>
          <span style={sectionDone(2) ? s.sectionNumDone : s.sectionNum}>2</span>
          Sample Data
          <InfoTip text="Provide sample log data so the app can discover fields, detect formats (CEF, JSON, CSV, etc.), and build accurate field mappings. You can auto-load samples from the Sentinel repo, upload Cribl capture files (.json), or paste raw events." />
        </div>
        <div style={s.sectionDesc}>
          Upload or paste sample log data for each log type. This informs pipeline field mapping.
          {!state.selectedSolution && <span style={{ color: 'var(--accent-orange)' }}> Select a solution first.</span>}
        </div>

        {/* Sample load feedback */}
        {preIngestedWarning && (
          <div style={{
            padding: '10px 14px', marginBottom: '12px', borderRadius: '4px',
            background: preIngestedWarning.includes('No sample data') || preIngestedWarning.includes('Failed')
              ? 'rgba(79, 195, 247, 0.08)' : 'rgba(255, 167, 38, 0.08)',
            border: `1px solid ${preIngestedWarning.includes('No sample data') || preIngestedWarning.includes('Failed')
              ? 'rgba(79, 195, 247, 0.25)' : 'rgba(255, 167, 38, 0.25)'}`,
            fontSize: '12px',
            color: preIngestedWarning.includes('No sample data') || preIngestedWarning.includes('Failed')
              ? 'var(--accent-blue)' : 'var(--accent-orange)',
            lineHeight: 1.5,
          }}>
            {preIngestedWarning}
          </div>
        )}

        {state.samples.length > 0 && (
          <div style={{ marginBottom: '12px' }}>
            <div style={{ marginBottom: '8px' }}>
              {state.samples.map((sample) => (
                <span
                  key={sample.logType}
                  style={{
                    ...s.sampleTag,
                    cursor: 'pointer',
                    borderColor: expandedSample === sample.logType ? 'var(--accent-blue)' : 'var(--border-color)',
                    background: expandedSample === sample.logType ? 'rgba(79, 195, 247, 0.1)' : 'var(--bg-input)',
                  }}
                  onClick={() => setExpandedSample(expandedSample === sample.logType ? null : sample.logType)}
                >
                  <strong>{sample.logType}</strong>
                  <span style={s.sampleCount}>{sample.eventCount} events, {sample.fieldCount} fields ({sample.format})</span>
                  <span
                    style={{ cursor: 'pointer', marginLeft: '4px', color: 'var(--accent-red)', fontWeight: 700, fontSize: '13px', lineHeight: 1 }}
                    title={`Remove ${sample.logType}`}
                    onClick={(e) => { e.stopPropagation(); setExpandedSample(null); update({ samples: state.samples.filter((ss) => ss.logType !== sample.logType) }); }}
                  >x</span>
                </span>
              ))}
            </div>

            {/* Expanded sample detail panel */}
            {expandedSample && (() => {
              const sample = state.samples.find((ss) => ss.logType === expandedSample);
              if (!sample) return null;
              return (
                <div style={{
                  background: 'var(--bg-primary)', border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius)', padding: '14px', marginBottom: '8px',
                  fontSize: '11px', fontFamily: 'var(--font-mono)',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
                    <div style={{ fontSize: '13px', fontWeight: 700, fontFamily: 'inherit' }}>
                      {sample.logType}
                      <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: '8px' }}>
                        {sample.eventCount} events, {sample.format} format
                        {sample.timestampField ? `, ts: ${sample.timestampField}` : ''}
                      </span>
                    </div>
                    <button
                      className="btn-secondary"
                      style={{ fontSize: '10px', padding: '2px 8px' }}
                      onClick={() => setExpandedSample(null)}
                    >Close</button>
                  </div>

                  {/* Fields table */}
                  {sample.fields && sample.fields.length > 0 && (
                    <div style={{ marginBottom: '12px' }}>
                      <div style={{ fontWeight: 700, marginBottom: '6px', fontSize: '11px', color: 'var(--text-secondary)' }}>
                        Fields ({sample.fields.length})
                      </div>
                      <div style={{ maxHeight: '220px', overflow: 'auto', border: '1px solid var(--border-color)', borderRadius: '3px' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '10px' }}>
                          <thead>
                            <tr style={{ background: 'var(--bg-secondary)', position: 'sticky', top: 0 }}>
                              <th style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--border-color)' }}>Field</th>
                              <th style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--border-color)', width: '60px' }}>Type</th>
                              <th style={{ textAlign: 'center', padding: '4px 8px', borderBottom: '1px solid var(--border-color)', width: '40px' }}>Req</th>
                              <th style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--border-color)' }}>Sample Values</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sample.fields.map((field) => (
                              <tr key={field.name} style={{ borderBottom: '1px solid var(--border-color)' }}>
                                <td style={{ padding: '3px 8px', color: 'var(--accent-blue)', fontWeight: 600 }}>{field.name}</td>
                                <td style={{ padding: '3px 8px', color: 'var(--text-muted)' }}>{field.type}</td>
                                <td style={{ padding: '3px 8px', textAlign: 'center', color: field.required ? 'var(--accent-green)' : 'var(--text-muted)' }}>
                                  {field.required ? 'Y' : ''}
                                </td>
                                <td style={{ padding: '3px 8px', color: 'var(--text-secondary)', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {field.sampleValues.slice(0, 2).join(' | ')}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Raw event preview */}
                  {sample.rawEvents && sample.rawEvents.length > 0 && (
                    <div>
                      <div style={{ fontWeight: 700, marginBottom: '6px', fontSize: '11px', color: 'var(--text-secondary)' }}>
                        Raw Events (first 3)
                      </div>
                      <div style={{ maxHeight: '160px', overflow: 'auto', background: 'var(--bg-input)', borderRadius: '3px', padding: '8px' }}>
                        {sample.rawEvents.slice(0, 3).map((raw, i) => {
                          let display = raw;
                          try { display = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* keep original */ }
                          return (
                            <pre key={i} style={{
                              margin: 0, marginBottom: i < 2 ? '6px' : 0, padding: '6px',
                              background: 'var(--bg-secondary)', borderRadius: '2px',
                              whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                              fontSize: '10px', lineHeight: 1.4, color: 'var(--text-secondary)',
                              maxHeight: '100px', overflow: 'auto',
                            }}>
                              {display}
                            </pre>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}

        <div style={s.row}>
          <div style={{ ...s.field, flex: 2 }}>
            <div style={s.label}>Paste Sample Logs</div>
            <textarea
              style={s.textarea}
              value={pasteContent}
              onChange={(e) => setPasteContent(e.target.value)}
              placeholder="Paste raw log events here..."
              disabled={!state.selectedSolution}
            />
          </div>
          <div style={s.field}>
            <div style={s.label}>Log Type Name</div>
            <input
              style={s.input}
              value={pasteLogType}
              onChange={(e) => setPasteLogType(e.target.value)}
              placeholder="e.g., Traffic, Threat, DNS"
              disabled={!state.selectedSolution}
            />
            <div style={{ display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' }}>
              <button className="btn-primary" style={{ fontSize: '11px' }} onClick={handleTagSample}
                disabled={!pasteContent.trim() || !pasteLogType.trim() || !state.selectedSolution}>
                Add Sample
              </button>
              <button className="btn-secondary" style={{ fontSize: '11px' }} onClick={handleUploadFiles}
                disabled={!state.selectedSolution}>
                Upload Files
              </button>
              <button className="btn-success" style={{ fontSize: '11px' }} onClick={handleAutoLoadSamples}
                disabled={!state.selectedSolution || autoLoading}>
                {autoLoading ? 'Searching...' : 'Auto-Load Samples'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Analysis Results -- shown after samples are uploaded */}
      {(analyses.length > 0 || analyzing) && (
        <div style={{ ...s.section, borderLeft: '3px solid var(--accent-blue)' }}>
          <div style={s.sectionTitle}>
            <span style={s.sectionNum}>
              {analyzing ? '...' : '\u2713'}
            </span>
            DCR Gap Analysis
            <InfoTip text="Compares your source sample fields against the Azure DCR schema to determine what each system handles. Passthrough fields need no transformation. DCR-handled fields are transformed by Azure. Cribl-handled fields require pipeline functions in the pack. Overflow fields are collected into a catch-all field so no data is lost." />
          </div>
          <div style={s.sectionDesc}>
            {analyzing ? 'Analyzing sample data against DCR schemas...' :
              'Comparison of source sample data vs Azure DCR expectations. Cribl pipelines will only handle the gaps.'}
          </div>

          {/* Mapping approval bar */}
          {!analyzing && hasMappings && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px',
              padding: '8px 14px', borderRadius: '4px',
              background: allMappingsReviewed ? 'rgba(102, 187, 106, 0.05)' : 'rgba(255, 167, 38, 0.05)',
              border: `1px solid ${allMappingsReviewed ? 'rgba(102, 187, 106, 0.2)' : 'rgba(255, 167, 38, 0.2)'}`,
            }}>
              {!allMappingsReviewed ? (
                <>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--accent-orange)', flexShrink: 0 }} />
                  <span style={{ fontSize: '11px', color: 'var(--text-secondary)', flex: 1 }}>
                    {approvedMappings.size > 0
                      ? `${approvedMappings.size} of ${tablesWithMappings.length} table mapping(s) approved. Approve each individually or auto-approve all.`
                      : 'Field mappings require approval before building. Expand each table below to review, or auto-approve to accept all mappings as-is.'}
                  </span>
                  <button
                    className="btn-primary"
                    style={{ fontSize: '11px', padding: '5px 14px', flexShrink: 0 }}
                    onClick={() => setApprovedMappings(new Set(tablesWithMappings))}
                  >
                    Auto-Approve All
                  </button>
                </>
              ) : (
                <>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--accent-green)', flexShrink: 0 }} />
                  <span style={{ fontSize: '11px', color: 'var(--accent-green)', flex: 1 }}>
                    All {tablesWithMappings.length} table mapping(s) approved. You can still expand and edit individual mappings below.
                  </span>
                  <button
                    style={{
                      fontSize: '10px', padding: '3px 10px', borderRadius: 'var(--radius)',
                      border: '1px solid var(--border-color)', background: 'transparent',
                      color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'var(--font-mono)',
                    }}
                    onClick={() => setApprovedMappings(new Set())}
                  >
                    Reset All
                  </button>
                </>
              )}
            </div>
          )}

          {analyses.map((a) => (
            <div key={a.logType} style={{
              background: 'var(--bg-primary)', border: '1px solid var(--border-color)',
              borderRadius: '4px', padding: '12px', marginBottom: '8px',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <div style={{ fontWeight: 600, fontSize: '13px' }}>{a.logType}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{a.tableName}</div>
              </div>

              <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '11px', fontFamily: 'var(--font-mono)' }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)' }}>{a.sourceFieldCount}</div>
                  <div style={{ color: 'var(--text-muted)' }}>Source Fields<InfoTip text="Total unique fields discovered in your sample data for this table." /></div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)' }}>{a.destFieldCount}</div>
                  <div style={{ color: 'var(--text-muted)' }}>Dest Columns<InfoTip text="Total columns defined in the Sentinel destination table schema (e.g., CommonSecurityLog has 80+ columns)." /></div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--accent-green)' }}>{a.passthroughCount}</div>
                  <div style={{ color: 'var(--text-muted)' }}>Passthrough<InfoTip text="Fields that match both name and type exactly -- no transformation needed. These flow directly through the DCR." /></div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--accent-blue)' }}>{a.dcrHandledCount}</div>
                  <div style={{ color: 'var(--text-muted)' }}>DCR Handles<InfoTip text="Fields that the Azure Data Collection Rule transforms (renames or type coercions). These are handled server-side by Azure, not by Cribl." /></div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--accent-orange)' }}>{a.criblHandledCount}</div>
                  <div style={{ color: 'var(--text-muted)' }}>Cribl Handles<InfoTip text="Fields that require Cribl pipeline transformation -- renames or type coercions that the DCR does not cover. These are the fields the generated pack pipeline will process." /></div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '18px', fontWeight: 700, color: a.overflowCount > 0 ? 'var(--accent-red)' : 'var(--text-muted)' }}>{a.overflowCount}</div>
                  <div style={{ color: 'var(--text-muted)' }}>Overflow<InfoTip text="Source fields with no matching destination column. These are collected into an overflow field (e.g., AdditionalExtensions for CommonSecurityLog) as key=value pairs so no data is lost." /></div>
                </div>
              </div>

              {(a.dcrRenames.length > 0 || a.dcrCoercions.length > 0) && (
                <details style={{ marginTop: '8px', fontSize: '11px' }}>
                  <summary style={{ cursor: 'pointer', color: 'var(--accent-blue)' }}>
                    DCR handles: {a.dcrRenames.length} rename(s), {a.dcrCoercions.length} coercion(s)
                  </summary>
                  <div style={{ fontFamily: 'var(--font-mono)', padding: '4px 0', color: 'var(--text-secondary)' }}>
                    {a.dcrRenames.map((r, i) => <div key={'r' + i}>{r.source} -&gt; {r.dest}</div>)}
                    {a.dcrCoercions.map((c, i) => <div key={'c' + i}>{c.field} -&gt; {c.toType}</div>)}
                  </div>
                </details>
              )}

              {(a.criblRenames.length > 0 || a.criblCoercions.length > 0) && (
                <details style={{ marginTop: '4px', fontSize: '11px' }}>
                  <summary style={{ cursor: 'pointer', color: 'var(--accent-orange)' }}>
                    Cribl handles: {a.criblRenames.length} rename(s), {a.criblCoercions.length} coercion(s)
                  </summary>
                  <div style={{ fontFamily: 'var(--font-mono)', padding: '4px 0', color: 'var(--text-secondary)' }}>
                    {a.criblRenames.map((r, i) => <div key={'cr' + i}>{r.source} -&gt; {r.dest} ({r.reason})</div>)}
                    {a.criblCoercions.map((c, i) => <div key={'cc' + i}>{c.field}: {c.fromType} -&gt; {c.toType}</div>)}
                  </div>
                </details>
              )}

              {a.routeCondition !== 'true' && (
                <div style={{ marginTop: '4px', fontSize: '10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                  Route: {a.routeCondition.length > 80 ? a.routeCondition.substring(0, 80) + '...' : a.routeCondition}
                </div>
              )}

              {/* Full field mapping table */}
              {(() => {
                const rawMappings = mappingEdits[a.logType] || a.fieldMappings || [];
                if (rawMappings.length === 0) return null;
                const mappings = [...rawMappings].sort((x, y) => x.dest.localeCompare(y.dest));
                const destOptions = a.destSchema || [];
                // Fields referenced by analytics rules (for highlighting)
                const ruleFields = new Set((ruleCoverage?.summary.ruleReferencedFields || []).map((f) => f.toLowerCase()));
                const isRuleField = (name: string) => ruleFields.has(name.toLowerCase());
                // Dest schema fields with no corresponding source mapping
                const mappedDestFields = new Set(mappings.map((m) => m.dest.toLowerCase()));
                const unmappedDest = destOptions.filter((d) => !mappedDestFields.has(d.name.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name));
                const confidenceColor: Record<string, string> = {
                  exact: 'var(--accent-green)', alias: 'var(--accent-blue)',
                  fuzzy: 'var(--accent-orange)', unmatched: 'var(--accent-red)',
                };
                const actionColor: Record<string, string> = {
                  keep: 'var(--accent-green)', rename: 'var(--accent-blue)',
                  coerce: 'var(--accent-orange)', overflow: 'var(--accent-red)', drop: 'var(--text-muted)',
                };
                const updateMapping = (sourceFieldName: string, field: string, value: string) => {
                  const current = [...(mappingEdits[a.logType] || a.fieldMappings || [])];
                  const i = current.findIndex((m) => m.source === sourceFieldName);
                  if (i >= 0) {
                    current[i] = { ...current[i], [field]: value };
                    setMappingEdits((prev) => ({ ...prev, [a.logType]: current }));
                  }
                };

                return (
                  <details style={{ marginTop: '10px' }}>
                    <summary style={{ cursor: 'pointer', fontSize: '12px', fontWeight: 600, color: 'var(--accent-blue)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span>Field Mappings ({mappings.length} mapped{unmappedDest.length > 0 ? ', ' + unmappedDest.length + ' unmapped dest' : ''})</span>
                      {!approvedMappings.has(a.logType) && (
                        <span style={{
                          fontSize: '9px', padding: '2px 8px', borderRadius: '10px',
                          background: 'rgba(255, 167, 38, 0.15)', color: 'var(--accent-orange)',
                          border: '1px solid rgba(255, 167, 38, 0.3)', fontWeight: 700,
                        }}>Approval Required</span>
                      )}
                      {approvedMappings.has(a.logType) && (
                        <span style={{
                          fontSize: '9px', padding: '2px 8px', borderRadius: '10px',
                          background: 'rgba(102, 187, 106, 0.15)', color: 'var(--accent-green)',
                          border: '1px solid rgba(102, 187, 106, 0.3)',
                        }}>Approved</span>
                      )}
                    </summary>
                    <div style={{ marginTop: '8px', border: '1px solid var(--border-color)', borderRadius: '4px', overflow: 'auto', maxHeight: '400px' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px', fontFamily: 'var(--font-mono)' }}>
                        <thead>
                          <tr style={{ background: 'var(--bg-secondary)', position: 'sticky', top: 0, zIndex: 1 }}>
                            {([
                              { label: 'Source Field', tip: 'The field name as it appears in your sample data. Fields with a RULE badge are referenced by Sentinel analytics rules and should not be dropped.' },
                              { label: 'Type', tip: 'The data type detected from the sample values (string, int, real, boolean, dynamic).' },
                              { label: 'Dest Field', tip: 'The destination column in the Sentinel table schema. Change this dropdown to reassign where a source field maps to.' },
                              { label: 'Type', tip: 'The expected data type in the destination schema. If it differs from the source type, a type coercion is applied.' },
                              { label: 'Confidence', tip: 'How the match was determined:\n- exact: field names are identical\n- alias: matched via known alias (e.g., src -> SourceIP)\n- fuzzy: similar names (e.g., EventType -> DeviceEventClassID)\n- unmatched: no match found, collected into overflow' },
                              { label: 'Action', tip: 'What the Cribl pipeline will do with this field:\n- keep: pass through unchanged (name and type match)\n- rename: change field name to match destination\n- coerce: convert data type (e.g., string to int)\n- overflow: collect into overflow field (e.g., AdditionalExtensions)\n- drop: remove the field during cleanup' },
                            ] as Array<{ label: string; tip: string }>).map((h) => (
                              <th key={h.label + h.tip.slice(0, 10)} style={{ padding: '6px 8px', textAlign: 'left', borderBottom: '1px solid var(--border-color)', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)' }}>
                                <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                                  {h.label}<InfoTip text={h.tip} />
                                </span>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {mappings.map((m, i) => (
                            <tr key={m.source + i} style={{
                              borderBottom: '1px solid var(--border-color)',
                              background: isRuleField(m.dest) && (m.action === 'drop' || m.action === 'overflow')
                                ? 'rgba(239, 83, 80, 0.08)'
                                : m.action === 'overflow' ? 'rgba(239, 83, 80, 0.03)'
                                : m.action === 'drop' ? 'rgba(255, 255, 255, 0.02)' : 'transparent',
                            }}>
                              <td style={{ padding: '4px 8px', color: 'var(--text-primary)' }} title={m.description}>
                                {m.source}
                                {isRuleField(m.dest) && (
                                  <span title="Referenced by analytics rule(s)" style={{
                                    marginLeft: '4px', fontSize: '8px', padding: '0 4px', borderRadius: '3px',
                                    background: 'rgba(255, 167, 38, 0.15)', color: 'var(--accent-orange)',
                                    verticalAlign: 'middle',
                                  }}>RULE</span>
                                )}
                              </td>
                              <td style={{ padding: '4px 8px', color: 'var(--text-muted)' }}>{m.sourceType}</td>
                              <td style={{ padding: '4px 8px' }}>
                                <select
                                  style={{
                                    background: 'var(--bg-input)', border: '1px solid var(--border-color)',
                                    borderRadius: '3px', color: 'var(--text-primary)', fontSize: '11px',
                                    padding: '2px 4px', fontFamily: 'var(--font-mono)', maxWidth: '200px',
                                  }}
                                  value={m.dest}
                                  onChange={(e) => updateMapping(m.source, 'dest', e.target.value)}
                                >
                                  <option value={m.dest}>{m.dest}</option>
                                  {destOptions
                                    .filter((d) => d.name !== m.dest)
                                    .map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
                                </select>
                              </td>
                              <td style={{ padding: '4px 8px', color: 'var(--text-muted)' }}>{m.destType}</td>
                              <td style={{ padding: '4px 8px' }}>
                                <span style={{
                                  fontSize: '9px', padding: '1px 6px', borderRadius: '3px',
                                  background: `color-mix(in srgb, ${confidenceColor[m.confidence] || 'var(--text-muted)'} 15%, transparent)`,
                                  color: confidenceColor[m.confidence] || 'var(--text-muted)',
                                }}>{m.confidence}</span>
                              </td>
                              <td style={{ padding: '4px 8px' }}>
                                <select
                                  style={{
                                    background: 'var(--bg-input)', border: '1px solid var(--border-color)',
                                    borderRadius: '3px', fontSize: '11px', padding: '2px 4px',
                                    fontFamily: 'var(--font-mono)',
                                    color: actionColor[m.action] || 'var(--text-primary)',
                                  }}
                                  value={m.action}
                                  onChange={(e) => updateMapping(m.source, 'action', e.target.value)}
                                >
                                  {['keep', 'rename', 'coerce', 'overflow', 'drop'].map((act) => (
                                    <option key={act} value={act}>{act}</option>
                                  ))}
                                </select>
                              </td>
                            </tr>
                          ))}
                          {/* Unmapped destination schema fields */}
                          {unmappedDest.length > 0 && (
                            <tr>
                              <td colSpan={6} style={{
                                padding: '6px 8px', fontSize: '10px', fontWeight: 700,
                                color: 'var(--text-muted)', background: 'var(--bg-secondary)',
                                borderBottom: '1px solid var(--border-color)',
                              }}>
                                Unmapped Destination Fields ({unmappedDest.length})
                                <InfoTip text="These destination schema columns have no corresponding field in your sample data. They will be empty in Sentinel unless populated by a DCR transformation or added to your source data." />
                              </td>
                            </tr>
                          )}
                          {unmappedDest.map((d) => (
                            <tr key={'unmapped-' + d.name} style={{
                              borderBottom: '1px solid var(--border-color)',
                              background: isRuleField(d.name) ? 'rgba(239, 83, 80, 0.06)' : 'rgba(255, 255, 255, 0.01)',
                              opacity: isRuleField(d.name) ? 1 : 0.6,
                            }}>
                              <td style={{ padding: '4px 8px', color: 'var(--text-muted)', fontStyle: 'italic' }}>--</td>
                              <td style={{ padding: '4px 8px', color: 'var(--text-muted)' }}>--</td>
                              <td style={{ padding: '4px 8px', color: 'var(--text-muted)' }}>
                                {d.name}
                                {isRuleField(d.name) && (
                                  <span title="Referenced by analytics rule(s) -- this field is needed for detection" style={{
                                    marginLeft: '4px', fontSize: '8px', padding: '0 4px', borderRadius: '3px',
                                    background: 'rgba(239, 83, 80, 0.15)', color: 'var(--accent-red)',
                                    verticalAlign: 'middle',
                                  }}>RULE</span>
                                )}
                              </td>
                              <td style={{ padding: '4px 8px', color: 'var(--text-muted)' }}>{d.type}</td>
                              <td style={{ padding: '4px 8px' }}>
                                <span style={{
                                  fontSize: '9px', padding: '1px 6px', borderRadius: '3px',
                                  background: 'rgba(255, 255, 255, 0.05)', color: 'var(--text-muted)',
                                }}>none</span>
                              </td>
                              <td style={{ padding: '4px 8px', color: 'var(--text-muted)', fontStyle: 'italic', fontSize: '10px' }}>no source</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                      {!approvedMappings.has(a.logType) ? (
                        <button
                          className="btn-primary"
                          style={{ fontSize: '11px', padding: '6px 16px' }}
                          onClick={() => setApprovedMappings((prev) => new Set([...prev, a.logType]))}
                        >
                          Approve {a.logType}
                        </button>
                      ) : (
                        <span style={{ fontSize: '11px', color: 'var(--accent-green)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--accent-green)', display: 'inline-block' }} />
                          Approved
                        </span>
                      )}
                      {mappingEdits[a.logType] && (
                        <span style={{ fontSize: '10px', color: 'var(--accent-orange)' }}>
                          Modified -- changes will be applied when you build the pack
                        </span>
                      )}
                    </div>
                  </details>
                );
              })()}
            </div>
          ))}
        </div>
      )}

      {/* Analytics Rule Coverage */}
      {ruleCoverage && (
        <div style={{ ...s.section, borderLeft: '3px solid var(--accent-orange)' }}>
          <div style={s.sectionTitle}>
            <span style={s.sectionNum}>
              {ruleCoverage.summary.totalRules === 0 ? '--' : ruleCoverage.summary.fullyCovered === ruleCoverage.summary.totalRules ? '\u2713' : '!'}
            </span>
            Analytics Rule Coverage
            <InfoTip text="Checks which fields referenced by the solution's Sentinel analytics (detection) rules are present in your sample data. Missing fields may cause detection rules to fail in production. Rules are parsed from the YAML files in the solution's Analytic Rules directory." />
          </div>
          <div style={s.sectionDesc}>
            {ruleCoverage.summary.totalRules === 0
              ? 'No analytics rules found in the Sentinel repository for this solution. You can upload custom rules below to validate field coverage.'
              : ruleCoverage.summary.fullyCovered === ruleCoverage.summary.totalRules
                ? 'All analytics rules have the fields they need from your sample data.'
                : `${ruleCoverage.summary.missingFieldsAcrossRules.length} field(s) referenced by detection rules are not present in your sample data. Missing fields may prevent rules from firing.`}
          </div>

          {/* Summary bar */}
          {ruleCoverage.summary.totalRules > 0 && (
          <div style={{
            display: 'flex', gap: '16px', fontSize: '11px', fontFamily: 'var(--font-mono)',
            marginBottom: '12px', padding: '8px 12px', background: 'var(--bg-primary)', borderRadius: '4px',
          }}>
            <span style={{ color: 'var(--accent-green)' }}>{ruleCoverage.summary.fullyCovered} fully covered</span>
            {ruleCoverage.summary.partiallyCovered > 0 && (
              <span style={{ color: 'var(--accent-orange)' }}>{ruleCoverage.summary.partiallyCovered} partial</span>
            )}
            {ruleCoverage.summary.totalRules - ruleCoverage.summary.fullyCovered - ruleCoverage.summary.partiallyCovered > 0 && (
              <span style={{ color: 'var(--accent-red)' }}>{ruleCoverage.summary.totalRules - ruleCoverage.summary.fullyCovered - ruleCoverage.summary.partiallyCovered} no coverage</span>
            )}
            <span style={{ color: 'var(--text-muted)' }}>{ruleCoverage.summary.totalRules} total rule{ruleCoverage.summary.totalRules !== 1 ? 's' : ''}</span>
          </div>
          )}

          {/* Custom rule upload */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px',
            padding: '8px 12px', background: 'var(--bg-primary)', borderRadius: '4px',
            border: '1px solid var(--border-color)',
          }}>
            <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Custom Rules:</span>
            <label style={{
              fontSize: '11px', padding: '4px 12px', borderRadius: 'var(--radius)',
              border: '1px solid var(--border-color)', background: 'var(--bg-secondary)',
              color: 'var(--accent-blue)', cursor: 'pointer', fontFamily: 'var(--font-mono)',
            }}>
              Upload YAML
              <input
                type="file"
                accept=".yaml,.yml"
                multiple
                style={{ display: 'none' }}
                onChange={async (e) => {
                  const files = e.target.files;
                  if (!files || files.length === 0 || !window.api) return;
                  const yamlContents: Array<{ fileName: string; content: string }> = [];
                  for (const file of Array.from(files)) {
                    const text = await file.text();
                    yamlContents.push({ fileName: file.name, content: text });
                  }
                  const result = await window.api.packBuilder.parseRuleYaml(yamlContents);
                  if (result.success && result.rules.length > 0) {
                    const merged = [...customRules];
                    for (const rule of result.rules) {
                      if (!merged.some((r) => r.name === rule.name)) merged.push(rule);
                    }
                    setCustomRules(merged);
                    // Re-run coverage with new custom rules
                    const mappedDest = [...new Set(
                      analyses.flatMap((a) => (a.fieldMappings || []).flatMap((m) => {
                        if (m.action === 'drop') return [];
                        if (m.action === 'overflow') return [m.dest, m.source];
                        return [m.dest];
                      }))
                    )];
                    if (mappedDest.length > 0) {
                      const allDestTables = [...new Set(analyses.map((a) => a.tableName))];
                      const coverage = await window.api.packBuilder.ruleCoverage(
                        state.selectedSolution, mappedDest, undefined, merged,
                        undefined, allDestTables,
                      );
                      setRuleCoverage(coverage);
                    }
                  }
                  e.target.value = '';
                }}
              />
            </label>
            <InfoTip text="Upload custom Sentinel analytics rule YAML files to include in the coverage analysis. These are merged with the rules from the Sentinel GitHub repository. Useful for organization-specific detection rules not in the public repo." />
            {customRules.length > 0 && (
              <>
                <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                  {customRules.length} custom rule{customRules.length !== 1 ? 's' : ''}
                </span>
                <button
                  style={{
                    fontSize: '10px', padding: '2px 8px', borderRadius: '3px',
                    border: '1px solid rgba(239, 83, 80, 0.3)', background: 'transparent',
                    color: 'var(--accent-red)', cursor: 'pointer', fontFamily: 'var(--font-mono)',
                  }}
                  onClick={async () => {
                    setCustomRules([]);
                    // Re-run coverage without custom rules
                    if (window.api && analyses.length > 0) {
                      const mappedDest = [...new Set(
                        analyses.flatMap((a) => (a.fieldMappings || []).flatMap((m) => {
                          if (m.action === 'drop') return [];
                          if (m.action === 'overflow') return [m.dest, m.source];
                          return [m.dest];
                        }))
                      )];
                      if (mappedDest.length > 0) {
                        const allDestTables = [...new Set(analyses.map((a) => a.tableName))];
                        const coverage = await window.api.packBuilder.ruleCoverage(
                          state.selectedSolution, mappedDest, undefined, undefined,
                          undefined, allDestTables,
                        );
                        setRuleCoverage(coverage);
                      }
                    }
                  }}
                >
                  Clear
                </button>
              </>
            )}
          </div>

          {/* Per-rule details */}
          {ruleCoverage.rules.map((rule) => (
            <details key={rule.name} style={{ marginBottom: '4px', fontSize: '11px' }}>
              <summary style={{
                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px',
                padding: '4px 0', color: rule.coverage === 1 ? 'var(--text-secondary)' : 'var(--text-primary)',
              }}>
                <span style={{
                  fontSize: '9px', padding: '1px 6px', borderRadius: '3px', fontWeight: 700,
                  background: rule.severity === 'High' ? 'rgba(239, 83, 80, 0.15)' :
                    rule.severity === 'Medium' ? 'rgba(255, 167, 38, 0.15)' :
                    rule.severity === 'Low' ? 'rgba(79, 195, 247, 0.15)' : 'rgba(255,255,255,0.05)',
                  color: rule.severity === 'High' ? 'var(--accent-red)' :
                    rule.severity === 'Medium' ? 'var(--accent-orange)' :
                    rule.severity === 'Low' ? 'var(--accent-blue)' : 'var(--text-muted)',
                }}>{rule.severity}</span>
                <span style={{ flex: 1 }}>
                  {rule.name}
                  {rule.custom && (
                    <span style={{
                      marginLeft: '6px', fontSize: '8px', padding: '1px 5px', borderRadius: '3px',
                      background: 'rgba(171, 71, 188, 0.15)', color: 'var(--accent-purple, #AB47BC)',
                      verticalAlign: 'middle',
                    }}>CUSTOM</span>
                  )}
                </span>
                <span style={{
                  fontFamily: 'var(--font-mono)', fontSize: '10px',
                  color: rule.coverage === 1 ? 'var(--accent-green)' : rule.coverage > 0.5 ? 'var(--accent-orange)' : 'var(--accent-red)',
                }}>{Math.round(rule.coverage * 100)}%</span>
                {rule.missingFields.length > 0 && (
                  <span style={{ fontSize: '10px', color: 'var(--accent-red)' }}>
                    {rule.missingFields.length} missing
                  </span>
                )}
              </summary>
              <div style={{ paddingLeft: '16px', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                {rule.coveredFields.length > 0 && (
                  <div style={{ color: 'var(--accent-green)', marginBottom: '2px' }}>
                    Covered: {rule.coveredFields.join(', ')}
                  </div>
                )}
                {rule.missingFields.length > 0 && (
                  <div style={{ color: 'var(--accent-red)' }}>
                    Missing: {rule.missingFields.join(', ')}
                  </div>
                )}
                {rule.query && (
                  <details style={{ marginTop: '6px' }}>
                    <summary style={{ cursor: 'pointer', color: 'var(--accent-blue)', fontSize: '10px' }}>View KQL Query</summary>
                    <pre style={{
                      marginTop: '4px', padding: '8px', background: 'var(--bg-secondary)',
                      border: '1px solid var(--border-color)', borderRadius: '4px',
                      fontSize: '10px', lineHeight: 1.4, color: 'var(--text-secondary)',
                      whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '200px', overflow: 'auto',
                    }}>{rule.query}</pre>
                  </details>
                )}
              </div>
            </details>
          ))}

          {/* Aggregated missing fields */}
          {ruleCoverage.summary.missingFieldsAcrossRules.length > 0 && (
            <div style={{
              marginTop: '10px', padding: '8px 12px', borderRadius: '4px',
              background: 'rgba(239, 83, 80, 0.05)', border: '1px solid rgba(239, 83, 80, 0.2)',
              fontSize: '11px',
            }}>
              <div style={{ fontWeight: 700, color: 'var(--accent-red)', marginBottom: '4px' }}>
                Fields missing across rules (prioritized by frequency):
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                {ruleCoverage.summary.missingFieldsAcrossRules.map((f) => (
                  <span key={f} style={{
                    display: 'inline-block', padding: '1px 8px', margin: '2px 4px 2px 0',
                    borderRadius: '3px', background: 'rgba(239, 83, 80, 0.1)',
                    border: '1px solid rgba(239, 83, 80, 0.2)', color: 'var(--accent-red)',
                  }}>{f}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Section 3: Azure Resources */}
      <div style={s.section}>
        <div style={s.sectionTitle}>
          <span style={sectionDone(3) ? s.sectionNumDone : s.sectionNum}>3</span>
          Azure Resources
          <InfoTip text="Configure the target Azure Log Analytics workspace where Data Collection Rules (DCRs) will be deployed. In connected mode, select from live subscriptions and workspaces. In offline mode, enter the workspace details manually -- they will be embedded in exported ARM templates." />
        </div>
        <div style={s.sectionDesc}>
          {hasAzure ? (
            <span>Select the Azure subscription and Log Analytics workspace for DCR deployment</span>
          ) : integrationMode === 'cribl-only' ? (
            <span>Enter target Azure workspace details for ARM template generation (deployed manually)</span>
          ) : (
            <span>Enter target Azure workspace details for offline artifact generation</span>
          )}
        </div>

        {hasAzure ? (
          <>
            <div style={s.row}>
              <div style={s.field}>
                <div style={s.label}>Subscription</div>
                <select style={s.select} value={state.subscription}
                  onChange={(e) => update({ subscription: e.target.value, workspace: '', resourceGroup: '', location: '' })}
                  disabled={!azureConnected}>
                  <option value="">-- Select subscription --</option>
                  {subscriptions.map((sub) => (
                    <option key={sub.id} value={sub.id}>{sub.name}</option>
                  ))}
                </select>
              </div>
              <div style={s.field}>
                <div style={s.label}>Log Analytics Workspace</div>
                <select style={s.select} value={state.workspace}
                  onChange={(e) => {
                    const ws = workspaces.find((w) => w.name === e.target.value);
                    update({
                      workspace: e.target.value,
                      // Default resource group to workspace's RG, but user can change it below
                      resourceGroup: state.resourceGroup || ws?.resourceGroup || '',
                      location: state.location || ws?.location || '',
                    });
                  }}
                  disabled={!state.subscription}>
                  <option value="">-- Select workspace --</option>
                  {[...workspaces].sort((a, b) => a.name.localeCompare(b.name)).map((ws) => (
                    <option key={ws.name} value={ws.name}>
                      {ws.name} ({ws.resourceGroup} / {ws.location})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {state.subscription && (
              <div>
                <div style={s.row}>
                  <div style={s.field}>
                    <div style={s.label}>
                      DCR Resource Group
                      <InfoTip text="The resource group where Data Collection Rules and DCEs will be deployed. Defaults to the workspace's resource group but can be changed. You can also create a new resource group." />
                    </div>
                    <select style={s.select} value={newRgName ? '' : state.resourceGroup}
                      onChange={(e) => {
                        const rg = resourceGroups.find((r) => r.name === e.target.value);
                        update({ resourceGroup: e.target.value, location: rg?.location || state.location });
                        setNewRgName('');
                      }}
                      disabled={!!newRgName}>
                      <option value="">-- Select resource group --</option>
                      {[...resourceGroups].sort((a, b) => a.name.localeCompare(b.name)).map((rg) => (
                        <option key={rg.name} value={rg.name}>
                          {rg.name} ({rg.location})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', padding: '20px 8px 0', color: 'var(--text-muted)', fontSize: '11px' }}>or</div>
                  <div style={s.field}>
                    <div style={s.label}>Create New Resource Group</div>
                    <input style={s.input} value={newRgName}
                      onChange={(e) => {
                        const name = e.target.value.replace(/[^a-zA-Z0-9_\-().]/g, '');
                        setNewRgName(name);
                        if (name) update({ resourceGroup: name });
                      }}
                      placeholder="e.g., rg-cribl-dcr-prod"
                      disabled={!!(state.resourceGroup && !newRgName && resourceGroups.some((r) => r.name === state.resourceGroup))} />
                  </div>
                  <div style={s.field}>
                    <div style={s.label}>Location</div>
                    <input style={s.input} value={state.location}
                      onChange={(e) => update({ location: e.target.value })}
                      readOnly={!newRgName}
                      placeholder="e.g., eastus"
                      title={newRgName ? 'Enter the Azure region for the new resource group' : 'Derived from the selected resource group'} />
                  </div>
                </div>
                {newRgName && (
                  <div style={{ fontSize: '10px', color: 'var(--accent-blue)', marginTop: '-4px', marginBottom: '4px' }}>
                    New resource group "{newRgName}" will be created during deployment in {state.location || '(select a location)'}.
                  </div>
                )}
              </div>
            )}

            {/* Azure Permission Check */}
            {state.workspace && (
              <div style={{
                marginTop: '12px', padding: '12px 14px', borderRadius: '4px',
                background: azurePermissions.checking ? 'rgba(79, 195, 247, 0.05)' :
                  azurePermissions.canDeploy ? 'rgba(102, 187, 106, 0.05)' :
                  azurePermissions.checked ? 'rgba(239, 83, 80, 0.05)' : 'transparent',
                border: `1px solid ${azurePermissions.checking ? 'rgba(79, 195, 247, 0.2)' :
                  azurePermissions.canDeploy ? 'rgba(102, 187, 106, 0.2)' :
                  azurePermissions.checked ? 'rgba(239, 83, 80, 0.2)' : 'var(--border-color)'}`,
              }}>
                <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {azurePermissions.checking && (
                    <div style={{
                      width: '12px', height: '12px', borderRadius: '50%',
                      border: '2px solid rgba(79, 195, 247, 0.3)', borderTopColor: 'var(--accent-blue)',
                      animation: 'repoSpin 1s linear infinite', flexShrink: 0,
                    }} />
                  )}
                  {azurePermissions.checking ? 'Checking Azure permissions...' :
                    azurePermissions.canDeploy ? 'Azure permissions verified' :
                    azurePermissions.checked ? 'Insufficient Azure permissions' : ''}
                  {azurePermissions.roles.length > 0 && (
                    <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '11px' }}>
                      ({azurePermissions.roles.join(', ')})
                    </span>
                  )}
                </div>

                {azurePermissions.checked && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', fontSize: '11px' }}>
                    {[
                      { label: 'Resource Group', ok: azurePermissions.canWriteResourceGroup },
                      { label: 'Workspace', ok: azurePermissions.canReadWorkspace },
                      { label: 'Create DCRs', ok: azurePermissions.canCreateDcr },
                      { label: 'Create Tables', ok: azurePermissions.canCreateTable },
                      { label: 'Create DCEs', ok: azurePermissions.canCreateDce },
                    ].map((perm) => (
                      <div key={perm.label} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <div style={{
                          width: '7px', height: '7px', borderRadius: '50%', flexShrink: 0,
                          background: perm.ok ? 'var(--accent-green)' : 'var(--accent-red)',
                        }} />
                        <span style={{ color: perm.ok ? 'var(--text-secondary)' : 'var(--accent-red)' }}>{perm.label}</span>
                      </div>
                    ))}
                  </div>
                )}

                {azurePermissions.checked && !azurePermissions.canDeploy && (
                  <div style={{
                    marginTop: '10px', padding: '8px 12px', borderRadius: '4px',
                    background: 'rgba(255, 167, 38, 0.08)', border: '1px solid rgba(255, 167, 38, 0.2)',
                    fontSize: '11px', color: 'var(--text-secondary)', lineHeight: 1.5,
                  }}>
                    <span style={{ fontWeight: 700, color: 'var(--accent-orange)' }}>Action required: </span>
                    You need <strong>Contributor</strong> or <strong>Owner</strong> role on the resource group.
                    Activate the role via PIM (Privileged Identity Management) or sign in with a different account.
                    <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                      <button
                        className="btn-secondary"
                        style={{ fontSize: '10px', padding: '4px 12px' }}
                        onClick={async () => {
                          if (!window.api) return;
                          setAzurePermissions((p) => ({ ...p, checking: true, checked: false }));
                          try {
                            const report = await window.api.permissions.check(state.workerGroups[0]);
                            const az = report.azure;
                            const roles = az.permissions.filter((p: any) => p.resource === 'RBAC Role' && p.granted).map((p: any) => p.detail);
                            const azCanDeploy = az.loggedIn && az.canCreateDcr && az.canReadWorkspace && az.canWriteResourceGroup;
                            setAzurePermissions({
                              checked: true, checking: false,
                              canCreateDcr: az.canCreateDcr, canCreateDce: az.canCreateDce,
                              canCreateTable: az.canCreateTable, canWriteResourceGroup: az.canWriteResourceGroup,
                              canReadWorkspace: az.canReadWorkspace, canDeploy: azCanDeploy,
                              roles, error: az.error,
                            });
                          } catch { setAzurePermissions((p) => ({ ...p, checking: false, checked: true })); }
                        }}
                      >
                        Retry Check
                      </button>
                      <button
                        className="btn-secondary"
                        style={{ fontSize: '10px', padding: '4px 12px' }}
                        onClick={async () => {
                          if (!window.api) return;
                          try {
                            await window.api.auth.azureLogin();
                            const auth = await window.api.auth.status();
                            setAzureConnected(auth.azure.loggedIn);
                          } catch { /* skip */ }
                        }}
                      >
                        Switch Account
                      </button>
                    </div>
                  </div>
                )}

                {azurePermissions.error && (
                  <div style={{ marginTop: '6px', fontSize: '10px', color: 'var(--accent-red)' }}>
                    {azurePermissions.error}
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '12px', padding: '8px 12px', background: 'rgba(171, 71, 188, 0.08)', borderRadius: '4px', border: '1px solid rgba(171, 71, 188, 0.2)' }}>
              Azure not connected. Enter the target workspace details below -- they will be embedded in the exported ARM templates for manual deployment.
              These fields are optional; leave blank to generate generic templates.
            </div>
            <div style={s.row}>
              <div style={s.field}>
                <div style={s.label}>Workspace Name</div>
                <input style={s.input} value={state.workspace}
                  onChange={(e) => update({ workspace: e.target.value })}
                  placeholder="e.g., my-sentinel-workspace" />
              </div>
              <div style={s.field}>
                <div style={s.label}>Resource Group</div>
                <input style={s.input} value={state.resourceGroup}
                  onChange={(e) => update({ resourceGroup: e.target.value })}
                  placeholder="e.g., rg-sentinel-prod" />
              </div>
            </div>
            <div style={s.row}>
              <div style={s.field}>
                <div style={s.label}>Location</div>
                <input style={s.input} value={state.location}
                  onChange={(e) => update({ location: e.target.value })}
                  placeholder="e.g., eastus" />
              </div>
              <div style={s.field}>
                <div style={s.label}>Subscription ID</div>
                <input style={s.input} value={state.subscription}
                  onChange={(e) => update({ subscription: e.target.value })}
                  placeholder="e.g., 00000000-0000-0000-0000-000000000000" />
              </div>
            </div>
          </>
        )}

        {hasAzure && (
          <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <label style={s.toggle}>
              <input type="checkbox" checked={state.enableDce}
                onChange={(e) => update({ enableDce: e.target.checked })} />
              <span>Create Data Collection Endpoint (DCE) for private endpoint connectivity</span>
              <InfoTip text="Enable this if your environment uses Azure Private Link / AMPLS. A Data Collection Endpoint (DCE) is created alongside each DCR, allowing ingestion traffic to route through your private network instead of the public internet. Required for private endpoint scenarios." />
            </label>
            <label style={s.toggle}>
              <input type="checkbox" checked={state.enableDcrMetrics}
                onChange={(e) => update({ enableDcrMetrics: e.target.checked })} />
              Enable DCR metrics (allows querying ingestion volume and errors in Log Analytics)
            </label>
            <label style={s.toggle}>
              <input type="checkbox" checked={state.assignDcrPermissions}
                onChange={(e) => update({ assignDcrPermissions: e.target.checked })} />
              <span>Assign Monitoring Metrics Publisher role to Cribl service principal on each DCR</span>
              <InfoTip text="Assigns the least-privilege 'Monitoring Metrics Publisher' role to your Cribl app's service principal on each deployed DCR. This is the minimum permission required for Cribl to send data to the DCR. Requires the Enterprise Application Object ID (found in Azure AD > Enterprise Applications > your app > Object ID). This is NOT the App Registration Client ID." />
            </label>
            {state.assignDcrPermissions && (
              <div style={{ marginTop: '4px', marginLeft: '24px' }}>
                <div style={s.label}>Enterprise Application Object ID</div>
                <input style={{ ...s.input, maxWidth: '400px' }} value={state.enterpriseAppObjectId}
                  onChange={(e) => update({ enterpriseAppObjectId: e.target.value.trim() })}
                  placeholder="00000000-0000-0000-0000-000000000000" />
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>
                  Azure AD &gt; Enterprise Applications &gt; your Cribl app &gt; Object ID (not the Client ID)
                </div>
              </div>
            )}
          </div>
        )}

        {/* Azure Resource Preview */}
        {resourcePreview && resourcePreview.resources.length > 0 && (
          <div style={{ marginTop: '16px' }}>
            <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '8px', color: 'var(--text-secondary)' }}>
              Azure Resources ({resourcePreview.resources.length})
            </div>
            <div style={{ border: '1px solid var(--border-color)', borderRadius: '4px', overflow: 'hidden' }}>
              {resourcePreview.resources.map((res, i) => {
                const isExpanded = expandedResource === `${res.type}:${res.name}`;
                const icon = res.type.includes('dataCollectionRules') ? 'DCR' :
                             res.type.includes('tables') ? 'TBL' : 'RES';
                return (
                  <div key={i}>
                    <div
                      style={{
                        display: 'flex', alignItems: 'center', gap: '8px',
                        padding: '8px 12px', fontSize: '11px',
                        borderBottom: '1px solid var(--border-color)',
                        cursor: res.armTemplate ? 'pointer' : 'default',
                        background: isExpanded ? 'rgba(79, 195, 247, 0.05)' : 'transparent',
                      }}
                      onClick={() => res.armTemplate && setExpandedResource(isExpanded ? null : `${res.type}:${res.name}`)}
                    >
                      <span style={{
                        fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '3px',
                        background: icon === 'DCR' ? 'rgba(79, 195, 247, 0.15)' : 'rgba(102, 187, 106, 0.15)',
                        color: icon === 'DCR' ? 'var(--accent-blue)' : 'var(--accent-green)',
                      }}>{icon}</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{res.name}</div>
                        <div style={{ color: 'var(--text-muted)', fontSize: '10px' }}>{res.type} ({res.table})</div>
                      </div>
                      <div style={{
                        fontSize: '10px', padding: '2px 8px', borderRadius: '10px',
                        background: res.exists ? 'rgba(102, 187, 106, 0.15)' : 'rgba(255, 167, 38, 0.15)',
                        color: res.exists ? 'var(--accent-green)' : 'var(--accent-orange)',
                      }}>
                        {res.exists ? 'Exists' : 'Will Create'}
                      </div>
                      {res.armTemplate && (
                        <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                          {isExpanded ? 'Hide' : 'View'} JSON
                        </span>
                      )}
                    </div>
                    {isExpanded && res.armTemplate && (
                      <div style={{
                        maxHeight: '300px', overflow: 'auto', padding: '10px',
                        background: 'var(--bg-input)', borderBottom: '1px solid var(--border-color)',
                      }}>
                        <pre style={{
                          margin: 0, fontSize: '10px', fontFamily: 'var(--font-mono)',
                          lineHeight: 1.4, color: 'var(--text-secondary)',
                          whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                        }}>
                          {JSON.stringify(res.armTemplate, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Section 4: Cribl Configuration */}
      <div style={s.section}>
        <div style={s.sectionTitle}>
          <span style={sectionDone(4) ? s.sectionNumDone : s.sectionNum}>4</span>
          Cribl Configuration
          <InfoTip text="Select which Cribl worker group(s) will receive the pack and name the pack. In connected mode, the pack is uploaded directly. In offline mode, a .crbl file is exported for manual import into Cribl Stream via Packs > Import." />
        </div>
        <div style={s.sectionDesc}>
          {hasCribl ? (
            <>
              Select the Cribl worker group and pack name for deployment
              {!criblConnected && <span style={{ color: 'var(--accent-red)' }}> -- Connect to Cribl first</span>}
            </>
          ) : (
            <span>Enter a name for the Cribl pack. The pack will be exported as a .crbl file.</span>
          )}
        </div>

        <div style={s.row}>
          {hasCribl && (
            <div style={s.field}>
              <div style={s.label}>Worker Groups</div>
              <div style={{
                border: '1px solid var(--border-color)', borderRadius: '4px',
                background: 'var(--bg-input)', maxHeight: '140px', overflow: 'auto', padding: '4px 0',
              }}>
                {workerGroups.length === 0 && (
                  <div style={{ padding: '8px 10px', fontSize: '12px', color: 'var(--text-muted)' }}>
                    {criblConnected ? 'No worker groups found' : 'Connect to Cribl first'}
                  </div>
                )}
                {workerGroups.map((g) => (
                  <label key={g.id} style={{
                    display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 10px',
                    fontSize: '12px', cursor: criblConnected ? 'pointer' : 'default',
                    color: 'var(--text-primary)',
                  }}>
                    <input
                      type="checkbox"
                      checked={state.workerGroups.includes(g.id)}
                      disabled={!criblConnected}
                      onChange={(e) => {
                        const selected = e.target.checked
                          ? [...state.workerGroups, g.id]
                          : state.workerGroups.filter((id) => id !== g.id);
                        update({ workerGroups: selected });
                      }}
                    />
                    {g.name} ({g.workerCount} workers)
                  </label>
                ))}
              </div>
              {state.workerGroups.length > 0 && (
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
                  {state.workerGroups.length} group{state.workerGroups.length !== 1 ? 's' : ''} selected
                </div>
              )}
            </div>
          )}
          <div style={s.field}>
            <div style={s.label}>Pack Name</div>
            <input style={s.input} value={state.packName}
              onChange={(e) => update({ packName: e.target.value })}
              placeholder="e.g., paloalto-sentinel" />
          </div>
        </div>
      </div>

      {/* Section 5: Deploy */}
      <div style={{ ...s.section, borderTop: '3px solid var(--accent-green)' }}>
        <div style={s.sectionTitle}>
          <span style={state.deployComplete ? s.sectionNumDone : s.sectionNum}>5</span>
          Deploy
          <InfoTip text="Executes the full build and deployment pipeline:\n1. Vendor research and table discovery\n2. DCR deployment to Azure (connected mode)\n3. Pack scaffold with pipelines, routes, destinations, lookups\n4. Package as .crbl archive\n5. Upload to Cribl worker groups (connected mode)\n6. Export artifacts to Downloads (offline mode)\n\nAll steps are logged below. Re-run any time to rebuild." />
        </div>
        <div style={s.sectionDesc}>
          {integrationMode === 'full' ? 'Deploy DCRs, build the Cribl pack, and upload to selected worker group(s).' :
           integrationMode === 'air-gapped' ? 'Build the Cribl pack and export all deployment artifacts for manual deployment.' :
           hasAzure ? 'Deploy DCRs to Azure and export the Cribl pack as a .crbl file.' :
           'Build and upload the Cribl pack. ARM templates will be exported for manual Azure deployment.'}
          {' '}Each step runs independently -- re-run any step if needed.
        </div>

        {/* Deploy steps summary */}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
          {[
            { label: 'Solution', done: !!state.selectedSolution, show: true },
            { label: 'Samples', done: state.samples.length > 0, show: true },
            { label: 'Mappings', done: allMappingsReviewed, show: hasMappings },
            { label: 'Workspace', done: !!state.workspace, show: hasAzure },
            { label: 'Worker Groups', done: state.workerGroups.length > 0, show: hasCribl },
            { label: 'Pack Name', done: !!state.packName, show: true },
          ].filter((step) => step.show).map((step) => (
            <span key={step.label} style={{
              fontSize: '11px', padding: '3px 10px', borderRadius: '10px',
              background: step.done ? 'rgba(102, 187, 106, 0.15)' : 'rgba(255, 255, 255, 0.05)',
              color: step.done ? 'var(--accent-green)' : 'var(--text-muted)',
              border: '1px solid ' + (step.done ? 'rgba(102, 187, 106, 0.3)' : 'var(--border-color)'),
            }}>
              {step.done ? '\u2713 ' : ''}{step.label}
            </span>
          ))}
        </div>

        {/* Analysis summary */}
        {analyses.length > 0 && (
          <div style={{
            fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '12px',
            padding: '8px 12px', background: 'rgba(79, 195, 247, 0.08)', borderRadius: '4px',
            fontFamily: 'var(--font-mono)',
          }}>
            {analyses.map((a) => (
              <div key={a.logType}>
                {a.logType} ({a.tableName}): {a.passthroughCount} passthrough, {a.dcrHandledCount} DCR, {a.criblHandledCount} Cribl
                {a.overflowCount > 0 ? ', ' + a.overflowCount + ' overflow' : ''}
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button
            className={canDeploy ? 'btn-success' : 'btn-secondary'}
            style={s.deployBtn}
            onClick={handleDeploy}
            disabled={!canDeploy}
          >
            {state.deploying ? (integrationMode === 'air-gapped' ? 'Building...' : 'Deploying...') :
             integrationMode === 'air-gapped' ? 'Build & Export' :
             integrationMode === 'full' ? 'Deploy All' : 'Deploy & Export'}
          </button>

          {!canDeploy && (
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              {!state.selectedSolution ? 'Select a solution' :
               hasAzure && !state.workspace ? 'Select a workspace' :
               !state.packName ? 'Enter a pack name' :
               hasCribl && state.workerGroups.length === 0 ? 'Select worker group(s)' :
               hasMappings && !allMappingsReviewed ? `Approve field mappings (${approvedMappings.size}/${tablesWithMappings.length} tables approved)` : ''}
            </div>
          )}
        </div>

        {state.deployLog.length > 0 && (
          <div style={s.deployLog}>
            {state.deployLog.map((line, i) => (
              <div key={i} style={s.deployItem(
                line.startsWith('  ') || line.includes('complete') || line.includes('OK') || line.includes('Ready')
              )}>
                {line}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Section 6: Source Wiring (appears after deploy) */}
      {state.deployComplete && criblConnected && (
        <div style={{ ...s.section, borderTop: '3px solid var(--accent-blue)' }}>
          <div style={s.sectionTitle}>
            <span style={state.wiringComplete ? s.sectionNumDone : s.sectionNum}>6</span>
            Source Wiring
          </div>
          <div style={s.sectionDesc}>
            Connect a Cribl source to the deployed pack. This creates a route from the source through the pack pipeline to the Sentinel destination.
          </div>

          <div style={s.row}>
            <div style={s.field}>
              <div style={s.label}>Source</div>
              <select
                style={s.select}
                value={state.selectedSource}
                onChange={(e) => update({ selectedSource: e.target.value })}
                disabled={state.wiring || state.wiringComplete}
              >
                <option value="">{wiringSources.length === 0 ? '-- Loading sources... --' : '-- Select a source --'}</option>
                {wiringSources.map((src) => (
                  <option key={src.id} value={src.id}>{src.id} ({src.type})</option>
                ))}
              </select>
            </div>
            <div style={s.field}>
              <div style={s.label}>Worker Group</div>
              <div style={{ fontSize: '12px', padding: '8px 0', color: 'var(--text-secondary)' }}>
                {state.workerGroups[0] || 'None selected'}
              </div>
            </div>
          </div>

          {/* Cribl Lake federation toggle (Cloud only -- Lake is not available on self-managed) */}
          {criblDeploymentType === 'cloud' && (
          <div style={{ marginTop: '12px', marginBottom: '12px' }}>
            <label style={s.toggle}>
              <input
                type="checkbox"
                checked={state.enableLakeFederation}
                onChange={(e) => update({ enableLakeFederation: e.target.checked })}
                disabled={state.wiring || state.wiringComplete}
              />
              <span>Send full fidelity copy to Cribl Lake (no transformation)</span>
            </label>
            {state.enableLakeFederation && (
              <div style={{ marginTop: '8px' }}>
                <div style={s.row}>
                  <div style={s.field}>
                    <div style={s.label}>Existing Dataset</div>
                    <select
                      style={s.select}
                      value={state.selectedDataset}
                      onChange={(e) => { update({ selectedDataset: e.target.value }); setNewDatasetName(''); }}
                      disabled={state.wiring || state.wiringComplete || !!newDatasetName}
                    >
                      <option value="">
                        {lakeDatasets.length === 0 ? '-- No datasets found --' : '-- Select existing dataset --'}
                      </option>
                      {lakeDatasets.map((ds) => (
                        <option key={ds.id} value={ds.id}>{ds.name || ds.id}</option>
                      ))}
                    </select>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', padding: '20px 8px 0', color: 'var(--text-muted)', fontSize: '11px' }}>or</div>
                  <div style={s.field}>
                    <div style={s.label}>Create New Dataset</div>
                    <input
                      style={s.input}
                      value={newDatasetName}
                      onChange={(e) => {
                        const name = e.target.value.replace(/[^a-zA-Z0-9_-]/g, '_');
                        setNewDatasetName(name);
                        if (name) update({ selectedDataset: '' });
                      }}
                      placeholder={`e.g., ${state.packName || 'vendor'}-raw`}
                      disabled={state.wiring || state.wiringComplete || !!state.selectedDataset}
                    />
                  </div>
                </div>
                {lakeDatasets.length === 0 && !newDatasetName && (
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
                    No existing Lake datasets found. Enter a name to create one.
                  </div>
                )}
              </div>
            )}
          </div>
          )}

          {/* Wire + Commit button */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <button
              className={state.selectedSource && !state.wiringComplete ? 'btn-success' : 'btn-secondary'}
              style={s.deployBtn}
              onClick={handleWireSource}
              disabled={!state.selectedSource || state.wiring || state.wiringComplete}
            >
              {state.wiring ? 'Wiring...' : state.wiringComplete ? 'Wired' : 'Wire Source & Commit'}
            </button>
            {!state.selectedSource && !state.wiringComplete && (
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Select a source to continue</div>
            )}
            {state.wiringComplete && (
              <div style={{ fontSize: '11px', color: 'var(--accent-green)' }}>
                Routes created, configuration committed and deployed.
              </div>
            )}
          </div>

          {/* Wiring log */}
          {state.wiringLog.length > 0 && (
            <div style={s.deployLog}>
              {state.wiringLog.map((line, i) => (
                <div key={i} style={s.deployItem(
                  line.startsWith('  ') || line.includes('OK') || line.includes('Committed') || line.includes('Deployed') || line.includes('complete')
                )}>
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Section 7: Data Flow Validation (appears after source wiring) */}
      {state.wiringComplete && criblConnected && (
        <div style={{ ...s.section, borderTop: '3px solid var(--accent-purple)' }}>
          <div style={s.sectionTitle}>
            <span style={s.sectionNum}>7</span>
            Data Flow Validation
          </div>
          <div style={s.sectionDesc}>
            Capture live events from the wired source through the pack pipeline to Sentinel. Verify data flows end-to-end.
          </div>
          <DataFlowView
            workerGroup={state.workerGroups[0] || ''}
            sourceId={state.selectedSource}
            packPipeline={state.packName ? `${state.packName}:main` : undefined}
            destTable={analyses.length > 0 ? analyses[0].tableName : undefined}
            criblConnected={criblConnected}
            azureConnected={azureConnected}
          />
        </div>
      )}
    </div>
  );
}

export default SentinelIntegration;
