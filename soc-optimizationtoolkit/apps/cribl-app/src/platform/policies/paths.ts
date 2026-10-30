// paths.ts - EVERY Cribl product API call this app makes, in one registry.
//
// Started from the cribl-app-kit template (skills/cribl-app-kit/reference/policies/paths.ts),
// which is a template and not a copy: this list is the app's own.
//
// Rules (claude-kit standards/cribl-app-permissions.md, "Declare"):
// - Policy grammar only: literals and `:name` segments. A call made in a worker
//   group context (CriblRequest.groupId set) is written `/m/:gid/...`; a leader
//   call is written as sent.
// - Change this file IN THE SAME COMMIT as the call that needs it, with `caller`
//   naming the module. policies-coverage.test.ts compares this list with
//   config/policies.yml in both directions, and request-scan.test.ts fails when
//   a `.request({ path: ... })` call site in the source has no entry here.
// - App-scoped paths (/kvstore, /proxy) are NOT listed: they are granted with the app.
// - The request scan cannot see a call whose path is built elsewhere (a request
//   builder, a constant, a capability probe table) - those entries are kept
//   honest by review, and their `caller` names the module that builds them.

import type { ApiCall } from './policyCoverage';

const ONBOARD = 'core usecases/onboard-table/onboard-table.ts';
const WIRE = 'core usecases/guided-deploy/wire-source.ts';
const FLOWLOG = 'core usecases/provision-lab/deploy-flowlog-pack.ts';
const LIVE_ARCH = 'core usecases/live-architecture/fetch-live-architecture.ts';
const PREFLIGHT = 'core usecases/permission-preflight/permission-preflight.ts (CRIBL_CAPABILITY_PROBES)';
const PACK_INSTALL = 'app platform/adapters.ts PlatformPackInstall';
const WIRING_UI = 'ui screens/integrate/wiring-section.tsx';
const ENSURE_SECRET = 'core usecases/ensure-secret/ensure-text-secret.ts (DBT-152)';
const CREATE_SOURCE = 'core usecases/create-cribl-source (AZR-34)';
const KIT_COMMIT = 'core kit/config-writes/commitDeploy.ts via create-cribl-source (AZR-34)';
const LAKE_QUERY = 'core usecases/query-lake-samples/query-lake-samples.ts';

