import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  allGranted,
  EMPTY_AZURE_CONFIG,
  evaluatePermissions,
  parseAzureConfig,
  REQUIRED_ACTIONS,
  serializeAzureConfig,
} from '@soc/core';
import type { AzureConfig, PermissionsResponse, RequiredAction } from '@soc/core';

// Phase 1 spike harness: six sequential diagnostics panels that exercise the
// Cribl App Platform surface (globals, KV store, proxy header injection,
// Azure AD token flow, ARM calls, iframe download behavior). Each panel runs
// independently and reports raw response details for the spike log.

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

// Load the persisted non-secret config from the single plain KV key 'azureConfig'
// and normalize it through the pure @soc/core codec. Tolerant: a missing key, a
// non-ok response, a network error, or an unparseable body all yield
// EMPTY_AZURE_CONFIG. The client secret is NEVER carried here - it lives only in
// the encrypted, write-only azureBasic entry and is never read back.
async function loadAzureConfig(): Promise<AzureConfig> {
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

// Reads the tenant ID from the persisted azureConfig KV entry and runs the
// client_credentials/ARM-scope token request. The app sets no Authorization
// header: proxies.yml injects Basic ${kv.azureBasic} server-side. Returns the
// parsed token (access_token plus type/expiry) so both the credentials
// preflight (panel 4) and the token panel (panel 5) share one implementation.
async function acquireArmToken(): Promise<ArmTokenResult> {
  const tenant = (await loadAzureConfig()).tenantId.trim();
  if (tenant === '') {
    throw new Error(
      'azureConfig has no tenant ID - enter the tenant ID in panel 4 (it is remembered automatically), then retry'
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

// Panel 4: store Azure app registration credentials in the app KV store. The
// Basic value (base64 of clientId:clientSecret) is written encrypted and is
// only ever resolved server-side by proxies.yml header injection. The re-check
// action also runs the permission preflight for the selected setup path.
interface AzureCredentialsPanelProps {
  clientId: string;
  onClientIdChange: (value: string) => void;
  tenantId: string;
  onTenantIdChange: (value: string) => void;
  setupPath: SetupPath;
  subscriptionId: string;
  rgName: string;
}

function AzureCredentialsPanel({
  clientId,
  onClientIdChange,
  tenantId,
  onTenantIdChange,
  setupPath,
  subscriptionId,
  rgName,
}: AzureCredentialsPanelProps) {
  const [clientSecret, setClientSecret] = useState('');
  const [stored, setStored] = useState('checking stored credentials...');
  const [secretStored, setSecretStored] = useState(false);
  const [validating, setValidating] = useState(false);
  const [status, output, run] = useRunner();

  // Report what already exists in THIS app context's KV store. The store is
  // scoped per app ID: Live Preview (__dev__ prefix) and the installed app
  // have separate stores, so credentials saved in one are absent in the other.
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
    const config = await loadAzureConfig();
    const tenant = config.tenantId.trim();
    const azureBasicPresent = keysText.includes('azureBasic');
    const lines = [
      `Stored in KV for app ID ${window.CRIBL_APP_ID ?? '(unknown)'}:`,
      azureBasicPresent
        ? '  client secret: stored (encrypted, not shown)'
        : '  client secret: not saved - enter it below and Save client secret',
      tenant !== ''
        ? `  tenant ID: ${tenant} (remembered in azureConfig)`
        : '  tenant ID: not saved - enter it below (remembered automatically)',
      keysText.includes('azureArmToken')
        ? '  azureArmToken: present (encrypted) - a token has been acquired in this context'
        : '  azureArmToken: not yet acquired - run the token panel or re-check here',
    ];
    return { lines, azureBasicPresent, tenant };
  }, []);

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
            '(it is remembered automatically). Validation acquires a token, which needs the encrypted',
            'azureBasic entry plus a tenant ID persisted in azureConfig.',
          ].join('\n')
        );
        return;
      }
      setStored([...baseLines, '', 'Permission validation: acquiring token and querying scopes...'].join('\n'));
      const validationLines: string[] = [];
      try {
        const token = await acquireArmToken();
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
  }, [buildKvReport, setupPath, subscriptionId, rgName]);

  // Save ONLY the client secret: write the encrypted, write-only azureBasic
  // entry (base64 of clientId:clientSecret). The non-secret config fields
  // (client ID, tenant ID, subscription, resource group, setup path) are NOT
  // written here - App autosaves them to the plain azureConfig entry.
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
      await checkStored();
      return `PUT azureBasic?encrypted=true: HTTP ${res.status}\nSaved. Secret input cleared.`;
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
        enter a new value only to replace it. The other fields (client ID, tenant ID, subscription,
        resource group, setup path) are non-secret configuration and are remembered automatically in
        the plain azureConfig KV entry, so they need no save button and reappear on the next load.
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
    </Panel>
  );
}

