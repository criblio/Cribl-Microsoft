/**
 * Capability enablers (CAP-2, CAP-3) - the Azure WRITE actions the capability
 * model measures AHEAD of the features that will need them.
 *
 * backlog.md 6h decided (2026-08-12) to add capabilities and their
 * measurements before the Azure onboarding features that use them, so the
 * nav and the How-to can say what an identity can do the day the feature
 * lands. The Azure Policy logging initiatives (6a, AZR-4) need at least these
 * three writes: assign the initiative, start a remediation task for the
 * resources that existed before it (DeployIfNotExists acts only on NEW
 * resources), and create the user-assigned managed identity every
 * DeployIfNotExists assignment runs as.
 *
 * NOT THE COMPLETE SET. Outside the portal the assignment's identity must be
 * granted the definition's roleDefinitionIds by hand (Microsoft Learn,
 * "Remediate non-compliant resources"), which is
 * Microsoft.Authorization/roleAssignments/write - the existing `role.assign`
 * capability, not an enabler here. Referencing a user-assigned identity on the
 * assignment probably also needs
 * Microsoft.ManagedIdentity/userAssignedIdentities/assign/action (Managed
 * Identity Operator), which Managed Identity Contributor does not carry -
 * unconfirmed, carded as CAP-12. Reading these three as granted does not mean
 * AZR-4 can run.
 *
 * WHY THESE ARE NOT IN REQUIRED_ACTIONS. That table lists only actions the app
 * calls ("the list is not aspirational"), and it is what the RBAC preflight
 * panel renders as rows and gates readiness on. Nothing calls these yet, so
 * they are evaluated by the background capability audit instead, at the
 * SUBSCRIPTION, in the same single read that already measures the Defender
 * actions on the existing-resources path (capability-audit
 * subscriptionScopeVerdicts). They never gate anything.
 *
 * WHAT THE SUBSCRIPTION READ CAN AND CANNOT SAY.
 *   - policyAssignments/write and remediations/write: the permissions API at a
 *     subscription returns every assignment effective there, INCLUDING those
 *     inherited from its management groups. So granted means the identity can
 *     assign (or remediate) at the configured subscription, and not granted
 *     means it cannot - there, or at any management group above it. Both are
 *     measurements, so both are recorded. A grant at the subscription does NOT
 *     prove a grant at a management group: when AZR-4 assigns at one, that
 *     scope needs its own evaluation, and this capability must not be read as
 *     covering it.
 *   - userAssignedIdentities/write: the identity is created in a resource
 *     group the operator picks, so a role on that group alone is invisible at
 *     the subscription. GRANT-ONLY, exactly like the Defender automation write
 *     (capability-mapping GRANT_ONLY_AZURE_ACTIONS).
 *
 * NO PROBE, EVER. Writes are measured from effective actions only
 * (capability-mapping rule 1); a probe of a write would be the write.
 *
 * NOT ASKED FOR YET. No change request includes Resource Policy Contributor or
 * Managed Identity Contributor until a shipped feature calls these actions:
 * asking for a role nothing uses is the opposite of least privilege. The
 * feature reads the least role from the registry operation named on each
 * entry below (pinned in app-permissions.test.ts).
 *
 * Pure: data only.
 */

import type { RequiredAction } from "../azure-permissions/azure-permissions";
import { leastRoleFor, operationAction } from "../least-privilege";
import type { OperationId } from "../least-privilege";

/** Assign a policy (or initiative) - Resource Policy Contributor. */
export const POLICY_ASSIGNMENTS_WRITE = operationAction("policy.assignment.write");
/** Start a remediation task - Resource Policy Contributor. */
export const POLICY_REMEDIATIONS_WRITE = operationAction("policy.remediation.write");
/** Create a user-assigned managed identity - Managed Identity Contributor. */
export const MANAGED_IDENTITY_WRITE = operationAction("managedIdentity.write");

/** One enabler action and the registry operation it is read from. */
export interface EnablerOperation extends RequiredAction {
  readonly operationId: OperationId;
}

function enablerAction(operationId: OperationId, what: string): EnablerOperation {
  return {
    operationId,
    action: operationAction(operationId),
    label: `${what} (${leastRoleFor(operationId)})`,
    necessity: "feature",
  };
}

/**
 * The enabler actions evaluated at the subscription, in a fixed order. Every
 * entry is `feature`: a denial costs one capability, never deploy readiness.
 */
export const ENABLER_SUBSCRIPTION_OPERATIONS: readonly EnablerOperation[] = Object.freeze([
  enablerAction("policy.assignment.write", "Assign the Azure Policy logging initiatives"),
  enablerAction("policy.remediation.write", "Remediate resources that existed before the assignment"),
  enablerAction("managedIdentity.write", "Create the policy's user-assigned managed identity"),
]);

/** Drop the registry key: the evaluator takes plain RequiredActions. */
export const ENABLER_SUBSCRIPTION_ACTIONS: readonly RequiredAction[] = Object.freeze(
  ENABLER_SUBSCRIPTION_OPERATIONS.map(({ action, label, necessity }) =>
    necessity === undefined ? { action, label } : { action, label, necessity },
  ),
);
