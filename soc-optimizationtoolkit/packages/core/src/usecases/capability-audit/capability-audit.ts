/**
 * capability-audit - running the permission audit and caching its result
 * (capability-model-plan step 2).
 *
 * This is the one place that joins the three pieces the plan said already
 * existed: the preflight MEASURES, capability-mapping PROJECTS, and the audit
 * lifecycle decides WHEN and whether a cached answer still applies. Nothing here
 * is new policy - every rule it follows lives in domain/capabilities.
 *
 * NEVER THROWS, and that is deliberate rather than defensive. The audit is
 * informational by rule 3 of the plan: it annotates and offers, it never
 * forbids. A failure to audit must therefore cost an annotation, not the app -
 * so a dead cache backend, an unreachable leader, or an ARM error all degrade to
 * fewer verdicts, and the domain resolves the rest from connection context.
 *
 * CACHE FAILURES ARE NON-FATAL IN BOTH DIRECTIONS. A read failure means we audit
 * (the conserving path is the one we skip, never the measuring one); a write
 * failure means the next launch re-audits. Neither is worth surfacing an error
 * for, and both are logged.
 *
 * Pure orchestration over ports: no clock of its own - `nowIso` comes from the
 * shell, exactly as CapabilitySet's contract requires.
 */

import type { AzureManagement } from "../../ports/azure-management";
import type { ContentCache } from "../../ports/sentinel-content";
import type { CriblClient } from "../../ports/cribl-client";
import type { Logger } from "../../ports/logger";
import type { SetupPath } from "../../domain/azure-permissions";
import {
  CAPABILITY_AUDIT_CACHE_KEY,
  auditKeyNamesTenant,
  capabilityAuditCacheKey,
  capabilityAuditKey,
  emptyCapabilitySet,
  mergeCapabilitySets,
  parseCapabilitySet,
  serializeCapabilitySet,
  shouldRunAudit,
  usableCapabilitySet,
} from "../../domain/capabilities";
import type {
  AuditDecision,
  AuditTrigger,
  Capability,
  CapabilitySet,
  CapabilityVerdict,
} from "../../domain/capabilities";
import { evaluateActionsAtScope, runPermissionPreflight } from "../permission-preflight";
import { DEFENDER_SUBSCRIPTION_ACTIONS } from "../../domain/defender-export/defender-permissions";
import { ENABLER_SUBSCRIPTION_ACTIONS } from "../../domain/capability-enablers";
import { evaluatePermissions } from "../../domain/azure-permissions";
import type { RequiredAction } from "../../domain/azure-permissions";
import type { GraphDirectory, GraphPermissionProbe } from "../../ports/graph-directory";
import type {
  AzurePreflightTarget,
  CriblShellMode,
  PermissionReport,
} from "../permission-preflight";
import {
  GRAPH_PROBE_CAPABILITIES,
  azureCheckVerdicts,
  capabilitiesFromReport,
  graphProbeVerdict,
} from "../permission-preflight/capability-mapping";

/** The ports the audit orchestrates. */
export interface CapabilityAuditPorts {
  azure: AzureManagement;
  cribl: CriblClient;
  /**
   * OPTIONAL cache for the audit result. Absent = nothing is remembered, so
   * every launch audits. Optional because UiPorts.contentCache is, and a shell
   * that has not bound one should still be able to audit.
   */
  cache?: ContentCache;
  /**
   * OPTIONAL Microsoft Graph reader for the CAP-5 permission probes. Absent,
   * or without `probePermission`, the Graph capabilities stay unmeasured.
   */
  graph?: GraphDirectory;
  /** OPTIONAL diagnostics sink. */
  logger?: Logger;
}

/** Input to {@link runCapabilityAudit}. */
export interface CapabilityAuditInput {
  /** What prompted this - the only thing that can decline to run is `launch`. */
  trigger: AuditTrigger;
  /** The setup path, which selects which actions are checked. */
  setupPath: SetupPath;
  /** Azure targeting for the preflight AND for the audit key's scope fields. */
  azure: AzurePreflightTarget;
  /** The App registration being audited. Non-secret fields only. */
  identity: {
    tenantId: string;
    clientId: string;
  };
  /** Cribl-side context. */
  cribl: {
    mode: CriblShellMode;
    workerGroup?: string;
  };
  /** The shell's clock reading, stamped onto the resulting set. */
  nowIso: string;
}

