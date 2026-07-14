// Repository Setup Page
// Part of the first-run wizard AND accessible from the sidebar nav.
// Handles:
//   1. GitHub PAT setup (required for authenticated API fetches)
//   2. Azure-Sentinel repo fetch (via GitHub API, not git clone)
//   3. Elastic Integrations repo fetch (via GitHub API, not git clone)

import { useState, useEffect } from 'react';

interface RepoSetupProps {
  onContinue?: () => void;  // Only provided when rendered in setup wizard
  wizard?: boolean;          // True when part of wizard, false when standalone nav item
}

const s = {
  page: {
    display: 'flex', flexDirection: 'column' as const, alignItems: 'center',
    justifyContent: 'flex-start', height: '100vh', padding: '40px 40px 20px',
    background: 'var(--bg-primary)', overflowY: 'auto' as const,
  } as React.CSSProperties,
  standalonePage: {
    maxWidth: '1000px', padding: '24px', paddingBottom: '40px',
  } as React.CSSProperties,
  card: {
    maxWidth: '760px', width: '100%', background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)', borderRadius: '8px',
    padding: '32px', boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
  } as React.CSSProperties,
  title: { fontSize: '22px', fontWeight: 700, marginBottom: '4px' } as React.CSSProperties,
  subtitle: { fontSize: '13px', color: 'var(--text-muted)', marginBottom: '24px' } as React.CSSProperties,
  section: {
    padding: '20px 0', borderTop: '1px solid var(--border-color)',
  } as React.CSSProperties,
  sectionTitle: {
    fontSize: '14px', fontWeight: 700, marginBottom: '4px',
  } as React.CSSProperties,
  sectionDesc: {
    fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px', lineHeight: 1.5,
  } as React.CSSProperties,
  input: {
    width: '100%', padding: '8px 12px', fontSize: '13px',
    background: 'var(--bg-input)', border: '1px solid var(--border-color)',
    borderRadius: '4px', color: 'var(--text-primary)',
    fontFamily: 'var(--font-mono)',
  } as React.CSSProperties,
  guide: {
    marginTop: '10px', padding: '12px 14px', background: 'var(--bg-input)',
    border: '1px solid var(--border-color)', borderRadius: '4px',
    fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.6,
  } as React.CSSProperties,
  statusBox: (ok: boolean) => ({
    display: 'flex', alignItems: 'center', gap: '10px',
    padding: '10px 14px', borderRadius: '4px', fontSize: '12px',
    background: ok ? 'rgba(102, 187, 106, 0.08)' : 'rgba(255, 167, 38, 0.08)',
    border: `1px solid ${ok ? 'rgba(102, 187, 106, 0.25)' : 'rgba(255, 167, 38, 0.25)'}`,
    color: ok ? 'var(--accent-green)' : 'var(--accent-orange)',
  } as React.CSSProperties),
  dot: (color: string) => ({
    width: '10px', height: '10px', borderRadius: '50%', flexShrink: 0, background: color,
  } as React.CSSProperties),
  repoRow: {
    display: 'flex', alignItems: 'center', gap: '12px',
    padding: '12px 0', borderBottom: '1px solid var(--border-color)',
  } as React.CSSProperties,
  repoInfo: { flex: 1 } as React.CSSProperties,
  repoName: { fontSize: '13px', fontWeight: 600, marginBottom: '2px' } as React.CSSProperties,
  repoDesc: { fontSize: '11px', color: 'var(--text-muted)' } as React.CSSProperties,
  repoDetail: { fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px', fontFamily: 'var(--font-mono)' } as React.CSSProperties,
  blockedSection: {
    marginTop: '8px', padding: '10px 14px', background: 'rgba(255, 167, 38, 0.06)',
    border: '1px solid rgba(255, 167, 38, 0.15)', borderRadius: '4px',
  } as React.CSSProperties,
  blockedHeader: {
    display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer',
    fontSize: '12px', color: 'var(--accent-orange)', fontWeight: 600,
  } as React.CSSProperties,
  blockedList: {
    marginTop: '8px', display: 'flex', flexDirection: 'column' as const, gap: '6px',
  } as React.CSSProperties,
  blockedItem: {
    display: 'flex', alignItems: 'flex-start', gap: '8px',
    padding: '6px 8px', background: 'var(--bg-input)', borderRadius: '4px',
    fontSize: '11px',
  } as React.CSSProperties,
  blockedBadge: (source: string) => ({
    display: 'inline-block', padding: '1px 6px', borderRadius: '3px',
    fontSize: '9px', fontWeight: 700, textTransform: 'uppercase' as const, flexShrink: 0,
    background: source === 'built-in' ? 'rgba(102, 187, 106, 0.12)' : source === 'auto-detected' ? 'rgba(255, 167, 38, 0.12)' : 'rgba(144, 202, 249, 0.12)',
    color: source === 'built-in' ? 'var(--accent-green)' : source === 'auto-detected' ? 'var(--accent-orange)' : 'var(--accent-blue)',
    border: `1px solid ${source === 'built-in' ? 'rgba(102, 187, 106, 0.25)' : source === 'auto-detected' ? 'rgba(255, 167, 38, 0.25)' : 'rgba(144, 202, 249, 0.25)'}`,
  } as React.CSSProperties),
  progressWrap: {
    marginTop: '6px', width: '100%', maxWidth: '400px',
  } as React.CSSProperties,
  progressBarBg: {
    width: '100%', height: '6px', background: 'var(--bg-input)',
    borderRadius: '3px', overflow: 'hidden',
  } as React.CSSProperties,
  progressBarFill: (pct: number) => ({
    height: '100%', width: `${Math.min(100, Math.max(0, pct))}%`,
    background: 'var(--accent-blue)',
    transition: 'width 0.25s ease-out',
  } as React.CSSProperties),
  progressText: {
    fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)',
    marginTop: '3px', display: 'flex', justifyContent: 'space-between',
  } as React.CSSProperties,
  footer: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginTop: '24px', paddingTop: '16px', borderTop: '1px solid var(--border-color)',
  } as React.CSSProperties,
};

