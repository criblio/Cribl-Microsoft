/**
 * Role-assignment state - the PURE decisions behind the Integrate page's
 * ingestion-role step (porting-plan Unit 8, ENG-37 runtime half), kept out of
 * the component so they are unit-testable without a DOM.
 *
 * The Azure section grants "Monitoring Metrics Publisher" to the ingestion
 * service principal on every deployed DCR - data cannot flow to a DCR without
 * it. The RUN itself is the @soc/core assignDcrRoles usecase (idempotency,
 * PrincipalNotFound retry, {results, assigned, total} aggregation); this module
 * only owns the surrounding pure logic:
 *
 *   - {@link validateObjectId}: the object-id validation SHAPE. The input is the
 *     ingestion Enterprise Application's OBJECT id (a GUID), NOT the app
 *     registration's client/application id - confusing the two is the classic
 *     ENG-37 failure, so this rejects a value equal to the known client id with
 *     an explicit reason as well as anything that is not GUID-shaped.
 *   - {@link roleAssignDisabledReason}: the single always-visible-disabled
 *     Run reason (running / no minter / no targets / invalid object id), in a
 *     fixed priority so the button title never contradicts the empty state.
 *   - {@link dcrResourceIdFor} / {@link upsertRoleTarget}: build a DCR's ARM
 *     resource id from a deploy outcome's scope + name (no location guesswork -
 *     the deploy already resolved the exact name) and accumulate distinct
 *     targets across in-session deploys.
 *   - {@link roleAssignStepNames}: seed the step list so it renders complete
 *     from the first onProgress tick, using the SAME assignDcrRoleStepName the
 *     usecase names its steps with (step lines stay consistent with
 *     onboard/batch).
 *   - {@link projectRoleOutcome}: project the usecase's {results, assigned,
 *     total} into the aggregated summary + per-DCR rows the section renders.
 *
 * Pure: no IO, no fetch, no React, no Date, no crypto (GUID minting is
 * shell-injected - core and this module never mint an id).
 */

import { assignDcrRoleStepName } from "@soc/core";
import type { AssignDcrRoleOutcome, DcrRoleTarget } from "@soc/core";

/**
 * A GUID (8-4-4-4-12 hex), the shape of an Azure object id. Anchored and
 * case-insensitive; hyphen-delimited groups only (the canonical portal form).
 */
const GUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reason shown when the object-id field is empty. */
export const OBJECT_ID_EMPTY_REASON =
  "Enter the ingestion service principal's Enterprise Application OBJECT id.";

/** Reason shown when the object-id value is not GUID-shaped. */
export const OBJECT_ID_NOT_GUID_REASON =
  "That is not a GUID. Use the ingestion service principal's Enterprise " +
  "Application OBJECT id (a GUID like 00000000-0000-0000-0000-000000000000), " +
  "NOT the app registration's client/application id.";

/** Reason shown when the value equals the known app-registration client id. */
export const OBJECT_ID_IS_CLIENT_ID_REASON =
  "That is the app registration's CLIENT (application) id, not the Enterprise " +
  "Application OBJECT id. They are different GUIDs - open the app registration " +
  "in Entra ID, follow the Managed application link, and copy that Enterprise " +
  "Application's Object ID.";

/** Result of {@link validateObjectId}. */
export interface ObjectIdCheck {
  /** True only when the trimmed value is a GUID and not the client id. */
  valid: boolean;
  /** Why it is invalid, or null when valid. */
  reason: string | null;
}

/**
 * Validate the Enterprise Application OBJECT id the role is granted to. The
 * value is trimmed first; an empty value is invalid (but not an error to show
 * loudly - it is just the not-yet-entered state). A non-GUID value and a value
 * equal to `clientId` (case-insensitive) are both rejected with the explicit
 * this-is-the-wrong-id guidance, since confusing the object id with the client
 * id is the classic ENG-37 mistake.
 */
export function validateObjectId(raw: string, clientId?: string): ObjectIdCheck {
  const value = raw.trim();
  if (value === "") {
    return { valid: false, reason: OBJECT_ID_EMPTY_REASON };
  }
  if (!GUID_RE.test(value)) {
    return { valid: false, reason: OBJECT_ID_NOT_GUID_REASON };
  }
  if (
    clientId !== undefined &&
    clientId.trim() !== "" &&
    value.toLowerCase() === clientId.trim().toLowerCase()
  ) {
    return { valid: false, reason: OBJECT_ID_IS_CLIENT_ID_REASON };
  }
  return { valid: true, reason: null };
}

/** Inputs to {@link roleAssignDisabledReason}. */
export interface RoleAssignGateInput {
  /** Whether the current object-id value passed {@link validateObjectId}. */
  objectIdValid: boolean;
  /** The object-id validation reason (shown when invalid), or null. */
  objectIdReason: string | null;
  /** How many DCR targets are available to grant the role on. */
  targetCount: number;
  /** Whether the shell injected a GUID minter (assignment names are shell-minted). */
  canMint: boolean;
  /** Whether an assignment run is in flight. */
  running: boolean;
}

/** Reason shown when no GUID minter was injected (a shell wiring gap). */
export const ROLE_ASSIGN_NO_MINTER_REASON =
  "This build cannot mint role-assignment ids - the hosting shell did not " +
  "provide a GUID minter.";

/** Reason shown when there are no DCR targets yet (the empty state). */
export const ROLE_ASSIGN_NO_TARGETS_REASON =
  "Deploy a DCR first - the DCRs a successful deploy creates appear here to " +
  "grant the role on.";

/** Reason shown while an assignment run is in flight. */
export const ROLE_ASSIGN_RUNNING_REASON = "Assigning the role...";

