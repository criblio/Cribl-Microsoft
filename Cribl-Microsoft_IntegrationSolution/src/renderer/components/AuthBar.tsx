import { useState, useEffect, useCallback } from 'react';

interface CriblStatus {
  connected: boolean;
  baseUrl: string;
  error?: string;
}

interface AzureStatus {
  loggedIn: boolean;
  accountId: string;
  subscriptionId: string;
  subscriptionName: string;
  tenantId: string;
  error?: string;
}

interface CriblConnectForm {
  clientId: string;
  clientSecret: string;
  organizationId: string;
  deploymentType: 'cloud' | 'self-managed';
  selfManagedUrl: string;
}

const s = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: '0',
    height: '32px',
    borderBottom: '1px solid var(--border-color)',
    background: 'var(--bg-secondary)',
    fontSize: '11px',
    flexShrink: 0,
    overflow: 'hidden',
  } as React.CSSProperties,
  section: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '0 12px',
    height: '100%',
    borderRight: '1px solid var(--border-color)',
    whiteSpace: 'nowrap' as const,
    cursor: 'pointer',
    userSelect: 'none' as const,
  } as React.CSSProperties,
  dot: (active: boolean) => ({
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    background: active ? 'var(--accent-green)' : 'var(--accent-red)',
    flexShrink: 0,
  } as React.CSSProperties),
  label: {
    color: 'var(--text-muted)',
    fontWeight: 600,
    fontSize: '10px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  } as React.CSSProperties,
  value: {
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    maxWidth: '220px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  } as React.CSSProperties,
  disconnected: {
    color: 'var(--text-muted)',
    fontStyle: 'italic' as const,
  } as React.CSSProperties,
  spacer: {
    flex: 1,
  } as React.CSSProperties,
  // Popup styles
  overlay: {
    position: 'fixed' as const,
    top: 0, left: 0, right: 0, bottom: 0,
    background: 'rgba(0, 0, 0, 0.4)',
    zIndex: 1000,
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingTop: '60px',
  } as React.CSSProperties,
  popup: {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--radius)',
    padding: '20px',
    width: '420px',
    maxHeight: '80vh',
    overflow: 'auto',
    boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
  } as React.CSSProperties,
  popupTitle: {
    fontSize: '14px',
    fontWeight: 700,
    marginBottom: '16px',
  } as React.CSSProperties,
  fieldGroup: {
    marginBottom: '12px',
  } as React.CSSProperties,
  fieldLabel: {
    fontSize: '11px',
    fontWeight: 600,
    color: 'var(--text-secondary)',
    marginBottom: '4px',
  } as React.CSSProperties,
  input: {
    width: '100%',
    padding: '6px 10px',
    fontSize: '12px',
    fontFamily: 'var(--font-mono)',
    background: 'var(--bg-input)',
    border: '1px solid var(--border-color)',
    borderRadius: '4px',
    color: 'var(--text-primary)',
    boxSizing: 'border-box' as const,
  } as React.CSSProperties,
  select: {
    width: '100%',
    padding: '6px 10px',
    fontSize: '12px',
    background: 'var(--bg-input)',
    border: '1px solid var(--border-color)',
    borderRadius: '4px',
    color: 'var(--text-primary)',
  } as React.CSSProperties,
  popupActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
    marginTop: '16px',
    paddingTop: '12px',
    borderTop: '1px solid var(--border-color)',
  } as React.CSSProperties,
  statusRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 10px',
    background: 'var(--bg-input)',
    borderRadius: '4px',
    marginBottom: '12px',
    fontSize: '11px',
  } as React.CSSProperties,
  errorText: {
    color: 'var(--accent-red)',
    fontSize: '11px',
    marginTop: '8px',
  } as React.CSSProperties,
};

