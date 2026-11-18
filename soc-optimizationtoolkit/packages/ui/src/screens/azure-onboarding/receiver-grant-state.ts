/**
 * Data Receiver grant state - every decision the grant panel shows, as pure
 * functions (AZR-103). The component (receiver-grant-section.tsx) renders
 * these and drives IO through core's planReceiverGrant / applyReceiverGrant.
 *
 *   - {@link receiverGrantScopeOptions}: the two scopes, hub first (the
 *     default, least privilege) and namespace only by choice.
 *   - {@link receiverGrantArmKey}: everything the confirm quotes; any change
 *     to it drops a plan and an armed confirm.
 *   - {@link receiverGrantConfirmText}: the confirm, quoting the exact scope,
 *     role and principal.
 *   - {@link receiverGrantPlanMessage} / {@link receiverGrantOutcomeMessage}:
 *     the plan and the outcome in plain words.
 *
 * Visible copy carries no card ids, dates or phases (the copy-history gate
 * reads these strings).
 *
 * Pure: no React, no IO.
 */

import type {
  ApplyReceiverGrantOutcome,
  PlanReceiverGrantResult,
  PlanValues,
  ReadyReceiverGrant,
  ReceiverGrantPrincipal,
  ReceiverGrantScopeChoice,
} from "@soc/core";
import type { PickerMessage } from "./azure-onboarding-state";

/** One scope the operator can pick. */
export interface ReceiverGrantScopeOption {
  readonly value: ReceiverGrantScopeChoice;
  readonly label: string;
  /** Why it cannot be picked, or null. */
  readonly disabledReason: string | null;
}

/** The two scopes, hub first. The hub option is off when the plan names no hub. */
export function receiverGrantScopeOptions(values: Pick<PlanValues, "hubName" | "namespace">): readonly ReceiverGrantScopeOption[] {
  const hub = values.hubName.trim();
  const ns = values.namespace.trim();
  return [
    {
      value: "hub",
      label: hub === "" ? "The hub (least privilege)" : `The hub ${hub} (least privilege)`,
      disabledReason: hub === "" ? "The plan names no hub." : null,
    },
    {
      value: "namespace",
      label:
        `The namespace${ns === "" ? "" : ` ${ns}`}: every hub in it, including the hubs Azure creates itself ` +
        "(choose this for the diagnostic-settings sources)",
      disabledReason: null,
    },
  ];
}

/** The plan values the grant depends on, in a fixed order. */
const KEYS = [
  "subscriptionId",
  "resourceGroup",
  "eventHubSubscriptionId",
  "eventHubResourceGroup",
  "namespace",
  "hubName",
  "criblPrincipalObjectId",
  "criblClientId",
  "criblTenantId",
] as const;

/**
 * The key a plan and an armed confirm are made against: the scope choice,
 * every plan value the grant reads, and the screen's read counter. A change to
 * any of them drops both, so the confirm never quotes something stale.
 */
export function receiverGrantArmKey(scope: ReceiverGrantScopeChoice, values: PlanValues, readSeq: number): string {
  return JSON.stringify([scope, ...KEYS.map((k) => (values[k] ?? "").trim()), readSeq]);
}

/** How the principal's object id was found, in words. */
export function principalSourceText(principal: ReceiverGrantPrincipal): string {
  const name = principal.displayName === "" ? "" : ` (${principal.displayName})`;
  switch (principal.source) {
    case "typed-matched":
      return `object ID ${principal.objectId}${name}, which the directory confirms is client ID ${principal.clientId}`;
    case "directory":
      return `object ID ${principal.objectId}${name}, looked up in the directory from client ID ${principal.clientId}`;
    case "typed-not-cross-checked":
      return principal.clientId === ""
        ? `object ID ${principal.objectId}, as typed in the plan values (not checked against a client ID)`
        : `object ID ${principal.objectId}, as typed in the plan values; the directory could not confirm it is client ID ${principal.clientId}, which the Cribl source signs in as`;
  }
}

/** The confirm, quoting exactly what is written. */
export function receiverGrantConfirmText(ready: ReadyReceiverGrant): string {
  const where =
    ready.scopeChoice === "hub"
      ? `the hub ${ready.hubName} in namespace ${ready.namespace.name}`
      : `the namespace ${ready.namespace.name} (every hub in it)`;
  return (
    `Assign the role ${ready.roleName} (role definition ${ready.roleDefinitionGuid}) to the service principal ` +
    `${principalSourceText(ready.principal)}, at ${where}: scope ${ready.scopeId}? ` +
    `The assignment is named ${ready.assignmentName}. This creates one role assignment in Azure.`
  );
}

/** The plan's caveats and refusals, as lines. Empty for a plain ready plan. */
export function receiverGrantPlanMessages(result: PlanReceiverGrantResult): readonly PickerMessage[] {
  switch (result.kind) {
    case "refused":
      return [{ tone: "warning", text: `Nothing can be granted yet. ${result.detail}` }];
    case "already-granted": {
      const who = result.existing.madeByThisApp ? " This app made it." : "";
      const where =
        result.existing.scope.toLowerCase().replace(/\/+$/, "") === result.scopeId.toLowerCase().replace(/\/+$/, "")
          ? "at this scope"
          : `at ${result.existing.scope}, which covers this scope`;
      return [
        {
          tone: "info",
          text: `Already granted: the principal holds ${result.existing.roleName} ${where}.${who} There is nothing to grant.`,
        },
        ...result.notes.map((text) => ({ tone: "warning" as const, text })),
      ];
    }
    case "ready": {
      const lines: PickerMessage[] = result.ready.notes.map((text) => ({ tone: "warning" as const, text }));
      if (result.ready.existing.kind === "unread") {
        lines.push({
          tone: "warning",
          text:
            `The principal's existing role assignments could not be read (${result.ready.existing.message}). ` +
            "A grant at this exact scope is still caught by Azure, which answers that it exists; one inherited from above is not, " +
            "so the app may add a second, narrower one.",
        });
      }
      return lines;
    }
  }
}

/** The caveat every success carries. */
export const RECEIVER_GRANT_PROPAGATION_NOTE =
  "Azure can take a few minutes to apply a new role assignment, so the Cribl source may be refused until it does.";

/** The apply outcome as the screen says it. `recorded` is whether the progress document took the record. */
export function receiverGrantOutcomeMessage(outcome: ApplyReceiverGrantOutcome, recorded: boolean): PickerMessage {
  const notRecorded = recorded
    ? ""
    : " Your saved progress could not be updated, so this page cannot prove it made the assignment and will not offer to remove it.";
  switch (outcome.kind) {
    case "granted":
      return {
        tone: recorded ? "info" : "warning",
        text: `The role assignment was created and read back from Azure. ${RECEIVER_GRANT_PROPAGATION_NOTE}${notRecorded}`,
      };
    case "accepted-not-verified":
      return {
        tone: "warning",
        text:
          `Azure accepted the role assignment, but reading it back did not confirm it: ${outcome.reasons.join(" ")} ` +
          `${RECEIVER_GRANT_PROPAGATION_NOTE}${notRecorded}`,
      };
    case "already-granted":
      return { tone: "info", text: outcome.message };
    case "principal-not-found":
      return { tone: "warning", text: outcome.message };
    case "denied":
    case "unregistered":
    case "failed":
      return { tone: "error", text: `The grant stopped: ${outcome.message}` };
  }
}
