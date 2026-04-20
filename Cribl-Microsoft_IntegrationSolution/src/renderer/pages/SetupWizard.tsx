// Setup Wizard -- First-run onboarding for credential configuration and mode selection.
// Appears when no saved credentials exist, or when user clicks "Reconfigure" in Settings.

import { useState, useEffect } from 'react';

interface SetupWizardProps {
  onComplete: (mode: string) => void;
}

type Step = 'cribl' | 'azure' | 'mode';

const s = {
  page: {
    display: 'flex', flexDirection: 'column' as const, alignItems: 'center',
    justifyContent: 'center', minHeight: '100vh', padding: '40px',
    background: 'var(--bg-primary)',
  } as React.CSSProperties,
  card: {
    maxWidth: '640px', width: '100%', background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)', borderRadius: '8px',
    padding: '32px', boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
  } as React.CSSProperties,
  title: { fontSize: '22px', fontWeight: 700, marginBottom: '4px' } as React.CSSProperties,
  subtitle: { fontSize: '13px', color: 'var(--text-muted)', marginBottom: '24px' } as React.CSSProperties,
  stepIndicator: {
    display: 'flex', gap: '8px', marginBottom: '24px',
  } as React.CSSProperties,
  stepDot: (active: boolean, done: boolean) => ({
    width: '32px', height: '4px', borderRadius: '2px',
    background: done ? 'var(--accent-green)' : active ? 'var(--accent-blue)' : 'var(--bg-input)',
  } as React.CSSProperties),
  label: { fontSize: '12px', fontWeight: 600, marginBottom: '6px', color: 'var(--text-secondary)' } as React.CSSProperties,
  input: {
    width: '100%', padding: '8px 12px', fontSize: '13px',
    background: 'var(--bg-input)', border: '1px solid var(--border-color)',
    borderRadius: '4px', color: 'var(--text-primary)', marginBottom: '12px',
  } as React.CSSProperties,
  select: {
    width: '100%', padding: '8px 12px', fontSize: '13px',
    background: 'var(--bg-input)', border: '1px solid var(--border-color)',
    borderRadius: '4px', color: 'var(--text-primary)', marginBottom: '12px',
  } as React.CSSProperties,
  row: { display: 'flex', gap: '12px', marginBottom: '12px' } as React.CSSProperties,
  field: { flex: 1 } as React.CSSProperties,
  status: (ok: boolean) => ({
    display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px',
    borderRadius: '4px', fontSize: '12px', marginBottom: '16px',
    background: ok ? 'rgba(102, 187, 106, 0.08)' : 'rgba(239, 83, 80, 0.08)',
    border: `1px solid ${ok ? 'rgba(102, 187, 106, 0.25)' : 'rgba(239, 83, 80, 0.25)'}`,
    color: ok ? 'var(--accent-green)' : 'var(--accent-red)',
  } as React.CSSProperties),
  dot: (ok: boolean) => ({
    width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
    background: ok ? 'var(--accent-green)' : 'var(--accent-red)',
  } as React.CSSProperties),
  actions: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '24px',
  } as React.CSSProperties,
  modeCard: (selected: boolean, available: boolean) => ({
    padding: '14px 16px', borderRadius: '6px', cursor: available ? 'pointer' : 'not-allowed',
    border: `2px solid ${selected ? 'var(--accent-blue)' : 'var(--border-color)'}`,
    background: selected ? 'rgba(79, 195, 247, 0.08)' : available ? 'var(--bg-input)' : 'rgba(255,255,255,0.02)',
    opacity: available ? 1 : 0.5, marginBottom: '8px',
  } as React.CSSProperties),
  modeTitle: { fontSize: '13px', fontWeight: 700 } as React.CSSProperties,
  modeDesc: { fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' } as React.CSSProperties,
  badge: (color: string) => ({
    fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '3px',
    background: `rgba(${color}, 0.15)`, color: `rgb(${color})`, marginLeft: '8px',
  } as React.CSSProperties),
};

