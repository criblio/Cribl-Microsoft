/**
 * Automation permissions - WHAT EACH AUTOMATABLE SOURCE NEEDS FROM AZURE, AND
 * WHAT THE CACHED AUDIT SAYS ABOUT IT (AZR-60).
 *
 * The operator asked for each section that automates a source to say when the
 * Azure identity lacks the permissions to automate it, and to point at the
 * How-to steps instead. This module is both halves: the DECLARATION per
 * automatable source ({@link AUTOMATION_PERMISSIONS}), and the pure function
 * from that declaration plus the capability set the shell already holds to a
 * banner model ({@link automationPermissionView}).
 *
 * KEPT BESIDE ITEM_AVAILABILITY ON PURPOSE. A source that becomes automatable
 * (status "available") without a declaration here would render no banner, and
 * silence reads as "you have what this needs". The pin "declares every
 * automatable item and no other" fails until it has one, and
 * {@link undeclaredAutomatableItems} is that check as a function so the pin can
 * be shown to fail. A not-built source has no declaration and no banner: there
 * is nothing to automate, and its How-to rbac lists already say what it needs.
 *
 * NO AZURE CALL. The view reads the CACHED CapabilitySet (the connection bar's
 * "permissions: checked N ago"), so mounting the screen still costs nothing
 * (ADR 0007 item 1). Re-measuring is the operator's Re-check permissions.
 *
 * ONLY THIS CONNECTION'S SET. The audit hook keeps the previous connection's
 * set until the new audit lands, so a caller passes the audit key and a set
 * measured for another connection is read as never checked here
 * (usableCapabilitySet). Without that guard a connection switch would block
 * Deploy on verdicts nobody measured for the new identity.
 *
 * THE CHECK'S AGE IS IN THE BLOCKING COPY. The set comes from a one-slot cache
 * that is re-measured only on a key change or a manual re-check, so a denial
 * can be days old. Given `nowIso`, the blocked banner and deploy reason say
 * when the check ran ("the permission check 3 days ago found ...") and offer
 * Re-check permissions first.
 *
 * FIVE STATES, AND ONLY ONE OF THEM IS A DENIAL:
 *
 *   granted        measured, and the identity can do it
 *   denied         measured, and it cannot
 *   unknown        an audit ran but did not measure this capability - the setup
 *                  path does not check it, or it is GRANT-ONLY and was not
 *                  granted at the subscription
 *   never-checked  no audit has run for this connection
 *   unreachable    no Azure identity is configured at all
 *
 * unknown and never-checked are never worded as denied
 * (claude-kit standards/inventory-honesty.md: an audit that has not run is not
 * evidence of a denial). GRANT-ONLY: automations/write is evaluated at the
 * subscription while the automation lives in a resource group the operator
 * picks later, so a miss there says nothing about a role on that group.
 * capability-mapping records nothing for it, and this view also turns a cached
 * `denied` for it into unknown, so a set written before that rule cannot
 * resurrect the claim.
 *
 * DEPLOY IS BLOCKED ONLY BY A MEASURED DENIAL OF A CORE CAPABILITY - the
 * operator's request, written on the card. This is a deliberate, scoped
 * departure from capabilities.ts rule 3 ("the audit informs and offers, never
 * forbids"): the verdict is Azure's own effective-action evaluation at the very
 * subscription the export is written to, the deploy re-lists before it writes
 * (so a refused automations read would fail it anyway), and the How-to path is
 * the offered fallback. A capability deploy does not need (plans.read) is
 * `informational`: its denial warns but never blocks.
 *
 * VISIBLE COPY. Every string here reaches the screen: no card ids, dates or
 * phases (the copy-history gate in the ui package reads them).
 *
 * Pure: no IO, no fetch, no React, no clock (the caller passes `nowIso`).
 */

