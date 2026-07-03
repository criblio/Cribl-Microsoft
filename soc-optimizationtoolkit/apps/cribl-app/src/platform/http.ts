// Platform HTTP helpers for the Cribl App Platform cloud shell: the proven
// primitives extracted verbatim from the Phase 1 spike harness (App.tsx).
// This module is the SINGLE source of truth for talking through the
// platform's locked fetch bridge - both the harness panels and the port
// adapters (adapters.ts) build on these helpers.
//
// Platform findings baked in (verified live against the real platform):
// - The locked fetch bridge IGNORES AbortSignal, so every client-side timeout
//   must Promise.race against a timer (fetchWithTimeout); an in-flight bridged
//   request cannot be cancelled.
// - KV DELETE is processed server-side but its response is LOST by the
//   bridge, so kvDelete races a short timeout and treats a timeout as
//   success. Never sequence follow-up work on a DELETE response.
// - Encrypted KV entries are WRITE-ONLY: GET returns HTTP 403
//   {"message":"Cannot read encrypted value"}, not the redacted placeholder
//   the platform docs describe. A stored secret can never be read back.
// - The app NEVER sets an Authorization header on Azure calls: proxies.yml
//   injects Basic (kv.azureBasic) on login.microsoftonline.com and Bearer
//   (kv.azureArmToken) on management.azure.com server-side.

export function kvUrl(key: string): string {
  return `${window.CRIBL_API_URL}/kvstore/${key}`;
}

// KV DELETE with the platform quirk handled: the bridge processes the delete
// server-side but has been observed to never return the response (verified
// live 2026-07-02 - keys are gone despite the timeout). Fire with a short
// race-timeout and treat a timeout as success. Callers must never sequence
// follow-up work on this response - fire deletes independently.
export async function kvDelete(key: string): Promise<void> {
  try {
    await fetchWithTimeout(kvUrl(key), { method: 'DELETE' }, 5000);
  } catch {
    // Best-effort by design: the delete is processed even when the bridge
    // loses the response.
  }
}

// fetch with a hard client-side timeout. Platform-bridged requests (KV store,
// product API) are proxied through the parent Cribl window; if that bridge is
// detached (typically after a dev-mode hot reload), the promise never settles
// and there is no platform timeout to save us - so every harness call that
// could hang must go through this wrapper and fail loudly instead.
export async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = 15000
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new Error(
          `timed out after ${timeoutMs / 1000}s - the platform bridge did not respond ` +
            '(and its fetch implementation ignores abort signals, so the underlying ' +
            'request may still be pending). If everything times out, reload the whole ' +
            'Cribl browser page; if only specific verbs time out, that is a platform finding.'
        )
      );
    }, timeoutMs);
  });
  // Promise.race, NOT AbortController alone: the platform's locked fetch bridge
  // has been observed to ignore the abort signal, leaving the fetch promise
  // pending forever. The race settles on our timer regardless. The no-op catch
  // keeps an eventual late rejection of the losing fetch from surfacing as an
  // unhandled rejection.
  const request = fetch(url, { ...init, signal: controller.signal });
  request.catch(() => undefined);
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Parsed subset of the Azure AD token endpoint response the harness consumes.
export interface ArmTokenResult {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

// Run the client_credentials/ARM-scope token request for the given tenant. The
// app sets no Authorization header: proxies.yml injects Basic ${kv.azureBasic}
// server-side (the active connection's secret). Returns the parsed token so the
// connect action (panel 3), resource discovery and the permission preflight
// (panel 4), and the token panel (panel 5) share one implementation. The tenant
// comes from the ACTIVE connection's config.
//
// This is a proxied EXTERNAL request (login.microsoftonline.com through the
// platform proxy): the proxy enforces a 30s server-side timeout, and like all
// bridged fetches it can hang forever if the bridge is detached - so it rides
// fetchWithTimeout at 25s, keeping the client-side failure loud and ahead of
// the platform's.
export async function acquireArmToken(tenantId: string): Promise<ArmTokenResult> {
  const tenant = tenantId.trim();
  if (tenant === '') {
    throw new Error(
      'The active connection has no tenant ID - enter the tenant ID in panel 3 (it is remembered per connection), then retry'
    );
  }
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: 'https://management.azure.com/.default',
  });
  const res = await fetchWithTimeout(
    `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    },
    25000
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