export const API_CALLS: readonly ApiCall[] = [
  // ---- Leader level ------------------------------------------------------
  { method: 'GET', path: '/master/groups', caller: 'app platform/adapters.ts PlatformCriblClient.listGroups' },
  // The kit's deployedVersion falls back here on a 404 from /products (AZR-34).
  { method: 'GET', path: '/master/groups/:id', caller: KIT_COMMIT },
  { method: 'GET', path: '/master/workers', caller: 'core usecases/live-architecture/fetch-edge-fleets.ts' },
  { method: 'PATCH', path: '/master/groups/:id/deploy', caller: `${ONBOARD}; ${WIRE}; ${FLOWLOG}; ${KIT_COMMIT} (404 fallback)` },
  { method: 'PATCH', path: '/products/stream/groups/:id/deploy', caller: KIT_COMMIT },
  { method: 'GET', path: '/products/stream/groups/:id', caller: `${KIT_COMMIT} (deployedVersion)` },
  { method: 'POST', path: '/system/lake/datasets', caller: WIRE },
  { method: 'GET', path: '/products/lake/lakes/:lakeId/datasets', caller: 'core usecases/discover-sample-sources/discover-sample-sources.ts' },

  // ---- Worker group context ---------------------------------------------
  { method: 'GET', path: '/m/:gid/system/outputs', caller: `${ONBOARD}; ${LIVE_ARCH}; ${PREFLIGHT}; ui screens/integrate/integrate-screen.tsx (routable check; GEN-21 existing Sentinel destination picker, parsed by core domain/sentinel-destination/existing-outputs.ts)` },
  { method: 'POST', path: '/m/:gid/system/outputs', caller: ONBOARD },
  { method: 'GET', path: '/m/:gid/system/outputs/:id', caller: `${ONBOARD} (verify step)` },
  { method: 'GET', path: '/m/:gid/system/inputs', caller: `${LIVE_ARCH}; ${PREFLIGHT}; discover-sample-sources.ts; ${CREATE_SOURCE}; read-source-flow/read-onboarding-cribl-side.ts` },
  { method: 'POST', path: '/m/:gid/system/inputs', caller: `${CREATE_SOURCE} apply-cribl-source.ts` },
  { method: 'GET', path: '/m/:gid/system/inputs/:id', caller: `${CREATE_SOURCE} (kit verifyStored); ui screens/integrate/integrate-screen.tsx (GEN-21 QuickConnect check, parsed by existing-destination-state.ts sourceRouting)` },
  { method: 'GET', path: '/m/:gid/pipelines', caller: LIVE_ARCH },
  { method: 'GET', path: '/m/:gid/lib/breakers', caller: LIVE_ARCH },
  { method: 'GET', path: '/m/:gid/jobs', caller: LIVE_ARCH },
  { method: 'GET', path: '/m/:gid/p/:pack/system/inputs', caller: LIVE_ARCH },
  { method: 'GET', path: '/m/:gid/p/:pack/system/outputs', caller: LIVE_ARCH },
  { method: 'GET', path: '/m/:gid/p/:pack/routes', caller: LIVE_ARCH },
  { method: 'GET', path: '/m/:gid/p/:pack/pipelines', caller: LIVE_ARCH },
  { method: 'POST', path: '/m/:gid/version/commit', caller: `${ONBOARD}; ${WIRE}; ${FLOWLOG}; ${KIT_COMMIT}` },
  { method: 'GET', path: '/m/:gid/version/status', caller: KIT_COMMIT },
  { method: 'GET', path: '/m/:gid/version', caller: `${KIT_COMMIT} (HEAD, ?offset=0&limit=1)` },
  { method: 'GET', path: '/m/:gid/packs', caller: `${PACK_INSTALL}.listDeployed; ${LIVE_ARCH}; ${PREFLIGHT}` },
  // The binary .crbl upload: a raw fetchWithTimeout in the adapter, because the
  // JSON CriblClient cannot carry an octet-stream body.
  { method: 'PUT', path: '/m/:gid/packs', caller: `${PACK_INSTALL}.install (raw fetch, ?filename=)` },
  { method: 'POST', path: '/m/:gid/packs', caller: `${PACK_INSTALL}.install` },
  { method: 'PATCH', path: '/m/:gid/packs/:id', caller: `${PACK_INSTALL}.install (upgradePack)` },
  { method: 'DELETE', path: '/m/:gid/packs/:id', caller: `${PACK_INSTALL}.install (deletePack)` },
  { method: 'GET', path: '/m/:gid/routes', caller: `${WIRE}; ${LIVE_ARCH}; ${PREFLIGHT}; read-source-flow/read-onboarding-cribl-side.ts` },
  { method: 'PUT', path: '/m/:gid/routes', caller: WIRE },
  { method: 'POST', path: '/m/:gid/system/secrets', caller: `${ENSURE_SECRET} for ${WIRING_UI} and ${FLOWLOG}; ${CREATE_SOURCE} apply-cribl-source.ts; ${ONBOARD} (destination client secret, create-only, DBT-155)` },
  { method: 'PATCH', path: '/m/:gid/system/secrets/:id', caller: `${ENSURE_SECRET} (on 409, only a secret carrying our stamp) for ${WIRING_UI} and ${FLOWLOG}` },
  { method: 'GET', path: '/m/:gid/system/secrets/:id', caller: `${CREATE_SOURCE} plan-cribl-source.ts; ${ENSURE_SECRET} (who owns the secret a 409 named)` },
  { method: 'POST', path: '/m/:gid/system/capture', caller: 'core usecases/capture-samples/capture-samples.ts' },
  { method: 'POST', path: '/m/:gid/system/metrics/query', caller: 'core usecases/read-source-flow/read-source-flow.ts via kit metricsQuery (AZR-33)' },
  // Search is group-scoped under the SEARCH group, whose id is resolved from
  // /master/groups (not a constant), so it is `:gid`, not a literal.
  { method: 'POST', path: '/m/:gid/search/jobs', caller: LAKE_QUERY },
  { method: 'GET', path: '/m/:gid/search/jobs/:id/status', caller: LAKE_QUERY },
  { method: 'GET', path: '/m/:gid/search/jobs/:id/results', caller: LAKE_QUERY },
];
