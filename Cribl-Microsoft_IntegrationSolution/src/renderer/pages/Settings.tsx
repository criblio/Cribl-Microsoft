import { useState, useEffect } from 'react';

function ModeDisplay() {
  const [mode, setMode] = useState('');
  useEffect(() => {
    if (!window.api) return;
    window.api.config.read('integration-mode.json')
      .then((c: any) => setMode(c?.mode || 'not set'))
      .catch(() => setMode('not set'));
  }, []);
  const labels: Record<string, string> = {
    'full': 'Full Integration',
    'azure-only': 'Azure Only',
    'cribl-only': 'Cribl Only',
    'air-gapped': 'Air-Gapped',
  };
  return <span style={{ fontSize: '13px', fontFamily: 'var(--font-mono)' }}>{labels[mode] || mode}</span>;
}

const styles = {
  page: { maxWidth: '700px' } as React.CSSProperties,
  title: { fontSize: '20px', fontWeight: 700, marginBottom: '24px' } as React.CSSProperties,
  section: { marginBottom: '24px' } as React.CSSProperties,
  sectionTitle: {
    fontSize: '13px',
    fontWeight: 600,
    color: 'var(--text-secondary)',
    marginBottom: '12px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  } as React.CSSProperties,
  card: {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--radius)',
    padding: '16px',
  } as React.CSSProperties,
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 0',
    borderBottom: '1px solid var(--border-color)',
  } as React.CSSProperties,
  rowLabel: { fontSize: '13px', color: 'var(--text-secondary)' } as React.CSSProperties,
  rowValue: { fontSize: '13px', fontFamily: 'var(--font-mono)' } as React.CSSProperties,
  infoText: {
    fontSize: '12px',
    color: 'var(--text-muted)',
    marginTop: '8px',
    lineHeight: '1.6',
  } as React.CSSProperties,
};

const configLocations = [
  { tool: 'DCR Automation', path: 'Azure/CustomDeploymentTemplates/DCR-Automation/core/' },
  { tool: 'EventHub Discovery', path: 'Azure/dev/EventHubDiscovery/prod/' },
  { tool: 'vNet Discovery', path: 'Azure/dev/vNetFlowLogDiscovery/' },
  { tool: 'Schema Sync', path: 'Azure/dev/windows-schema-sync/Core/' },
  { tool: 'Unified Lab', path: 'Azure/Labs/UnifiedLab/' },
  { tool: 'Flow Log Lab', path: 'Azure/Labs/AzureFlowLogLab/prod/' },
  { tool: 'Pack Packaging', path: 'Azure/dev/Packs/Cribl_Pack_Packaging/prod/' },
];

function Settings() {
  const [repoRoot, setRepoRoot] = useState('');

  useEffect(() => {
    if (window.api) {
      window.api.config.getRepoRoot().then(setRepoRoot);
    }
  }, []);

  return (
    <div style={styles.page}>
      <h1 style={styles.title}>Settings</h1>

      <div style={styles.section}>
        <div style={styles.sectionTitle}>Environment</div>
        <div style={styles.card}>
          <div style={styles.row}>
            <span style={styles.rowLabel}>Repository Root</span>
            <span style={styles.rowValue}>{repoRoot || 'Loading...'}</span>
          </div>
          <div style={styles.row}>
            <span style={styles.rowLabel}>Platform</span>
            <span style={styles.rowValue}>Windows</span>
          </div>
          <div style={{ ...styles.row, borderBottom: 'none' }}>
            <span style={styles.rowLabel}>PowerShell</span>
            <span style={styles.rowValue}>powershell.exe</span>
          </div>
        </div>
      </div>

      <div style={styles.section}>
        <div style={styles.sectionTitle}>Configuration File Locations</div>
        <div style={styles.card}>
          {configLocations.map((loc, i) => (
            <div
              key={loc.tool}
              style={{ ...styles.row, borderBottom: i === configLocations.length - 1 ? 'none' : styles.row.borderBottom }}
            >
              <span style={styles.rowLabel}>{loc.tool}</span>
              <span style={{ ...styles.rowValue, fontSize: '11px', color: 'var(--text-muted)' }}>
                {loc.path}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div style={styles.section}>
        <div style={styles.sectionTitle}>Azure Authentication</div>
        <div style={styles.card}>
          <p style={styles.infoText}>
            Azure authentication is managed through PowerShell. Run <code>Connect-AzAccount</code> in
            a PowerShell terminal before using tools that require Azure access. Use{' '}
            <code>Set-AzContext -Subscription "name"</code> to select the target subscription.
          </p>
        </div>
      </div>

      <div style={styles.section}>
        <div style={styles.sectionTitle}>Integration Mode</div>
        <div style={styles.card}>
          <div style={styles.row}>
            <span style={styles.rowLabel}>Current Mode</span>
            <ModeDisplay />
          </div>
          <div style={{ ...styles.row, borderBottom: 'none' }}>
            <span style={styles.rowLabel}>Reconfigure connections and mode</span>
            <button className="btn-secondary" style={{ fontSize: '11px', padding: '4px 12px' }}
              onClick={async () => {
                if (!window.api) return;
                try {
                  await window.api.config.write('integration-mode.json', {});
                  window.location.reload();
                } catch { /* skip */ }
              }}>
              Reconfigure
            </button>
          </div>
        </div>
      </div>

      <div style={styles.section}>
        <div style={styles.sectionTitle}>About</div>
        <div style={styles.card}>
          <div style={styles.row}>
            <span style={styles.rowLabel}>Application</span>
            <span style={styles.rowValue}>Cribl SOC Optimization Toolkit for Microsoft Sentinel</span>
          </div>
          <div style={{ ...styles.row, borderBottom: 'none' }}>
            <span style={styles.rowLabel}>Version</span>
            <span style={styles.rowValue}>1.0.0</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Settings;
