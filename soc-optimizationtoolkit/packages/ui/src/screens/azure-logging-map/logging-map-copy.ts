/**
 * logging-map-copy - every customer-visible word of the Azure Logging Map
 * screen (AZR-19, phase 1, READ-ONLY), in one place so the copy gate
 * (logging-map-copy.test.ts) can run the no-project-history rule over all of
 * it, and so the canvas, outline, panel and toolbar cannot word one state two
 * different ways.
 *
 * THE RULES THE WORDS KEEP (inventory-honesty, info-affordances):
 * - a list that could not be read is "could not be read", never "none" and
 *   never 0 - and it names the role that would reveal it;
 * - "none" is said only for a VERIFIED zero (a per-scope read that answered
 *   2xx with an array on every page - core's toListingFromRead);
 * - an ownership claim says what it rests on; a bare name match says so;
 * - no project ids, plan phases or dates in anything the operator reads.
 *
 * Pure: no React, no DOM, no clock.
 */

import type {
  CoverageState,
  LoggingClass,
  LoggingDestination,
  OwnershipEvidenceKind,
  OwnershipStrength,
  Refusal,
  RolesNote,
  ScopeKind,
  ScopeNode,
  TraceSummary,
} from "@soc/core";

import type { TraceMark, UiLoggingMap } from "./logging-map-state";

// ---------------------------------------------------------------- scopes

/** The header strip on a canvas card. */
export const KIND_HEADER: Readonly<Record<ScopeKind, string>> = {
  "tenant-root": "TENANT ROOT",
  "management-group": "MANAGEMENT GROUP",
  subscription: "SUBSCRIPTION",
  placeholder: "PARENT NOT READ",
};

/** The kind in a sentence or an eyebrow. */
export const KIND_WORD: Readonly<Record<ScopeKind, string>> = {
  "tenant-root": "Tenant Root Group",
  "management-group": "Management group",
  subscription: "Subscription",
  placeholder: "Subscriptions whose parent was not read",
};

/** The short outline tag before a scope name. */
export const KIND_TAG: Readonly<Record<ScopeKind, string>> = {
  "tenant-root": "ROOT",
  "management-group": "MG",
  subscription: "SUB",
  placeholder: "UNREAD PARENT",
};

/** The role that would let this app read a scope's policy, in words. */
export function readRoleFor(kind: ScopeKind): string {
  if (kind === "subscription") return "Reader on this subscription would reveal it.";
  if (kind === "placeholder") return "Management Group Reader on the parent management group would reveal where they sit.";
  return "Reader on this management group would reveal it.";
}

export const TENANT_ROOT_ROLE = "Management Group Reader at the Tenant Root Group";

/**
 * True when a scope is drawn and worded as UNREADABLE - a dashed card, the
 * lock note, "can't be read": it was never listed (an unread origin), or its
 * assignments read was refused. Kept beside the words it selects so the
 * canvas and the outline cannot disagree about which scopes get them. The
 * parent-unknown holder is not an Azure scope and is never "unreadable".
 */
export function isUnreadable(map: UiLoggingMap, scopeId: string): boolean {
  const n = map.nodesById.get(scopeId);
  if (n === undefined) return false;
  if (n.node.treeRole === "unread-origin") return true;
  if (n.node.kind === "placeholder") return false;
  return n.assignments.kind === "empty";
}

/** The lock note on an unreadable card (kept short: it is one card line). */
export const LOCK_NOTE = "can't be read, needs Reader";

/** Why a node is unreadable, in one sentence, or null when it is readable. */
export function unreadSentence(node: ScopeNode, assignmentsUnread: boolean): string | null {
  if (node.treeRole === "unread-origin") {
    return "Seen only as the origin of an inherited assignment. This scope was never listed, so what is set here and what it covers below are unknown, not empty.";
  }
  if (node.treeRole === "parent-unknown") {
    return "These subscriptions were listed, but the management group above them was not read, so where they sit in the tree is unknown.";
  }
  if (assignmentsUnread) {
    return "The policy assignments at this scope could not be read. This scope is counted as unknown, not as uncovered.";
  }
  return null;
}

// ---------------------------------------------------------------- ownership

export function ownerPill(owner: "ours" | "other" | null): string {
  if (owner === "ours") return "ours";
  if (owner === "other") return "other owner";
  return "owner unknown";
}

export const STRENGTH_LABEL: Readonly<Record<OwnershipStrength, string>> = {
  "toolkit-marker": "Toolkit marker on the assignment",
  "legacy-strong": "Earlier toolkit: name, definition and scope all match",
  "legacy-identity": "Earlier toolkit's managed identity",
  "name-only": "name match",
  none: "Someone else's assignment",
};

