/**
 * capability-mapping - projecting a {@link PermissionReport} onto the capability
 * model (domain/capabilities, docs/capability-model-plan.md).
 *
 * This is the seam deliberately left open when the capability domain shipped:
 * the domain is pure and knows nothing about how a verdict was measured, and the
 * preflight already measures exactly the right things, so all that was missing
 * was the projection between them. It lives HERE rather than in
 * domain/capabilities because the dependency only points one way - usecases may
 * import domain, never the reverse.
 *
 * THREE RULES DECIDE EVERY VERDICT, and they are the whole design:
 *
 * 1. WRITES COME FROM EFFECTIVE ACTIONS, NEVER FROM A PROBE. Writes cannot be
 *    probed non-destructively, so the RBAC permissions API is the only sound
 *    source. No probe in the report grants a write capability, and none ever
 *    should - that is the "a Reader passes every probe yet is not deployable"
 *    pin, restated in capability terms.
 *
 * 2. READS COME FROM PROBES FIRST. A no-op GET that returned 2xx is direct
 *    evidence the read works, and an explicit 401/403 is direct evidence it does
 *    not; both outrank the RBAC evaluation for the same capability. The effective
 *    action is the fallback when the probe could not complete.
 *
 * 3. ONLY MEASUREMENTS ARE RECORDED. Anything unmeasured is OMITTED from the
 *    verdict map so the domain resolves it from connection context as `unknown`
 *    or `unreachable`. This is load-bearing and is the one place the projection
 *    could easily go wrong: when the permissions API cannot be read the preflight
 *    fills `checks` with granted:false, which is the correct CONSERVATIVE stance
 *    for its own deploy gate but is NOT a permission measurement. Copying it
 *    across as `denied` would make the capability model claim a fact it never
 *    established, breaking the domain's pin that denied is only ever measured.
 *    Hence the `permissionsFetched` guard below.
 *
 * Pure: no IO, no clock. `auditedAt` and the connection identity are supplied by
 * the caller, exactly as CapabilitySet requires.
 */

import type {
  AzureCapability,
  Capability,
  CapabilitySet,
  CapabilityVerdict,
  CriblCapability,
} from "../../domain/capabilities";
import type { PermissionCheckResult, SetupPath } from "../../domain/azure-permissions";
import { operationAction } from "../../domain/least-privilege";
import {
  DEFENDER_AUTOMATIONS_READ,
  DEFENDER_AUTOMATIONS_WRITE,
  DEFENDER_PRICINGS_READ,
} from "../../domain/defender-export/defender-permissions";
import {
  MANAGED_IDENTITY_WRITE,
  POLICY_ASSIGNMENTS_WRITE,
  POLICY_REMEDIATIONS_WRITE,
} from "../../domain/capability-enablers";
import type { GraphPermissionProbe, GraphProbeResponse } from "../../ports/graph-directory";
import type { AzurePreflight, CriblPreflight, PermissionReport } from "./permission-preflight";
import { checkedAzureActions, criblProbeGrantsManage } from "./permission-preflight";
import { is2xx, prop } from "../arm-http";

// ---------------------------------------------------------------------------
// Mapping tables (exported as DATA)
// ---------------------------------------------------------------------------

/**
 * Azure control-plane action -> the capability it establishes.
 *
 * Keys are the exact action strings in REQUIRED_ACTIONS, read from the
 * least-privilege registry (AZR-61) so a corrected action cannot silently stop
 * establishing its capability. Two of those actions
 * are deliberately ABSENT: `Microsoft.Resources/subscriptions/resourceGroups/write`
 * and `Microsoft.OperationalInsights/workspaces/write` are lab-provisioning
 * concerns with no capability in the settled taxonomy, and inventing one here
 * would widen a model the plan closed. An unmapped action is simply not a
 * capability signal - it is never an error.
 *
 * The three Defender keys (CAP-7a) are imported from the Defender domain, so
 * the action this table maps is the action REQUIRED_ACTIONS checks by
 * construction. They appear only on `existing-subscription`, so only an audit
 * of that path records them; every other path leaves them unmeasured.
 */
