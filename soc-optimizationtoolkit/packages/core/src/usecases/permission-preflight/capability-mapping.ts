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
import type { SetupPath } from "../../domain/azure-permissions";
import type { AzurePreflight, CriblPreflight, PermissionReport } from "./permission-preflight";
import { checkedAzureActions } from "./permission-preflight";

// ---------------------------------------------------------------------------
// Mapping tables (exported as DATA)
// ---------------------------------------------------------------------------

/**
 * Azure control-plane action -> the capability it establishes.
 *
 * Keys are the exact action strings in REQUIRED_ACTIONS. Two of those actions
 * are deliberately ABSENT: `Microsoft.Resources/subscriptions/resourceGroups/write`
 * and `Microsoft.OperationalInsights/workspaces/write` are lab-provisioning
 * concerns with no capability in the settled taxonomy, and inventing one here
 * would widen a model the plan closed. An unmapped action is simply not a
 * capability signal - it is never an error.
 */
export const AZURE_ACTION_CAPABILITIES: Readonly<Record<string, AzureCapability>> =
  Object.freeze({
    "Microsoft.Insights/dataCollectionRules/write": "dcr.write",
    "Microsoft.Insights/dataCollectionRules/read": "dcr.read",
    "Microsoft.OperationalInsights/workspaces/tables/write": "table.write",
    "Microsoft.OperationalInsights/workspaces/read": "workspace.read",
    "Microsoft.Resources/deployments/write": "arm.deploy",
    "Microsoft.Authorization/roleAssignments/write": "role.assign",
  });

/**
 * Azure existence-probe name -> the capability it establishes.
 *
 * Every entry is a READ capability, and that is structural rather than
 * incidental: the probes are no-op GETs, so a probe can only ever prove a read.
 */
export const AZURE_PROBE_CAPABILITIES: Readonly<Record<string, AzureCapability>> =
  Object.freeze({
    "dcr-list": "dcr.read",
    "workspace-get": "workspace.read",
    "tables-list": "table.read",
  });

/** Cribl probe key -> capability. One probe per Cribl capability, exactly. */
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
 * Azure verdicts from the effective-action checks.
 *
 * Gated on `permissionsFetched`: an unread permissions API yields fabricated
 * granted:false checks (see rule 3 in the module doc), and those are not
 * measurements. When it was read, granted maps to `granted` and NOT granted maps
 * to `denied` - at that point it IS a measurement, which is the entire reason
 * the preflight prefers effective actions over role names.
 */
function applyAzureChecks(preflight: AzurePreflight, into: Verdicts): void {
  if (!preflight.permissionsFetched) {
    return;
  }
  for (const check of preflight.checks) {
    const capability = AZURE_ACTION_CAPABILITIES[check.action];
    if (capability !== undefined) {
      into[capability] = check.granted ? "granted" : "denied";
    }
  }
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
 * Cribl verdicts from the capability probes.
 *
 * The plan's symmetry decision: identical treatment to the Azure side, same
 * four-value verdict, same omit-when-unmeasured discipline. That last part is
 * what makes an unreachable leader read correctly - every probe degrades to
 * `unknown`, nothing is recorded, and the domain resolves `unreachable` from
 * `criblReachable: false` instead of asserting a permission denial.
 *
 * On the cloud shell every probe reads "granted by platform", which is a real
 * measurement of a real fact: the app runs inside the leader under the approved
 * policies.yml.
 */
function applyCriblProbes(preflight: CriblPreflight, into: Verdicts): void {
  for (const probe of preflight.probes) {
    const capability = CRIBL_PROBE_CAPABILITIES[probe.capability];
    if (capability === undefined || probe.status === "unknown") {
      continue;
    }
    into[capability] = probe.status;
  }
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
  const verdicts: Verdicts = {};
  applyAzureChecks(report.azure, verdicts);
  applyAzureProbes(report.azure, verdicts);
  applyCriblProbes(report.cribl, verdicts);
  return {
    verdicts,
    auditedAt: meta.auditedAt,
    connectionId: meta.connectionId,
  };
}
