import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  APP_THEME_KEY,
  AppFrame,
  ArchitectureScreen,
  MappingCatalogScreen,
  AuaGate,
  AzureConnectSection,
  AzureResourcesSection,
  BatchDeployScreen,
  DcrAutomationScreen,
  DcrInventoryPanel,
  EMPTY_MODE_RECORD,
  EventHubDiscoveryScreen,
  HomeScreen,
  IntegrateScreen,
  LogsScreen,
  ModeSelect,
  OnboardTableScreen,
  PackInventoryScreen,
  PortsProvider,
  RbacPreflightPanel,
  RepositoriesScreen,
  SettingsScreen,
  commitNoticeText,
  formatScopeChip,
  mergeJourneyLinks,
  resolveFramePhase,
  useConsolidatedPolling,
} from '@soc/ui';
import type {
  AppFrameNav,
  AppRoute,
  AzureConnectResult,
  CommitScopeOutcome,
  JourneyLinks,
  LoadableAcceptance,
  LoadableMode,
  ThemeControl,
} from '@soc/ui';
import {
  commitTargetScope,
  computeInvalidation,
  DEFAULT_APP_OPTIONS,
  DEFAULT_THEME_CHOICE,
  hasAzure,
  hasCribl,
  EMPTY_AZURE_CONFIG,
  EMPTY_PROFILE_STORE,
  getActiveConfig,
  getActiveProfile,
  parseAcceptanceRecord,
  parseAppMode,
  parseAppOptions,
  serializeAppOptions,
  parseAzureConfig,
  parseProfileStore,
  parseThemeChoice,
  resolveTheme,
  serializeThemeChoice,
  removeProfile,
  renameProfile,
  serializeAcceptanceRecord,
  serializeAppMode,
  serializeProfileStore,
  setActiveProfile,
  updateActiveConfig,
  upsertProfile,
} from '@soc/core';
import type {
  AcceptanceRecord,
  AppMode,
  AppOptions,
  OperationOptions,
  AzureConfig,
  AzureSetupPath,
  BatchPacing,
  ChangeRequestContext,
  ConnectionProfile,
  JourneyFacts,
  ProfileStore,
  SetupPath as PreflightSetupPath,
  TargetScope,
  ThemeChoice,
} from '@soc/core';
// The proven platform primitives (bridge-safe fetch, KV helpers, ARM token
// flow) live in platform/http.ts as the single source of truth, shared with
// the port adapters in platform/adapters.ts.
import { acquireArmToken, fetchWithTimeout, kvDelete, kvUrl } from './platform/http';
// Cloud-shell port adapters for the shared @soc/ui screens: the @soc/core
// ports bound to the platform primitives (KV, proxy-injected auth, downloads).
import { makeCloudPorts, PlatformSecretsStore } from './platform/adapters';
// The app-lifetime Logger (porting-plan Unit 3): bounded in-memory ring with
// warn/error mirrored to one rolling plain KV entry. Module scope so the
// ring survives connection switches and ports-bundle rebuilds.
import { PlatformLogger } from './platform/logger';

// The app's display name, shown in generated change-request tickets and the
// architecture diagrams embedded in them. The change-request text and diagrams
// are produced entirely by @soc/core; the app only supplies this name and the
// active connection's non-secret config.
const APP_NAME = 'SOC Optimization Toolkit';

// Phase 1 harness: five sequential diagnostics panels that exercise the Cribl
// App Platform surface (globals, KV store, proxy header injection, Azure AD
// token flow, ARM calls, iframe download behavior), driven by named connection
// profiles. A connection bar at the top selects the ACTIVE profile. The former
// panels 3 and 4 (App registration and connect / resource selection and role
// grant) were PROMOTED to the Setup page as shared @soc/ui sections
// (AzureConnectSection / AzureResourcesSection).
//
// PLATFORM CONSTRAINT: proxies.yml injects auth from the FIXED keys
// kv.azureBasic (Basic, the client secret) and kv.azureArmToken (Bearer), and
// encrypted entries are write-only. Only ONE profile's secret can be live at
// azureBasic at a time, so switching identities requires re-entering that
// connection's secret. `liveSecretProfileId` tracks which profile's secret was
// written this session; it is never persisted and resets to null on reload.

type Status = 'idle' | 'running' | 'ok' | 'failed';

// Acceptance-of-use and operating-mode records persist as PLAIN KV entries
// (not encrypted) through the platform SecretsStore adapter: they are app
// state, not secrets, and must be readable back on every launch. The codecs
// (parse/serialize) live in @soc/core app-mode; the shell owns the clock.
const AUA_ACCEPTANCE_KEY = 'auaAcceptance';
const APP_MODE_KEY = 'appMode';
// Deployment/naming options (porting-plan Unit 4): ONE plain KV entry,
// persisted through the same SecretsStore adapter as appMode. Saves go
// through @soc/core applyOptionsPatch so unmanaged keys in the blob survive.
const APP_OPTIONS_KEY = 'appOptions';
const appStateStore = new PlatformSecretsStore();
const appLogger = new PlatformLogger();

// The pacing hooks the batch-onboarding usecase runs its rolling-minute ARM
// budget on (porting-plan Unit 6): the SHELL owns time - @soc/core never
// reads a clock. Module scope keeps the object identity stable across
// renders. maxRequestsPerMinute stays at the @soc/core default (80/min),
// leaving headroom under the platform proxy's ~100 req/min budget for the
// status pollers and the operator's other screens.
const BATCH_PACING: BatchPacing = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

// The AzureConfig fields the Onboard screen cannot run without. tenantId
// drives the ARM token flow; the rest address the workspace the DCR targets.
const ONBOARD_REQUIRED_FIELDS = [
  'tenantId',
  'clientId',
  'subscriptionId',
  'resourceGroup',
  'workspaceName',
] as const;

// This shell's journey stage bindings (ux-flow-plan 4.4, Unit 6.5): the
// shared bindings plus the CLOUD-specific connect cross-link - identity
// entry lives in the App registration and connect section of the Setup page.
// Cross-links are DATA passed to the shared screens; shared prose never
// names shell-specific UI.
const SHELL_LINK_OVERRIDES: JourneyLinks = {
  connect: {
    routeId: 'home',
    hint:
      'Identity entry lives in the App registration and connect section of the Setup ' +
      'page: Save and connect stores the secret and verifies it by acquiring an ARM token.',
  },
};
// Full mode: the integrate-arc stages the single-page Integrate flagship
// serves (choose-content / configure / deploy) cross-link to the 'integrate'
// route - Setup's Integrate rail opens the one page (legacy-flow-analysis.md).
// In cribl-only / air-gapped these stages render 'not-yet-available'
// (non-navigable), so the binding is inert where the 'both'-gated route is
// hidden.
const JOURNEY_LINKS = mergeJourneyLinks({
  ...SHELL_LINK_OVERRIDES,
  'choose-content': {
    routeId: 'integrate',
    hint: 'Start on the Integrate page - the single-page flow from Azure resources through deploy.',
  },
  configure: {
    routeId: 'integrate',
    hint: 'Configure Azure resources and Cribl on the Integrate page.',
  },
  deploy: {
    routeId: 'integrate',
    hint: 'Deploy the native table on the Integrate page.',
  },
});

// azure-only: the Onboard route requires a live Cribl side and is hidden, so
// the integrate stages bind to DCR Automation - the surface the relaxed
// 'azure' requirement actually exposes in this mode (templateOnly forced on;
// the honest copy lives on the screen).
const AZURE_ONLY_JOURNEY_LINKS = mergeJourneyLinks({
  ...SHELL_LINK_OVERRIDES,
  'choose-content': {
    routeId: 'dcr-automation',
    hint: 'DCR Automation is this mode\'s onboarding surface; runs are template-only (no live Cribl connection).',
  },
  configure: {
    routeId: 'dcr-automation',
    hint: 'Per-run overrides live on DCR Automation.',
  },
  deploy: {
    routeId: 'dcr-automation',
    hint:
      'Run on DCR Automation - template-only in this mode; ARM bodies download as one ' +
      'artifact.',
  },
});

// Where the operator grants the Monitoring Metrics Publisher role today
// (shell-provided pointer for the shared Onboard footer - the local shell
// passes its own).
const ROLE_GUIDANCE =
  'grant it following the role guidance in the Select resources and grant permissions ' +
  'section of the Setup page.';

// Shared runner state for a panel: status line plus a monospace output area.
// The task either resolves to the output text (status ok) or throws; thrown
// errors are reported verbatim (status failed).
function useRunner(): [Status, string, (task: () => Promise<string>) => Promise<void>] {
  const [status, setStatus] = useState<Status>('idle');
  const [output, setOutput] = useState('');
  const run = useCallback(async (task: () => Promise<string>) => {
    setStatus('running');
    setOutput('');
    try {
      setOutput(await task());
      setStatus('ok');
    } catch (err) {
      setOutput(String(err));
      setStatus('failed');
    }
  }, []);
  return [status, output, run];
}

interface PanelProps {
  index: number;
  title: string;
  status: Status;
  output: string;
  actionLabel: string;
  onAction: () => void;
  children?: ReactNode;
}

