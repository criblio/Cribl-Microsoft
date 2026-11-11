/**
 * Activity Log section state - every decision the Activity Log deploy section
 * shows, as pure functions (AZR-98). The component (activity-log-section.tsx)
 * only renders these and drives IO through the ports.
 *
 *   - {@link activityLogDeployDisabledReason}: why Deploy is disabled, ONE
 *     reason in a fixed priority, or null. The deploy usecase re-checks the
 *     refusals itself after the confirm; this only keeps the button honest.
 *   - {@link activityLogOutcomeMessage}: the deploy outcome in plain words.
 *   - {@link activityLogStateNote}: the caveat an unmeasured absence carries.
 *
 * Visible copy carries no card ids, dates or phases (the copy-history gate
 * reads these strings).
 *
 * Pure: no React, no IO.
 */

import {
  ACTIVITY_LOG_AUTO_HUB,
  ACTIVITY_LOG_ITEM_ID,
  ACTIVITY_LOG_SETTING_NAME,
  MAX_SUBSCRIPTION_DIAGNOSTIC_SETTINGS,
  classifyOursSetting,
  describeSettingDiff,
  expectedActivityLogSetting,
  findSameNamespaceSettings,
  ruleCanManage,
  selectedItemIds,
  subscriptionSettingsFull,
} from "@soc/core";
import type {
  ActivityLogDeployOutcome,
  ActivityLogDeployStep,
  ActivityLogState,
  CoverageSelection,
  NamespaceRef,
  OursSettingState,
} from "@soc/core";
import { unmeasuredInventoryMessage } from "../../capabilities/empty-inventory";
import type { PickerMessage } from "./azure-onboarding-state";

/** Everything the gate looks at. No capability set, on purpose: the audit never forbids. */
export interface ActivityLogDeployGate {
  readonly running: boolean;
  /** The loaded selection, or null when none was loaded. */
  readonly selection: CoverageSelection | null;
  /** The last read, or null when none has been made. */
  readonly state: ActivityLogState | null;
  /** The subscription the setting is written to; "" when none is configured. */
  readonly subscriptionId: string;
  readonly namespace: NamespaceRef | null;
  readonly rule: { readonly name: string; readonly rights: readonly string[] } | null;
}

/** The categories as the confirm and the section list them. */
export function categoriesText(categories: readonly string[]): string {
  return categories.join(", ");
}

/**
 * Our setting as the last read shows it, judged against the chosen rule once a
 * namespace and rule are chosen (so it says what the deploy would refuse
 * with), and without one before that. Null when the list was not read.
 */
export function oursForTarget(
  state: ActivityLogState | null,
  target: Pick<ActivityLogDeployGate, "subscriptionId" | "namespace" | "rule">,
): OursSettingState | null {
  if (state === null || state.settings.kind !== "listed") return null;
  const listing = state.settings.listing;
  return target.namespace !== null && target.rule !== null
    ? classifyOursSetting(
        listing,
        expectedActivityLogSetting({
          subscriptionId: target.subscriptionId,
          namespace: target.namespace,
          ruleName: target.rule.name,
        }),
      )
    : classifyOursSetting(listing);
}

/**
 * Why Deploy is disabled, or null when it may run. ONE reason, in this fixed
 * priority: running; no subscription; selection not loaded; not ticked; ours
 * exists and matches; ours differs; another setting feeds the namespace; the
 * subscription is full; state not read or unreadable; no namespace; no rule;
 * the rule cannot Manage.
 *
 * Ours is judged against the chosen rule once one is chosen, so the reason is
 * the same one the deploy would refuse with.
 */
