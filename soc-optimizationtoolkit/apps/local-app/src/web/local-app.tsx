// Local-shell root component: the browser side of the dual-target twin.
// Renders the SAME @soc/ui frame and screens as the cloud shell, wired to
// the six local adapters (local-adapters.ts) that talk to the loopback Node
// host. The active config is the host's non-secret /api/config payload -
// there is no connection-profile UI here; identity lives in
// config/local-config.json and changing it means editing that file and
// restarting the host.
//
// Frame flow (identical to the cloud shell): AuaGate before ANYTHING else
// when no acceptance record exists, then ModeSelect while the mode is null,
// then AppFrame with mode-filtered navigation. Acceptance + mode persist as
// PLAIN entries through the local SecretsStore adapter (host
// data/secrets.json) - app state, not secrets, readable back every launch.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AppFrame,
  AuaGate,
  EMPTY_MODE_RECORD,
  ModeSelect,
  OnboardTableScreen,
  PortsProvider,
  SettingsScreen,
  resolveFramePhase,
  useConsolidatedPolling,
} from '@soc/ui';
import type {
  AppRoute,
  LoadableAcceptance,
  LoadableMode,
  PlatformInfoRow,
} from '@soc/ui';
import {
  parseAcceptanceRecord,
  parseAppMode,
  parseAzureConfig,
  serializeAcceptanceRecord,
  serializeAppMode,
} from '@soc/core';
import type { AcceptanceRecord, AppMode, AzureConfig } from '@soc/core';
import { fetchWithTimeout, makeLocalPorts } from './local-adapters';

// Constructed once: the adapters are stateless over the host API, and a
// stable identity keeps PortsProvider's memoized context value stable.
const ports = makeLocalPorts();

// Acceptance + mode keys in the host secrets store (plain, not encrypted -
// they must be readable back). Same key names as the cloud shell's KV.
const AUA_ACCEPTANCE_KEY = 'auaAcceptance';
const APP_MODE_KEY = 'appMode';

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

// Render a config value for the Settings rows; blanks stay visible as an
// explicit "(not set)" so an incomplete config file is obvious at a glance.
function display(value: string): string {
  return value === '' ? '(not set)' : value;
}

