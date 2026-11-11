/**
 * The subscription Activity Log export - THE DIAGNOSTIC SETTING, how to build
 * it and how to recognise one that already exists.
 *
 * AZR-98. The Activity Log reaches an Event Hub through ONE subscription-scope
 * resource, `Microsoft.Insights/diagnosticSettings/{name}` under
 * `/subscriptions/{sub}/providers`. The same shape the hand-made test setting
 * of 2026-11-04 used (AZR-34), and the shape the community policy's
 * deployIfNotExists writes on the How-to path.
 *
 * THE BODY, AND WHAT IS LEFT OUT ON PURPOSE:
 *
 * - `eventHubAuthorizationRuleId` is the chosen NAMESPACE rule's id. A
 *   diagnostic setting takes the rule id, never a connection string, so no
 *   listKeys is made and no secret exists anywhere in this flow.
 * - `eventHubName` is OMITTED. Azure then creates and writes to
 *   `insights-activity-logs` itself, which is the hub onboarding-howto/sources
 *   expects for this source. Because Azure creates the hub, the rule needs
 *   Manage rights as well as Send (the How-to step eh-rule-diagnostic says the
 *   same; inferred from Azure Monitor documentation, not measured live).
 * - `logs` enables EVERY Activity Log category ({@link ACTIVITY_LOG_CATEGORIES}).
 *   No metrics: the Activity Log has none.
 *
 * NOTHING IS REPLACED. A PUT of a diagnostic setting replaces it whole. This
 * module supplies the reads that make create-only possible:
 * {@link classifyOursSetting} finds our setting by name, and
 * {@link findSameNamespaceSettings} finds any OTHER setting already sending
 * to the chosen namespace - a second one would deliver every event twice.
 *
 * AZURE'S LIMIT. A subscription holds at most
 * {@link MAX_SUBSCRIPTION_DIAGNOSTIC_SETTINGS} diagnostic settings (Azure
 * Monitor documentation; the shape of Azure's refusal past it is not measured
 * here), so a full subscription is refused before the PUT rather than after.
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto. The caller
 * performs every request.
 */

import type { AzureManagementRequest } from "../../ports/azure-management";
import type { NamespaceRef } from "../eventhub-arm/eventhub-arm";
import { eventHubNamespacePath, namespaceRuleResourceId } from "../eventhub-arm/eventhub-arm";
import type { Listing } from "../inventory-listing/inventory-listing";
import { listingCount, listingRows, listingWasRead } from "../inventory-listing/inventory-listing";
import type { OnboardingSourceId } from "../onboarding-howto/sources";
import type { DiagnosticSettingRead } from "./diagnostic-setting";
import { settingTargetsNamespace } from "./diagnostic-setting";

/**
 * api-version for subscription diagnostic settings - the one Validate has
 * always read them with. INFERRED: the current Microsoft.Insights
 * diagnosticSettings version; on the live-verification list.
 */
export const SUBSCRIPTION_DIAGNOSTIC_SETTINGS_API_VERSION = "2021-05-01-preview";

/**
 * The coverage-catalog item (and How-to source) this setting deploys - the
 * ONE declaration of the id here. Typed as the source-id union so a
 * misspelling fails typecheck.
 */
export const ACTIVITY_LOG_ITEM_ID = "activityLog" satisfies OnboardingSourceId;

/** The diagnostic setting's name. Spelled once; every reader compares against it. */
export const ACTIVITY_LOG_SETTING_NAME = "cribl-activity-log";

/**
 * Every Activity Log category, in the order Azure lists them. All are enabled:
 * Cribl decides what to keep, and a category left off here would be silently
 * missing downstream.
 */
export const ACTIVITY_LOG_CATEGORIES: readonly string[] = [
  "Administrative",
  "Security",
  "ServiceHealth",
  "Alert",
  "Recommendation",
  "Policy",
  "Autoscale",
  "ResourceHealth",
];

/** Azure's limit on diagnostic settings per subscription (documented, not measured). */
export const MAX_SUBSCRIPTION_DIAGNOSTIC_SETTINGS = 5;

