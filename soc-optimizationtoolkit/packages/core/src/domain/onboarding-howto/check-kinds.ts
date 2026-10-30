/**
 * Check vocabulary - WHAT VALIDATE LOOKS AT, AND WHAT IT MAY SAY ABOUT IT.
 *
 * Validate (AZR-32) is read-only: it GETs Azure resources and says whether each
 * one matches the plan. This module is the vocabulary only - the kinds of thing
 * checked, and the verdicts a check may reach. The requests and classifiers
 * live in onboarding-validation.
 *
 * A REFUSED READ IS UNKNOWN, NEVER ABSENT (claude-kit standards/
 * inventory-honesty.md). `absent` is reserved for a GET-by-name 404 or a
 * complete listing without the item. Anything else that failed to answer -
 * denied, a 5xx, a truncated listing, an unregistered provider, a value the
 * operator has not filled in - is {@link StepVerdict} `unknown` with its reason,
 * so the screen can say "could not be read" instead of "not found".
 *
 * ARRIVAL IS NOT A VERDICT. Whether messages reached a hub is a measurement,
 * not a configuration check, so it has its own type ({@link ArrivalReading}).
 * A measured zero is a real answer - "no messages in the window" - and is kept
 * apart from "could not be measured" at the type level.
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto.
 */

/** Every kind of Azure object Validate reads. Arrival is deliberately absent. */
export const CHECK_KINDS = [
  "eh-namespace",
  "eh-hub",
  "eh-rule-send",
  "eh-rule-listen",
  "eh-rule-manage",
  "eh-consumer-group",
  "defender-plans",
  "defender-provider",
  "defender-export",
  "entra-setting",
  "activity-log-setting",
  "policy-assignment",
  "policy-set-definition",
  "policy-definition",
  "policy-identity-roles",
  "policy-remediation",
  "xdr-streaming",
  "network-watcher",
  "storage-account",
  "storage-container",
  "storage-queue",
  "eventgrid-topic",
  "eventgrid-subscription",
  "flow-log",
  "storage-rbac",
] as const;

export type CheckKind = (typeof CHECK_KINDS)[number];

/**
 * Why a check could not reach a yes or no.
 *
 *   denied         401 or 403
 *   failed         a transport error, a 5xx, or a cancelled run
 *   truncated      a listing stopped before its last page
 *   unregistered   the resource provider is not registered on the subscription
 *   unmeasurable   Azure exposes nothing this app can read (XDR streaming)
 *   missing-value  a plan value the request needs is unset; nothing was sent
 */
export type UnknownReason =
  | "denied"
  | "failed"
  | "truncated"
  | "unregistered"
  | "unmeasurable"
  | "missing-value";

/** One field that does not match the plan. */
export interface VerdictDiff {
  readonly field: string;
  readonly expected: string;
  readonly actual: string;
}

/** What one check concluded. */
export type StepVerdict =
  | { readonly kind: "as-expected" }
  | { readonly kind: "present-differs"; readonly diffs: readonly VerdictDiff[] }
  | {
      readonly kind: "present-other-name";
      readonly name: string;
      readonly diffs: readonly VerdictDiff[];
      /**
       * How many more objects matched the same way besides `name` (DBT-178),
       * so the screen can say the named one is not the only one. Set only
       * when there is at least one.
       */
      readonly alsoFound?: number;
    }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown"; readonly reason: UnknownReason; readonly detail: string };

/**
 * What a present-other-name verdict's `alsoFound` counts, per check kind, as
 * [one, many]. Each is what that kind's classifier counted: a remediation
 * verdict counts ASSIGNMENTS that have remediations, not remediations, since
 * one assignment may have several (DBT-189). Every unit says "like it": the
 * count is of objects that matched the way the named one did, not of every
 * such object in Azure - without it, "2 other policy assignments" on a lane
 * card reads as an inventory. A kind without its own unit claims nothing
 * beyond "like it".
 */
const OTHER_NAME_UNIT: Partial<Record<CheckKind, readonly [string, string]>> = {
  "defender-export": ["continuous export like it", "continuous exports like it"],
  "entra-setting": ["diagnostic setting like it", "diagnostic settings like it"],
  "policy-assignment": ["policy assignment like it", "policy assignments like it"],
  "policy-remediation": ["assignment like it with remediations", "assignments like it with remediations"],
};

/**
 * The words for the objects a present-other-name verdict did NOT name - ""
 * when there are none, else e.g. "2 other policy assignments like it were
 * also found".
 * The ONE wording Validate, the How-to step word and the dataflow lane use, so
 * all three say the same count in the same unit (DBT-189).
 */
export function otherNameAlsoFound(alsoFound: number | undefined, kind?: CheckKind): string {
  const n = alsoFound ?? 0;
  if (n <= 0) return "";
  const [one, many] = (kind === undefined ? undefined : OTHER_NAME_UNIT[kind]) ?? ["object like it", "objects like it"];
  return n === 1 ? `1 other ${one} was also found` : `${n} other ${many} were also found`;
}

/**
 * A hub arrival measurement (Azure Monitor IncomingMessages).
 *
 *   measured  Azure answered; `messages` is the total over `window`, and 0 is a
 *             real, measured zero ("no messages in the window")
 *   no-hub    a COMPLETE hub listing of the namespace does not hold the hub,
 *             so nothing has ever been sent to it (AZR-47: Azure Monitor
 *             answers a read for a hub that does not exist with a zero series,
 *             which must not read as a quiet hub)
 *   unknown   the metric could not be read; `reason` says why
 *
 * `window` is the timespan the total covers, as the request sent it.
 */
export type ArrivalReading =
  | { readonly kind: "measured"; readonly messages: number; readonly window: string }
  | { readonly kind: "no-hub" }
  | { readonly kind: "unknown"; readonly reason: UnknownReason; readonly detail: string };

/**
 * The verdict a group of checks rolls up to. present-differs and
 * present-other-name both roll up to `differs`.
 */
export type AggregateVerdict = "as-expected" | "differs" | "absent" | "unknown";

const RANK: Readonly<Record<StepVerdict["kind"], number>> = {
  "as-expected": 0,
  "present-differs": 1,
  "present-other-name": 1,
  absent: 2,
  unknown: 3,
};

const AGGREGATE: readonly AggregateVerdict[] = ["as-expected", "differs", "absent", "unknown"];

/**
 * The worst verdict in the list: unknown beats absent beats differs beats
 * as-expected. An EMPTY list is unknown - nothing checked is not "all good".
 */
export function aggregateVerdict(verdicts: readonly StepVerdict[]): AggregateVerdict {
  if (verdicts.length === 0) return "unknown";
  let worst = 0;
  for (const v of verdicts) worst = Math.max(worst, RANK[v.kind]);
  return AGGREGATE[worst];
}
