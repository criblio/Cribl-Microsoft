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
 *   - {@link receiverGrantToRerecord}: an assignment this app provably made
 *     whose record was lost, so it can be recorded again without a write.
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
  ReceiverGrantRecord,
  ReceiverGrantRemoveOutcome,
  ReceiverGrantScopeChoice,
} from "@soc/core";
import {
  RECEIVER_GRANT_ADMIN_ROLE,
  RECEIVER_GRANT_DELETE_ACTION,
  RECEIVER_GRANT_ROLE,
  quoteArmRequest,
  receiverGrantKey,
  receiverGrantRemoveRequests,
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

/**
 * The record to write again for an assignment this app provably made but
 * whose record the progress document no longer holds (review round 1): the
 * PUT succeeded, the save behind the record failed, and the page reloaded.
 * Without the record a later removal (AZR-141) cannot list it.
 *
 * Only when the plan read the assignment EXACTLY at the chosen scope and
 * its name and stamp prove it this app's (madeByThisApp). The name is
 * deterministic over scope, role and principal, so it is evidence, not a
 * guess. Recording needs no Azure write. Null otherwise: a grant above the
 * scope, or one someone else made, is never recorded.
 */
export function receiverGrantToRerecord(
  result: PlanReceiverGrantResult,
  records: readonly ReceiverGrantRecord[],
): ReceiverGrantRecord | null {
  if (result.kind !== "already-granted" || !result.existing.madeByThisApp) return null;
  const record: ReceiverGrantRecord = {
    scopeId: result.scopeId,
    principalId: result.principal.objectId,
    assignmentName: result.existing.assignmentName,
  };
  const key = receiverGrantKey(record);
  if (receiverGrantKey({ scopeId: result.existing.scope, principalId: record.principalId }) !== key) return null;
  return records.some((r) => receiverGrantKey(r) === key) ? null : record;
}

// ---------------------------------------------------------------------------
// Removal (AZR-141): the rows in "Remove or pause what this app created"
// ---------------------------------------------------------------------------

/** Where a recorded grant sits, in words: the hub in its namespace, or the namespace. */
function scopeWords(scopeId: string): string {
  const s = scopeId.split("/").filter((x) => x !== "");
  const ns = s[7] ?? "";
  return s.length === 10 ? `hub ${s[9] ?? ""} in namespace ${ns}` : `namespace ${ns}`;
}

/** The removal row's title. */
export function receiverGrantRecordTitle(record: ReceiverGrantRecord): string {
  return `${RECEIVER_GRANT_ROLE.roleName} for object ID ${record.principalId} on ${scopeWords(record.scopeId)} (Azure)`;
}

/** The removal confirm: the exact DELETE, the scope, the role and the principal, and what is checked first. */
export function receiverGrantRemoveConfirmText(record: ReceiverGrantRecord): string {
  const requests = receiverGrantRemoveRequests(record);
  if (requests === null) return "This record does not name a role assignment this app creates; nothing will be sent.";
  return (
    `Remove the role ${RECEIVER_GRANT_ROLE.roleName} (role definition ${RECEIVER_GRANT_ROLE.guid}) from the service principal ` +
    `with object ID ${record.principalId}, at scope ${record.scopeId}? Remove sends ${quoteArmRequest(requests.del)} - ` +
    "the assignment is read first and removed only if this app's record names it, its name is the one this app gives this grant, " +
    "and its description carries this app's stamp. A Cribl source that signs in as this principal stops reading this hub."
  );
}

/**
 * The SECOND confirm, offered only after the removal was refused because a
 * recorded Cribl Event Hubs source may still read with the grant. Says what
 * stops, by name.
 */
export function receiverGrantOverrideConfirmText(record: ReceiverGrantRecord, inUseBy: readonly string[]): string {
  const one = inUseBy.length === 1;
  return (
    `Remove it anyway? The Cribl source${one ? "" : "s"} ${inUseBy.join(", ")} this app created ` +
    `${one ? "is" : "are"} still recorded and may sign in with Entra ID as object ID ${record.principalId}. ` +
    `Once the assignment is gone, Azure refuses ${one ? "its" : "their"} reads at ${record.scopeId} and ` +
    `${one ? "it stops" : "they stop"} receiving events. The same checks still apply: nothing is removed unless this app can prove it made the assignment.`
  );
}

/** Why Remove is off, or null. A running Check or grant and a running removal never overlap. */
export function receiverGrantRemoveDisabledReason(gate: { readonly granting: boolean; readonly removing: boolean }): string | null {
  if (gate.removing) return "A removal is already running.";
  if (gate.granting) return "A Data Receiver check or grant is running. Remove is off until it finishes.";
  return null;
}

/** The permission the removal needs: shown as a note, never a block. */
export const RECEIVER_GRANT_REMOVE_PERMISSION_NOTE =
  `Needs ${RECEIVER_GRANT_DELETE_ACTION} on the hub or namespace, not yet measured; ${RECEIVER_GRANT_ADMIN_ROLE} holds it. ` +
  "If it is missing, Azure's refusal is shown here.";

/** The removal outcome as the screen says it. */
export function receiverGrantRemoveMessage(outcome: ReceiverGrantRemoveOutcome): PickerMessage {
  const what = `The ${RECEIVER_GRANT_ROLE.roleName} assignment ${outcome.record.assignmentName}`;
  switch (outcome.kind) {
    case "removed":
      return { tone: "info", text: `${what} was removed, and Azure no longer returns it. This app has forgotten it.` };
    case "already-gone":
      return { tone: "info", text: `${what} is no longer in Azure, so nothing was sent. This app has forgotten it.` };
    case "removed-not-confirmed":
      return {
        tone: "warning",
        text: `Azure accepted the removal of ${outcome.record.assignmentName}, but it could not be confirmed gone (${outcome.reason}). The record is kept; try Remove again.`,
      };
    case "not-proven":
    case "in-use":
      return { tone: "warning", text: `Nothing was removed. ${outcome.detail}` };
    case "invalid-record":
      return { tone: "warning", text: "This record does not name a role assignment this app creates, so nothing was sent." };
    case "denied":
    case "unregistered":
    case "failed":
      return {
        tone: "error",
        text:
          outcome.step === "read"
            ? `Nothing was removed: the assignment could not be read (${outcome.message}). The record is kept, so Remove stays offered.`
            : `The removal stopped: ${outcome.message} The record is kept.`,
      };
  }
}

/** What the section says beside the re-record button. */
export const RECEIVER_GRANT_RERECORD_TEXT =
  "This app made that assignment (its name and description say so), but your saved progress holds no record of it, " +
  "so it would not be offered for removal later. Recording it writes only your saved progress, not Azure.";