export function activityLogDeployDisabledReason(gate: ActivityLogDeployGate): string | null {
  if (gate.running) return "A deploy is already running.";
  if (gate.subscriptionId === "") return "No Azure subscription is configured for this connection.";
  if (gate.selection === null) {
    return "The saved selection has not loaded, so whether the Activity Log is ticked is not known.";
  }
  if (!selectedItemIds(gate.selection).includes(ACTIVITY_LOG_ITEM_ID)) {
    return "Tick the Azure Activity Log to deploy it.";
  }
  const state = gate.state;
  if (state !== null && state.settings.kind === "listed") {
    const listing = state.settings.listing;
    const ours = oursForTarget(state, gate);
    if (ours?.kind === "present-matching") {
      return `${ACTIVITY_LOG_SETTING_NAME} already exists on this subscription - there is nothing to deploy.`;
    }
    if (ours?.kind === "present-differs") {
      return (
        `${ACTIVITY_LOG_SETTING_NAME} exists but differs from what this app writes: ` +
        `${ours.diffs.map(describeSettingDiff).join(" ")} Repairing it from here is not available yet.`
      );
    }
    if (gate.namespace !== null) {
      const others = findSameNamespaceSettings(listing, gate.namespace);
      if (others.length > 0) {
        return (
          "Another diagnostic setting already sends this subscription's Activity Log to this namespace: " +
          `${others.map((s) => s.name).join(", ")}. Deploying would deliver every event twice.`
        );
      }
    }
    if (subscriptionSettingsFull(listing)) {
      return (
        `This subscription already has ${MAX_SUBSCRIPTION_DIAGNOSTIC_SETTINGS} diagnostic settings, ` +
        "the most Azure allows. Remove one in Azure before adding this one."
      );
    }
  }
  if (state === null) return "Read the subscription's diagnostic settings first.";
  if (state.settings.kind === "unread") {
    return `The subscription's diagnostic settings could not be read - ${state.settings.failure.message}`;
  }
  if (gate.namespace === null) return "Choose the Event Hub namespace the Activity Log goes to.";
  if (gate.rule === null) return "Choose the namespace authorization rule the setting sends with.";
  if (!ruleCanManage(gate.rule.rights)) {
    const rights = gate.rule.rights.length > 0 ? gate.rule.rights.join(", ") : "no rights";
    return (
      `The selected rule has ${rights}. A diagnostic setting needs a rule with Manage rights, ` +
      `because Azure creates the ${ACTIVITY_LOG_AUTO_HUB} hub itself.`
    );
  }
  return null;
}

/**
 * The caveat for an absence that was not measured: the list came back empty,
 * which an access-filtered list also does. Deploy stays enabled - an empty list
 * is the normal answer for a fresh subscription - so this is a note, not a
 * reason.
 */
export const ACTIVITY_LOG_UNCONFIRMED_ABSENT_NOTE =
  `${unmeasuredInventoryMessage("diagnostic settings").text}, so the duplicate check had nothing to compare against.`;

/** A caveat about the last read, or null when it has none. */
export function activityLogStateNote(state: ActivityLogState | null): PickerMessage | null {
  if (state === null || state.ours.kind !== "absent" || state.ours.measured) return null;
  return { tone: "warning", text: ACTIVITY_LOG_UNCONFIRMED_ABSENT_NOTE };
}

/** The caveat every success carries. */
export const ACTIVITY_LOG_DELIVERY_NOT_VERIFIED =
  `Delivery is not verified until an Activity Log event arrives in the ${ACTIVITY_LOG_AUTO_HUB} hub.`;

const STEP_LABELS: Readonly<Record<ActivityLogDeployStep, string>> = {
  "setting-list": "listing the subscription's diagnostic settings",
  "setting-put": "creating the diagnostic setting",
};

/** The deploy outcome as the screen says it. */
export function activityLogOutcomeMessage(outcome: ActivityLogDeployOutcome): PickerMessage {
  switch (outcome.kind) {
    case "written-and-read-back":
      return {
        tone: "info",
        text: `${ACTIVITY_LOG_SETTING_NAME} was created and read back from Azure. ${ACTIVITY_LOG_DELIVERY_NOT_VERIFIED}`,
      };
    case "accepted-not-verified":
      return {
        tone: "warning",
        text:
          `Azure accepted ${ACTIVITY_LOG_SETTING_NAME}, but reading it back did not confirm it: ` +
          `${outcome.reasons.join(" ")} ${ACTIVITY_LOG_DELIVERY_NOT_VERIFIED}`,
      };
    case "already-exists":
      return { tone: "info", text: `Nothing was written: ${ACTIVITY_LOG_SETTING_NAME} already exists on this subscription.` };
    case "present-differs":
      return {
        tone: "warning",
        text:
          `Nothing was written: ${ACTIVITY_LOG_SETTING_NAME} exists but differs - ` +
          outcome.diffs.map(describeSettingDiff).join(" "),
      };
    case "possible-duplicate":
      return {
        tone: "warning",
        text:
          "Nothing was written: another diagnostic setting already sends the Activity Log to this namespace, " +
          `so every event would arrive twice: ${outcome.names.join(", ")}.`,
      };
    case "limit-reached":
      return {
        tone: "warning",
        text:
          `Nothing was written: this subscription already has ${outcome.limit} diagnostic settings, the most Azure ` +
          `allows (${outcome.names.join(", ")}).`,
      };
    case "denied":
    case "unregistered":
    case "failed":
      return { tone: "error", text: `Deploy stopped at ${STEP_LABELS[outcome.step]}. ${outcome.message}` };
  }
}
