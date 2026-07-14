import { useState } from 'react';
import { usePowerShell } from '../hooks/usePowerShell';
import ConfigEditor from '../components/ConfigEditor';
import StatusBadge from '../components/StatusBadge';

const EVENTHUB_SCRIPT = 'Azure/dev/EventHubDiscovery/Discover-EventHubSources.ps1';
const EVENTHUB_CONFIG = 'Azure/dev/EventHubDiscovery/prod/azure-parameters.json';

const VNET_SCRIPT = 'Azure/dev/vNetFlowLogDiscovery/Run-vNetFlowLogDiscovery.ps1';
const VNET_CONFIG = 'Azure/dev/vNetFlowLogDiscovery/azure-parameters.json';

const eventHubModes = [
  { value: 'DiscoverAll', label: 'Discover All Event Hubs' },
  { value: 'DiscoverByNamespace', label: 'Discover by Namespace' },
  { value: 'DiscoverByResourceGroup', label: 'Discover by Resource Group' },
  { value: 'ExportConfig', label: 'Export Configuration' },
  { value: 'ValidateConfig', label: 'Validate Configuration' },
  { value: 'Status', label: 'Show Status' },
];

const styles = {
  page: {
    maxWidth: '900px',
  } as React.CSSProperties,
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '24px',
  } as React.CSSProperties,
  title: {
    fontSize: '20px',
    fontWeight: 700,
  } as React.CSSProperties,
  tabs: {
    display: 'flex',
    gap: '0',
    marginBottom: '20px',
    borderBottom: '1px solid var(--border-color)',
  } as React.CSSProperties,
  tab: (active: boolean) => ({
    padding: '10px 20px',
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
    color: active ? 'var(--accent-blue)' : 'var(--text-secondary)',
    borderBottom: active ? '2px solid var(--accent-blue)' : '2px solid transparent',
    background: 'none',
    borderTop: 'none',
    borderLeft: 'none',
    borderRight: 'none',
    borderRadius: 0,
  } as React.CSSProperties),
  section: {
    marginBottom: '20px',
  } as React.CSSProperties,
  sectionTitle: {
    fontSize: '13px',
    fontWeight: 600,
    color: 'var(--text-secondary)',
    marginBottom: '10px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  } as React.CSSProperties,
  controls: {
    display: 'flex',
    gap: '12px',
    alignItems: 'flex-end',
    flexWrap: 'wrap' as const,
  } as React.CSSProperties,
  field: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '4px',
  } as React.CSSProperties,
  label: {
    fontSize: '11px',
    color: 'var(--text-muted)',
    fontWeight: 600,
  } as React.CSSProperties,
};

function Discovery() {
  const [activeTab, setActiveTab] = useState<'eventhub' | 'vnet'>('eventhub');
  const [ehMode, setEhMode] = useState('DiscoverAll');
  const { isRunning, execute, cancel } = usePowerShell();

  const handleEventHubRun = () => {
    execute(EVENTHUB_SCRIPT, ['-NonInteractive', '-Mode', ehMode]);
  };

  const handleVNetRun = () => {
    execute(VNET_SCRIPT, ['-NonInteractive']);
  };

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.title}>Discovery Tools</h1>
        <StatusBadge status={isRunning ? 'running' : 'idle'} />
      </div>

      <div style={styles.tabs}>
        <button style={styles.tab(activeTab === 'eventhub')} onClick={() => setActiveTab('eventhub')}>
          Event Hub Discovery
        </button>
        <button style={styles.tab(activeTab === 'vnet')} onClick={() => setActiveTab('vnet')}>
          vNet Flow Logs
        </button>
      </div>

      {activeTab === 'eventhub' && (
        <>
          <div style={styles.section}>
            <div style={styles.sectionTitle}>Discovery</div>
            <div style={styles.controls}>
              <div style={styles.field}>
                <span style={styles.label}>Mode</span>
                <select
                  value={ehMode}
                  onChange={(e) => setEhMode(e.target.value)}
                  disabled={isRunning}
                  style={{ minWidth: '240px' }}
                >
                  {eventHubModes.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>
              <button className="btn-success" onClick={handleEventHubRun} disabled={isRunning}>
                Run Discovery
              </button>
              {isRunning && <button className="btn-danger" onClick={cancel}>Cancel</button>}
            </div>
          </div>
          <div style={styles.section}>
            <div style={styles.sectionTitle}>Configuration</div>
            <ConfigEditor configPath={EVENTHUB_CONFIG} label="azure-parameters.json" />
          </div>
        </>
      )}

      {activeTab === 'vnet' && (
        <>
          <div style={styles.section}>
            <div style={styles.sectionTitle}>Discovery</div>
            <div style={styles.controls}>
              <button className="btn-success" onClick={handleVNetRun} disabled={isRunning}>
                Discover vNet Flow Logs
              </button>
              {isRunning && <button className="btn-danger" onClick={cancel}>Cancel</button>}
            </div>
          </div>
          <div style={styles.section}>
            <div style={styles.sectionTitle}>Configuration</div>
            <ConfigEditor configPath={VNET_CONFIG} label="azure-parameters.json" />
          </div>
        </>
      )}
    </div>
  );
}

export default Discovery;
