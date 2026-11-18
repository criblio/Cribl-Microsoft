/**
 * The Entra ID tenant diagnostic setting - the USECASES (AZR-99, on the AZR-18
 * Azure Native Source Onboarding screen). Modelled on the Activity Log export
 * (usecases/activity-log-export), over the AzureManagement port:
 *
 * - {@link readEntraSettingState}: the tenant's Entra diagnostic settings, and
 *   whether ours ({@link ENTRA_SETTING_NAME}) exists.
 * - {@link deployEntraSetting}: create ours. CREATE-ONLY.
 * - {@link removeEntraSetting}: delete ours, once proven the app's.
 *
 * WHY DEPLOY RE-LISTS AND REFUSES. A diagnostic setting PUT replaces the
 * setting whole, and the tenant's Entra settings are shared by every team.
 * Between the screen's read and the operator's confirm anything may have
 * changed, so deploy lists again first and REFUSES - it never repairs or
 * replaces - when:
 *
 *   unknown-categories   a chosen category this app cannot express (named)
 *   already-exists       ours exists and matches - "already applied", whoever
 *                        made it (a hand-made one from the How-to included)
 *   present-differs      ours exists but differs: the app did not write it
 *                        this way, so it is never overwritten (fields named)
 *   possible-duplicate   another setting already sends a chosen category to
 *                        the same namespace, so those events would arrive twice
 *
 * THEN, in this order and nothing else: PUT, GET it back by name. A read-back
 * that matches is `written-and-read-back`; anything short of that after an
 * accepted PUT is `accepted-not-verified` with the fields named - including
 * every chosen category that did not come back enabled, which is how a
 * category the tenant is not licensed for is named rather than dropped.
 *
 * THE ROLE IS UNMEASURABLE HERE. The write needs an Entra directory role
 * (Security Administrator or Global Administrator); a refusal is `denied` with
 * the step named, as Azure gave it.
 *
 * Never throws. Pure orchestration over the port: no IO of its own.
 */

import type { AzureManagement } from "../../ports/azure-management";
import type { Logger } from "../../ports/logger";
import { attemptArm, classifyArmFailure, is2xx } from "../arm-http";
import type { ArmReadFailure } from "../arm-http";
import type { OnboardingItemId } from "../../domain/onboarding-selection";
import { readDiagnosticSetting } from "../../domain/activity-log-export/diagnostic-setting";
import type { OursSettingState, SettingDiff } from "../../domain/activity-log-export/activity-log-setting";
import { describeSettingDiff } from "../../domain/activity-log-export/activity-log-setting";
import {
  buildEntraSettingDeleteRequest,
  buildEntraSettingGetRequest,
  buildEntraSettingPutRequest,
  listSettingsRequest,
} from "../../domain/entra-diagnostics/entra-diagnostic-setting";
import type { EntraSettingInput } from "../../domain/entra-diagnostics/entra-setting-deploy";
import {
  ENTRA_ITEM_ID,
  ENTRA_SETTING_NAME,
  classifyOursEntraSetting,
  entraDiagnosticInputFor,
  entraOurSettingPath,
  entraSettingDiffs,
  expectedEntraSetting,
  findOverlappingEntraSettings,
  unknownEntraCategories,
} from "../../domain/entra-diagnostics/entra-setting-deploy";
import { classifyEntraSettingRemoval } from "../../domain/onboarding-teardown/teardown-plan";
import type { ActivityLogSettingLookup } from "../../domain/onboarding-teardown/teardown-plan";
import type { EntraSettingRecord } from "../../domain/onboarding-howto/progress-document";
import { listDiagnosticSettings } from "../activity-log-export/activity-log-export";
import type { ActivityLogSettingsState } from "../activity-log-export/activity-log-export";

export { ENTRA_ITEM_ID };

/** The tenant's Entra diagnostic settings, or why they could not be read. */
export type EntraSettingsState = ActivityLogSettingsState;

/** Our setting, or why we cannot say. `unknown` is never shown as absent. */
export type EntraOursReading = OursSettingState | { readonly kind: "unknown"; readonly reason: string };

/** What {@link readEntraSettingState} returns. */
export interface EntraSettingState {
  readonly settings: EntraSettingsState;
  readonly ours: EntraOursReading;
  /** `[ENTRA_ITEM_ID]` ONLY when ours is present-matching. */
  readonly deployed: readonly OnboardingItemId[];
  /** Set exactly when ours is `unknown`: the reason, for the row label. */
  readonly unknownReason?: string;
}

export type EntraDeployInput = EntraSettingInput;