export const AZURE_ACTION_CAPABILITIES: Readonly<Record<string, AzureCapability>> =
  Object.freeze({
    [operationAction("dcr.write")]: "dcr.write",
    [operationAction("dcr.read")]: "dcr.read",
    [operationAction("table.write")]: "table.write",
    [operationAction("workspace.read")]: "workspace.read",
    // Not a registry action: nothing calls it (audit discrepancy 5); kept
    // until arm.deploy is measured some other way (REQUIRED_ACTIONS header).
    "Microsoft.Resources/deployments/write": "arm.deploy",
    [operationAction("dcr.roleAssignment.write")]: "role.assign",
    [DEFENDER_PRICINGS_READ]: "defender-plans.read",
    [DEFENDER_AUTOMATIONS_READ]: "defender-automation.read",
    [DEFENDER_AUTOMATIONS_WRITE]: "defender-automation.write",
    // AZR-85 review: Enable Sentinel's solution PUT, at the resource group.
    [operationAction("sentinel.solution.write")]: "sentinel.enable",
    // CAP-2 / CAP-3. Never in REQUIRED_ACTIONS (nothing calls them yet): the
    // capability audit evaluates them at the subscription, beside the
    // Defender actions, through azureCheckVerdicts.
    [POLICY_ASSIGNMENTS_WRITE]: "policy.assign",
    [POLICY_REMEDIATIONS_WRITE]: "policy.remediate",
    [MANAGED_IDENTITY_WRITE]: "identity.create",
  });

/**
 * Actions whose resource lives BELOW the scope the preflight evaluates them at,
 * so the evaluation can establish a grant but never a denial.
 *
 * The Defender continuous export is checked on `existing-subscription`, but the
 * automation resource sits in a resource group the operator picks at deploy
 * time (defender-automation defenderExportPath). A grant at the subscription is
 * inherited by every group, so it is a real `granted`. Not granted at the
 * subscription says nothing about a role on that group - the same reason CAP-7b
 * keeps listKeys out - so it is recorded as nothing, and the domain resolves
 * `unknown` rather than claiming a denial nobody measured.
 *
 * pricings/read and automations/read stay two-sided: the app reads both at the
 * subscription itself, so the subscription evaluation is their real scope.
 *
 * The user-assigned managed identity the Azure Policy assignments run as
 * (CAP-3) is the same case: it is created in a resource group the operator
 * picks, so only a subscription grant is a measurement. The two policy writes
 * (CAP-2) stay two-sided: a management group's grants are inherited and
 * visible at the subscription, so a miss there is a real denial at the
 * subscription and above it (domain/capability-enablers).
 */
export const GRANT_ONLY_AZURE_ACTIONS: ReadonlySet<string> = new Set([
  DEFENDER_AUTOMATIONS_WRITE,
  MANAGED_IDENTITY_WRITE,
]);

/**
 * Azure existence-probe name -> the capability it establishes.
 *
 * Every entry is a READ capability, and that is structural rather than
 * incidental: the probes are no-op reads (GETs, and one Resource Graph query),
 * so a probe can only ever prove a read.
 */
export const AZURE_PROBE_CAPABILITIES: Readonly<Record<string, AzureCapability>> =
  Object.freeze({
    "dcr-list": "dcr.read",
    "workspace-get": "workspace.read",
    "tables-list": "table.read",
    // CAP-1. A POST, but a query: Resource Graph has no write, so the probe
    // still proves only a read.
    "resource-graph-query": "resourcegraph.read",
    // CAP-4. One incident from the configured workspace's Sentinel incidents.
    "sentinel-incidents-list": "sentinel-incidents.read",
  });

/**
 * Microsoft Graph permission probe -> the capability it establishes (CAP-5).
 *
 * Both are application-permission READS, run by the capability audit through
 * the optional GraphDirectory probe. Not part of the permission preflight's
 * report: the preflight reads ARM only, and the RBAC panel shows ARM rows.
 */
