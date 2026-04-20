import { useState, useEffect, useCallback } from 'react';
import { usePowerShell } from '../../hooks/usePowerShell';
import { PackInfo } from '../../types';

interface PackManagerProps {
  onNewPack: () => void;
}

interface PackAlert {
  packName: string;
  solutionName: string;
  hasChanges: boolean;
  totalChanges: number;
  criticalCount: number;
  warningCount: number;
  changes: Array<{
    category: string;
    severity: string;
    description: string;
    fileName?: string;
    logTypeName?: string;
    oldValue?: string | number;
    newValue?: string | number;
  }>;
}

interface PackDiff {
  packName: string;
  solutionName: string;
  buildTime: number;
  daysSinceBuild: number;
  changes: PackAlert['changes'];
  recommendation: string;
}

const styles = {
  container: {} as React.CSSProperties,
  toolbar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '16px',
  } as React.CSSProperties,
  info: {
    fontSize: '12px',
    color: 'var(--text-muted)',
  } as React.CSSProperties,
  grid: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '8px',
  } as React.CSSProperties,
  card: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--radius)',
    padding: '14px 16px',
  } as React.CSSProperties,
  cardInfo: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '4px',
  } as React.CSSProperties,
  packName: {
    fontSize: '14px',
    fontWeight: 600,
  } as React.CSSProperties,
  packMeta: {
    fontSize: '11px',
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)',
  } as React.CSSProperties,
  cardActions: {
    display: 'flex',
    gap: '8px',
  } as React.CSSProperties,
  empty: {
    textAlign: 'center' as const,
    padding: '40px',
    color: 'var(--text-muted)',
  } as React.CSSProperties,
  emptyTitle: {
    fontSize: '15px',
    fontWeight: 600,
    marginBottom: '8px',
    color: 'var(--text-secondary)',
  } as React.CSSProperties,
  changeBadge: (critical: boolean) => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '2px 8px',
    borderRadius: '10px',
    fontSize: '10px',
    fontWeight: 600,
    background: critical ? 'rgba(239, 83, 80, 0.15)' : 'rgba(255, 167, 38, 0.15)',
    color: critical ? 'var(--accent-red)' : 'var(--accent-orange)',
    cursor: 'pointer',
  } as React.CSSProperties),
  upToDate: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '2px 8px',
    borderRadius: '10px',
    fontSize: '10px',
    fontWeight: 600,
    background: 'rgba(102, 187, 106, 0.15)',
    color: 'var(--accent-green)',
  } as React.CSSProperties,
  diffPanel: {
    background: 'var(--bg-input)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--radius)',
    padding: '14px 16px',
    marginTop: '8px',
  } as React.CSSProperties,
  diffHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '10px',
  } as React.CSSProperties,
  diffTitle: {
    fontSize: '12px',
    fontWeight: 600,
    color: 'var(--text-primary)',
  } as React.CSSProperties,
  diffRecommendation: (critical: boolean) => ({
    fontSize: '11px',
    padding: '8px 10px',
    borderRadius: '4px',
    marginBottom: '10px',
    background: critical ? 'rgba(239, 83, 80, 0.08)' : 'rgba(255, 167, 38, 0.08)',
    border: `1px solid ${critical ? 'rgba(239, 83, 80, 0.2)' : 'rgba(255, 167, 38, 0.2)'}`,
    color: critical ? 'var(--accent-red)' : 'var(--accent-orange)',
  } as React.CSSProperties),
  changeRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '8px',
    padding: '6px 0',
    borderBottom: '1px solid var(--border-color)',
    fontSize: '11px',
  } as React.CSSProperties,
  severityDot: (severity: string) => ({
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    marginTop: '3px',
    flexShrink: 0,
    background: severity === 'critical'
      ? 'var(--accent-red)'
      : severity === 'warning'
        ? 'var(--accent-orange)'
        : 'var(--accent-blue)',
  } as React.CSSProperties),
  changeDesc: {
    flex: 1,
    color: 'var(--text-secondary)',
    lineHeight: 1.4,
  } as React.CSSProperties,
  changeCategory: {
    fontFamily: 'var(--font-mono)',
    fontSize: '10px',
    color: 'var(--text-muted)',
    flexShrink: 0,
  } as React.CSSProperties,
  checkBar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 12px',
    marginBottom: '12px',
    borderRadius: 'var(--radius)',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    fontSize: '11px',
    color: 'var(--text-muted)',
  } as React.CSSProperties,
};