/** What the audit resolved to. */
export interface CapabilityAuditResult {
  /**
   * The capabilities to render. Guaranteed to apply to `key`: a cached set for
   * another connection never reaches the caller.
   */
  set: CapabilitySet;
  /** The connection identity these capabilities were measured against. */
  key: string;
  /** The report, when one was run; null when the cached set was reused. */
  report: PermissionReport | null;
  /** Whether an audit ran, and why. */
  decision: AuditDecision;
}

/**
 * The actions a resource-group audit evaluates at the SUBSCRIPTION, in one
 * read: the Defender export's (AZR-86) and the capability enablers' (CAP-2,
 * CAP-3). Exported so the pin can name exactly what is measured there.
 */
export const SUBSCRIPTION_AUDIT_ACTIONS: readonly RequiredAction[] = Object.freeze([
  ...DEFENDER_SUBSCRIPTION_ACTIONS,
  ...ENABLER_SUBSCRIPTION_ACTIONS,
]);

/**
 * The verdicts every audit adds from the subscription, for actions the setup
 * path's own check does not evaluate.
 *
 * DEFENDER (AZR-86, audit discrepancy 21). The existing path audits
 * `existing-rg`, whose scope is the workspace's resource group, while the
 * Defender export's pricings and automations are read at the subscription. So
 * the default audit never measured them, and the Defender capabilities stayed
 * unknown for every existing-path tenant.
 *
 * ENABLERS (CAP-2, CAP-3). The Azure Policy assignment, remediation and
 * managed-identity writes are measured ahead of the feature that will call
 * them (domain/capability-enablers says what the subscription read can and
 * cannot prove for each). They are in no setup path's required actions, so
 * every path evaluates them here.
 *
 * WHICH READ, PER SETUP PATH:
 *   - subscription scope (`existing-subscription`, `lab-new-rg-subscription`):
 *     the preflight already read the subscription, so these actions are
 *     evaluated against THAT read (`report.azure.scopePermissions`) - no
 *     request. Unread there, nothing is recorded and nothing is re-asked.
 *   - resource-group scope (`existing-rg`, `lab-byo-rg`): one GET of the
 *     subscription's permissions.
 * Never with no subscription set. The grant-only rule applies to the Defender
 * export write and the managed identity write. Unread, it records nothing
 * (rule 3), so a refusal costs an annotation. Where the preflight also
 * measured an action (Defender on existing-subscription), its verdict wins.
 */
export async function subscriptionScopeVerdicts(
  azure: AzureManagement,
  report: PermissionReport,
  subscriptionId: string,
): Promise<CapabilitySet["verdicts"]> {
  if (subscriptionId === "") {
    return {};
  }
  if (report.azure.scopeKind === "subscription") {
    const permissions = report.azure.scopePermissions;
    if (!report.azure.permissionsFetched || permissions === undefined) {
      return {};
    }
    return azureCheckVerdicts(
      true,
      evaluatePermissions({ value: [...permissions] }, [...SUBSCRIPTION_AUDIT_ACTIONS]),
    );
  }
  const evaluated = await evaluateActionsAtScope(
    azure,
    `/subscriptions/${subscriptionId}`,
    SUBSCRIPTION_AUDIT_ACTIONS,
  );
  return azureCheckVerdicts(evaluated.fetched, evaluated.checks);
}

/**
 * The Microsoft Graph application-permission verdicts (CAP-5): one minimal
 * read per probe in {@link GRAPH_PROBE_CAPABILITIES}, run in sequence.
 *
 * Records only what graphProbeVerdict says a response proves - a row is a
 * grant, a 403 naming missing privileges a denial, and an empty 200 or any
 * other 403 nothing (AZR-111). A shell whose GraphDirectory has no probe, or
 * no GraphDirectory at all, records nothing; so does a probe that rejects.
 *
 * COST per audit that runs: two Graph GETs when both are answered first time.
 * At most ONE token mint (a token request plus a KV write) and THREE Graph
 * GETs, because every mint counts against one per-audit budget: the mint the
 * adapter makes before the first GET when it holds no token for this tenant
 * (every fresh page load, after a secret is written, after a tenant switch)
 * is reported as `reminted` and never followed by a 401/403 re-mint of its
 * own; a refused probe on a token held from earlier re-mints and retries
 * once. Either way the re-mint is allowed only until one probe in this audit
 * has spent it. (Review r2: a fresh page load used to cost two mints.)
 */
