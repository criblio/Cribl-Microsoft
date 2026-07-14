import { useState, useRef, useEffect } from 'react';
import { usePowerShell } from '../hooks/usePowerShell';

const UNIFIED_SCRIPT = 'Azure/Labs/UnifiedLab/Run-AzureUnifiedLab.ps1';

// ---------------------------------------------------------------------------
// Lab & Parameter Definitions
// ---------------------------------------------------------------------------

interface LabDef {
  id: string;
  name: string;
  description: string;
  components: string[];
  estTime: string;
  cost: string;
  costWarn?: string;
  mode: string;
  steps: StepId[];
  category: 'sentinel' | 'analytics' | 'storage' | 'infrastructure' | 'quickstart';
}

type StepId = 'identity' | 'naming' | 'ttl' | 'monitoring' | 'infrastructure' | 'storage' | 'analytics' | 'review';

interface ParamField {
  key: string;
  label: string;
  type: 'text' | 'select' | 'number' | 'toggle' | 'password';
  required: boolean;
  default: string | number | boolean;
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  hint?: string;
  group: StepId;
}

const AZURE_LOCATIONS = [
  { value: 'eastus', label: 'East US' }, { value: 'eastus2', label: 'East US 2' },
  { value: 'westus', label: 'West US' }, { value: 'westus2', label: 'West US 2' },
  { value: 'westus3', label: 'West US 3' }, { value: 'centralus', label: 'Central US' },
  { value: 'northcentralus', label: 'North Central US' }, { value: 'southcentralus', label: 'South Central US' },
  { value: 'westeurope', label: 'West Europe' }, { value: 'northeurope', label: 'North Europe' },
  { value: 'uksouth', label: 'UK South' }, { value: 'ukwest', label: 'UK West' },
  { value: 'australiaeast', label: 'Australia East' }, { value: 'japaneast', label: 'Japan East' },
  { value: 'southeastasia', label: 'Southeast Asia' }, { value: 'canadacentral', label: 'Canada Central' },
  { value: 'swedencentral', label: 'Sweden Central' },
];