export const GRAPH_PROBE_CAPABILITIES: Readonly<Record<GraphPermissionProbe, AzureCapability>> =
  Object.freeze({
    "subscribed-skus": "graph-licences.read",
    "security-incidents": "graph-incidents.read",
  });

/**
 * The verdict one Graph probe response establishes, or undefined when it
 * establishes nothing (rule 3).
 *
 *   - 2xx WITH at least one row in `value`: granted - Graph returned data it
 *     returns only to a consented identity.
 *   - 2xx with no rows: NOTHING. Whether Graph refuses a missing application
 *     permission with a 403 or answers 200 with nothing in it is unsettled in
 *     this repo (AZR-111), and a tenant can genuinely have no incidents, so an
 *     empty answer is evidence of neither.
 *   - 403: denied. The adapter has already re-minted the token once, so a
 *     token issued before the consent cannot be the cause.
 *   - anything else (401, 404, 429, 5xx): nothing - not a permission answer.
 */
export function graphProbeVerdict(
  response: GraphProbeResponse,
): "granted" | "denied" | undefined {
  if (is2xx(response.status)) {
    const value = prop(response.body, "value");
    return Array.isArray(value) && value.length > 0 ? "granted" : undefined;
  }
  return response.status === 403 ? "denied" : undefined;
}

/**
 * Cribl probe key -> capability. One probe per Cribl capability, exactly.
 *
 * Every target is a MANAGE capability, yet the local probe behind it is a GET.
 * Rule 1 therefore holds by construction in {@link applyCriblProbes}, not here:
 * a local 2xx records nothing, only a local denial is recorded, and a grant is
 * recorded only from the cloud shell's app-policy grant.
 */
export const CRIBL_PROBE_CAPABILITIES: Readonly<Record<string, CriblCapability>> =
  Object.freeze({
    packs: "pack.manage",
    outputs: "destination.manage",
    inputs: "source.manage",
    routes: "route.manage",
  });

/**
 * The Azure capabilities a setup path's effective-action check actually
 * measures. Useful for explaining an `unknown` honestly - "this setup path does
 * not check that action" is a different statement from "we have not audited yet"
 * - rather than leaving the UI to re-derive it from the action strings.
 */
