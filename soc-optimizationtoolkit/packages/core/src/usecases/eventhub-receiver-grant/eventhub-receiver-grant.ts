/**
 * Grant the Cribl service principal Azure Event Hubs Data Receiver on the hub
 * (or, by the operator's choice, the namespace) - the USECASES (AZR-103, ADR
 * 0008 amendment 2026-11-18). Two entry points over the AzureManagement port:
 *
 * - {@link planReceiverGrant}: READ-ONLY. Resolves the principal's object id
 *   (cribl-principal resolveCriblPrincipal: typed and cross-checked, or looked
 *   up from the client id - never guessed), builds the scope, and reads the
 *   principal's role assignments there (assignedTo(), which returns grants at
 *   and above the scope). A Data Receiver grant that already covers the scope
 *   is `already-granted`: nothing to write.
 * - {@link applyReceiverGrant}: after the operator's confirm, ONE PUT of the
 *   role assignment, then ONE GET of it back by name.
 *
 * IDEMPOTENT BY NAME. The assignment name is a version 5 GUID of the scope,
 * the role and the principal (receiverGrantAssignmentName), so repeating the
 * grant lands on the same name. Azure keeps one assignment per scope, role and
 * principal: when one exists under ANOTHER name, the PUT answers 409
 * RoleAssignmentExists, which is `already-granted` - the principal has the
 * role, and the app did not make it, so nothing is recorded.
 *
 * WHAT IS RECORDED. Only an assignment Azure accepted from this app's PUT
 * carries a record (ReceiverGrantRecord): the screen writes it to the
 * progress document, and with the deterministic name and the description
 * stamp it is what lets a removal prove the grant the app's own. A grant found
 * in place is never recorded.
 *
 * NOT A BLOCK. The permission to do this (roleAssignments/write at the scope)
 * is not measured; the screen shows that as a banner. Azure's own answer at
 * the PUT is reported as it comes: a 403 is `denied`, naming the role an
 * administrator grants.
 *
 * - {@link removeReceiverGrant} (AZR-141): after the operator's confirm in
 *   "Remove or pause what this app created", ONE GET of a recorded grant by
 *   name, and only when the record, the deterministic name and the stamp all
 *   prove it the app's (and no recorded Cribl source may read with it, or the
 *   operator overrode that), ONE DELETE by name and a GET for the 404.
 *
 * Never throws: every transport rejection and every non-2xx becomes an
 * outcome. No clock, no randomness.
 */

import type { AzureManagement, AzureManagementRequest } from "../../ports/azure-management";
import type { GraphDirectory } from "../../ports/graph-directory";
import type { Logger } from "../../ports/logger";
import { attemptArm, classifyArmFailure, is2xx, isErrorCode } from "../arm-http";
import { readAllPages } from "../read-logging-map";
import {
  PRINCIPAL_NOT_FOUND_ERROR_CODE,
  ROLE_ASSIGNMENT_EXISTS_ERROR_CODE,
  ROLE_ASSIGNMENTS_API_VERSION,
  buildRoleAssignmentRequest,
} from "../assign-dcr-role/assign-dcr-role";
import { resolveCriblPrincipal } from "../cribl-principal/cribl-principal";
import type { PrincipalSource } from "../cribl-principal/cribl-principal";
import { roleAssignmentsForPrincipalRequest } from "../../domain/logging-map/logging-map-requests";
import { overprivilegedRoleCovering, receiverRoleCovering } from "../../domain/eventhub-arm/eventhub-arm";
import type { NamespaceRef } from "../../domain/eventhub-arm/eventhub-arm";
import { eventHubLocation } from "../../domain/onboarding-howto/plan-values";
import type { PlanValues } from "../../domain/onboarding-howto/plan-values";
import type { ReceiverGrantRecord } from "../../domain/onboarding-howto/progress-document";
import {
  RECEIVER_GRANT_ROLE,
  hasReceiverGrantStamp,
  parseReceiverAssignmentRow,
  receiverGrantAssignmentName,
  receiverGrantDescription,
  receiverGrantReadBackDiffs,
  receiverGrantScopeId,
  classifyReceiverGrantRemoval,
  isReceiverGrantScope,
} from "../../domain/eventhub-receiver-grant/receiver-grant";
import { isGuid } from "../../domain/name-based-guid/name-based-guid";
import type { ReceiverGrantScopeChoice } from "../../domain/eventhub-receiver-grant/receiver-grant";
import {
  RECEIVER_GRANT_ADMIN_CONDITION,
  RECEIVER_GRANT_ADMIN_ROLE,
  RECEIVER_GRANT_DELETE_ACTION,
} from "../../domain/eventhub-receiver-grant/receiver-grant-permissions";

