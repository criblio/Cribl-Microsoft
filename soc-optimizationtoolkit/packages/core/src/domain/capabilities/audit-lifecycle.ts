/**
 * Audit lifecycle - WHEN the capability audit runs and whether a cached result
 * may still be trusted (capability-model-plan step 2, decision 2).
 *
 * The decisions this module encodes, all settled in the plan:
 *
 *   - Cache PER CONNECTION. A different App registration is a different answer,
 *     and so is a different scope: the RBAC permissions API is queried AT a
 *     scope, and the setup path selects WHICH actions are checked. All of that
 *     folds into one {@link capabilityAuditKey}, which is what a CapabilitySet
 *     carries as its `connectionId` - so the existing isSetForConnection check
 *     is the whole invalidation rule, not a second mechanism beside it.
 *
 *   - Re-audit on connection switch, scope commit, and secret re-entry. The
 *     first two already change the key; SECRET RE-ENTRY DOES NOT, which is
 *     exactly why triggers are modelled explicitly rather than inferred from
 *     key equality. Re-entering a secret does not change who you are - it
 *     changes whether we can measure at all.
 *
 *   - Do NOT re-audit every launch. The audit costs real requests against a
 *     shared budget, and permissions change rarely. A launch that finds a
 *     matching cached set uses it.
 *
 *   - NO TIME-BASED EXPIRY. Age is surfaced so the operator can judge staleness
 *     and refresh; it never silently invalidates. This is only safe because of
 *     the plan's rule 3 - the audit informs and offers, it never forbids - so a
 *     stale verdict costs an annotation, never the ability to work.
 *
 * Pure: no IO, no clock. `nowIso` is supplied by the caller for age arithmetic,
 * the same injected-timestamp pattern domain/labs/lab-inventory already uses.
 */

import type { SetupPath } from "../azure-permissions";
import { emptyCapabilitySet, isSetForConnection } from "./capabilities";
import type { CapabilitySet } from "./capabilities";

// ---------------------------------------------------------------------------
// The audit key (what a CapabilitySet's connectionId actually is)
// ---------------------------------------------------------------------------

/**
 * Everything that, if it changed, would make a cached audit answer the wrong
 * question.
 *
 * The Cribl SHELL is deliberately absent: it is fixed for a given build (the
 * cloud app is always cloud), so keying on it would add a constant. The worker
 * group is present because it genuinely varies and the Cribl probes are
 * group-scoped.
 */
export interface CapabilityAuditKeyInput {
  /** Azure AD tenant of the App registration audited. */
  tenantId: string;
  /** Azure AD client id of the App registration audited. */
  clientId: string;
  /** Subscription the scope was built from. */
  subscriptionId: string;
  /** Resource group, for resource-group-scoped setup paths. */
  resourceGroup: string;
  /** Workspace, which decides whether the workspace/table probes ran at all. */
  workspaceName: string;
  /** The setup path, which selects WHICH actions the audit checked. */
  setupPath: SetupPath;
  /** The worker group / edge fleet the Cribl probes targeted. */
  criblWorkerGroup: string;
}

/**
 * Version prefix on every key. Bumping it invalidates every cached audit in the
 * field at once - the escape hatch for a taxonomy or probe-set change that makes
 * old verdicts mean something different.
 */
export const CAPABILITY_AUDIT_KEY_VERSION = "v1";

/** Escape a field value so no value can forge a different key's delimiters. */
function escapeField(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\p").replace(/=/g, "\\e");
}

/**
 * Derive the stable key an audit was measured against.
 *
 * ALWAYS returns a string, including for a wholly unconfigured connection - an
 * audit run while unconfigured measured nothing, so reusing it is harmless and
 * the domain still resolves every capability from context. Avoiding a null case
 * here is what keeps the caching rule a single equality check.
 *
 * Carries NO SECRET, by construction: only the non-secret identity and target
 * fields are read, mirroring the secret-exclusion rule AzureConfig already
 * enforces. Never hash or embed a client secret here - the key is persisted.
 */