export const EVIDENCE_LABEL: Readonly<Record<OwnershipEvidenceKind, string>> = {
  "toolkit-marker": "Toolkit marker",
  "legacy-strong": "Earlier toolkit, strong match",
  "legacy-identity": "Earlier toolkit identity",
  "name-only": "Name match only",
  "legacy-shape-mismatch": "Name looks like the earlier toolkit, but the scope or definition does not",
  "diagnostic-setting-name-hint": "Diagnostic setting name hint (never enough on its own)",
};

// ---------------------------------------------------------------- logging class

export const DESTINATION_LABEL: Readonly<Record<LoggingDestination, string>> = {
  "event-hub": "Event Hub",
  "log-analytics": "Log Analytics",
  storage: "Storage account",
  dcr: "Data Collection Rule",
};

function destinations(list: readonly LoggingDestination[]): string {
  return list.length === 0 ? "a destination the parameters do not name" : list.map((d) => DESTINATION_LABEL[d]).join(", ");
}

/** What the assignment does, in one sentence. */
export function classSentence(c: LoggingClass | null): string {
  if (c === null) return "Unclassified: its definition was not judged.";
  if (c.verdict === "yes") return `Deploys diagnostic settings to ${destinations(c.destinations)}.`;
  if (c.verdict === "no") {
    return c.reason === "effect-not-deploy"
      ? `Not a logging deployment: its effect is ${c.effect ?? "not DeployIfNotExists"}.`
      : "Not a logging policy: it does not deploy diagnostic settings.";
  }
  if (c.reason === "effect-unresolved") return "Unclassified: its effect could not be resolved.";
  return c.reason === "member-not-read"
    ? "Unclassified: some initiative members could not be read."
    : "Unclassified: its definition could not be read.";
}

/** The pill a chip carries for its logging class, or null when it needs none. */
export function classPill(c: LoggingClass | null): string | null {
  if (c === null || c.verdict === "unknown") return "unclassified";
  return null;
}

// ---------------------------------------------------------------- coverage

/** Append the selector regions, when present, so a pill keeps both facts. */
function withRegions(text: string, regions: readonly string[] | undefined): string {
  return regions !== undefined && regions.length > 0 ? `${text}, regions: ${regions.join(", ")}` : text;
}

/** The short pill text for a coverage state at a scope, or null for plain covered / not reached. */
export function coveragePill(c: CoverageState | null): string | null {
  if (c === null) return null;
  switch (c.state) {
    case "covered":
    case "not-reached":
      return null;
    case "excluded":
      return "excluded";
    case "exempt":
      return "exempt";
    case "partially-exempt":
      return "partly exempt";
    case "partial":
      return withRegions(`${c.belowCount} below excluded`, c.regions);
    case "conditional":
      return `regions: ${c.regions.join(", ")}`;
    case "covered-exemptions-unknown":
      return withRegions(
        c.belowCount !== undefined && c.belowCount > 0
          ? `exemptions unknown, ${c.belowCount} below excluded`
          : "exemptions unknown",
        c.regions,
      );
    case "unknown":
      return "unknown";
  }
}

function regionsSentence(regions: readonly string[] | undefined): string {
  return regions !== undefined && regions.length > 0 ? ` Only resources in: ${regions.join(", ")}.` : "";
}

/**
 * What an assignment does at this scope, in one sentence. For an inherited
 * entry `originName` is where it is set; at its own origin the panel shows the
 * sentence only for a state other than plain covered.
 */
export function coverageSentence(c: CoverageState | null, originName: string): string {
  if (c === null) return `Set at ${originName}.`;
  switch (c.state) {
    case "covered":
      return `Applies here, from ${originName}.`;
    case "conditional":
      return `Applies here only to resources in: ${c.regions.join(", ")}.`;
    case "partial":
      return `Applies here, but ${c.belowCount} resource group or resource scope${c.belowCount === 1 ? " is" : "s are"} excluded or exempt below.${regionsSentence(c.regions)}`;
    case "covered-exemptions-unknown":
      return `Applies here, but the exemptions here could not be read, so an exemption may be hiding.${
        c.belowCount !== undefined && c.belowCount > 0
          ? ` At least ${c.belowCount} resource group or resource scope${c.belowCount === 1 ? " is" : "s are"} excluded below.`
          : ""
      }${regionsSentence(c.regions)}`;
    case "exempt":
      return "Exempt here, so it does not apply.";
    case "partially-exempt":
      return `Partly exempt here: ${c.referenceIds.length} initiative member${c.referenceIds.length === 1 ? " is" : "s are"} exempt.`;
    case "excluded":
      return "Excluded here by notScopes, so it does not apply.";
    case "unknown":
      return c.why === "assignments-unread"
        ? "Can't tell whether it applies: the assignments here could not be read."
        : "Can't tell whether it applies: the tree above this scope was not fully read.";
    case "not-reached":
      return "Does not reach this scope.";
  }
}

/** The card's status line while an assignment is traced. */
export const MARK_LABEL: Readonly<Record<TraceMark, string>> = {
  origin: "assigned here",
  covered: "covered",
  "covered-exemptions-unknown": "covered, exemptions unknown",
  "gap-excluded": "excluded (notScopes)",
  "gap-exempt": "exempt",
  partial: "partly covered",
  conditional: "covered for some regions",
  unknown: "unknown, can't be read",
  dimmed: "not reached",
};