const LOG = "azure-onboarding: receiver grant";

export interface ReceiverGrantPorts {
  readonly azure: AzureManagement;
  /** The Entra directory, when the shell binds it: resolves or cross-checks the principal. */
  readonly graph?: GraphDirectory;
  readonly logger?: Logger;
}

export interface PlanReceiverGrantInput {
  /** The saved plan values: namespace location, hub, and the Cribl principal's ids. */
  readonly values: PlanValues;
  /** Hub by default; namespace only when the operator chose it. */
  readonly scope: ReceiverGrantScopeChoice;
  /** This app's own client id ("" when unknown); its principal is refused. */
  readonly appClientId: string;
  /** The connection's tenant, to warn when the Cribl principal names another. */
  readonly connectionTenantId: string;
}

/** The principal as the plan resolved it. */
export interface ReceiverGrantPrincipal {
  readonly objectId: string;
  readonly source: PrincipalSource;
  /** The directory's display name, or "" when it did not list the principal. */
  readonly displayName: string;
  /** The client id from the plan values ("" when blank). */
  readonly clientId: string;
}

/** A plan that may be confirmed and applied. Everything the confirm quotes is here. */
export interface ReadyReceiverGrant {
  readonly scopeChoice: ReceiverGrantScopeChoice;
  /** The ARM id of the hub or namespace the role is assigned at. */
  readonly scopeId: string;
  readonly namespace: NamespaceRef;
  /** The hub, for the hub scope; "" for the namespace scope. */
  readonly hubName: string;
  readonly principal: ReceiverGrantPrincipal;
  readonly roleName: string;
  readonly roleDefinitionGuid: string;
  /** The deterministic assignment name the PUT writes. */
  readonly assignmentName: string;
  readonly description: string;
  /**
   * The principal's assignments there: read and none covers the scope, or
   * not read (the message says why). A grant AT the scope is still caught by
   * Azure's 409 when unread; one inherited from above is not.
   */
  readonly existing: { readonly kind: "read" } | { readonly kind: "unread"; readonly message: string };
  /** Caveats the confirm shows (another tenant, Data Owner also held). */
  readonly notes: readonly string[];
}

/** A grant that already covers the scope. */
export interface ExistingReceiverGrant {
  readonly roleName: string;
  /** Where the covering assignment is: the scope itself, or above it. */
  readonly scope: string;
  readonly assignmentName: string;
  /** True when it is exactly the grant this app writes: its name and stamp. */
  readonly madeByThisApp: boolean;
}

export type PlanReceiverGrantResult =
  | { readonly kind: "ready"; readonly ready: ReadyReceiverGrant }
  | {
      readonly kind: "already-granted";
      readonly scopeId: string;
      readonly principal: ReceiverGrantPrincipal;
      readonly existing: ExistingReceiverGrant;
      readonly notes: readonly string[];
    }
  | {
      readonly kind: "refused";
      readonly reason:
        | "missing-value"
        | "no-hub"
        | "principal-unresolved"
        | "principal-invalid"
        | "principal-mismatch"
        | "app-principal";
      readonly detail: string;
    };

/** The steps an apply can stop at. */
export type ReceiverGrantStep = "assignment-put" | "assignment-read";

export type ApplyReceiverGrantOutcome =
  | { readonly kind: "granted"; readonly record: ReceiverGrantRecord }
  | {
      /** Azure accepted the PUT, but the read-back did not confirm it. */
      readonly kind: "accepted-not-verified";
      readonly record: ReceiverGrantRecord;
      readonly reasons: readonly string[];
    }
  | {
      /** 409 RoleAssignmentExists: the principal has the role under another name. Nothing recorded. */
      readonly kind: "already-granted";
      readonly message: string;
    }
  | {
      /** Azure does not know the principal in this tenant (or not yet). */
      readonly kind: "principal-not-found";
      readonly message: string;
    }
  | {
      readonly kind: "denied" | "unregistered" | "failed";
      readonly step: ReceiverGrantStep;
      readonly status: number | null;
      readonly code: string;
      readonly message: string;
    };

function refused(
  reason: Extract<PlanReceiverGrantResult, { kind: "refused" }>["reason"],
  detail: string,
): PlanReceiverGrantResult {
  return { kind: "refused", reason, detail };
}

/**
 * Plan the grant. READ-ONLY: at most one directory listing and one
 * role-assignment listing (paged). Never throws.
 */