function Panel({ index, title, status, output, actionLabel, onAction, children }: PanelProps) {
  return (
    <section className="panel">
      <h2 className="panel-title">{index}. {title}</h2>
      {children}
      <div className="panel-controls">
        <button className="run-button" onClick={onAction} disabled={status === 'running'}>
          {actionLabel}
        </button>
        <span className={`status status-${status}`}>{status}</span>
      </div>
      {output !== '' && <pre className="result">{output}</pre>}
    </section>
  );
}

// Result of loading the profile store, distinguishing a genuinely absent key
// (safe to seed a Default profile) from a load FAILURE of unknown state (a
// transient 5xx, an auth error, or a network throw). Seeding on a failure would
// let autosave overwrite real profiles that are actually still there, so the
// two cases must not be conflated.
type ProfileLoad =
  | { status: 'loaded'; store: ProfileStore }
  | { status: 'absent' }
  | { status: 'error'; message: string };

// Load the persisted profile store from the plain KV key 'azureProfiles' and
// normalize it through the pure @soc/core codec. A 404 or an ok-but-empty body
// means the key does not exist yet (absent); any other non-ok status or a
// network error is a failure we must not treat as "no data". No client secret
// is ever carried here - secrets live only in the encrypted, write-only
// azureBasic entry and are never read back.
async function loadProfileStore(): Promise<ProfileLoad> {
  try {
    const res = await fetchWithTimeout(kvUrl('azureProfiles'));
    if (res.status === 404) {
      return { status: 'absent' };
    }
    if (!res.ok) {
      return { status: 'error', message: `HTTP ${res.status} loading azureProfiles` };
    }
    const body = await res.text();
    if (body.trim() === '') {
      return { status: 'absent' };
    }
    return { status: 'loaded', store: parseProfileStore(body) };
  } catch (err) {
    return { status: 'error', message: String(err) };
  }
}

// One-time migration read: the legacy single-config key 'azureConfig' from before
// named connection profiles existed. Used only to seed a 'Default' profile when
// no profile store is present yet. Tolerant, like loadProfileStore.
async function loadLegacyAzureConfig(): Promise<AzureConfig> {
  try {
    const res = await fetchWithTimeout(kvUrl('azureConfig'));
    if (!res.ok) {
      return { ...EMPTY_AZURE_CONFIG };
    }
    return parseAzureConfig(await res.text());
  } catch {
    return { ...EMPTY_AZURE_CONFIG };
  }
}

// Panel 1: report the platform-injected globals and the signed-in user.
function PlatformGlobalsPanel() {
  const [status, output, run] = useRunner();
  const inspect = useCallback(
    () =>
      run(async () => {
        const lines: string[] = [
          `CRIBL_API_URL: ${String(window.CRIBL_API_URL)}`,
          `CRIBL_BASE_PATH: ${String(window.CRIBL_BASE_PATH)}`,
          `CRIBL_APP_ID: ${window.CRIBL_APP_ID ?? '(not present)'}`,
        ];
        try {
          const user = await window.getCriblUser();
          lines.push(`getCriblUser(): ${JSON.stringify(user, null, 2)}`);
        } catch (err) {
          throw new Error(`${lines.join('\n')}\ngetCriblUser() failed: ${String(err)}`);
        }
        return lines.join('\n');
      }),
    [run]
  );

  // Run once on load; the button re-runs on demand.
  useEffect(() => {
    void inspect();
  }, [inspect]);

  return (
    <Panel
      index={1}
      title="Platform globals"
      status={status}
      output={output}
      actionLabel="Read globals"
      onAction={() => void inspect()}
    >
      <p className="panel-desc">
        Reads window.CRIBL_API_URL, window.CRIBL_BASE_PATH, window.CRIBL_APP_ID (if present),
        and the result of window.getCriblUser(). Runs automatically on load.
      </p>
    </Panel>
  );
}

// Panel 2: exercise KV store semantics, including the write-only behavior of
// encrypted entries (GET must return a redacted placeholder, not plaintext).
// Steps stream into a live progress area with a per-step timeout, so a hung
// platform bridge shows exactly which step is stuck instead of spinning forever.
function KvStorePanel() {
  const [status, output, run] = useRunner();
  const [progress, setProgress] = useState('');
  const exercise = () =>
    run(async () => {
      const lines: string[] = [];
      setProgress('');
      const step = async (label: string, url: string, init?: RequestInit) => {
        setProgress([...lines, `${label}: waiting...`].join('\n'));
        const res = await fetchWithTimeout(url, init);
        const body = await res.text();
        lines.push(`${label}: HTTP ${res.status} body=${JSON.stringify(body)}`);
        setProgress(lines.join('\n'));
        return body;
      };
      try {
        await step("PUT spike-plain 'hello'", kvUrl('spike-plain'), { method: 'PUT', body: 'hello' });
        const plain = await step('GET spike-plain', kvUrl('spike-plain'));
        lines.push(
          plain === 'hello'
            ? "  check: got 'hello' back as expected"
            : "  check: expected 'hello', got the body shown above"
        );
        await step("PUT spike-secret?encrypted=true 'topsecret'", kvUrl('spike-secret?encrypted=true'), {
          method: 'PUT',
          body: 'topsecret',
        });
        const secret = await step('GET spike-secret', kvUrl('spike-secret'));
        lines.push(
          secret.includes('topsecret')
            ? '  check: FAIL - plaintext came back; encrypted entries are NOT write-only here'
            : '  check: plaintext not readable - write-only confirmed (observed: HTTP 403 "Cannot read encrypted value", not the redacted placeholder the docs describe)'
        );
        const listKeys = () =>
          step("POST keys {prefix: 'spike-'}", `${window.CRIBL_API_URL}/kvstore/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prefix: 'spike-' }),
          });
        const keys = await listKeys();
        lines.push(
          keys.includes('spike-plain') && keys.includes('spike-secret')
            ? '  check: both keys listed as expected'
            : '  check: expected both spike-plain and spike-secret in the listing'
        );
        // DELETE has been observed to hang in Live Preview (the bridge never
        // returns a response). Time out fast, then verify via a key listing
        // whether the delete actually took effect server-side - that
        // distinguishes "response lost in the bridge" from "not processed".
        const deleteStep = async (key: string) => {
          const label = `DELETE ${key}`;
          try {
            setProgress([...lines, `${label}: waiting...`].join('\n'));
            const res = await fetchWithTimeout(kvUrl(key), { method: 'DELETE' }, 8000);
            lines.push(`${label}: HTTP ${res.status}`);
          } catch (err) {
            lines.push(`${label}: ${String(err)}`);
            const after = await listKeys();
            lines.push(
              after.includes(key)
                ? `  check: ${key} STILL PRESENT after the timed-out DELETE - the delete was NOT processed`
                : `  check: ${key} is GONE despite the timeout - the delete WAS processed server-side but the bridge lost the response (platform finding)`
            );
          }
          setProgress(lines.join('\n'));
        };
        await deleteStep('spike-plain');
        await deleteStep('spike-secret');
      } catch (err) {
        throw new Error([...lines, `error: ${String(err)}`].join('\n'));
      }
      return lines.join('\n');
    });

  return (
    <Panel
      index={2}
      title="KV store semantics"
      status={status}
      output={output !== '' ? output : progress}
      actionLabel="Run KV sequence"
      onAction={() => void exercise()}
    >
      <p className="panel-desc">
        PUT/GET a plain entry, PUT/GET an encrypted entry (expect a redacted placeholder on read),
        list keys by prefix, then delete both. Each step reports its status code and body.
      </p>
    </Panel>
  );
}

// Map the coarse shell setup path (persisted on AzureConfig, edited in the
// Setup page's connect section) to the DEFAULT core preflight SetupPath the
// RBAC panel opens on. 'existing' defaults to the resource-group WRITE path
// (what deploy-readiness turns on); the operator can switch to the
// subscription-scope read path inside the panel.
function defaultPreflightPath(path: AzureSetupPath): PreflightSetupPath {
  switch (path) {
    case 'existing':
      return 'existing-rg';
    case 'lab-new-rg':
      return 'lab-new-rg-subscription';
    case 'lab-byo-rg':
      return 'lab-byo-rg';
  }
}

// Panel 3: client_credentials token flow. The app never sets Authorization;
// proxies.yml injects Basic ${kv.azureBasic} server-side (the proxy strips
// any Authorization header the client sends). The tenant is the ACTIVE
// connection's tenant ID.
function TokenAcquisitionPanel({ tenantId }: { tenantId: string }) {
  const [status, output, run] = useRunner();
  const acquire = () =>
    run(async () => {
      // Shared with the Setup page's connect action so the token flow lives
      // in one place.
      const token = await acquireArmToken(tenantId);
      const putRes = await fetch(kvUrl('azureArmToken?encrypted=true'), {
        method: 'PUT',
        body: token.access_token,
      });
      const lines = [
        'token endpoint: ok',
        `token_type: ${token.token_type ?? '(missing)'}`,
        `expires_in: ${token.expires_in ?? '(missing)'}`,
        `access_token (first 12 chars): ${token.access_token.slice(0, 12)}`,
        `PUT azureArmToken?encrypted=true: HTTP ${putRes.status}`,
      ];
      if (!putRes.ok) {
        throw new Error([...lines, `body: ${await putRes.text()}`].join('\n'));
      }
      return lines.join('\n');
    });

  return (
    <Panel
      index={3}
      title="Token acquisition (via proxy header injection)"
      status={status}
      output={output}
      actionLabel="Acquire token"
      onAction={() => void acquire()}
    >
      <p className="panel-desc">
        Save and connect (on the Setup page) already acquires and stores a token; this panel is an
        explicit re-acquire and diagnostic. Uses the active connection&apos;s tenant ID, then POSTs
        grant_type=client_credentials with the ARM scope to login.microsoftonline.com. No Authorization
        header is set by the app - the proxy injects Basic auth from kv.azureBasic per proxies.yml. On
        success the access token is stored encrypted under azureArmToken.
      </p>
    </Panel>
  );
}

// Panel 4: ARM subscriptions list. Bearer token is injected server-side from
// kv.azureArmToken; the app sends no Authorization header.
function ArmCallPanel() {
  const [status, output, run] = useRunner();
  const call = () =>
    run(async () => {
      const started = Date.now();
      const res = await fetch('https://management.azure.com/subscriptions?api-version=2022-12-01');
      const elapsed = Date.now() - started;
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} in ${elapsed} ms\n${text}`);
      }
      const parsed = JSON.parse(text) as {
        value?: Array<{ displayName?: string; subscriptionId?: string }>;
      };
      const subs = parsed.value ?? [];
      const lines = [`HTTP ${res.status} in ${elapsed} ms`, `subscriptions: ${subs.length}`];
      for (const sub of subs) {
        lines.push(`  ${sub.displayName ?? '(no displayName)'} (${sub.subscriptionId ?? 'no subscriptionId'})`);
      }
      return lines.join('\n');
    });

  return (
    <Panel
      index={4}
      title="ARM call (Bearer injected from KV)"
      status={status}
      output={output}
      actionLabel="List subscriptions"
      onAction={() => void call()}
    >
      <p className="panel-desc">
        GETs management.azure.com/subscriptions with no Authorization header - the proxy injects
        Bearer from kv.azureArmToken per proxies.yml. Shows subscription names, IDs, and elapsed
        milliseconds.
      </p>
    </Panel>
  );
}