// Panel 4: client_credentials token flow. The app never sets Authorization;
// proxies.yml injects Basic ${kv.azureBasic} server-side (the proxy strips
// any Authorization header the client sends).
function TokenAcquisitionPanel() {
  const [status, output, run] = useRunner();
  const acquire = () =>
    run(async () => {
      // Shared with panel 4's preflight so the token flow lives in one place.
      const token = await acquireArmToken();
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
        Reads the tenant ID from the KV store, then POSTs grant_type=client_credentials with the
        ARM scope to login.microsoftonline.com. No Authorization header is set by the app - the
        proxy injects Basic auth from kv.azureBasic per proxies.yml. On success the access token
        is stored encrypted under azureArmToken.
      </p>
    </Panel>
  );
}

// Panel 5: ARM subscriptions list. Bearer token is injected server-side from
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

// Panel 6: does the sandboxed iframe allow programmatic downloads? The only
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

function App() {
  // Shared between the app registration panel (az script) and the credentials
  // panel (secret save + permission preflight). These five non-secret fields ARE
  // the AzureConfig: they are hydrated from, and debounce-autosaved to, the
  // single plain 'azureConfig' KV entry. The client secret is never part of this
  // state - it is handled write-only in panel 4.
  const [clientId, setClientId] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [setupPath, setSetupPath] = useState<SetupPath>('existing');
  const [subscriptionId, setSubscriptionId] = useState('');
  const [rgName, setRgName] = useState('');
  // Gates the autosave effect: no write happens until the persisted config has
  // been loaded, so the initial empty state can never clobber stored values.
  const [hydrated, setHydrated] = useState(false);
  // The config we know is already persisted (serialized). Initialized when
  // hydration completes so the just-loaded values are never redundantly written.
  const lastPersistedRef = useRef<string | null>(null);

  // Hydrate the non-secret config once on mount. The client secret is never
  // loaded (it is write-only); only these five fields are restored.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const config = await loadAzureConfig();
      if (cancelled) {
        return;
      }
      setClientId(config.clientId);
      setTenantId(config.tenantId);
      setSubscriptionId(config.subscriptionId);
      setRgName(config.resourceGroup);
      setSetupPath(config.setupPath);
      lastPersistedRef.current = serializeAzureConfig(config);
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced autosave. Inert until hydrated. Once hydrated, if the current
  // config differs from what is persisted, wait ~800ms then PUT the plain
  // azureConfig entry and record it. The timeout is cleared on every change and
  // on unmount, so only a settled edit is written and no redundant write of the
  // just-hydrated values occurs.
  useEffect(() => {
    if (!hydrated) {
      return;
    }
    const current = serializeAzureConfig({
      clientId,
      tenantId,
      subscriptionId,
      resourceGroup: rgName,
      setupPath,
    });
    if (current === lastPersistedRef.current) {
      return;
    }
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(kvUrl('azureConfig'), { method: 'PUT', body: current });
          if (res.ok) {
            lastPersistedRef.current = current;
          }
        } catch {
          // Best-effort autosave; the next edit retries.
        }
      })();
    }, 800);
    return () => clearTimeout(timer);
  }, [hydrated, clientId, tenantId, subscriptionId, rgName, setupPath]);

  return (
    <div className="harness">
      <header className="harness-header">
        <h1 className="harness-title">Phase 1 Spike Harness</h1>
        <p className="harness-subtitle">
          Sequential diagnostics for the Cribl App Platform: globals, KV store semantics,
          proxy header injection, Azure AD token flow, ARM access, and iframe download behavior.
          Run the panels top to bottom.
        </p>
      </header>
      <PlatformGlobalsPanel />
      <KvStorePanel />
      <AppRegistrationPanel
        clientId={clientId}
        onClientIdChange={setClientId}
        setupPath={setupPath}
        onSetupPathChange={setSetupPath}
        subscriptionId={subscriptionId}
        onSubscriptionIdChange={setSubscriptionId}
        rgName={rgName}
        onRgNameChange={setRgName}
      />
      <AzureCredentialsPanel
        clientId={clientId}
        onClientIdChange={setClientId}
        tenantId={tenantId}
        onTenantIdChange={setTenantId}
        setupPath={setupPath}
        subscriptionId={subscriptionId}
        rgName={rgName}
      />
      <TokenAcquisitionPanel />
      <ArmCallPanel />
      <ArtifactDownloadPanel />
    </div>
  );
}

export default App;
