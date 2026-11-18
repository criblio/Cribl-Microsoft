/**
 * Entra ID setting section state - every decision the Entra ID deploy section
 * and its Remove show, as pure functions (AZR-99). The components
 * (entra-setting-section.tsx, entra-remove-panel.tsx) only render these and
 * drive IO through the ports.
 *
 *   - {@link entraDeployDisabledReason}: why Deploy is disabled, ONE reason in
 *     a fixed priority, or null. The deploy usecase re-checks the refusals
 *     itself after the confirm; this only keeps the button honest.
 *   - {@link entraDeployConfirmText}: the confirm, quoting the exact setting
 *     name, categories and target.
 *   - {@link entraOutcomeMessage} / {@link entraRemoveMessage}: outcomes in
 *     plain words.
 *
 * Visible copy carries no card ids, dates or phases (the copy-history gate
 * reads these strings).
 *
 * Pure: no React, no IO.
 */

import {
  ENTRA_AUTO_HUB_TEXT,
  ENTRA_SETTING_NAME,
  classifyOursEntraSetting,
  describeSettingDiff,
  eventHubNamespacePath,
  expectedEntraSetting,
  findOverlappingEntraSettings,
  ruleCanManage,
} from "@soc/core";
import type {
  EntraDeployOutcome,
  EntraDeployStep,
  EntraRemoveOutcome,
  EntraRemoveStep,
  EntraSettingInput,
  EntraSettingRecord,
  EntraSettingState,
  OursSettingState,
} from "@soc/core";
import { unmeasuredInventoryMessage } from "../../capabilities/empty-inventory";
import { choiceDeployBlock } from "./azure-onboarding-state";
import type { PickerMessage, RowChoice } from "./azure-onboarding-state";
import type { EventHubTarget } from "./eventhub-prerequisite-section";

/** The source's noun in the shared choice copy. */
export const ENTRA_NOUN = "Entra ID diagnostic setting";

/** The plan value keys the Deploy reads, as the operator knows them. */
const VALUE_LABELS: Readonly<Record<string, string>> = {
  eventHubSubscriptionId: "the Event Hub subscription",
  eventHubResourceGroup: "the Event Hub resource group",
  namespace: "the Event Hub namespace",
  sendRule: "the Send rule",
};

/** The Deploy's target from the plan (core entraDeployTarget), or null while progress is not loaded. */
export type EntraTarget = { readonly input: EntraSettingInput | null; readonly missing: readonly string[] } | null;

/** Everything the gate looks at. No capability set, on purpose: the audit never forbids. */
export interface EntraDeployGate {
  readonly running: boolean;
  readonly choice: RowChoice;
  readonly state: EntraSettingState | null;
  /** The connection's tenant; "" when none is configured. */
  readonly tenantId: string;
  readonly target: EntraTarget;
  /**
   * The rights of the plan's rule when section 1 picked that same rule (so
   * they were read), else null: not known, and never guessed.
   */
  readonly ruleRights: readonly string[] | null;
}

/**
 * The rights of the plan's rule, when section 1's pick IS that rule on that
 * namespace; null otherwise (the operator's own names, or nothing picked).
 */
export function planRuleRights(target: EventHubTarget, input: EntraSettingInput | null): readonly string[] | null {
  if (input === null || target.namespace === null || target.rule === null) return null;
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  if (!same(eventHubNamespacePath(target.namespace), eventHubNamespacePath(input.namespace))) return null;
  return same(target.rule.name, input.ruleName) ? target.rule.rights : null;
}

/** Ours as the last read shows it, judged against the target once there is one. Null when not read. */
export function entraOursForTarget(state: EntraSettingState | null, input: EntraSettingInput | null): OursSettingState | null {
  if (state === null || state.settings.kind !== "listed") return null;
  return input === null
    ? classifyOursEntraSetting(state.settings.listing)
    : classifyOursEntraSetting(state.settings.listing, expectedEntraSetting(input));
}

/**
 * Why Deploy is disabled, or null when it may run. ONE reason, in this fixed
 * priority: running; no tenant; not chosen in Automate; progress not loaded;
 * plan values missing; ours exists and matches (already applied); ours
 * differs; another setting already sends a chosen category to the namespace;
 * state not read or unreadable; the plan's rule measured without Manage.
 */