import { verdictFor } from "../capabilities/capabilities";
import { auditAgeMs, describeAuditAge, usableCapabilitySet } from "../capabilities/audit-lifecycle";
import type {
  AzureCapability,
  CapabilityContext,
  CapabilitySet,
  CapabilityVerdict,
} from "../capabilities/capabilities";
import type { RequiredAction } from "../azure-permissions/azure-permissions";
import {
  DEFENDER_AUTOMATIONS_READ,
  DEFENDER_AUTOMATIONS_WRITE,
  DEFENDER_NAMESPACE_ACTIONS,
  DEFENDER_PRICINGS_READ,
} from "../defender-export/defender-permissions";
import type { OnboardingItemId } from "../onboarding-selection";
import type { ItemAvailability } from "./onboarding-sections";

/**
 * Whether automating the source depends on the capability.
 *
 *   core           the deploy cannot work without it; a measured denial blocks
 *   informational  the section reads something with it, deploy works without
 */
export type AutomationNecessity = "core" | "informational";

/** One capability an automatable source's automation needs, as the audit measures it. */
export interface AutomationCapabilityNeed {
  readonly capability: AzureCapability;
  /** The Azure action the preflight checks for it (the capability-mapping key). */
  readonly action: string;
  /** What it lets the app do, as a verb phrase after "cannot": "create the continuous export". */
  readonly does: string;
  /**
   * The built-in role an administrator would grant. Inferred from Azure's
   * built-in role definitions, not measured here (verify live).
   */
  readonly role: string;
  readonly necessity: AutomationNecessity;
  /** Evaluated above its resource's scope: a miss is unknown, never denied. */
  readonly grantOnly: boolean;
}

/** Actions the source needs that no capability measures yet, grouped by scope. */
export interface UnmeasuredActionGroup {
  /** Visible scope heading: "On the Event Hub namespace". */
  readonly scope: string;
  readonly actions: readonly RequiredAction[];
}

/** Everything one automatable source needs from Azure to be automated. */
export interface AutomationPermissions {
  /** The source's visible name, as the banner says it. */
  readonly sourceTitle: string;
  /** Visible heading over the measured list: "On the subscription". */
  readonly measuredScope: string;
  readonly measured: readonly AutomationCapabilityNeed[];
  readonly notMeasured: readonly UnmeasuredActionGroup[];
}

const DEFENDER_EXPORT_PERMISSIONS: AutomationPermissions = {
  sourceTitle: "Defender for Cloud alert export",
  measuredScope: "On the subscription",
  measured: [
    {
      capability: "defender-plans.read",
      action: DEFENDER_PRICINGS_READ,
      does: "read which Defender plans are enabled",
      role: "Security Reader",
      // ADR 0005 section 5: deploy is allowed with no plan read at all.
      necessity: "informational",
      grantOnly: false,
    },
    {
      capability: "defender-automation.read",
      action: DEFENDER_AUTOMATIONS_READ,
      does: "list the subscription's continuous exports",
      role: "Security Reader",
      // The deploy re-lists and refuses before it writes (create-only).
      necessity: "core",
      grantOnly: false,
    },
    {
      capability: "defender-automation.write",
      action: DEFENDER_AUTOMATIONS_WRITE,
      does: "create the continuous export",
      role: "Security Admin",
      necessity: "core",
      // capability-mapping GRANT_ONLY_AZURE_ACTIONS; pinned equal there.
      grantOnly: true,
    },
  ],
  // CAP-7b: listKeys can be granted on the namespace itself, so it stays
  // unmeasured and is listed as such.
  notMeasured: [{ scope: "On the Event Hub namespace", actions: DEFENDER_NAMESPACE_ACTIONS }],
};

/**
 * The declaration per AUTOMATABLE item. Keyed like ITEM_AVAILABILITY and
 * covering exactly its "available" ids - the pin holds both directions.
 */
export const AUTOMATION_PERMISSIONS: Readonly<Record<OnboardingItemId, AutomationPermissions>> = {
  defenderExport: DEFENDER_EXPORT_PERMISSIONS,
};

/** The declaration for one item, or null when it has none (nothing to automate). */
export function automationPermissionsFor(id: OnboardingItemId): AutomationPermissions | null {
  return Object.prototype.hasOwnProperty.call(AUTOMATION_PERMISSIONS, id)
    ? (AUTOMATION_PERMISSIONS[id] ?? null)
    : null;
}

