/**
 * Defender for Cloud continuous export - the USECASES (AZR-3, on the AZR-18
 * Azure Native Source Onboarding screen). Two entry points over the
 * AzureManagement port:
 *
 * - {@link readDefenderState}: what the configured subscription has now. Which
 *   paid plans are on (read, never written) and whether our export exists.
 * - {@link deployDefenderExport}: create the export. CREATE-ONLY.
 *
 * WHY "OURS" IS DECIDED FROM THE SUBSCRIPTION-WIDE LIST. Legacy
 * (Deploy-DefenderExport.ps1:208, :236) put CriblDefenderExport in resource
 * group CriblSecurityExport. A GET scoped to the group the operator picks now
 * would 404 there, and this app would write a SECOND export into the same hub,
 * so every alert would arrive twice. Both functions therefore list
 * `/subscriptions/{sub}/providers/Microsoft.Security/automations` and match by
 * name in ANY resource group (domain `classifyOurs`).
 *
 * WHY DEPLOY RE-LISTS AND REFUSES. A Microsoft.Security/automations PUT
 * replaces the resource whole, and legacy PUT blindly on every run. Between
 * the screen's read and the operator's confirm anything may have changed, so
 * deploy lists again first and REFUSES - it never repairs or replaces - when:
 *
 *   already-exists       a CriblDefenderExport that matches exists anywhere
 *   present-differs      a CriblDefenderExport exists but is broken (repair is
 *                        a follow-up card; nothing here re-PUTs)
 *   possible-duplicate   another automation already sends to the chosen hub or
 *                        its namespace
 *
 * An automations list that comes back EMPTY does not refuse: it is the normal
 * answer for a subscription with no exports, and a list the identity could
 * not read answers 403, which does refuse (denied at step automation-list).
 *
 * THEN, in this order and nothing else: POST listKeys on the chosen namespace
 * rule, PUT the automation, GET it back by id. A read-back whose non-secret
 * fields match is `written-and-read-back` - which names exactly what was
 * checked; delivery is only proven when an alert arrives in the hub. Anything
 * short of that after an accepted PUT is `accepted-not-verified`, never a
 * failure, because the export may well exist.
 *
 * THE CONNECTION STRING. It is fetched only inside deploy, after the re-list,
 * goes into the PUT body and nowhere else: no outcome field, no log entry, no
 * error text. Error text built from Azure's answers is scrubbed of it as well,
 * in case Azure echoes the body back in a validation message.
 *
 * Never throws: every transport rejection and every non-2xx becomes an
 * outcome. Never DELETEs, never re-PUTs, never writes a pricing.
 *
 * Pure orchestration over the port: no IO of its own, no clock, no randomness.
 */

import type { AzureManagement } from "../../ports/azure-management";
import type { PortHttpResponse } from "../../ports/http";
import type { Logger } from "../../ports/logger";
import { armErrorCode, asString, is2xx, prop } from "../arm-http";
import type { Listing } from "../../domain/inventory-listing/inventory-listing";
import type { OnboardingItemId } from "../../domain/onboarding-selection";
import type { NamespaceRef } from "../../domain/eventhub-arm/eventhub-arm";
import {
  buildNamespaceListKeysRequest,
  parseListKeys,
} from "../../domain/eventhub-arm/eventhub-arm";
import type { PricingsRead } from "../../domain/defender-export/defender-plans";
import {
  buildPricingsListRequest,
  parsePricings,
} from "../../domain/defender-export/defender-plans";
import type {
  DefenderAutomation,
  OursState,
} from "../../domain/defender-export/defender-automation";
import {
  DEFENDER_EXPORT_ITEM_ID,
  automationDiffs,
  buildAutomationGetByIdRequest,
  buildAutomationPutRequest,
  buildSubscriptionAutomationsListRequest,
  classifyOurs,
  defenderExportPath,
  expectedExportFor,
  findSameTargetExports,
  parseAutomation,
  parseAutomations,
} from "../../domain/defender-export/defender-automation";

