import { useState } from 'react';
import { usePowerShell } from '../hooks/usePowerShell';
import ConfigEditor from '../components/ConfigEditor';
import StatusBadge from '../components/StatusBadge';

const SCRIPT_PATH = 'Azure/CustomDeploymentTemplates/DCR-Automation/Run-DCRAutomation.ps1';
const CONFIG_BASE = 'Azure/CustomDeploymentTemplates/DCR-Automation/core';

const deploymentModes = [
  { value: 'DirectNative', label: 'Direct DCR - Native Tables' },
  { value: 'DirectCustom', label: 'Direct DCR - Custom Tables' },
  { value: 'DirectBoth', label: 'Direct DCR - All Tables' },
  { value: 'DCENative', label: 'DCE-based - Native Tables' },
  { value: 'DCECustom', label: 'DCE-based - Custom Tables' },
  { value: 'DCEBoth', label: 'DCE-based - All Tables' },
  { value: 'TemplateOnly', label: 'Generate Templates Only' },
];

const actionModes = [
  { value: 'Status', label: 'Show Status' },
  { value: 'CollectCribl', label: 'Collect Cribl Config' },
  { value: 'ValidateCribl', label: 'Validate Cribl Config' },
  { value: 'ResetCribl', label: 'Reset Cribl Config' },
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
  select: {
    minWidth: '240px',
  } as React.CSSProperties,
  actionGrid: {
    display: 'flex',
    gap: '8px',
    flexWrap: 'wrap' as const,
  } as React.CSSProperties,
  configs: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '12px',
  } as React.CSSProperties,
};

function DcrAutomation() {
  const [selectedMode, setSelectedMode] = useState('DirectBoth');
  const { isRunning, execute, cancel } = usePowerShell();

  const handleRun = () => {
    execute(SCRIPT_PATH, ['-NonInteractive', '-Mode', selectedMode]);
  };

  const handleAction = (mode: string) => {
    execute(SCRIPT_PATH, ['-NonInteractive', '-Mode', mode]);
  };

  const status = isRunning ? 'running' : 'idle';

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.title}>DCR Automation</h1>
        <StatusBadge status={status} />
      </div>

      <div style={styles.section}>
        <div style={styles.sectionTitle}>Deployment</div>
        <div style={styles.controls}>
          <div style={styles.field}>
            <span style={styles.label}>Mode</span>
            <select
              style={styles.select}
              value={selectedMode}
              onChange={(e) => setSelectedMode(e.target.value)}
              disabled={isRunning}
            >
              {deploymentModes.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
          <button className="btn-success" onClick={handleRun} disabled={isRunning}>
            Run Deployment
          </button>
          {isRunning && (
            <button className="btn-danger" onClick={cancel}>Cancel</button>
          )}
        </div>
      </div>

      <div style={styles.section}>
        <div style={styles.sectionTitle}>Actions</div>
        <div style={styles.actionGrid}>
          {actionModes.map((a) => (
            <button
              key={a.value}
              className="btn-secondary"
              onClick={() => handleAction(a.value)}
              disabled={isRunning}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>

      <div style={styles.section}>
        <div style={styles.sectionTitle}>Configuration</div>
        <div style={styles.configs}>
          <ConfigEditor
            configPath={`${CONFIG_BASE}/azure-parameters.json`}
            label="azure-parameters.json"
          />
          <ConfigEditor
            configPath={`${CONFIG_BASE}/operation-parameters.json`}
            label="operation-parameters.json"
          />
        </div>
      </div>
    </div>
  );
}

export default DcrAutomation;