const ALL_PARAMS: ParamField[] = [
  // Identity
  { key: 'baseName', label: 'Base Name', type: 'text', required: true, default: '', placeholder: 'e.g., jpederson', hint: 'Used as prefix for all resource names', group: 'identity' },
  { key: 'ownerEmail', label: 'Owner Email', type: 'text', required: false, default: '', placeholder: 'you@company.com', hint: 'Tagged on resources for ownership tracking', group: 'identity' },
  // Naming & Location
  { key: 'location', label: 'Azure Region', type: 'select', required: true, default: 'eastus', options: AZURE_LOCATIONS, group: 'naming' },
  { key: 'labMode', label: 'Network Mode', type: 'select', required: true, default: 'public', options: [{ value: 'public', label: 'Public (default endpoints)' }, { value: 'private', label: 'Private (private endpoints)' }], group: 'naming' },
  // TTL
  { key: 'ttlEnabled', label: 'Enable TTL Auto-Cleanup', type: 'toggle', required: false, default: true, hint: 'Automatically tag resources with expiration time', group: 'ttl' },
  { key: 'ttlHours', label: 'TTL Duration (hours)', type: 'number', required: false, default: 72, hint: 'Resources tagged for cleanup after this duration', group: 'ttl' },
  { key: 'ttlWarningHours', label: 'Warning Before Expiry (hours)', type: 'number', required: false, default: 24, group: 'ttl' },
  // Monitoring
  { key: 'lawRetention', label: 'Log Analytics Retention (days)', type: 'number', required: false, default: 90, hint: 'How long to retain log data (30-730 days)', group: 'monitoring' },
  { key: 'lawDailyQuota', label: 'Daily Ingestion Quota (GB)', type: 'number', required: false, default: -1, hint: '-1 for unlimited', group: 'monitoring' },
  { key: 'sentinelEnabled', label: 'Enable Microsoft Sentinel', type: 'toggle', required: false, default: true, group: 'monitoring' },
  { key: 'connAzureActivity', label: 'Azure Activity Connector', type: 'toggle', required: false, default: true, group: 'monitoring' },
  { key: 'connSecurityEvents', label: 'Security Events Connector', type: 'toggle', required: false, default: true, group: 'monitoring' },
  // Infrastructure
  { key: 'vnetCidr', label: 'VNet Address Space', type: 'text', required: false, default: '10.198.30.0/24', placeholder: '10.198.30.0/24', group: 'infrastructure' },
  { key: 'vpnEnabled', label: 'Deploy VPN Gateway', type: 'toggle', required: false, default: false, hint: 'Adds ~30 min and ~$30/mo', group: 'infrastructure' },
  { key: 'vpnSku', label: 'VPN Gateway SKU', type: 'select', required: false, default: 'Basic', options: [{ value: 'Basic', label: 'Basic (~$30/mo)' }, { value: 'VpnGw1', label: 'VpnGw1 (~$140/mo)' }], group: 'infrastructure' },
  { key: 'deployVMs', label: 'Deploy Test VMs', type: 'toggle', required: false, default: false, hint: 'Ubuntu VMs for traffic generation', group: 'infrastructure' },
  { key: 'vmSize', label: 'VM Size', type: 'select', required: false, default: 'Standard_B1s', options: [{ value: 'Standard_B1ls', label: 'Standard_B1ls (~$0.13/day)' }, { value: 'Standard_B1s', label: 'Standard_B1s (~$0.25/day)' }, { value: 'Standard_B2s', label: 'Standard_B2s (~$1/day)' }], group: 'infrastructure' },
  { key: 'vmPassword', label: 'VM Admin Password', type: 'password', required: false, default: '', placeholder: 'Min 12 chars, upper+lower+number+special', group: 'infrastructure' },
  // Storage
  { key: 'storageSku', label: 'Storage Account SKU', type: 'select', required: false, default: 'Standard_LRS', options: [{ value: 'Standard_LRS', label: 'Standard LRS (cheapest)' }, { value: 'Standard_GRS', label: 'Standard GRS (geo-redundant)' }, { value: 'Premium_LRS', label: 'Premium LRS (SSD)' }], group: 'storage' },
  { key: 'storageTier', label: 'Access Tier', type: 'select', required: false, default: 'Hot', options: [{ value: 'Hot', label: 'Hot' }, { value: 'Cool', label: 'Cool' }], group: 'storage' },
  { key: 'deployQueues', label: 'Deploy Storage Queues', type: 'toggle', required: false, default: true, hint: 'For Event Grid blob notifications', group: 'storage' },
  { key: 'deployEventGrid', label: 'Deploy Event Grid', type: 'toggle', required: false, default: true, hint: 'Blob creation event subscriptions', group: 'storage' },
  { key: 'generateSampleData', label: 'Generate Sample Data', type: 'toggle', required: false, default: false, hint: 'Pre-populate blob containers with test data', group: 'storage' },
  // Analytics
  { key: 'adxSku', label: 'ADX Cluster SKU', type: 'select', required: false, default: 'Dev(No SLA)_Standard_E2a_v4', options: [{ value: 'Dev(No SLA)_Standard_E2a_v4', label: 'Dev (No SLA) ~$8/day' }, { value: 'Standard_E2a_v4', label: 'Standard E2a_v4 ~$24/day' }], group: 'analytics' },
  { key: 'adxAutoStop', label: 'ADX Auto-Stop', type: 'toggle', required: false, default: true, hint: 'Stop cluster when idle to save costs', group: 'analytics' },
  { key: 'adxHotCache', label: 'ADX Hot Cache (days)', type: 'number', required: false, default: 7, group: 'analytics' },
  { key: 'ehSku', label: 'Event Hub SKU', type: 'select', required: false, default: 'Standard', options: [{ value: 'Basic', label: 'Basic' }, { value: 'Standard', label: 'Standard' }], group: 'analytics' },
  { key: 'ehCapacity', label: 'Event Hub Throughput Units', type: 'number', required: false, default: 1, group: 'analytics' },
];