/** The coverage-catalog item this export deploys; declared once, in the domain. */
export { DEFENDER_EXPORT_ITEM_ID };

/**
 * Fail-safe bound on nextLink pages of the automations list. A subscription
 * holds a handful of automations; a chain longer than this is broken, and the
 * list is then reported unread rather than half-read.
 */
export const DEFENDER_AUTOMATIONS_MAX_PAGES = 20;

/** The ARM error code Azure returns when Microsoft.Security is not registered. */
export const MISSING_REGISTRATION_CODE = "MissingSubscriptionRegistration";

/** Why one ARM call produced no usable answer, classified for the operator. */
export interface ArmReadFailure {
  /** 403, provider not registered, or anything else (incl. no answer at all). */
  readonly kind: "denied" | "unregistered" | "failed";
  /** Azure's status, or null when the transport produced no answer. */
  readonly status: number | null;
  /** Azure's error code, "" when there was none. */
  readonly code: string;
  /** Azure's message, or ours. */
  readonly message: string;
}

/**
 * The plan read. Only `read` carries plan lists, so only `read` can ever be
 * summarised as "no paid plan" - a denied or failed read has no `enabled`
 * array to be mistaken for an empty one.
 */
export type DefenderPlansState =
  | { readonly kind: "read"; readonly pricings: PricingsRead }
  | ({ readonly kind: "denied" | "unregistered" | "failed" } & Omit<ArmReadFailure, "kind">);

/** The subscription-wide automations list, or why it could not be read. */
export type DefenderAutomationsState =
  | { readonly kind: "listed"; readonly listing: Listing<DefenderAutomation> }
  | { readonly kind: "unread"; readonly failure: ArmReadFailure };

/** Our export, or why we cannot say. `unknown` is never shown as absent. */
export type DefenderOursReading = OursState | { readonly kind: "unknown"; readonly reason: string };

/** What {@link readDefenderState} returns. */
export interface DefenderState {
  readonly plans: DefenderPlansState;
  readonly automations: DefenderAutomationsState;
  readonly ours: DefenderOursReading;
  /**
   * `[DEFENDER_EXPORT_ITEM_ID]` ONLY when ours is present-matching. A broken export
   * is not deployed, and an unreadable list proves nothing either way.
   */
  readonly deployed: readonly OnboardingItemId[];
  /** Set exactly when ours is `unknown`: the reason, for the row label. */
  readonly unknownReason?: string;
}

/** What {@link deployDefenderExport} needs. No secret: the key is fetched inside. */
export interface DefenderDeployInput {
  readonly subscriptionId: string;
  /** An EXISTING resource group the operator picked. */
  readonly resourceGroup: string;
  /** That resource group's location. */
  readonly location: string;
  readonly namespace: NamespaceRef;
  readonly hubName: string;
  /** A namespace-level rule the operator picked; the UI offers only Send-capable ones. */
  readonly ruleName: string;
}

/** The deploy steps, named in denied / unregistered / failed outcomes. */
export type DefenderDeployStep = "automation-list" | "list-keys" | "automation-put";

/** Every way {@link deployDefenderExport} can end. None carries the secret. */
export type DefenderDeployOutcome =
  | {
      readonly kind: "written-and-read-back";
      readonly automationId: string;
    }
  | {
      /** The PUT was accepted, but the read-back did not confirm the shape. */
      readonly kind: "accepted-not-verified";
      readonly automationId: string;
      readonly reasons: readonly string[];
    }
  | {
      /** Ours exists and matches - possibly in another resource group. */
      readonly kind: "already-exists";
      readonly automationId: string;
      readonly resourceGroup: string;
    }
  | {
      /** Ours exists but is broken. Repair is a follow-up; nothing is written. */
      readonly kind: "present-differs";
      readonly automationId: string;
      readonly diffs: readonly string[];
    }
  | {
      /** Other automations already send to this hub or namespace. */
      readonly kind: "possible-duplicate";
      readonly names: readonly string[];
    }
  | {
      readonly kind: "denied" | "unregistered" | "failed";
      readonly step: DefenderDeployStep;
      readonly status: number | null;
      readonly code: string;
      readonly message: string;
    };