function PackManager({ onNewPack }: PackManagerProps) {
  const [packs, setPacks] = useState<PackInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [alerts, setAlerts] = useState<Record<string, PackAlert>>({});
  const [expandedPack, setExpandedPack] = useState<string | null>(null);
  const [diffData, setDiffData] = useState<PackDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const { isRunning, execute } = usePowerShell();

  const loadPacks = useCallback(async () => {
    if (!window.api) return;
    setLoading(true);
    try {
      const result = await window.api.packBuilder.list();
      setPacks(result);
    } catch {
      setPacks([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAlerts = useCallback(async () => {
    if (!window.api) return;
    try {
      const status = await window.api.changeDetection.status();
      const map: Record<string, PackAlert> = {};
      for (const alert of status.alerts) {
        map[alert.packName] = alert;
      }
      setAlerts(map);
    } catch { /* not available yet */ }
  }, []);

  useEffect(() => {
    loadPacks();
    loadAlerts();
    if (!window.api) return;
    const unsub = window.api.changeDetection.onStatus(() => { loadAlerts(); });
    return () => { unsub(); };
  }, [loadPacks, loadAlerts]);

  const handleCheckChanges = async () => {
    if (!window.api) return;
    setChecking(true);
    try {
      await window.api.changeDetection.check();
      // Wait a bit for detection to complete, then reload
      setTimeout(() => { loadAlerts(); setChecking(false); }, 3000);
    } catch {
      setChecking(false);
    }
  };

  const handleViewDiff = async (packName: string) => {
    if (expandedPack === packName) {
      setExpandedPack(null);
      setDiffData(null);
      return;
    }
    setExpandedPack(packName);
    setDiffLoading(true);
    setDiffData(null);
    try {
      if (!window.api) return;
      const diff = await window.api.changeDetection.packDiff(packName);
      setDiffData(diff);
    } catch { /* skip */ }
    setDiffLoading(false);
  };

  const handleDismiss = async (packName: string) => {
    if (!window.api) return;
    try {
      await window.api.changeDetection.dismiss(packName);
      loadAlerts();
      setExpandedPack(null);
      setDiffData(null);
    } catch { /* skip */ }
  };

  const [lastCrblPath, setLastCrblPath] = useState('');

  const handlePackage = async (pack: PackInfo) => {
    if (!window.api) return;
    try {
      const result = await window.api.packBuilder.package(pack.path);
      if (result.crblPath) {
        setLastCrblPath(result.crblPath);
      }
    } catch { /* skip */ }
  };

  // Copy .crbl path to clipboard
  const handleCopyPath = () => {
    if (lastCrblPath) {
      navigator.clipboard?.writeText(lastCrblPath);
    }
  };

  const handleDelete = async (pack: PackInfo) => {
    if (!window.api) return;
    try {
      await window.api.packBuilder.delete(pack.name);
      loadPacks();
    } catch { /* skip */ }
  };

  if (loading) {
    return <div style={{ color: 'var(--text-muted)', padding: '20px' }}>Loading packs...</div>;
  }

  if (packs.length === 0) {
    return (
      <div style={styles.empty}>
        <div style={styles.emptyTitle}>No packs yet</div>
        <p style={{ fontSize: '13px', marginBottom: '16px' }}>
          Create your first Cribl Pack from a Microsoft Sentinel Content Hub solution.
        </p>
        <button className="btn-primary" onClick={onNewPack}>
          Browse Sentinel Solutions
        </button>
      </div>
    );
  }

  const packsWithChanges = Object.values(alerts).filter((a) => a.hasChanges).length;

  return (
    <div style={styles.container}>
      {lastCrblPath && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 14px', marginBottom: '8px', borderRadius: 'var(--radius)',
          background: 'rgba(102, 187, 106, 0.1)', border: '1px solid rgba(102, 187, 106, 0.3)',
          fontSize: '12px',
        }}>
          <div>
            <span style={{ fontWeight: 600, color: 'var(--accent-green)' }}>Pack packaged successfully</span>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
              {lastCrblPath}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              className="btn-primary"
              style={{ fontSize: '10px', padding: '4px 10px' }}
              onClick={async () => {
                try {
                  const resp = await fetch(`/api/pack/download?path=${encodeURIComponent(lastCrblPath)}`);
                  if (!resp.ok) return;
                  const blob = await resp.blob();
                  const fileName = lastCrblPath.split(/[/\\]/).pop() || 'pack.crbl';
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = fileName;
                  a.click();
                  URL.revokeObjectURL(url);
                } catch { /* skip */ }
              }}
            >
              Download .crbl
            </button>
            <button
              className="btn-secondary"
              style={{ fontSize: '10px', padding: '4px 10px' }}
              onClick={handleCopyPath}
            >
              Copy Path
            </button>
            <button
              className="btn-secondary"
              style={{ fontSize: '10px', padding: '4px 10px' }}
              onClick={() => setLastCrblPath('')}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      <div style={styles.checkBar}>
        <span>
          {packsWithChanges > 0
            ? `${packsWithChanges} pack${packsWithChanges !== 1 ? 's' : ''} with upstream changes`
            : 'All packs up to date'
          }
        </span>
        <button
          className="btn-secondary"
          style={{ fontSize: '10px', padding: '4px 10px' }}
          onClick={handleCheckChanges}
          disabled={checking}
        >
          {checking ? 'Checking...' : 'Check for Changes'}
        </button>
      </div>

      <div style={styles.toolbar}>
        <span style={styles.info}>{packs.length} pack{packs.length !== 1 ? 's' : ''}</span>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button className="btn-secondary" onClick={loadPacks}>Refresh</button>
          <button className="btn-primary" onClick={onNewPack}>New Pack</button>
        </div>
      </div>

      <div style={styles.grid}>
        {packs.map((pack) => {
          const alert = alerts[pack.name];
          const hasChanges = alert?.hasChanges;
          const isExpanded = expandedPack === pack.name;

          return (
            <div key={pack.name}>
              <div style={{
                ...styles.card,
                borderLeft: hasChanges
                  ? `3px solid ${alert.criticalCount > 0 ? 'var(--accent-red)' : 'var(--accent-orange)'}`
                  : '3px solid transparent',
              }}>
                <div style={styles.cardInfo}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={styles.packName}>{pack.displayName || pack.name}</span>
                    {hasChanges ? (
                      <span
                        style={styles.changeBadge(alert.criticalCount > 0)}
                        onClick={() => handleViewDiff(pack.name)}
                        title="Click to view changes"
                      >
                        {alert.criticalCount > 0 ? 'SCHEMA CHANGED' : 'UPDATES'}
                        {' '}{alert.totalChanges}
                      </span>
                    ) : alert && !hasChanges ? (
                      <span style={styles.upToDate}>UP TO DATE</span>
                    ) : null}
                  </div>
                  <span style={styles.packMeta}>
                    v{pack.version} | {pack.name}
                  </span>
                </div>
                <div style={styles.cardActions}>
                  {hasChanges && (
                    <button
                      className="btn-secondary"
                      style={{ fontSize: '11px', padding: '6px 12px' }}
                      onClick={() => handleViewDiff(pack.name)}
                    >
                      {isExpanded ? 'Hide' : 'View'} Changes
                    </button>
                  )}
                  <button
                    className="btn-success"
                    style={{ fontSize: '11px', padding: '6px 12px' }}
                    onClick={() => handlePackage(pack)}
                    disabled={isRunning}
                  >
                    Package .crbl
                  </button>
                  <button
                    className="btn-danger"
                    style={{ fontSize: '11px', padding: '6px 12px' }}
                    onClick={() => handleDelete(pack)}
                    disabled={isRunning}
                  >
                    Delete
                  </button>
                </div>
              </div>

              {isExpanded && (
                <div style={styles.diffPanel}>
                  {diffLoading ? (
                    <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                      Checking upstream changes...
                    </div>
                  ) : diffData ? (
                    <>
                      <div style={styles.diffHeader}>
                        <span style={styles.diffTitle}>
                          Changes since build ({diffData.daysSinceBuild} day{diffData.daysSinceBuild !== 1 ? 's' : ''} ago)
                        </span>
                        <button
                          className="btn-secondary"
                          style={{ fontSize: '10px', padding: '3px 8px' }}
                          onClick={() => handleDismiss(pack.name)}
                        >
                          Dismiss
                        </button>
                      </div>

                      <div style={styles.diffRecommendation(diffData.changes.some((c) => c.severity === 'critical'))}>
                        {diffData.recommendation}
                      </div>

                      {diffData.changes.map((change, idx) => (
                        <div key={idx} style={styles.changeRow}>
                          <div style={styles.severityDot(change.severity)} />
                          <div style={styles.changeDesc}>{change.description}</div>
                          <div style={styles.changeCategory}>{change.category}</div>
                        </div>
                      ))}

                      {diffData.changes.length === 0 && (
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>
                          No changes detected on live check.
                        </div>
                      )}
                    </>
                  ) : (
                    <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                      Unable to fetch change details.
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default PackManager;