// Panel 5: does the sandboxed iframe allow programmatic downloads? The only
// reliable signal is the file appearing in the browser's downloads.
function ArtifactDownloadPanel() {
  const [status, output, run] = useRunner();
  const download = () =>
    run(async () => {
      const artifact = {
        generatedAt: new Date().toISOString(),
        app: 'soc-optimizationtoolkit',
        spike: 'download',
      };
      const blob = new Blob([JSON.stringify(artifact, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'spike-artifact.json';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return await Promise.resolve(
        `Anchor click dispatched for spike-artifact.json (${blob.size} bytes).\n` +
          'This only proves the click fired - success means the file actually appears in the\n' +
          'browser downloads. If nothing appears, the iframe sandbox blocks downloads.\n' +
          'Record the finding either way.'
      );
    });

  return (
    <Panel
      index={5}
      title="Artifact download (iframe sandbox spike)"
      status={status}
      output={output}
      actionLabel="Download artifact"
      onAction={() => void download()}
    >
      <p className="panel-desc">
        Builds a small JSON artifact, creates a Blob object URL, and clicks a programmatic anchor
        with the download attribute. Success must be confirmed by the file appearing in the
        browser downloads - an ok status here does not prove the sandbox allowed it.
      </p>
    </Panel>
  );
}

// Normalize an identity field for comparison: trim then lowercase (Azure GUIDs
// are case-insensitive and stray whitespace should not read as a real change).
function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase();
}

// The identity a saved secret was written under, snapshotted at save time so the
// identity-drift hint can detect when the active connection's tenant/client has
// been edited away from what the live secret authenticates.
interface LiveSecretIdentity {
  tenantId: string;
  clientId: string;
}

function App() {
  // The whole app is driven by a ProfileStore of named connections. The
  // ACTIVE profile's non-secret config feeds every config-bearing surface. The
  // store is hydrated from, and debounce-autosaved to, the plain 'azureProfiles'
  // KV entry. Client secrets are NEVER part of this state - they are handled
  // write-only by the Setup page's connect action and tracked per session by
  // liveSecretProfileId.
  const [store, setStore] = useState<ProfileStore>(EMPTY_PROFILE_STORE);
  const [hydrated, setHydrated] = useState(false);

  // Acceptance-of-use and operating mode: 'loading' until the persisted
  // blobs arrive, then the parsed value (null = not accepted / not chosen).
  // resolveFramePhase turns the pair into the top-level surface; its loading
  // contract guarantees the agreement gate NEVER flashes for a user whose
  // acceptance is merely still in flight.
  const [acceptance, setAcceptance] = useState<LoadableAcceptance>('loading');
  const [mode, setMode] = useState<LoadableMode>('loading');

  // The parsed deployment/naming options (porting-plan Unit 4). Hydrated
  // from the plain appOptions KV entry alongside acceptance and mode;
  // refreshed by saveAppOptions (the Integrate page's DCE toggle persists
  // through it). The tolerant codec makes a failed read equal "defaults",
  // never a crash.
  const [appOptions, setAppOptions] = useState<AppOptions>(DEFAULT_APP_OPTIONS);

  // Theme (porting-plan dark-mode note, lands with Unit 6.5). The CHOICE
  // (light | dark | system) persists as the plain appTheme KV entry (the
  // appMode pattern); the prefers-color-scheme signal is read live so a
  // 'system' choice re-resolves the moment the OS preference changes. Inside
  // the Cribl iframe 'system' follows the OS, not Cribl's own UI theme (no
  // platform theme signal exists).
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(DEFAULT_THEME_CHOICE);
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  );
  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  const resolvedTheme = resolveTheme(themeChoice, systemPrefersDark);
  // data-theme goes on <html> so the tokens re-theme EVERYTHING - body
  // background and the gate screens (AuaGate, ModeSelect, loading) that
  // render outside the AppFrame wrapper.
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);
  const handleThemeChange = useCallback(async (choice: ThemeChoice) => {
    setThemeChoice(choice);
    try {
      await appStateStore.set(APP_THEME_KEY, serializeThemeChoice(choice));
    } catch {
      // Non-fatal: the choice holds for this session and re-reads next launch.
    }
  }, []);
  const themeControl: ThemeControl = {
    theme: themeChoice,
    resolvedTheme,
    onThemeChange: handleThemeChange,
  };

  // Status of the consolidated connection poll (the one budgeted poller):
  // 'checking...' -> 'ok' | 'failed - <error>'.
  const [platformLink, setPlatformLink] = useState('checking...');

  // Load acceptance + mode + options once on mount. Tolerant on purpose: a
  // failed read parses to null, which re-prompts (acceptance) or re-asks
  // (mode) rather than silently waving the user through; options fall back
  // to their defaults.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [accRaw, modeRaw, optionsRaw, themeRaw] = await Promise.allSettled([
        appStateStore.get(AUA_ACCEPTANCE_KEY),
        appStateStore.get(APP_MODE_KEY),
        appStateStore.get(APP_OPTIONS_KEY),
        appStateStore.get(APP_THEME_KEY),
      ]);
      if (cancelled) {
        return;
      }
      setAcceptance(
        parseAcceptanceRecord(accRaw.status === 'fulfilled' ? accRaw.value : null)
      );
      setMode(parseAppMode(modeRaw.status === 'fulfilled' ? modeRaw.value : null));
      setAppOptions(
        parseAppOptions(optionsRaw.status === 'fulfilled' ? optionsRaw.value : null)
      );
      // Theme: a failed read parses to 'system' - always renderable.
      setThemeChoice(
        parseThemeChoice(themeRaw.status === 'fulfilled' ? themeRaw.value : null)
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The options save callback (the small shared save this shell owns): one
  // plain KV entry, with the shell's parsed copy refreshed on every save so
  // onboarding defaults follow immediately. The dedicated Options screen was
  // RETIRED (2026-07-14, never used); deployment/naming defaults apply from
  // DEFAULT_APP_OPTIONS and the surviving inline edits persist through here.
  const saveAppOptions = useCallback(async (serialized: string) => {
    await appStateStore.set(APP_OPTIONS_KEY, serialized);
    setAppOptions(parseAppOptions(serialized));
  }, []);
  // Persist an inline OperationOptions edit (the Integrate page's DCE capability
  // toggle) through the same appOptions entry.
  const persistOperation = useCallback(
    (operation: OperationOptions) => {
      void saveAppOptions(serializeAppOptions({ ...appOptions, operation }));
    },
    [appOptions, saveAppOptions],
  );

  // Which profile's secret was last written to the single azureBasic slot THIS
  // session, plus the identity it was written under. Non-persisted: both reset to
  // null on reload (secrets are never remembered per profile across reloads).
  const [liveSecretProfileId, setLiveSecretProfileId] = useState<string | null>(null);
  const [liveSecretIdentity, setLiveSecretIdentity] = useState<LiveSecretIdentity | null>(null);

  // SECRET VERIFICATION (user direction 2026-07-14): instead of a standing
  // "secret not entered this session" warning, VERIFY the stored secret once
  // per connection per session - acquiring an ARM token with the stored
  // azureBasic slot is the definitive probe. Success marks the secret live
  // (and stores a fresh azureArmToken, same as a connect); only a VERIFIED
  // failure surfaces a notice. 'idle' = nothing to probe yet (no identity).
  const [secretProbe, setSecretProbe] = useState<
    | { state: 'idle' | 'checking' | 'live' | 'missing' }
    | { state: 'failed'; detail: string }
  >({ state: 'idle' });
  const probedProfileRef = useRef<string | null>(null);

  // A transient message surfaced after a switch / clear (e.g. "enter the secret
  // for this connection"). Cleared once a secret is saved or a no-clear switch
  // happens.
  const [switchNotice, setSwitchNotice] = useState('');

  // Bumped on a full successful connect (secret written + token acquired).
  // The Setup page's resources section watches this to auto-run resource
  // discovery exactly once per connect. Non-persisted; survives section
  // remounts so a connect made while the section is mounted triggers its
  // discovery effect.
  const [connectNonce, setConnectNonce] = useState(0);
  const handleConnected = useCallback(() => setConnectNonce((n) => n + 1), []);

  // Inline rename state for the connection bar.
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');

  // The serialized store we know is already persisted. Set at hydration to what
  // azureProfiles actually held, so a just-loaded (or migrated) store is written
  // exactly once and never redundantly.
  const lastPersistedRef = useRef<string | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);

  // Hydrate the profile store once on mount (and on an explicit retry). Only an
  // absent key seeds a Default profile (first try the legacy 'azureConfig' key
  // as a one-time migration, otherwise start blank). A LOAD ERROR does NOT seed
  // and does NOT set hydrated, so autosave stays inert and cannot overwrite
  // profiles that may still exist server-side; the user gets a retry instead.
  // Secrets are never loaded.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Transient-abort tolerance (observed live 2026-07-08): the platform
      // bridge can abort requests fired during app boot ("Error: Aborted" on
      // the first azureProfiles read) and the same read succeeds moments
      // later. Retry a couple of times with a short backoff before surfacing
      // the manual-retry UI; a persistent failure still lands there.
      let loaded = await loadProfileStore();
      for (
        let attempt = 1;
        attempt <= 2 && !cancelled && loaded.status === 'error';
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 750 * attempt));
        if (cancelled) {
          return;
        }
        loaded = await loadProfileStore();
      }
      if (cancelled) {
        return;
      }
      if (loaded.status === 'error') {
        setLoadError(loaded.message);
        return;
      }
      const persisted = loaded.status === 'loaded' ? loaded.store : EMPTY_PROFILE_STORE;
      let next = persisted;
      if (next.profiles.length === 0) {
        const legacy = await loadLegacyAzureConfig();
        if (cancelled) {
          return;
        }
        const id = crypto.randomUUID();
        next = { profiles: [{ id, name: 'Default', config: legacy }], activeProfileId: id };
      } else if (next.activeProfileId === null) {
        next = setActiveProfile(next, next.profiles[0].id);
      }
      // Record what was actually persisted; if we seeded or corrected the active
      // profile, `next` differs and the autosave effect will write it.
      lastPersistedRef.current = serializeProfileStore(persisted);
      setLoadError('');
      setStore(next);
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  // Debounced autosave of the whole store. Inert until hydrated. Once hydrated,
  // if the current store differs from what is persisted, wait ~800ms then PUT the
  // plain azureProfiles entry and record it. Editing any config field, switching,
  // renaming, and creating/deleting connections all flow through here.
  useEffect(() => {
    if (!hydrated) {
      return;
    }
    const current = serializeProfileStore(store);
    if (current === lastPersistedRef.current) {
      return;
    }
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(kvUrl('azureProfiles'), { method: 'PUT', body: current });
          if (res.ok) {
            lastPersistedRef.current = current;
          }
        } catch {
          // Best-effort autosave; the next edit retries.
        }
      })();
    }, 800);
    return () => clearTimeout(timer);
  }, [hydrated, store]);

  const activeConfig = getActiveConfig(store);
  const activeProfile = getActiveProfile(store);

  // The cloud port adapters for the @soc/ui screens, rebuilt when the
  // ACTIVE connection's tenant changes (the ARM token flow is tenant-scoped;
  // see makeCloudPorts). Construction is side-effect free. The logger rides
  // along BY REFERENCE (module-scoped), so its ring survives the rebuild and
  // every usecase invoked with this bundle logs for free.
  const cloudPorts = useMemo(
    () => makeCloudPorts(activeConfig.tenantId, appLogger),
    [activeConfig.tenantId]
  );

  // Which top-level surface to show (loading / AUA gate / mode select /
  // frame). Computed every render from the two loadable states.
  const phase = resolveFramePhase(acceptance, mode);

  // Stable accessor for the Logs screen: a fresh snapshot of the module-
  // scoped logger ring on every call (mount and Refresh).
  const getRecentLogs = useCallback(async () => appLogger.getRecent(), []);

  // The ONE budgeted status poller (@soc/ui hook over the @soc/core
  // poll-scheduler). For this unit only the connection-status poll registers:
  // a KV key listing once a minute proves the platform bridge and the leader
  // are reachable. Every future poll (health, data-flow, drift) registers
  // HERE with a priority - never its own setInterval - so the shared
  // ~100 req/min proxy budget has one enforcement point.
  const connectionPolls = useMemo(
    () => [
      {
        id: 'connection-status',
        intervalMs: 60_000,
        priority: 10,
        run: async () => {
          try {
            await appStateStore.list('azure');
            setPlatformLink('ok');
          } catch (err) {
            setPlatformLink(`failed - ${String(err)}`);
            // At most one warn per poll interval - well within the KV
            // mirror's write budget, and exactly the event a support bundle
            // should carry.
            appLogger.warn('connection-status poll failed', {
              error: String(err),
            });
          }
        },
      },
    ],
    []
  );
  useConsolidatedPolling({
    polls: connectionPolls,
    maxPerMinute: 30,
    enabled: phase.phase === 'ready',
  });

  // Fields the Onboard screen still needs. Non-empty means the screen is
  // replaced by a message pointing at the Setup page's sections.
  const missingOnboardFields = ONBOARD_REQUIRED_FIELDS.filter(
    (field) => activeConfig[field].trim() === ''
  );
  // The change-request context handed to the Setup sections: the fixed app name
  // plus the active connection's non-secret config. Re-derived each render so
  // the generated tickets and their embedded diagrams reflect the current inputs.
  const changeRequestCtx: ChangeRequestContext = { appName: APP_NAME, config: activeConfig };
  const secretLive = liveSecretProfileId !== null && liveSecretProfileId === store.activeProfileId;
  // The live secret is still marked stored, but the active connection's identity
  // has been edited away from what that secret authenticates. Do NOT auto-clear;
  // surface a hint telling the user to Clear stored secret and re-enter.
  const identityDrifted =
    secretLive &&
    liveSecretIdentity !== null &&
    (normalizeIdentity(activeConfig.tenantId) !== normalizeIdentity(liveSecretIdentity.tenantId) ||
      normalizeIdentity(activeConfig.clientId) !== normalizeIdentity(liveSecretIdentity.clientId));

  // Patch the active profile's config. Uses a functional update so it always
  // reads the latest store, never a stale closure.
  const updateField = useCallback((patch: Partial<AzureConfig>) => {
    setStore((s) => updateActiveConfig(s, { ...getActiveConfig(s), ...patch }));
  }, []);

  // Apply a deliberate switch of the active profile: adopt the new store, then
  // invalidate cached secrets/tokens per computeInvalidation AND the live-secret
  // ownership rule (only one connection's secret can be live at azureBasic).
  // Discovery lists and permission-validation output clear automatically because
  // the credentials panel is keyed by the active profile id and remounts.
  const applySwitch = useCallback(
    (prevConfig: AzureConfig, nextConfig: AzureConfig, nextId: string | null, nextStore: ProfileStore) => {
      setStore(nextStore);
      setRenaming(false);
      const inv = computeInvalidation(prevConfig, nextConfig);
      const needSecretClear = inv.clearSecret || liveSecretProfileId !== nextId;
      // Independent fire-and-forget clears: DELETE responses are lost by the
      // bridge, so sequencing the second delete after the first would mean it
      // never runs (the old secret would stay live after an identity switch).
      if (inv.clearToken) {
        void kvDelete('azureArmToken');
      }
      if (needSecretClear) {
        void kvDelete('azureBasic');
      }
      if (needSecretClear) {
        setLiveSecretProfileId(null);
        setLiveSecretIdentity(null);
        setSwitchNotice(
          'Switched connection - enter the client secret for this connection in the App registration and connect section on Setup and Save and connect to authenticate.'
        );
      } else {
        setSwitchNotice('');
      }
    },
    [liveSecretProfileId]
  );

  // Connection <select>: the EXPLICIT switch. No-op when the selection is
  // unchanged or blank.
  const handleSelectProfile = (nextId: string) => {
    if (nextId === '' || nextId === store.activeProfileId) {
      return;
    }
    const prevConfig = getActiveConfig(store);
    const nextStore = setActiveProfile(store, nextId);
    applySwitch(prevConfig, getActiveConfig(nextStore), nextId, nextStore);
  };

  // New connection: a fresh blank profile with a shell-minted id, made active.
  const handleNewConnection = () => {
    const id = crypto.randomUUID();
    const profile: ConnectionProfile = {
      id,
      name: `Connection ${store.profiles.length + 1}`,
      config: { ...EMPTY_AZURE_CONFIG },
    };
    const prevConfig = getActiveConfig(store);
    const nextStore = setActiveProfile(upsertProfile(store, profile), id);
    applySwitch(prevConfig, getActiveConfig(nextStore), id, nextStore);
  };

  // Delete the active connection. Guard: never leave zero connections - deleting
  // the last one replaces it with a fresh blank 'Default'.
  const handleDeleteConnection = () => {
    const activeId = store.activeProfileId;
    if (activeId === null) {
      return;
    }
    const prevConfig = getActiveConfig(store);
    if (store.profiles.length <= 1) {
      const id = crypto.randomUUID();
      const nextStore: ProfileStore = {
        profiles: [{ id, name: 'Default', config: { ...EMPTY_AZURE_CONFIG } }],
        activeProfileId: id,
      };
      applySwitch(prevConfig, getActiveConfig(nextStore), id, nextStore);
      return;
    }
    const nextStore = removeProfile(store, activeId);
    applySwitch(prevConfig, getActiveConfig(nextStore), nextStore.activeProfileId, nextStore);
  };

  // Clear stored secret: the explicit way to force re-auth without switching
  // connections (e.g. after editing the active connection's tenant/client id).
  const handleClearSecret = () => {
    // Independent fire-and-forget clears (DELETE responses are lost by the
    // bridge; sequenced awaits would strand the second delete).
    void kvDelete('azureBasic');
    void kvDelete('azureArmToken');
    setLiveSecretProfileId(null);
    setLiveSecretIdentity(null);
    setSwitchNotice('Stored secret cleared - re-enter the client secret in the App registration and connect section on Setup and Save and connect to re-authenticate.');
  };

  const startRename = () => {
    setRenameValue(activeProfile?.name ?? '');
    setRenaming(true);
  };
  const commitRename = () => {
    const id = store.activeProfileId;
    if (id !== null) {
      const trimmed = renameValue.trim();
      const name = trimmed === '' ? (activeProfile?.name ?? 'Connection') : trimmed;
      setStore(renameProfile(store, id, name));
    }
    setRenaming(false);
  };
  const cancelRename = () => {
    setRenaming(false);
  };

  // Save-secret success: record which connection (and identity) the live secret
  // now belongs to, and clear any outstanding "enter the secret" notice.
  const handleSecretSaved = useCallback(
    (profileId: string, savedTenantId: string, savedClientId: string) => {
      setLiveSecretProfileId(profileId);
      setLiveSecretIdentity({ tenantId: savedTenantId, clientId: savedClientId });
      setSwitchNotice('');
    },
    [],
  );

  // The one-shot secret probe per connection per session (ref-guarded so
  // re-renders never re-fire it; a profile switch probes the new profile).
  // Skips honestly when there is no identity to probe with - the journey's
  // connect stage covers that case without a warning.
  useEffect(() => {
    const profileId = store.activeProfileId;
    if (!hydrated || profileId === null) return;
    if (activeConfig.tenantId.trim() === '' || activeConfig.clientId.trim() === '') return;
    if (liveSecretProfileId === profileId) return;
    if (probedProfileRef.current === profileId) return;
    probedProfileRef.current = profileId;
    let cancelled = false;
    setSecretProbe({ state: 'checking' });
    void (async () => {
      try {
        const keys = await appStateStore.list('azure');
        if (cancelled) return;
        if (!keys.includes('azureBasic')) {
          setSecretProbe({ state: 'missing' });
          return;
        }
        const token = await acquireArmToken(activeConfig.tenantId);
        await appStateStore.set('azureArmToken', token.access_token, { encrypted: true });
        if (cancelled) return;
        handleSecretSaved(profileId, activeConfig.tenantId, activeConfig.clientId);
        setSecretProbe({ state: 'live' });
      } catch (err) {
        if (!cancelled) {
          setSecretProbe({ state: 'failed', detail: String(err) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    hydrated,
    store.activeProfileId,
    activeConfig.tenantId,
    activeConfig.clientId,
    liveSecretProfileId,
    handleSecretSaved,
  ]);

  // The Setup connect section's shell-specific connect mechanics (promoted
  // verbatim from Diagnostics panel 3): write the encrypted, write-only
  // azureBasic entry (base64 of clientId:clientSecret), then VERIFY the
  // secret by acquiring an ARM token and storing it encrypted under
  // azureArmToken so proxies.yml can inject Bearer server-side. The secret is
  // marked live for this connection as soon as azureBasic is written (badge +
  // identity tracking) even if the token step fails; a full success bumps
  // connectNonce so the resources section auto-runs discovery. Resolves a
  // result object, never throws (the section honors secretStored on partial
  // failures).
  const connectAzure = async (input: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
  }): Promise<AzureConnectResult> => {
    try {
      await appStateStore.set('azureBasic', btoa(`${input.clientId}:${input.clientSecret}`), {
        encrypted: true,
      });
    } catch (err) {
      return { ok: false, secretStored: false, message: String(err) };
    }
    // The encrypted slot is populated now, so mark the secret live regardless
    // of whether the token step below succeeds.
    if (store.activeProfileId !== null) {
      handleSecretSaved(store.activeProfileId, input.tenantId, input.clientId);
    }
    try {
      const token = await acquireArmToken(input.tenantId);
      await appStateStore.set('azureArmToken', token.access_token, { encrypted: true });
      handleConnected();
      return {
        ok: true,
        secretStored: true,
        message: [
          'Connected.',
          '  client secret: saved (encrypted, write-only) for this connection',
          `  ARM token: acquired and stored encrypted (expires_in ${token.expires_in ?? '(missing)'})`,
          '',
          'Next: the Select resources and grant permissions section below discovers',
          'subscriptions, selects your resources, and grants roles.',
        ].join('\n'),
      };
    } catch (err) {
      return {
        ok: false,
        secretStored: true,
        message: `Client secret saved, but the connect verification failed.\n${String(err)}`,
      };
    }
  };

  // The EXPLICIT scope commit from the Integrate page's Azure Resources
  // section (the AzureTargetingScreen cascade it composes): the ONE way a
  // browsed subscription/RG/workspace becomes the active target. Runs the pure
  // @soc/core commitTargetScope (MERGE into the active profile - identity
  // fields survive untouched), persists via the store autosave, applies the
  // returned invalidation (a pure scope change only ever stales permission
  // results, but the token/secret flags are honored defensively), and surfaces
  // the consequence through the connection-bar notice pattern.
  const handleCommitScope = async (scope: TargetScope): Promise<CommitScopeOutcome> => {
    const result = commitTargetScope(store, scope);
    if (!result.committed) {
      return {
        committed: false,
        notice: 'No active connection - create or select a connection first.',
      };
    }
    setStore(result.store);
    if (result.invalidation.clearToken) {
      void kvDelete('azureArmToken');
    }
    if (result.invalidation.clearSecret) {
      void kvDelete('azureBasic');
      setLiveSecretProfileId(null);
      setLiveSecretIdentity(null);
    }
    const notice =
      commitNoticeText(result.invalidation) ||
      'Target scope unchanged - it was already committed.';
    setSwitchNotice(notice);
    return { committed: true, notice };
  };

  // Accept the acceptable-use agreement: the shell mints the timestamp (core
  // never calls Date) and persists the record as a plain KV entry. A failed
  // write is non-fatal (legacy contract): the session proceeds and the gate
  // simply re-prompts on the next launch.
  const handleAccept = async () => {
    const record: AcceptanceRecord = { acceptedAt: new Date().toISOString() };
    try {
      await appStateStore.set(AUA_ACCEPTANCE_KEY, serializeAcceptanceRecord(record));
    } catch {
      // Non-fatal; re-prompts next launch.
    }
    setAcceptance(record);
  };

  // First-run mode choice: persist, then adopt. A failed write holds the
  // mode for this session only and re-asks next launch.
  const handleSelectMode = async (next: AppMode) => {
    try {
      await appStateStore.set(APP_MODE_KEY, serializeAppMode(next));
    } catch {
      // Non-fatal; re-asks next launch.
    }
    setMode(next);
  };

  // The Reconfigure contract (mined from the legacy Settings page): write an
  // EMPTY mode record - which parses back to null, "not yet chosen" - then
  // reload so the next load lands in ModeSelect. Connections and their
  // configs are untouched. If the write fails, fall back to an in-session
  // reset so the user still reaches the chooser.
  const handleReconfigure = async () => {
    try {
      await appStateStore.set(APP_MODE_KEY, EMPTY_MODE_RECORD);
      window.location.reload();
    } catch {
      setMode(null);
    }
  };

  // Gate order is the contract: acceptance before ANYTHING else, then mode
  // selection, then the frame. The loading branch is what keeps the gate
  // from flashing for already-accepted users.
  if (phase.phase === 'loading') {
    return (
      <div className="harness">
        <header className="harness-header">
          <h1 className="harness-title">{APP_NAME}</h1>
          <p className="harness-subtitle">Loading...</p>
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

  if (!hydrated) {
    return (
      <div className="harness">
        <header className="harness-header">
          <h1 className="harness-title">{APP_NAME}</h1>
          {loadError === '' ? (
            <p className="harness-subtitle">Loading connections...</p>
          ) : (
            <>
              <p className="harness-subtitle">
                Could not load saved connections: {loadError}. Not seeding a blank profile, to avoid
                overwriting connections that may still be stored. Retry when the leader is reachable.
              </p>
              <div className="panel-controls">
                <button className="run-button" onClick={() => setLoadAttempt((n) => n + 1)}>
                  Retry loading connections
                </button>
              </div>
            </>
          )}
        </header>
      </div>
    );
  }

  // The journey readiness FACTS (ux-flow-plan 4.1, Unit 6.5), composed from
  // signals this shell already owns - nothing new is probed. The split
  // replaces the conflated five-field gate: identity (tenant + client ids on
  // the active connection), secret liveness (SESSION-ONLY: live only when
  // this session connected it under the current identity, else the honest
  // 'unknown' - a secret from an earlier session may still be live
  // server-side but nothing has proven it), and committed scope (the three
  // scope fields the Azure Targeting commit writes). criblReachable maps the
  // consolidated poll's platform-link status: this app runs inside the
  // leader, so a healthy bridge IS Cribl reachability.
  const journeyFacts: JourneyFacts = {
    accepted: typeof acceptance === 'object' && acceptance !== null,
    mode: phase.mode,
    identityPresent:
      activeConfig.tenantId.trim() !== '' && activeConfig.clientId.trim() !== '',
    // The probe resolves the honest 'unknown': a verified token acquisition
    // reads 'live' (via secretLive), a verified miss/failure reads 'missing'.
    secretLive:
      secretLive && !identityDrifted
        ? 'live'
        : secretProbe.state === 'missing' || secretProbe.state === 'failed'
          ? 'missing'
          : 'unknown',
    scopeCommitted:
      activeConfig.subscriptionId.trim() !== '' &&
      activeConfig.resourceGroup.trim() !== '' &&
      activeConfig.workspaceName.trim() !== '',
    criblReachable:
      platformLink === 'ok' ? true : platformLink === 'checking...' ? undefined : false,
  };

  // The VERIFIED secret notice (user direction 2026-07-14 - replaces the
  // speculative "not entered this session" warning): null while the secret
  // is live, the probe is still running, or there is nothing to probe yet.
  // Only a VERIFIED absence/failure warns.
  const secretNotice = secretLive
    ? null
    : secretProbe.state === 'missing'
      ? 'No client secret is stored for this connection (verified just now). Enter it ' +
        'in the App registration and connect section on Setup and Save and connect.'
      : secretProbe.state === 'failed'
        ? 'The stored client secret FAILED verification just now - token acquisition ' +
          'was refused. Re-enter the secret in the App registration and connect ' +
          `section on Setup. Detail: ${secretProbe.detail}`
        : null;

  // The connection bar: shell chrome that stays visible within the frame,
  // above whatever screen is active. Connection select/create/rename/delete,
  // the live-secret badge, and the consolidated poll's platform-link badge.
  const connectionBar = (
    <div className="connection-bar">
        <div className="connection-bar-main">
          <label className="connection-select">
            <span className="field-label">Connection</span>
            {renaming ? (
              <input
                className="connection-rename-input"
                type="text"
                value={renameValue}
                autoFocus
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    commitRename();
                  } else if (e.key === 'Escape') {
                    cancelRename();
                  }
                }}
              />
            ) : (
              <select
                value={store.activeProfileId ?? ''}
                onChange={(e) => handleSelectProfile(e.target.value)}
              >
                {store.profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </label>
          <div className="connection-actions">
            {renaming ? (
              <>
                <button className="run-button" onClick={commitRename}>
                  Save name
                </button>
                <button className="run-button" onClick={cancelRename}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button className="run-button" onClick={handleNewConnection}>
                  New connection
                </button>
                <button className="run-button" onClick={startRename}>
                  Rename
                </button>
                <button className="run-button" onClick={handleDeleteConnection}>
                  Delete
                </button>
                <button className="run-button" onClick={handleClearSecret}>
                  Clear stored secret
                </button>
              </>
            )}
          </div>
          <span className={`secret-badge ${secretLive ? 'secret-badge-stored' : 'secret-badge-none'}`}>
            secret:{' '}
            {secretLive
              ? 'live (verified)'
              : secretProbe.state === 'checking'
                ? 'verifying...'
                : secretProbe.state === 'missing'
                  ? 'not stored'
                  : secretProbe.state === 'failed'
                    ? 'failed verification'
                    : 'unknown'}
          </span>
          <span
            className="scope-chip"
            title="The committed Azure target scope (subscription / resource group / workspace) of the active connection. Change it from the Integrate page's Azure Resources section (Use this target) or the Setup page's resource selection."
          >
            target:{' '}
            {formatScopeChip({
              subscriptionId: activeConfig.subscriptionId,
              resourceGroup: activeConfig.resourceGroup,
              workspaceName: activeConfig.workspaceName,
            })}
          </span>
          <span
            className={`link-badge ${platformLink === 'ok' ? 'link-badge-ok' : 'link-badge-off'}`}
            title={platformLink}
          >
            platform link:{' '}
            {platformLink === 'ok' ? 'ok' : platformLink === 'checking...' ? 'checking' : 'failed'}
          </span>
        </div>
        {switchNotice !== '' && <p className="connection-notice">{switchNotice}</p>}
        {identityDrifted && (
          <p className="connection-hint">
            identity changed - the stored secret was saved under a different tenant/client id. Use
            Clear stored secret and re-enter the secret for this identity.
          </p>
        )}
      </div>
  );

  // The Phase 1 diagnostics panels, now living behind the frame's Diagnostics
  // route (retitled from Spike Harness and demoted below the journey and
  // tools sections - ux-flow-plan 3.3). The former panels 3 and 4 (connect /
  // resource selection) were promoted to the Setup page; what remains is pure
  // platform diagnostics.
  const harnessView = (
    <>
      <header className="harness-header">
        <h1 className="harness-title">Diagnostics (Phase 1 Spike Harness)</h1>
        <p className="harness-subtitle">
          Sequential diagnostics for the Cribl App Platform: globals, KV store semantics,
          proxy header injection, Azure AD token flow, ARM access, and iframe download behavior.
          Pick or create a connection above, then run the panels top to bottom. Identity entry
          and resource selection live on the Setup page.
        </p>
      </header>
      <PlatformGlobalsPanel />
      <KvStorePanel />
      <TokenAcquisitionPanel tenantId={activeConfig.tenantId} />
      <ArmCallPanel />
      <ArtifactDownloadPanel />
    </>
  );

  // The Setup page's shell-composed sections (the promoted Diagnostics panels
  // 3 and 4 plus the GitHub token surface): Azure connect (shell mechanics
  // injected via connectAzure), resource selection + role grant (ports-driven),
  // and the Repositories/PAT surface so everything setup-shaped lives on one
  // page. Keyed by the active profile so switching connections remounts them
  // and discards cached discovery and validation state.
  const setupSections = (
    <>
      <AzureConnectSection
        key={`connect-${store.activeProfileId ?? 'none'}`}
        tenantId={activeConfig.tenantId}
        onTenantIdChange={(v) => updateField({ tenantId: v })}
        clientId={activeConfig.clientId}
        onClientIdChange={(v) => updateField({ clientId: v })}
        setupPath={activeConfig.setupPath}
        onSetupPathChange={(v) => updateField({ setupPath: v })}
        secretLive={secretLive}
        ctx={changeRequestCtx}
        onConnect={connectAzure}
        storageNote={
          'Save and connect combines the client secret with the client ID as ' +
          'base64(clientId:clientSecret) and writes it to the encrypted, write-only KV entry ' +
          'azureBasic, then acquires an Azure AD ARM token (grant_type=client_credentials, ARM ' +
          'scope) and stores it encrypted under azureArmToken. The app never sets an Authorization ' +
          'header - the platform proxy injects the secret and token server-side per proxies.yml, ' +
          'and the secret can never be read back. azureBasic is a single shared slot, so only one ' +
          "connection's secret is live at a time: switching connections clears it and you re-enter " +
          'and reconnect here. If a secret is already stored the field stays blank - enter a new ' +
          'value only to replace it. The client ID, tenant ID, and setup path are non-secret ' +
          'configuration remembered per connection in the plain azureProfiles KV entry. The ' +
          "connection bar above shows whether this connection's secret is live this session."
        }
      />
      <AzureResourcesSection
        key={`resources-${store.activeProfileId ?? 'none'}`}
        clientId={activeConfig.clientId}
        tenantId={activeConfig.tenantId}
        setupPath={activeConfig.setupPath}
        subscriptionId={activeConfig.subscriptionId}
        onSubscriptionIdChange={(v) => updateField({ subscriptionId: v })}
        rgName={activeConfig.resourceGroup}
        onRgNameChange={(v) => updateField({ resourceGroup: v })}
        workspaceName={activeConfig.workspaceName}
        onWorkspaceNameChange={(v) => updateField({ workspaceName: v })}
        connectNonce={connectNonce}
        ctx={changeRequestCtx}
        storageContextLabel={`Stored in KV for app ID ${window.CRIBL_APP_ID ?? '(unknown)'}:`}
      />
      <RepositoriesScreen platform="cloud" />
    </>
  );

  // The Setup route (ux-flow-plan 4.3, Unit 6.5 + the 2026-07-14 promotion):
  // the state-aware landing surface BOTH shells open on every launch. Facts
  // in, rails and the single next action out - position is derived from
  // persisted state on every render, so resume is automatic and there is no
  // wizard-progress blob to drift. The setup sections (Azure connect,
  // resource selection + role grant, GitHub token) render right on this page,
  // so the journey's Connect and Target stages resolve here. Mounted in a
  // PortsProvider for the embedded RecentRuns and the ports-driven sections.
  const renderHome = (nav: AppFrameNav) => (
    <>
      <header className="harness-header">
        <h1 className="harness-title">Setup</h1>
        <p className="harness-subtitle">
          Where this install is on the journey, the single next action, and
          every setup task on one page: connect the Entra app registration,
          select Azure resources and grant roles, and connect GitHub content.
        </p>
      </header>
      <PortsProvider ports={cloudPorts} config={activeConfig}>
        <HomeScreen
          facts={journeyFacts}
          links={phase.mode === 'azure-only' ? AZURE_ONLY_JOURNEY_LINKS : JOURNEY_LINKS}
          onNavigate={nav.navigate}
          setupSections={setupSections}
        />
      </PortsProvider>
    </>
  );

  // Preflight route (porting-plan Unit 9, ENG-38 delta / GUI-11): the Setup
  // Wizard's PERMISSION-CHECK step in the onboarding consent flow. The panel
  // runs the @soc/core side-runners over THIS shell's ports (Azure effective
  // actions + live probes; Cribl capability probes) and renders per-capability
  // dots + Retry / Switch account. On the CLOUD shell the Cribl side is
  // granted-by-platform (mode 'cloud'), so criblShellMode is 'cloud'. Switch
  // account clears the live secret for this session and returns to the Setup
  // page's connect section. requires 'azure' - the Azure side is the
  // informative half here; INFORMATIONAL, it never gates the deploy partition.
  const renderPreflight = (nav: AppFrameNav) => (
    <>
      <header className="harness-header">
        <h1 className="harness-title">Permission preflight</h1>
        <p className="harness-subtitle">
          What the connected identity can and cannot do, on both Azure and
          Cribl, before a deploy is attempted. Effective-action checks and live
          probes are the truth; role names are decoration. This is
          informational - it reports access, it does not gate the deploy.
        </p>
      </header>
      <PortsProvider ports={cloudPorts} config={activeConfig}>
        <RbacPreflightPanel
          key={`preflight-${store.activeProfileId ?? 'none'}`}
          criblShellMode="cloud"
          defaultSetupPath={defaultPreflightPath(activeConfig.setupPath)}
          onSwitchAccount={() => {
            setLiveSecretProfileId(null);
            setLiveSecretIdentity(null);
            nav.navigate('home');
          }}
        />
      </PortsProvider>
    </>
  );

  // The Integrate route (legacy-flow-analysis.md single-page decision): THE
  // MVP centerpiece - the single-page Integrate flagship composing the built
  // screens (Azure Targeting cascade + the operable native-table deploy) as
  // numbered sections, with coming-soon sections rendered honestly and a
  // persistent deploy-readiness footer. requires 'both' (it both targets
  // Azure and deploys to Cribl in one page). No hard wall: controls stay
  // visible and gate at the commit actions inside the composed screens
  // (read-ahead). Keyed by the active profile so switching connections drops
  // in-page deploy state. This page composes and supersedes the standalone
  // Azure Targeting / Review surfaces (their nav items are retired).
  const renderIntegrate = () => (
    <>
      <header className="harness-header">
        <h1 className="harness-title">Integrate</h1>
        <p className="harness-subtitle">
          The single-page integration flow: solution browser, sample data,
          Azure resources, Cribl configuration, and the operable native-table
          deploy on one page, with deploy readiness always visible. The
          gap-analysis and rule-coverage sections arrive in later units.
        </p>
      </header>
      {secretNotice !== null && (
        <p className="connection-notice">{secretNotice}</p>
      )}
      <PortsProvider ports={cloudPorts} config={activeConfig}>
        <IntegrateScreen
          key={`integrate-${store.activeProfileId ?? 'none'}`}
          scopeCommitted={journeyFacts.scopeCommitted}
          offline={!hasAzure(phase.mode)}
          onCommitScope={handleCommitScope}
          criblDefaults={appOptions.cribl}
          operationDefaults={appOptions.operation}
          onOperationChange={persistOperation}
          roleGuidance={ROLE_GUIDANCE}
          mode={phase.mode}
        />
      </PortsProvider>
    </>
  );

  // The Onboard route: gated on the five config fields the use-case cannot
  // run without; the escape hatch navigates to Setup through the frame.
  const renderOnboard = (nav: AppFrameNav) => (
    <>
      <header className="harness-header">
        <h1 className="harness-title">Onboard a native table</h1>
        <p className="harness-subtitle">
          The first walking-skeleton feature screen from the shared UI package: deploy a
          Kind:Direct DCR for one native Log Analytics table and create the matching Cribl
          Sentinel destination, end to end through the shared onboardTable use-case.
        </p>
      </header>
      {missingOnboardFields.length > 0 ? (
        <section className="panel">
          <h2 className="panel-title">Connection incomplete</h2>
          <p className="panel-desc">
            The active connection is missing required configuration:{' '}
            {missingOnboardFields.join(', ')}. Setup shows the whole journey and names the
            single next step. Connect first in the App registration and connect section on
            Setup - that fills the tenant and client ids. Then choose WHERE to deploy in the
            Select resources and grant permissions section (or commit a scope from the
            Integrate page&apos;s Azure Resources section). The Run action unlocks once all
            five fields are set.
          </p>
          <div className="panel-controls">
            <button className="run-button" onClick={() => nav.navigate('home')}>
              Open Setup
            </button>
          </div>
        </section>
      ) : (
        <>
          {secretNotice !== null && (
            <p className="connection-notice">{secretNotice}</p>
          )}
          <PortsProvider ports={cloudPorts} config={activeConfig}>
            <OnboardTableScreen
              key={`onboard-${store.activeProfileId ?? 'none'}`}
              criblDefaults={appOptions.cribl}
              operationDefaults={appOptions.operation}
              roleGuidance={ROLE_GUIDANCE}
            />
          </PortsProvider>
        </>
      )}
    </>
  );

  // The DCR Automation route (porting-plan Unit 6): many tables as ONE parent
  // onboard-batch job - shared prologue (workspace fetch; in DCE mode one
  // batch-wide DCE plus the AMPLS association when public access is
  // disabled) and one step per table. Gated on the same five config fields
  // as Onboard; the shell injects the pacing hooks (BATCH_PACING) and the
  // persisted Unit 4 options, and hands navigation to the Options screen for
  // editing the defaults.
  const renderBatch = (nav: AppFrameNav) => (
    <>
      <header className="harness-header">
        <h1 className="harness-title">Batch onboarding</h1>
        <p className="harness-subtitle">
          Deploy DCRs for many tables in one run: per-table isolation and
          skip-existing semantics, Direct or DCE mode with Private Link
          support, resumable progress, and template-only export - through the
          shared onboardBatch use-case.
        </p>
      </header>
      {missingOnboardFields.length > 0 ? (
        <section className="panel">
          <h2 className="panel-title">Connection incomplete</h2>
          <p className="panel-desc">
            The active connection is missing required configuration:{' '}
            {missingOnboardFields.join(', ')}. Setup shows the whole journey and names the
            single next step: connect first in the App registration and connect section on
            Setup, then choose the target in the Select resources and grant permissions
            section. The Run action unlocks once all five fields are set.
          </p>
          <div className="panel-controls">
            <button className="run-button" onClick={() => nav.navigate('home')}>
              Open Setup
            </button>
          </div>
        </section>
      ) : (
        <>
          {secretNotice !== null && (
            <p className="connection-notice">{secretNotice}</p>
          )}
          <PortsProvider ports={cloudPorts} config={activeConfig}>
            <BatchDeployScreen
              key={`batch-${store.activeProfileId ?? 'none'}`}
              pacing={BATCH_PACING}
              operationDefaults={appOptions.operation}
              criblDefaults={appOptions.cribl}
              forcedTemplateOnly={!hasCribl(phase.mode)}
            />
          </PortsProvider>
        </>
      )}
    </>
  );

  // DCR Automation (consolidated): one surface with a Single/Batch toggle over
  // the single-table onboard and batch onboard flows (matching the legacy app's
  // single "DCR Automation" page). Single onboards one table live to Cribl, so
  // it needs a Cribl connection; in modes without Cribl the Single tab is
  // disabled and Batch (template-only) is the usable mode.
  const renderDcrAutomation = (nav: AppFrameNav) => (
    <DcrAutomationScreen
      single={renderOnboard(nav)}
      batch={renderBatch(nav)}
      inventory={
        <PortsProvider ports={cloudPorts} config={activeConfig}>
          <DcrInventoryPanel />
        </PortsProvider>
      }
      singleDisabledReason={
        hasCribl(phase.mode)
          ? undefined
          : 'Single-table onboarding creates a Cribl destination, so it needs a live Cribl connection. Batch supports template-only export without Cribl.'
      }
    />
  );

  // The Logs route (porting-plan Unit 3): the shared diagnostics viewer over
  // the module-scoped PlatformLogger's ring, plus the support-bundle download
  // (logs + recent job records + the platform facts below) through the
  // ArtifactSink port. requires: 'none' - diagnostics must be reachable in
  // every mode.
  const logsView = (
    <>
      <header className="harness-header">
        <h1 className="harness-title">Logs</h1>
        <p className="harness-subtitle">
          Diagnostics recorded by this session&apos;s logger (bounded in-memory
          ring; warnings and errors also persist to one rolling KV entry).
          Secrets and tokens are excluded by construction.
        </p>
      </header>
      <PortsProvider ports={cloudPorts} config={activeConfig}>
        <LogsScreen
          getRecentLogs={getRecentLogs}
          platformInfo={{
            shell: 'cribl-cloud-app',
            application: APP_NAME,
            appId: window.CRIBL_APP_ID ?? null,
            mode: phase.mode,
            activeConnection: activeProfile?.name ?? null,
            platformLink,
          }}
        />
      </PortsProvider>
    </>
  );

  // Event Hub Discovery (roadmap Phase 4, EVH-03 + LOG-16): Resource Graph
  // namespace inventory + per-namespace hub listing over the ARM proxy, and
  // local generation of Cribl Event Hub source configs. requires: 'azure'.
  const eventHubDiscoveryView = (
    <>
      <header className="harness-header">
        <h1 className="harness-title">Event Hub Discovery</h1>
        <p className="harness-subtitle">
          Inventory the subscription's Event Hubs and generate Cribl Stream
          source configurations for the hubs worth onboarding.
        </p>
      </header>
      <PortsProvider ports={cloudPorts} config={activeConfig}>
        <EventHubDiscoveryScreen />
      </PortsProvider>
    </>
  );

  // Vendor Mapping Catalog: the documented source-field -> Sentinel-column
  // suggestions the analysis applies (hand-verified vendor-doc citations +
  // Elastic-mined entries). Pure bundled data; no ports, no IO.
  const mappingCatalogView = (
    <>
      <header className="harness-header">
        <h1 className="harness-title">Vendor Mapping Catalog</h1>
        <p className="harness-subtitle">
          The vendor-suggested Sentinel field mappings applied during the DCR
          Gap Analysis, with the documentation behind each one.
        </p>
      </header>
      <MappingCatalogScreen />
    </>
  );

  // Architecture Patterns (roadmap Phase 4 queued item): the data-driven
  // reference-architecture advisor. Pure core recommender + inline-SVG
  // diagrams; no ports, no IO. requires: 'none' - advisory in every mode.
  const architectureView = (
    <>
      <header className="harness-header">
        <h1 className="harness-title">Architecture Patterns</h1>
        <p className="harness-subtitle">
          Reference architectures for your Cribl + Azure footprint. Select what
          is in use; get the matching patterns, diagrams, and considerations.
        </p>
      </header>
      <ArchitectureScreen />
    </>
  );

  // Repositories (porting-plan Unit 14): the GitHub PAT settings page over the
  // cloud shell's content ports (validate-then-store the encrypted, write-only
  // githubPat; reachability + PAT-valid status; the 13-step walkthrough). A PAT
  // is effectively required on cloud (shared egress IP). requires: 'none' -
  // reachable in every mode, and content is external (proxies, not product API).
  const repositoriesView = (
    <>
      <header className="harness-header">
        <h1 className="harness-title">Repositories</h1>
        <p className="harness-subtitle">
          Connect to GitHub for Microsoft Sentinel content. A personal access
          token is validated then stored encrypted and write-only - it never
          reaches the browser. Content is fetched lazily per selected solution
          and cached by commit; nothing is mirrored.
        </p>
      </header>
      <PortsProvider ports={cloudPorts} config={activeConfig}>
        <RepositoriesScreen platform="cloud" />
      </PortsProvider>
    </>
  );

  // Packs (porting-plan Unit 19, GUI-19/20 folded): the ONE merged pack
  // inventory over the cloud shell's pack ports - build records, DEPLOYED
  // badges per worker group (truth from the live packs API), storage/retention,
  // download the .crbl via the ArtifactSink (regenerated deterministically from
  // the stored definition - cloud never persists bytes), install-to-group, and
  // delete guarded by scoped record-id validation. requires: 'cribl' - the
  // inventory and its deployed badges need a live Cribl side. Additive: it
  // never touches canDeploy / canDeployContentPath.
  const packsView = (
    <>
      <header className="harness-header">
        <h1 className="harness-title">Pack Maintenance</h1>
        <p className="harness-subtitle">
          Every pack built by this app, with its destination tables, size, and
          live deployed status per worker group. Download the .crbl (regenerated
          on demand from the stored definition), install it into a group, or
          delete an older build. Deployed status is read from the Cribl packs
          API, never from this list.
        </p>
      </header>
      <PortsProvider ports={cloudPorts} config={activeConfig}>
        <PackInventoryScreen key={`packs-${store.activeProfileId ?? 'none'}`} />
      </PortsProvider>
    </>
  );

  // Settings: the Phase 1 exit item graduated into a real screen - platform
  // info, current mode + Reconfigure, and the validate-before-save raw-JSON
  // editor over the active connection's non-secret config.
  const settingsView = (
    <SettingsScreen
      shellName="Cribl.Cloud app platform (sandboxed iframe on the leader)"
      platformRows={[
        { label: 'Application', value: APP_NAME },
        { label: 'App ID', value: window.CRIBL_APP_ID ?? '(not present)' },
        { label: 'Platform API', value: String(window.CRIBL_API_URL) },
        {
          label: 'Platform link',
          value: platformLink,
          tip:
            'The consolidated status poll: one KV key listing per minute,\n' +
            'scheduled under the shared request budget, proves the platform\n' +
            'bridge and the leader are reachable.',
        },
        { label: 'Active connection', value: activeProfile?.name ?? '(none)' },
        {
          label: 'Agreement accepted',
          value:
            typeof acceptance === 'object' && acceptance !== null
              ? acceptance.acceptedAt
              : '(not recorded)',
        },
      ]}
      platformNote={
        'Requests to Azure ride the platform proxy (30s timeout, shared request budget). ' +
        'Secrets live in the app-scoped KV store; encrypted entries are write-only and can ' +
        'only be replaced, never read back.'
      }
      mode={phase.mode}
      onReconfigure={handleReconfigure}
      configEditor={{
        label: `Active connection config - ${activeProfile?.name ?? '(none)'}`,
        json: JSON.stringify(activeConfig, null, 2),
        onSave: (config) => updateField(config),
      }}
      themeControl={themeControl}
    />
  );

  // The frame's route table, SECTIONED per ux-flow-plan 4.4: journey steps
  // in dependency order - Setup (home, now carrying the connect + resource +
  // GitHub sections), then Integrate (the single-page flagship, the PRIMARY
  // journey route), then DCR Automation and Pack Maintenance - then tools
  // (Repositories, Logs, Settings), then Diagnostics last. Requirements
  // still drive mode-aware navigation via the ONE @soc/core filterNavItems
  // pass; grouping is presentation only. Onboard needs BOTH live sides (it
  // deploys to Azure and Cribl in one run); batch-onboard relaxes to 'azure'
  // (recorded Unit 6.5 decision) - in azure-only mode templateOnly is FORCED
  // on because no live Cribl connection exists to deploy destinations to.
  // NAV PRUNE (user directives 2026-07-14): Options RETIRED (never used;
  // defaults persist via appOptions), the standalone Azure Targeting item
  // RETIRED (the Integrate page composes the same cascade and Setup selects
  // resources), the standalone Review item RETIRED (its preview folds into
  // the Integrate flow), and Preflight is relabeled Permission Verification.
  // SECTION SPLIT (user directive 2026-07-09): only Setup (home) and
  // Sentinel Integration are ACTIVE. Every feature not yet validated live
  // parks in the DEVELOPMENT section - still reachable, moved back into
  // journey/tools one item at a time as it passes live testing.
  const routes: AppRoute[] = [
    { id: 'home', label: 'Setup', requires: 'none', section: 'journey', render: renderHome },
    { id: 'integrate', label: 'Sentinel Integration', requires: 'both', section: 'journey', render: renderIntegrate },
    { id: 'dcr-automation', label: 'DCR Automation', requires: 'azure', section: 'journey', render: renderDcrAutomation },
    { id: 'packs', label: 'Pack Maintenance', requires: 'cribl', section: 'journey', render: () => packsView },
    { id: 'repositories', label: 'Repositories', requires: 'none', section: 'tools', render: () => repositoriesView },
    { id: 'logs', label: 'Logs', requires: 'none', section: 'tools', render: () => logsView },
    { id: 'settings', label: 'Settings', requires: 'none', section: 'tools', render: () => settingsView },
    { id: 'preflight', label: 'Permission Verification', requires: 'azure', section: 'development', render: renderPreflight },
    { id: 'eventhub-discovery', label: 'Event Hub Discovery', requires: 'azure', section: 'development', render: () => eventHubDiscoveryView },
    { id: 'architecture', label: 'Architecture Patterns', requires: 'none', section: 'development', render: () => architectureView },
    { id: 'mapping-catalog', label: 'Mapping Catalog', requires: 'none', section: 'development', render: () => mappingCatalogView },
    { id: 'harness', label: 'Diagnostics', requires: 'none', section: 'diagnostics', render: () => harnessView },
  ];

  return (
    <AppFrame
      title={APP_NAME}
      subtitle="Cribl.Cloud shell"
      mode={phase.mode}
      routes={routes}
      topBar={connectionBar}
      footerNote="v1.0.0"
      initialRouteId="home"
      themeControl={themeControl}
    />
  );
}

export default App;