function SetupWizard({ onComplete }: SetupWizardProps) {
  const [step, setStep] = useState<Step>('cribl');

  // Cribl state
  const [criblClientId, setCriblClientId] = useState('');
  const [criblSecret, setCriblSecret] = useState('');
  const [criblDeployType, setCriblDeployType] = useState<'cloud' | 'self-managed'>('cloud');
  const [criblOrgId, setCriblOrgId] = useState('');
  const [criblLeaderAddr, setCriblLeaderAddr] = useState('');
  const [criblLeaderPort, setCriblLeaderPort] = useState('9000');
  const [criblLeaderProtocol, setCriblLeaderProtocol] = useState<'https' | 'http'>('https');
  const [criblConnected, setCriblConnected] = useState(false);
  const [criblTesting, setCriblTesting] = useState(false);
  const [criblError, setCriblError] = useState('');
  const [criblSkipped, setCriblSkipped] = useState(false);

  // Saved profiles for both deployment types (loaded from disk, swapped on toggle)
  const [savedCloud, setSavedCloud] = useState<{ clientId: string; organizationId: string; hasSecret: boolean } | null>(null);
  const [savedSelfManaged, setSavedSelfManaged] = useState<{ clientId: string; baseUrl: string; hasSecret: boolean } | null>(null);

  // Derive base URL from deployment type + user input
  const criblBaseUrl = criblDeployType === 'cloud'
    ? (criblOrgId ? `https://main-${criblOrgId}.cribl.cloud` : '')
    : (criblLeaderAddr ? `${criblLeaderProtocol}://${criblLeaderAddr}${criblLeaderPort ? ':' + criblLeaderPort : ''}` : '');

  // Azure state
  const [azureConnected, setAzureConnected] = useState(false);
  const [azureAccount, setAzureAccount] = useState('');
  const [azureSubscription, setAzureSubscription] = useState('');
  const [azureTenant, setAzureTenant] = useState('');
  const [azureChecking, setAzureChecking] = useState(false);
  const [azureSkipped, setAzureSkipped] = useState(false);

  // Mode
  const [selectedMode, setSelectedMode] = useState('');

  // Repo status
  const [sentinelRepo, setSentinelRepo] = useState<{ state: string; solutionCount: number; error: string }>({ state: 'unknown', solutionCount: 0, error: '' });
  const [elasticRepo, setElasticRepo] = useState<{ state: string; packageCount: number; error: string }>({ state: 'unknown', packageCount: 0, error: '' });
  const [sentinelCloning, setSentinelCloning] = useState(false);
  const [elasticCloning, setElasticCloning] = useState(false);

  // Load saved Cribl credentials on mount (pre-fill form, but don't auto-connect)
  const [savedLoaded, setSavedLoaded] = useState(false);
  useEffect(() => {
    if (!window.api || savedLoaded) return;
    setSavedLoaded(true);
    (async () => {
      try {
        const saved = await window.api.auth.criblSaved();
        if (!saved) return;

        // Store both saved profiles for toggling
        if (saved.cloud) setSavedCloud(saved.cloud as any);
        if (saved.selfManaged) setSavedSelfManaged(saved.selfManaged as any);

        // Set active deployment type and populate form fields
        const activeType = (saved.deploymentType as 'cloud' | 'self-managed') || 'cloud';
        setCriblDeployType(activeType);

        if (activeType === 'cloud') {
          const profile = saved.cloud || saved;
          setCriblClientId((profile as any).clientId || '');
          setCriblOrgId((profile as any).organizationId || saved.organizationId || '');
        } else {
          const profile = saved.selfManaged || saved;
          setCriblClientId((profile as any).clientId || '');
          const baseUrl = (profile as any).baseUrl || saved.baseUrl;
          if (baseUrl) {
            try {
              const url = new URL(baseUrl);
              setCriblLeaderProtocol(url.protocol === 'http:' ? 'http' : 'https');
              setCriblLeaderAddr(url.hostname);
              setCriblLeaderPort(url.port || (url.protocol === 'http:' ? '80' : '9000'));
            } catch { /* skip */ }
          }
        }
      } catch { /* no saved credentials */ }
    })();
  }, []);

  // Load repo status
  useEffect(() => {
    if (!window.api) return;
    window.api.sentinelRepo?.status().then((s: any) => setSentinelRepo(s)).catch(() => {});
    (window.api as any).elasticRepo?.status().then((s: any) => setElasticRepo(s)).catch(() => {});
    const unsubSentinel = window.api.sentinelRepo?.onStatus?.((s: any) => setSentinelRepo(s));
    const unsubElastic = (window.api as any).elasticRepo?.onStatus?.((s: any) => setElasticRepo(s));
    return () => { unsubSentinel?.(); unsubElastic?.(); };
  }, []);

  const cloneSentinelRepo = async () => {
    if (!window.api) return;
    setSentinelCloning(true);
    try {
      await window.api.sentinelRepo.sync();
    } catch { /* handled by status updates */ }
    setSentinelCloning(false);
  };

  const cloneElasticRepo = async () => {
    if (!window.api) return;
    setElasticCloning(true);
    try {
      await (window.api as any).elasticRepo.clone();
    } catch { /* handled by status updates */ }
    setElasticCloning(false);
  };

  // Test Cribl connection
  const testCribl = async () => {
    if (!window.api || !criblClientId || !criblSecret || !criblBaseUrl) return;
    setCriblTesting(true);
    setCriblError('');
    try {
      const result = await window.api.auth.criblConnect({
        clientId: criblClientId,
        clientSecret: criblSecret,
        baseUrl: criblBaseUrl,
        deploymentType: criblDeployType,
        organizationId: criblDeployType === 'cloud' ? criblOrgId : undefined,
        saveCredentials: true,
      });
      setCriblConnected(result.success);
      if (!result.success) setCriblError(result.error || 'Connection failed');
    } catch (err) {
      setCriblError(err instanceof Error ? err.message : 'Connection failed');
    }
    setCriblTesting(false);
  };

  // Check Azure session
  const checkAzure = async () => {
    if (!window.api) return;
    setAzureChecking(true);
    try {
      const status = await window.api.auth.azureStatus();
      setAzureConnected(status.loggedIn);
      if (status.loggedIn) {
        setAzureAccount(status.accountId);
        setAzureSubscription(status.subscriptionName || status.subscriptionId);
        setAzureTenant(status.tenantId);
      }
    } catch { /* skip */ }
    setAzureChecking(false);
  };

  // Azure login
  const loginAzure = async () => {
    if (!window.api) return;
    setAzureChecking(true);
    try {
      const result = await window.api.auth.azureLogin();
      setAzureConnected(result.loggedIn);
      if (result.loggedIn) {
        setAzureAccount(result.accountId);
        setAzureSubscription(result.subscriptionName || result.subscriptionId);
        setAzureTenant(result.tenantId);
      }
    } catch { /* skip */ }
    setAzureChecking(false);
  };

  // Determine available modes
  const hasCribl = criblConnected && !criblSkipped;
  const hasAzure = azureConnected && !azureSkipped;

  // Auto-select mode based on connections
  useEffect(() => {
    if (step === 'mode') {
      if (hasCribl && hasAzure) setSelectedMode('full');
      else if (hasAzure && !hasCribl) setSelectedMode('azure-only');
      else if (hasCribl && !hasAzure) setSelectedMode('cribl-only');
      else setSelectedMode('air-gapped');
    }
  }, [step, hasCribl, hasAzure]);

  const handleComplete = async () => {
    // Save mode to config
    if (window.api) {
      try {
        await window.api.config.write('integration-mode.json', { mode: selectedMode });
      } catch { /* non-fatal */ }
    }
    onComplete(selectedMode);
  };

  const stepDone = (s: Step) => {
    if (s === 'cribl') return criblConnected || criblSkipped;
    if (s === 'azure') return azureConnected || azureSkipped;
    return false;
  };

  return (
    <div style={s.page}>
      <div style={s.card}>
        <div style={s.title}>Cribl SOC Optimization Toolkit for Microsoft Sentinel</div>
        <div style={s.subtitle}>Configure connections to Cribl Stream and Microsoft Azure</div>

        {/* Step indicator */}
        <div style={s.stepIndicator}>
          {(['cribl', 'azure', 'mode'] as Step[]).map((st) => (
            <div key={st} style={s.stepDot(step === st, stepDone(st))} />
          ))}
        </div>

        {/* Step 1: Cribl */}
        {step === 'cribl' && (
          <div>
            <div style={{ fontSize: '15px', fontWeight: 700, marginBottom: '8px' }}>
              Step 1: Cribl Stream Connection
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '16px', lineHeight: 1.5 }}>
              For Cribl Cloud, provide your Organization ID and OAuth client credentials.
              For on-prem / self-managed leaders, provide the leader IP or FQDN and admin credentials.
              Credentials are encrypted on disk using your OS keychain (Windows DPAPI / macOS Keychain).
              The app requests an access token and uses it to manage packs, routes, destinations,
              and capture live events. No credentials are sent to third parties.
            </div>

            {criblConnected ? (
              <div style={s.status(true)}>
                <div style={s.dot(true)} />
                <div>
                  <div>Connected to Cribl Stream</div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px', fontFamily: 'var(--font-mono)' }}>
                    {criblDeployType === 'cloud' ? `Organization: ${criblOrgId}` : `Leader: ${criblLeaderAddr}${criblLeaderPort ? ':' + criblLeaderPort : ''}`}
                    {' | '}{criblBaseUrl}
                  </div>
                </div>
              </div>
            ) : (
              <>
                <div style={s.row}>
                  <div style={s.field}>
                    <div style={s.label}>Deployment Type</div>
                    <select style={s.select} value={criblDeployType}
                      onChange={(e) => {
                        const newType = e.target.value as 'cloud' | 'self-managed';
                        setCriblDeployType(newType);
                        setCriblError('');
                        setCriblConnected(false);
                        setCriblSecret('');
                        // Swap form fields from saved profile for the selected type
                        if (newType === 'cloud' && savedCloud) {
                          setCriblClientId(savedCloud.clientId || '');
                          setCriblOrgId(savedCloud.organizationId || '');
                        } else if (newType === 'self-managed' && savedSelfManaged) {
                          setCriblClientId(savedSelfManaged.clientId || '');
                          if (savedSelfManaged.baseUrl) {
                            try {
                              const url = new URL(savedSelfManaged.baseUrl);
                              setCriblLeaderProtocol(url.protocol === 'http:' ? 'http' : 'https');
                              setCriblLeaderAddr(url.hostname);
                              setCriblLeaderPort(url.port || (url.protocol === 'http:' ? '80' : '9000'));
                            } catch { /* skip */ }
                          }
                        }
                      }}>
                      <option value="cloud">Cribl Cloud</option>
                      <option value="self-managed">On-Prem / Self-Managed</option>
                    </select>
                  </div>
                </div>

                {criblDeployType === 'cloud' ? (
                  <div style={{ marginBottom: '12px' }}>
                    <div style={s.label}>Organization ID</div>
                    <input style={s.input} value={criblOrgId}
                      onChange={(e) => setCriblOrgId(e.target.value.trim())}
                      placeholder="myorg" />
                    {criblOrgId && (
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '-8px', marginBottom: '12px', fontFamily: 'var(--font-mono)' }}>
                        Base URL: https://main-{criblOrgId}.cribl.cloud
                      </div>
                    )}
                  </div>
                ) : (
                  <div>
                    <div style={s.row}>
                      <div style={{ flex: 1 }}>
                        <div style={s.label}>Protocol</div>
                        <select style={s.select} value={criblLeaderProtocol}
                          onChange={(e) => setCriblLeaderProtocol(e.target.value as 'https' | 'http')}>
                          <option value="https">HTTPS</option>
                          <option value="http">HTTP</option>
                        </select>
                      </div>
                      <div style={{ flex: 3 }}>
                        <div style={s.label}>Leader Address (IP or FQDN)</div>
                        <input style={s.input} value={criblLeaderAddr}
                          onChange={(e) => setCriblLeaderAddr(e.target.value.trim())}
                          placeholder="cribl-leader.internal or 10.0.1.50" />
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={s.label}>Port</div>
                        <input style={s.input} value={criblLeaderPort}
                          onChange={(e) => setCriblLeaderPort(e.target.value.trim())}
                          placeholder="9000" />
                      </div>
                    </div>
                    {criblLeaderAddr && (
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '-8px', marginBottom: '12px', fontFamily: 'var(--font-mono)' }}>
                        Base URL: {criblLeaderProtocol}://{criblLeaderAddr}{criblLeaderPort ? ':' + criblLeaderPort : ''}
                      </div>
                    )}
                  </div>
                )}

                <div style={s.row}>
                  <div style={s.field}>
                    <div style={s.label}>{criblDeployType === 'cloud' ? 'Client ID' : 'Username'}</div>
                    <input style={s.input} value={criblClientId}
                      onChange={(e) => setCriblClientId(e.target.value)}
                      placeholder={criblDeployType === 'cloud' ? 'OAuth Client ID' : 'Admin username'} />
                  </div>
                  <div style={s.field}>
                    <div style={s.label}>{criblDeployType === 'cloud' ? 'Client Secret' : 'Password'}</div>
                    <input style={{ ...s.input, fontFamily: 'var(--font-mono)' }} type="password"
                      value={criblSecret}
                      onChange={(e) => setCriblSecret(e.target.value)}
                      placeholder={criblDeployType === 'cloud' ? 'OAuth Client Secret' : 'Admin password'} />
                  </div>
                </div>

                {savedLoaded && criblClientId && !criblConnected && (
                  (criblDeployType === 'cloud' ? savedCloud?.hasSecret : savedSelfManaged?.hasSecret)) && (
                  <div style={{
                    fontSize: '11px', color: 'var(--accent-blue)', marginBottom: '8px',
                    padding: '8px 12px', borderRadius: '4px',
                    background: 'rgba(79, 195, 247, 0.08)', border: '1px solid rgba(79, 195, 247, 0.2)',
                    display: 'flex', alignItems: 'center', gap: '12px',
                  }}>
                    <span style={{ flex: 1 }}>
                      Saved connection found. Credentials are encrypted with your OS keychain.
                    </span>
                    <button
                      className="btn-primary"
                      style={{ fontSize: '11px', padding: '4px 14px', flexShrink: 0 }}
                      onClick={async () => {
                        if (!window.api) return;
                        setCriblTesting(true);
                        setCriblError('');
                        try {
                          // Pass current form values as overrides so the saved secret
                          // is used but deployment type / base URL / org ID reflect
                          // what the user currently has selected in the form.
                          const result = await window.api.auth.criblReconnect({
                            deploymentType: criblDeployType,
                            baseUrl: criblBaseUrl,
                            organizationId: criblDeployType === 'cloud' ? criblOrgId : undefined,
                            clientId: criblClientId,
                          });
                          setCriblConnected(result.success);
                          if (!result.success) setCriblError(result.error || 'Reconnect failed');
                        } catch (err) {
                          setCriblError(err instanceof Error ? err.message : 'Reconnect failed');
                        }
                        setCriblTesting(false);
                      }}
                      disabled={criblTesting}
                    >
                      {criblTesting ? 'Connecting...' : 'Reconnect'}
                    </button>
                  </div>
                )}

                {criblError && (
                  <div style={s.status(false)}>
                    <div style={s.dot(false)} />
                    {criblError}
                  </div>
                )}
              </>
            )}

            <div style={s.actions}>
              <button className="btn-secondary" style={{ fontSize: '12px', padding: '8px 16px' }}
                onClick={() => { setCriblSkipped(true); setStep('azure'); }}>
                Skip Cribl
              </button>
              <div style={{ display: 'flex', gap: '8px' }}>
                {!criblConnected && (
                  <button className="btn-primary" style={{ fontSize: '12px', padding: '8px 20px' }}
                    onClick={testCribl}
                    disabled={criblTesting || !criblClientId || !criblSecret || !criblBaseUrl}>
                    {criblTesting ? 'Testing...' : 'Test Connection'}
                  </button>
                )}
                {(criblConnected || criblSkipped) && (
                  <button className="btn-primary" style={{ fontSize: '12px', padding: '8px 20px' }}
                    onClick={() => setStep('azure')}>
                    Next
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Step 2: Azure */}
        {step === 'azure' && (
          <div>
            <div style={{ fontSize: '15px', fontWeight: 700, marginBottom: '8px' }}>
              Step 2: Microsoft Azure Connection
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '16px', lineHeight: 1.5 }}>
              The app leverages your existing Azure PowerShell session (Connect-AzAccount).
              No Azure credentials are stored by this application -- it uses the token already
              cached by the Az PowerShell module. The app calls Azure REST APIs to deploy Data Collection
              Rules, create custom tables, and query Log Analytics workspaces. You need Contributor or
              Owner role on the target resource group.
            </div>

            {azureConnected ? (
              <div style={s.status(true)}>
                <div style={s.dot(true)} />
                <div>
                  <div>Signed in as {azureAccount}</div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>
                    Subscription: {azureSubscription} | Tenant: {azureTenant}
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ marginBottom: '16px' }}>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px', lineHeight: 1.5 }}>
                  The app uses your existing Azure PowerShell session. Run <code style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-input)', padding: '1px 6px', borderRadius: '3px' }}>Connect-AzAccount</code> in a PowerShell terminal first, then click Detect Session below.
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button className="btn-primary" style={{ fontSize: '12px', padding: '8px 16px' }}
                    onClick={checkAzure} disabled={azureChecking}>
                    {azureChecking ? 'Detecting...' : 'Detect Existing Session'}
                  </button>
                </div>
              </div>
            )}

            <div style={s.actions}>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn-secondary" style={{ fontSize: '12px', padding: '8px 16px' }}
                  onClick={() => setStep('cribl')}>
                  Back
                </button>
                <button className="btn-secondary" style={{ fontSize: '12px', padding: '8px 16px' }}
                  onClick={() => { setAzureSkipped(true); setStep('mode'); }}>
                  Skip Azure
                </button>
              </div>
              <button className="btn-primary" style={{ fontSize: '12px', padding: '8px 20px' }}
                onClick={() => setStep('mode')}
                disabled={!azureConnected && !azureSkipped}>
                {azureConnected ? 'Next' : 'Skip Azure'}
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Mode Selection */}
        {step === 'mode' && (
          <div>
            <div style={{ fontSize: '15px', fontWeight: 700, marginBottom: '16px' }}>
              Step 3: Integration Mode
            </div>

            {[
              {
                id: 'full', label: 'Full Integration', available: hasCribl && hasAzure,
                color: '102, 187, 106',
                desc: 'Deploy DCRs to Azure, build and upload packs to Cribl, wire sources, validate data flow end-to-end',
              },
              {
                id: 'azure-only', label: 'Azure Only', available: hasAzure,
                color: '79, 195, 247',
                desc: 'Deploy DCRs and custom tables to Azure. Build Cribl packs as .crbl files for manual import',
              },
              {
                id: 'cribl-only', label: 'Cribl Only', available: hasCribl,
                color: '255, 167, 38',
                desc: 'Upload packs to Cribl, wire sources. Generate ARM templates for manual Azure deployment',
              },
              {
                id: 'air-gapped', label: 'Air-Gapped (Offline)', available: true,
                color: '171, 71, 188',
                desc: 'No cloud connectivity required. Export .crbl packs, ARM templates, and deployment instructions for manual deployment',
              },
            ].map((mode) => (
              <div key={mode.id}
                style={s.modeCard(selectedMode === mode.id, mode.available)}
                onClick={() => mode.available && setSelectedMode(mode.id)}>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <div style={{ width: '16px', height: '16px', borderRadius: '50%', border: '2px solid var(--border-color)', marginRight: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {selectedMode === mode.id && <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--accent-blue)' }} />}
                  </div>
                  <span style={s.modeTitle}>{mode.label}</span>
                  {!mode.available && <span style={s.badge('239, 83, 80')}>Requires connection</span>}
                  {mode.id === 'full' && mode.available && <span style={s.badge('102, 187, 106')}>Recommended</span>}
                </div>
                <div style={{ ...s.modeDesc, marginLeft: '26px' }}>{mode.desc}</div>
              </div>
            ))}

            {/* Connection & repo summary */}
            <div style={{ marginTop: '16px', padding: '12px 14px', background: 'var(--bg-input)', borderRadius: '4px', fontSize: '11px' }}>
              <div style={{ fontWeight: 600, fontSize: '10px', color: 'var(--text-muted)', marginBottom: '8px', textTransform: 'uppercase' as const, letterSpacing: '0.5px' }}>Connections</div>
              <div style={{ display: 'flex', gap: '16px', marginBottom: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <div style={s.dot(hasCribl)} />
                  <span style={{ color: 'var(--text-secondary)' }}>Cribl: {hasCribl ? 'Connected' : criblSkipped ? 'Skipped' : 'Not connected'}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <div style={s.dot(hasAzure)} />
                  <span style={{ color: 'var(--text-secondary)' }}>Azure: {hasAzure ? azureAccount : azureSkipped ? 'Skipped' : 'Not connected'}</span>
                </div>
              </div>

              <div style={{ fontWeight: 600, fontSize: '10px', color: 'var(--text-muted)', marginBottom: '8px', textTransform: 'uppercase' as const, letterSpacing: '0.5px' }}>Repositories</div>
              {/* Sentinel repo */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                <div style={{
                  width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
                  background: sentinelRepo.state === 'ready' && sentinelRepo.solutionCount > 0
                    ? 'var(--accent-green)'
                    : sentinelRepo.state === 'cloning' || sentinelCloning ? 'var(--accent-blue)'
                    : sentinelRepo.state === 'error' ? 'var(--accent-red)' : 'var(--text-muted)',
                }} />
                <span style={{ color: 'var(--text-secondary)', flex: 1 }}>
                  Sentinel: {sentinelRepo.state === 'ready' && sentinelRepo.solutionCount > 0
                    ? `${sentinelRepo.solutionCount} solutions`
                    : sentinelCloning || sentinelRepo.state === 'cloning' ? 'Cloning...'
                    : sentinelRepo.state === 'error' ? `Error: ${sentinelRepo.error}`
                    : 'Not cloned'}
                </span>
                <button className="btn-secondary" style={{ fontSize: '10px', padding: '2px 10px', flexShrink: 0 }}
                  onClick={cloneSentinelRepo}
                  disabled={sentinelCloning || sentinelRepo.state === 'cloning'}>
                  {sentinelCloning || sentinelRepo.state === 'cloning' ? 'Cloning...'
                    : sentinelRepo.state === 'ready' && sentinelRepo.solutionCount > 0 ? 'Refresh' : 'Clone'}
                </button>
              </div>
              {/* Elastic repo */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{
                  width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
                  background: elasticRepo.state === 'ready' && elasticRepo.packageCount > 0
                    ? 'var(--accent-green)'
                    : elasticRepo.state === 'cloning' || elasticCloning ? 'var(--accent-blue)'
                    : elasticRepo.state === 'error' ? 'var(--accent-red)' : 'var(--text-muted)',
                }} />
                <span style={{ color: 'var(--text-secondary)', flex: 1 }}>
                  Elastic: {elasticRepo.state === 'ready' && elasticRepo.packageCount > 0
                    ? `${elasticRepo.packageCount} samples`
                    : elasticCloning || elasticRepo.state === 'cloning' ? 'Cloning...'
                    : elasticRepo.state === 'error' ? `Error: ${elasticRepo.error}`
                    : 'Not cloned'}
                </span>
                <button className="btn-secondary" style={{ fontSize: '10px', padding: '2px 10px', flexShrink: 0 }}
                  onClick={cloneElasticRepo}
                  disabled={elasticCloning || elasticRepo.state === 'cloning'}>
                  {elasticCloning || elasticRepo.state === 'cloning' ? 'Cloning...'
                    : elasticRepo.state === 'ready' && elasticRepo.packageCount > 0 ? 'Refresh' : 'Clone'}
                </button>
              </div>
            </div>

            <div style={s.actions}>
              <button className="btn-secondary" style={{ fontSize: '12px', padding: '8px 16px' }}
                onClick={() => setStep('azure')}>
                Back
              </button>
              <button className="btn-success" style={{ fontSize: '14px', fontWeight: 700, padding: '10px 28px' }}
                onClick={handleComplete}
                disabled={!selectedMode}>
                Get Started
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default SetupWizard;