/**
 * The single always-visible-disabled Run reason, or null when the run can
 * proceed. Fixed priority: running first, then the shell-wiring gap, then the
 * empty-targets state, then the object-id validation reason. This ordering
 * keeps the disabled Run button's title consistent with the section's own
 * empty state (targets missing is reported before the object id, so a fresh
 * page never nags for an id before there is anything to assign).
 */
export function roleAssignDisabledReason(
  input: RoleAssignGateInput,
): string | null {
  if (input.running) {
    return ROLE_ASSIGN_RUNNING_REASON;
  }
  if (!input.canMint) {
    return ROLE_ASSIGN_NO_MINTER_REASON;
  }
  if (input.targetCount <= 0) {
    return ROLE_ASSIGN_NO_TARGETS_REASON;
  }
  if (!input.objectIdValid) {
    return input.objectIdReason ?? OBJECT_ID_EMPTY_REASON;
  }
  return null;
}

/** Scope + name needed to address a deployed DCR (from a deploy outcome). */
export interface DcrScopeName {
  subscriptionId: string;
  resourceGroup: string;
  dcrName: string;
}

/**
 * Build a DCR's full ARM resource id from the scope + name a deploy outcome
 * already resolved - the assignment SCOPE. No name PREDICTION (and therefore
 * no workspace-location input) is needed: the deploy carried the exact
 * deployed name, so this simply composes the canonical id the role assignment
 * PUTs against.
 */
export function dcrResourceIdFor(scope: DcrScopeName): string {
  return (
    `/subscriptions/${scope.subscriptionId}` +
    `/resourceGroups/${scope.resourceGroup}` +
    `/providers/Microsoft.Insights/dataCollectionRules/${scope.dcrName}`
  );
}

/**
 * Add a target to the list, replacing any existing entry with the same DCR
 * resource id (case-insensitive - ARM ids are case-insensitive), and returning
 * a NEW array (never mutating the input). Accumulates the DCRs an operator
 * deploys across a session so the role step can grant on all of them at once,
 * without ever listing the same DCR twice.
 */
export function upsertRoleTarget(
  list: readonly DcrRoleTarget[],
  target: DcrRoleTarget,
): DcrRoleTarget[] {
  const key = target.dcrResourceId.toLowerCase();
  const next = list.filter((t) => t.dcrResourceId.toLowerCase() !== key);
  next.push(target);
  return next;
}

/** The last non-empty path segment of an ARM resource id (its own name). */
function lastSegment(resourceId: string): string {
  const segments = resourceId.split("/").filter((s) => s !== "");
  return segments.length > 0 ? segments[segments.length - 1] : resourceId;
}

/** The display name a target renders and names its step with. */
export function roleTargetDisplayName(target: DcrRoleTarget): string {
  return target.table !== undefined && target.table !== ""
    ? target.table
    : lastSegment(target.dcrResourceId);
}

/**
 * Seed step names for the targets, one per DCR, using the SAME
 * assignDcrRoleStepName the usecase names its steps with (so the seeded
 * pending list and the usecase's onProgress updates key on identical names -
 * the shipped honest-step-list idiom, consistent with onboard/batch).
 */
export function roleAssignStepNames(
  targets: readonly DcrRoleTarget[],
): string[] {
  return targets.map((t) => assignDcrRoleStepName(roleTargetDisplayName(t)));
}

/** The outcome of one DCR's assignment, projected for display. */
export type RoleOutcomeKind = "assigned" | "already" | "failed";

/** One per-DCR row of the projected outcome. */
export interface RoleOutcomeRow {
  /** The DCR's display name. */
  dcr: string;
  /** Freshly assigned, already held, or failed. */
  kind: RoleOutcomeKind;
  /** Human-readable detail (the failure text for a failed row). */
  detail: string;
}

/** The projected aggregate outcome the section renders. */
export interface RoleOutcomeView {
  /** How many DCRs now hold the role (freshly assigned OR already present). */
  assigned: number;
  /** Total DCRs attempted. */
  total: number;
  /** True when every target now holds the role. */
  allSucceeded: boolean;
  /** One-line aggregate summary. */
  summary: string;
  /** Per-DCR rows, in the usecase's result order (target order). */
  rows: RoleOutcomeRow[];
}

/** Detail text for a freshly-assigned row. */
export const ROLE_DETAIL_ASSIGNED = "role assigned";
/** Detail text for an already-held row. */
export const ROLE_DETAIL_ALREADY = "role already assigned";

/**
 * Project the usecase's {results, assigned, total} into the aggregated summary
 * and per-DCR rows. Success + alreadyAssigned renders as 'already' (idempotent
 * hit); success alone as 'assigned'; anything else as 'failed' carrying the
 * raw error text. The summary names the role so the operator sees exactly what
 * was granted.
 */
export function projectRoleOutcome(
  outcome: AssignDcrRoleOutcome,
): RoleOutcomeView {
  const rows: RoleOutcomeRow[] = outcome.results.map((r) => {
    if (r.success) {
      return r.alreadyAssigned
        ? { dcr: r.dcr, kind: "already", detail: ROLE_DETAIL_ALREADY }
        : { dcr: r.dcr, kind: "assigned", detail: ROLE_DETAIL_ASSIGNED };
    }
    return {
      dcr: r.dcr,
      kind: "failed",
      detail: r.error ?? "assignment failed but recorded no error text",
    };
  });
  const allSucceeded =
    outcome.total > 0 && outcome.assigned === outcome.total;
  return {
    assigned: outcome.assigned,
    total: outcome.total,
    allSucceeded,
    summary:
      `${outcome.assigned} of ${outcome.total} DCR(s) now hold ` +
      "Monitoring Metrics Publisher.",
    rows,
  };
}