export function LocalApp() {
  const [load, setLoad] = useState<ConfigLoad>({ state: 'loading' });

  // Acceptance-of-use and operating mode: 'loading' until the persisted
  // entries arrive, then the parsed value (null = not accepted / not
  // chosen). resolveFramePhase's loading contract keeps the agreement gate
  // from ever flashing for an already-accepted user.
  const [acceptance, setAcceptance] = useState<LoadableAcceptance>('loading');
  const [mode, setMode] = useState<LoadableMode>('loading');

  // Status of the consolidated connection poll: is the loopback host up?
  const [hostLink, setHostLink] = useState('checking...');

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

  // Load acceptance + mode once on mount through the local secrets adapter.
  // Tolerant on purpose: a failed read parses to null, which re-prompts
  // (acceptance) or re-asks (mode) rather than silently waving through.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [accRaw, modeRaw] = await Promise.allSettled([
        ports.secrets.get(AUA_ACCEPTANCE_KEY),
        ports.secrets.get(APP_MODE_KEY),
      ]);
      if (cancelled) {
        return;
      }
      setAcceptance(
        parseAcceptanceRecord(accRaw.status === 'fulfilled' ? accRaw.value : null)
      );
      setMode(parseAppMode(modeRaw.status === 'fulfilled' ? modeRaw.value : null));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const phase = resolveFramePhase(acceptance, mode);

  // The ONE budgeted status poller (@soc/ui hook over the @soc/core
  // poll-scheduler). Only the connection-status poll registers for now: a
  // cheap loopback GET proves the host process is still running. Future
  // polls register HERE with a priority - never their own setInterval.
  const connectionPolls = useMemo(
    () => [
      {
        id: 'connection-status',
        intervalMs: 30_000,
        priority: 10,
        run: async () => {
          try {
            const res = await fetchWithTimeout('/api/config', undefined, 5000);
            setHostLink(res.ok ? 'ok' : `failed - GET /api/config: HTTP ${res.status}`);
          } catch (err) {
            setHostLink(`failed - ${String(err)}`);
          }
        },
      },
    ],
    []
  );
  useConsolidatedPolling({
    polls: connectionPolls,
    // Loopback traffic has no proxy budget; the cap just bounds pathology.
    maxPerMinute: 60,
    enabled: phase.phase === 'ready',
  });

  // Accept the agreement: the shell mints the timestamp and persists the
  // record as a plain entry. A failed write is non-fatal (legacy contract):
  // the session proceeds and the gate re-prompts on the next launch.
  const handleAccept = async () => {
    const record: AcceptanceRecord = { acceptedAt: new Date().toISOString() };
    try {
      await ports.secrets.set(AUA_ACCEPTANCE_KEY, serializeAcceptanceRecord(record));
    } catch {
      // Non-fatal; re-prompts next launch.
    }
    setAcceptance(record);
  };

  // First-run mode choice: persist, then adopt.
  const handleSelectMode = async (next: AppMode) => {
    try {
      await ports.secrets.set(APP_MODE_KEY, serializeAppMode(next));
    } catch {
      // Non-fatal; re-asks next launch.
    }
    setMode(next);
  };

  // The Reconfigure contract (mined from the legacy Settings page): write an
  // EMPTY mode record - which parses back to null - then reload into
  // ModeSelect. The host config file is untouched. If the write fails, fall
  // back to an in-session reset so the chooser is still reachable.
  const handleReconfigure = async () => {
    try {
      await ports.secrets.set(APP_MODE_KEY, EMPTY_MODE_RECORD);
      window.location.reload();
    } catch {
      setMode(null);
    }
  };

  // Gate order is the contract: acceptance before ANYTHING else, then mode
  // selection, then the frame.
  if (phase.phase === 'loading') {
    return (
      <div className="local-shell">
        <header className="local-header">
          <h1 className="local-title">SOC Optimization Toolkit - Local</h1>
          <p className="local-subtitle">Loading...</p>
        </header>
      </div>
    );
  }
  if (phase.phase === 'aua') {
    return <AuaGate onAccept={handleAccept} />;
  }
  if (phase.phase === 'mode-select') {
    return <ModeSelect onSelect={handleSelectMode} />;
  }

  // The Onboard route: the shared walking-skeleton screen against the local
  // adapters, gated on the host config actually loading.
  const onboardView = (
    <>
      <header className="local-header">
        <h1 className="local-title">Onboard a native table</h1>
        <p className="local-subtitle">
          Deploy a Kind:Direct DCR for one native Log Analytics table and create the matching
          Cribl Sentinel destination - the same screens and port contracts as the Cribl.Cloud
          app, served by the loopback Node host that owns all credentials and upstream calls.
        </p>
      </header>
      {load.state === 'loading' && (
        <p className="local-subtitle">Loading host configuration...</p>
      )}
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
        <PortsProvider ports={ports} config={load.config.azure}>
          <OnboardTableScreen />
        </PortsProvider>
      )}
    </>
  );

  // Settings platform info: the local header's explanation plus the old
  // config-summary rows, graduated into the shared SettingsScreen. Secrets
  // never appear - the host only ever serves non-secret fields.
  const configRows: PlatformInfoRow[] =
    load.state === 'loaded'
      ? [
          { label: 'Cribl leader', value: display(load.config.criblLeaderUrl) },
          { label: 'Tenant ID', value: display(load.config.azure.tenantId) },
          { label: 'Client ID', value: display(load.config.azure.clientId) },
          { label: 'Subscription', value: display(load.config.azure.subscriptionId) },
          { label: 'Resource group', value: display(load.config.azure.resourceGroup) },
          { label: 'Workspace', value: display(load.config.azure.workspaceName) },
        ]
      : [
          {
            label: 'Connection',
            value:
              load.state === 'loading'
                ? 'loading host configuration...'
                : `unavailable - ${load.message}`,
          },
        ];

  const settingsView = (
    <SettingsScreen
      shellName="Local Node host (127.0.0.1 loopback)"
      platformRows={[
        {
          label: 'Host link',
          value: hostLink,
          tip:
            'The consolidated status poll: one loopback GET /api/config\n' +
            'every 30 seconds proves the host process is still running.',
        },
        ...configRows,
      ]}
      platformNote={
        'This page is served by the loopback Node host, which holds the Azure and Cribl ' +
        'credentials in config/local-config.json and performs every upstream call ' +
        'server-side. Non-secret fields only are shown; the Azure client secret and Cribl ' +
        'token never leave the host process. To change this connection, edit ' +
        'config/local-config.json, restart the host, then reload this page.'
      }
      mode={phase.mode}
      onReconfigure={handleReconfigure}
    />
  );

  // Route table: Onboard needs BOTH live sides; Settings is always shown.
  const routes: AppRoute[] = [
    { id: 'onboard', label: 'Onboard', requires: 'both', render: () => onboardView },
    { id: 'settings', label: 'Settings', requires: 'none', render: () => settingsView },
  ];

  return (
    <AppFrame
      title="SOC Optimization Toolkit"
      subtitle="Local shell"
      mode={phase.mode}
      routes={routes}
      initialRouteId="onboard"
      footerNote="local host"
    />
  );
}