/** The deploy steps, named in denied / unregistered / failed outcomes. */
export type EntraDeployStep = "setting-list" | "setting-put";

/** Every way {@link deployEntraSetting} can end. */
export type EntraDeployOutcome =
  | { readonly kind: "written-and-read-back"; readonly settingId: string }
  | { readonly kind: "accepted-not-verified"; readonly settingId: string; readonly reasons: readonly string[] }
  | { readonly kind: "already-exists"; readonly settingId: string }
  | { readonly kind: "present-differs"; readonly settingId: string; readonly diffs: readonly SettingDiff[] }
  | { readonly kind: "possible-duplicate"; readonly names: readonly string[] }
  | { readonly kind: "unknown-categories"; readonly names: readonly string[] }
  | {
      readonly kind: "denied" | "unregistered" | "failed";
      readonly step: EntraDeployStep;
      readonly status: number | null;
      readonly code: string;
      readonly message: string;
    };

const LIST_WHAT = "List the tenant's Entra ID diagnostic settings";

function listTenantSettings(azure: AzureManagement): Promise<EntraSettingsState> {
  return listDiagnosticSettings(azure, listSettingsRequest(), LIST_WHAT, "a tenant's Entra settings");
}

/**
 * Read the tenant's Entra state: one list of its diagnostic settings. Ours is
 * classified without an expected rule or categories - the operator may not
 * have chosen them yet. Never throws; never writes.
 */
export async function readEntraSettingState(azure: AzureManagement, logger?: Logger): Promise<EntraSettingState> {
  const settings = await listTenantSettings(azure);
  const ours: EntraOursReading =
    settings.kind === "listed"
      ? classifyOursEntraSetting(settings.listing)
      : { kind: "unknown", reason: settings.failure.message };
  logger?.info("entra-diagnostic-export: state read", {
    settings: settings.kind === "listed" ? settings.listing.kind : settings.failure.kind,
    ours: ours.kind,
  });
  return {
    settings,
    ours,
    deployed: ours.kind === "present-matching" ? [ENTRA_ITEM_ID] : [],
    ...(ours.kind === "unknown" ? { unknownReason: ours.reason } : {}),
  };
}

function stepFailure(step: EntraDeployStep, failure: ArmReadFailure): EntraDeployOutcome {
  return { kind: failure.kind, step, status: failure.status, code: failure.code, message: failure.message };
}

/**
 * Create CriblEntraIDLogs: the plan's rule, no hub name (Azure creates one hub
 * per category), the chosen categories enabled and the rest written disabled.
 *
 * Order, exactly: refuse unknown categories; re-list the tenant's settings
 * (refuse already-exists / present-differs / possible-duplicate); PUT; GET by
 * name. Never throws, never DELETEs, never re-PUTs. The caller has already
 * had the operator confirm.
 */
