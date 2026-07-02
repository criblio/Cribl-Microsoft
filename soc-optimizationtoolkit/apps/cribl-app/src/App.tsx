import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  allGranted,
  computeInvalidation,
  deriveResourceGroup,
  EMPTY_AZURE_CONFIG,
  EMPTY_PROFILE_STORE,
  evaluatePermissions,
  getActiveConfig,
  getActiveProfile,
  parseAzureConfig,
  parseProfileStore,
  removeProfile,
  renameProfile,
  REQUIRED_ACTIONS,
  serializeProfileStore,
  setActiveProfile,
  updateActiveConfig,
  upsertProfile,
} from '@soc/core';
import type {
  AzureConfig,
  ConnectionProfile,
  PermissionsResponse,
  ProfileStore,
  RequiredAction,
} from '@soc/core';

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

function kvUrl(key: string): string {
  return `${window.CRIBL_API_URL}/kvstore/${key}`;
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
    const res = await fetch(kvUrl('azureProfiles'));
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
    const res = await fetch(kvUrl('azureConfig'));
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
function KvStorePanel() {
  const [status, output, run] = useRunner();
  const exercise = () =>
    run(async () => {
      const lines: string[] = [];
      const step = async (label: string, url: string, init?: RequestInit) => {
        const res = await fetch(url, init);
        const body = await res.text();
        lines.push(`${label}: HTTP ${res.status} body=${JSON.stringify(body)}`);
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
            : '  check: redacted placeholder returned, plaintext not readable (expected)'
        );
        const keys = await step("POST keys {prefix: 'spike-'}", `${window.CRIBL_API_URL}/kvstore/keys`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefix: 'spike-' }),
        });
        lines.push(
          keys.includes('spike-plain') && keys.includes('spike-secret')
            ? '  check: both keys listed as expected'
            : '  check: expected both spike-plain and spike-secret in the listing'
        );
        await step('DELETE spike-plain', kvUrl('spike-plain'), { method: 'DELETE' });
        await step('DELETE spike-secret', kvUrl('spike-secret'), { method: 'DELETE' });
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
      output={output}
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

// Panel 3: how to create the Entra app registration and which Azure roles to
// assign, tiered so testers grant only what the capabilities they exercise
// need. The inputs complete an az CLI script for the role assignments; blank
// fields stay as <placeholders> so a partial copy is still visibly incomplete.
type SetupPath = 'existing' | 'lab-new-rg' | 'lab-byo-rg';

function buildAzScript(path: SetupPath, clientId: string, subscriptionId: string, rgName: string): string {
  const client = clientId.trim() === '' ? '<clientId>' : clientId.trim();
  const sub = subscriptionId.trim() === '' ? '<subscriptionId>' : subscriptionId.trim();
  const rg = rgName.trim() === '' ? (path === 'existing' ? '<workspaceRg>' : '<labRg>') : rgName.trim();
  if (path === 'existing') {
    return [
      '# Existing workspace: least privilege, scoped to its resource group',
      `az role assignment create --assignee ${client} --role "Reader" --scope /subscriptions/${sub}`,
      `az role assignment create --assignee ${client} --role "Monitoring Contributor" --scope /subscriptions/${sub}/resourceGroups/${rg}`,
      `az role assignment create --assignee ${client} --role "Log Analytics Contributor" --scope /subscriptions/${sub}/resourceGroups/${rg}`,
    ].join('\n');
  }
  if (path === 'lab-new-rg') {
    return [
      '# Lab creates its own resource group and workspace: subscription Contributor',
      '# covers RG creation plus all workspace/DCR operations inside the lab, so no',
      '# workspace-scoped roles are needed on this path.',
      `az role assignment create --assignee ${client} --role "Contributor" --scope /subscriptions/${sub}`,
      '# Assign RBAC Administrator via the Azure portal so you can add the condition',
      '# "Constrain roles and principal types": only Contributor and Monitoring',
      '# Metrics Publisher, only to service principals (the lab TTL self-destruct',
      '# assigns its delete role at deploy time).',
    ].join('\n');
  }
  return [
    '# Pre-created lab resource group: least privilege for labs; the lab deploys',
    '# its workspace and resources into this RG with no subscription-scope rights.',
    `az role assignment create --assignee ${client} --role "Contributor" --scope /subscriptions/${sub}/resourceGroups/${rg}`,
    '# An admin must pre-assign the TTL self-destruct identity its delete rights',
    '# on this resource group (the app cannot assign roles on this path).',
  ].join('\n');
}

interface AppRegistrationPanelProps {
  clientId: string;
  onClientIdChange: (value: string) => void;
  setupPath: SetupPath;
  onSetupPathChange: (value: SetupPath) => void;
  subscriptionId: string;
  onSubscriptionIdChange: (value: string) => void;
  rgName: string;
  onRgNameChange: (value: string) => void;
}

function AppRegistrationPanel({
  clientId,
  onClientIdChange,
  setupPath,
  onSetupPathChange,
  subscriptionId,
  onSubscriptionIdChange,
  rgName,
  onRgNameChange,
}: AppRegistrationPanelProps) {
  const [status, output, run] = useRunner();
  const script = buildAzScript(setupPath, clientId, subscriptionId, rgName);
  const copyScript = () =>
    run(async () => {
      await navigator.clipboard.writeText(script);
      const incomplete = script.includes('<');
      return incomplete
        ? 'Copied to clipboard - NOTE: some fields are blank, so the script still contains <placeholders>.'
        : 'Copied to clipboard. Run it in a shell with az logged into the test tenant.';
    });
  // Download avoids the terminal multi-line paste prompt and lets the script be
  // reviewed and re-run: bash assign-roles.sh, or run the az lines in PowerShell.
  const downloadScript = () =>
    run(async () => {
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
      const incomplete = script.includes('<');
      return incomplete
        ? 'Download dispatched (assign-roles.sh) - NOTE: some fields are blank, so it still contains <placeholders>.'
        : 'Download dispatched (assign-roles.sh). Run: bash assign-roles.sh (or run the az lines in PowerShell).';
    });

  return (
    <Panel
      index={3}
      title="App registration setup"
      status={status}
      output={output}
      actionLabel="Copy az CLI script"
      onAction={() => void copyScript()}
    >
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
          Choose your setup path, fill in the fields, then copy and run the completed script
          (or use the portal).
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
          <span className="field-label">Subscription ID</span>
          <input
            type="text"
            value={subscriptionId}
            onChange={(e) => onSubscriptionIdChange(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        {setupPath !== 'lab-new-rg' && (
          <label className="field">
            <span className="field-label">
              {setupPath === 'existing' ? 'Workspace resource group' : 'Lab resource group (pre-created)'}
            </span>
            <input
              type="text"
              value={rgName}
              onChange={(e) => onRgNameChange(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        )}
      </div>
      <pre className="result">{script}</pre>
      <div className="panel-controls">
        <button className="run-button" onClick={() => void downloadScript()}>
          Download assign-roles.sh
        </button>
      </div>
      <p className="panel-desc">
        Copy or download the script - download avoids the terminal multi-line paste prompt and lets
        you review it first. If you do paste, choose Paste (not Paste as one line, which would join
        the commands). Role assignments can take a couple of minutes to propagate. The client ID
        entered here pre-fills the credentials panel below; enter the tenant ID and secret there.
      </p>
    </Panel>
  );
}

// Parsed subset of the Azure AD token endpoint response the harness consumes.
interface ArmTokenResult {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

// Run the client_credentials/ARM-scope token request for the given tenant. The
// app sets no Authorization header: proxies.yml injects Basic ${kv.azureBasic}
// server-side (the active connection's secret). Returns the parsed token so both
// the credentials preflight (panel 4) and the token panel (panel 5) share one
// implementation. The tenant comes from the ACTIVE connection's config.
async function acquireArmToken(tenantId: string): Promise<ArmTokenResult> {
  const tenant = tenantId.trim();
  if (tenant === '') {
    throw new Error(
      'The active connection has no tenant ID - enter the tenant ID in panel 4 (it is remembered per connection), then retry'
    );
  }
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: 'https://management.azure.com/.default',
  });
  const res = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    }
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`token endpoint: HTTP ${res.status}\n${text}`);
  }
  const token = JSON.parse(text) as {
    token_type?: string;
    expires_in?: number;
    access_token?: string;
  };
  if (typeof token.access_token !== 'string' || token.access_token === '') {
    throw new Error(`token endpoint: HTTP ${res.status} but no access_token in body\n${text}`);
  }
  return { access_token: token.access_token, token_type: token.token_type, expires_in: token.expires_in };
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
        'Subscription scope: enter a Subscription ID in panel 3 to validate subscription-level reads (existing-subscription).'
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
        'Resource group scope: enter Subscription ID and Workspace resource group in panel 3 to validate RG-level writes (existing-rg).'
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
        'Subscription scope: enter a Subscription ID in panel 3 to validate subscription-level lab creation (lab-new-rg-subscription).',
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
      'Resource group scope: enter Subscription ID and Lab resource group in panel 3 to validate RG-level lab deployment (lab-byo-rg).',
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
        'Click Discover Azure resources again to acquire a fresh token, then retry.',
    };
  }
  if (res.status === 403) {
    return {
      ok: false,
      message:
        `${label}: HTTP 403 - the service principal is not authorized at this scope. ` +
        'Grant it at least Reader (run the panel 3 role script), wait for propagation, then retry.',
    };
  }
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, message: `${label}: HTTP ${res.status}\n${text}` };
  }
  return { ok: true, text };
}

