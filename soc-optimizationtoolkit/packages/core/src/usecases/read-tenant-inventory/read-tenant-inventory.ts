/**
 * The READ-ONLY tenant inventory: which log types are collected, across every
 * subscription this connection can read, and which are archived.
 *
 * GET only. Order: the subscription list, the Entra diagnostic-settings list
 * once, then per subscription its diagnostic-settings list and its Defender
 * automations list - two requests per subscription (plus nextLink pages).
 *
 * Every subscription is read except Disabled and Deleted ones: a Warned or
 * PastDue subscription still holds settings, and dropping it silently would
 * shrink the denominator.
 *
 * Cancellation is a flag, not an AbortSignal (the platform fetch bridge
 * ignores signals): once `cancelled()` is true no further request is issued
 * through this usecase. Wrap the RAW port with {@link cancellableAzure}
 * before pacing it, so a request already waiting in the pacer is also
 * stopped.
 *
 * HONESTY: a read that is refused, fails, is truncated or has an unexpected
 * shape reaches the domain as `unread` with its reason, never as an empty
 * listing. The subscription list is read with the verdict pager for that
 * reason: `listSubscriptions` throws on a bad page and so cannot be turned into
 * a could-not-check state without a try/catch that loses the reason.
 *
 * Never throws. `now` is injected; pacing is the caller's wrapper
 * (`paceAzureManagement`), because this usecase counts requests, it does not
 * schedule them.
 */

import type {
  AzureManagement,
  AzureManagementRequest,
  AzureManagementUrlRequest,
} from "../../ports/azure-management";
import type { PortHttpResponse } from "../../ports/http";
import type { OnboardingProgress } from "../../domain/onboarding-howto/progress-document";
import type { Listing } from "../../domain/inventory-listing/inventory-listing";
import { toListing } from "../../domain/inventory-listing/inventory-listing";
import type { ListRead } from "../../domain/logging-map/list-read";
import { listSettingsRequest } from "../../domain/entra-diagnostics/entra-diagnostic-setting";
import { buildSubscriptionDiagnosticSettingsListRequest } from "../../domain/activity-log-export/activity-log-setting";
import {
  parseDiagnosticSettings,
  type DiagnosticSettingRead,
} from "../../domain/activity-log-export/diagnostic-setting";
import {
  activityLogCells,
  archiveEvidenceFrom,
  categoryCards,
  defenderCells,
  entraCells,
  withArchive,
  type CategoryCard,
  type EntraRead,
  type LogTypeCell,
  type SubscriptionAutomationsRead,
  type SubscriptionSettingsRead,
} from "../../domain/tenant-inventory/tenant-inventory";
import { SUBSCRIPTIONS_API_VERSION, subscriptionFromItem } from "../azure-discovery";
import { listSubscriptionAutomations } from "../defender-export";
import { readAllPages } from "../read-logging-map/arm-pager";

export interface TenantInventory {
  readonly readAt: string;
  readonly subscriptions:
    | Listing<{ readonly id: string; readonly name: string }>
    | { readonly kind: "unread"; readonly reason: string };
  readonly cells: readonly LogTypeCell[];
  readonly cards: readonly CategoryCard[];
  readonly requests: number;
}

export interface ReadTenantInventoryInput {
  readonly azure: AzureManagement;
  /**
   * The app's own progress record, the evidence for "archived through Cribl";
   * null when it could not be read - Event Hub destinations are then unknown.
   */
  readonly progress: OnboardingProgress | null;
  readonly now: () => string;
  /** Called after each read. `total` is known once the subscription list is. */
  readonly onProgress?: (done: number, total: number) => void;
  /** True once the caller is gone (unmounted); no request is issued after that. */
  readonly cancelled?: () => boolean;
}

/** The reason a read that was never sent because the caller went away carries. */
export const READ_CANCELLED = "the read was cancelled before this request was sent";

/**
 * The port, refusing every request once `cancelled()` is true. The refusal is
 * a rejection, which every read here turns into could-not-check.
 */
export function cancellableAzure(azure: AzureManagement, cancelled: () => boolean): AzureManagement {
  const inner = azure.requestUrl?.bind(azure);
  return {
    request: (r: AzureManagementRequest): Promise<PortHttpResponse> =>
      cancelled() ? Promise.reject(new Error(READ_CANCELLED)) : azure.request(r),
    ...(inner === undefined
      ? {}
      : {
          requestUrl: (r: AzureManagementUrlRequest): Promise<PortHttpResponse> =>
            cancelled() ? Promise.reject(new Error(READ_CANCELLED)) : inner(r),
        }),
  };
}