export async function planReceiverGrant(
  ports: ReceiverGrantPorts,
  input: PlanReceiverGrantInput,
): Promise<PlanReceiverGrantResult> {
  const { values } = input;
  const loc = eventHubLocation(values);
  const namespace: NamespaceRef = {
    subscriptionId: loc.subscriptionId.trim(),
    resourceGroup: loc.resourceGroup.trim(),
    name: values.namespace.trim(),
  };
  if (namespace.subscriptionId === "" || namespace.resourceGroup === "" || namespace.name === "") {
    return refused("missing-value", "Enter the Event Hub namespace, its subscription and its resource group first.");
  }
  const hubName = input.scope === "hub" ? values.hubName.trim() : "";
  const scopeId = receiverGrantScopeId(namespace, hubName, input.scope);
  if (scopeId === null) {
    return refused(
      "no-hub",
      "The plan names no hub, so the role cannot be granted on a hub. Name the hub first, or choose the namespace " +
        "(it covers every hub in it, including the hubs Azure creates itself).",
    );
  }

  const resolved = await resolveCriblPrincipal(ports.graph, {
    objectId: values.criblPrincipalObjectId,
    clientId: values.criblClientId,
    appClientId: input.appClientId,
  });
  if (resolved.kind === "refused") return refused(resolved.reason, resolved.detail);
  const principal: ReceiverGrantPrincipal = {
    objectId: resolved.objectId,
    source: resolved.source,
    displayName: resolved.displayName,
    clientId: values.criblClientId.trim(),
  };

  const notes: string[] = [];
  const criblTenant = values.criblTenantId.trim();
  const connectionTenant = input.connectionTenantId.trim();
  if (criblTenant !== "" && connectionTenant !== "" && criblTenant.toLowerCase() !== connectionTenant.toLowerCase()) {
    notes.push(
      `The Cribl principal signs in to tenant ${criblTenant}, but this connection is tenant ${connectionTenant}. ` +
        "A role here can only be assigned to a principal of this tenant, so the object ID must be the Cribl principal's object ID in this tenant.",
    );
  }

  const assignmentName = receiverGrantAssignmentName(scopeId, principal.objectId);
  const read = await readAllPages(
    ports.azure,
    roleAssignmentsForPrincipalRequest(scopeId, principal.objectId),
    `role assignments of the Cribl principal on ${input.scope === "hub" ? `hub ${hubName}` : `namespace ${namespace.name}`}`,
  );
  let existing: ReadyReceiverGrant["existing"];
  if (read.state === "read") {
    const owner = overprivilegedRoleCovering(read.rows, scopeId);
    if (owner !== null) {
      notes.push(
        `The principal also holds ${owner.roleName} at ${owner.scope}. That role can read every shared access key of the namespace, ` +
          "so the Cribl source refuses this principal until it is removed; granting Data Receiver does not change that.",
      );
    }
    const covering = findCoveringGrant(read.rows, scopeId);
    if (covering !== null) {
      ports.logger?.info(`${LOG}: already granted`, { madeByThisApp: covering.madeByThisApp });
      return { kind: "already-granted", scopeId, principal, existing: covering, notes };
    }
    existing = { kind: "read" };
  } else {
    existing = { kind: "unread", message: read.refusal.text };
  }

  ports.logger?.info(`${LOG}: planned`, { scope: input.scope, existing: existing.kind, principalSource: principal.source });
  return {
    kind: "ready",
    ready: {
      scopeChoice: input.scope,
      scopeId,
      namespace,
      hubName,
      principal,
      roleName: RECEIVER_GRANT_ROLE.roleName,
      roleDefinitionGuid: RECEIVER_GRANT_ROLE.guid,
      assignmentName,
      description: receiverGrantDescription(),
      existing,
      notes,
    },
  };
}

/**
 * The Data Receiver assignment among `rows` that covers `scopeId` (at it or
 * above it), or null. Coverage is eventhub-arm's receiverRoleCovering, the
 * rule Validate and the Cribl source plan use, asked one row at a time so the
 * covering row's name and description can be read.
 */
function findCoveringGrant(rows: readonly unknown[], scopeId: string): ExistingReceiverGrant | null {
  for (const raw of rows) {
    const covering = receiverRoleCovering([raw], scopeId);
    const row = parseReceiverAssignmentRow(raw);
    if (covering === null || row === null) continue;
    const expectedName = receiverGrantAssignmentName(row.scope, row.principalId);
    return {
      roleName: covering.roleName,
      scope: covering.scope,
      assignmentName: row.name,
      madeByThisApp: row.name.toLowerCase() === expectedName && hasReceiverGrantStamp(row.description),
    };
  }
  return null;
}

/**
 * Apply a confirmed plan: PUT the assignment, then GET it back by name. Never
 * throws. Only a PUT Azure accepted yields a record.
 */
