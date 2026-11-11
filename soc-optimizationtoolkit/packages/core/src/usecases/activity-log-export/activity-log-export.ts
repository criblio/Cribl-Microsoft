/**
 * The subscription Activity Log export - the USECASES (AZR-98, on the AZR-18
 * Azure Native Source Onboarding screen). Two entry points over the
 * AzureManagement port, mirroring the Defender export (usecases/defender-export):
 *
 * - {@link readActivityLogState}: what the subscription has now - its
 *   diagnostic settings, and whether ours ({@link ACTIVITY_LOG_SETTING_NAME})
 *   exists.
 * - {@link deployActivityLogExport}: create our setting. CREATE-ONLY.
 *
 * WHY DEPLOY RE-LISTS AND REFUSES. A diagnostic setting PUT replaces the
 * setting whole. Between the screen's read and the operator's confirm anything
 * may have changed, so deploy lists again first and REFUSES - it never repairs
 * or replaces - when:
 *
 *   already-exists       ours exists and matches the chosen rule
 *   present-differs      ours exists but differs (the fields are named; repair
 *                        is not built, nothing here re-PUTs)
 *   possible-duplicate   another setting already sends to the chosen
 *                        namespace, so every event would arrive twice
 *   limit-reached        the subscription already holds Azure's maximum of
 *                        diagnostic settings
 *
 * A list that comes back EMPTY does not refuse: it is the normal answer for a
 * subscription with no settings. A list the identity could not read (403, no
 * answer, a 2xx that is not a listing, or more pages than a subscription can
 * hold) refuses with the step named.
 *
 * THEN, in this order and nothing else: PUT the setting, GET it back by name.
 * A read-back whose fields match is `written-and-read-back` - which names
 * exactly what was checked; delivery is only proven when an Activity Log event
 * arrives in the hub. Anything short of that after an accepted PUT is
 * `accepted-not-verified`, never a failure, because the setting may well exist.
 *
 * NO SECRET. A diagnostic setting names the namespace rule by id; Azure checks
 * the caller may use it. No listKeys is made, so no connection string exists
 * in this flow at all.
 *
 * Never throws: every transport rejection and every non-2xx becomes an
 * outcome. Never DELETEs, never re-PUTs.
 *
 * Pure orchestration over the port: no IO of its own, no clock, no randomness.
 */

import type { AzureManagement } from "../../ports/azure-management";
import type { Logger } from "../../ports/logger";
import { asString, attemptArm, classifyArmFailure, is2xx, prop } from "../arm-http";
import type { ArmReadFailure } from "../arm-http";
import type { Listing } from "../../domain/inventory-listing/inventory-listing";
import type { OnboardingItemId } from "../../domain/onboarding-selection";
import type { DiagnosticSettingRead } from "../../domain/activity-log-export/diagnostic-setting";
import { parseDiagnosticSettings, readDiagnosticSetting } from "../../domain/activity-log-export/diagnostic-setting";
import type {
  ActivityLogSettingInput,
  OursSettingState,
  SettingDiff,
} from "../../domain/activity-log-export/activity-log-setting";
import {
  ACTIVITY_LOG_ITEM_ID,
  MAX_SUBSCRIPTION_DIAGNOSTIC_SETTINGS,
  activityLogSettingDiffs,
  activityLogSettingPath,
  buildActivityLogSettingGetRequest,
  buildActivityLogSettingPutRequest,
  buildSubscriptionDiagnosticSettingsListRequest,
  classifyOursSetting,
  describeSettingDiff,
  expectedActivityLogSetting,
  findSameNamespaceSettings,
  subscriptionSettingsFull,
} from "../../domain/activity-log-export/activity-log-setting";

/** The coverage-catalog item this setting deploys; declared once, in the domain. */
export { ACTIVITY_LOG_ITEM_ID };

/** The subscription's diagnostic settings, or why they could not be read. */
export type ActivityLogSettingsState =
  | { readonly kind: "listed"; readonly listing: Listing<DiagnosticSettingRead> }
  | { readonly kind: "unread"; readonly failure: ArmReadFailure };

/** Our setting, or why we cannot say. `unknown` is never shown as absent. */
export type ActivityLogOursReading = OursSettingState | { readonly kind: "unknown"; readonly reason: string };