/**
 * Ids an availability map marks available that a permissions map does not
 * declare, sorted. Empty is the only acceptable answer for the shipped maps; a
 * function so the coverage pin can be planted and shown to fail.
 */
export function undeclaredAutomatableItems(
  availability: Readonly<Record<string, ItemAvailability>>,
  permissions: Readonly<Record<string, AutomationPermissions>>,
): string[] {
  return Object.entries(availability)
    .filter(([id, a]) => a.status === "available" && !Object.prototype.hasOwnProperty.call(permissions, id))
    .map(([id]) => id)
    .sort();
}

/** What is known about one need. Only `denied` is a denial. */
export type AutomationNeedState = "granted" | "denied" | "unknown" | "never-checked" | "unreachable";

export interface AutomationNeedRow {
  readonly need: AutomationCapabilityNeed;
  readonly state: AutomationNeedState;
  /** Visible state text beside the action. */
  readonly stateLabel: string;
}

/**
 * The banner over the section.
 *
 *   blocked       a core capability was measured denied: deploy is blocked
 *   not-measured  a core capability is unknown, never checked or unreachable
 *   partial       only an informational capability is denied: deploy works
 */
export interface AutomationBanner {
  readonly kind: "blocked" | "not-measured" | "partial";
  readonly tone: "info" | "warning" | "error";
  readonly text: string;
  /** Whether Re-check permissions is offered (not without an identity to check). */
  readonly offerRecheck: boolean;
}

export interface AutomationPermissionView {
  readonly rows: readonly AutomationNeedRow[];
  readonly banner: AutomationBanner | null;
  /** Non-null only for a measured denial of a core capability. */
  readonly deployBlockedReason: string | null;
}

export interface AutomationPermissionInput {
  readonly permissions: AutomationPermissions;
  /** The shell's cached set, or undefined when the shell wired no audit. */
  readonly capabilities: CapabilitySet | undefined;
  /** Connection facts; undefined is read as "an identity is configured". */
  readonly context: CapabilityContext | undefined;
  /** The number of the How-to section on the screen, so the copy names it. */
  readonly howtoSection: number;
  /**
   * The CURRENT connection's audit key. When given, a set whose connectionId
   * differs is another connection's and is read as never checked. Absent =
   * the set is trusted as this connection's (a shell that wires no key).
   */
  readonly auditKey?: string;
  /** The shell's clock, so the blocking copy can say how old the check is. */
  readonly nowIso?: string;
}

const ASSUME_CONNECTED: CapabilityContext = { azureIdentityPresent: true, criblReachable: true };

function needState(
  need: AutomationCapabilityNeed,
  set: CapabilitySet | undefined,
  context: CapabilityContext,
): AutomationNeedState {
  let verdict: CapabilityVerdict =
    set === undefined
      ? context.azureIdentityPresent
        ? "unknown"
        : "unreachable"
      : verdictFor(need.capability, set, context);
  if (verdict === "denied" && need.grantOnly) verdict = "unknown";
  if (verdict === "unknown" && (set === undefined || set.auditedAt === null)) return "never-checked";
  return verdict;
}

function stateLabel(need: AutomationCapabilityNeed, state: AutomationNeedState): string {
  switch (state) {
    case "granted":
      return "Granted";
    case "denied":
      return "Denied";
    case "unknown":
      return need.grantOnly ? "Not measured (grant-only check)" : "Not measured by the last permission check";
    case "never-checked":
      return "Not checked yet";
    case "unreachable":
      return "Not checked - no Azure identity is connected";
  }
}