type Attempt =
  | { readonly ok: true; readonly response: PortHttpResponse }
  | { readonly ok: false; readonly message: string };

/** One call that never rejects. The rejection text is kept, never thrown. */
async function attempt(
  run: () => Promise<PortHttpResponse>,
): Promise<Attempt> {
  try {
    return { ok: true, response: await run() };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Classify a non-2xx answer (or no answer). Registration is checked BEFORE
 * 403: an unregistered provider can come back as a 403 carrying
 * MissingSubscriptionRegistration, and "register Microsoft.Security" is the
 * fix the operator needs there, not "ask for a role".
 */
function classifyFailure(result: Attempt, what: string): ArmReadFailure {
  if (!result.ok) {
    return { kind: "failed", status: null, code: "", message: `${what}: ${result.message}` };
  }
  const { status, body } = result.response;
  const code = armErrorCode(body);
  const azureMessage = asString(prop(prop(body, "error"), "message")) || asString(prop(body, "message"));
  const message = `${what}: HTTP ${status}${azureMessage !== "" ? ` - ${azureMessage}` : ""}`;
  if (code.toLowerCase() === MISSING_REGISTRATION_CODE.toLowerCase()) {
    return { kind: "unregistered", status, code, message };
  }
  if (status === 403) {
    return { kind: "denied", status, code, message };
  }
  return { kind: "failed", status, code, message };
}

/**
 * List every automation in the subscription, following nextLink. Any page
 * failing makes the whole list unread: "ours is absent" cannot be claimed from
 * part of a list. For the same reason, a nextLink this adapter cannot follow
 * (the port's `requestUrl` is optional) and a chain longer than
 * {@link DEFENDER_AUTOMATIONS_MAX_PAGES} are both unread, never `listed` with
 * the pages read so far - deploy would otherwise PUT past an export on an
 * unread page and every alert would arrive twice. A 2xx page whose body is
 * not an object with a `value` array (an empty body, a proxy's HTML page) is
 * unread too: it was answered, but it is not a listing.
 */
async function listSubscriptionAutomations(
  azure: AzureManagement,
  subscriptionId: string,
): Promise<DefenderAutomationsState> {
  const what = "List Defender automations";
  const first = await attempt(() =>
    azure.request(buildSubscriptionAutomationsListRequest(subscriptionId)),
  );
  if (!first.ok || !is2xx(first.response.status)) {
    return { kind: "unread", failure: classifyFailure(first, what) };
  }
  const items: unknown[] = [];
  /** The page's nextLink ("" for the last page), or null when the body is not a listing. */
  const collect = (body: unknown): string | null => {
    const value = prop(body, "value");
    if (!Array.isArray(value)) return null;
    items.push(...value);
    return asString(prop(body, "nextLink"));
  };
  const notAListing = (page: string, status: number): DefenderAutomationsState => ({
    kind: "unread",
    failure: {
      kind: "failed",
      status,
      code: "",
      message: `${what}${page}: HTTP ${status}, but the response had no value array.`,
    },
  });
  let nextLink = collect(first.response.body);
  if (nextLink === null) return notAListing("", first.response.status);
  let pages = 0;
  const requestUrl = azure.requestUrl?.bind(azure);
  while (nextLink !== "") {
    if (requestUrl === undefined) {
      return {
        kind: "unread",
        failure: {
          kind: "failed",
          status: null,
          code: "",
          message: `${what}: Azure returned more pages, but this adapter cannot follow nextLink.`,
        },
      };
    }
    if (pages >= DEFENDER_AUTOMATIONS_MAX_PAGES) {
      return {
        kind: "unread",
        failure: {
          kind: "failed",
          status: null,
          code: "",
          message: `${what}: more than ${DEFENDER_AUTOMATIONS_MAX_PAGES} pages - stopped reading.`,
        },
      };
    }
    pages += 1;
    const url = nextLink;
    const page = await attempt(() => requestUrl({ method: "GET", url }));
    if (!page.ok || !is2xx(page.response.status)) {
      return { kind: "unread", failure: classifyFailure(page, `${what} (page ${pages + 1})`) };
    }
    nextLink = collect(page.response.body);
    if (nextLink === null) return notAListing(` (page ${pages + 1})`, page.response.status);
  }
  return { kind: "listed", listing: parseAutomations(items) };
}

/**
 * Read the configured subscription's Defender state: the plans (one GET on
 * pricings) and our export (one subscription-wide automations list, plus its
 * nextLink pages). Two independent reads - one failing never hides the other.
 *
 * Our export is classified without an expected target: the operator has not
 * picked a hub yet, so "matching" here means enabled, sending Alerts, to an
 * Event Hub target this app can parse. Never throws; never writes.
 */
export async function readDefenderState(
  azure: AzureManagement,
  subscriptionId: string,
  logger?: Logger,
): Promise<DefenderState> {
  const pricingsAttempt = await attempt(() =>
    azure.request(buildPricingsListRequest(subscriptionId)),
  );
  let plans: DefenderPlansState;
  if (pricingsAttempt.ok) {
    const parsed = parsePricings(pricingsAttempt.response);
    if (parsed.kind === "read") {
      plans = { kind: "read", pricings: parsed };
    } else if (is2xx(parsed.status)) {
      // A 2xx we could not understand: not denied, not unregistered.
      plans = { kind: "failed", status: parsed.status, code: parsed.code, message: parsed.message };
    } else {
      const failure = classifyFailure(pricingsAttempt, "Read Defender plans");
      plans = { ...failure };
    }
  } else {
    plans = { ...classifyFailure(pricingsAttempt, "Read Defender plans") };
  }

  const automations = await listSubscriptionAutomations(azure, subscriptionId);
  const ours: DefenderOursReading =
    automations.kind === "listed"
      ? classifyOurs(automations.listing)
      : { kind: "unknown", reason: automations.failure.message };

  logger?.info("defender-export: state read", {
    subscription: subscriptionId,
    plans: plans.kind,
    automations: automations.kind === "listed" ? automations.listing.kind : automations.failure.kind,
    ours: ours.kind,
  });

  return {
    plans,
    automations,
    ours,
    deployed: ours.kind === "present-matching" ? [DEFENDER_EXPORT_ITEM_ID] : [],
    ...(ours.kind === "unknown" ? { unknownReason: ours.reason } : {}),
  };
}

/** Remove the secret, and the key inside it, from text built from Azure's answers. */
function scrub(text: string, connectionString: string): string {
  let out = text;
  if (connectionString !== "") out = out.split(connectionString).join("<redacted>");
  const key = /SharedAccessKey=([^;]+)/.exec(connectionString)?.[1];
  if (key !== undefined && key !== "") out = out.split(key).join("<redacted>");
  return out;
}

function stepFailure(
  step: DefenderDeployStep,
  failure: ArmReadFailure,
): DefenderDeployOutcome {
  return { kind: failure.kind, step, status: failure.status, code: failure.code, message: failure.message };
}

/**
 * Create the CriblDefenderExport automation: Alerts only, this subscription
 * only, one EventHub action to the chosen hub, in the operator's EXISTING
 * resource group at that group's location.
 *
 * Order, exactly: re-list subscription automations (refuse on
 * already-exists / present-differs / possible-duplicate), POST listKeys, PUT,
 * GET by id. Never throws, never DELETEs, never re-PUTs, never reads or writes
 * a pricing. The caller has already had the operator confirm twice.
 */
export async function deployDefenderExport(
  azure: AzureManagement,
  input: DefenderDeployInput,
  logger?: Logger,
): Promise<DefenderDeployOutcome> {
  const context = {
    subscription: input.subscriptionId,
    resourceGroup: input.resourceGroup,
    namespace: input.namespace.name,
    hub: input.hubName,
    rule: input.ruleName,
  };
  const done = (outcome: DefenderDeployOutcome): DefenderDeployOutcome => {
    const level = outcome.kind === "written-and-read-back" ? "info" : "warn";
    logger?.[level]("defender-export: deploy finished", {
      ...context,
      outcome: outcome.kind,
      ...("step" in outcome ? { step: outcome.step } : {}),
    });
    return outcome;
  };

  // 1. Re-list, and refuse on anything that would make this PUT replace or
  //    duplicate an export.
  const automations = await listSubscriptionAutomations(azure, input.subscriptionId);
  if (automations.kind === "unread") {
    return done(stepFailure("automation-list", automations.failure));
  }
  const ours = classifyOurs(automations.listing);
  if (ours.kind === "present-matching") {
    return done({
      kind: "already-exists",
      automationId: ours.automation.id,
      resourceGroup: ours.automation.resourceGroup,
    });
  }
  if (ours.kind === "present-differs") {
    return done({ kind: "present-differs", automationId: ours.automation.id, diffs: ours.diffs });
  }
  const expected = expectedExportFor(input);
  const sameTarget = findSameTargetExports(automations.listing, expected.eventHubResourceId);
  if (sameTarget.length > 0) {
    return done({ kind: "possible-duplicate", names: sameTarget.map((a) => a.name) });
  }

  // 2. listKeys. The only place the connection string exists.
  const keysAttempt = await attempt(() =>
    azure.request(buildNamespaceListKeysRequest(input.namespace, input.ruleName)),
  );
  if (!keysAttempt.ok || !is2xx(keysAttempt.response.status)) {
    // A failed listKeys answer carries no key, so its text may be reported.
    return done(stepFailure("list-keys", classifyFailure(keysAttempt, "List the rule's keys")));
  }
  let connectionString: string;
  try {
    connectionString = parseListKeys(keysAttempt.response.body);
  } catch (error) {
    // parseListKeys's message never echoes the body; keep it, add nothing.
    return done({
      kind: "failed",
      step: "list-keys",
      status: keysAttempt.response.status,
      code: "",
      message: error instanceof Error ? error.message : "The listKeys response could not be read.",
    });
  }

  // 3. PUT. The body carries the secret; nothing built from the answer may.
  const put = buildAutomationPutRequest({ ...input, connectionString });
  const putAttempt = await attempt(() => azure.request(put));
  if (!putAttempt.ok || !is2xx(putAttempt.response.status)) {
    const failure = classifyFailure(putAttempt, "Create the Defender export");
    return done(
      stepFailure("automation-put", { ...failure, message: scrub(failure.message, connectionString) }),
    );
  }

  // 4. Read back by id and compare only the non-secret fields.
  const automationId = defenderExportPath(input.subscriptionId, input.resourceGroup);
  const readAttempt = await attempt(() =>
    azure.request(buildAutomationGetByIdRequest(automationId)),
  );
  if (!readAttempt.ok || !is2xx(readAttempt.response.status)) {
    const failure = classifyFailure(readAttempt, "Read the export back");
    return done({
      kind: "accepted-not-verified",
      automationId,
      reasons: [scrub(failure.message, connectionString)],
    });
  }
  const observed = parseAutomation(readAttempt.response.body);
  if (observed === null) {
    return done({
      kind: "accepted-not-verified",
      automationId,
      reasons: ["The read-back did not contain an automation."],
    });
  }
  const diffs = automationDiffs(expected, observed);
  if (diffs.length > 0) {
    return done({ kind: "accepted-not-verified", automationId, reasons: diffs });
  }
  return done({ kind: "written-and-read-back", automationId });
}