/** What {@link readActivityLogState} returns. */
export interface ActivityLogState {
  readonly settings: ActivityLogSettingsState;
  readonly ours: ActivityLogOursReading;
  /**
   * `[ACTIVITY_LOG_ITEM_ID]` ONLY when ours is present-matching. A differing
   * setting is not deployed, and an unreadable list proves nothing either way.
   */
  readonly deployed: readonly OnboardingItemId[];
  /** Set exactly when ours is `unknown`: the reason, for the row label. */
  readonly unknownReason?: string;
}

/** What {@link deployActivityLogExport} needs. No secret exists in this flow. */
export type ActivityLogDeployInput = ActivityLogSettingInput;

/** The deploy steps, named in denied / unregistered / failed outcomes. */
export type ActivityLogDeployStep = "setting-list" | "setting-put";

/** Every way {@link deployActivityLogExport} can end. */
export type ActivityLogDeployOutcome =
  | { readonly kind: "written-and-read-back"; readonly settingId: string }
  | {
      /** The PUT was accepted, but the read-back did not confirm the shape. */
      readonly kind: "accepted-not-verified";
      readonly settingId: string;
      readonly reasons: readonly string[];
    }
  | {
      /** Ours exists and matches the chosen rule. Nothing to do. */
      readonly kind: "already-exists";
      readonly settingId: string;
    }
  | {
      /** Ours exists but differs. Repair is not built; nothing is written. */
      readonly kind: "present-differs";
      readonly settingId: string;
      readonly diffs: readonly SettingDiff[];
    }
  | {
      /** Other settings already send to this namespace. */
      readonly kind: "possible-duplicate";
      readonly names: readonly string[];
    }
  | {
      /** The subscription already holds Azure's maximum of settings. */
      readonly kind: "limit-reached";
      readonly limit: number;
      readonly names: readonly string[];
    }
  | {
      readonly kind: "denied" | "unregistered" | "failed";
      readonly step: ActivityLogDeployStep;
      readonly status: number | null;
      readonly code: string;
      readonly message: string;
    };

/**
 * List every diagnostic setting of the subscription. Azure answers this list
 * in one page (a subscription holds at most a handful), so a nextLink is not
 * followed: it is reported unread, never `listed` with the first page, because
 * a setting on an unread page could be ours or a duplicate. A 2xx whose body
 * is not an object with a `value` array is unread too.
 */
async function listSubscriptionSettings(
  azure: AzureManagement,
  subscriptionId: string,
): Promise<ActivityLogSettingsState> {
  const what = "List the subscription's diagnostic settings";
  const first = await attemptArm(() =>
    azure.request(buildSubscriptionDiagnosticSettingsListRequest(subscriptionId)),
  );
  if (!first.ok || !is2xx(first.response.status)) {
    return { kind: "unread", failure: classifyArmFailure(first, what) };
  }
  const { status, body } = first.response;
  const value = prop(body, "value");
  if (!Array.isArray(value)) {
    return {
      kind: "unread",
      failure: { kind: "failed", status, code: "", message: `${what}: HTTP ${status}, but the response had no value array.` },
    };
  }
  if (asString(prop(body, "nextLink")) !== "") {
    return {
      kind: "unread",
      failure: {
        kind: "failed",
        status,
        code: "",
        message: `${what}: Azure returned more than one page, which a subscription's settings should not need - stopped reading.`,
      },
    };
  }
  return { kind: "listed", listing: parseDiagnosticSettings(value) };
}

/**
 * Read the subscription's Activity Log state: one list of its diagnostic
 * settings. Ours is classified without an expected rule - the operator may not
 * have picked one yet - so "matching" here means every category on, no hub
 * name, sending to an Event Hub namespace rule. Never throws; never writes.
 */
export async function readActivityLogState(
  azure: AzureManagement,
  subscriptionId: string,
  logger?: Logger,
): Promise<ActivityLogState> {
  const settings = await listSubscriptionSettings(azure, subscriptionId);
  const ours: ActivityLogOursReading =
    settings.kind === "listed"
      ? classifyOursSetting(settings.listing)
      : { kind: "unknown", reason: settings.failure.message };

  logger?.info("activity-log-export: state read", {
    subscription: subscriptionId,
    settings: settings.kind === "listed" ? settings.listing.kind : settings.failure.kind,
    ours: ours.kind,
  });

  return {
    settings,
    ours,
    deployed: ours.kind === "present-matching" ? [ACTIVITY_LOG_ITEM_ID] : [],
    ...(ours.kind === "unknown" ? { unknownReason: ours.reason } : {}),
  };
}

