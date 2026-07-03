// Local-shell root component: the browser side of the dual-target twin.
// Renders the SAME @soc/ui screens as the cloud shell, wired to the six
// local adapters (local-adapters.ts) that talk to the loopback Node host.
// The active config is the host's non-secret /api/config payload - there is
// no connection-profile UI here; identity lives in config/local-config.json
// and changing it means editing that file and restarting the host.

import { useCallback, useEffect, useState } from 'react';
import { OnboardTableScreen, PortsProvider } from '@soc/ui';
import { parseAzureConfig } from '@soc/core';
import type { AzureConfig } from '@soc/core';
import { fetchWithTimeout, makeLocalPorts } from './local-adapters';

// Constructed once: the adapters are stateless over the host API, and a
// stable identity keeps PortsProvider's memoized context value stable.
const ports = makeLocalPorts();

// What GET /api/config yields for the shell: the AzureConfig-shaped
// non-secret fields plus the leader URL for display. Secrets (Azure client
// secret, Cribl token) never appear on any host response.
interface LocalShellConfig {
  azure: AzureConfig;
  criblLeaderUrl: string;
}

type ConfigLoad =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'loaded'; config: LocalShellConfig };

// Load and normalize /api/config. The AzureConfig fields go through the
// tolerant @soc/core codec (unknown keys - including criblLeaderUrl - are
// dropped; missing fields become ''); the leader URL is read alongside.
async function loadConfig(): Promise<LocalShellConfig> {
  const res = await fetchWithTimeout('/api/config');
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GET /api/config: HTTP ${res.status}${text === '' ? '' : `\n${text}`}`);
  }
  const azure = parseAzureConfig(text);
  let criblLeaderUrl = '';
  try {
    const parsed: unknown = JSON.parse(text);
    const url = (parsed as { criblLeaderUrl?: unknown }).criblLeaderUrl;
    if (typeof url === 'string') {
      criblLeaderUrl = url;
    }
  } catch {
    // parseAzureConfig already tolerated the body; leader URL stays blank.
  }
  return { azure, criblLeaderUrl };
}

// One labelled row of the config summary; blank values render as an explicit
// "(not set)" so an incomplete config file is visible at a glance.
function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="config-key">{label}</span>
      {value === '' ? (
        <span className="config-value config-value-unset">(not set)</span>
      ) : (
        <span className="config-value">{value}</span>
      )}
    </>
  );
}

export function LocalApp() {
  const [load, setLoad] = useState<ConfigLoad>({ state: 'loading' });

  const reload = useCallback(async () => {
    setLoad({ state: 'loading' });
    try {
      setLoad({ state: 'loaded', config: await loadConfig() });
    } catch (err) {
      setLoad({ state: 'error', message: String(err) });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="local-shell">
      <header className="local-header">
        <h1 className="local-title">SOC Optimization Toolkit - Local</h1>
        <p className="local-subtitle">
          The local deployment target: this page is served by the loopback Node host, which holds
          the Azure and Cribl credentials in config/local-config.json and performs every upstream
          call server-side. Same screens, same port contracts as the Cribl.Cloud app.
        </p>
      </header>

      {load.state === 'loading' && <p className="local-subtitle">Loading host configuration...</p>}

      {load.state === 'error' && (
        <>
          <div className="local-error">
            Could not load the host configuration: {load.message}
          </div>
          <div className="panel-controls">
            <button className="run-button" onClick={() => void reload()}>
              Retry
            </button>
          </div>
        </>
      )}

      {load.state === 'loaded' && (
        <>
          <section className="config-bar">
            <span className="discovery-title">Connection (from config/local-config.json)</span>
            <div className="config-grid">
              <ConfigRow label="Cribl leader" value={load.config.criblLeaderUrl} />
              <ConfigRow label="Tenant ID" value={load.config.azure.tenantId} />
              <ConfigRow label="Client ID" value={load.config.azure.clientId} />
              <ConfigRow label="Subscription" value={load.config.azure.subscriptionId} />
              <ConfigRow label="Resource group" value={load.config.azure.resourceGroup} />
              <ConfigRow label="Workspace" value={load.config.azure.workspaceName} />
            </div>
            <p className="panel-desc">
              Non-secret fields only: the Azure client secret and Cribl token never leave the host
              process. To change this connection, edit config/local-config.json and restart the
              host, then reload this page.
            </p>
          </section>
          <PortsProvider ports={ports} config={load.config.azure}>
            <OnboardTableScreen />
          </PortsProvider>
        </>
      )}
    </div>
  );
}