type SettingsRead =
  | { readonly kind: "read"; readonly settings: Listing<DiagnosticSettingRead> }
  | { readonly kind: "unread"; readonly reason: string };

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function refusedReason(read: Extract<ListRead<unknown>, { state: "refused" }>): string {
  return read.refusal.text !== "" ? read.refusal.text : `${read.refusal.reason}: ${read.refusal.request}`;
}

/** Counts every request issued through it; the inner port is untouched. */
function counting(azure: AzureManagement, tally: { n: number }): AzureManagement {
  const inner = azure.requestUrl?.bind(azure);
  return {
    request: (r: AzureManagementRequest): Promise<PortHttpResponse> => {
      tally.n += 1;
      return azure.request(r);
    },
    ...(inner === undefined
      ? {}
      : {
          requestUrl: (r: AzureManagementUrlRequest): Promise<PortHttpResponse> => {
            tally.n += 1;
            return inner(r);
          },
        }),
  };
}

async function guarded<T>(run: () => Promise<T>, fallback: (reason: string) => T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    return fallback(reasonOf(error));
  }
}

function readSettings(
  azure: AzureManagement,
  request: AzureManagementRequest,
  context: string,
): Promise<SettingsRead> {
  return guarded<SettingsRead>(
    async () => {
      const read = await readAllPages(azure, request, context);
      return read.state === "read"
        ? { kind: "read", settings: parseDiagnosticSettings(read.rows) }
        : { kind: "unread", reason: refusedReason(read) };
    },
    (reason) => ({ kind: "unread", reason }),
  );
}

type SubscriptionsRead =
  | { readonly kind: "read"; readonly rows: readonly { id: string; name: string }[] }
  | { readonly kind: "unread"; readonly reason: string };

export async function readTenantInventory(input: ReadTenantInventoryInput): Promise<TenantInventory> {
  const tally = { n: 0 };
  const cancelled = input.cancelled ?? ((): boolean => false);
  const azure = counting(cancellableAzure(input.azure, cancelled), tally);
  let done = 0;
  let total = 0;
  const tick = (): void => {
    done += 1;
    try {
      input.onProgress?.(done, total);
    } catch {
      // A progress callback must not break the read.
    }
  };

  // 1. Subscriptions: every readable state, not only Enabled.
  const subRead = await guarded<SubscriptionsRead>(
    async () => {
      const read = await readAllPages(
        azure,
        { method: "GET", path: "/subscriptions", apiVersion: SUBSCRIPTIONS_API_VERSION },
        "list subscriptions",
      );
      if (read.state === "refused") return { kind: "unread", reason: refusedReason(read) };
      const rows: { id: string; name: string }[] = [];
      for (const item of read.rows) {
        const sub = subscriptionFromItem(item, "readable");
        if (sub !== null) rows.push({ id: sub.subscriptionId, name: sub.displayName });
      }
      return { kind: "read", rows };
    },
    (reason) => ({ kind: "unread", reason }),
  );
  const subs = subRead.kind === "read" ? subRead.rows : [];
  total = 2 + 2 * subs.length;
  tick();

  // 2. Entra, once.
  const entraRead: EntraRead = await readSettings(azure, listSettingsRequest(), "list Entra diagnostic settings");
  tick();

  // 3. Per subscription: its diagnostic settings, then its Defender automations.
  const settingsReads: SubscriptionSettingsRead[] = [];
  const automationReads: SubscriptionAutomationsRead[] = [];
  for (const sub of subs) {
    if (cancelled()) {
      settingsReads.push({ subscriptionId: sub.id, kind: "unread", reason: READ_CANCELLED });
      automationReads.push({ subscriptionId: sub.id, kind: "unread", reason: READ_CANCELLED });
      continue;
    }
    const settings = await readSettings(
      azure,
      buildSubscriptionDiagnosticSettingsListRequest(sub.id),
      `list diagnostic settings of ${sub.id}`,
    );
    settingsReads.push({ subscriptionId: sub.id, ...settings });
    tick();

    const automations = await guarded<SubscriptionAutomationsRead>(
      async () => {
        const listed = await listSubscriptionAutomations(azure, sub.id);
        return listed.kind === "listed"
          ? { subscriptionId: sub.id, kind: "read", automations: listed.listing }
          : { subscriptionId: sub.id, kind: "unread", reason: listed.failure.message };
      },
      (reason) => ({ subscriptionId: sub.id, kind: "unread", reason }),
    );
    automationReads.push(automations);
    tick();
  }

  const cells = withArchive(
    [...entraCells(entraRead), ...activityLogCells(settingsReads), ...defenderCells(automationReads)],
    input.progress === null ? null : archiveEvidenceFrom(input.progress),
  );
  return {
    readAt: input.now(),
    subscriptions: subRead.kind === "unread" ? subRead : toListing(subRead.rows),
    cells,
    cards: categoryCards(cells),
    requests: tally.n,
  };
}