export async function applyReceiverGrant(
  ports: ReceiverGrantPorts,
  ready: ReadyReceiverGrant,
): Promise<ApplyReceiverGrantOutcome> {
  const request = buildRoleAssignmentRequest({
    dcrResourceId: ready.scopeId,
    assignmentName: ready.assignmentName,
    principalId: ready.principal.objectId,
    roleDefinitionId: ready.roleDefinitionGuid,
    description: ready.description,
  });
  ports.logger?.info(`${LOG}: confirmed`, { scope: ready.scopeChoice });
  const put = await attemptArm(() => ports.azure.request(request));
  if (put.ok && !is2xx(put.response.status)) {
    const { status, body } = put.response;
    if (status === 409 && isErrorCode(body, ROLE_ASSIGNMENT_EXISTS_ERROR_CODE)) {
      return {
        kind: "already-granted",
        message:
          `Azure answered that the principal ${ready.principal.objectId} already holds ${ready.roleName} at ${ready.scopeId} ` +
          "under another assignment, so nothing was created.",
      };
    }
    if (isErrorCode(body, PRINCIPAL_NOT_FOUND_ERROR_CODE)) {
      return {
        kind: "principal-not-found",
        message:
          `Azure does not know a principal with object ID ${ready.principal.objectId} in this tenant, so nothing was created. ` +
          "Check the object ID; a service principal created minutes ago can take a while to appear. Then check again.",
      };
    }
  }
  if (!put.ok || !is2xx(put.response.status)) {
    const failure = classifyArmFailure(put, `Assign ${ready.roleName} at ${ready.scopeId}`);
    const message =
      failure.kind === "denied"
        ? `${failure.message}. Your Azure identity cannot create role assignments there (Microsoft.Authorization/roleAssignments/write). ` +
          `An administrator can grant ${RECEIVER_GRANT_ADMIN_ROLE} on the hub or namespace, narrowed with the condition: ${RECEIVER_GRANT_ADMIN_CONDITION} ` +
          "Or they can follow the How-to step for this grant."
        : failure.message;
    ports.logger?.error(`${LOG}: put failed`, { kind: failure.kind, status: failure.status });
    return { kind: failure.kind, step: "assignment-put", status: failure.status, code: failure.code, message };
  }

  const record: ReceiverGrantRecord = {
    scopeId: ready.scopeId,
    principalId: ready.principal.objectId,
    assignmentName: ready.assignmentName,
  };
  const get = await attemptArm(() =>
    ports.azure.request({
      method: "GET",
      path: `${ready.scopeId}/providers/Microsoft.Authorization/roleAssignments/${ready.assignmentName}`,
      apiVersion: ROLE_ASSIGNMENTS_API_VERSION,
    }),
  );
  if (!get.ok || !is2xx(get.response.status)) {
    const failure = classifyArmFailure(get, "Read the assignment back");
    return { kind: "accepted-not-verified", record, reasons: [failure.message] };
  }
  const diffs = receiverGrantReadBackDiffs(parseReceiverAssignmentRow(get.response.body), {
    scopeId: ready.scopeId,
    principalId: ready.principal.objectId,
    assignmentName: ready.assignmentName,
  });
  ports.logger?.info(`${LOG}: written`, { verified: diffs.length === 0 });
  return diffs.length === 0 ? { kind: "granted", record } : { kind: "accepted-not-verified", record, reasons: diffs };
}

// ---------------------------------------------------------------------------
// Removal (AZR-141)
// ---------------------------------------------------------------------------

/**
 * The GET and the DELETE of a recorded grant, by its recorded name at its
 * recorded scope: exactly what the removal sends, and what its confirm
 * quotes. Null when the record names no scope this app grants at, or its
 * name is not a GUID: nothing is sent for it.
 */
export function receiverGrantRemoveRequests(
  record: ReceiverGrantRecord,
): { readonly get: AzureManagementRequest; readonly del: AzureManagementRequest } | null {
  const scope = record.scopeId.trim().replace(/\/+$/, "");
  const name = record.assignmentName.trim();
  if (!isReceiverGrantScope(scope) || !isGuid(name)) return null;
  const path = `${scope}/providers/Microsoft.Authorization/roleAssignments/${name}`;
  return {
    get: { method: "GET", path, apiVersion: ROLE_ASSIGNMENTS_API_VERSION },
    del: { method: "DELETE", path, apiVersion: ROLE_ASSIGNMENTS_API_VERSION },
  };
}

