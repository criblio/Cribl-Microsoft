/**
 * The Cribl principal's Azure Event Hubs Data Receiver grant - the PURE half
 * (AZR-103, ADR 0008 amendment 2026-11-18). The usecase
 * (usecases/eventhub-receiver-grant) does the reads and the one write; this
 * module decides every name, scope and body they use.
 *
 * THE ROLE is read from EVENT_HUB_RECEIVER_ROLES (eventhub-arm), the one list
 * Validate and the Cribl source plan check: role definition
 * a638d3c7-ab3a-418d-83e6-5f17a39d4fde, Azure Event Hubs Data Receiver, as
 * Microsoft Learn's built-in roles page (analytics) lists it. No lookup by
 * role NAME is made at run time: a name can be shadowed by a custom role, a
 * built-in role's GUID cannot.
 *
 * THE SCOPE is the hub by default - the narrowest grant that lets Cribl read
 * it. The namespace is offered only when the operator chooses it (it covers
 * every hub in the namespace, including the insights-* hubs Azure creates
 * itself, which do not exist yet when the grant is made).
 *
 * THE NAME is deterministic: an RFC 4122 version 5 GUID of the scope, the role
 * and the principal ({@link receiverGrantAssignmentName}). The same grant
 * always lands on the same assignment name, so repeating it is idempotent and
 * the name itself is one of the three ownership signals a later removal checks
 * (with the description stamp and the progress document's record).
 *
 * Pure: no IO, no clock, no randomness.
 */

import { stampDescription, stampFor } from "../../kit/config-writes/ownership";
import { APP_ID } from "../cribl-secrets/secret-body";
import { EVENT_HUB_RECEIVER_ROLES, eventHubNamespacePath, eventHubResourceId } from "../eventhub-arm/eventhub-arm";
import type { NamespaceRef } from "../eventhub-arm/eventhub-arm";
import { nameBasedGuid } from "../name-based-guid/name-based-guid";

/** The role granted: Azure Event Hubs Data Receiver, by its built-in GUID. */
export const RECEIVER_GRANT_ROLE: { readonly guid: string; readonly roleName: string } = EVENT_HUB_RECEIVER_ROLES[0] ?? {
  guid: "a638d3c7-ab3a-418d-83e6-5f17a39d4fde",
  roleName: "Azure Event Hubs Data Receiver",
};

/**
 * The namespace GUID every assignment name is derived in. A fixed constant of
 * this app: changing it would give every grant a new name, so a grant made
 * before the change would no longer be recognised as the app's.
 */
export const RECEIVER_GRANT_NAME_NAMESPACE = "5b0e4d5c-3f0a-4c1e-9a52-6d1f0c3e8b27";

/** Where the grant is made. `hub` is the default; `namespace` only by the operator's choice. */
export type ReceiverGrantScopeChoice = "hub" | "namespace";

/** The default scope choice: the hub, the least privilege. */
export const DEFAULT_RECEIVER_GRANT_SCOPE: ReceiverGrantScopeChoice = "hub";

/**
 * The ARM id the grant is made at, or null when the choice cannot be built:
 * `hub` with no hub named, or a namespace with a blank part.
 */
export function receiverGrantScopeId(
  ns: NamespaceRef,
  hubName: string,
  choice: ReceiverGrantScopeChoice,
): string | null {
  const clean: NamespaceRef = {
    subscriptionId: ns.subscriptionId.trim(),
    resourceGroup: ns.resourceGroup.trim(),
    name: ns.name.trim(),
  };
  if (clean.subscriptionId === "" || clean.resourceGroup === "" || clean.name === "") return null;
  if (choice === "namespace") return eventHubNamespacePath(clean);
  const hub = hubName.trim();
  return hub === "" ? null : eventHubResourceId(clean, hub);
}

