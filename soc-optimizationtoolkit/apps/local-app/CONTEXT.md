# CONTEXT: @soc/local-app

Purpose: the local deployment target for customer-managed (on-prem) Cribl - a Node host that serves the shared UI in a browser and fulfills the same @soc/core port contracts the cloud platform provides to cribl-app. Launched from source (EDR-friendly, per the repo's established launcher pattern).

## Status

Host implemented (src/host/, plain ESM .mjs with JSDoc types, ZERO runtime dependencies - node builtins and global fetch only). Web side implemented too: src/web/ is a Vite+React entry (main.tsx -> local-app.tsx) that imports "@soc/ui/styles.css" plus local.css chrome, fetches the non-secret /api/config (leader URL + AzureConfig summary), and renders the shared OnboardTableScreen inside PortsProvider bound to the six local adapters in src/web/local-adapters.ts (AzureManagement -> POST /api/azure/request, CriblClient -> /api/cribl/*, SecretsStore -> /api/secrets* with write-only encrypted parity, JobStore -> /api/jobs*, UserContext -> /api/user, ArtifactSink -> Blob+anchor download; all requests ride a race-based fetchWithTimeout for cross-shell consistency). Build: "npm run build" (tsc -b && vite build) emits dist/web, which the host serves at "/"; "npm run dev" proxies /api to http://127.0.0.1:4600; the root "npm run local" builds then starts the host.

## What the host provides

- Config: config/local-config.json (gitignored; copy config/local-config.example.json). Validated at startup with actionable per-field errors. Holds the Azure service principal (including clientSecret) and the Cribl leader URL + static bearer token.
- GET /api/config: the NON-secret Azure fields (AzureConfig shape, setupPath "existing") plus criblLeaderUrl for display. Secrets never appear on any HTTP response.
- POST /api/azure/request: ARM proxy. The host acquires and caches the client_credentials token (refresh ~5 min before expiry; on upstream 401 re-acquire once and retry once) and returns the upstream {status, body} verbatim - twin of the cloud shell's PlatformAzureManagement.
- POST /api/cribl/request and GET /api/cribl/groups: leader proxy with Authorization: Bearer {authToken}; groups mapping mirrors the cloud adapter's tolerant shape-handling. cribl.rejectUnauthorized=false (self-signed on-prem leaders) applies via an https.Agent to leader calls ONLY.
- Secrets (data/secrets.json, 0600 best effort): PUT/GET/DELETE /api/secrets/{key}, POST /api/secrets-list. Values stored with { encrypted: true } are WRITE-ONLY through the API - GET returns { value: null }, exactly like the cloud KV's unreadable encrypted entries (SECURITY POSTURE PARITY).
- Jobs (data/jobs.json): POST/GET /api/jobs, GET/PATCH /api/jobs/{id}. Same contract as the cloud PlatformJobStore: store-managed id/createdAt, patch-wins shallow merge, updatedAt refreshed, newest-first listing. Atomic-ish writes (temp file + rename).
- GET /api/user: { id, username } from the OS account (node:os userInfo).
- Static serving of dist/web with index.html fallback for client routing; friendly "run the build" page when the build output is missing.

Every upstream request (Azure token, ARM, leader) is bounded by an ~30s AbortController timeout. Node's fetch honors AbortSignal - the ignore-abort quirk that forces Promise.race timeouts exists only in the Cribl platform's locked fetch bridge on the cloud side.

## Security posture

- Binds 127.0.0.1 only. There is NO API auth: this is a single-operator localhost tool and the loopback interface is the boundary. Do not port-forward or reverse-proxy it.
- The Azure client secret is read ONLY from config/local-config.json and used server-side for token acquisition; it is never exposed over HTTP. Same for the Cribl authToken.
- Encrypted-marked secrets are unreadable through the browser-facing API (write-only parity with the cloud KV).

## Deliberately deferred

- Leader login flow (username/password or OAuth to mint tokens): the token is static per the Phase 1 roadmap; expired tokens surface as leader 401s in {status, body}.
- Encryption at rest for data/secrets.json: the encrypted marker enforces API write-only semantics, but the file itself is plaintext on disk (0600 best effort; mode bits are advisory on Windows). data/ is gitignored.
- API auth on the loopback listener (documented above as out of scope for a single-operator tool).
- First-run onboarding GUI covering both targets, drift-check job scheduling, outbound domain allowlist enforcement (mirror of cloud proxies.yml discipline) - these arrive with the web UI and later phases.

Advantages over the cloud target (capability superset): private network reach, no 30s/100rpm proxy limits, scheduling, can run inside air-gapped networks beside a local leader.