/** The panel's trace summary line. Unknown is its own figure, never folded into "not reached". */
export function traceSummaryText(s: TraceSummary): string {
  const covered = s.subscriptionsCovered + s.coveredExemptionsUnknown + s.partial + s.conditional;
  const parts = [
    `covers ${covered} subscription${covered === 1 ? "" : "s"}`,
    `${s.excluded} excluded`,
    `${s.exempt} exempt`,
    `${s.unknown} unknown`,
  ];
  if (s.coveredExemptionsUnknown > 0) parts.push(`${s.coveredExemptionsUnknown} with exemptions unknown`);
  if (s.partial > 0) parts.push(`${s.partial} partly covered`);
  if (s.conditional > 0) parts.push(`${s.conditional} for some regions only`);
  return `${parts.join(", ")}.`;
}

// ---------------------------------------------------------------- roles and refusals

/** Why a read was refused, in words, with the raw text for the logs. */
export function refusalText(r: Refusal): string {
  if (r.reason === "http") return `Azure answered ${r.status ?? "an error"}${r.code !== "" ? ` (${r.code})` : ""}.`;
  if (r.reason === "transport") return "The request did not complete.";
  if (r.reason === "unexpected-shape") return "Azure answered in a shape this app does not recognise.";
  return /cap reached/i.test(r.text) ? "not read: cap reached" : "Too many pages to read.";
}

/** The roles row when there is no grant list to show. */
export function rolesNoteText(note: RolesNote): string {
  switch (note) {
    case "no-identity":
      return "No managed identity, so no roles.";
    case "principal-not-given":
      return "Roles unknown: Azure did not give the identity's principal id.";
    case "not-read":
      return "Roles not read: this assignment is not in the default view.";
    case "some-not-read":
      return "Roles of some of this identity's principals were not read.";
  }
}

export const ROLES_REFUSED = "Roles could not be read.";
export const ROLES_EMPTY_VERIFIED = "No role assignments for this identity at or below this scope.";
export const ROLES_ROLE_HINT = "Reader on the assignment's scope would reveal them.";

// ---------------------------------------------------------------- panel words

export const NO_EXEMPTIONS = "No exemptions at this scope.";
export const EXEMPTIONS_REFUSED = "Exemptions could not be read.";
export const NO_ASSIGNMENTS_HERE = "Nothing is assigned directly on this scope.";
export const ASSIGNMENTS_REFUSED = "Assignments could not be read.";

/** The Azure portal page for a scope. */
export function portalLink(scopeId: string): string {
  return `https://portal.azure.com/#resource${scopeId}/overview`;
}

// ---------------------------------------------------------------- tips

/** Every InfoTip on the screen. */
export const TIPS = {
  scopes:
    "Management groups and subscriptions this app could list. Subscriptions are only those its identity can see; the list is filtered by permission, so a missing one may still exist.",
  couldNotRead:
    "Reads Azure refused or did not answer: assignments, exemptions, the tree, definitions and roles. Each is counted here and drawn as unknown, never as empty or uncovered.",
  unclassified:
    "Assignments whose policy definition could not be read, so the app cannot tell whether they deploy logging. They are always shown, never hidden as not logging.",
  rolesUnread:
    "Managed identities whose role assignments could not be read, or were not read because the read limit was reached. Their roles are unknown, not absent.",
  trace:
    "Pick one assignment to see what it reaches: its scope is ringed, covered scopes are filled, gaps are hatched, and scopes that could not be read stay marked unknown.",
  inherited:
    "Show assignments that apply at a scope because they are set above it, drawn dotted with the scope they come from.",
  allPolicy:
    "By default the map shows the toolkit's assignments, other owners' logging assignments, and anything it could not classify. Turn this on to show every policy assignment.",
  search: "Find a management group, subscription or assignment by name. The tree opens just the path to each match.",
  legend:
    "Every state is drawn with more than colour: a pill, a border style or a hatch. Ours means the toolkit (or the earlier toolkit) wrote it; name match means only the name looks like ours. Read only: nothing on this screen changes Azure.",
} as const;

/** The legend rows, in order: swatch class suffix and words. */
export const LEGEND: readonly { readonly key: string; readonly label: string }[] = [
  { key: "ours", label: "Applied by the toolkit (pill: ours)" },
  { key: "other", label: "Someone else's assignment" },
  { key: "inherited", label: "Inherited from above (dotted, italic)" },
  { key: "gap", label: "Excluded or exempt (hatched, with a pill)" },
  { key: "unread", label: "Can't be read (dashed, lock note)" },
];

export const SCREEN_LEAD =
  "Where each logging policy is assigned in the tenant: the management group tree down to subscriptions, what each assignment reaches by inheritance, and where it stops. Read only.";