export function entraDeployDisabledReason(gate: EntraDeployGate): string | null {
  if (gate.running) return "A deploy is already running.";
  if (gate.tenantId.trim() === "") return "No Azure tenant is configured for this connection.";
  const blocked = choiceDeployBlock(gate.choice, ENTRA_NOUN);
  if (blocked !== null) return blocked;
  if (gate.target === null) return "The Event Hub plan values are still loading.";
  const input = gate.target.input;
  if (input === null) {
    const labels = gate.target.missing.map((k) => VALUE_LABELS[k] ?? k);
    const names = labels.length <= 1 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1] ?? ""}`;
    return `The plan does not name ${names} yet. Choose them in the Event Hub section, or set them under How to set it up yourself.`;
  }
  const state = gate.state;
  if (state !== null && state.settings.kind === "listed") {
    const ours = entraOursForTarget(state, input);
    if (ours?.kind === "present-matching") {
      return `${ENTRA_SETTING_NAME} is already applied in this tenant, exactly as this app would write it - there is nothing to deploy.`;
    }
    if (ours?.kind === "present-differs") {
      return (
        `${ENTRA_SETTING_NAME} exists in this tenant but differs from what this app writes: ` +
        `${ours.diffs.map(describeSettingDiff).join(" ")} The app does not overwrite a setting it did not write this way; change or remove it in the Microsoft Entra admin center.`
      );
    }
    const others = findOverlappingEntraSettings(state.settings.listing, input.namespace, input.categories);
    if (others.length > 0) {
      return (
        "Another Entra ID diagnostic setting already sends a chosen category to this namespace: " +
        `${others.map((s) => s.name).join(", ")}. Deploying would deliver those events twice.`
      );
    }
  }
  if (state === null) return "Read the tenant's Entra ID diagnostic settings first.";
  if (state.settings.kind === "unread") {
    return `The tenant's Entra ID diagnostic settings could not be read - ${state.settings.failure.message}`;
  }
  if (gate.ruleRights !== null && !ruleCanManage(gate.ruleRights)) {
    const rights = gate.ruleRights.length > 0 ? gate.ruleRights.join(", ") : "no rights";
    return (
      `The rule ${input.ruleName} has ${rights}. An Entra ID diagnostic setting needs a rule with Manage rights, ` +
      "because Azure creates one hub per category itself."
    );
  }
  return null;
}

/** The confirm, quoting exactly what is created. */
export function entraDeployConfirmText(tenantId: string, input: EntraSettingInput, profile: string): string {
  return (
    `Create the Entra ID diagnostic setting ${ENTRA_SETTING_NAME} in tenant ${tenantId}, ` +
    `sending to namespace ${input.namespace.name} (resource group ${input.namespace.resourceGroup}, subscription ${input.namespace.subscriptionId}) ` +
    `with rule ${input.ruleName} (${ENTRA_AUTO_HUB_TEXT}), with the ${profile} categories enabled: ${input.categories.join(", ")}? ` +
    "Every other category is written as disabled. This creates one tenant-wide setting in Microsoft Entra ID."
  );
}

/** The caveat for an absence that was not measured (the list came back empty). */
export const ENTRA_UNCONFIRMED_ABSENT_NOTE =
  `${unmeasuredInventoryMessage("Entra ID diagnostic settings").text}, so the duplicate check had nothing to compare against.`;

/** A caveat about the last read, or null when it has none. */
export function entraStateNote(state: EntraSettingState | null): PickerMessage | null {
  if (state === null || state.ours.kind !== "absent" || state.ours.measured) return null;
  return { tone: "warning", text: ENTRA_UNCONFIRMED_ABSENT_NOTE };
}

/** The caveat every success carries. */
export const ENTRA_DELIVERY_NOT_VERIFIED =
  "Delivery is not verified until sign-in or audit events arrive in the namespace; Microsoft notes the first logs can take up to three days to appear.";

const STEP_LABELS: Readonly<Record<EntraDeployStep, string>> = {
  "setting-list": "listing the tenant's Entra ID diagnostic settings",
  "setting-put": "creating the diagnostic setting",
};

/** A denial at either step is most likely the directory role, which the app cannot check. */
const ROLE_HINT =
  " Writing an Entra ID diagnostic setting needs the Security Administrator or Global Administrator directory role; the app cannot check that before it runs.";

