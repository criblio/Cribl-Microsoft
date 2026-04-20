import { useState, useEffect } from 'react';
import { DepStatus } from '../types';
import CriblLogo from '../components/CriblLogo';

interface DepsCheckProps {
  onReady: () => void;
}

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    padding: '40px',
    background: 'var(--bg-primary)',
  } as React.CSSProperties,
  card: {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--radius)',
    padding: '32px',
    maxWidth: '700px',
    width: '100%',
  } as React.CSSProperties,
  title: {
    fontSize: '20px',
    fontWeight: 700,
    marginBottom: '4px',
    color: 'var(--accent-blue)',
  } as React.CSSProperties,
  subtitle: {
    fontSize: '13px',
    color: 'var(--text-muted)',
    marginBottom: '24px',
  } as React.CSSProperties,
  depRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 0',
    borderBottom: '1px solid var(--border-color)',
  } as React.CSSProperties,
  depInfo: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '2px',
    flex: 1,
  } as React.CSSProperties,
  depName: {
    fontSize: '14px',
    fontWeight: 600,
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  } as React.CSSProperties,
  depDesc: {
    fontSize: '11px',
    color: 'var(--text-muted)',
  } as React.CSSProperties,
  depVersion: {
    fontSize: '11px',
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-secondary)',
  } as React.CSSProperties,
  depStatus: (installed: boolean) => ({
    fontSize: '11px',
    fontWeight: 600,
    padding: '3px 10px',
    borderRadius: '12px',
    background: installed ? 'rgba(102, 187, 106, 0.15)' : 'rgba(239, 83, 80, 0.15)',
    color: installed ? 'var(--accent-green)' : 'var(--accent-red)',
    whiteSpace: 'nowrap' as const,
    marginLeft: '12px',
  } as React.CSSProperties),
  optionalTag: {
    fontSize: '9px',
    padding: '1px 6px',
    borderRadius: '8px',
    background: 'rgba(171, 71, 188, 0.15)',
    color: 'var(--accent-purple)',
    textTransform: 'uppercase' as const,
    fontWeight: 600,
  } as React.CSSProperties,
  installRow: {
    marginTop: '6px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  } as React.CSSProperties,
  installHint: {
    fontSize: '11px',
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-muted)',
    background: 'var(--bg-input)',
    padding: '4px 8px',
    borderRadius: '4px',
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  footer: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: '24px',
    paddingTop: '16px',
    borderTop: '1px solid var(--border-color)',
  } as React.CSSProperties,
  summary: {
    fontSize: '12px',
    color: 'var(--text-muted)',
  } as React.CSSProperties,
  actions: {
    display: 'flex',
    gap: '8px',
  } as React.CSSProperties,
  loadingDot: {
    display: 'inline-block',
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: 'var(--accent-orange)',
    marginRight: '8px',
    animation: 'none',
  } as React.CSSProperties,
  installing: {
    fontSize: '12px',
    color: 'var(--accent-blue)',
    marginTop: '12px',
    padding: '10px',
    background: 'var(--bg-input)',
    borderRadius: 'var(--radius)',
    fontFamily: 'var(--font-mono)',
    maxHeight: '120px',
    overflow: 'auto',
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-all' as const,
  } as React.CSSProperties,
};

function DepsCheck({ onReady }: DepsCheckProps) {
  const [deps, setDeps] = useState<DepStatus[]>([]);
  const [checking, setChecking] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installOutput, setInstallOutput] = useState('');

  useEffect(() => {
    runCheck();
  }, []);

  async function runCheck() {
    if (!window.api) return;
    setChecking(true);
    try {
      const results = await window.api.deps.check();
      setDeps(results);
    } catch {
      // If check itself fails, let user proceed anyway
      setDeps([]);
    } finally {
      setChecking(false);
    }
  }

  async function handleInstall(dep: DepStatus) {
    if (!window.api || !dep.installHint) return;
    setInstalling(dep.name);
    setInstallOutput('');
    try {
      const result = await window.api.deps.install(dep.installHint);
      setInstallOutput(result.output);
      if (result.success) {
        // Re-check after install
        await runCheck();
      }
    } catch {
      setInstallOutput('Installation failed. Try running the command manually.');
    } finally {
      setInstalling(null);
    }
  }

  const requiredDeps = deps.filter((d) => d.required);
  const optionalDeps = deps.filter((d) => !d.required);
  const requiredMet = requiredDeps.every((d) => d.installed);
  const missingRequired = requiredDeps.filter((d) => !d.installed).length;

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={{ marginBottom: '8px' }}><CriblLogo height={28} /></div>
        <div style={styles.title}>Cribl SOC Optimization Toolkit</div>
        <div style={styles.subtitle}>
          {checking
            ? 'Checking dependencies...'
            : requiredMet
              ? 'All required dependencies are available.'
              : `${missingRequired} required dependency${missingRequired !== 1 ? 'ies' : ''} missing.`
          }
        </div>

        {deps.map((dep) => (
          <div key={dep.name}>
            <div style={styles.depRow}>
              <div style={styles.depInfo}>
                <div style={styles.depName}>
                  {dep.name}
                  {!dep.required && <span style={styles.optionalTag}>optional</span>}
                </div>
                <div style={styles.depDesc}>{dep.description}</div>
                {dep.installed && dep.version && (
                  <div style={styles.depVersion}>{dep.version}</div>
                )}
              </div>
              <span style={styles.depStatus(dep.installed)}>
                {dep.installed ? 'Found' : 'Missing'}
              </span>
            </div>
            {!dep.installed && dep.installHint && (
              <div style={styles.installRow}>
                <div style={styles.installHint} title={dep.installHint}>
                  {dep.installHint}
                </div>
                <button
                  className="btn-primary"
                  style={{ fontSize: '11px', padding: '4px 10px', whiteSpace: 'nowrap' }}
                  onClick={() => handleInstall(dep)}
                  disabled={installing !== null}
                >
                  {installing === dep.name ? 'Installing...' : 'Install'}
                </button>
              </div>
            )}
          </div>
        ))}

        {installOutput && (
          <div style={styles.installing}>{installOutput}</div>
        )}

        <div style={styles.footer}>
          <div style={styles.summary}>
            {checking
              ? 'Scanning system...'
              : `${deps.filter((d) => d.installed).length}/${deps.length} dependencies available`
            }
          </div>
          <div style={styles.actions}>
            <button
              className="btn-secondary"
              onClick={runCheck}
              disabled={checking || installing !== null}
            >
              Re-check
            </button>
            <button
              className={requiredMet ? 'btn-success' : 'btn-secondary'}
              onClick={onReady}
              disabled={checking}
            >
              {requiredMet ? 'Continue' : 'Skip (some tools may not work)'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default DepsCheck;