function stepFailure(step: ActivityLogDeployStep, failure: ArmReadFailure): ActivityLogDeployOutcome {
  return { kind: failure.kind, step, status: failure.status, code: failure.code, message: failure.message };
}

/**
 * Create the cribl-activity-log diagnostic setting: the chosen namespace rule,
 * no hub name (Azure creates insights-activity-logs), every category on.
 *
 * Order, exactly: re-list the subscription's settings (refuse on
 * already-exists / present-differs / possible-duplicate / limit-reached), PUT,
 * GET by name. Never throws, never DELETEs, never re-PUTs. The caller has
 * already had the operator confirm.
 */
export async function deployActivityLogExport(
  azure: AzureManagement,
  input: ActivityLogDeployInput,
  logger?: Logger,
): Promise<ActivityLogDeployOutcome> {
  const context = {
    subscription: input.subscriptionId,
    namespace: input.namespace.name,
    rule: input.ruleName,
  };
  const done = (outcome: ActivityLogDeployOutcome): ActivityLogDeployOutcome => {
    const level = outcome.kind === "written-and-read-back" ? "info" : "warn";
    logger?.[level]("activity-log-export: deploy finished", {
      ...context,
      outcome: outcome.kind,
      ...("step" in outcome ? { step: outcome.step } : {}),
    });
    return outcome;
  };

  // 1. Re-list, and refuse on anything that would make this PUT replace a
  //    setting, duplicate the Activity Log, or exceed Azure's limit.
  const settings = await listSubscriptionSettings(azure, input.subscriptionId);
  if (settings.kind === "unread") {
    return done(stepFailure("setting-list", settings.failure));
  }
  const expected = expectedActivityLogSetting(input);
  const ours = classifyOursSetting(settings.listing, expected);
  if (ours.kind === "present-matching") {
    return done({ kind: "already-exists", settingId: ours.setting.id || activityLogSettingPath(input.subscriptionId) });
  }
  if (ours.kind === "present-differs") {
    return done({
      kind: "present-differs",
      settingId: ours.setting.id || activityLogSettingPath(input.subscriptionId),
      diffs: ours.diffs,
    });
  }
  const sameNamespace = findSameNamespaceSettings(settings.listing, input.namespace);
  if (sameNamespace.length > 0) {
    return done({ kind: "possible-duplicate", names: sameNamespace.map((s) => s.name) });
  }
  if (subscriptionSettingsFull(settings.listing)) {
    return done({
      kind: "limit-reached",
      limit: MAX_SUBSCRIPTION_DIAGNOSTIC_SETTINGS,
      names: settings.listing.kind === "rows" ? settings.listing.rows.map((s) => s.name) : [],
    });
  }

  // 2. PUT.
  const settingId = activityLogSettingPath(input.subscriptionId);
  const putAttempt = await attemptArm(() => azure.request(buildActivityLogSettingPutRequest(input)));
  if (!putAttempt.ok || !is2xx(putAttempt.response.status)) {
    return done(stepFailure("setting-put", classifyArmFailure(putAttempt, "Create the Activity Log setting")));
  }

  // 3. Read back by name and compare every field the PUT wrote.
  const readAttempt = await attemptArm(() =>
    azure.request(buildActivityLogSettingGetRequest(input.subscriptionId)),
  );
  if (!readAttempt.ok || !is2xx(readAttempt.response.status)) {
    const failure = classifyArmFailure(readAttempt, "Read the setting back");
    return done({ kind: "accepted-not-verified", settingId, reasons: [failure.message] });
  }
  const observed = readDiagnosticSetting(readAttempt.response.body);
  if (observed.name === "" && observed.id === "") {
    return done({
      kind: "accepted-not-verified",
      settingId,
      reasons: ["The read-back did not contain a diagnostic setting."],
    });
  }
  const diffs = activityLogSettingDiffs(expected, observed);
  if (diffs.length > 0) {
    return done({ kind: "accepted-not-verified", settingId, reasons: diffs.map(describeSettingDiff) });
  }
  return done({ kind: "written-and-read-back", settingId });
}