/** The deploy outcome as the screen says it. */
export function entraOutcomeMessage(outcome: EntraDeployOutcome): PickerMessage {
  switch (outcome.kind) {
    case "written-and-read-back":
      return { tone: "info", text: `${ENTRA_SETTING_NAME} was created and read back from Azure. ${ENTRA_DELIVERY_NOT_VERIFIED}` };
    case "accepted-not-verified":
      return {
        tone: "warning",
        text:
          `Azure accepted ${ENTRA_SETTING_NAME}, but reading it back did not confirm it: ${outcome.reasons.join(" ")} ` +
          `A chosen category the tenant is not licensed for can read back as not enabled. ${ENTRA_DELIVERY_NOT_VERIFIED}`,
      };
    case "already-exists":
      return { tone: "info", text: `Nothing was written: ${ENTRA_SETTING_NAME} is already applied in this tenant.` };
    case "present-differs":
      return {
        tone: "warning",
        text: `Nothing was written: ${ENTRA_SETTING_NAME} exists but differs - ${outcome.diffs.map(describeSettingDiff).join(" ")}`,
      };
    case "possible-duplicate":
      return {
        tone: "warning",
        text:
          "Nothing was written: another Entra ID diagnostic setting already sends a chosen category to this namespace, " +
          `so those events would arrive twice: ${outcome.names.join(", ")}.`,
      };
    case "unknown-categories":
      return {
        tone: "error",
        text: `Nothing was written: these categories are not ones this app can set: ${outcome.names.join(", ")}.`,
      };
    case "denied":
      return { tone: "error", text: `Deploy stopped at ${STEP_LABELS[outcome.step]}. ${outcome.message}${ROLE_HINT}` };
    case "unregistered":
    case "failed":
      return { tone: "error", text: `Deploy stopped at ${STEP_LABELS[outcome.step]}. ${outcome.message}` };
  }
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

/**
 * Why Remove is disabled, or null. The removal proves ownership itself after
 * the confirm (it re-reads the setting by name); this only keeps the button
 * honest: without the app's own record of writing the setting in this tenant,
 * the app never removes it.
 */
export function entraRemoveDisabledReason(gate: {
  readonly running: boolean;
  readonly tenantId: string;
  readonly record: EntraSettingRecord | null;
}): string | null {
  if (gate.running) return "A change is already running.";
  if (gate.tenantId.trim() === "") return "No Azure tenant is configured for this connection.";
  if (gate.record === null) {
    return (
      `This app has no record of creating ${ENTRA_SETTING_NAME} in this tenant, so it does not remove it from here. ` +
      "Remove it in the Microsoft Entra admin center if it should go. Unchoosing Entra ID does not remove it."
    );
  }
  return null;
}

/** The removal confirm, quoting exactly what goes and what it is checked against. */
export function entraRemoveConfirmText(tenantId: string, record: EntraSettingRecord): string {
  return (
    `Remove the Entra ID diagnostic setting ${ENTRA_SETTING_NAME} from tenant ${tenantId}? ` +
    `It is removed only if it still sends with the rule this app recorded writing (${record.ruleId}); otherwise nothing is removed. ` +
    "Microsoft Entra ID then stops sending sign-in and audit logs to the Event Hub. The hubs, their events and the Cribl source are not touched. " +
    "This deletes one tenant-wide setting in Microsoft Entra ID."
  );
}

const REMOVE_STEP_LABELS: Readonly<Record<EntraRemoveStep, string>> = {
  "setting-read": "reading the setting",
  "setting-delete": "removing the setting",
};

/** The removal outcome as the screen says it. */
export function entraRemoveMessage(outcome: EntraRemoveOutcome): PickerMessage {
  switch (outcome.kind) {
    case "removed":
      return { tone: "info", text: `${ENTRA_SETTING_NAME} was removed, and no longer reads back from Azure.` };
    case "removed-not-confirmed":
      return { tone: "warning", text: `Azure accepted removing ${ENTRA_SETTING_NAME}, but it is not confirmed gone: ${outcome.reason}` };
    case "already-gone":
      return { tone: "info", text: `Nothing was removed: ${ENTRA_SETTING_NAME} is not in this tenant.` };
    case "not-proven":
      return { tone: "warning", text: `Nothing was removed. ${outcome.detail}` };
    case "denied":
      return { tone: "error", text: `Remove stopped at ${REMOVE_STEP_LABELS[outcome.step]}. ${outcome.message}${ROLE_HINT}` };
    case "unregistered":
    case "failed":
      return { tone: "error", text: `Remove stopped at ${REMOVE_STEP_LABELS[outcome.step]}. ${outcome.message}` };
  }
}
