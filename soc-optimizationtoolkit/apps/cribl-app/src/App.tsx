import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  APP_THEME_KEY,
  AppFrame,
  AuaGate,
  AzureTargetingScreen,
  BatchDeployScreen,
  EMPTY_MODE_RECORD,
  HomeScreen,
  IntegrateScreen,
  LogsScreen,
  ModeSelect,
  OnboardTableScreen,
  OptionsScreen,
  PortsProvider,
  ReviewScreen,
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
  CommitScopeOutcome,
  JourneyLinks,
  LoadableAcceptance,
  LoadableMode,
  ThemeControl,
} from '@soc/ui';
import {
  allGranted,
  appRegistrationRequest,
  commitTargetScope,
  computeInvalidation,
  DEFAULT_APP_OPTIONS,
  DEFAULT_THEME_CHOICE,
  deriveJourney,
  deriveResourceGroup,
  hasAzure,
  hasCribl,
  EMPTY_AZURE_CONFIG,
  EMPTY_PROFILE_STORE,
  evaluatePermissions,
  getActiveConfig,
  getActiveProfile,
  parseAcceptanceRecord,
  parseAppMode,
  parseAppOptions,
  parseAzureConfig,
  parseProfileStore,
  parseThemeChoice,
  resolveTheme,
  serializeThemeChoice,
  removeProfile,
  renameProfile,
  renderRoleAssignmentCli,
  REQUIRED_ACTIONS,
  resourceCreationRequest,
  roleAssignmentRequest,
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
  AzureConfig,
  BatchPacing,
  ChangeRequestContext,
  ConnectionProfile,
  JourneyFacts,
  PermissionsResponse,
  ProfileStore,
  RequiredAction,
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

// Phase 1 harness: seven sequential diagnostics panels that exercise the Cribl
// App Platform surface (globals, KV store, proxy header injection, Azure AD
// token flow, ARM calls, iframe download behavior), now driven by named
// connection profiles. A connection bar at the top selects the ACTIVE profile;
// all config-bearing panels read and write the active profile's config.
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

// The Review screen's generated-at token supplier (porting-plan Unit 7):
// the SHELL owns the clock - @soc/core echoes the token verbatim onto the
// preview so the staleness marker can render a generation time without core
// ever reading Date. Module scope keeps the identity stable across renders.
const REVIEW_GENERATED_AT = () => new Date().toISOString();

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
// entry lives in Diagnostics panel 3 (App registration and connect) until
// Unit 9 promotes it to a product Connect step. Cross-links are DATA passed
// to the shared screens; shared prose never names shell-specific UI.
const SHELL_LINK_OVERRIDES: JourneyLinks = {
  connect: {
    routeId: 'harness',
    hint:
      'Identity entry lives in panel 3 (App registration and connect) of the Diagnostics ' +
      'view until the product Connect step ships: Save and connect stores the secret and ' +
      'verifies it by acquiring an ARM token.',
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
// the integrate stages bind to Batch Onboard - the surface the relaxed
// 'azure' requirement actually exposes in this mode (templateOnly forced on;
// the honest copy lives on the screen).
const AZURE_ONLY_JOURNEY_LINKS = mergeJourneyLinks({
  ...SHELL_LINK_OVERRIDES,
  'choose-content': {
    routeId: 'batch-onboard',
    hint: 'Batch Onboard is this mode\'s onboarding surface; runs are template-only (no live Cribl connection).',
  },
  configure: {
    routeId: 'batch-onboard',
    hint: 'Per-run overrides live on Batch Onboard; saved defaults in Options.',
  },
  deploy: {
    routeId: 'batch-onboard',
    hint:
      'Run on Batch Onboard - template-only in this mode; ARM bodies download as one ' +
      'artifact. The Review stage previews what a run would create.',
  },
});

// Where the operator grants the Monitoring Metrics Publisher role today
// (shell-provided pointer for the shared Onboard footer - the local shell
// passes its own).
const ROLE_GUIDANCE =
  'grant it following the role guidance in panel 4 (Select resources and grant permissions) ' +
  'of the Diagnostics view.';

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

// The coarse setup path shared by panel 3 (connect) and panel 4 (resource
// selection and role assignment). The az CLI role-assignment script for the
// chosen path is rendered in panel 4 by renderRoleAssignmentCli from @soc/core -
// the single source of truth for the setup-path RBAC role model - from the
// SELECTED (or bootstrap-typed) subscription and the derived/selected resource
// group. Blank fields stay as <placeholders> so a partial copy is still visibly
// incomplete.
type SetupPath = 'existing' | 'lab-new-rg' | 'lab-byo-rg';

// Reusable "generate a change request" block for operators who must ASK another
// team to perform a setup step (create the app registration, assign roles, or
// create resources) rather than doing it themselves. The ticket body and the
// Mermaid architecture diagram embedded in it come entirely from @soc/core via
// the `generate` closure; this component only handles rendering, clipboard
// copy, and download. The generated text is shown in a monospace <pre>; the
// embedded diagram is a fenced mermaid block whose source is plain text, so it
// pastes safely anywhere and renders wherever Markdown+Mermaid is supported.
interface ChangeRequestBlockProps {
  title: string;
  description: string;
  // Downloaded filename.
  filename: string;
  generate: () => string;
}

function ChangeRequestBlock({ title, description, filename, generate }: ChangeRequestBlockProps) {
  const [text, setText] = useState('');
  const [feedback, setFeedback] = useState('');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setFeedback('Copied to clipboard.');
    } catch (err) {
      setFeedback(`Copy failed: ${String(err)}`);
    }
  };

  // Download the ticket as plain text so it can be attached or pasted into a
  // ticketing system without the terminal multi-line paste prompt.
  const download = () => {
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setFeedback(`Download dispatched (${filename}).`);
  };

  return (
    <div className="change-request">
      <span className="field-label">{title}</span>
      <p className="panel-desc">{description}</p>
      <div className="panel-controls">
        <button
          className="run-button"
          onClick={() => {
            setText(generate());
            setFeedback('');
          }}
        >
          Generate change request
        </button>
        {text !== '' && (
          <>
            <button className="run-button" onClick={() => void copy()}>
              Copy
            </button>
            <button className="run-button" onClick={download}>
              Download {filename}
            </button>
          </>
        )}
      </div>
      {text !== '' && <pre className="result">{text}</pre>}
      {feedback !== '' && <p className="panel-desc">{feedback}</p>}
    </div>
  );
}

// Panel 3: create the Entra app registration, then CONNECT this app to it. The
// identity inputs (tenant ID, client ID, client secret) plus a single primary
// action, Save and connect, write the encrypted write-only azureBasic entry
// (base64 of clientId:clientSecret), acquire an ARM token, and store it under
// azureArmToken so proxies.yml can inject Bearer server-side. Resource selection
// and role assignment moved to panel 4; this panel no longer takes a
// subscription/resource group or renders the az script.
interface AppRegistrationConnectPanelProps {
  activeProfileId: string | null;
  secretLive: boolean;
  onSecretSaved: (profileId: string, tenantId: string, clientId: string) => void;
  onConnected: () => void;
  clientId: string;
  onClientIdChange: (value: string) => void;
  tenantId: string;
  onTenantIdChange: (value: string) => void;
  setupPath: SetupPath;
  onSetupPathChange: (value: SetupPath) => void;
  // The active connection's change-request context (app name + non-secret
  // config), used to generate the app-registration ticket for the IAM team.
  ctx: ChangeRequestContext;
}

function AppRegistrationConnectPanel({
  activeProfileId,
  secretLive,
  onSecretSaved,
  onConnected,
  clientId,
  onClientIdChange,
  tenantId,
  onTenantIdChange,
  setupPath,
  onSetupPathChange,
  ctx,
}: AppRegistrationConnectPanelProps) {
  const [clientSecret, setClientSecret] = useState('');
  const [status, output, run] = useRunner();

  // Save and connect: write the encrypted, write-only azureBasic entry, then
  // acquire an ARM token and store it encrypted under azureArmToken. The app
  // sets no Authorization header - the proxy injects both server-side. Once
  // azureBasic is written the secret is marked live for this connection (badge +
  // identity tracking) even if the token step fails; a full success additionally
  // tells the parent a connect happened so panel 4 can auto-run discovery.
  const saveAndConnect = () =>
    run(async () => {
      if (clientId.trim() === '' || clientSecret === '') {
        throw new Error('Client ID and client secret are both required to connect.');
      }
      if (tenantId.trim() === '') {
        throw new Error('Tenant ID is required to acquire an ARM token - enter it above, then Save and connect.');
      }
      const basicRes = await fetch(kvUrl('azureBasic?encrypted=true'), {
        method: 'PUT',
        body: btoa(`${clientId}:${clientSecret}`),
      });
      const basicText = await basicRes.text();
      if (!basicRes.ok) {
        throw new Error(`PUT azureBasic?encrypted=true: HTTP ${basicRes.status}\nbody: ${basicText}`);
      }
      // The encrypted slot is populated now, so mark the secret live and clear
      // the input regardless of whether the token step below succeeds.
      setClientSecret('');
      if (activeProfileId !== null) {
        onSecretSaved(activeProfileId, tenantId, clientId);
      }
      const token = await acquireArmToken(tenantId);
      const putRes = await fetch(kvUrl('azureArmToken?encrypted=true'), {
        method: 'PUT',
        body: token.access_token,
      });
      if (!putRes.ok) {
        throw new Error(
          'Client secret saved, but the ARM token could not be stored.\n' +
            `PUT azureArmToken?encrypted=true: HTTP ${putRes.status}\n${await putRes.text()}`
        );
      }
      onConnected();
      return [
        'Connected.',
        '  client secret: saved (encrypted, write-only) for this connection',
        `  ARM token: acquired and stored encrypted (expires_in ${token.expires_in ?? '(missing)'})`,
        '',
        'Next: panel 4 discovers subscriptions, selects your resources, and grants roles.',
      ].join('\n');
    });

  return (
    <Panel
      index={3}
      title="App registration and connect"
      status={status}
      output={output}
      actionLabel="Save and connect"
      onAction={() => void saveAndConnect()}
    >
      <p className="panel-desc">
        Create the Entra app registration, then connect this app to it with the tenant ID, client ID,
        and a client secret. Azure roles are granted in panel 4, after you discover your subscription.
      </p>
      <ChangeRequestBlock
        title="Cannot create the app registration yourself? Generate a change request"
        description={
          'Produce a paste-ready ticket for the team that manages Entra ID. It asks them to create a ' +
          'single-tenant daemon confidential client (no redirect URI), create a client secret, and ' +
          'securely share the tenant id, client id, and secret. The current tenant/client ids are ' +
          'included; blank fields appear as clear placeholders.'
        }
        filename="app-registration-request.txt"
        generate={() => appRegistrationRequest(ctx)}
      />
      <ol className="setup-steps">
        <li>
          In Entra ID, open App registrations and select New registration. Single tenant;
          no redirect URI is needed (this is a daemon-style confidential client).
        </li>
        <li>
          Record the Directory (tenant) ID and Application (client) ID from the Overview page.
        </li>
        <li>
          Under Certificates and secrets, create a New client secret and copy its value
          immediately - it is shown only once.
        </li>
        <li>
          Enter the tenant ID, client ID, and client secret below, choose your setup path,
          then Save and connect.
        </li>
      </ol>
      <div className="path-options">
        <label className="path-option">
          <input
            type="radio"
            name="setup-path"
            checked={setupPath === 'existing'}
            onChange={() => onSetupPathChange('existing')}
          />
          <span>I have an existing Log Analytics workspace to target</span>
        </label>
        <label className="path-option">
          <input
            type="radio"
            name="setup-path"
            checked={setupPath === 'lab-new-rg'}
            onChange={() => onSetupPathChange('lab-new-rg')}
          />
          <span>No workspace yet - a lab will create its own resource group and workspace</span>
        </label>
        <label className="path-option">
          <input
            type="radio"
            name="setup-path"
            checked={setupPath === 'lab-byo-rg'}
            onChange={() => onSetupPathChange('lab-byo-rg')}
          />
          <span>No workspace yet - deploy a lab into a pre-created resource group</span>
        </label>
      </div>
      {setupPath === 'existing' && (
        <p className="panel-desc">
          Least privilege for an existing environment: Monitoring Contributor and Log Analytics
          Contributor scoped to the workspace resource group, plus Reader on the subscription.
          Nothing is granted subscription-wide beyond read.
        </p>
      )}
      {setupPath === 'lab-new-rg' && (
        <p className="panel-desc">
          Requires <strong>Contributor at the subscription scope</strong> (resource group creation is
          a subscription-level action, and it covers all workspace and DCR operations inside the lab,
          so no workspace resource group is needed) and{' '}
          <strong>RBAC Administrator at the subscription scope</strong> for the lab TTL self-destruct.
          Assign RBAC Administrator in the portal with the condition &quot;Constrain roles and
          principal types&quot;: only Contributor and Monitoring Metrics Publisher, only to service
          principals.
        </p>
      )}
      {setupPath === 'lab-byo-rg' && (
        <p className="panel-desc">
          Least privilege for labs: an admin pre-creates an empty lab resource group and grants
          Contributor on it - the lab deploys its workspace there with no subscription-scope rights.
          The admin also pre-assigns the TTL self-destruct identity its delete rights on that group.
        </p>
      )}
      <div className="form-grid">
        <label className="field">
          <span className="field-label">Directory (tenant) ID</span>
          <input
            type="text"
            value={tenantId}
            onChange={(e) => onTenantIdChange(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span className="field-label">Application (client) ID</span>
          <input
            type="text"
            value={clientId}
            onChange={(e) => onClientIdChange(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span className="field-label">Client secret</span>
          <input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            autoComplete="new-password"
            placeholder={secretLive ? 'stored for this connection - enter a new value to replace' : ''}
          />
        </label>
      </div>
      <p className="panel-desc">
        Save and connect combines the client secret with the client ID as base64(clientId:clientSecret)
        and writes it to the encrypted, write-only KV entry azureBasic, then acquires an Azure AD ARM
        token (grant_type=client_credentials, ARM scope) and stores it encrypted under azureArmToken.
        The app never sets an Authorization header - the platform proxy injects the secret and token
        server-side per proxies.yml, and the secret can never be read back. azureBasic is a single
        shared slot, so only one connection&apos;s secret is live at a time: switching connections clears
        it and you re-enter and reconnect here. If a secret is already stored the field stays blank -
        enter a new value only to replace it. The client ID, tenant ID, and setup path are non-secret
        configuration remembered per connection in the plain azureProfiles KV entry. The connection
        badge above shows whether this connection&apos;s secret is live this session.
      </p>
    </Panel>
  );
}

// Permission preflight: the RBAC permissions API returns the caller's EFFECTIVE
// allowed actions at a scope, which is the only sound signal (customers use
// custom/lookalike roles, so role names cannot be trusted). @soc/core evaluates
// the response against the actions each setup path actually performs.
const PERMISSIONS_API_VERSION = '2022-04-01';

function subscriptionScopeUrl(sub: string): string {
  return (
    `https://management.azure.com/subscriptions/${encodeURIComponent(sub)}` +
    `/providers/Microsoft.Authorization/permissions?api-version=${PERMISSIONS_API_VERSION}`
  );
}

function resourceGroupScopeUrl(sub: string, rg: string): string {
  return (
    `https://management.azure.com/subscriptions/${encodeURIComponent(sub)}` +
    `/resourceGroups/${encodeURIComponent(rg)}` +
    `/providers/Microsoft.Authorization/permissions?api-version=${PERMISSIONS_API_VERSION}`
  );
}

// GET one scope's RBAC permissions (no Authorization header - the proxy injects
// Bearer ${kv.azureArmToken}) and evaluate the required actions with the pure
// @soc/core evaluator. Returns one summary line plus one line per required
// action. 401 and 403 get actionable messages rather than raw bodies.
async function checkScope(
  scopeLabel: string,
  url: string,
  required: RequiredAction[]
): Promise<string[]> {
  const res = await fetch(url);
  if (res.status === 401) {
    return [
      `${scopeLabel}: HTTP 401 - the ARM token was rejected (expired, or the proxy did not inject it).`,
      '  Re-check here (or re-run panel 5) to acquire a fresh token, then retry.',
    ];
  }
  if (res.status === 403) {
    return [
      `${scopeLabel}: HTTP 403 - the service principal cannot even read permissions at this scope.`,
      '  Grant it at least Reader on this scope so the preflight can evaluate effective actions.',
    ];
  }
  const text = await res.text();
  if (!res.ok) {
    return [`${scopeLabel}: HTTP ${res.status}\n${text}`];
  }
  let parsed: PermissionsResponse;
  try {
    const body = JSON.parse(text) as Partial<PermissionsResponse>;
    parsed = { value: Array.isArray(body.value) ? body.value : [] };
  } catch {
    return [`${scopeLabel}: could not parse permissions response\n${text}`];
  }
  const results = evaluatePermissions(parsed, required);
  const lines = [
    `${scopeLabel}: ${allGranted(results) ? 'all required actions granted' : 'MISSING required actions'}`,
  ];
  for (const result of results) {
    lines.push(`  [${result.granted ? 'ok' : 'missing'}] ${result.label} (${result.action})`);
  }
  return lines;
}

// Run the scope check(s) the selected panel-3 setup path requires, mapping the
// panel-3 SetupPath to the @soc/core required-action set keys. A blank scope
// input reports that the scope is needed for validation rather than failing.
async function validatePermissionsForPath(path: SetupPath, sub: string, rg: string): Promise<string[]> {
  if (path === 'existing') {
    const lines: string[] = [];
    if (sub === '') {
      lines.push(
        'Subscription scope: select a subscription above to validate subscription-level reads (existing-subscription).'
      );
    } else {
      lines.push(
        ...(await checkScope(
          'Subscription scope (existing-subscription)',
          subscriptionScopeUrl(sub),
          REQUIRED_ACTIONS['existing-subscription']
        ))
      );
    }
    if (sub === '' || rg === '') {
      lines.push(
        'Resource group scope: select a subscription and workspace above to validate RG-level writes (existing-rg).'
      );
    } else {
      lines.push(
        ...(await checkScope(
          'Resource group scope (existing-rg)',
          resourceGroupScopeUrl(sub, rg),
          REQUIRED_ACTIONS['existing-rg']
        ))
      );
    }
    return lines;
  }
  if (path === 'lab-new-rg') {
    if (sub === '') {
      return [
        'Subscription scope: select a subscription above to validate subscription-level lab creation (lab-new-rg-subscription).',
      ];
    }
    return checkScope(
      'Subscription scope (lab-new-rg-subscription)',
      subscriptionScopeUrl(sub),
      REQUIRED_ACTIONS['lab-new-rg-subscription']
    );
  }
  // lab-byo-rg: the pre-created lab resource group scope only.
  if (sub === '' || rg === '') {
    return [
      'Resource group scope: select a subscription and lab resource group above to validate RG-level lab deployment (lab-byo-rg).',
    ];
  }
  return checkScope(
    'Resource group scope (lab-byo-rg)',
    resourceGroupScopeUrl(sub, rg),
    REQUIRED_ACTIONS['lab-byo-rg']
  );
}

// Discovery option shapes populated from ARM list responses. Kept minimal - only
// the fields the dropdowns render or use to derive shared config.
interface SubscriptionOption {
  subscriptionId: string;
  displayName: string;
}
interface WorkspaceOption {
  name: string;
  id: string;
}
interface ResourceGroupOption {
  name: string;
}

// GET an ARM list endpoint with no Authorization header (proxies.yml injects
// Bearer ${kv.azureArmToken}). Returns the raw body on success, or an actionable
// message for 401/403/other non-ok so each caller renders one clear line.
type ArmGetResult = { ok: true; text: string } | { ok: false; message: string };

async function armGetJson(url: string, label: string): Promise<ArmGetResult> {
  const res = await fetch(url);
  if (res.status === 401) {
    return {
      ok: false,
      message:
        `${label}: HTTP 401 - the ARM token was rejected (expired, or the proxy did not inject it). ` +
        'Click Discover / refresh from Azure again to acquire a fresh token, then retry.',
    };
  }
  if (res.status === 403) {
    return {
      ok: false,
      message:
        `${label}: HTTP 403 - the service principal is not authorized at this scope. ` +
        'Grant it at least Reader (run the role assignment script in panel 4), wait for propagation, then retry.',
    };
  }
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, message: `${label}: HTTP ${res.status}\n${text}` };
  }
  return { ok: true, text };
}

// Panel 4: discover the subscriptions this app registration can see, SELECT the
// subscription (and, per setup path, the workspace or resource group), then
// generate the az role-assignment script and validate the caller's EFFECTIVE
// permissions. Discovery needs an ARM token, which the connect action in panel 3
// acquires; this panel re-acquires one on demand too. It writes the shared
// subscription/resource-group state and auto-runs discovery once after a
// successful connect (connectNonce). When discovery returns ZERO subscriptions a
// fresh service principal cannot list any, so a one-time bootstrap subscription
// text input appears - the only place a subscription is typed - to scope the
// role script until Reader is granted. The panel is keyed by the active profile
// id in App, so switching connections remounts it and clears all cached
// discovery and permission-validation state.
interface ResourceSelectionPanelProps {
  clientId: string;
  tenantId: string;
  setupPath: SetupPath;
  subscriptionId: string;
  onSubscriptionIdChange: (value: string) => void;
  rgName: string;
  onRgNameChange: (value: string) => void;
  workspaceName: string;
  onWorkspaceNameChange: (value: string) => void;
  connectNonce: number;
  // The active connection's change-request context (app name + non-secret
  // config), used to generate the role-assignment and resource-creation tickets.
  ctx: ChangeRequestContext;
}

function ResourceSelectionPanel({
  clientId,
  tenantId,
  setupPath,
  subscriptionId,
  onSubscriptionIdChange,
  rgName,
  onRgNameChange,
  workspaceName,
  onWorkspaceNameChange,
  connectNonce,
  ctx,
}: ResourceSelectionPanelProps) {
  const [stored, setStored] = useState('checking stored credentials...');
  const [validating, setValidating] = useState(false);
  const [scriptFeedback, setScriptFeedback] = useState('');
  const [discoverStatus, discoverOutput, runDiscover] = useRunner();

  // Resource discovery state. Each list is null until its query has run; an
  // empty array means the query succeeded but returned nothing. For subscriptions
  // an empty array is the bootstrap signal (dropdown hidden, text input shown).
  // Lists are cached in React state only - never persisted, and a connection
  // switch remounts this panel (via its key), which discards them.
  const [subscriptions, setSubscriptions] = useState<SubscriptionOption[] | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[] | null>(null);
  const [resourceGroups, setResourceGroups] = useState<ResourceGroupOption[] | null>(null);
  const [dependentStatus, setDependentStatus] = useState('');

  // Run the setup-path-dependent query for a chosen subscription:
  //   existing   -> Log Analytics workspaces (selecting one also sets rgName)
  //   lab-byo-rg -> resource groups
  //   lab-new-rg -> nothing (the lab creates its own resource group)
  // Clears the previous dependent lists first so stale options never linger.
  const loadDependent = useCallback(async (sub: string, path: SetupPath) => {
    setWorkspaces(null);
    setResourceGroups(null);
    if (sub === '') {
      setDependentStatus('');
      return;
    }
    if (path === 'lab-new-rg') {
      setDependentStatus(
        'This setup path creates its own resource group in the lab, so no resource selection is needed here.'
      );
      return;
    }
    if (path === 'existing') {
      setDependentStatus('Listing Log Analytics workspaces...');
      try {
        const result = await armGetJson(
          `https://management.azure.com/subscriptions/${encodeURIComponent(sub)}` +
            '/providers/Microsoft.OperationalInsights/workspaces?api-version=2023-09-01',
          'Workspaces'
        );
        if (!result.ok) {
          setDependentStatus(result.message);
          return;
        }
        const parsed = JSON.parse(result.text) as {
          value?: Array<{ name?: string; id?: string }>;
        };
        const list: WorkspaceOption[] = (parsed.value ?? [])
          .filter(
            (w): w is { name: string; id: string } =>
              typeof w.name === 'string' && w.name !== '' && typeof w.id === 'string' && w.id !== ''
          )
          .map((w) => ({ name: w.name, id: w.id }));
        setWorkspaces(list);
        setDependentStatus(
          list.length === 0
            ? 'No Log Analytics workspaces found in this subscription. Create one, or choose a different subscription.'
            : `Found ${list.length} workspace(s). Selecting one sets the workspace and its resource group.`
        );
      } catch (err) {
        setDependentStatus(`Workspace discovery error: ${String(err)}`);
      }
      return;
    }
    // lab-byo-rg: list the resource groups so the user can pick the pre-created one.
    setDependentStatus('Listing resource groups...');
    try {
      const result = await armGetJson(
        `https://management.azure.com/subscriptions/${encodeURIComponent(sub)}` +
          '/resourcegroups?api-version=2021-04-01',
        'Resource groups'
      );
      if (!result.ok) {
        setDependentStatus(result.message);
        return;
      }
      const parsed = JSON.parse(result.text) as { value?: Array<{ name?: string }> };
      const list: ResourceGroupOption[] = (parsed.value ?? [])
        .filter((g): g is { name: string } => typeof g.name === 'string' && g.name !== '')
        .map((g) => ({ name: g.name }));
      setResourceGroups(list);
      setDependentStatus(
        list.length === 0
          ? 'No resource groups found in this subscription.'
          : `Found ${list.length} resource group(s). Selecting one sets the resource group.`
      );
    } catch (err) {
      setDependentStatus(`Resource group discovery error: ${String(err)}`);
    }
  }, []);

  // Discover / refresh: acquire an ARM token (needs the connected secret), store
  // it so the proxy injects it as Bearer, then list subscriptions. A 401/403
  // returns an actionable message and leaves the dropdown hidden. An EMPTY list
  // is NOT an error: it means the service principal has no role assignments yet,
  // so the bootstrap subscription input is revealed (subscriptions === []).
  const discover = useCallback(
    () =>
      runDiscover(async () => {
        setSubscriptions(null);
        setWorkspaces(null);
        setResourceGroups(null);
        setDependentStatus('');
        const token = await acquireArmToken(tenantId);
        // Store the token BEFORE the ARM GET so proxies.yml can inject it as
        // Bearer (the app sends no Authorization header), same as panel 5.
        const putRes = await fetch(kvUrl('azureArmToken?encrypted=true'), {
          method: 'PUT',
          body: token.access_token,
        });
        if (!putRes.ok) {
          throw new Error(`PUT azureArmToken: HTTP ${putRes.status}\n${await putRes.text()}`);
        }
        const result = await armGetJson(
          'https://management.azure.com/subscriptions?api-version=2022-12-01',
          'Subscriptions'
        );
        if (!result.ok) {
          // 401/403: a token/authorization problem, not an empty tenant. Leave
          // subscriptions null so the bootstrap input does NOT appear.
          return result.message;
        }
        const parsed = JSON.parse(result.text) as {
          value?: Array<{ displayName?: string; subscriptionId?: string }>;
        };
        const list: SubscriptionOption[] = (parsed.value ?? [])
          .filter(
            (s): s is { subscriptionId: string; displayName?: string } =>
              typeof s.subscriptionId === 'string' && s.subscriptionId !== ''
          )
          .map((s) => ({ subscriptionId: s.subscriptionId, displayName: s.displayName ?? '(no displayName)' }));
        setSubscriptions(list);
        if (list.length === 0) {
          return (
            'No subscriptions returned. This app registration has no role assignments yet, so it ' +
            'cannot list any subscription. Enter your subscription ID below to scope the role ' +
            'assignment script, run it (it grants Reader), wait a couple of minutes for propagation, ' +
            'then Discover / refresh from Azure again.'
          );
        }
        // If the already-selected subscription is among the discovered set, load
        // its dependent list so a returning user sees the dependent dropdown now.
        const current = subscriptionId.trim();
        if (current !== '' && list.some((s) => s.subscriptionId === current)) {
          await loadDependent(current, setupPath);
        }
        return `Discovered ${list.length} subscription(s). Choose one below.`;
      }),
    [tenantId, subscriptionId, setupPath, loadDependent, runDiscover]
  );

  // Selecting a subscription sets the shared subscriptionId and re-runs the
  // dependent query for the current setup path.
  const onSubscriptionSelect = (value: string) => {
    onSubscriptionIdChange(value);
    void loadDependent(value, setupPath);
  };

  // Selecting a workspace sets the shared workspaceName and derives the resource
  // group from the workspace's ARM id (via @soc/core) so the user never types it.
  const onWorkspaceSelect = (name: string) => {
    onWorkspaceNameChange(name);
    const match = (workspaces ?? []).find((w) => w.name === name);
    if (match) {
      onRgNameChange(deriveResourceGroup(match.id));
    }
  };

  // When the setup path changes, the dependent query type changes (workspaces vs
  // resource groups vs none), so clear the now-irrelevant dependent lists; if a
  // subscription has already been discovered and selected, re-run the query for
  // the new path. The ref guard makes this fire ONLY on an actual setupPath
  // change, never when discovery repopulates subscriptions.
  const prevSetupPathRef = useRef(setupPath);
  useEffect(() => {
    if (prevSetupPathRef.current === setupPath) {
      return;
    }
    prevSetupPathRef.current = setupPath;
    setWorkspaces(null);
    setResourceGroups(null);
    setDependentStatus('');
    const current = subscriptionId.trim();
    if (subscriptions !== null && current !== '') {
      void loadDependent(current, setupPath);
    }
  }, [setupPath, subscriptions, subscriptionId, loadDependent]);

  // Report what already exists in THIS app context's KV store. The store is
  // scoped per app ID: Live Preview (__dev__ prefix) and the installed app
  // have separate stores, so credentials saved in one are absent in the other.
  // The tenant ID reflects the ACTIVE connection's config (remembered in the
  // azureProfiles entry), not a global key.
  const buildKvReport = useCallback(async (): Promise<{
    lines: string[];
    azureBasicPresent: boolean;
    tenant: string;
  }> => {
    const keysRes = await fetch(`${window.CRIBL_API_URL}/kvstore/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: 'azure' }),
    });
    const keysText = await keysRes.text();
    const tenant = tenantId.trim();
    const azureBasicPresent = keysText.includes('azureBasic');
    const lines = [
      `Stored in KV for app ID ${window.CRIBL_APP_ID ?? '(unknown)'}:`,
      azureBasicPresent
        ? '  client secret: stored (encrypted, not shown) - NOTE this is a single shared slot, not per connection'
        : '  client secret: not saved - Save and connect in panel 3 to store it',
      tenant !== ''
        ? `  tenant ID: ${tenant} (remembered in this connection)`
        : '  tenant ID: not saved - enter it in panel 3 (remembered per connection)',
      keysText.includes('azureArmToken')
        ? '  azureArmToken: present (encrypted) - a token has been acquired in this context'
        : '  azureArmToken: not yet acquired - run the token panel or re-check here',
    ];
    return { lines, azureBasicPresent, tenant };
  }, [tenantId]);

  // Auto-run on mount and after a save: report KV state only (no network to Azure).
  const checkStored = useCallback(async () => {
    try {
      const { lines } = await buildKvReport();
      setStored(lines.join('\n'));
    } catch (err) {
      setStored(`stored-credentials check failed: ${String(err)}`);
    }
  }, [buildKvReport]);

  useEffect(() => {
    void checkStored();
  }, [checkStored]);

  // Auto-run discovery ONCE after a successful connect in panel 3, and refresh
  // the stored-credentials KV report at the same time so it reflects the just-
  // saved secret/token instead of staying stale until a manual Re-check.
  // connectNonce increments on each connect; the ref guard fires only on an
  // actual increment, never on mount (prev === current) or on unrelated
  // re-renders (e.g. when checkStored's identity changes as tenantId changes).
  // Declared AFTER discover and checkStored so both are in scope (no TDZ).
  const prevConnectNonceRef = useRef(connectNonce);
  useEffect(() => {
    if (prevConnectNonceRef.current === connectNonce) {
      return;
    }
    prevConnectNonceRef.current = connectNonce;
    void discover();
    void checkStored();
  }, [connectNonce, discover, checkStored]);

  // Combined preflight: the KV report, then (if credentials are present) acquire
  // a token, store it so the proxy can inject it as Bearer, and validate the
  // caller's EFFECTIVE permissions at the scope(s) the selected setup path uses.
  const recheckAndValidate = useCallback(async () => {
    setValidating(true);
    try {
      const report = await buildKvReport();
      const baseLines = report.lines;
      const credsPresent = report.azureBasicPresent && report.tenant !== '';
      if (!credsPresent) {
        setStored(
          [
            ...baseLines,
            '',
            'Permission validation skipped: connect first in panel 3 (Save and connect stores the',
            'client secret and tenant ID). Validation acquires a token, which needs the encrypted',
            'azureBasic entry plus a tenant ID on the active connection.',
          ].join('\n')
        );
        return;
      }
      setStored([...baseLines, '', 'Permission validation: acquiring token and querying scopes...'].join('\n'));
      const validationLines: string[] = [];
      try {
        const token = await acquireArmToken(tenantId);
        // Store the token BEFORE the permissions GET so proxies.yml can inject
        // it as Bearer (the app sends no Authorization header), like panel 5.
        const putRes = await fetch(kvUrl('azureArmToken?encrypted=true'), {
          method: 'PUT',
          body: token.access_token,
        });
        if (!putRes.ok) {
          throw new Error(`PUT azureArmToken: HTTP ${putRes.status}\n${await putRes.text()}`);
        }
        validationLines.push(
          ...(await validatePermissionsForPath(setupPath, subscriptionId.trim(), rgName.trim()))
        );
      } catch (err) {
        validationLines.push(`Permission validation error: ${String(err)}`);
      }
      setStored([...baseLines, '', 'Permission validation:', ...validationLines].join('\n'));
    } catch (err) {
      setStored(`stored-credentials check failed: ${String(err)}`);
    } finally {
      setValidating(false);
    }
  }, [buildKvReport, tenantId, setupPath, subscriptionId, rgName]);

  // The az role-assignment script for the selected setup path, built from the
  // SELECTED (or bootstrap-typed) subscription and the derived/selected resource
  // group. Blank fields stay as <placeholders> so a partial copy is visibly
  // incomplete. Copy/download report via a small feedback line (no runner).
  const script = renderRoleAssignmentCli(setupPath, {
    clientId,
    subscriptionId,
    resourceGroup: rgName,
  });
  const copyScript = async () => {
    try {
      await navigator.clipboard.writeText(script);
      setScriptFeedback(
        script.includes('<')
          ? 'Copied - NOTE: some fields are blank, so the script still contains <placeholders>.'
          : 'Copied to clipboard. Run it in a shell with az logged into the test tenant.'
      );
    } catch (err) {
      setScriptFeedback(`Copy failed: ${String(err)}`);
    }
  };
  // Download avoids the terminal multi-line paste prompt and lets the script be
  // reviewed and re-run: bash assign-roles.sh, or run the az lines in PowerShell.
  const downloadScript = () => {
    const body = `#!/usr/bin/env bash\nset -euo pipefail\n\n${script}\n`;
    const blob = new Blob([body], { type: 'application/x-sh' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'assign-roles.sh';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setScriptFeedback(
      script.includes('<')
        ? 'Download dispatched (assign-roles.sh) - NOTE: some fields are blank, so it still contains <placeholders>.'
        : 'Download dispatched (assign-roles.sh). Run: bash assign-roles.sh (or run the az lines in PowerShell).'
    );
  };

  return (
    <section className="panel">
      <h2 className="panel-title">4. Select resources and grant permissions</h2>
      <p className="panel-desc">
        Discover the subscriptions this app registration can see, select the subscription and (for the
        existing and bring-your-own-RG paths) the target resource, then generate and run the role
        assignment script and validate the effective permissions. Discovery runs automatically once
        after you Save and connect in panel 3; use Discover / refresh from Azure to re-run it after
        granting roles.
      </p>
      <ChangeRequestBlock
        title="Cannot assign roles yourself? Generate a change request"
        description={
          'The human-readable companion to the az CLI script below: a paste-ready ticket asking a team ' +
          'with RBAC rights to assign exactly the roles this setup path requires, at the named scopes, ' +
          'with a justification per role. Blank fields appear as clear placeholders.'
        }
        filename="role-assignment-request.txt"
        generate={() => roleAssignmentRequest(ctx)}
      />
      <ChangeRequestBlock
        title="Need a resource group or Event Hub created? Generate a change request"
        description={
          'A paste-ready ticket asking for the Azure resources this app needs but you may lack rights ' +
          'to create: for the new-lab-RG path a resource group with a mandatory TTL auto-delete, plus ' +
          'an Event Hub namespace for the diagnostic-settings export path.'
        }
        filename="resource-creation-request.txt"
        generate={() => resourceCreationRequest(ctx)}
      />
      <div className="panel-controls">
        <button
          className="run-button"
          onClick={() => void discover()}
          disabled={discoverStatus === 'running'}
        >
          Discover / refresh from Azure
        </button>
        <span className={`status status-${discoverStatus}`}>{discoverStatus}</span>
      </div>
      {discoverOutput !== '' && <pre className="result">{discoverOutput}</pre>}
      <div className="form-grid">
        {subscriptions === null && (
          <label className="field">
            <span className="field-label">Subscription</span>
            <select disabled value="">
              <option value="">Click Discover / refresh from Azure above to load...</option>
            </select>
            <span className="field-hint">
              The selectors fill from live discovery. Connect in panel 3 first, then Discover.
            </span>
          </label>
        )}
        {subscriptions !== null && subscriptions.length > 0 && (
          <label className="field">
            <span className="field-label">Subscription</span>
            <select value={subscriptionId} onChange={(e) => onSubscriptionSelect(e.target.value)}>
              <option value="">Select a subscription...</option>
              {subscriptions.map((s) => (
                <option key={s.subscriptionId} value={s.subscriptionId}>
                  {s.displayName} ({s.subscriptionId})
                </option>
              ))}
            </select>
          </label>
        )}
        {subscriptions !== null && subscriptions.length === 0 && (
          <label className="field">
            <span className="field-label">Subscription ID (one-time bootstrap)</span>
            <input
              type="text"
              value={subscriptionId}
              onChange={(e) => onSubscriptionIdChange(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="find it via 'az account list' or the Azure portal"
            />
            <span className="field-hint">
              Discovery found no subscriptions, so this app registration has no role assignments yet.
              Type the subscription ID here to scope the role script below - this is the only place a
              subscription is typed. After you grant Reader and Discover / refresh from Azure again,
              the dropdown replaces it.
            </span>
          </label>
        )}
        {setupPath === 'existing' &&
          (workspaces !== null && workspaces.length > 0 ? (
            <label className="field">
              <span className="field-label">Log Analytics workspace</span>
              <select value={workspaceName} onChange={(e) => onWorkspaceSelect(e.target.value)}>
                <option value="">Select a workspace...</option>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.name}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="field">
              <span className="field-label">Log Analytics workspace</span>
              <select disabled value="">
                <option value="">
                  {subscriptionId === ''
                    ? 'Select a subscription first...'
                    : 'Waiting for workspace discovery...'}
                </option>
              </select>
            </label>
          ))}
        {setupPath === 'lab-byo-rg' &&
          (resourceGroups !== null && resourceGroups.length > 0 ? (
            <label className="field">
              <span className="field-label">Resource group</span>
              <select value={rgName} onChange={(e) => onRgNameChange(e.target.value)}>
                <option value="">Select a resource group...</option>
                {resourceGroups.map((g) => (
                  <option key={g.name} value={g.name}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="field">
              <span className="field-label">Resource group</span>
              <select disabled value="">
                <option value="">
                  {subscriptionId === ''
                    ? 'Select a subscription first...'
                    : 'Waiting for resource group discovery...'}
                </option>
              </select>
            </label>
          ))}
      </div>
      {dependentStatus !== '' && (
        <div className="discovery-result">
          <span className="field-label">
            {setupPath === 'existing'
              ? 'Workspace discovery'
              : setupPath === 'lab-byo-rg'
                ? 'Resource group discovery'
                : 'Setup path'}
          </span>
          <pre className="result">{dependentStatus}</pre>
        </div>
      )}
      <div className="discovery-result">
        <span className="field-label">Role assignment script</span>
        <pre className="result">{script}</pre>
      </div>
      <div className="panel-controls">
        <button className="run-button" onClick={() => void copyScript()}>
          Copy az CLI script
        </button>
        <button className="run-button" onClick={downloadScript}>
          Download assign-roles.sh
        </button>
      </div>
      {scriptFeedback !== '' && <p className="panel-desc">{scriptFeedback}</p>}
      <p className="panel-desc">
        The script is generated from the selected (or bootstrap) subscription and the derived resource
        group. Copy or download it - download avoids the terminal multi-line paste prompt and lets you
        review it first. If you paste, choose Paste (not Paste as one line, which would join the
        commands). Role assignments can take a couple of minutes to propagate; Discover / refresh from
        Azure again afterward.
      </p>
      <pre className="result">{stored}</pre>
      <div className="panel-controls">
        <button
          className="run-button"
          onClick={() => void recheckAndValidate()}
          disabled={validating}
        >
          Re-check and validate permissions
        </button>
      </div>
      <p className="panel-desc">
        Re-check and validate permissions reports the stored KV state and then, if the connection is
        made, acquires a token and checks the caller&apos;s EFFECTIVE Azure permissions for the selected
        setup path and resources - it evaluates the actions actually allowed (via the RBAC permissions
        API), not role names, so custom or lookalike roles are handled correctly.
      </p>
    </section>
  );
}

// Panel 5: client_credentials token flow. The app never sets Authorization;
// proxies.yml injects Basic ${kv.azureBasic} server-side (the proxy strips
// any Authorization header the client sends). The tenant is the ACTIVE
// connection's tenant ID.
function TokenAcquisitionPanel({ tenantId }: { tenantId: string }) {
  const [status, output, run] = useRunner();
  const acquire = () =>
    run(async () => {
      // Shared with the panel 3 connect and panel 4 discovery/preflight so the
      // token flow lives in one place.
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
      index={5}
      title="Token acquisition (via proxy header injection)"
      status={status}
      output={output}
      actionLabel="Acquire token"
      onAction={() => void acquire()}
    >
      <p className="panel-desc">
        Save and connect (panel 3) already acquires and stores a token; this panel is an explicit
        re-acquire and diagnostic. Uses the active connection&apos;s tenant ID, then POSTs
        grant_type=client_credentials with the ARM scope to login.microsoftonline.com. No Authorization
        header is set by the app - the proxy injects Basic auth from kv.azureBasic per proxies.yml. On
        success the access token is stored encrypted under azureArmToken.
      </p>
    </Panel>
  );
}

// Panel 6: ARM subscriptions list. Bearer token is injected server-side from
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
      index={6}
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

// Panel 7: does the sandboxed iframe allow programmatic downloads? The only
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
      index={7}
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
  // The whole harness is now driven by a ProfileStore of named connections. The
  // ACTIVE profile's non-secret config feeds every config-bearing panel. The
  // store is hydrated from, and debounce-autosaved to, the plain 'azureProfiles'
  // KV entry. Client secrets are NEVER part of this state - they are handled
  // write-only by the connect action in panel 3 and tracked per session by
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
  // refreshed by the Options screen's save callback. The tolerant codec
  // makes a failed read equal "defaults", never a crash.
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

  // The Options screen's storage callbacks (the small shared load/save this
  // shell owns): one plain KV entry, read raw so the screen can merge saves
  // through applyOptionsPatch, with the shell's parsed copy refreshed on
  // every save so onboarding defaults follow immediately.
  const loadAppOptions = useCallback(() => appStateStore.get(APP_OPTIONS_KEY), []);
  const saveAppOptions = useCallback(async (serialized: string) => {
    await appStateStore.set(APP_OPTIONS_KEY, serialized);
    setAppOptions(parseAppOptions(serialized));
  }, []);

  // Which profile's secret was last written to the single azureBasic slot THIS
  // session, plus the identity it was written under. Non-persisted: both reset to
  // null on reload (secrets are never remembered per profile across reloads).
  const [liveSecretProfileId, setLiveSecretProfileId] = useState<string | null>(null);
  const [liveSecretIdentity, setLiveSecretIdentity] = useState<LiveSecretIdentity | null>(null);

  // A transient message surfaced after a switch / clear (e.g. "enter the secret
  // for this connection"). Cleared once a secret is saved or a no-clear switch
  // happens.
  const [switchNotice, setSwitchNotice] = useState('');

  // Bumped by panel 3 on a full successful connect (secret written + token
  // acquired). Panel 4 watches this to auto-run resource discovery exactly once
  // per connect. Non-persisted; survives panel-4 remounts so a connect made
  // while panel 4 is mounted triggers its discovery effect.
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
      const loaded = await loadProfileStore();
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
  // replaced by a message pointing at panels 3 and 4 in the harness view.
  const missingOnboardFields = ONBOARD_REQUIRED_FIELDS.filter(
    (field) => activeConfig[field].trim() === ''
  );
  // The change-request context handed to panels 3 and 4: the fixed app name plus
  // the active connection's non-secret config. Re-derived each render so the
  // generated tickets and their embedded diagrams reflect the current inputs.
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
          'Switched connection - enter the client secret for this connection in panel 3 and Save and connect to authenticate.'
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
    setSwitchNotice('Stored secret cleared - re-enter the client secret in panel 3 and Save and connect to re-authenticate.');
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
  const handleSecretSaved = (profileId: string, savedTenantId: string, savedClientId: string) => {
    setLiveSecretProfileId(profileId);
    setLiveSecretIdentity({ tenantId: savedTenantId, clientId: savedClientId });
    setSwitchNotice('');
  };

  // The EXPLICIT scope commit from the Azure Targeting screen: the ONE way a
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
    secretLive: secretLive && !identityDrifted ? 'live' : 'unknown',
    scopeCommitted:
      activeConfig.subscriptionId.trim() !== '' &&
      activeConfig.resourceGroup.trim() !== '' &&
      activeConfig.workspaceName.trim() !== '',
    criblReachable:
      platformLink === 'ok' ? true : platformLink === 'checking...' ? undefined : false,
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
            secret: {secretLive ? 'stored (this session)' : 'not entered'}
          </span>
          <span
            className="scope-chip"
            title="The committed Azure target scope (subscription / resource group / workspace) of the active connection. Change it from the Azure Targeting screen - browsing there never changes it until you click Use this target."
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

  // The Phase 1 diagnostics panels, intact, now living behind the frame's
  // Diagnostics route (retitled from Spike Harness and demoted below the
  // journey and tools sections - ux-flow-plan 3.3). Panel 3 doubles as the
  // journey's Connect surface until Unit 9 promotes it; panel 4's discovery
  // stays a diagnostic (Azure Targeting is the product path).
  const harnessView = (
    <>
      <header className="harness-header">
        <h1 className="harness-title">Diagnostics (Phase 1 Spike Harness)</h1>
        <p className="harness-subtitle">
          Sequential diagnostics for the Cribl App Platform: globals, KV store semantics,
          proxy header injection, Azure AD token flow, ARM access, and iframe download behavior.
          Pick or create a connection above, then run the panels top to bottom. Panel 3
          (App registration and connect) is also the journey&apos;s Connect step until a
          dedicated Connect screen ships.
        </p>
      </header>
      <PlatformGlobalsPanel />
      <KvStorePanel />
      <AppRegistrationConnectPanel
        key={store.activeProfileId ?? 'none'}
        activeProfileId={store.activeProfileId}
        secretLive={secretLive}
        onSecretSaved={handleSecretSaved}
        onConnected={handleConnected}
        clientId={activeConfig.clientId}
        onClientIdChange={(v) => updateField({ clientId: v })}
        tenantId={activeConfig.tenantId}
        onTenantIdChange={(v) => updateField({ tenantId: v })}
        setupPath={activeConfig.setupPath}
        onSetupPathChange={(v) => updateField({ setupPath: v })}
        ctx={changeRequestCtx}
      />
      <ResourceSelectionPanel
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
      />
      <TokenAcquisitionPanel tenantId={activeConfig.tenantId} />
      <ArmCallPanel />
      <ArtifactDownloadPanel />
    </>
  );

  // The Home route (ux-flow-plan 4.3, Unit 6.5): the state-aware landing
  // surface BOTH shells open on every launch. Facts in, rails and the single
  // next action out - position is derived from persisted state on every
  // render, so resume is automatic and there is no wizard-progress blob to
  // drift. Mounted in a PortsProvider for the embedded RecentRuns.
  const renderHome = (nav: AppFrameNav) => (
    <>
      <header className="harness-header">
        <h1 className="harness-title">Home</h1>
        <p className="harness-subtitle">
          Where this install is on the journey and the single next action.
          Every stage is visible and navigable; commits stay gated inside
          their screens.
        </p>
      </header>
      <PortsProvider ports={cloudPorts} config={activeConfig}>
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
  // (read-ahead). Keyed by the active profile so switching connections drops
  // in-page deploy state. The standalone Onboard / Azure Targeting / Batch /
  // Review routes stay registered - this page composes and supersedes them.
  const renderIntegrate = (nav: AppFrameNav) => (
    <>
      <header className="harness-header">
        <h1 className="harness-title">Integrate</h1>
        <p className="harness-subtitle">
          The single-page integration flow: Azure resources, Cribl
          configuration, and the operable native-table deploy on one page, with
          deploy readiness always visible. The solution, sample-data,
          gap-analysis, and rule-coverage sections arrive in later units.
        </p>
      </header>
      {!secretLive && (
        <p className="connection-notice">
          This connection&apos;s client secret has not been entered this
          session. A secret connected in an earlier session may still be live
          server-side; if the deploy fails acquiring a token, re-enter the
          secret in panel 3 (Save and connect) of the Diagnostics view first.
        </p>
      )}
      <PortsProvider ports={cloudPorts} config={activeConfig}>
        <IntegrateScreen
          key={`integrate-${store.activeProfileId ?? 'none'}`}
          scopeCommitted={journeyFacts.scopeCommitted}
          offline={!hasAzure(phase.mode)}
          onCommitScope={handleCommitScope}
          criblDefaults={appOptions.cribl}
          operationDefaults={appOptions.operation}
          onOpenOptions={() => nav.navigate('options')}
          roleGuidance={ROLE_GUIDANCE}
        />
      </PortsProvider>
    </>
  );

  // The Azure Targeting route (Unit 2): the product path for choosing where
  // DCRs deploy. Keyed by the active profile so switching connections resets
  // all browse state. requires: 'azure' gates it to modes with a live Azure
  // side; the screen's offline branch stays wired for the day the route table
  // exposes it in artifact-only modes.
  const renderTargeting = () => (
    <>
      <header className="harness-header">
        <h1 className="harness-title">Azure targeting</h1>
        <p className="harness-subtitle">
          Browse subscriptions, workspaces, and resource groups; create what is
          missing; enable Sentinel; then commit the scope with Use this target.
          Browsing never changes the committed target - the chip in the
          connection bar always shows what is committed.
        </p>
      </header>
      <PortsProvider ports={cloudPorts} config={activeConfig}>
        <AzureTargetingScreen
          key={`target-${store.activeProfileId ?? 'none'}`}
          offline={!hasAzure(phase.mode)}
          onCommitScope={handleCommitScope}
        />
      </PortsProvider>
    </>
  );

  // The Onboard route: gated on the five config fields the use-case cannot
  // run without; the escape hatch navigates to the harness through the frame.
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
            {missingOnboardFields.join(', ')}. Home shows the whole journey and names the
            single next step. Connect first in panel 3 (App registration and connect) of the
            Diagnostics view - that fills the tenant and client ids. Then choose WHERE to
            deploy on the Azure Targeting screen: browse the subscription, workspace, and
            resource group cascade and click Use this target to commit the scope. The Run
            action unlocks once all five fields are set.
          </p>
          <div className="panel-controls">
            <button className="run-button" onClick={() => nav.navigate('home')}>
              Open Home
            </button>
            <button className="run-button" onClick={() => nav.navigate('azure-target')}>
              Open Azure Targeting
            </button>
            <button className="run-button" onClick={() => nav.navigate('harness')}>
              Open Diagnostics
            </button>
          </div>
        </section>
      ) : (
        <>
          {!secretLive && (
            <p className="connection-notice">
              This connection&apos;s client secret has not been entered this session. A secret
              connected in an earlier session may still be live server-side; if the run fails
              acquiring a token, re-enter the secret in panel 3 (Save and connect) of the
              Diagnostics view first.
            </p>
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

  // The Batch Onboard route (porting-plan Unit 6): many tables as ONE parent
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
            {missingOnboardFields.join(', ')}. Home shows the whole journey and names the
            single next step: connect first in panel 3 (App registration and connect) of the
            Diagnostics view, then commit a target scope on the Azure Targeting screen. The
            Run action unlocks once all five fields are set.
          </p>
          <div className="panel-controls">
            <button className="run-button" onClick={() => nav.navigate('home')}>
              Open Home
            </button>
            <button className="run-button" onClick={() => nav.navigate('azure-target')}>
              Open Azure Targeting
            </button>
            <button className="run-button" onClick={() => nav.navigate('harness')}>
              Open Diagnostics
            </button>
          </div>
        </section>
      ) : (
        <>
          {!secretLive && (
            <p className="connection-notice">
              This connection&apos;s client secret has not been entered this session. A secret
              connected in an earlier session may still be live server-side; if the run fails
              acquiring a token, re-enter the secret in panel 3 (Save and connect) of the
              Diagnostics view first.
            </p>
          )}
          <PortsProvider ports={cloudPorts} config={activeConfig}>
            <BatchDeployScreen
              key={`batch-${store.activeProfileId ?? 'none'}`}
              pacing={BATCH_PACING}
              operationDefaults={appOptions.operation}
              criblDefaults={appOptions.cribl}
              onOpenOptions={() => nav.navigate('options')}
              forcedTemplateOnly={!hasCribl(phase.mode)}
            />
          </PortsProvider>
        </>
      )}
    </>
  );

  // The Review route (porting-plan Unit 7, ux-flow-plan 5.2): the Integrate
  // arc's REVIEW stage - live-ARM deployment preview with the staleness
  // marker and the acknowledge gate arming the handoff to Batch Onboard.
  // No "connection incomplete" wall here: the screen keeps every control
  // visible and disables them with the journey-state hint (the same
  // identity/scope prerequisites a deploy run needs). Keyed by the active
  // profile so switching connections drops the generated preview (stale
  // cross-profile previews were a legacy hazard class).
  const renderReview = (nav: AppFrameNav) => (
    <>
      <header className="harness-header">
        <h1 className="harness-title">Review deployment</h1>
        <p className="harness-subtitle">
          Preview exactly what a deploy run would create - predicted DCR/DCE
          names (the same names deployment uses), Exists vs Will create from
          live Azure, and the ARM request bodies - then acknowledge the
          preview to arm the Deploy handoff. Read-only: checking never
          deploys anything.
        </p>
      </header>
      <PortsProvider ports={cloudPorts} config={activeConfig}>
        <ReviewScreen
          key={`review-${store.activeProfileId ?? 'none'}`}
          generatedAtToken={REVIEW_GENERATED_AT}
          operationDefaults={appOptions.operation}
          journeyBlockedReason={reviewJourneyHint}
          onOpenOptions={() => nav.navigate('options')}
          onProceedToDeploy={() => nav.navigate('batch-onboard')}
          deploySurfaceLabel="Batch Onboard"
        />
      </PortsProvider>
    </>
  );

  // The Options route (porting-plan Unit 4): deployment and naming defaults
  // as typed forms over the plain appOptions KV entry. requires: 'none' -
  // options are app configuration, editable in every mode. No PortsProvider
  // needed: the screen's only IO is the two storage callbacks above.
  const optionsView = (
    <>
      <header className="harness-header">
        <h1 className="harness-title">Options</h1>
        <p className="harness-subtitle">
          Deployment and naming defaults for onboarding and deployment jobs:
          Direct vs DCE mode, timeouts, template handling, custom-table
          retention, Private Link, and Cribl destination naming.
        </p>
      </header>
      <OptionsScreen loadOptions={loadAppOptions} saveOptions={saveAppOptions} />
    </>
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
  // in dependency order - Home, then Integrate (the single-page flagship, the
  // PRIMARY journey route), then the standalone Azure Targeting, Onboard,
  // Batch Onboard, and Review screens the Integrate page composes and
  // supersedes but which stay reachable during the transition - then tools
  // (Options, Logs, Settings), then Diagnostics last (the Spike
  // Harness retitled; panel 4's discovery stays a diagnostic - the targeting
  // screen is the product path). Requirements still drive mode-aware
  // navigation via the ONE @soc/core filterNavItems pass; grouping is
  // presentation only. Onboard needs BOTH live sides (it deploys to Azure
  // and Cribl in one run); batch-onboard relaxes to 'azure' (recorded Unit
  // 6.5 decision) - in azure-only mode templateOnly is FORCED on because no
  // live Cribl connection exists to deploy destinations to. Review (Unit 7)
  // requires 'azure' (its truth is live ARM) and sits after the screens
  // serving Choose/Configure, mirroring the integrate arc's stage order.
  const routes: AppRoute[] = [
    { id: 'home', label: 'Home', requires: 'none', section: 'journey', render: renderHome },
    { id: 'integrate', label: 'Integrate', requires: 'both', section: 'journey', render: renderIntegrate },
    { id: 'azure-target', label: 'Azure Targeting', requires: 'azure', section: 'journey', render: renderTargeting },
    { id: 'onboard', label: 'Onboard', requires: 'both', section: 'journey', render: renderOnboard },
    { id: 'batch-onboard', label: 'Batch Onboard', requires: 'azure', section: 'journey', render: renderBatch },
    { id: 'review', label: 'Review', requires: 'azure', section: 'journey', render: renderReview },
    { id: 'options', label: 'Options', requires: 'none', section: 'tools', render: () => optionsView },
    { id: 'logs', label: 'Logs', requires: 'none', section: 'tools', render: () => logsView },
    { id: 'settings', label: 'Settings', requires: 'none', section: 'tools', render: () => settingsView },
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
