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
  APP_THEME_KEY,
  AppFrame,
  ArchitectureScreen,
  MappingCatalogScreen,
  AuaGate,
  AzureTargetingScreen,
  EventHubDiscoveryScreen,
  BatchDeployScreen,
  DcrAutomationScreen,
  DcrInventoryPanel,
  EMPTY_MODE_RECORD,
  HomeScreen,
  IntegrateScreen,
  LogsScreen,
  OnboardTableScreen,
  OptionsScreen,
  PackInventoryScreen,
  PortsProvider,
  RbacPreflightPanel,
  RepositoriesScreen,
  ReviewScreen,
  SettingsScreen,
  SetupWizard,
  commitNoticeText,
  formatScopeChip,
  logLineToEntry,
  mergeJourneyLinks,
  parseTargetScope,
  resolveFramePhase,
  serializeTargetScope,
  useConsolidatedPolling,
} from '@soc/ui';
import type {
  AppFrameNav,
  AppRoute,
  CommitScopeOutcome,
  JourneyLinks,
  LoadableAcceptance,
  LoadableMode,
  PlatformInfoRow,
  ThemeControl,
} from '@soc/ui';
import {
  DEFAULT_APP_OPTIONS,
  DEFAULT_THEME_CHOICE,
  EMPTY_AZURE_CONFIG,
  computeInvalidation,
  deriveJourney,
  hasAzure,
  hasCribl,
  parseAcceptanceRecord,
  parseAppMode,
  parseAppOptions,
  serializeAppOptions,
  parseAzureConfig,
  parseThemeChoice,
  resolveTheme,
  serializeAcceptanceRecord,
  serializeAppMode,
  serializeThemeChoice,
} from '@soc/core';
import type {
  AcceptanceRecord,
  AppMode,
  AppOptions,
  OperationOptions,
  AzureConfig,
  BatchPacing,
  JourneyFacts,
  LogEntry,
  SetupPath as PreflightSetupPath,
  TargetScope,
  ThemeChoice,
  WizardCapabilities,
} from '@soc/core';
import { fetchWithTimeout, makeLocalPorts } from './local-adapters';
import { HostLogger } from './logger';

// Map the coarse setup path (persisted on AzureConfig) to the DEFAULT core
// preflight SetupPath the RBAC panel opens on. 'existing' defaults to the
// resource-group WRITE path; the operator can switch inside the panel.
function defaultPreflightPath(
  path: 'existing' | 'lab-new-rg' | 'lab-byo-rg',
): PreflightSetupPath {
  switch (path) {
    case 'existing':
      return 'existing-rg';
    case 'lab-new-rg':
      return 'lab-new-rg-subscription';
    case 'lab-byo-rg':
      return 'lab-byo-rg';
  }
}

// Constructed once: the adapters are stateless over the host API, and a
// stable identity keeps PortsProvider's memoized context value stable. The
// logger (porting-plan Unit 3) batches entries to the host's POST /api/logs;
// the host appends them to data/logs/app.log - the shell's one log truth.
const hostLogger = new HostLogger();
const ports = makeLocalPorts(hostLogger);

// The pacing hooks the batch-onboarding usecase runs its rolling-minute ARM
// budget on (porting-plan Unit 6): the SHELL owns time - @soc/core never
// reads a clock. Loopback traffic has no proxy budget, but ARM itself is
// still rate-limited upstream, so the @soc/core default (80 req/min) stays.
const BATCH_PACING: BatchPacing = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

// The Review screen's generated-at token supplier (porting-plan Unit 7):
// the SHELL owns the clock - @soc/core echoes the token verbatim onto the
// preview so the staleness marker can render a generation time without core
// ever reading Date. Module scope keeps the identity stable across renders.
const REVIEW_GENERATED_AT = () => new Date().toISOString();