// Panel 4: store Azure app registration credentials in the app KV store. The
// Basic value (base64 of clientId:clientSecret) is written encrypted and is
// only ever resolved server-side by proxies.yml header injection. The re-check
// action also runs the permission preflight for the selected setup path. This
// panel also hosts resource discovery: it needs an ARM token (from the saved
// secret), so the Discover Azure resources button and its dependent dropdowns
// live here, writing into the same shared subscription/resource-group state the
// panel-3 text inputs bind to. The panel is keyed by the active profile id in
// App, so switching connections remounts it and clears all cached discovery and
// permission-validation state.
interface AzureCredentialsPanelProps {
  activeProfileId: string | null;
  onSecretSaved: (profileId: string, tenantId: string, clientId: string) => void;
  clientId: string;
  onClientIdChange: (value: string) => void;
  tenantId: string;
  onTenantIdChange: (value: string) => void;
  setupPath: SetupPath;
  subscriptionId: string;
  onSubscriptionIdChange: (value: string) => void;
  rgName: string;
  onRgNameChange: (value: string) => void;
  workspaceName: string;
  onWorkspaceNameChange: (value: string) => void;
}

function AzureCredentialsPanel({
  activeProfileId,
  onSecretSaved,
  clientId,
  onClientIdChange,
  tenantId,
  onTenantIdChange,
  setupPath,
  subscriptionId,
  onSubscriptionIdChange,
  rgName,
  onRgNameChange,
  workspaceName,
  onWorkspaceNameChange,
}: AzureCredentialsPanelProps) {
  const [clientSecret, setClientSecret] = useState('');
  const [stored, setStored] = useState('checking stored credentials...');
  const [secretStored, setSecretStored] = useState(false);
  const [validating, setValidating] = useState(false);
  const [status, output, run] = useRunner();

  // Resource discovery state. Each list is null until its query has run; an
  // empty array means the query succeeded but returned nothing (rendered as a
  // clear message, not a dropdown). Lists are cached in React state only - they
  // are never persisted, and a connection switch remounts this panel (via its
  // key), which discards them. The two status strings label the result areas so
  // an empty or permission-denied outcome is obvious.
  const [subscriptions, setSubscriptions] = useState<SubscriptionOption[] | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[] | null>(null);
  const [resourceGroups, setResourceGroups] = useState<ResourceGroupOption[] | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryStatus, setDiscoveryStatus] = useState('');
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

  // Discover button: acquire an ARM token (needs the saved secret), store it so
  // the proxy injects it as Bearer, then list subscriptions. 401/403/empty get
  // actionable messages - empty means the service principal has no access yet,
  // so point at the panel-3 role script.
  const discoverResources = useCallback(async () => {
    setDiscovering(true);
    setDiscoveryStatus('Acquiring ARM token and listing subscriptions...');
    setSubscriptions(null);
    setWorkspaces(null);
    setResourceGroups(null);
    setDependentStatus('');
    try {
      const token = await acquireArmToken(tenantId);
      // Store the token BEFORE the ARM GET so proxies.yml can inject it as Bearer
      // (the app sends no Authorization header), same as panel 5.
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
        setDiscoveryStatus(result.message);
        return;
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
        setDiscoveryStatus(
          'No subscriptions returned. The service principal has no subscription access yet - run the ' +
            'panel 3 role assignment script (it grants Reader), wait a couple of minutes for propagation, ' +
            'then Discover Azure resources again.'
        );
        return;
      }
      setDiscoveryStatus(`Discovered ${list.length} subscription(s). Choose one below.`);
      // If the already-selected subscription is among the discovered set, load its
      // dependent list now so a returning user sees the dependent dropdown at once.
      const current = subscriptionId.trim();
      if (current !== '' && list.some((s) => s.subscriptionId === current)) {
        await loadDependent(current, setupPath);
      }
    } catch (err) {
      setDiscoveryStatus(`Discovery error: ${String(err)}`);
    } finally {
      setDiscovering(false);
    }
  }, [tenantId, subscriptionId, setupPath, loadDependent]);

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
        : '  client secret: not saved - enter it below and Save client secret',
      tenant !== ''
        ? `  tenant ID: ${tenant} (remembered in this connection)`
        : '  tenant ID: not saved - enter it below (remembered per connection)',
      keysText.includes('azureArmToken')
        ? '  azureArmToken: present (encrypted) - a token has been acquired in this context'
        : '  azureArmToken: not yet acquired - run the token panel or re-check here',
    ];
    return { lines, azureBasicPresent, tenant };
  }, [tenantId]);

  // Auto-run on mount and after a save: report KV state only (no network to Azure).
  const checkStored = useCallback(async () => {
    try {
      const { lines, azureBasicPresent } = await buildKvReport();
      setStored(lines.join('\n'));
      setSecretStored(azureBasicPresent);
    } catch (err) {
      setStored(`stored-credentials check failed: ${String(err)}`);
    }
  }, [buildKvReport]);

  useEffect(() => {
    void checkStored();
  }, [checkStored]);

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
            'Permission validation skipped: save the client secret below and enter the tenant ID',
            '(it is remembered per connection). Validation acquires a token, which needs the encrypted',
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

  // Save ONLY the client secret: write the encrypted, write-only azureBasic
  // entry (base64 of clientId:clientSecret). The non-secret config fields are
  // NOT written here - App autosaves the whole profile store to azureProfiles.
  // On success, App is told which profile (and identity) the live secret now
  // belongs to, so the connection badge and identity-drift hint stay accurate.
  const saveSecret = () =>
    run(async () => {
      if (clientId === '' || clientSecret === '') {
        throw new Error('clientId and clientSecret are both required to save the client secret');
      }
      const res = await fetch(kvUrl('azureBasic?encrypted=true'), {
        method: 'PUT',
        body: btoa(`${clientId}:${clientSecret}`),
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`PUT azureBasic?encrypted=true: HTTP ${res.status}\nbody: ${text}`);
      }
      setClientSecret('');
      if (activeProfileId !== null) {
        onSecretSaved(activeProfileId, tenantId, clientId);
      }
      await checkStored();
      return `PUT azureBasic?encrypted=true: HTTP ${res.status}\nSaved for this connection. Secret input cleared.`;
    });

  return (
    <Panel
      index={4}
      title="Azure credentials"
      status={status}
      output={output}
      actionLabel="Save client secret"
      onAction={() => void saveSecret()}
    >
      <p className="panel-desc">
        The client secret is combined with the client ID as base64(clientId:clientSecret) and stored
        write-only encrypted in the app KV store (key azureBasic) when you click Save client secret. It
        is injected into outbound token requests server-side by the platform proxy and can never be
        read back or shown in the browser - if a secret is already stored the field stays blank, so
        enter a new value only to replace it. azureBasic is a single shared slot, so only one
        connection&apos;s secret is live at a time: switching connections clears it and you re-enter the
        secret for the new connection. The other fields (client ID, tenant ID, subscription, resource
        group, workspace, setup path) are non-secret configuration remembered per connection in the
        plain azureProfiles KV entry, so they need no save button and reappear on the next load.
        Credentials persist server-side per app context: the Live Preview dev app and the installed app
        have separate KV stores, so save the secret once in each context you test. Re-check and
        validate permissions reports the stored KV state and then, if credentials are present, acquires
        a token and checks the caller&apos;s EFFECTIVE Azure permissions for the setup path selected in
        panel 3 - it evaluates the actions actually allowed (via the RBAC permissions API), not role
        names, so custom or lookalike roles are handled correctly. See panel 3 for creating the app
        registration and assigning its roles.
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
      <div className="form-grid">
        <label className="field">
          <span className="field-label">Tenant ID</span>
          <input
            type="text"
            value={tenantId}
            onChange={(e) => onTenantIdChange(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span className="field-label">Client ID</span>
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
            placeholder={secretStored ? 'stored - enter a new value to replace' : ''}
          />
        </label>
      </div>
      <div className="discovery">
        <h3 className="discovery-title">Discover Azure resources</h3>
        <p className="panel-desc">
          Acquires an ARM token from the saved secret, then lists the subscriptions the service
          principal can see. Pick a subscription to load the Log Analytics workspace (existing path)
          or resource group (bring-your-own-RG lab path) - these dropdowns fill in the same
          Subscription ID and resource group fields you can also type in panel 3, so the manual
          inputs and the dropdowns stay in sync. Use the manual inputs to bootstrap before the
          service principal has Reader; use discovery once it does.
        </p>
        <div className="panel-controls">
          <button
            className="run-button"
            onClick={() => void discoverResources()}
            disabled={discovering}
          >
            Discover Azure resources
          </button>
        </div>
        {discoveryStatus !== '' && (
          <div className="discovery-result">
            <span className="field-label">Discovery result</span>
            <pre className="result">{discoveryStatus}</pre>
          </div>
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
        {setupPath === 'existing' && workspaces !== null && workspaces.length > 0 && (
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
        )}
        {setupPath === 'lab-byo-rg' && resourceGroups !== null && resourceGroups.length > 0 && (
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
        )}
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
      </div>
    </Panel>
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
      // Shared with panel 4's preflight so the token flow lives in one place.
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
        Uses the active connection&apos;s tenant ID, then POSTs grant_type=client_credentials with the
        ARM scope to login.microsoftonline.com. No Authorization header is set by the app - the
        proxy injects Basic auth from kv.azureBasic per proxies.yml. On success the access token
        is stored encrypted under azureArmToken.
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
  // write-only in panel 4 and tracked per session by liveSecretProfileId.
  const [store, setStore] = useState<ProfileStore>(EMPTY_PROFILE_STORE);
  const [hydrated, setHydrated] = useState(false);

  // Which profile's secret was last written to the single azureBasic slot THIS
  // session, plus the identity it was written under. Non-persisted: both reset to
  // null on reload (secrets are never remembered per profile across reloads).
  const [liveSecretProfileId, setLiveSecretProfileId] = useState<string | null>(null);
  const [liveSecretIdentity, setLiveSecretIdentity] = useState<LiveSecretIdentity | null>(null);

  // A transient message surfaced after a switch / clear (e.g. "enter the secret
  // for this connection"). Cleared once a secret is saved or a no-clear switch
  // happens.
  const [switchNotice, setSwitchNotice] = useState('');

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
      void (async () => {
        if (inv.clearToken) {
          try {
            await fetch(kvUrl('azureArmToken'), { method: 'DELETE' });
          } catch {
            // Best-effort clear.
          }
        }
        if (needSecretClear) {
          try {
            await fetch(kvUrl('azureBasic'), { method: 'DELETE' });
          } catch {
            // Best-effort clear.
          }
        }
      })();
      if (needSecretClear) {
        setLiveSecretProfileId(null);
        setLiveSecretIdentity(null);
        setSwitchNotice(
          'Switched connection - enter the client secret for this connection in panel 4 to authenticate.'
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
    void (async () => {
      try {
        await fetch(kvUrl('azureBasic'), { method: 'DELETE' });
      } catch {
        // Best-effort clear.
      }
      try {
        await fetch(kvUrl('azureArmToken'), { method: 'DELETE' });
      } catch {
        // Best-effort clear.
      }
    })();
    setLiveSecretProfileId(null);
    setLiveSecretIdentity(null);
    setSwitchNotice('Stored secret cleared - re-enter the client secret in panel 4 to re-authenticate.');
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

  if (!hydrated) {
    return (
      <div className="harness">
        <header className="harness-header">
          <h1 className="harness-title">Phase 1 Spike Harness</h1>
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

  return (
    <div className="harness">
      <header className="harness-header">
        <h1 className="harness-title">Phase 1 Spike Harness</h1>
        <p className="harness-subtitle">
          Sequential diagnostics for the Cribl App Platform: globals, KV store semantics,
          proxy header injection, Azure AD token flow, ARM access, and iframe download behavior.
          Pick or create a connection above, then run the panels top to bottom.
        </p>
      </header>

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
        </div>
        {switchNotice !== '' && <p className="connection-notice">{switchNotice}</p>}
        {identityDrifted && (
          <p className="connection-hint">
            identity changed - the stored secret was saved under a different tenant/client id. Use
            Clear stored secret and re-enter the secret for this identity.
          </p>
        )}
      </div>

      <PlatformGlobalsPanel />
      <KvStorePanel />
      <AppRegistrationPanel
        clientId={activeConfig.clientId}
        onClientIdChange={(v) => updateField({ clientId: v })}
        setupPath={activeConfig.setupPath}
        onSetupPathChange={(v) => updateField({ setupPath: v })}
        subscriptionId={activeConfig.subscriptionId}
        onSubscriptionIdChange={(v) => updateField({ subscriptionId: v })}
        rgName={activeConfig.resourceGroup}
        onRgNameChange={(v) => updateField({ resourceGroup: v })}
      />
      <AzureCredentialsPanel
        key={store.activeProfileId ?? 'none'}
        activeProfileId={store.activeProfileId}
        onSecretSaved={handleSecretSaved}
        clientId={activeConfig.clientId}
        onClientIdChange={(v) => updateField({ clientId: v })}
        tenantId={activeConfig.tenantId}
        onTenantIdChange={(v) => updateField({ tenantId: v })}
        setupPath={activeConfig.setupPath}
        subscriptionId={activeConfig.subscriptionId}
        onSubscriptionIdChange={(v) => updateField({ subscriptionId: v })}
        rgName={activeConfig.resourceGroup}
        onRgNameChange={(v) => updateField({ resourceGroup: v })}
        workspaceName={activeConfig.workspaceName}
        onWorkspaceNameChange={(v) => updateField({ workspaceName: v })}
      />
      <TokenAcquisitionPanel tenantId={activeConfig.tenantId} />
      <ArmCallPanel />
      <ArtifactDownloadPanel />
    </div>
  );
}

export default App;