const STEP_META: Record<StepId, { title: string; description: string }> = {
  identity: { title: 'Identity', description: 'Set the base name used for all resource naming and ownership.' },
  naming: { title: 'Location & Mode', description: 'Select the Azure region and network mode for the deployment.' },
  ttl: { title: 'Time to Live', description: 'Configure auto-cleanup to avoid unexpected charges.' },
  monitoring: { title: 'Monitoring', description: 'Log Analytics workspace and Sentinel configuration.' },
  infrastructure: { title: 'Infrastructure', description: 'Virtual network, VPN gateway, and compute options.' },
  storage: { title: 'Storage', description: 'Storage account, containers, queues, and Event Grid.' },
  analytics: { title: 'Analytics', description: 'Azure Data Explorer and Event Hub configuration.' },
  review: { title: 'Review & Deploy', description: 'Review your configuration and start the deployment.' },
};

const LABS: LabDef[] = [
  {
    id: 'quickstart', name: 'Sentinel Quick Start',
    description: 'Creates a resource group, Log Analytics workspace, and enables Microsoft Sentinel.',
    components: ['Resource Group', 'Log Analytics', 'Sentinel'],
    estTime: '~2 min', cost: 'Free (ingestion-based)', mode: 'quickstart', category: 'quickstart',
    steps: ['identity', 'naming', 'review'],
  },
  {
    id: 'sentinel', name: 'Sentinel Lab',
    description: 'Log Analytics workspace with Sentinel, data connectors, and diagnostic settings.',
    components: ['Resource Group', 'Log Analytics', 'Sentinel', 'Data Connectors'],
    estTime: '~5 min', cost: 'Free (ingestion-based)', mode: 'Monitoring', category: 'sentinel',
    steps: ['identity', 'naming', 'ttl', 'monitoring', 'review'],
  },
  {
    id: 'complete', name: 'Complete Lab',
    description: 'Full environment with all components: networking, storage, monitoring, analytics.',
    components: ['Resource Group', 'VNet', 'NSGs', 'Storage', 'Log Analytics', 'Sentinel', 'Event Hub', 'ADX'],
    estTime: '~45 min', cost: '~$280/mo', costWarn: 'Includes ADX (~$8/day) and VPN (~$30/mo)', mode: 'Full', category: 'infrastructure',
    steps: ['identity', 'naming', 'ttl', 'monitoring', 'infrastructure', 'storage', 'analytics', 'review'],
  },
  {
    id: 'flowlog', name: 'Flow Log Lab',
    description: 'Virtual network with subnets, NSGs, storage, and vNet flow logs.',
    components: ['Resource Group', 'Storage', 'VNet', 'NSGs', 'Flow Logs'],
    estTime: '~10 min', cost: 'Minimal', mode: 'Infrastructure', category: 'infrastructure',
    steps: ['identity', 'naming', 'ttl', 'infrastructure', 'storage', 'review'],
  },
  {
    id: 'adx', name: 'ADX Analytics Lab',
    description: 'Event Hub namespace and Azure Data Explorer cluster for real-time analytics.',
    components: ['Resource Group', 'Event Hub', 'ADX Cluster'],
    estTime: '~15 min', cost: '~$8/day', costWarn: 'ADX Dev SKU runs ~$8/day. Stop when not in use.', mode: 'Analytics', category: 'analytics',
    steps: ['identity', 'naming', 'ttl', 'analytics', 'review'],
  },
  {
    id: 'eventhub', name: 'Event Hub Lab',
    description: 'Event Hub namespace with configurable hubs for log streaming.',
    components: ['Resource Group', 'Event Hub Namespace', 'Event Hubs'],
    estTime: '~5 min', cost: 'Minimal', mode: 'Analytics', category: 'analytics',
    steps: ['identity', 'naming', 'ttl', 'analytics', 'review'],
  },
  {
    id: 'blobqueue', name: 'Blob & Queue Lab',
    description: 'Storage account with containers, queues, and Event Grid subscriptions.',
    components: ['Resource Group', 'Storage', 'Containers', 'Queues', 'Event Grid'],
    estTime: '~5 min', cost: 'Minimal', mode: 'Storage', category: 'storage',
    steps: ['identity', 'naming', 'ttl', 'storage', 'review'],
  },
  {
    id: 'blobcollector', name: 'Blob Collector Lab',
    description: 'Minimal storage with blob containers for Cribl collection testing.',
    components: ['Resource Group', 'Storage', 'Containers'],
    estTime: '~3 min', cost: 'Minimal', mode: 'Storage', category: 'storage',
    steps: ['identity', 'naming', 'ttl', 'storage', 'review'],
  },
  {
    id: 'basic', name: 'Basic Infrastructure',
    description: 'Virtual network, subnets, NSGs, and optional VPN gateway.',
    components: ['Resource Group', 'VNet', 'NSGs', 'VPN Gateway'],
    estTime: '~35 min', cost: '~$30/mo', costWarn: 'VPN Gateway runs ~$30/mo.', mode: 'Infrastructure', category: 'infrastructure',
    steps: ['identity', 'naming', 'ttl', 'infrastructure', 'review'],
  },
];

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const s = {
  page: { maxWidth: '1100px', padding: '24px', paddingBottom: '40px' } as React.CSSProperties,
  title: { fontSize: '20px', fontWeight: 700, marginBottom: '4px' } as React.CSSProperties,
  subtitle: { fontSize: '12px', color: 'var(--text-muted)', marginBottom: '24px' } as React.CSSProperties,
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(310px, 1fr))', gap: '12px', marginBottom: '20px' } as React.CSSProperties,
  card: (sel: boolean) => ({
    padding: '16px', borderRadius: '8px', cursor: 'pointer',
    background: sel ? 'rgba(79, 195, 247, 0.06)' : 'var(--bg-secondary)',
    border: `1px solid ${sel ? 'var(--accent-blue)' : 'var(--border-color)'}`,
    transition: 'border-color 0.15s',
  } as React.CSSProperties),
  cardName: { fontSize: '14px', fontWeight: 700, marginBottom: '4px' } as React.CSSProperties,
  cardDesc: { fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px', lineHeight: 1.4 } as React.CSSProperties,
  badges: { display: 'flex', flexWrap: 'wrap' as const, gap: '4px', marginBottom: '8px' } as React.CSSProperties,
  badge: { fontSize: '9px', padding: '1px 6px', borderRadius: '3px', background: 'rgba(79,195,247,0.1)', color: 'var(--accent-blue)', border: '1px solid rgba(79,195,247,0.2)', fontWeight: 600 } as React.CSSProperties,
  cardMeta: { display: 'flex', gap: '12px', fontSize: '10px', color: 'var(--text-muted)' } as React.CSSProperties,
  costWarn: { fontSize: '10px', color: 'var(--accent-orange)', marginTop: '4px' } as React.CSSProperties,
  wizard: { background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '24px', marginBottom: '20px' } as React.CSSProperties,
  stepBar: { display: 'flex', gap: '4px', marginBottom: '20px' } as React.CSSProperties,
  stepDot: (active: boolean, done: boolean) => ({
    flex: 1, height: '4px', borderRadius: '2px',
    background: active ? 'var(--accent-blue)' : done ? 'var(--accent-green)' : 'var(--border-color)',
  } as React.CSSProperties),
  stepTitle: { fontSize: '15px', fontWeight: 700, marginBottom: '4px' } as React.CSSProperties,
  stepDesc: { fontSize: '11px', color: 'var(--text-muted)', marginBottom: '16px' } as React.CSSProperties,
  fieldRow: { display: 'flex', gap: '12px', marginBottom: '12px', flexWrap: 'wrap' as const } as React.CSSProperties,
  field: { display: 'flex', flexDirection: 'column' as const, gap: '4px', flex: 1, minWidth: '200px' } as React.CSSProperties,
  label: { fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 } as React.CSSProperties,
  required: { color: 'var(--accent-red)', marginLeft: '2px' } as React.CSSProperties,
  input: { padding: '8px 12px', fontSize: '12px', background: 'var(--bg-input)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' } as React.CSSProperties,
  select: { padding: '8px 12px', fontSize: '12px', background: 'var(--bg-input)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)' } as React.CSSProperties,
  hint: { fontSize: '10px', color: 'var(--text-muted)', marginTop: '-2px' } as React.CSSProperties,
  historyDrop: { position: 'absolute' as const, top: '100%', left: 0, right: 0, zIndex: 10, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '4px', boxShadow: '0 4px 12px rgba(0,0,0,0.3)', maxHeight: '120px', overflow: 'auto' } as React.CSSProperties,
  historyItem: { padding: '4px 10px', fontSize: '11px', cursor: 'pointer', fontFamily: 'var(--font-mono)' } as React.CSSProperties,
  nav: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '16px', borderTop: '1px solid var(--border-color)' } as React.CSSProperties,
  terminal: { marginTop: '12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', padding: '12px', fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-secondary)', maxHeight: '300px', overflow: 'auto', whiteSpace: 'pre-wrap' as const } as React.CSSProperties,
  reviewRow: { display: 'flex', gap: '8px', padding: '3px 0', fontSize: '11px' } as React.CSSProperties,
  reviewLabel: { fontWeight: 600, color: 'var(--text-secondary)', minWidth: '180px' } as React.CSSProperties,
  reviewVal: { color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' } as React.CSSProperties,
};