function repoStateColor(ready: boolean, working: boolean, error: boolean): string {
  if (ready) return 'var(--accent-green)';
  if (working) return 'var(--accent-blue)';
  if (error) return 'var(--accent-red)';
  return 'var(--text-muted)';
}

function RepoSetup({ onContinue, wizard }: RepoSetupProps) {
  // GitHub PAT state
  const [ghHasPat, setGhHasPat] = useState(false);
  const [ghLogin, setGhLogin] = useState('');
  const [ghPatInput, setGhPatInput] = useState('');
  const [ghSaving, setGhSaving] = useState(false);
  const [ghError, setGhError] = useState('');
  const [ghGuideOpen, setGhGuideOpen] = useState(false);

  // Repo status
  const [sentinelRepo, setSentinelRepo] = useState<{ state: string; solutionCount: number; error: string; blockedCount: number; fetchedCount: number }>({
    state: 'unknown', solutionCount: 0, error: '', blockedCount: 0, fetchedCount: 0,
  });
  // EDR blocklist
  const [blocklist, setBlocklist] = useState<Array<{ name: string; reason: string; source: string }>>([]);
  const [blocklistOpen, setBlocklistOpen] = useState(false);
  const [elasticRepo, setElasticRepo] = useState<{ state: string; packageCount: number; error: string }>({
    state: 'unknown', packageCount: 0, error: '',
  });
  const [sentinelWorking, setSentinelWorking] = useState(false);
  const [elasticWorking, setElasticWorking] = useState(false);
  const [sentinelPhase, setSentinelPhase] = useState('');
  const [sentinelPct, setSentinelPct] = useState<{ done: number; total: number; pct: number } | null>(null);
  const [elasticPct, setElasticPct] = useState<{ done: number; total: number; pct: number } | null>(null);

  useEffect(() => {
    if (!window.api) return;

    // Initial status
    (window.api as any).auth?.githubSaved?.().then((r: any) => setGhHasPat(!!r?.hasPat)).catch(() => {});
    window.api.sentinelRepo?.status().then((r: any) => setSentinelRepo(r)).catch(() => {});
    (window.api as any).elasticRepo?.status().then((r: any) => setElasticRepo(r)).catch(() => {});
    // Load EDR blocklist
    (window.api.sentinelRepo as any)?.blocklist?.().then((bl: any) => setBlocklist(bl || [])).catch(() => {});

    // Live updates
    const unsubSentinel = window.api.sentinelRepo?.onStatus?.((r: any) => setSentinelRepo(r));
    const unsubElastic = (window.api as any).elasticRepo?.onStatus?.((r: any) => setElasticRepo(r));
    // Phase text (just a short status line, e.g., "Downloading 2500 files...")
    const unsubSentinelPhase = window.api.sentinelRepo?.onProgress?.((msg: string) => {
      setSentinelPhase(msg.trim().split('\n').pop() || '');
    });
    // Structured fetch progress for the progress bar
    const unsubSentinelFetch = (window.api.sentinelRepo as any)?.onFetchProgress?.(
      (p: { done: number; total: number; pct: number }) => setSentinelPct(p),
    );
    const unsubElasticFetch = (window.api as any).elasticRepo?.onFetchProgress?.(
      (p: { done: number; total: number; pct: number }) => setElasticPct(p),
    );
    return () => {
      unsubSentinel?.(); unsubElastic?.();
      unsubSentinelPhase?.(); unsubSentinelFetch?.(); unsubElasticFetch?.();
    };
  }, []);

  async function saveGitHubPat() {
    if (!window.api || !ghPatInput.trim()) return;
    setGhSaving(true);
    setGhError('');
    try {
      const result = await (window.api as any).auth.githubSave(ghPatInput.trim());
      if (result.success) {
        setGhHasPat(true);
        setGhLogin(result.login || '');
        setGhPatInput('');
        // Reset any stale error state in both repos (backend + frontend).
        // The backend may have cached "PAT required" errors from attempts before the token was added.
        try { await (window.api as any).sentinelRepo.resetError?.(); } catch { /* optional */ }
        try { await (window.api as any).elasticRepo.resetError?.(); } catch { /* optional */ }
        setSentinelRepo((prev) => prev.state === 'error'
          ? { ...prev, state: 'not_cloned', error: '' }
          : prev);
        setElasticRepo((prev) => prev.state === 'error'
          ? { ...prev, state: 'not_cloned', error: '' }
          : prev);
        // Re-fetch fresh status from backend to overwrite local cache
        window.api.sentinelRepo?.status().then((r: any) => setSentinelRepo(r)).catch(() => {});
        (window.api as any).elasticRepo?.status().then((r: any) => setElasticRepo(r)).catch(() => {});
      } else {
        setGhError(result.error || 'Failed to validate token');
      }
    } catch (err) {
      setGhError(err instanceof Error ? err.message : 'Save failed');
    }
    setGhSaving(false);
  }

  async function clearGitHubPat() {
    if (!window.api) return;
    await (window.api as any).auth.githubClear();
    setGhHasPat(false);
    setGhLogin('');
    setGhError('');
  }

  async function fetchSentinel() {
    if (!window.api || !ghHasPat) return;
    setSentinelWorking(true);
    setSentinelPhase('Starting...');
    setSentinelPct(null);
    try { await window.api.sentinelRepo.sync(); } catch { /* progress events show error */ }
    // Refresh blocklist (may have new auto-detected entries)
    (window.api.sentinelRepo as any)?.blocklist?.().then((bl: any) => setBlocklist(bl || [])).catch(() => {});
    setSentinelWorking(false);
  }

  async function retryBlockedSolution(solutionName: string) {
    if (!window.api) return;
    try {
      const result = await (window.api.sentinelRepo as any).blocklistRetry(solutionName);
      if (result?.blocklist) setBlocklist(result.blocklist);
    } catch { /* non-fatal */ }
  }

  async function fetchElastic() {
    if (!window.api || !ghHasPat) return;
    setElasticWorking(true);
    setElasticPct(null);
    try { await (window.api as any).elasticRepo.clone(); } catch { /* status events show error */ }
    setElasticWorking(false);
  }

  const bothReady = sentinelRepo.state === 'ready' && sentinelRepo.solutionCount > 0
    && elasticRepo.state === 'ready' && elasticRepo.packageCount > 0;

  const sentinelReady = sentinelRepo.state === 'ready' && sentinelRepo.solutionCount > 0;
  const sentinelBusy = sentinelWorking || sentinelRepo.state === 'cloning' || sentinelRepo.state === 'updating';
  const sentinelErr = sentinelRepo.state === 'error';

  const elasticReady = elasticRepo.state === 'ready' && elasticRepo.packageCount > 0;
  const elasticBusy = elasticWorking || elasticRepo.state === 'cloning';
  const elasticErr = elasticRepo.state === 'error';

  return (
    <div style={wizard ? s.page : s.standalonePage}>
      <div style={wizard ? s.card : {}}>
        <div style={s.title}>Content Repositories</div>
        <div style={s.subtitle}>
          Configure GitHub access and download Sentinel Solutions + Elastic sample data. All fetches use the GitHub REST API -- no git installation or cloning required.
        </div>

        {/* SECTION 1: GitHub Authentication */}
        <div style={s.section}>
          <div style={s.sectionTitle}>1. GitHub Personal Access Token (Required)</div>
          <div style={s.sectionDesc}>
            GitHub rate-limits unauthenticated API requests to 60/hour. The repositories below require ~600-2500 API calls, so a PAT is required.
            The token is encrypted at rest using your OS keychain (Windows DPAPI / macOS Keychain) and only sent to GitHub over HTTPS.
          </div>

          {ghHasPat ? (
            <div style={s.statusBox(true)}>
              <div style={s.dot('var(--accent-green)')} />
              <div style={{ flex: 1 }}>GitHub token saved{ghLogin ? ` (${ghLogin})` : ''}</div>
              <button className="btn-secondary" style={{ fontSize: '11px', padding: '4px 12px' }}
                onClick={clearGitHubPat}>Clear Token</button>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <input type="password"
                  placeholder="github_pat_... or ghp_..."
                  value={ghPatInput}
                  onChange={(e) => setGhPatInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveGitHubPat(); }}
                  style={s.input}
                />
                <button className="btn-primary" style={{ fontSize: '12px', padding: '8px 18px', whiteSpace: 'nowrap' }}
                  onClick={saveGitHubPat}
                  disabled={ghSaving || !ghPatInput.trim()}>
                  {ghSaving ? 'Validating...' : 'Save Token'}
                </button>
              </div>
              {ghError && (
                <div style={{ fontSize: '11px', color: 'var(--accent-red)', marginTop: '6px' }}>
                  {ghError}
                </div>
              )}
            </>
          )}

          <div style={{ marginTop: '12px' }}>
            <button className="btn-secondary"
              style={{ fontSize: '11px', padding: '4px 12px' }}
              onClick={() => setGhGuideOpen(!ghGuideOpen)}>
              {ghGuideOpen ? 'Hide' : 'Show'} instructions for creating a PAT
            </button>
          </div>

          {ghGuideOpen && (
            <div style={s.guide}>
              <div style={{ fontWeight: 600, marginBottom: '8px', color: 'var(--text-primary)' }}>
                Create a fine-grained Personal Access Token
              </div>
              <ol style={{ margin: 0, paddingLeft: '20px' }}>
                <li style={{ marginBottom: '6px' }}>
                  <strong>Log in</strong> to{' '}
                  <a href="https://github.com/login" target="_blank" rel="noopener"
                    style={{ color: 'var(--accent-blue)', textDecoration: 'underline' }}>
                    github.com
                  </a>.
                </li>
                <li style={{ marginBottom: '6px' }}>
                  Click your <strong>profile picture</strong> in the top-right corner.
                </li>
                <li style={{ marginBottom: '6px' }}>
                  Select <strong>Settings</strong> from the dropdown menu.
                </li>
                <li style={{ marginBottom: '6px' }}>
                  In the left sidebar, scroll down and click <strong>Developer settings</strong>.
                </li>
                <li style={{ marginBottom: '6px' }}>
                  Click <strong>Personal access tokens</strong>.
                </li>
                <li style={{ marginBottom: '6px' }}>
                  Click <strong>Fine-grained tokens</strong>.
                </li>
                <li style={{ marginBottom: '6px' }}>
                  Click <strong>Generate new token</strong>.
                </li>
                <li style={{ marginBottom: '6px' }}>
                  <strong>Token name</strong>: anything memorable (e.g., "Cribl Sentinel Toolkit").
                </li>
                <li style={{ marginBottom: '6px' }}>
                  <strong>Expiration</strong>: your organization's policy (90 days is common).
                </li>
                <li style={{ marginBottom: '6px' }}>
                  <strong>Resource owner</strong>: your personal account (no org access needed).
                </li>
                <li style={{ marginBottom: '6px' }}>
                  <strong>Repository access</strong>: select <em>"Public Repositories (read-only)"</em> -- this is all that's required.
                </li>
                <li style={{ marginBottom: '6px' }}>
                  <strong>Permissions</strong>: leave defaults (read-only access to public content).
                </li>
                <li style={{ marginBottom: '6px' }}>
                  Click <strong>Generate token</strong>, then <strong>copy the token</strong> (starts with <code style={{ fontFamily: 'var(--font-mono)' }}>github_pat_...</code>).
                </li>
                <li>Paste it into the field above and click <strong>Save Token</strong>.</li>
              </ol>
              <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--border-color)', fontSize: '11px', color: 'var(--text-muted)' }}>
                Classic tokens (<code style={{ fontFamily: 'var(--font-mono)' }}>ghp_...</code>) also work -- only <code style={{ fontFamily: 'var(--font-mono)' }}>public_repo</code> scope is needed. The token is never written to disk in plaintext.
              </div>
            </div>
          )}
        </div>

        {/* SECTION 2: Azure-Sentinel repo */}
        <div style={s.section}>
          <div style={s.sectionTitle}>2. Azure-Sentinel Content</div>
          <div style={s.sectionDesc}>
            Fetches Solution definitions, analytic rules, hunting queries, parsers, workbooks, and data connectors from{' '}
            <a href="https://github.com/Azure/Azure-Sentinel" target="_blank" rel="noopener"
              style={{ color: 'var(--accent-blue)' }}>github.com/Azure/Azure-Sentinel</a>.
            Skips executables and scripts that commonly trigger EDR alerts. ~30-50MB across ~2500 text files.
          </div>

          <div style={s.repoRow}>
            <div style={s.dot(repoStateColor(sentinelReady, sentinelBusy, sentinelErr))} />
            <div style={s.repoInfo}>
              <div style={s.repoName}>
                {sentinelReady
                  ? `${sentinelRepo.solutionCount} solutions ready`
                  : sentinelBusy ? 'Fetching...'
                  : sentinelErr ? 'Error' : 'Not fetched'}
                {sentinelReady && sentinelRepo.blockedCount > 0 && (
                  <span style={{ fontWeight: 400, color: 'var(--accent-orange)', marginLeft: '6px', fontSize: '11px' }}>
                    ({sentinelRepo.blockedCount} blocked)
                  </span>
                )}
              </div>
              {sentinelBusy && (
                <div style={s.progressWrap}>
                  {sentinelPhase && (
                    <div style={s.repoDetail}>{sentinelPhase}</div>
                  )}
                  {sentinelPct && sentinelPct.total > 0 && (
                    <>
                      <div style={s.progressBarBg}>
                        <div style={s.progressBarFill(sentinelPct.pct)} />
                      </div>
                      <div style={s.progressText}>
                        <span>{sentinelPct.done.toLocaleString()} of {sentinelPct.total.toLocaleString()}</span>
                        <span>{sentinelPct.pct}%</span>
                      </div>
                    </>
                  )}
                </div>
              )}
              {sentinelErr && sentinelRepo.error && (
                <div style={{ ...s.repoDetail, color: 'var(--accent-red)' }}>{sentinelRepo.error}</div>
              )}
            </div>
            <button className="btn-primary" style={{ fontSize: '12px', padding: '6px 16px' }}
              onClick={fetchSentinel}
              disabled={!ghHasPat || sentinelBusy}>
              {sentinelBusy ? 'Fetching...' : sentinelReady ? 'Refresh' : 'Fetch'}
            </button>
          </div>

          {/* Blocked Solutions (EDR) */}
          {blocklist.length > 0 && (
            <div style={s.blockedSection}>
              <div style={s.blockedHeader} onClick={() => setBlocklistOpen(!blocklistOpen)}>
                <span style={{ fontSize: '10px' }}>{blocklistOpen ? 'v' : '>'}</span>
                <span>{blocklist.length} solution{blocklist.length !== 1 ? 's' : ''} blocked by EDR policy</span>
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
                These solutions contain content that triggers EDR false positives (offensive security tool references, attack pattern hashes).
                Skipping them prevents the fetch from being terminated.
              </div>
              {blocklistOpen && (
                <div style={s.blockedList}>
                  {blocklist.map((item) => (
                    <div key={item.name} style={s.blockedItem}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '2px' }}>
                          {item.name}
                          <span style={{ ...s.blockedBadge(item.source), marginLeft: '6px' }}>{item.source}</span>
                        </div>
                        <div style={{ color: 'var(--text-muted)', lineHeight: 1.4 }}>{item.reason}</div>
                      </div>
                      {item.source !== 'built-in' && (
                        <button className="btn-secondary"
                          style={{ fontSize: '10px', padding: '2px 8px', flexShrink: 0, marginTop: '2px' }}
                          onClick={() => retryBlockedSolution(item.name)}
                          title="Remove from local blocklist. The next fetch will attempt this solution again. If EDR kills the process, it will be re-added automatically.">
                          Retry
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* SECTION 3: Elastic Integrations */}
        <div style={s.section}>
          <div style={s.sectionTitle}>3. Elastic Integrations Sample Data</div>
          <div style={s.sectionDesc}>
            Fetches raw vendor log samples from{' '}
            <a href="https://github.com/elastic/integrations" target="_blank" rel="noopener"
              style={{ color: 'var(--accent-blue)' }}>github.com/elastic/integrations</a>
            {' '}-- used to drive pack field mapping and reduction rule generation.
            Only the test pipeline data is fetched (~5MB total across 20+ vendors).
          </div>

          <div style={s.repoRow}>
            <div style={s.dot(repoStateColor(elasticReady, elasticBusy, elasticErr))} />
            <div style={s.repoInfo}>
              <div style={s.repoName}>
                {elasticReady
                  ? `${elasticRepo.packageCount} sample files ready`
                  : elasticBusy ? 'Fetching...'
                  : elasticErr ? 'Error' : 'Not fetched'}
              </div>
              {elasticBusy && elasticPct && elasticPct.total > 0 && (
                <div style={s.progressWrap}>
                  <div style={s.progressBarBg}>
                    <div style={s.progressBarFill(elasticPct.pct)} />
                  </div>
                  <div style={s.progressText}>
                    <span>{elasticPct.done} of {elasticPct.total} packages</span>
                    <span>{elasticPct.pct}%</span>
                  </div>
                </div>
              )}
              {elasticErr && elasticRepo.error && (
                <div style={{ ...s.repoDetail, color: 'var(--accent-red)' }}>{elasticRepo.error}</div>
              )}
            </div>
            <button className="btn-primary" style={{ fontSize: '12px', padding: '6px 16px' }}
              onClick={fetchElastic}
              disabled={!ghHasPat || elasticBusy}>
              {elasticBusy ? 'Fetching...' : elasticReady ? 'Refresh' : 'Fetch'}
            </button>
          </div>
        </div>

        {/* Wizard continue footer */}
        {wizard && (
          <div style={s.footer}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              {!ghHasPat
                ? 'Add a GitHub token to continue.'
                : !sentinelReady
                ? 'Fetch the Sentinel repository to continue.'
                : !elasticReady
                ? 'Fetch Elastic samples or continue without them.'
                : 'Repositories ready.'}
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="btn-success" style={{ fontSize: '13px', padding: '8px 24px', fontWeight: 700 }}
                onClick={onContinue}
                disabled={!ghHasPat || !sentinelReady || sentinelBusy || elasticBusy}>
                {bothReady ? 'Continue' : 'Continue Without Repos'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default RepoSetup;