export async function graphPermissionVerdicts(
  graph: GraphDirectory | undefined,
  logger?: Logger,
): Promise<CapabilitySet["verdicts"]> {
  const into: Partial<Record<Capability, CapabilityVerdict>> = {};
  if (graph?.probePermission === undefined) {
    return into;
  }
  const probes = Object.keys(GRAPH_PROBE_CAPABILITIES) as GraphPermissionProbe[];
  // One token re-mint per audit at most: a probe after one that re-minted is
  // already reading on a token that reflects current consent.
  let reminted = false;
  for (const probe of probes) {
    try {
      const response = await graph.probePermission(probe, { remint: !reminted });
      reminted = reminted || response.reminted === true;
      const verdict = graphProbeVerdict(response);
      if (verdict !== undefined) {
        into[GRAPH_PROBE_CAPABILITIES[probe]] = verdict;
      }
    } catch (err) {
      logger?.info("capability-audit: graph probe failed", { probe, error: errText(err) });
    }
  }
  return into;
}

/** Render a thrown value as text. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read `tenantId`'s cached set, or the empty set when there is no cache, the
 * entry is absent, or the backend failed. A read failure must never look like a
 * cache HIT, since that is the path that skips measuring.
 *
 * ONE-TIME MOVE (ADR 0009 decision 3): when the tenant has no entry yet, the
 * legacy single-slot audit is adopted only if it was measured for THIS tenant -
 * the set names its tenant, so unlike the How-to documents it does not need the
 * "whoever is active" rule - and the legacy slot is then emptied.
 */
export async function loadCachedCapabilities(
  cache: ContentCache | undefined,
  tenantId: string,
  logger?: Logger,
): Promise<CapabilitySet> {
  if (cache === undefined) {
    return emptyCapabilitySet();
  }
  try {
    const own = await cache.get(capabilityAuditCacheKey(tenantId));
    if (own !== null) return parseCapabilitySet(own);
    const legacy = parseCapabilitySet(await cache.get(CAPABILITY_AUDIT_CACHE_KEY));
    if (!auditKeyNamesTenant(legacy.connectionId, tenantId)) return emptyCapabilitySet();
    await cache.set(capabilityAuditCacheKey(tenantId), serializeCapabilitySet(legacy));
    await cache.set(CAPABILITY_AUDIT_CACHE_KEY, null);
    return legacy;
  } catch (err) {
    logger?.info("capability-audit: cache read failed", { error: errText(err) });
    return emptyCapabilitySet();
  }
}

/**
 * MERGE a writer's measurements into `tenantId`'s cached set and persist the
 * result; returns the set as stored (or as it would have been, when the write
 * fails). A write failure only costs a re-audit next launch.
 *
 * Exported because the RBAC preflight panel measures part of the same thing on
 * demand and should feed the same cache rather than run a competing audit
 * beside it. Safe for either writer:
 *   - the set carries the connection it was measured against, so a set stored
 *     for one connection can never be read AS another's, and the per-tenant key
 *     means it never evicts another tenant's audit;
 *   - it MERGES rather than replaces (CAP-11, mergeCapabilitySets): each writer
 *     measures a different subset, and a replace by the panel used to drop
 *     every verdict only the audit measures (subscription-scope enablers,
 *     Defender on existing-rg, Graph). A verdict is now replaced only by a
 *     newer measurement of the same capability.
 *
 * A READ FAILURE SKIPS THE WRITE. With the cached set unreadable there is
 * nothing to merge over, and writing the incoming set alone would erase
 * whatever the other writer measured - the defect this exists to prevent. The
 * skipped write costs at most a re-audit.
 */