/** A scope id compared the way ARM compares it: case-insensitive, no trailing slash. */
export function armScopeKey(scopeId: string): string {
  return scopeId.trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * The assignment name for this grant: a version 5 GUID of the lower-cased
 * scope, the role GUID and the lower-cased principal object id. Case and a
 * trailing slash never change it, because ARM treats both as the same scope.
 */
export function receiverGrantAssignmentName(scopeId: string, principalId: string): string {
  return nameBasedGuid(
    RECEIVER_GRANT_NAME_NAMESPACE,
    `${armScopeKey(scopeId)}|${RECEIVER_GRANT_ROLE.guid}|${principalId.trim().toLowerCase()}`,
  );
}

/**
 * The description the assignment is written with: what it is for, and the
 * app's ownership stamp (the kit's `[managed-by:<app>]`), which a removal
 * checks alongside the name and the record.
 */
export function receiverGrantDescription(): string {
  return stampDescription("Cribl Stream reads this Event Hub with Entra ID (Azure onboarding)", APP_ID);
}

/** Whether a description carries this app's stamp. */
export function hasReceiverGrantStamp(description: unknown): boolean {
  return typeof description === "string" && description.includes(stampFor(APP_ID));
}

/** One role assignment row as the grant reads it. Fields absent from the row are "". */
export interface ReceiverAssignmentRow {
  /** The assignment's full ARM id. */
  readonly id: string;
  /** The assignment's name (a GUID). */
  readonly name: string;
  readonly scope: string;
  readonly roleDefinitionId: string;
  readonly principalId: string;
  readonly description: string;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Read one roleAssignments row (a listing row or a GET body). Null when it is not one. */
export function parseReceiverAssignmentRow(row: unknown): ReceiverAssignmentRow | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as { id?: unknown; name?: unknown; properties?: unknown };
  const props = r.properties;
  if (typeof props !== "object" || props === null) return null;
  const p = props as { scope?: unknown; roleDefinitionId?: unknown; principalId?: unknown; description?: unknown };
  const roleDefinitionId = str(p.roleDefinitionId);
  if (roleDefinitionId === "") return null;
  return {
    id: str(r.id),
    name: str(r.name),
    scope: str(p.scope),
    roleDefinitionId,
    principalId: str(p.principalId),
    description: str(p.description),
  };
}

/**
 * What a read-back of the assignment differs in, as sentences; empty when it
 * is exactly the grant the app wrote.
 */
export function receiverGrantReadBackDiffs(
  row: ReceiverAssignmentRow | null,
  expected: { readonly scopeId: string; readonly principalId: string; readonly assignmentName: string },
): string[] {
  if (row === null) return ["The read-back was not a role assignment."];
  const diffs: string[] = [];
  if (!row.roleDefinitionId.toLowerCase().endsWith(`/${RECEIVER_GRANT_ROLE.guid}`)) {
    diffs.push(`It names role definition ${row.roleDefinitionId || "(none)"}, not ${RECEIVER_GRANT_ROLE.roleName}.`);
  }
  if (row.principalId.trim().toLowerCase() !== expected.principalId.trim().toLowerCase()) {
    diffs.push(`It is assigned to ${row.principalId || "(no principal)"}, not ${expected.principalId}.`);
  }
  if (row.scope !== "" && armScopeKey(row.scope) !== armScopeKey(expected.scopeId)) {
    diffs.push(`Its scope is ${row.scope}, not ${expected.scopeId}.`);
  }
  if (row.name !== "" && row.name.toLowerCase() !== expected.assignmentName.toLowerCase()) {
    diffs.push(`Its name is ${row.name}, not ${expected.assignmentName}.`);
  }
  return diffs;
}

// ---------------------------------------------------------------------------
// Removal (AZR-141): may the app delete a grant it recorded?
// ---------------------------------------------------------------------------

/**
 * Whether `scopeId` is a scope this app grants at: an Event Hub namespace, or
 * one hub in it. A record naming anything else did not come from this app's
 * grant, and nothing is sent for it.
 */
export function isReceiverGrantScope(scopeId: string): boolean {
  const segments = scopeId.trim().split("/").filter((s) => s !== "");
  const lower = segments.map((s) => s.toLowerCase());
  const nsOk =
    segments.length >= 8 &&
    lower[0] === "subscriptions" &&
    lower[2] === "resourcegroups" &&
    lower[4] === "providers" &&
    lower[5] === "microsoft.eventhub" &&
    lower[6] === "namespaces";
  if (!nsOk) return false;
  return segments.length === 8 || (segments.length === 10 && lower[8] === "eventhubs");
}

/**
 * The record a removal works from: the shape of progress-document's
 * ReceiverGrantRecord, which this pure module does not import.
 */
export interface ReceiverGrantRemovalRecord {
  readonly scopeId: string;
  readonly principalId: string;
  readonly assignmentName: string;
}

/** What a recorded grant's removal may do. */
export type ReceiverGrantRemovalVerdict =
  | { readonly kind: "delete" }
  | { readonly kind: "already-gone" }
  | { readonly kind: "not-proven"; readonly detail: string }
  | { readonly kind: "in-use"; readonly detail: string };

const removalKey = (r: ReceiverGrantRemovalRecord): string => `${armScopeKey(r.scopeId)}|${r.principalId.trim().toLowerCase()}`;

/** A read-back difference as a clause: lower-case first letter, no full stop. */
const clause = (sentence: string): string => `${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`.replace(/\.$/, "");

/**
 * May the app delete this Data Receiver assignment? Judged from the GET of the
 * assignment by its recorded name, made just before.
 *
 *   - Absent (404): already gone; nothing is sent.
 *   - `inUseBy` names the Cribl Event Hubs sources this app records. Any of
 *     them may sign in with Entra ID as this principal and read under this
 *     grant (the source record says neither its credential nor its hub), and
 *     removing it stops them reading, so while one remains nothing goes -
 *     UNLESS `override` is true: the operator confirmed a second, explicit
 *     confirm that names them.
 *   - Otherwise ALL THREE ownership signals must hold, else not-proven with
 *     every missing one named: (1) the record - the progress document still
 *     holds it under this scope and principal, with this name; (2) the name -
 *     the recorded name is the deterministic one for the scope, role and
 *     principal (receiverGrantAssignmentName), and the read answered under
 *     it; (3) the stamp - its description carries this app's stamp. The read
 *     must also still be Data Receiver, for this principal, at this scope
 *     (receiverGrantReadBackDiffs).
 */
export function classifyReceiverGrantRemoval(
  lookup: { readonly kind: "absent" } | { readonly kind: "found"; readonly body: unknown },
  record: ReceiverGrantRemovalRecord,
  recorded: readonly ReceiverGrantRemovalRecord[],
  inUseBy: readonly string[],
  override: boolean,
): ReceiverGrantRemovalVerdict {
  if (lookup.kind === "absent") return { kind: "already-gone" };
  const name = record.assignmentName.trim();
  if (inUseBy.length > 0 && !override) {
    const one = inUseBy.length === 1;
    return {
      kind: "in-use",
      detail:
        `The Cribl source${one ? "" : "s"} ${inUseBy.join(", ")} this app created may sign in with Entra ID as principal ${record.principalId} ` +
        `and read under this assignment; removing it stops ${one ? "that source" : "those sources"} reading. ` +
        `Remove ${one ? "it" : "them"} first (Remove or pause what this app created), or remove the assignment anyway after a second confirm.`,
    };
  }
  const missing: string[] = [];
  const saved = recorded.find((r) => removalKey(r) === removalKey(record));
  if (saved === undefined) {
    missing.push("this app has no record of creating it");
  } else if (saved.assignmentName.trim().toLowerCase() !== name.toLowerCase()) {
    missing.push(`this app recorded it under the name ${saved.assignmentName}, not ${name}`);
  }
  const expectedName = receiverGrantAssignmentName(record.scopeId, record.principalId);
  if (name.toLowerCase() !== expectedName) {
    missing.push(`its name ${name} is not the one this app gives this role for this principal at this scope (${expectedName})`);
  }
  const row = parseReceiverAssignmentRow(lookup.body);
  if (row === null) {
    missing.push("Azure's answer was not a role assignment");
  } else {
    const diffs = receiverGrantReadBackDiffs(row, { scopeId: record.scopeId, principalId: record.principalId, assignmentName: name });
    missing.push(...diffs.map(clause));
    if (!hasReceiverGrantStamp(row.description)) missing.push("its description does not carry this app's stamp");
  }
  if (missing.length > 0) {
    return {
      kind: "not-proven",
      detail:
        `This app cannot prove it created role assignment ${name} as it is now (${missing.join("; ")}), so it does not remove it. ` +
        "An administrator can remove it in the Azure portal (Access control (IAM) on the hub or namespace) if it should go.",
    };
  }
  return { kind: "delete" };
}