// The Logs screen's data source: flush anything the browser logger still
// holds, then read the host log tail back and re-parse the pinned line
// format into entries (unparseable lines stay visible as info entries).
async function getRecentLogs(): Promise<readonly LogEntry[]> {
  hostLogger.flush();
  const res = await fetchWithTimeout('/api/logs?tail=500', undefined, 10000);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GET /api/logs: HTTP ${res.status}${text === '' ? '' : `\n${text}`}`);
  }
  const parsed = JSON.parse(text) as { lines?: unknown };
  const lines = Array.isArray(parsed.lines)
    ? parsed.lines.filter((line): line is string => typeof line === 'string')
    : [];
  return lines.map(logLineToEntry);
}

// Acceptance + mode keys in the host secrets store (plain, not encrypted -
// they must be readable back). Same key names as the cloud shell's KV.
const AUA_ACCEPTANCE_KEY = 'auaAcceptance';
const APP_MODE_KEY = 'appMode';

// The committed Azure target scope OVERRIDE (plain entry, readable back).
// The host config file owns the IDENTITY (tenant/client/secret); the
// targeting screen's Use this target commits only the three scope fields
// here, merged over the file's scope on load - merge, never replace, which
// is this shell's equivalent of the cloud profile-store commit.
const TARGET_SCOPE_KEY = 'azureTargetScope';

// Deployment/naming options (porting-plan Unit 4): ONE plain entry in the
// host secrets store, same key name as the cloud shell's KV entry. Saves go
// through @soc/core applyOptionsPatch so unmanaged keys in the blob survive.
const APP_OPTIONS_KEY = 'appOptions';

// This shell's journey stage bindings (ux-flow-plan 4.4, Unit 6.5): the
// shared bindings plus the LOCAL-specific connect guidance - this shell has
// no in-app identity surface until Unit 22, so the connect stage renders the
// config-file path as guidance text with no route. Cross-links are DATA
// passed to the shared screens; shared prose never names shell-specific UI.
const SHELL_LINK_OVERRIDES: JourneyLinks = {
  connect: {
    hint:
      'The identity (tenant, client, secret) lives in config/local-config.json: edit the ' +
      'file, restart the host, then reload this page. A guided connect step ships in a ' +
      'later unit.',
  },
};
// Full mode: the integrate-arc stages the single-page Integrate flagship
// serves (choose-content / configure / deploy) cross-link to the 'integrate'
// route - Home's Integrate rail opens the one page (legacy-flow-analysis.md).
// 'review' stays bound to the dedicated Review screen (SHARED_JOURNEY_LINKS);
// its Integrate-page section is coming-soon. In cribl-only / air-gapped these
// stages render 'not-yet-available' (non-navigable), so the binding is inert
// where the 'both'-gated route is hidden.
const JOURNEY_LINKS = mergeJourneyLinks({
  ...SHELL_LINK_OVERRIDES,
  'choose-content': {
    routeId: 'integrate',
    hint: 'Start on the Integrate page - the single-page flow from Azure resources through deploy.',
  },
  configure: {
    routeId: 'integrate',
    hint: 'Configure Azure resources and Cribl on the Integrate page; saved defaults live in Options.',
  },
  deploy: {
    routeId: 'integrate',
    hint: 'Deploy the native table on the Integrate page. The Review stage previews what a run would create.',
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
    hint: 'Per-run overrides live on DCR Automation; saved defaults in Options.',
  },
  deploy: {
    routeId: 'dcr-automation',
    hint:
      'Run on DCR Automation - template-only in this mode; ARM bodies download as one ' +
      'artifact. The Review stage previews what a run would create.',
  },
});

// Where the operator grants the Monitoring Metrics Publisher role today
// (shell-provided pointer for the shared Onboard footer - the cloud shell
// passes its Diagnostics pointer instead).
const ROLE_GUIDANCE =
  'grant it out of band: az CLI, the Azure portal, or a change request to the team ' +
  'holding RBAC rights. A guided role-assignment step ships in a later unit.';

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

  // The committed target-scope override (null until hydrated / when none is
  // committed). Tolerant parse: a garbage blob reads as "nothing committed".
  const [scopeOverride, setScopeOverride] = useState<TargetScope | null>(null);

  // The parsed deployment/naming options (porting-plan Unit 4). Hydrated
  // alongside acceptance/mode/scope; refreshed by the Options screen's save
  // callback. A failed read parses to the defaults.
  const [appOptions, setAppOptions] = useState<AppOptions>(DEFAULT_APP_OPTIONS);

  // Theme (porting-plan dark-mode note, lands with Unit 6.5). The CHOICE
  // (light | dark | system) persists as the plain appTheme host-secrets
  // entry (the appMode pattern, same key name as the cloud shell's KV
  // entry); the prefers-color-scheme signal is read live so a 'system'
  // choice re-resolves the moment the OS preference changes.
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
      await ports.secrets.set(APP_THEME_KEY, serializeThemeChoice(choice));
    } catch {
      // Non-fatal: the choice holds for this session and re-reads next launch.
    }
  }, []);
  const themeControl: ThemeControl = {
    theme: themeChoice,
    resolvedTheme,
    onThemeChange: handleThemeChange,
  };

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
      const [accRaw, modeRaw, scopeRaw, optionsRaw, themeRaw] = await Promise.allSettled([
        ports.secrets.get(AUA_ACCEPTANCE_KEY),
        ports.secrets.get(APP_MODE_KEY),
        ports.secrets.get(TARGET_SCOPE_KEY),
        ports.secrets.get(APP_OPTIONS_KEY),
        ports.secrets.get(APP_THEME_KEY),
      ]);
      if (cancelled) {
        return;
      }
      setAcceptance(
        parseAcceptanceRecord(accRaw.status === 'fulfilled' ? accRaw.value : null)
      );
      setMode(parseAppMode(modeRaw.status === 'fulfilled' ? modeRaw.value : null));
      setScopeOverride(
        parseTargetScope(scopeRaw.status === 'fulfilled' ? scopeRaw.value : null)
      );
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

  // The Options screen's storage callbacks (the small shared load/save this
  // shell owns): one plain host-secrets entry, read raw so the screen can
  // merge saves through applyOptionsPatch, with the shell's parsed copy
  // refreshed on every save so onboarding defaults follow immediately.
  const loadAppOptions = useCallback(() => ports.secrets.get(APP_OPTIONS_KEY), []);
  const saveAppOptions = useCallback(async (serialized: string) => {
    await ports.secrets.set(APP_OPTIONS_KEY, serialized);
    setAppOptions(parseAppOptions(serialized));
  }, []);
  // Persist an inline OperationOptions edit (the Integrate page's DCE capability
  // toggle) through the same appOptions entry the Options screen uses.
  const persistOperation = useCallback(
    (operation: OperationOptions) => {
      void saveAppOptions(serializeAppOptions({ ...appOptions, operation }));
    },
    [appOptions, saveAppOptions],
  );

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
            if (!res.ok) {
              hostLogger.warn('connection-status poll failed', {
                status: res.status,
              });
            }
          } catch (err) {
            setHostLink(`failed - ${String(err)}`);
            // Fire-and-forget by design: if the host is down this batch is
            // dropped, and the host's own request log covers the gap.
            hostLogger.warn('connection-status poll failed', {
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
    // Loopback traffic has no proxy budget; the cap just bounds pathology.
    maxPerMinute: 60,
    enabled: phase.phase === 'ready',
  });

  // The ACTIVE AzureConfig: the host file's non-secret fields with the
  // committed scope override merged over the three scope fields (merge,
  // never replace - identity always comes from the file). This is what the
  // shared screens see through PortsContext.
  const activeAzureConfig: AzureConfig | null =
    load.state === 'loaded'
      ? scopeOverride === null
        ? load.config.azure
        : { ...load.config.azure, ...scopeOverride }
      : null;

  // The EXPLICIT scope commit from the Azure Targeting screen: persist the
  // three scope fields as a plain override entry, then surface the
  // invalidation consequences computed by @soc/core (a pure scope change
  // stales cached permission results only; nothing else is cached locally
  // yet, but the notice states it honestly either way).
  const handleCommitScope = async (scope: TargetScope): Promise<CommitScopeOutcome> => {
    if (activeAzureConfig === null) {
      return {
        committed: false,
        notice: 'Host configuration is not loaded - retry loading it first.',
      };
    }
    const next: AzureConfig = { ...activeAzureConfig, ...scope };
    const invalidation = computeInvalidation(activeAzureConfig, next);
    try {
      await ports.secrets.set(TARGET_SCOPE_KEY, serializeTargetScope(scope));
    } catch (err) {
      return { committed: false, notice: `Could not persist the target scope: ${String(err)}` };
    }
    setScopeOverride(scope);
    const notice =
      commitNoticeText(invalidation) || 'Target scope unchanged - it was already committed.';
    return { committed: true, notice };
  };

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
    // First-run onboarding: the assembled Setup Wizard (porting-plan Unit 22)
    // replaces the plain mode chooser. Acceptance is already handled by the
    // AuaGate phase above, so the wizard opens at the Target step and its Get
    // Started persists the chosen mode through the same handleSelectMode the
    // plain chooser used. The composed preflight + repositories panels read IO
    // through PortsContext, so the wizard is mounted inside a PortsProvider
    // (the host config falls back to the empty config while it loads).
    //
    // Capabilities gate the mode cards from what the host config actually
    // configures (identity present -> Azure; a leader URL -> Cribl); the
    // preflight step is where the operator VERIFIES those links.
    const wizardCapabilities: WizardCapabilities = {
      hasAzure:
        activeAzureConfig !== null &&
        activeAzureConfig.tenantId.trim() !== '' &&
        activeAzureConfig.clientId.trim() !== '',
      hasCribl:
        load.state === 'loaded' && load.config.criblLeaderUrl.trim() !== '',
    };
    return (
      <PortsProvider ports={ports} config={activeAzureConfig ?? EMPTY_AZURE_CONFIG}>
        <SetupWizard
          capabilities={wizardCapabilities}
          initialTarget="local"
          criblShellMode="local"
          contentPlatform="local"
          defaultSetupPath={defaultPreflightPath(
            activeAzureConfig?.setupPath ?? 'existing',
          )}
          connectGuidance={
            'This local host reads leader credentials from config/local-config.json: ' +
            'edit the file, restart the host, then reload. The base-URL check above ' +
            'validates the value you would put there. A live in-app reconnect ships later.'
          }
          azureConnectGuidance={
            'The Azure service-principal identity (tenant, client id, client secret) ' +
            'lives in config/local-config.json; edit the file and restart the host to ' +
            'change it, then use the permission check to verify access.'
          }
          onGetStarted={handleSelectMode}
        />
      </PortsProvider>
    );
  }

  // The journey readiness FACTS (ux-flow-plan 4.1, Unit 6.5), composed from
  // signals this shell already owns - nothing new is probed. Identity comes
  // from the host config file's non-secret fields; the SECRET never leaves
  // the host process and nothing this session has proven it works, so its
  // liveness is honestly 'unknown' (never 'live', never silently ok) until a
  // run or a later unit's probe makes it definite. Scope counts as committed
  // when the effective config (file + committed override) addresses a full
  // target. While the host config is still loading (or failed), identity and
  // scope read false - the journey re-derives the moment it loads.
  const journeyFacts: JourneyFacts = {
    accepted: typeof acceptance === 'object' && acceptance !== null,
    mode: phase.mode,
    identityPresent:
      activeAzureConfig !== null &&
      activeAzureConfig.tenantId.trim() !== '' &&
      activeAzureConfig.clientId.trim() !== '',
    secretLive: 'unknown',
    scopeCommitted:
      activeAzureConfig !== null &&
      activeAzureConfig.subscriptionId.trim() !== '' &&
      activeAzureConfig.resourceGroup.trim() !== '' &&
      activeAzureConfig.workspaceName.trim() !== '',
  };

  // The Review screen's disabled-control hint comes from journey-state's
  // deploy stage (Unit 7 amendment: the single missing thing - identity or
  // scope - is journey data, never per-screen prose). The preview needs the
  // same live-ARM prerequisites as a deploy run, so one hint serves both.
  const deployStage = deriveJourney(journeyFacts).integrate.find(
    (stage) => stage.id === 'deploy'
  );
  const reviewJourneyHint =
    deployStage !== undefined && deployStage.status === 'blocked'
      ? (deployStage.blockedReason ?? null)
      : null;

  // The Home route (ux-flow-plan 4.3, Unit 6.5): the state-aware landing
  // surface BOTH shells open on every launch. Facts in, rails and the single
  // next action out - position is derived from persisted state on every
  // render, so resume is automatic. Mounted in a PortsProvider for the
  // embedded RecentRuns (falls back to the empty config while the host
  // config loads; the runs list never reads the config).
  const renderHome = (nav: AppFrameNav) => (
    <>
      <header className="local-header">
        <h1 className="local-title">Home</h1>
        <p className="local-subtitle">
          Where this install is on the journey and the single next action.
          Every stage is visible and navigable; commits stay gated inside
          their screens.
        </p>
      </header>
      <PortsProvider ports={ports} config={activeAzureConfig ?? EMPTY_AZURE_CONFIG}>
        <HomeScreen
          facts={journeyFacts}
          links={phase.mode === 'azure-only' ? AZURE_ONLY_JOURNEY_LINKS : JOURNEY_LINKS}
          onNavigate={nav.navigate}
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
  // (read-ahead); the host-config loading/error branches match the other
  // ports-backed routes. The standalone Onboard / Azure Targeting / Batch /
  // Review routes stay registered - this page composes and supersedes them.
  const renderIntegrate = (nav: AppFrameNav) => (
    <>
      <header className="local-header">
        <h1 className="local-title">Integrate</h1>
        <p className="local-subtitle">
          The single-page integration flow: solution browser, sample data,
          Azure resources, Cribl configuration, and the operable native-table
          deploy on one page, with deploy readiness always visible. The
          gap-analysis and rule-coverage sections arrive in later units.
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
      {load.state === 'loaded' && activeAzureConfig !== null && (
        <PortsProvider ports={ports} config={activeAzureConfig}>
          <IntegrateScreen
            scopeCommitted={journeyFacts.scopeCommitted}
            offline={!hasAzure(phase.mode)}
            onCommitScope={handleCommitScope}
            criblDefaults={appOptions.cribl}
            operationDefaults={appOptions.operation}
            onOpenOptions={() => nav.navigate('options')}
            onOperationChange={persistOperation}
            roleGuidance={ROLE_GUIDANCE}
            mode={phase.mode}
          />
        </PortsProvider>
      )}
    </>
  );

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
      {load.state === 'loaded' && activeAzureConfig !== null && (
        <PortsProvider ports={ports} config={activeAzureConfig}>
          <OnboardTableScreen
            criblDefaults={appOptions.cribl}
            operationDefaults={appOptions.operation}
            roleGuidance={ROLE_GUIDANCE}
          />
        </PortsProvider>
      )}
    </>
  );

  // The DCR Automation route (porting-plan Unit 6): many tables as ONE parent
  // onboard-batch job against the same local adapters - shared prologue
  // (workspace fetch; in DCE mode one batch-wide DCE plus the AMPLS
  // association when public access is disabled) plus one step per table.
  // The shell injects the pacing hooks and the persisted Unit 4 options.
  const renderBatch = (nav: AppFrameNav) => (
    <>
      <header className="local-header">
        <h1 className="local-title">Batch onboarding</h1>
        <p className="local-subtitle">
          Deploy DCRs for many tables in one run: per-table isolation and
          skip-existing semantics, Direct or DCE mode with Private Link
          support, resumable progress, and template-only export - the same
          onboardBatch use-case as the Cribl.Cloud app, served by the loopback
          Node host.
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
      {load.state === 'loaded' && activeAzureConfig !== null && (
        <PortsProvider ports={ports} config={activeAzureConfig}>
          <BatchDeployScreen
            pacing={BATCH_PACING}
            operationDefaults={appOptions.operation}
            criblDefaults={appOptions.cribl}
            onOpenOptions={() => nav.navigate('options')}
            forcedTemplateOnly={!hasCribl(phase.mode)}
          />
        </PortsProvider>
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
      single={onboardView}
      batch={renderBatch(nav)}
      inventory={
        <PortsProvider ports={ports} config={activeAzureConfig ?? EMPTY_AZURE_CONFIG}>
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

  // The Review route (porting-plan Unit 7, ux-flow-plan 5.2): the Integrate
  // arc's REVIEW stage - live-ARM deployment preview through the host's ARM
  // proxy, with the staleness marker and the acknowledge gate arming the
  // handoff to DCR Automation. Controls stay visible and disable with the
  // journey-state hint (identity/scope - the same prerequisites a deploy
  // run needs); the host-config loading/error branches match the other
  // ports-backed routes.
  const renderReview = (nav: AppFrameNav) => (
    <>
      <header className="local-header">
        <h1 className="local-title">Review deployment</h1>
        <p className="local-subtitle">
          Preview exactly what a deploy run would create - predicted DCR/DCE
          names (the same names deployment uses), Exists vs Will create from
          live Azure, and the ARM request bodies - then acknowledge the
          preview to arm the Deploy handoff. Read-only: checking never
          deploys anything.
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
      {load.state === 'loaded' && activeAzureConfig !== null && (
        <PortsProvider ports={ports} config={activeAzureConfig}>
          <ReviewScreen
            generatedAtToken={REVIEW_GENERATED_AT}
            operationDefaults={appOptions.operation}
            journeyBlockedReason={reviewJourneyHint}
            onOpenOptions={() => nav.navigate('options')}
            onProceedToDeploy={() => nav.navigate('dcr-automation')}
            deploySurfaceLabel="DCR Automation"
          />
        </PortsProvider>
      )}
    </>
  );

  // The Options route (porting-plan Unit 4): deployment and naming defaults
  // as typed forms over one plain host-secrets entry. requires: 'none' -
  // options are app configuration, editable in every mode. No PortsProvider
  // needed: the screen's only IO is the two storage callbacks above.
  const optionsView = (
    <>
      <header className="local-header">
        <h1 className="local-title">Options</h1>
        <p className="local-subtitle">
          Deployment and naming defaults for onboarding and deployment jobs:
          Direct vs DCE mode, timeouts, template handling, custom-table
          retention, Private Link, and Cribl destination naming.
        </p>
      </header>
      <OptionsScreen loadOptions={loadAppOptions} saveOptions={saveAppOptions} />
    </>
  );

  // The Azure Targeting route (Unit 2): browse subscriptions, workspaces,
  // and resource groups through the host's ARM proxy, create what is
  // missing, and commit the scope explicitly. The host config file keeps the
  // identity; the committed scope persists as a plain override entry.
  const targetingView = (
    <>
      <header className="local-header">
        <h1 className="local-title">Azure targeting</h1>
        <p className="local-subtitle">
          Browse the subscription, workspace, and resource-group cascade,
          create what is missing, enable Sentinel, then commit the scope with
          Use this target. The identity (tenant, client, secret) stays in
          config/local-config.json; only the committed scope is stored here.
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
      {load.state === 'loaded' && activeAzureConfig !== null && (
        <PortsProvider ports={ports} config={activeAzureConfig}>
          <AzureTargetingScreen
            offline={!hasAzure(phase.mode)}
            onCommitScope={handleCommitScope}
          />
        </PortsProvider>
      )}
    </>
  );

  // The Logs route (porting-plan Unit 3): the shared diagnostics viewer over
  // the host's log file tail (browser batches + the host's own server-side
  // events in one greppable stream), plus the support-bundle download.
  // requires: 'none' - diagnostics must be reachable in every mode, so the
  // ports context falls back to an empty config while the host config is
  // still loading or failed (the screen never reads the config).
  const logsView = (
    <>
      <header className="local-header">
        <h1 className="local-title">Logs</h1>
        <p className="local-subtitle">
          The host&apos;s log file (data/logs/app.log): entries from this
          browser session batched to the host, alongside the host&apos;s own
          API request, token refresh, and upstream failure events. Secrets
          and tokens are excluded by construction.
        </p>
      </header>
      <PortsProvider ports={ports} config={activeAzureConfig ?? EMPTY_AZURE_CONFIG}>
        <LogsScreen
          getRecentLogs={getRecentLogs}
          platformInfo={{
            shell: 'local-node-host',
            mode: phase.mode,
            hostLink,
            criblLeader: load.state === 'loaded' ? load.config.criblLeaderUrl : null,
          }}
        />
      </PortsProvider>
    </>
  );

  // Settings platform info: the local header's explanation plus the old
  // config-summary rows, graduated into the shared SettingsScreen. Secrets
  // never appear - the host only ever serves non-secret fields.
  const configRows: PlatformInfoRow[] =
    load.state === 'loaded' && activeAzureConfig !== null
      ? [
          { label: 'Cribl leader', value: display(load.config.criblLeaderUrl) },
          { label: 'Tenant ID', value: display(activeAzureConfig.tenantId) },
          { label: 'Client ID', value: display(activeAzureConfig.clientId) },
          {
            label: 'Subscription',
            value: display(activeAzureConfig.subscriptionId),
            ...(scopeOverride !== null
              ? {
                  tip:
                    'Committed from the Azure Targeting screen; it overrides the\n' +
                    'scope fields in config/local-config.json (identity fields\n' +
                    'always come from the file).',
                }
              : {}),
          },
          { label: 'Resource group', value: display(activeAzureConfig.resourceGroup) },
          { label: 'Workspace', value: display(activeAzureConfig.workspaceName) },
        ]
      : [
          {
            label: 'Connection',
            value:
              load.state === 'error'
                ? `unavailable - ${load.message}`
                : 'loading host configuration...',
          },
        ];

  // Repositories (porting-plan Unit 14): the GitHub PAT settings page over the
  // local shell's content ports. The host owns the token (data/github.json,
  // server-side); this page only ever sees hasPat + login. A PAT is recommended
  // (not required) on local - the process has its own egress IP.
  // Event Hub Discovery (roadmap Phase 4, EVH-03 + LOG-16): Resource Graph
  // namespace inventory + per-namespace hub listing via the host ARM proxy,
  // and local generation of Cribl Event Hub source configs. requires: 'azure'.
  const eventHubDiscoveryView = (
    <>
      <header className="local-header">
        <h1 className="local-title">Event Hub Discovery</h1>
        <p className="local-subtitle">
          Inventory the subscription's Event Hubs and generate Cribl Stream
          source configurations for the hubs worth onboarding.
        </p>
      </header>
      <PortsProvider ports={ports} config={activeAzureConfig ?? EMPTY_AZURE_CONFIG}>
        <EventHubDiscoveryScreen />
      </PortsProvider>
    </>
  );

  // Vendor Mapping Catalog: the documented source-field -> Sentinel-column
  // suggestions the analysis applies. Pure bundled data; no ports, no IO.
  const mappingCatalogView = (
    <>
      <header className="local-header">
        <h1 className="local-title">Vendor Mapping Catalog</h1>
        <p className="local-subtitle">
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
      <header className="local-header">
        <h1 className="local-title">Architecture Patterns</h1>
        <p className="local-subtitle">
          Reference architectures for your Cribl + Azure footprint. Select what
          is in use; get the matching patterns, diagrams, and considerations.
        </p>
      </header>
      <ArchitectureScreen />
    </>
  );

  const repositoriesView = (
    <>
      <header className="local-header">
        <h1 className="local-title">Repositories</h1>
        <p className="local-subtitle">
          Connect to GitHub for Microsoft Sentinel content. The token is
          validated then stored by the host process (never returned to this
          page). Content is fetched lazily per selected solution and cached by
          commit; nothing is mirrored.
        </p>
      </header>
      <PortsProvider ports={ports} config={activeAzureConfig ?? EMPTY_AZURE_CONFIG}>
        <RepositoriesScreen platform="local" />
      </PortsProvider>
    </>
  );

  // Packs (porting-plan Unit 19, GUI-19/20 folded): the ONE merged pack
  // inventory over the local shell's pack ports - build records (data/packs.json
  // on the host), DEPLOYED badges per worker group (truth from the leader's live
  // packs API), storage/retention, download the .crbl via the ArtifactSink
  // (regenerated from the stored definition), install-to-group through the
  // host's octet-stream upload proxy, and delete guarded by scoped record-id
  // validation. requires: 'cribl' - the inventory and its badges need a leader.
  const packsView = (
    <>
      <header className="local-header">
        <h1 className="local-title">Pack Maintenance</h1>
        <p className="local-subtitle">
          Every pack built by this app, with its destination tables, size, and
          live deployed status per worker group. Download the .crbl (regenerated
          on demand from the stored definition), install it into a group, or
          delete an older build. Deployed status is read from the Cribl leader,
          never from this list.
        </p>
      </header>
      <PortsProvider ports={ports} config={activeAzureConfig ?? EMPTY_AZURE_CONFIG}>
        <PackInventoryScreen />
      </PortsProvider>
    </>
  );

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
      themeControl={themeControl}
    />
  );

  // Preflight route (porting-plan Unit 9, ENG-38 delta / GUI-11): the Setup
  // Wizard's PERMISSION-CHECK step. The panel runs the @soc/core side-runners
  // over the local shell's ports. On the LOCAL shell the Cribl probes are
  // genuinely informative against the configured leader (mode 'local'), so
  // criblShellMode is 'local'. Switch account is a reconnect: the loopback host
  // holds the credentials, so it routes to Settings which explains editing
  // config/local-config.json and restarting. requires 'azure'; INFORMATIONAL,
  // it never gates the deploy partition.
  const renderPreflight = (nav: AppFrameNav) => (
    <>
      <header className="harness-header">
        <h1 className="harness-title">Permission preflight</h1>
        <p className="harness-subtitle">
          What the configured identity can and cannot do, on both Azure and
          Cribl, before a deploy is attempted. Effective-action checks and live
          probes are the truth; role names are decoration. This is
          informational - it reports access, it does not gate the deploy.
        </p>
      </header>
      <PortsProvider ports={ports} config={activeAzureConfig ?? EMPTY_AZURE_CONFIG}>
        <RbacPreflightPanel
          criblShellMode="local"
          defaultSetupPath={defaultPreflightPath(
            activeAzureConfig?.setupPath ?? 'existing',
          )}
          onSwitchAccount={() => nav.navigate('settings')}
        />
      </PortsProvider>
    </>
  );

  // Route table, SECTIONED per ux-flow-plan 4.4: journey steps in dependency
  // order - Home, then Integrate (the single-page flagship, the PRIMARY
  // journey route), then the standalone Azure Targeting, Onboard, Batch
  // Onboard, and Review screens the Integrate page composes and supersedes
  // but which stay reachable during the transition - then tools. This shell
  // has no diagnostics section (the Spike Harness is cloud-only). Integrate
  // and Onboard need BOTH live sides; batch-onboard relaxes to
  // 'azure' (recorded Unit 6.5 decision) - in azure-only mode templateOnly
  // is FORCED on because no live Cribl connection exists to deploy
  // destinations to. Review (Unit 7) requires 'azure' (its truth is live
  // ARM) and sits after the screens serving Choose/Configure, mirroring the
  // integrate arc's stage order.
  // SECTION SPLIT (user directive 2026-07-09, mirrors the cloud shell): only
  // Setup (home) and Sentinel Integration are ACTIVE; unvalidated features
  // park in DEVELOPMENT and move out one at a time as they pass live
  // testing. Options, Repositories, Logs, and Settings stay under Tools
  // because the two active screens depend on them.
  const routes: AppRoute[] = [
    { id: 'home', label: 'Setup', requires: 'none', section: 'journey', render: renderHome },
    { id: 'integrate', label: 'Sentinel Integration', requires: 'both', section: 'journey', render: renderIntegrate },
    { id: 'options', label: 'Options', requires: 'none', section: 'tools', render: () => optionsView },
    { id: 'repositories', label: 'Repositories', requires: 'none', section: 'tools', render: () => repositoriesView },
    { id: 'logs', label: 'Logs', requires: 'none', section: 'tools', render: () => logsView },
    { id: 'settings', label: 'Settings', requires: 'none', section: 'tools', render: () => settingsView },
    { id: 'azure-target', label: 'Azure Targeting', requires: 'azure', section: 'development', render: () => targetingView },
    { id: 'preflight', label: 'Preflight', requires: 'azure', section: 'development', render: renderPreflight },
    { id: 'dcr-automation', label: 'DCR Automation', requires: 'azure', section: 'development', render: renderDcrAutomation },
    { id: 'eventhub-discovery', label: 'Event Hub Discovery', requires: 'azure', section: 'development', render: () => eventHubDiscoveryView },
    { id: 'review', label: 'Review', requires: 'azure', section: 'development', render: renderReview },
    { id: 'packs', label: 'Pack Maintenance', requires: 'cribl', section: 'development', render: () => packsView },
    { id: 'architecture', label: 'Architecture Patterns', requires: 'none', section: 'development', render: () => architectureView },
    { id: 'mapping-catalog', label: 'Mapping Catalog', requires: 'none', section: 'development', render: () => mappingCatalogView },
  ];

  // Frame topBar (GUI-28's Azure half): the committed target scope as a
  // compact chip, always visible above the active screen.
  const topBar = (
    <div className="scope-bar">
      <span
        className="scope-chip"
        title="The committed Azure target scope (subscription / resource group / workspace). Change it from the Azure Targeting screen - browsing there never changes it until you click Use this target."
      >
        target:{' '}
        {formatScopeChip(
          activeAzureConfig !== null
            ? {
                subscriptionId: activeAzureConfig.subscriptionId,
                resourceGroup: activeAzureConfig.resourceGroup,
                workspaceName: activeAzureConfig.workspaceName,
              }
            : { subscriptionId: '', resourceGroup: '', workspaceName: '' }
        )}
      </span>
    </div>
  );

  return (
    <AppFrame
      title="SOC Optimization Toolkit"
      subtitle="Local shell"
      mode={phase.mode}
      routes={routes}
      topBar={topBar}
      initialRouteId="home"
      footerNote="local host"
      themeControl={themeControl}
    />
  );
}