export async function saveCapabilityAudit(
  cache: ContentCache | undefined,
  set: CapabilitySet,
  tenantId: string,
  logger?: Logger,
): Promise<CapabilitySet> {
  if (cache === undefined) {
    return set;
  }
  const key = capabilityAuditCacheKey(tenantId);
  let stored: CapabilitySet;
  try {
    stored = parseCapabilitySet(await cache.get(key));
  } catch (err) {
    logger?.info("capability-audit: cache read before write failed; not writing", {
      error: errText(err),
    });
    return set;
  }
  const merged = mergeCapabilitySets(stored, set);
  try {
    await cache.set(key, serializeCapabilitySet(merged));
  } catch (err) {
    logger?.info("capability-audit: cache write failed", { error: errText(err) });
  }
  return merged;
}

/**
 * Run the audit if the trigger and cache state call for it, and return the
 * capabilities that apply to this connection either way.
 *
 * Never rejects. When the preflight itself throws - which it is written not to -
 * the result is the empty set rather than a propagated error, so the caller
 * still has something honest to render.
 */
export async function runCapabilityAudit(
  ports: CapabilityAuditPorts,
  input: CapabilityAuditInput,
): Promise<CapabilityAuditResult> {
  const { logger } = ports;
  const workerGroup = input.cribl.workerGroup ?? "";
  const key = capabilityAuditKey({
    tenantId: input.identity.tenantId,
    clientId: input.identity.clientId,
    subscriptionId: input.azure.subscriptionId,
    resourceGroup: input.azure.resourceGroup,
    workspaceName: input.azure.workspaceName,
    setupPath: input.setupPath,
    criblWorkerGroup: workerGroup,
  });

  const cached = await loadCachedCapabilities(ports.cache, input.identity.tenantId, logger);
  const decision = shouldRunAudit(input.trigger, cached, key);

  if (!decision.run) {
    logger?.info("capability-audit: using cached audit", {
      trigger: input.trigger,
      reason: decision.reason,
    });
    // usableCapabilitySet is redundant here (the decision to skip already
    // required a match) and is kept anyway: it makes "the caller never sees
    // another connection's verdicts" true by construction rather than by
    // reasoning about a decision made elsewhere.
    return { set: usableCapabilitySet(cached, key), key, report: null, decision };
  }

  let report: PermissionReport | null = null;
  try {
    report = await runPermissionPreflight(
      { azure: ports.azure, cribl: ports.cribl, ...(logger !== undefined ? { logger } : {}) },
      {
        setupPath: input.setupPath,
        azure: input.azure,
        cribl: {
          mode: input.cribl.mode,
          ...(input.cribl.workerGroup !== undefined
            ? { workerGroup: input.cribl.workerGroup }
            : {}),
        },
      },
    );
  } catch (err) {
    // The preflight is total, so this is belt-and-braces. An unexpected throw
    // must still leave the caller with a renderable answer.
    logger?.info("capability-audit: preflight threw", { error: errText(err) });
    return {
      set: { verdicts: {}, auditedAt: input.nowIso, connectionId: key },
      key,
      report: null,
      decision,
    };
  }

  const measured = capabilitiesFromReport(report, {
    auditedAt: input.nowIso,
    connectionId: key,
  });
  // AZR-86 and CAP-2/CAP-3: the subscription-scope evaluation, per tenant
  // (this audit, its key and its cache entry are one tenant's). Fills only
  // what the preflight left unmeasured.
  const subscription = await subscriptionScopeVerdicts(
    ports.azure,
    report,
    input.azure.subscriptionId,
  );
  // CAP-5: the Graph application permissions, measured on this tenant's
  // Graph token. The preflight never records these, so nothing collides.
  const graph = await graphPermissionVerdicts(ports.graph, logger);
  const set: CapabilitySet = {
    ...measured,
    verdicts: { ...subscription, ...graph, ...measured.verdicts },
  };
  // Merged over what the cache holds for this same connection (CAP-11), so a
  // measurement this run could not repeat - a Graph probe that rejected, a
  // subscription read that failed - keeps its earlier verdict, and what the
  // caller renders is what the next launch will read.
  const stored = await saveCapabilityAudit(ports.cache, set, input.identity.tenantId, logger);

  logger?.info("capability-audit: audited", {
    trigger: input.trigger,
    reason: decision.reason,
    measured: Object.keys(set.verdicts).length,
  });
  return { set: stored, key, report, decision };
}
