/**
 * Event Hub TARGET usecase (AZR-11, on the AZR-18 Azure onboarding screen):
 * once the operator has picked a namespace, list what inside it can be a
 * target - its hubs, and its namespace-level authorization rules with whether
 * each one can Send.
 *
 * READ-ONLY. Each function issues exactly ONE ARM GET and nothing else. The
 * thin slice uses an existing namespace, rule and hub; creating any of them is
 * out of scope, and listKeys is deliberately NOT here - a SAS key is fetched
 * only inside the Defender deploy, after the operator's confirm, never to fill
 * a picker.
 *
 * NEVER THROWS. Both functions resolve to a {@link EventHubTargetRead}: a
 * Listing when ARM answered 2xx, or a failure that names why there is no
 * listing. The transport is wrapped with safeAzureManagement, so a rejected
 * request is a `failed` result rather than an escape.
 *
 * A 403 IS NOT AN EMPTY LIST. It is classified as `denied`, separately from
 * every other failure, because "you may not read this namespace's rules" and
 * "this namespace has no rules" call for different operator actions - folding
 * a 403 into an empty picker is the HON-2 / DBT-52 shape this repo keeps
 * re-learning. A 2xx with no items is `empty` (unverified), never `none`:
 * the list is RBAC-filtered, so a verified zero cannot be claimed from it.
 *
 * ONE PAGE, AND IT SAYS SO. `nextLink` is not followed (a picker read stays
 * one GET), but it is not ignored either: a 2xx whose body carries a non-empty
 * `nextLink` sets `truncated: true` on the result, so the screen can say the
 * list is partial instead of presenting the first page as every hub. A
 * Premium namespace holds up to 100 hubs per PU and a Dedicated one up to
 * 1000, so the operator's hub can sit on a later page.
 *
 * Failure messages never echo the response body. Neither list carries a key,
 * but the ARM error code is enough to act on and the habit is cheaper to keep
 * than to audit.
 *
 * Pure orchestration over the port: no IO of its own.
 */

import type {
  AzureManagement,
  AzureManagementRequest,
} from "../../ports/azure-management";
import type { Listing } from "../../domain/inventory-listing/inventory-listing";
import { toListing } from "../../domain/inventory-listing/inventory-listing";
import {
  buildNamespaceAuthRulesListRequest,
  buildNamespaceHubsListRequest,
  parseNamespaceAuthRules,
  ruleCanSend,
} from "../../domain/eventhub-arm/eventhub-arm";
import type {
  NamespaceAuthRule,
  NamespaceRef,
} from "../../domain/eventhub-arm/eventhub-arm";
import { parseEventHubItem } from "../../domain/eventhub-discovery/eventhub-discovery";
import type { EventHubInfo } from "../../domain/eventhub-discovery/eventhub-discovery";
import { armErrorCode, is2xx, prop, safeAzureManagement } from "../arm-http";

/**
 * Why a target read produced no listing.
 * - `denied`: ARM answered 403. The identity lacks read on the namespace (or
 *   its rules); the operator needs a role, not a different namespace.
 * - `failed`: any other non-2xx (`status` set) or no answer at all (`status`
 *   null: transport error, token failure).
 */
export type EventHubTargetFailure =
  | { readonly kind: "denied"; readonly status: 403; readonly message: string }
  | {
      readonly kind: "failed";
      readonly status: number | null;
      readonly message: string;
    };

/**
 * A listing when ARM answered 2xx, otherwise the reason there is none.
 * `truncated` is true when ARM returned a `nextLink`: the listing is the first
 * page only, and a `rows` or `empty` listing must not be shown as complete.
 */
export type EventHubTargetRead<T> =
  | {
      readonly ok: true;
      readonly listing: Listing<T>;
      readonly truncated: boolean;
    }
  | { readonly ok: false; readonly failure: EventHubTargetFailure };

/**
 * One namespace-level rule, with whether it can deliver events. The picker
 * offers only `canSend` rules: a Listen-only rule lets the Defender PUT and its
 * read-back succeed while nothing is ever delivered.
 */
export interface EventHubTargetRule extends NamespaceAuthRule {
  readonly canSend: boolean;
}

/**
 * Issue one GET and classify it. `what` names the list for the message, e.g.
 * "hubs in namespace ns-a".
 */
async function readOnce<T>(
  azure: AzureManagement,
  request: AzureManagementRequest,
  what: string,
  parse: (body: unknown) => Listing<T>,
): Promise<EventHubTargetRead<T>> {
  const attempt = await safeAzureManagement(azure).request(request);
  if (!attempt.ok) {
    return {
      ok: false,
      failure: {
        kind: "failed",
        status: null,
        message: `Could not list ${what}: ${attempt.error}`,
      },
    };
  }
  const { status, body } = attempt.response;
  if (is2xx(status)) {
    const nextLink = prop(body, "nextLink");
    return {
      ok: true,
      listing: parse(body),
      truncated: typeof nextLink === "string" && nextLink !== "",
    };
  }
  const code = armErrorCode(body);
  const suffix = code === "" ? "" : ` (${code})`;
  if (status === 403) {
    return {
      ok: false,
      failure: {
        kind: "denied",
        status: 403,
        message:
          `Could not list ${what}: HTTP 403${suffix} - the identity needs ` +
          "read access on the Event Hub namespace",
      },
    };
  }
  return {
    ok: false,
    failure: {
      kind: "failed",
      status,
      message: `Could not list ${what}: HTTP ${status}${suffix}`,
    },
  };
}

/**
 * List the hubs in one namespace. One GET; `nextLink` is not followed (the
 * same single-page read discoverEventHubs makes per namespace), but its
 * presence is reported as `truncated`.
 */
export async function listNamespaceHubs(
  azure: AzureManagement,
  ns: NamespaceRef,
): Promise<EventHubTargetRead<EventHubInfo>> {
  return readOnce(
    azure,
    buildNamespaceHubsListRequest(ns),
    `hubs in namespace ${ns.name}`,
    (body) => {
      const value = prop(body, "value");
      const items = Array.isArray(value) ? value : [];
      const hubs: EventHubInfo[] = [];
      for (const item of items) {
        const hub = parseEventHubItem(item, ns.name);
        if (hub !== null) hubs.push(hub);
      }
      return toListing(hubs);
    },
  );
}

/**
 * List one namespace's namespace-level authorization rules, each carrying
 * `canSend` from {@link ruleCanSend}. One GET. Every rule is returned - the
 * caller filters to `canSend` for the picker and can still say that rules
 * exist but none can send.
 */
export async function listNamespaceAuthRules(
  azure: AzureManagement,
  ns: NamespaceRef,
): Promise<EventHubTargetRead<EventHubTargetRule>> {
  return readOnce(
    azure,
    buildNamespaceAuthRulesListRequest(ns),
    `authorization rules in namespace ${ns.name}`,
    (body) => {
      const parsed = parseNamespaceAuthRules(body);
      if (parsed.kind !== "rows") return parsed;
      return toListing(
        parsed.rows.map((rule) => ({ ...rule, canSend: ruleCanSend(rule.rights) })),
      );
    },
  );
}
