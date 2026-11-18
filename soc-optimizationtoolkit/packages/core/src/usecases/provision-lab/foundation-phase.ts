/**
 * Phase 1 - Foundation (ALWAYS runs; LAB-02): the lab resource group with
 * the MANDATORY TTL self-destruct - the tagged group, the hourly TTL
 * watchdog Logic App (system-assigned identity), and the Contributor grant
 * that lets the watchdog delete its own resource group at expiry.
 *
 * THE ONE ABORTING PHASE: returns false when the run must stop (resource
 * group unusable, or the TTL mandate unmet - the app never creates billable
 * lab resources without a working self-destruct). The sequencer finishes
 * the job; this module only records the failure and skips what remains.
 */

import {
  CONTRIBUTOR_ROLE_DEFINITION_ID,
  buildResourceGroupGetRequest,
  buildResourceGroupPatchTagsRequest,
  buildResourceGroupPutRequest,
  buildRgContributorRoleAssignmentRequest,
  buildTtlLogicAppGetRequest,
  buildTtlLogicAppPutRequest,
  labFoundationTags,
  labTtlInstants,
} from "../../domain/labs/lab-foundation";
import { asString, httpErrorText, is2xx, isErrorCode, mergedTags, prop } from "../arm-http";
import { ensureResource } from "./arm-resource";
import type { LabPhaseContext } from "./lab-phase-context";
import { PREREQUISITE_FAILED, manualLabRoleCommand } from "./provision-lab-types";

/** ARM error code for a role assignment that already exists (idempotent hit). */
const ROLE_ASSIGNMENT_EXISTS = "RoleAssignmentExists";

/** ARM error code when the principal object has not replicated yet. */
const PRINCIPAL_NOT_FOUND = "PrincipalNotFound";

/**
 * Run the foundation phase. Returns false when the run must ABORT (the
 * remaining steps are already marked skipped and the error recorded).
 */
