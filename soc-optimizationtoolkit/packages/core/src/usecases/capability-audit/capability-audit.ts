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
  capabilityAuditKey,
  emptyCapabilitySet,
  parseCapabilitySet,
  serializeCapabilitySet,
  shouldRunAudit,
  usableCapabilitySet,
} from "../../domain/capabilities";
import type {
  AuditDecision,
  AuditTrigger,
  CapabilitySet,
} from "../../domain/capabilities";
import { runPermissionPreflight } from "../permission-preflight";
import type {
  AzurePreflightTarget,
  CriblShellMode,
  PermissionReport,
} from "../permission-preflight";
import { capabilitiesFromReport } from "../permission-preflight/capability-mapping";

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

/** Render a thrown value as text. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read the cached set, or the empty set when there is no cache, the entry is
 * absent, or the backend failed. A read failure must never look like a cache
 * HIT, since that is the path that skips measuring.
 */
export async function loadCachedCapabilities(
  cache: ContentCache | undefined,
  logger?: Logger,
): Promise<CapabilitySet> {
  if (cache === undefined) {
    return emptyCapabilitySet();
  }
  try {
    return parseCapabilitySet(await cache.get(CAPABILITY_AUDIT_CACHE_KEY));
  } catch (err) {
    logger?.info("capability-audit: cache read failed", { error: errText(err) });
    return emptyCapabilitySet();
  }
}

/**
 * Persist a set; a write failure only costs a re-audit next launch.
 *
 * Exported because the RBAC preflight panel measures the same thing on demand
 * and should feed the same cache rather than run a competing audit beside it.
 * Safe for either writer: the set carries the connection it was measured
 * against, so a set stored for one connection can never be read AS another's.
 */
export async function saveCapabilityAudit(
  cache: ContentCache | undefined,
  set: CapabilitySet,
  logger?: Logger,
): Promise<void> {
  if (cache === undefined) {
    return;
  }
  try {
    await cache.set(CAPABILITY_AUDIT_CACHE_KEY, serializeCapabilitySet(set));
  } catch (err) {
    logger?.info("capability-audit: cache write failed", { error: errText(err) });
  }
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

  const cached = await loadCachedCapabilities(ports.cache, logger);
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

  const set = capabilitiesFromReport(report, {
    auditedAt: input.nowIso,
    connectionId: key,
  });
  await saveCapabilityAudit(ports.cache, set, logger);

  logger?.info("capability-audit: audited", {
    trigger: input.trigger,
    reason: decision.reason,
    measured: Object.keys(set.verdicts).length,
  });
  return { set, key, report, decision };
}