// ---------------------------------------------------------------------------
// History-aware Input Component
// ---------------------------------------------------------------------------

function HistoryInput({ value, onChange, history, placeholder, disabled, type }: {
  value: string; onChange: (v: string) => void; history: string[];
  placeholder?: string; disabled?: boolean; type?: string;
}) {
  const [open, setOpen] = useState(false);
  const filtered = history.filter((h) => h && h !== value);
  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: '0' }}>
        <input
          style={{ ...s.input, flex: 1, borderRadius: filtered.length > 0 ? '4px 0 0 4px' : '4px' }}
          value={value} onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder} disabled={disabled} type={type || 'text'}
          onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        />
        {filtered.length > 0 && (
          <button style={{
            padding: '0 8px', background: 'var(--bg-input)', border: '1px solid var(--border-color)',
            borderLeft: 'none', borderRadius: '0 4px 4px 0', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '10px',
          }} onClick={() => setOpen(!open)} tabIndex={-1}>
            {open ? '^' : 'v'}
          </button>
        )}
      </div>
      {open && filtered.length > 0 && (
        <div style={s.historyDrop}>
          <div style={{ padding: '4px 10px', fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600 }}>Recent</div>
          {filtered.slice(0, 5).map((h) => (
            <div key={h} style={s.historyItem}
              onMouseDown={(e) => { e.preventDefault(); onChange(h); setOpen(false); }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-input)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
              {h}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

function LabAutomation() {
  const [selectedLab, setSelectedLab] = useState<string | null>(null);
  const [wizardStep, setWizardStep] = useState(0);
  const [values, setValues] = useState<Record<string, string | number | boolean>>({});
  const [history, setHistory] = useState<Record<string, string[]>>({});
  const [deploying, setDeploying] = useState(false);
  const [deployLog, setDeployLog] = useState<string[]>([]);
  const [deployStatus, setDeployStatus] = useState<'idle' | 'running' | 'success' | 'error'>('idle');
  const [subscriptions, setSubscriptions] = useState<Array<{ id: string; name: string }>>([]);
  const termRef = useRef<HTMLDivElement>(null);
  const { isRunning, execute, cancel } = usePowerShell();

  const lab = LABS.find((l) => l.id === selectedLab);
  const steps = lab?.steps || [];
  const currentStep = steps[wizardStep] || 'review';
  const stepMeta = STEP_META[currentStep];

  // Load history and subscriptions on mount
  useEffect(() => {
    if (!window.api) return;
    window.api.config.read('lab-field-history.json').then((data: any) => {
      if (data && typeof data === 'object') setHistory(data);
    }).catch(() => {});
    window.api.auth.azureSubscriptions().then((r: any) => {
      if (r.success) setSubscriptions(r.subscriptions);
    }).catch(() => {});
    // Also load current subscription
    window.api.auth.azureStatus().then((auth: any) => {
      if (auth.loggedIn && auth.subscriptionId) {
        setVal('subscription', auth.subscriptionId);
      }
    }).catch(() => {});
  }, []);

  // Auto-scroll terminal
  useEffect(() => {
    if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight;
  }, [deployLog]);

  // Initialize defaults when lab is selected
  useEffect(() => {
    if (!lab) return;
    const defaults: Record<string, string | number | boolean> = {};
    for (const p of ALL_PARAMS) {
      if (lab.steps.includes(p.group)) {
        defaults[p.key] = p.default;
      }
    }
    setValues((prev) => ({ ...defaults, ...prev }));
    setWizardStep(0);
    setDeployLog([]);
    setDeployStatus('idle');
  }, [selectedLab]);

  const setVal = (key: string, val: string | number | boolean) => setValues((prev) => ({ ...prev, [key]: val }));
  const getVal = (key: string) => values[key] ?? '';
  const addLog = (msg: string) => setDeployLog((prev) => [...prev, msg]);

  // Save history on deploy
  const saveHistory = () => {
    if (!window.api) return;
    const updated = { ...history };
    for (const [key, val] of Object.entries(values)) {
      if (typeof val === 'string' && val.trim()) {
        const list = updated[key] || [];
        const filtered = list.filter((v) => v !== val);
        updated[key] = [val, ...filtered].slice(0, 5);
      }
    }
    setHistory(updated);
    window.api.config.write('lab-field-history.json', updated).catch(() => {});
  };

  // Get fields for current step
  const stepFields = ALL_PARAMS.filter((p) => p.group === currentStep);

  // Computed resource names for review
  const baseName = String(getVal('baseName') || 'mylab');
  const loc = String(getVal('location') || 'eastus');
  const labSuffix = lab ? lab.id.charAt(0).toUpperCase() + lab.id.slice(1) + 'Lab' : 'Lab';
  const rgName = `rg-${baseName}-${labSuffix}`;
  const wsName = `law-${baseName}-${loc}`;

  // Can advance to next step?
  const canAdvance = stepFields.filter((f) => f.required).every((f) => {
    const v = getVal(f.key);
    return v !== '' && v !== undefined;
  });

  // Deploy: Sentinel Quick Start
  const deployQuickStart = async () => {
    if (!window.api) return;
    setDeploying(true); setDeployStatus('running'); setDeployLog([]);
    saveHistory();
    try {
      addLog(`Creating resource group: ${rgName} (${loc})...`);
      const rgResult = await window.api.auth.azureCreateResourceGroup(rgName, loc, String(getVal('subscription')));
      if (!rgResult.success) { addLog(`  ERROR: ${rgResult.error}`); setDeployStatus('error'); setDeploying(false); return; }
      addLog('  Resource group created');

      addLog(`Creating workspace: ${wsName}...`);
      const wsResult = await window.api.auth.azureCreateWorkspace(wsName, rgName, loc, String(getVal('subscription')));
      if (!wsResult.success) { addLog(`  ERROR: ${wsResult.error}`); setDeployStatus('error'); setDeploying(false); return; }
      addLog(`  Workspace created (CustomerId: ${wsResult.customerId || 'pending'})`);

      addLog('Enabling Microsoft Sentinel...');
      const sentResult = await window.api.auth.azureEnableSentinel(wsName, rgName, String(getVal('subscription')));
      addLog(sentResult.success ? (sentResult.alreadyEnabled ? '  Already enabled' : '  Sentinel enabled') : `  Failed: ${sentResult.error} (non-fatal)`);

      addLog(''); addLog('Sentinel Quick Start complete.');
      addLog(`  Resource Group: ${rgName}`); addLog(`  Workspace: ${wsName}`); addLog(`  Location: ${loc}`);
      setDeployStatus('success');
    } catch (err) { addLog(`ERROR: ${err instanceof Error ? err.message : String(err)}`); setDeployStatus('error'); }
    setDeploying(false);
  };

  // Deploy: PowerShell lab
  const deployPsLab = () => {
    if (!lab) return;
    setDeployLog([]); setDeployStatus('running');
    saveHistory();
    // TODO: Write values to azure-parameters.json before running script
    execute(UNIFIED_SCRIPT, ['-NonInteractive', '-Mode', lab.mode]);
  };

  const handleDeploy = () => {
    if (!lab) return;
    lab.mode === 'quickstart' ? deployQuickStart() : deployPsLab();
  };

  return (
    <div style={s.page}>
      <div style={s.title}>Lab Environments</div>
      <div style={s.subtitle}>
        Deploy pre-configured Azure lab environments for testing Cribl Stream integrations.
      </div>

      {/* Lab Cards */}
      <div style={s.grid}>
        {LABS.map((l) => (
          <div key={l.id} style={s.card(selectedLab === l.id)}
            onClick={() => setSelectedLab(selectedLab === l.id ? null : l.id)}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <div style={s.cardName}>{l.name}</div>
              {l.category === 'quickstart' && (
                <span style={{ fontSize: '9px', padding: '1px 6px', borderRadius: '3px', background: 'rgba(102,187,106,0.12)', color: 'var(--accent-green)', border: '1px solid rgba(102,187,106,0.25)', fontWeight: 700 }}>
                  NEW
                </span>
              )}
            </div>
            <div style={s.cardDesc}>{l.description}</div>
            <div style={s.badges}>
              {l.components.map((c) => <span key={c} style={s.badge}>{c}</span>)}
            </div>
            <div style={s.cardMeta}>
              <span>{l.estTime}</span>
              <span>Cost: {l.cost}</span>
            </div>
            {l.costWarn && <div style={s.costWarn}>{l.costWarn}</div>}
          </div>
        ))}
      </div>

      {/* Wizard */}
      {lab && (
        <div style={s.wizard}>
          {/* Step progress bar */}
          <div style={s.stepBar}>
            {steps.map((st, i) => (
              <div key={st} style={s.stepDot(i === wizardStep, i < wizardStep)} />
            ))}
          </div>

          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px' }}>
            Step {wizardStep + 1} of {steps.length} -- {lab.name}
          </div>
          <div style={s.stepTitle}>{stepMeta.title}</div>
          <div style={s.stepDesc}>{stepMeta.description}</div>

          {/* Step content */}
          {currentStep === 'identity' && (
            <>
              <div style={s.fieldRow}>
                <div style={s.field}>
                  <span style={s.label}>Azure Subscription<span style={s.required}>*</span></span>
                  <select style={s.select} value={String(getVal('subscription') || '')}
                    onChange={(e) => setVal('subscription', e.target.value)}>
                    <option value="">-- Select subscription --</option>
                    {subscriptions.map((sub) => (
                      <option key={sub.id} value={sub.id}>{sub.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              {stepFields.map((f) => (
                <div key={f.key} style={s.fieldRow}>
                  <div style={s.field}>
                    <span style={s.label}>{f.label}{f.required && <span style={s.required}>*</span>}</span>
                    <HistoryInput value={String(getVal(f.key) || '')} onChange={(v) => setVal(f.key, v)}
                      history={history[f.key] || []} placeholder={f.placeholder} disabled={deploying} />
                    {f.hint && <span style={s.hint}>{f.hint}</span>}
                  </div>
                </div>
              ))}
              {getVal('baseName') && (
                <div style={{ fontSize: '11px', color: 'var(--accent-blue)', padding: '8px 12px', borderRadius: '4px', background: 'rgba(79,195,247,0.06)', border: '1px solid rgba(79,195,247,0.15)', marginTop: '8px' }}>
                  Resource Group: <strong>{rgName}</strong> | Workspace: <strong>{wsName}</strong>
                </div>
              )}
            </>
          )}

          {currentStep === 'review' && (
            <div>
              <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '8px', color: 'var(--text-secondary)' }}>Configuration Summary</div>
              <div style={{ background: 'var(--bg-primary)', padding: '12px', borderRadius: '4px', border: '1px solid var(--border-color)' }}>
                <div style={s.reviewRow}><span style={s.reviewLabel}>Lab Type</span><span style={s.reviewVal}>{lab.name}</span></div>
                <div style={s.reviewRow}><span style={s.reviewLabel}>Resource Group</span><span style={s.reviewVal}>{rgName}</span></div>
                {(lab.steps.includes('monitoring') || lab.mode === 'quickstart') && (
                  <div style={s.reviewRow}><span style={s.reviewLabel}>Workspace</span><span style={s.reviewVal}>{wsName}</span></div>
                )}
                <div style={s.reviewRow}><span style={s.reviewLabel}>Location</span><span style={s.reviewVal}>{loc}</span></div>
                {Object.entries(values).filter(([k]) => k !== 'baseName' && k !== 'location' && k !== 'subscription').map(([k, v]) => {
                  const param = ALL_PARAMS.find((p) => p.key === k);
                  if (!param || !lab.steps.includes(param.group)) return null;
                  return (
                    <div key={k} style={s.reviewRow}>
                      <span style={s.reviewLabel}>{param.label}</span>
                      <span style={s.reviewVal}>{String(v)}</span>
                    </div>
                  );
                })}
              </div>
              {lab.costWarn && (
                <div style={{ ...s.costWarn, marginTop: '8px', padding: '6px 12px', borderRadius: '4px', background: 'rgba(255,167,38,0.06)', border: '1px solid rgba(255,167,38,0.15)' }}>
                  Cost: {lab.costWarn}
                </div>
              )}
            </div>
          )}

          {/* Generic step fields (not identity/review) */}
          {currentStep !== 'identity' && currentStep !== 'review' && (
            <>
              {stepFields.map((f) => (
                <div key={f.key} style={s.fieldRow}>
                  <div style={s.field}>
                    <span style={s.label}>{f.label}{f.required && <span style={s.required}>*</span>}</span>
                    {f.type === 'text' && (
                      <HistoryInput value={String(getVal(f.key) || '')} onChange={(v) => setVal(f.key, v)}
                        history={history[f.key] || []} placeholder={f.placeholder} disabled={deploying} />
                    )}
                    {f.type === 'password' && (
                      <input style={s.input} type="password" value={String(getVal(f.key) || '')}
                        onChange={(e) => setVal(f.key, e.target.value)} placeholder={f.placeholder} disabled={deploying} />
                    )}
                    {f.type === 'number' && (
                      <input style={s.input} type="number" value={String(getVal(f.key) ?? f.default)}
                        onChange={(e) => setVal(f.key, parseInt(e.target.value, 10) || 0)} disabled={deploying} />
                    )}
                    {f.type === 'select' && (
                      <select style={s.select} value={String(getVal(f.key) ?? f.default)}
                        onChange={(e) => setVal(f.key, e.target.value)} disabled={deploying}>
                        {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    )}
                    {f.type === 'toggle' && (
                      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '12px' }}>
                        <input type="checkbox" checked={!!getVal(f.key)} onChange={(e) => setVal(f.key, e.target.checked)} disabled={deploying} />
                        <span style={{ color: 'var(--text-secondary)' }}>{getVal(f.key) ? 'Enabled' : 'Disabled'}</span>
                      </label>
                    )}
                    {f.hint && <span style={s.hint}>{f.hint}</span>}
                  </div>
                </div>
              ))}
            </>
          )}

          {/* Navigation */}
          <div style={s.nav}>
            <button className="btn-secondary" style={{ fontSize: '12px', padding: '6px 16px', visibility: wizardStep === 0 ? 'hidden' : 'visible' }}
              onClick={() => setWizardStep(Math.max(0, wizardStep - 1))} disabled={deploying}>
              Back
            </button>
            <div style={{ display: 'flex', gap: '8px' }}>
              {currentStep === 'review' ? (
                <>
                  <button className="btn-success" style={{ fontSize: '12px', padding: '8px 24px', fontWeight: 700 }}
                    onClick={handleDeploy} disabled={deploying || isRunning}>
                    {deploying || isRunning ? 'Deploying...' : `Deploy ${lab.name}`}
                  </button>
                  {(deploying || isRunning) && (
                    <button className="btn-danger" style={{ fontSize: '12px', padding: '6px 16px' }}
                      onClick={() => { cancel(); setDeploying(false); setDeployStatus('error'); }}>Cancel</button>
                  )}
                </>
              ) : (
                <button className="btn-primary" style={{ fontSize: '12px', padding: '6px 20px' }}
                  onClick={() => setWizardStep(Math.min(steps.length - 1, wizardStep + 1))}
                  disabled={!canAdvance}>
                  Next
                </button>
              )}
            </div>
          </div>

          {/* Terminal output */}
          {deployLog.length > 0 && (
            <div ref={termRef} style={s.terminal}>
              {deployLog.map((line, i) => (
                <div key={i} style={{
                  color: line.startsWith('ERROR') || line.includes('ERROR:')
                    ? 'var(--accent-red)' : line.startsWith('  ') ? 'var(--text-muted)' : 'var(--text-primary)',
                }}>{line}</div>
              ))}
              {deployStatus === 'success' && (
                <div style={{ color: 'var(--accent-green)', marginTop: '8px', fontWeight: 700 }}>Deployment complete.</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default LabAutomation;