export async function runFoundationPhase(ctx: LabPhaseContext): Promise<boolean> {
  const { azure, input, result, errors, sub, rg } = ctx;
  const instants = labTtlInstants(input.ttl, input.nowIso);

  // --- resource-group (GET-first; create or TTL-extend) --------------------
  await ctx.setStep("resource-group", "running");
  const foundationTags = labFoundationTags(input.ttl, input.nowIso);
  const getRg = await azure.request(buildResourceGroupGetRequest(sub, rg));

  if (is2xx(getRg.status)) {
    const patch = await azure.request(
      buildResourceGroupPatchTagsRequest(sub, rg, mergedTags(getRg.body, foundationTags)),
    );
    if (!is2xx(patch.status)) {
      const error = httpErrorText(
        `extend TTL tags on resource group '${rg}'`,
        patch.status,
        patch.body,
      );
      errors.push(error);
      await ctx.setStep("resource-group", "failed", error);
      await ctx.skipSteps(ctx.remainingAfter("ttl-logic-app"), PREREQUISITE_FAILED);
      return false;
    }
    await ctx.setStep(
      "resource-group",
      "succeeded",
      `already existed - TTL extended to ${instants.expirationTime}`,
    );
  } else if (getRg.status === 404) {
    if (input.rgMode === "bring-your-own") {
      const error =
        `resource group '${rg}' not found - bring-your-own mode requires an ` +
        "admin-pre-created group (or switch to create-new mode)";
      errors.push(error);
      await ctx.setStep("resource-group", "failed", error);
      await ctx.skipSteps(ctx.remainingAfter("ttl-logic-app"), PREREQUISITE_FAILED);
      return false;
    }
    const put = await azure.request(
      buildResourceGroupPutRequest(sub, rg, input.location, foundationTags),
    );
    if (!is2xx(put.status)) {
      const error = httpErrorText(
        `create resource group '${rg}'`,
        put.status,
        put.body,
      );
      errors.push(error);
      await ctx.setStep("resource-group", "failed", error);
      await ctx.skipSteps(ctx.remainingAfter("ttl-logic-app"), PREREQUISITE_FAILED);
      return false;
    }
    result.resourceGroupCreated = true;
    await ctx.setStep(
      "resource-group",
      "succeeded",
      `created with TTL expiring ${instants.expirationTime}`,
    );
  } else {
    const error = httpErrorText(
      `read resource group '${rg}'`,
      getRg.status,
      getRg.body,
    );
    errors.push(error);
    await ctx.setStep("resource-group", "failed", error);
    await ctx.skipSteps(ctx.remainingAfter("ttl-logic-app"), PREREQUISITE_FAILED);
    return false;
  }

  // --- ttl-logic-app (GET-first; identity readback) ------------------------
  // A TTL failure skips ALL later phases: the mandate means no billable lab
  // resources exist without a working self-destruct.
  const ttlSkipReason = "TTL self-destruct is mandatory and did not deploy";
  await ctx.setStep("ttl-logic-app", "running");
  const readPrincipalId = (body: unknown): string =>
    asString(prop(prop(body, "identity"), "principalId"));

  const ensured = await ensureResource({
    get: () => azure.request(buildTtlLogicAppGetRequest(sub, rg, input.baseObjectName)),
    put: () =>
      azure.request(
        buildTtlLogicAppPutRequest(sub, rg, input.location, input.baseObjectName),
      ),
    context: `TTL Logic App '${result.logicAppName}'`,
  });
  if (ensured.status === "failed") {
    const error = ensured.error ?? "";
    errors.push(error);
    await ctx.setStep("ttl-logic-app", "failed", error);
    await ctx.skipSteps(ctx.remainingAfter("ttl-role-assignment"), ttlSkipReason);
    return false;
  }
  if (ensured.status === "created") {
    result.logicAppCreated = true;
  }
  result.principalId = readPrincipalId(ensured.body);

  let readbackAttempt = 1;
  while (result.principalId === "" && readbackAttempt < ctx.maxAttempts) {
    readbackAttempt++;
    await ctx.sleep(ctx.delayMs);
    const reread = await azure.request(
      buildTtlLogicAppGetRequest(sub, rg, input.baseObjectName),
    );
    if (is2xx(reread.status)) {
      result.principalId = readPrincipalId(reread.body);
    }
  }
  if (result.principalId === "") {
    const error =
      `TTL Logic App '${result.logicAppName}' has no managed-identity principal id ` +
      `after ${ctx.maxAttempts} attempt(s) - re-run the deploy, then grant Contributor manually if it persists`;
    errors.push(error);
    await ctx.setStep("ttl-logic-app", "failed", error);
    await ctx.skipSteps(ctx.remainingAfter("ttl-role-assignment"), ttlSkipReason);
    return false;
  }
  await ctx.setStep(
    "ttl-logic-app",
    "succeeded",
    result.logicAppCreated
      ? `created (identity ${result.principalId})`
      : `already existed (identity ${result.principalId})`,
  );

  // --- ttl-role-assignment --------------------------------------------------
  await ctx.setStep("ttl-role-assignment", "running");
  const assignmentName = input.mintAssignmentName();
  const roleRequest = buildRgContributorRoleAssignmentRequest({
    subscriptionId: sub,
    resourceGroup: rg,
    assignmentName,
    principalId: result.principalId,
  });

  let attempt = 0;
  for (;;) {
    attempt++;
    const response = await azure.request(roleRequest);
    if (is2xx(response.status)) {
      result.roleAssigned = true;
      break;
    }
    if (response.status === 409 && isErrorCode(response.body, ROLE_ASSIGNMENT_EXISTS)) {
      result.roleAssigned = true;
      result.roleAlreadyAssigned = true;
      break;
    }
    if (isErrorCode(response.body, PRINCIPAL_NOT_FOUND) && attempt < ctx.maxAttempts) {
      await ctx.sleep(ctx.delayMs);
      continue;
    }
    const command = manualLabRoleCommand(sub, rg, result.principalId);
    result.manualRoleAssignmentCommand = command;
    // A constrained RBAC Administrator grant whose ABAC condition does not
    // allow assigning Contributor fails exactly here - name the fix.
    const bodyText = JSON.stringify(response.body) ?? "";
    const abacHint = /ABAC condition/i.test(bodyText)
      ? " The app's RBAC Administrator grant carries a role-assignment condition " +
        "that does not allow this assignment - ask an admin to add " +
        `Contributor (${CONTRIBUTOR_ROLE_DEFINITION_ID}) to the condition's ` +
        "allowed roles for service principals; if the condition pins SPECIFIC " +
        "principal ids, it must be re-authored to principal TYPES instead (the " +
        "TTL identity is created at deploy time and cannot be pre-listed). " +
        "Use the Labs screen's permission check to verify before re-running."
      : "";
    const error =
      httpErrorText(
        `grant Contributor to the TTL identity on '${rg}'`,
        response.status,
        response.body,
      ) +
      abacHint +
      ` - the lab CANNOT self-delete until an admin grants the role: ${command}`;
    errors.push(error);
    await ctx.setStep("ttl-role-assignment", "failed", error);
    const afterRole = ctx.stepNames.slice(ctx.stepNames.indexOf("ttl-role-assignment") + 1);
    await ctx.skipSteps(afterRole, ttlSkipReason);
    return false;
  }
  await ctx.setStep(
    "ttl-role-assignment",
    "succeeded",
    result.roleAlreadyAssigned ? "role already assigned" : "role assigned",
  );
  return true;
}
