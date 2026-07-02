import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

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

// Panel 3: store Azure app registration credentials in the app KV store. The
// Basic value (base64 of clientId:clientSecret) is written encrypted and is
// only ever resolved server-side by proxies.yml header injection.
function AzureCredentialsPanel() {
  const [tenantId, setTenantId] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [stored, setStored] = useState('checking stored credentials...');
  const [status, output, run] = useRunner();

  // Report what already exists in THIS app context's KV store. The store is
  // scoped per app ID: Live Preview (__dev__ prefix) and the installed app
  // have separate stores, so credentials saved in one are absent in the other.
  const checkStored = useCallback(async () => {
    try {
      const keysRes = await fetch(`${window.CRIBL_API_URL}/kvstore/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix: 'azure' }),
      });
      const keysText = await keysRes.text();
      const tenantRes = await fetch(kvUrl('azureTenantId'));
      const tenant = tenantRes.ok ? (await tenantRes.text()).trim() : '';
      setStored(
        [
          `Stored in KV for app ID ${window.CRIBL_APP_ID ?? '(unknown)'}:`,
          keysText.includes('azureBasic')
            ? '  azureBasic: present (encrypted, not readable back)'
            : '  azureBasic: MISSING - save credentials below',
          tenant !== '' ? `  azureTenantId: ${tenant}` : '  azureTenantId: MISSING - save credentials below',
          keysText.includes('azureArmToken')
            ? '  azureArmToken: present (encrypted) - panel 4 has run in this context'
            : '  azureArmToken: not yet acquired - run panel 4',
        ].join('\n')
      );
    } catch (err) {
      setStored(`stored-credentials check failed: ${String(err)}`);
    }
  }, []);

  useEffect(() => {
    void checkStored();
  }, [checkStored]);

  const save = () =>
    run(async () => {
      if (tenantId === '' || clientId === '' || clientSecret === '') {
        throw new Error('tenantId, clientId, and clientSecret are all required');
      }
      const lines: string[] = [];
      const put = async (label: string, key: string, body: string) => {
        const res = await fetch(kvUrl(key), { method: 'PUT', body });
        const text = await res.text();
        lines.push(`${label}: HTTP ${res.status}`);
        if (!res.ok) {
          throw new Error([...lines, `body: ${text}`].join('\n'));
        }
      };
      await put('PUT azureBasic?encrypted=true', 'azureBasic?encrypted=true', btoa(`${clientId}:${clientSecret}`));
      await put('PUT azureTenantId', 'azureTenantId', tenantId);
      setClientSecret('');
      await checkStored();
      return [...lines, 'Saved. Secret input cleared.'].join('\n');
    });

  return (
    <Panel
      index={3}
      title="Azure credentials"
      status={status}
      output={output}
      actionLabel="Save credentials"
      onAction={() => void save()}
    >
      <p className="panel-desc">
        The client secret is combined with the client ID as base64(clientId:clientSecret) and stored
        write-only encrypted in the app KV store (key azureBasic). It is injected into outbound token
        requests server-side by the platform proxy and can never be read back by the browser.
        The tenant ID is stored as a plain KV entry (key azureTenantId).
        Credentials persist server-side per app context: the Live Preview dev app and the
        installed app have separate KV stores, so save once in each context you test.
      </p>
      <p className="panel-desc">
        App registration setup: in Entra ID, create the registration under App registrations
        (New registration), add a client secret under Certificates and secrets, then assign
        these Azure roles to the service principal:
      </p>
      <ul className="perm-list">
        <li>
          Core onboarding (panels 4-5, DCR deployment): Monitoring Contributor and Log Analytics
          Contributor on the target workspace resource group, plus Reader on the subscription.
        </li>
        <li>
          Lab provisioning (create-new-RG mode): <strong>Contributor at the subscription scope</strong>{' '}
          and <strong>RBAC Administrator at the subscription scope</strong>. Resource group creation
          is a subscription-level action, and the lab TTL self-destruct assigns its delete role at
          deploy time.
        </li>
        <li>
          Least-privilege alternative for labs: bring-your-own-RG mode needs only Contributor on an
          admin-pre-created lab resource group.
        </li>
      </ul>
      <pre className="result">{stored}</pre>
      <div className="panel-controls">
        <button className="run-button" onClick={() => void checkStored()}>
          Re-check stored
        </button>
      </div>
      <div className="form-grid">
        <label className="field">
          <span className="field-label">Tenant ID</span>
          <input
            type="text"
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span className="field-label">Client ID</span>
          <input
            type="text"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
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
      const tenantRes = await fetch(kvUrl('azureTenantId'));
      const tenant = (await tenantRes.text()).trim();
      if (!tenantRes.ok || tenant === '') {
        throw new Error(
          `GET azureTenantId: HTTP ${tenantRes.status} body=${JSON.stringify(tenant)} - save credentials in panel 3 first`
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
      const putRes = await fetch(kvUrl('azureArmToken?encrypted=true'), {
        method: 'PUT',
        body: token.access_token,
      });
      const lines = [
        `token endpoint: HTTP ${res.status}`,
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
      index={4}
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
      index={5}
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
      index={6}
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
      <AzureCredentialsPanel />
      <TokenAcquisitionPanel />
      <ArmCallPanel />
      <ArtifactDownloadPanel />
    </div>
  );
}

export default App;