export interface ReceiverGrantRemoveInput {
  readonly record: ReceiverGrantRecord;
  /** Every grant the progress document records (the proof reads it again). */
  readonly recorded: readonly ReceiverGrantRecord[];
  /** The Cribl Event Hubs sources the app records: while any remains, nothing goes unless overridden. */
  readonly inUseBy: readonly string[];
  /** The operator confirmed the second, explicit confirm naming `inUseBy`. */
  readonly override: boolean;
}

/** The steps a removal can stop at. */
export type ReceiverGrantRemoveStep = "read" | "delete";

export type ReceiverGrantRemoveOutcome =
  /** DELETE accepted and the assignment no longer reads (404). The record can go. */
  | { readonly kind: "removed"; readonly record: ReceiverGrantRecord }
  /** DELETE accepted, but it still reads or the read failed. Keep the record. */
  | { readonly kind: "removed-not-confirmed"; readonly record: ReceiverGrantRecord; readonly reason: string }
  /** Nothing there (404 on the read): nothing sent. The record can go. */
  | { readonly kind: "already-gone"; readonly record: ReceiverGrantRecord }
  /** There, but not provably the app's, or a recorded Cribl source may still read with it: nothing sent. */
  | { readonly kind: "not-proven" | "in-use"; readonly record: ReceiverGrantRecord; readonly detail: string }
  /** The record names no scope or name this app writes: nothing sent. */
  | { readonly kind: "invalid-record"; readonly record: ReceiverGrantRecord }
  | {
      /** The read or the DELETE was refused or failed. Keep the record. */
      readonly kind: "denied" | "unregistered" | "failed";
      readonly record: ReceiverGrantRecord;
      readonly step: ReceiverGrantRemoveStep;
      readonly message: string;
    };

/**
 * Remove one recorded grant, after the operator's confirm: GET it by name
 * (404 is already gone), prove it the app's and not in use
 * (classifyReceiverGrantRemoval), DELETE it by name, then GET for the 404.
 * Never throws; a read Azure would not answer keeps the record.
 */
export async function removeReceiverGrant(
  azure: AzureManagement,
  input: ReceiverGrantRemoveInput,
  logger?: Logger,
): Promise<ReceiverGrantRemoveOutcome> {
  const { record } = input;
  const done = (outcome: ReceiverGrantRemoveOutcome): ReceiverGrantRemoveOutcome => {
    logger?.[outcome.kind === "removed" || outcome.kind === "already-gone" ? "info" : "warn"](`${LOG}: remove finished`, {
      outcome: outcome.kind,
      override: input.override,
    });
    return outcome;
  };
  const requests = receiverGrantRemoveRequests(record);
  if (requests === null) return done({ kind: "invalid-record", record });

  const read = await attemptArm(() => azure.request(requests.get));
  let found: { readonly kind: "absent" } | { readonly kind: "found"; readonly body: unknown };
  if (read.ok && read.response.status === 404) found = { kind: "absent" };
  else if (read.ok && is2xx(read.response.status)) found = { kind: "found", body: read.response.body };
  else {
    const f = classifyArmFailure(read, `Read role assignment ${record.assignmentName}`);
    return done({ kind: f.kind, record, step: "read", message: f.message });
  }

  const verdict = classifyReceiverGrantRemoval(found, record, input.recorded, input.inUseBy, input.override);
  if (verdict.kind === "already-gone") return done({ kind: "already-gone", record });
  if (verdict.kind === "not-proven" || verdict.kind === "in-use") return done({ kind: verdict.kind, record, detail: verdict.detail });

  const del = await attemptArm(() => azure.request(requests.del));
  if (!del.ok || !is2xx(del.response.status)) {
    const f = classifyArmFailure(del, `Remove role assignment ${record.assignmentName}`);
    const message =
      f.kind === "denied"
        ? `${f.message}. Your Azure identity cannot remove role assignments there (${RECEIVER_GRANT_DELETE_ACTION}). ` +
          `An administrator can grant ${RECEIVER_GRANT_ADMIN_ROLE} on the hub or namespace, narrowed with the condition: ${RECEIVER_GRANT_ADMIN_CONDITION} ` +
          "Or they can remove the assignment in the Azure portal (Access control (IAM) on the hub or namespace)."
        : f.message;
    return done({ kind: f.kind, record, step: "delete", message });
  }
  const after = await attemptArm(() => azure.request(requests.get));
  if (after.ok && after.response.status === 404) return done({ kind: "removed", record });
  const reason =
    after.ok && is2xx(after.response.status)
      ? "Azure accepted the removal, but the assignment still reads back."
      : classifyArmFailure(after, "Read it after the removal").message;
  return done({ kind: "removed-not-confirmed", record, reason });
}
