/**
 * Remove the subscription Activity Log diagnostic setting the app created
 * (AZR-105, the removal half of AZR-98).
 *
 * DELETE ONLY WHAT THE APP CAN PROVE IT CREATED (claude-kit cribl-config-writes
 * rule 11). A diagnostic setting has no description or tags, so the proof is:
 * the name is the app's (cribl-activity-log), the app's KV record names this
 * subscription, and the setting still sends with the rule the record says the
 * app wrote (domain/onboarding-teardown classifyActivityLogRemoval).
 *
 * Order, exactly, after the operator's confirm:
 *
 *   1. GET  .../diagnosticSettings/cribl-activity-log   - read it NOW (a 404
 *      is already gone, never an error); prove it ours
 *   2. DELETE the same path
 *   3. GET  it again: a 404 confirms the removal; anything else is
 *      `removed-not-confirmed` (Azure accepted the DELETE but the setting
 *      still reads, or the read failed)
 *
 * NO PAUSE. A diagnostic setting has no switch of its own; turning categories
 * off would be a re-PUT that replaces the setting, which this app never does.
 *
 * Never throws: every rejection and non-2xx becomes an outcome; a 403 is
 * `denied` with the step named. Pure orchestration over the port.
 */

import type { AzureManagement } from "../../ports/azure-management";
import type { Logger } from "../../ports/logger";
import { attemptArm, classifyArmFailure, is2xx } from "../arm-http";
import type { ArmReadFailure } from "../arm-http";
import { readDiagnosticSetting } from "../../domain/activity-log-export/diagnostic-setting";
import {
  ACTIVITY_LOG_SETTING_NAME,
  activityLogSettingPath,
  buildActivityLogSettingDeleteRequest,
  buildActivityLogSettingGetRequest,
} from "../../domain/activity-log-export/activity-log-setting";
import { classifyActivityLogRemoval } from "../../domain/onboarding-teardown/teardown-plan";
import type { ActivityLogSettingLookup } from "../../domain/onboarding-teardown/teardown-plan";
import type { ActivityLogSettingRecord } from "../../domain/onboarding-howto/progress-document";

export type ActivityLogRemoveStep = "setting-read" | "setting-delete";

export type ActivityLogRemoveOutcome =
  /** DELETE accepted and the setting no longer reads (404). The record can go. */
  | { readonly kind: "removed"; readonly settingId: string }
  /** DELETE accepted, but the setting still reads or the read failed. Keep the record. */
  | { readonly kind: "removed-not-confirmed"; readonly settingId: string; readonly reason: string }
  /** Nothing under the app's name on this subscription: nothing sent. The record can go. */
  | { readonly kind: "already-gone"; readonly settingId: string }
  /** There, but not provably the app's: nothing sent. */
  | { readonly kind: "not-proven"; readonly settingId: string; readonly detail: string }
  | {
      readonly kind: "denied" | "unregistered" | "failed";
      readonly step: ActivityLogRemoveStep;
      readonly status: number | null;
      readonly code: string;
      readonly message: string;
    };

export interface ActivityLogRemoveInput {
  readonly subscriptionId: string;
  /** The app's KV record for this subscription, or null when it has none. */
  readonly record: ActivityLogSettingRecord | null;
}

function failure(step: ActivityLogRemoveStep, f: ArmReadFailure): ActivityLogRemoveOutcome {
  return { kind: f.kind, step, status: f.status, code: f.code, message: f.message };
}

/** Remove the app's Activity Log setting after the operator confirmed. Never throws. */
export async function removeActivityLogExport(
  azure: AzureManagement,
  input: ActivityLogRemoveInput,
  logger?: Logger,
): Promise<ActivityLogRemoveOutcome> {
  const settingId = activityLogSettingPath(input.subscriptionId);
  const done = (outcome: ActivityLogRemoveOutcome): ActivityLogRemoveOutcome => {
    const level = outcome.kind === "removed" || outcome.kind === "already-gone" ? "info" : "warn";
    logger?.[level]("activity-log-export: remove finished", { subscription: input.subscriptionId, outcome: outcome.kind });
    return outcome;
  };

  // 1. Read it now, by name.
  const read = await attemptArm(() => azure.request(buildActivityLogSettingGetRequest(input.subscriptionId)));
  let lookup: ActivityLogSettingLookup;
  if (read.ok && read.response.status === 404) lookup = { kind: "absent" };
  else if (read.ok && is2xx(read.response.status)) {
    const setting = readDiagnosticSetting(read.response.body);
    if (setting.name === "" && setting.id === "") {
      return done({
        kind: "failed",
        step: "setting-read",
        status: read.response.status,
        code: "",
        message: `Read ${ACTIVITY_LOG_SETTING_NAME}: HTTP ${read.response.status}, but the answer was not a diagnostic setting. Nothing was removed.`,
      });
    }
    lookup = { kind: "found", setting };
  } else return done(failure("setting-read", classifyArmFailure(read, `Read ${ACTIVITY_LOG_SETTING_NAME}`)));

  const verdict = classifyActivityLogRemoval(lookup, input.record, input.subscriptionId);
  if (verdict.kind === "already-gone") return done({ kind: "already-gone", settingId });
  if (verdict.kind === "not-proven") return done({ kind: "not-proven", settingId, detail: verdict.detail });

  // 2. Delete.
  const del = await attemptArm(() => azure.request(buildActivityLogSettingDeleteRequest(input.subscriptionId)));
  if (!del.ok || !is2xx(del.response.status)) {
    return done(failure("setting-delete", classifyArmFailure(del, `Remove ${ACTIVITY_LOG_SETTING_NAME}`)));
  }

  // 3. Confirm it no longer reads.
  const after = await attemptArm(() => azure.request(buildActivityLogSettingGetRequest(input.subscriptionId)));
  if (after.ok && after.response.status === 404) return done({ kind: "removed", settingId });
  const reason =
    after.ok && is2xx(after.response.status)
      ? "Azure accepted the removal, but the setting still reads back."
      : classifyArmFailure(after, "Read the setting after the removal").message;
  return done({ kind: "removed-not-confirmed", settingId, reason });
}