export async function deployEntraSetting(
  azure: AzureManagement,
  input: EntraDeployInput,
  logger?: Logger,
): Promise<EntraDeployOutcome> {
  const done = (outcome: EntraDeployOutcome): EntraDeployOutcome => {
    logger?.[outcome.kind === "written-and-read-back" ? "info" : "warn"]("entra-diagnostic-export: deploy finished", {
      namespace: input.namespace.name,
      rule: input.ruleName,
      categories: input.categories.length,
      outcome: outcome.kind,
      ...("step" in outcome ? { step: outcome.step } : {}),
    });
    return outcome;
  };
  const settingId = entraOurSettingPath();

  // 0. A category this app cannot express is refused by name, before any call.
  const unknown = unknownEntraCategories(input.categories);
  if (unknown.length > 0) return done({ kind: "unknown-categories", names: unknown });

  // 1. Re-list, and refuse on anything that would make this PUT replace a
  //    setting or duplicate a category.
  const settings = await listTenantSettings(azure);
  if (settings.kind === "unread") return done(stepFailure("setting-list", settings.failure));
  const expected = expectedEntraSetting(input);
  const ours = classifyOursEntraSetting(settings.listing, expected);
  if (ours.kind === "present-matching") return done({ kind: "already-exists", settingId: ours.setting.id || settingId });
  if (ours.kind === "present-differs") {
    return done({ kind: "present-differs", settingId: ours.setting.id || settingId, diffs: ours.diffs });
  }
  const overlapping = findOverlappingEntraSettings(settings.listing, input.namespace, input.categories);
  if (overlapping.length > 0) return done({ kind: "possible-duplicate", names: overlapping.map((s) => s.name) });

  // 2. PUT.
  const put = await attemptArm(() => azure.request(buildEntraSettingPutRequest(entraDiagnosticInputFor(input))));
  if (!put.ok || !is2xx(put.response.status)) {
    return done(stepFailure("setting-put", classifyArmFailure(put, `Create the Entra ID setting ${ENTRA_SETTING_NAME}`)));
  }

  // 3. Read back by name and compare every field the PUT wrote.
  const read = await attemptArm(() => azure.request(buildEntraSettingGetRequest(ENTRA_SETTING_NAME)));
  if (!read.ok || !is2xx(read.response.status)) {
    return done({ kind: "accepted-not-verified", settingId, reasons: [classifyArmFailure(read, "Read the setting back").message] });
  }
  const observed = readDiagnosticSetting(read.response.body);
  if (observed.name === "" && observed.id === "") {
    return done({ kind: "accepted-not-verified", settingId, reasons: ["The read-back did not contain a diagnostic setting."] });
  }
  const diffs = entraSettingDiffs(expected, observed);
  if (diffs.length > 0) return done({ kind: "accepted-not-verified", settingId, reasons: diffs.map(describeSettingDiff) });
  return done({ kind: "written-and-read-back", settingId });
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

export type EntraRemoveStep = "setting-read" | "setting-delete";

export type EntraRemoveOutcome =
  | { readonly kind: "removed"; readonly settingId: string }
  | { readonly kind: "removed-not-confirmed"; readonly settingId: string; readonly reason: string }
  | { readonly kind: "already-gone"; readonly settingId: string }
  | { readonly kind: "not-proven"; readonly settingId: string; readonly detail: string }
  | {
      readonly kind: "denied" | "unregistered" | "failed";
      readonly step: EntraRemoveStep;
      readonly status: number | null;
      readonly code: string;
      readonly message: string;
    };

export interface EntraRemoveInput {
  /** The connection's tenant: the record must name it. */
  readonly tenantId: string;
  /** The app's KV record for this tenant, or null when it has none. */
  readonly record: EntraSettingRecord | null;
}

/**
 * Remove the app's Entra ID setting after the operator confirmed - the same
 * order as the Activity Log removal: GET by name (a 404 is already gone),
 * prove it the app's (classifyEntraSettingRemoval), DELETE, GET again (a 404
 * confirms). No Pause: a diagnostic setting has no switch of its own. Never
 * throws.
 */
export async function removeEntraSetting(
  azure: AzureManagement,
  input: EntraRemoveInput,
  logger?: Logger,
): Promise<EntraRemoveOutcome> {
  const settingId = entraOurSettingPath();
  const done = (outcome: EntraRemoveOutcome): EntraRemoveOutcome => {
    const level = outcome.kind === "removed" || outcome.kind === "already-gone" ? "info" : "warn";
    logger?.[level]("entra-diagnostic-export: remove finished", { outcome: outcome.kind });
    return outcome;
  };
  const failure = (step: EntraRemoveStep, f: ArmReadFailure): EntraRemoveOutcome => ({
    kind: f.kind,
    step,
    status: f.status,
    code: f.code,
    message: f.message,
  });

  // 1. Read it now, by name.
  const read = await attemptArm(() => azure.request(buildEntraSettingGetRequest(ENTRA_SETTING_NAME)));
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
        message: `Read ${ENTRA_SETTING_NAME}: HTTP ${read.response.status}, but the answer was not a diagnostic setting. Nothing was removed.`,
      });
    }
    lookup = { kind: "found", setting };
  } else return done(failure("setting-read", classifyArmFailure(read, `Read ${ENTRA_SETTING_NAME}`)));

  const verdict = classifyEntraSettingRemoval(lookup, input.record, input.tenantId);
  if (verdict.kind === "already-gone") return done({ kind: "already-gone", settingId });
  if (verdict.kind === "not-proven") return done({ kind: "not-proven", settingId, detail: verdict.detail });

  // 2. Delete.
  const del = await attemptArm(() => azure.request(buildEntraSettingDeleteRequest(ENTRA_SETTING_NAME)));
  if (!del.ok || !is2xx(del.response.status)) {
    return done(failure("setting-delete", classifyArmFailure(del, `Remove ${ENTRA_SETTING_NAME}`)));
  }

  // 3. Confirm it no longer reads.
  const after = await attemptArm(() => azure.request(buildEntraSettingGetRequest(ENTRA_SETTING_NAME)));
  if (after.ok && after.response.status === 404) return done({ kind: "removed", settingId });
  const reason =
    after.ok && is2xx(after.response.status)
      ? "Azure accepted the removal, but the setting still reads back."
      : classifyArmFailure(after, "Read the setting after the removal").message;
  return done({ kind: "removed-not-confirmed", settingId, reason });
}