/** "a", "a and b", "a, b and c". */
function phrase(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1] ?? ""}`;
}

function rolesOf(needs: readonly AutomationCapabilityNeed[]): string {
  return phrase([...new Set(needs.map((n) => n.role))]);
}

/**
 * The banner and per-capability rows for one automatable source, from the
 * cached audit alone. Precedence: a core denial blocks; otherwise any core
 * capability not known to be granted gets the soft note; otherwise an
 * informational denial warns; otherwise there is nothing to say.
 */
export function automationPermissionView(input: AutomationPermissionInput): AutomationPermissionView {
  const { permissions, howtoSection } = input;
  const capabilities =
    input.capabilities !== undefined && input.auditKey !== undefined
      ? usableCapabilitySet(input.capabilities, input.auditKey)
      : input.capabilities;
  const context = input.context ?? ASSUME_CONNECTED;
  const source = permissions.sourceTitle;
  const rows: AutomationNeedRow[] = permissions.measured.map((need) => {
    const state = needState(need, capabilities, context);
    return { need, state, stateLabel: stateLabel(need, state) };
  });
  const core = rows.filter((r) => r.need.necessity === "core");

  const denied = core.filter((r) => r.state === "denied").map((r) => r.need);
  if (denied.length > 0) {
    const does = phrase(denied.map((n) => n.does));
    const actions = denied.map((n) => n.action).join(", ");
    // A denial can be days old (one-slot cache), so the copy says when it was measured.
    const check =
      input.nowIso !== undefined && capabilities !== undefined && auditAgeMs(capabilities, input.nowIso) !== null
        ? `the permission check ${describeAuditAge(capabilities, input.nowIso)}`
        : "the last permission check";
    return {
      rows,
      banner: {
        kind: "blocked",
        tone: "error",
        text:
          `${check.charAt(0).toUpperCase()}${check.slice(1)} found your Azure identity cannot ${does} ` +
          `(${actions}), so this section cannot set ${source} up. If the role was granted since, ` +
          `Re-check permissions. Otherwise switch ${source} to How-to in section ${howtoSection} to see its ` +
          `steps, or ask an administrator for ${rolesOf(denied)} on the subscription.`,
        offerRecheck: true,
      },
      deployBlockedReason:
        `Deploy is blocked: ${check} found your Azure identity cannot ${does} (${actions}). ` +
        `Re-check permissions if the role was granted since, or switch it to How-to in section ${howtoSection}.`,
    };
  }

  const open = core.filter((r) => r.state !== "granted");
  if (open.length > 0) {
    if (open.some((r) => r.state === "unreachable")) {
      return {
        rows,
        banner: {
          kind: "not-measured",
          tone: "info",
          text: `No Azure identity is connected, so whether it can set ${source} up has not been checked.`,
          offerRecheck: false,
        },
        deployBlockedReason: null,
      };
    }
    if (open.some((r) => r.state === "never-checked")) {
      return {
        rows,
        banner: {
          kind: "not-measured",
          tone: "info",
          text:
            `Permissions have not been checked for this connection yet, so whether your Azure identity ` +
            `can set ${source} up is not known. Re-check permissions to measure them; Azure's own answer ` +
            `at each step is what decides.`,
          offerRecheck: true,
        },
        deployBlockedReason: null,
      };
    }
    const grantOnly = open.some((r) => r.need.grantOnly);
    return {
      rows,
      banner: {
        kind: "not-measured",
        tone: "info",
        text:
          `The last permission check did not measure whether your Azure identity can ` +
          `${phrase(open.map((r) => r.need.does))}, so whether it can set ${source} up is not known.` +
          (grantOnly
            ? " The check sees only roles on the whole subscription; a role on the export's resource group is checked by Azure at deploy."
            : " Re-check permissions to measure it; Azure's own answer at each step is what decides."),
        offerRecheck: true,
      },
      deployBlockedReason: null,
    };
  }

  const informational = rows
    .filter((r) => r.need.necessity === "informational" && r.state === "denied")
    .map((r) => r.need);
  if (informational.length > 0) {
    return {
      rows,
      banner: {
        kind: "partial",
        tone: "warning",
        text:
          `Your Azure identity cannot ${phrase(informational.map((n) => n.does))}. Deploy does not need it ` +
          `and is not blocked; ask an administrator for ${rolesOf(informational)} to see it.`,
        offerRecheck: true,
      },
      deployBlockedReason: null,
    };
  }

  return { rows, banner: null, deployBlockedReason: null };
}