function AuthBar() {
  const [cribl, setCribl] = useState<CriblStatus>({ connected: false, baseUrl: '' });
  const [azure, setAzure] = useState<AzureStatus>({
    loggedIn: false, accountId: '', subscriptionId: '', subscriptionName: '', tenantId: '',
  });
  const [showCriblPopup, setShowCriblPopup] = useState(false);
  const [showAzurePopup, setShowAzurePopup] = useState(false);
  const [criblForm, setCriblForm] = useState<CriblConnectForm>({
    clientId: '', clientSecret: '', organizationId: '',
    deploymentType: 'cloud', selfManagedUrl: '',
  });
  const [saveCredentials, setSaveCredentials] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [error, setError] = useState('');
  const [subscriptions, setSubscriptions] = useState<Array<{ id: string; name: string }>>([]);
  const [workspaces, setWorkspaces] = useState<Array<{ name: string; resourceGroup: string; location: string; customerId: string }>>([]);
  const [selectedSub, setSelectedSub] = useState('');
  const [selectedWs, setSelectedWs] = useState('');
  const [loadingAzure, setLoadingAzure] = useState(false);
  const [mode, setMode] = useState('full');

  // Load integration mode
  useEffect(() => {
    if (!window.api) return;
    window.api.config.read('integration-mode.json')
      .then((c: any) => setMode(c?.mode || 'full'))
      .catch(() => {});
  }, []);

  const refreshStatus = useCallback(async () => {
    if (!window.api) return;
    try {
      // Check integration mode -- skip auth checks for skipped services
      let mode = 'full';
      try {
        const config = await window.api.config.read('integration-mode.json') as any;
        mode = config?.mode || 'full';
      } catch { /* no config yet */ }

      if (mode === 'air-gapped') {
        setCribl({ connected: false, baseUrl: '', error: 'Air-gapped mode' });
        setAzure({ loggedIn: false, accountId: '', subscriptionId: '', subscriptionName: '', tenantId: '', error: 'Air-gapped mode' });
        return;
      }

      const status = await window.api.auth.status();

      if (mode === 'azure-only') {
        setCribl({ connected: false, baseUrl: '', error: 'Cribl skipped' });
        setAzure(status.azure);
      } else if (mode === 'cribl-only') {
        setCribl(status.cribl);
        setAzure({ loggedIn: false, accountId: '', subscriptionId: '', subscriptionName: '', tenantId: '', error: 'Azure skipped' });
      } else {
        setCribl(status.cribl);
        setAzure(status.azure);
      }
    } catch { /* not ready */ }
  }, []);

  useEffect(() => {
    refreshStatus();
    const interval = setInterval(refreshStatus, 30000);
    return () => clearInterval(interval);
  }, [refreshStatus]);

  const handleCriblConnect = async () => {
    if (!window.api) return;
    setConnecting(true);
    setError('');
    try {
      const baseUrl = criblForm.deploymentType === 'cloud'
        ? `https://main-${criblForm.organizationId}.cribl.cloud`
        : criblForm.selfManagedUrl.replace(/\/$/, '');
      const result = await window.api.auth.criblConnect({
        clientId: criblForm.clientId,
        clientSecret: criblForm.clientSecret,
        baseUrl,
        deploymentType: criblForm.deploymentType,
        organizationId: criblForm.organizationId,
        saveCredentials,
      });
      if (result.success) {
        setShowCriblPopup(false);
        refreshStatus();
      } else {
        setError(result.error || 'Connection failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
    }
    setConnecting(false);
  };

  const handleCriblDisconnect = async () => {
    if (!window.api) return;
    await window.api.auth.criblDisconnect();
    refreshStatus();
    setShowCriblPopup(false);
  };

  const handleAzureLogin = async () => {
    if (!window.api) return;
    setLoggingIn(true);
    setError('');
    try {
      const result = await window.api.auth.azureLogin();
      if (result.loggedIn) {
        refreshStatus();
        loadSubscriptions();
      } else {
        setError('Azure login was not completed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    }
    setLoggingIn(false);
  };

  const loadSubscriptions = async () => {
    if (!window.api) return;
    setLoadingAzure(true);
    try {
      const result = await window.api.auth.azureSubscriptions();
      if (result.success) {
        setSubscriptions(result.subscriptions);
        // Pre-select current subscription
        if (azure.subscriptionId) setSelectedSub(azure.subscriptionId);
        else if (result.subscriptions.length > 0) setSelectedSub(result.subscriptions[0].id);
      }
    } catch { /* skip */ }
    setLoadingAzure(false);
  };

  const loadWorkspaces = async (subId: string) => {
    if (!window.api || !subId) return;
    setLoadingAzure(true);
    setWorkspaces([]);
    setSelectedWs('');
    try {
      await window.api.auth.azureSetSubscription(subId);
      const result = await window.api.auth.azureWorkspaces(subId);
      if (result.success) {
        setWorkspaces(result.workspaces);
        if (result.workspaces.length > 0) setSelectedWs(result.workspaces[0].name);
      }
    } catch { /* skip */ }
    setLoadingAzure(false);
  };

  const handleSelectWorkspace = async () => {
    if (!window.api || !selectedWs || !selectedSub) return;
    const ws = workspaces.find((w) => w.name === selectedWs);
    if (!ws) return;
    setLoadingAzure(true);
    try {
      await window.api.auth.azureSelectWorkspace({
        workspaceName: ws.name,
        resourceGroupName: ws.resourceGroup,
        location: ws.location,
        subscriptionId: selectedSub,
      });
      refreshStatus();
      setShowAzurePopup(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to select workspace');
    }
    setLoadingAzure(false);
  };

  // Load subscriptions when Azure popup opens and user is logged in
  useEffect(() => {
    if (showAzurePopup && azure.loggedIn && subscriptions.length === 0) {
      loadSubscriptions();
    }
  }, [showAzurePopup, azure.loggedIn]);

  // Load workspaces when subscription changes
  useEffect(() => {
    if (selectedSub) loadWorkspaces(selectedSub);
  }, [selectedSub]);

  // Extract org from Cribl Cloud URL: "https://main-myorg.cribl.cloud" -> "myorg"
  const criblOrg = cribl.baseUrl
    ? (() => {
        const match = cribl.baseUrl.match(/main-([^.]+)\.cribl\.cloud/);
        return match ? match[1] : cribl.baseUrl.replace(/^https?:\/\//, '').split('.')[0];
      })()
    : '';

  // Hide entire AuthBar in air-gapped mode
  if (mode === 'air-gapped') return null;

  const showCribl = mode === 'full' || mode === 'cribl-only';
  const showAzure = mode === 'full' || mode === 'azure-only';

  return (
    <>
      <div style={s.bar}>
        {/* Cribl Section */}
        {showCribl && <div
          style={s.section}
          onClick={() => { setShowCriblPopup(true); setError(''); }}
          title={cribl.connected ? `Connected to ${cribl.baseUrl}` : 'Click to connect to Cribl'}
        >
          <div style={s.dot(cribl.connected)} />
          <span style={s.label}>Cribl</span>
          {cribl.connected ? (
            <span style={s.value} title={cribl.baseUrl}>{criblOrg}</span>
          ) : (
            <span style={s.disconnected}>Not connected</span>
          )}
        </div>}

        {/* Azure Section */}
        {showAzure && <div
          style={s.section}
          onClick={() => { setShowAzurePopup(true); setError(''); }}
          title={azure.loggedIn ? `${azure.accountId} | ${azure.subscriptionName}` : 'Click to sign in to Azure'}
        >
          <div style={s.dot(azure.loggedIn)} />
          <span style={s.label}>Azure</span>
          {azure.loggedIn ? (
            <>
              <span style={s.value} title={azure.tenantId}>
                {azure.subscriptionName || azure.subscriptionId.slice(0, 8)}
              </span>
              <span style={{ ...s.value, color: 'var(--text-muted)', fontSize: '10px' }}>
                {azure.accountId.split('@')[0]}
              </span>
            </>
          ) : (
            <span style={s.disconnected}>Not signed in</span>
          )}
        </div>}

        <div style={s.spacer} />
      </div>

      {/* Cribl Connection Popup */}
      {showCriblPopup && (
        <div style={s.overlay} onClick={() => setShowCriblPopup(false)}>
          <div style={s.popup} onClick={(e) => e.stopPropagation()}>
            <div style={s.popupTitle}>Cribl Stream Connection</div>

            {cribl.connected && (
              <div style={s.statusRow}>
                <div style={s.dot(true)} />
                <span>Connected to <strong>{criblOrg}</strong></span>
                <span style={{ flex: 1 }} />
                <button
                  className="btn-danger"
                  style={{ fontSize: '10px', padding: '3px 10px' }}
                  onClick={handleCriblDisconnect}
                >
                  Disconnect
                </button>
              </div>
            )}

            <div style={s.fieldGroup}>
              <div style={s.fieldLabel}>Deployment Type</div>
              <select
                style={s.select}
                value={criblForm.deploymentType}
                onChange={(e) => setCriblForm({ ...criblForm, deploymentType: e.target.value as 'cloud' | 'self-managed' })}
              >
                <option value="cloud">Cribl Cloud</option>
                <option value="self-managed">Self-Managed</option>
              </select>
            </div>

            {criblForm.deploymentType === 'cloud' ? (
              <div style={s.fieldGroup}>
                <div style={s.fieldLabel}>Organization ID</div>
                <input
                  style={s.input}
                  value={criblForm.organizationId}
                  onChange={(e) => setCriblForm({ ...criblForm, organizationId: e.target.value })}
                  placeholder="myorg"
                />
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
                  From your Cribl Cloud URL: https://main-<strong>{criblForm.organizationId || 'myorg'}</strong>.cribl.cloud
                </div>
              </div>
            ) : (
              <div style={s.fieldGroup}>
                <div style={s.fieldLabel}>Leader URL</div>
                <input
                  style={s.input}
                  value={criblForm.selfManagedUrl}
                  onChange={(e) => setCriblForm({ ...criblForm, selfManagedUrl: e.target.value })}
                  placeholder="https://cribl.internal:9000"
                />
              </div>
            )}

            <div style={s.fieldGroup}>
              <div style={s.fieldLabel}>Client ID</div>
              <input
                style={s.input}
                value={criblForm.clientId}
                onChange={(e) => setCriblForm({ ...criblForm, clientId: e.target.value })}
                placeholder="Client ID from Cribl API credentials"
              />
            </div>

            <div style={s.fieldGroup}>
              <div style={s.fieldLabel}>Client Secret</div>
              <input
                style={s.input}
                type="password"
                value={criblForm.clientSecret}
                onChange={(e) => setCriblForm({ ...criblForm, clientSecret: e.target.value })}
                placeholder="Client secret"
              />
            </div>

            <label style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              fontSize: '11px', color: 'var(--text-secondary)', cursor: 'pointer',
              marginTop: '4px',
            }}>
              <input
                type="checkbox"
                checked={saveCredentials}
                onChange={(e) => setSaveCredentials(e.target.checked)}
              />
              Save credentials for next session
            </label>
            {saveCredentials && (
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px', padding: '6px 8px', background: 'var(--bg-input)', borderRadius: '4px' }}>
                Credentials will be stored in %APPDATA%/.cribl-microsoft/auth/.
                For production use, consider using environment variables or a secrets manager instead.
              </div>
            )}

            {error && <div style={s.errorText}>{error}</div>}

            <div style={s.popupActions}>
              <button className="btn-secondary" onClick={() => setShowCriblPopup(false)}>Cancel</button>
              <button
                className="btn-primary"
                onClick={handleCriblConnect}
                disabled={connecting || !criblForm.clientId || !criblForm.clientSecret ||
                  (criblForm.deploymentType === 'cloud' ? !criblForm.organizationId : !criblForm.selfManagedUrl)}
              >
                {connecting ? 'Connecting...' : 'Connect'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Azure Login Popup */}
      {showAzurePopup && (
        <div style={s.overlay} onClick={() => setShowAzurePopup(false)}>
          <div style={s.popup} onClick={(e) => e.stopPropagation()}>
            <div style={s.popupTitle}>Azure Session</div>

            {azure.loggedIn ? (
              <>
                <div style={s.statusRow}>
                  <div style={s.dot(true)} />
                  <span>Signed in as <strong>{azure.accountId}</strong></span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                    Tenant: {azure.tenantId.slice(0, 8)}...
                  </span>
                </div>

                <div style={s.fieldGroup}>
                  <div style={s.fieldLabel}>Subscription</div>
                  <select
                    style={s.select}
                    value={selectedSub}
                    onChange={(e) => setSelectedSub(e.target.value)}
                    disabled={loadingAzure}
                  >
                    {subscriptions.length === 0 && (
                      <option value="">Loading subscriptions...</option>
                    )}
                    {subscriptions.map((sub) => (
                      <option key={sub.id} value={sub.id}>{sub.name}</option>
                    ))}
                  </select>
                </div>

                <div style={s.fieldGroup}>
                  <div style={s.fieldLabel}>Log Analytics Workspace</div>
                  {loadingAzure ? (
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', padding: '6px 0' }}>
                      Loading workspaces...
                    </div>
                  ) : workspaces.length > 0 ? (
                    <select
                      style={s.select}
                      value={selectedWs}
                      onChange={(e) => setSelectedWs(e.target.value)}
                    >
                      {workspaces.map((ws) => (
                        <option key={ws.name} value={ws.name}>
                          {ws.name} ({ws.resourceGroup} / {ws.location})
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', padding: '6px 0' }}>
                      No workspaces found in this subscription
                    </div>
                  )}
                  {selectedWs && workspaces.length > 0 && (() => {
                    const ws = workspaces.find((w) => w.name === selectedWs);
                    return ws ? (
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '6px', fontFamily: 'var(--font-mono)' }}>
                        Resource Group: {ws.resourceGroup}<br />
                        Location: {ws.location}<br />
                        Workspace ID: {ws.customerId}
                      </div>
                    ) : null;
                  })()}
                </div>

                {error && <div style={s.errorText}>{error}</div>}

                <div style={s.popupActions}>
                  <button className="btn-secondary" onClick={handleAzureLogin} disabled={loggingIn}>
                    {loggingIn ? 'Signing in...' : 'Switch Account'}
                  </button>
                  <button
                    className="btn-primary"
                    onClick={handleSelectWorkspace}
                    disabled={loadingAzure || !selectedWs}
                  >
                    {loadingAzure ? 'Loading...' : 'Select Workspace'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={s.statusRow}>
                  <div style={s.dot(false)} />
                  <span>Not signed in to Azure</span>
                </div>

                <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
                  Click below to open the Azure login page in your browser.
                  This uses Connect-AzAccount from the Az PowerShell module.
                </p>

                {error && <div style={s.errorText}>{error}</div>}

                <div style={s.popupActions}>
                  <button className="btn-secondary" onClick={() => setShowAzurePopup(false)}>Cancel</button>
                  <button
                    className="btn-primary"
                    onClick={handleAzureLogin}
                    disabled={loggingIn}
                  >
                    {loggingIn ? 'Opening browser...' : 'Sign in to Azure'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export default AuthBar;