/** The hub Azure creates when eventHubName is omitted, for the operator's copy. */
export const ACTIVITY_LOG_AUTO_HUB = "insights-activity-logs";

/** What the PUT needs. No secret: a diagnostic setting takes the rule id. */
export interface ActivityLogSettingInput {
  readonly subscriptionId: string;
  readonly namespace: NamespaceRef;
  /** A namespace-level rule with Manage rights; the UI offers and gates it. */
  readonly ruleName: string;
}

/** The PUT this module builds. */
export interface ActivityLogSettingPutRequest extends AzureManagementRequest {
  readonly method: "PUT";
  readonly body: {
    readonly properties: {
      readonly eventHubAuthorizationRuleId: string;
      readonly logs: readonly { readonly category: string; readonly enabled: true }[];
    };
  };
}

/** What a correctly-written setting must look like. */
export interface ExpectedActivityLogSetting {
  readonly ruleId: string;
}

/** One field that falls short, named the way the ARM body names it. */
export interface SettingDiff {
  readonly field: "eventHubAuthorizationRuleId" | "eventHubName" | "logs" | "name";
  readonly expected: string;
  readonly actual: string;
}

function sameId(a: string, b: string): boolean {
  // ARM ids and names are case-insensitive; Azure itself returns mixed casing.
  return a.toLowerCase() === b.toLowerCase();
}

/** The subscription-scope path every subscription diagnostic setting lives under. */
export function subscriptionDiagnosticSettingsPath(subscriptionId: string): string {
  return `/subscriptions/${subscriptionId}/providers/Microsoft.Insights/diagnosticSettings`;
}

/** The resource path the PUT writes to, which is also our setting's id. */
export function activityLogSettingPath(subscriptionId: string): string {
  return `${subscriptionDiagnosticSettingsPath(subscriptionId)}/${ACTIVITY_LOG_SETTING_NAME}`;
}

/** The GET that lists every diagnostic setting of the subscription. A GET changes nothing. */
export function buildSubscriptionDiagnosticSettingsListRequest(
  subscriptionId: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path: subscriptionDiagnosticSettingsPath(subscriptionId),
    apiVersion: SUBSCRIPTION_DIAGNOSTIC_SETTINGS_API_VERSION,
  };
}

/** The GET that reads our setting back by name, after the PUT. */
export function buildActivityLogSettingGetRequest(subscriptionId: string): AzureManagementRequest {
  return {
    method: "GET",
    path: activityLogSettingPath(subscriptionId),
    apiVersion: SUBSCRIPTION_DIAGNOSTIC_SETTINGS_API_VERSION,
  };
}

/** The shape the PUT below writes, for comparing a read-back. */
export function expectedActivityLogSetting(input: ActivityLogSettingInput): ExpectedActivityLogSetting {
  return { ruleId: namespaceRuleResourceId(input.namespace, input.ruleName) };
}

/**
 * Build the create PUT: the chosen rule, no hub name, every category on.
 *
 * The caller must have listed the subscription's settings first and found
 * neither {@link classifyOursSetting}, {@link findSameNamespaceSettings} nor
 * the limit objecting - this PUT replaces whatever is at the path, and this
 * builder cannot know.
 */
export function buildActivityLogSettingPutRequest(input: ActivityLogSettingInput): ActivityLogSettingPutRequest {
  return {
    method: "PUT",
    path: activityLogSettingPath(input.subscriptionId),
    apiVersion: SUBSCRIPTION_DIAGNOSTIC_SETTINGS_API_VERSION,
    body: {
      properties: {
        eventHubAuthorizationRuleId: expectedActivityLogSetting(input).ruleId,
        logs: ACTIVITY_LOG_CATEGORIES.map((category) => ({ category, enabled: true as const })),
      },
    },
  };
}

/** True when `ruleId` names an authorization rule on an Event Hub namespace. */
function isNamespaceRuleId(ruleId: string): boolean {
  return /\/providers\/microsoft\.eventhub\/namespaces\/[^/]+\/authorizationrules\/[^/]+$/i.test(ruleId);
}

