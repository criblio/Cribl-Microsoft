/**
 * Listen rule and consumer group panel state - PURE (AZR-36).
 *
 * Decides what the panel says: the not-measured permission banner, one line
 * per object the read-only check looked at, the confirm (which QUOTES each PUT
 * exactly as it will be sent), each apply outcome, and the Remove confirm and
 * outcome for an object the app recorded creating. Core's
 * planListenAccess / applyListenAccess / removeListenAccessObject do the work.
 *
 * VISIBLE COPY. Every string here reaches the screen: no card ids, dates or
 * phases (azure-onboarding-copy-history gate).
 *
 * No React, no IO, no clock.
 */

import {
  LISTEN_ACCESS_ACTIONS,
  LISTEN_ACCESS_LEAST_ROLE,
  LISTEN_ACCESS_NOT_MEASURED,
  accessObjectHub,
  accessObjectName,
  plannedWrites,
  quoteArmRequest,
  requestsForAccessRecord,
} from "@soc/core";
import type {
  EventHubAccessRecord,
  ListenAccessItem,
  ListenAccessItemOutcome,
  ListenAccessPlan,
  ListenAccessRemoveOutcome,
  ListenAccessTarget,
  OnboardingProgress,
} from "@soc/core";
import type { PickerMessage } from "../azure-onboarding-state";

/**
 * The permission banner. Never a denial and never a block: nothing measures
 * these actions, so the banner says so and Azure's own answer decides.
 */
export function listenAccessPermissionMessage(): PickerMessage {
  const creates = LISTEN_ACCESS_ACTIONS.filter((a) => a.action.endsWith("/write")).map((a) => a.action);
  return {
    tone: "info",
    text: `Creating these needs ${creates.join(" and ")} on the namespace (least role: ${LISTEN_ACCESS_LEAST_ROLE}). ${LISTEN_ACCESS_NOT_MEASURED}`,
  };
}

/** Everything the confirm names, as one key: any change disarms. */
export function listenAccessArmKey(target: ListenAccessTarget, readSeq: number): string {
  return JSON.stringify([
    target.namespace.subscriptionId,
    target.namespace.resourceGroup,
    target.namespace.name,
    [...target.hubs],
    target.consumerGroup,
    target.ruleName,
    target.createRule,
    target.createGroups,
    readSeq,
  ]);
}

function itemLabel(item: ListenAccessItem): string {
  return item.kind === "listen-rule" ? `Listen rule ${item.name}` : `Consumer group ${item.name} on ${item.hub ?? ""}`;
}

/** One line per object the check looked at. */
export function planItemLine(item: ListenAccessItem): PickerMessage {
  const v = item.verdict;
  switch (v.kind) {
    case "create":
      return { tone: "info", text: `${itemLabel(item)}: not there yet, the app can create it.` };
    case "reuse":
      return { tone: "info", text: v.detail };
    case "refused":
      return { tone: "warning", text: v.detail };
    case "unknown":
      return { tone: v.denied ? "error" : "warning", text: v.denied ? `${v.detail} Azure refused the read: a permission is likely missing.` : v.detail };
  }
}

/** The confirm: each PUT quoted exactly, in the order it is sent. */
export function listenAccessConfirmLines(plan: ListenAccessPlan): string[] {
  const writes = plannedWrites(plan);
  if (writes.length === 0) return [];
  return [
    `Confirm to send ${writes.length === 1 ? "this request" : `these ${writes.length} requests`} to Azure, in this order:`,
    ...writes.map(quoteArmRequest),
    "Each name is read again just before its request; one that exists by then is left as it is and not written. Nothing that already exists is replaced.",
  ];
}

/** A plan's headline when it has nothing to create. */
export function nothingToCreateText(plan: ListenAccessPlan): string | null {
  if (plan.kind === "refused") return plan.detail;
  return plannedWrites(plan).length === 0 ? "Nothing to create: every object is already there or cannot be created (see each line)." : null;
}

/** One apply outcome. */
export function applyOutcomeMessage(o: ListenAccessItemOutcome): PickerMessage {
  const label = itemLabel(o.item);
  switch (o.kind) {
    case "created":
      return { tone: "info", text: `${label}: created and read back.` };
    case "created-not-verified":
      return { tone: "warning", text: `${label}: Azure accepted the create, but the read-back did not confirm it (${o.reason}).` };
    case "appeared":
      return { tone: "warning", text: o.detail };
    case "not-written":
      return { tone: "warning", text: `${label}: ${o.detail}` };
    case "failed":
      return {
        tone: "error",
        text:
          o.failure.kind === "denied"
            ? `${o.failure.message}. Azure refused it: the identity likely lacks ${LISTEN_ACCESS_LEAST_ROLE} (or Contributor) on the namespace.`
            : o.failure.message,
      };
  }
}

/** The Cribl Event Hubs sources the app records: while any remains, nothing here is removed. */
export function eventHubSourcesInUse(progress: OnboardingProgress): string[] {
  return Object.values(progress.criblSources)
    .filter((r) => r !== undefined && r.inputType === "eventhub")
    .map((r) => r?.inputId ?? "")
    .filter((id) => id !== "");
}

/** The Remove row's title. A consumer group names its hub: the same group may sit on several. */
export function accessRecordTitle(record: EventHubAccessRecord): string {
  const name = accessObjectName(record.resourceId);
  if (record.kind === "listen-rule") return `Listen rule ${name} (Azure)`;
  const hub = accessObjectHub(record);
  return hub === "" ? `Consumer group ${name} (Azure)` : `Consumer group ${name} on ${hub} (Azure)`;
}

/** The Remove confirm: the exact DELETE, and what is checked first. */
export function accessRemoveConfirmText(record: EventHubAccessRecord): string {
  const requests = requestsForAccessRecord(record);
  const proof =
    record.kind === "listen-rule"
      ? "it is read first and removed only if this app's record names it, its rights are still Listen alone and Azure reports the creation time this app saved"
      : "it is read first and removed only if this app's record names it and it still carries this app's description";
  if (requests === null) return "This record does not name an object this app creates; nothing will be sent.";
  return `Remove sends ${quoteArmRequest(requests.del)} - ${proof}. A Cribl source that read with it stops reading.`;
}

/** One Remove outcome. */
export function accessRemoveMessage(outcome: ListenAccessRemoveOutcome): PickerMessage {
  switch (outcome.kind) {
    case "removed":
      return { tone: "info", text: `Removed ${accessObjectName(outcome.resourceId)}.` };
    case "already-gone":
      return { tone: "info", text: `${accessObjectName(outcome.resourceId)} was already gone; nothing was sent.` };
    case "removed-not-confirmed":
      return { tone: "warning", text: `Azure accepted the removal of ${accessObjectName(outcome.resourceId)}, but it is not confirmed gone: ${outcome.reason}` };
    case "not-proven":
    case "in-use":
      return { tone: "warning", text: outcome.detail };
    case "invalid-record":
      return { tone: "warning", text: "The saved record does not name an object this app creates; nothing was sent." };
    case "denied":
      return { tone: "error", text: `${outcome.message}. Azure refused it: a permission is likely missing.` };
    case "unregistered":
    case "failed":
      return { tone: "error", text: outcome.message };
  }
}

/** Shown when the hubs, names, choices or a newer read changed while the check ran. */
export const STALE_CHECK_TEXT =
  "What the check would create changed while it ran (a hub, a name, a choice, or a newer read). Nothing was written; check again.";