export function capabilitiesCheckedForSetupPath(setupPath: SetupPath): AzureCapability[] {
  const seen = new Set<AzureCapability>();
  for (const action of checkedAzureActions(setupPath)) {
    const capability = AZURE_ACTION_CAPABILITIES[action];
    if (capability !== undefined) {
      seen.add(capability);
    }
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/** The audit identity the shell supplies - core reads neither clock nor config. */
export interface CapabilityAuditMeta {
  /** When the audit ran, ISO-8601. The shell owns the clock. */
  auditedAt: string | null;
  /**
   * The connection the audit was measured against. A different App registration
   * is a different answer, so this is what {@link isSetForConnection} compares.
   */
  connectionId: string | null;
}

/** Mutable accumulator for the verdict map. */
type Verdicts = Partial<Record<Capability, CapabilityVerdict>>;

/**
 * Azure verdicts from effective-action checks read at one scope.
 *
 * Gated on `fetched`: an unread permissions API yields fabricated
 * granted:false checks (see rule 3 in the module doc), and those are not
 * measurements. When it was read, granted maps to `granted` and NOT granted maps
 * to `denied` - at that point it IS a measurement, which is the entire reason
 * the preflight prefers effective actions over role names. The exceptions are
 * {@link GRANT_ONLY_AZURE_ACTIONS} and a check marked `unmeasured` (AZR-85),
 * each evaluated above its
 * resource's scope: there NOT granted is not a measurement, and nothing is
 * recorded.
 */
export function azureCheckVerdicts(
  fetched: boolean,
  checks: readonly PermissionCheckResult[],
): Verdicts {
  const into: Verdicts = {};
  if (!fetched) {
    return into;
  }
  for (const check of checks) {
    const capability = AZURE_ACTION_CAPABILITIES[check.action];
    if (capability === undefined) {
      continue;
    }
    if (check.granted) {
      into[capability] = "granted";
    } else if (
      !GRANT_ONLY_AZURE_ACTIONS.has(check.action) &&
      check.unmeasured === undefined
    ) {
      into[capability] = "denied";
    }
  }
  return into;
}

/**
 * Azure verdicts from the preflight's effective-action checks. A workspace
 * action the preflight could only read above the workspace arrives marked
 * `unmeasured` (AZR-85), and records nothing.
 */
function applyAzureChecks(preflight: AzurePreflight, into: Verdicts): void {
  Object.assign(into, azureCheckVerdicts(preflight.permissionsFetched, preflight.checks));
}

/**
 * Azure verdicts from the live existence probes, applied AFTER the checks so a
 * completed probe overrides the RBAC evaluation for the same read capability
 * (rule 2). An `unknown` probe writes nothing - it neither grants nor denies,
 * and must not erase a verdict the check already established.
 */
function applyAzureProbes(preflight: AzurePreflight, into: Verdicts): void {
  for (const probe of preflight.probes) {
    const capability = AZURE_PROBE_CAPABILITIES[probe.name];
    if (capability === undefined || probe.status === "unknown") {
      continue;
    }
    into[capability] = probe.status === "ok" ? "granted" : "denied";
  }
}

/**
 * Cribl verdicts from the capability probes. Every Cribl capability is a
 * MANAGE right, so rule 1 decides what may be recorded:
 *
 * - CLOUD: no request is issued; every capability is granted by the app's
 *   policies.yml, which the Org admin approved at install. That is the real
 *   source of the write grant, so `granted` is recorded. Keyed off
 *   `preflight.mode`, never off the probe's detail text.
 * - LOCAL: the probe is a GET. A 2xx proves the read only and records NOTHING,
 *   so the manage capability resolves `unknown`. A 401/403 is recorded as
 *   `denied`: if policies.yml or the role does not cover the GET, the write on
 *   the same path cannot work either.
 * - `unknown` is never recorded (rule 3). That is what makes an unreachable
 *   leader read correctly - the domain resolves `unreachable` from
 *   `criblReachable: false` instead of asserting a permission denial - and why
 *   "no worker group chosen" resolves unknown rather than denied.
 */
function applyCriblProbes(preflight: CriblPreflight, into: Verdicts): void {
  for (const probe of preflight.probes) {
    const capability = CRIBL_PROBE_CAPABILITIES[probe.capability];
    if (capability === undefined || probe.status === "unknown") {
      continue;
    }
    if (probe.status === "granted" && !criblProbeGrantsManage(preflight.mode, probe)) {
      // A GET never claims a manage right (rule 1).
      continue;
    }
    into[capability] = probe.status;
  }
}

/**
 * Project the two preflight HALVES onto a {@link CapabilitySet}.
 *
 * Takes the sides rather than a whole report because the RBAC preflight panel
 * fires the two side-runners INDEPENDENTLY - so that a slow or failed side never
 * blanks the other - and therefore never assembles a PermissionReport. Both
 * callers project through this one function, so the panel's measurement and the
 * audit's measurement can never disagree about what a probe means.
 */
export function capabilitiesFromSides(
  azure: AzurePreflight,
  cribl: CriblPreflight,
  meta: CapabilityAuditMeta,
): CapabilitySet {
  const verdicts: Verdicts = {};
  applyAzureChecks(azure, verdicts);
  applyAzureProbes(azure, verdicts);
  applyCriblProbes(cribl, verdicts);
  return {
    verdicts,
    auditedAt: meta.auditedAt,
    connectionId: meta.connectionId,
  };
}

/**
 * Project a permission preflight report onto a {@link CapabilitySet}.
 *
 * Records ONLY what was measured; everything else is left out so the domain
 * derives it from connection context. Never throws: an unconfigured, failed, or
 * partially-rendered report simply contributes fewer verdicts, which is the
 * honest outcome rather than a degraded one.
 */
export function capabilitiesFromReport(
  report: PermissionReport,
  meta: CapabilityAuditMeta,
): CapabilitySet {
  return capabilitiesFromSides(report.azure, report.cribl, meta);
}