/**
 * Every field where `observed` falls short of a working Activity Log export,
 * named as the ARM body names it. Empty means it matches.
 *
 * With `expected`, the rule must be the expected one - the read-back after our
 * own PUT, or the deploy's re-check against the chosen rule. Without it, any
 * namespace rule is enough - classifying a setting before a target is chosen.
 */
export function activityLogSettingDiffs(
  expected: ExpectedActivityLogSetting | undefined,
  observed: DiagnosticSettingRead,
): SettingDiff[] {
  const diffs: SettingDiff[] = [];
  if (expected !== undefined) {
    if (!sameId(observed.ruleId, expected.ruleId)) {
      diffs.push({
        field: "eventHubAuthorizationRuleId",
        expected: expected.ruleId,
        actual: observed.ruleId || "(none)",
      });
    }
  } else if (!isNamespaceRuleId(observed.ruleId)) {
    diffs.push({
      field: "eventHubAuthorizationRuleId",
      expected: "an Event Hub namespace authorization rule",
      actual: observed.ruleId || "(none)",
    });
  }
  if (observed.hub !== "") {
    diffs.push({
      field: "eventHubName",
      expected: `(none: Azure writes to ${ACTIVITY_LOG_AUTO_HUB})`,
      actual: observed.hub,
    });
  }
  const off = ACTIVITY_LOG_CATEGORIES.filter((c) => !observed.enabled.some((e) => sameId(e, c)));
  if (off.length > 0) {
    diffs.push({ field: "logs", expected: "every Activity Log category enabled", actual: `not enabled: ${off.join(", ")}` });
  }
  return diffs;
}

/** One diff as a sentence the screen can show. */
export function describeSettingDiff(diff: SettingDiff): string {
  return `${diff.field}: expected ${diff.expected}, found ${diff.actual}.`;
}

/** What the subscription already holds under our name. */
export type OursSettingState =
  | {
      readonly kind: "absent";
      /**
       * True when the list behind this was READ (it had rows, none ours).
       * False when it came back empty, which for a raw ARM list cannot be told
       * apart from a list we were not shown (inventory-listing).
       */
      readonly measured: boolean;
    }
  | { readonly kind: "present-matching"; readonly setting: DiagnosticSettingRead }
  | {
      readonly kind: "present-differs";
      readonly setting: DiagnosticSettingRead;
      readonly diffs: readonly SettingDiff[];
    };

/**
 * Find {@link ACTIVITY_LOG_SETTING_NAME} in the listing, by name
 * (case-insensitively). Only `present-matching` means deployed.
 */
export function classifyOursSetting(
  listing: Listing<DiagnosticSettingRead>,
  expected?: ExpectedActivityLogSetting,
): OursSettingState {
  const ours = listingRows(listing).find((s) => sameId(s.name, ACTIVITY_LOG_SETTING_NAME));
  if (ours === undefined) return { kind: "absent", measured: listingWasRead(listing) };
  const diffs = activityLogSettingDiffs(expected, ours);
  return diffs.length === 0
    ? { kind: "present-matching", setting: ours }
    : { kind: "present-differs", setting: ours, diffs };
}

/**
 * Every OTHER setting (any name but ours) whose rule lives in the chosen
 * namespace. Deploying beside one would put a second copy of the Activity Log
 * into the namespace Cribl reads. Ours is left out because
 * {@link classifyOursSetting} already answers for it.
 */
export function findSameNamespaceSettings(
  listing: Listing<DiagnosticSettingRead>,
  namespace: NamespaceRef,
): DiagnosticSettingRead[] {
  const nsPath = eventHubNamespacePath(namespace);
  return listingRows(listing).filter(
    (s) => !sameId(s.name, ACTIVITY_LOG_SETTING_NAME) && settingTargetsNamespace(s, nsPath),
  );
}

/**
 * True when the subscription already holds Azure's maximum of diagnostic
 * settings, so a new one cannot be added. Counts only what was listed: an
 * unverified empty list is never full.
 */
export function subscriptionSettingsFull(listing: Listing<DiagnosticSettingRead>): boolean {
  // An unverified empty list counts as 0 here: it cannot prove the limit reached.
  return listingCount(listing, 0) >= MAX_SUBSCRIPTION_DIAGNOSTIC_SETTINGS;
}