export function capabilityAuditKey(input: CapabilityAuditKeyInput): string {
  const parts: [string, string][] = [
    ["tenant", input.tenantId],
    ["client", input.clientId],
    ["sub", input.subscriptionId],
    ["rg", input.resourceGroup],
    ["ws", input.workspaceName],
    ["path", input.setupPath],
    ["group", input.criblWorkerGroup],
  ];
  return [
    CAPABILITY_AUDIT_KEY_VERSION,
    ...parts.map(([name, value]) => `${name}=${escapeField(value)}`),
  ].join("|");
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

/**
 * What prompted a possible audit.
 *
 * `secret-entry` is the one that cannot be derived from the key: re-entering a
 * secret leaves the identity unchanged but may turn an unmeasurable connection
 * into a measurable one.
 */
export type AuditTrigger =
  | "launch"
  | "connection-switch"
  | "scope-commit"
  | "secret-entry"
  | "manual";

/** Whether to run, and the greppable reason - shown in logs, not to operators. */
export interface AuditDecision {
  run: boolean;
  reason: string;
}

/** Reason a launch declines to re-audit. */
export const AUDIT_SKIP_CACHED_REASON =
  "cached audit matches this connection; launch does not re-audit";

/**
 * Decide whether an audit should run for a trigger.
 *
 * Every trigger except `launch` runs unconditionally - each is a moment where
 * the previous answer is known to be suspect, or where the operator explicitly
 * asked. `launch` is the sole conserving case, and it conserves ONLY when the
 * cached set was measured against this exact key.
 */
export function shouldRunAudit(
  trigger: AuditTrigger,
  cached: CapabilitySet,
  key: string,
): AuditDecision {
  switch (trigger) {
    case "manual":
      return { run: true, reason: "operator requested a refresh" };
    case "connection-switch":
      return { run: true, reason: "connection changed" };
    case "scope-commit":
      return { run: true, reason: "scope committed" };
    case "secret-entry":
      // The key is unchanged, so nothing about identity says to re-run. What
      // changed is our ability to measure at all.
      return { run: true, reason: "secret re-entered" };
    case "launch":
      return isSetForConnection(cached, key)
        ? { run: false, reason: AUDIT_SKIP_CACHED_REASON }
        : { run: true, reason: "no cached audit for this connection" };
  }
}

// ---------------------------------------------------------------------------
// Age
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Milliseconds since the audit ran, or null when it never ran or either
 * timestamp is unparseable. Clamped at zero: a future `auditedAt` is clock skew,
 * and rendering a negative age would be worse than rendering none.
 */
export function auditAgeMs(set: CapabilitySet, nowIso: string): number | null {
  if (set.auditedAt === null) {
    return null;
  }
  const auditedMs = new Date(set.auditedAt).getTime();
  const nowMs = new Date(nowIso).getTime();
  if (Number.isNaN(auditedMs) || Number.isNaN(nowMs)) {
    return null;
  }
  return Math.max(0, nowMs - auditedMs);
}

/** Pluralize a whole-unit count. */
function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

/**
 * The age phrase shown beside the audit result. Coarse on purpose - the point
 * is "is this old enough that I should refresh?", not precision.
 */
export function describeAuditAge(set: CapabilitySet, nowIso: string): string {
  const age = auditAgeMs(set, nowIso);
  if (age === null) {
    return "never checked";
  }
  if (age < MINUTE_MS) {
    return "just now";
  }
  if (age < HOUR_MS) {
    return plural(Math.floor(age / MINUTE_MS), "minute");
  }
  if (age < DAY_MS) {
    return plural(Math.floor(age / HOUR_MS), "hour");
  }
  return plural(Math.floor(age / DAY_MS), "day");
}

// ---------------------------------------------------------------------------
// The composed view
// ---------------------------------------------------------------------------

/**
 * Whether the cached audit applies here.
 *
 *   never-run         - nothing cached at all.
 *   current           - measured against this exact connection and scope.
 *   other-connection  - a real audit, but of something else. Its verdicts are
 *                       not shown; they answer a different question.
 */
export type AuditStatus = "never-run" | "current" | "other-connection";

/** What the UI needs to describe the audit's standing. */
export interface CapabilityAuditView {
  status: AuditStatus;
  /** One line for the operator, age included when there is one. */
  label: string;
  /** Whether the cached verdicts may be rendered at all. */
  usable: boolean;
}

/**
 * Describe a cached set's standing against the current connection.
 *
 * Deliberately says nothing about a set being "too old". Age is reported; the
 * judgement is the operator's, and the refresh is manual.
 */
export function describeCapabilityAudit(
  set: CapabilitySet,
  key: string,
  nowIso: string,
): CapabilityAuditView {
  if (isSetForConnection(set, key)) {
    return {
      status: "current",
      label: `Permissions checked ${describeAuditAge(set, nowIso)}.`,
      usable: true,
    };
  }
  if (set.connectionId === null) {
    return {
      status: "never-run",
      label: "Permissions have not been checked for this connection yet.",
      usable: false,
    };
  }
  return {
    status: "other-connection",
    label:
      "The last permission check was for a different connection or scope. " +
      "Re-run it to see what this one can do.",
    usable: false,
  };
}

/**
 * The set that may actually be rendered: the cached one when it matches this
 * connection, an empty one otherwise.
 *
 * A guard rather than a convenience. Showing another connection's verdicts would
 * be the single worst failure this model can have - confidently wrong about
 * permissions - and an empty set degrades honestly instead, resolving every
 * capability to unknown or unreachable from context.
 */
export function usableCapabilitySet(set: CapabilitySet, key: string): CapabilitySet {
  return isSetForConnection(set, key) ? set : emptyCapabilitySet();
}
