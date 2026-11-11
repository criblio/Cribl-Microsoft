/**
 * Pure presentation for the data allowance cards (MIG-15): the words and
 * figures the cards, the table's Allowance and Over columns and the CSV show.
 *
 * UNKNOWN IS NOT ZERO (docs/inventory-standard.md, binding): an eligible
 * volume that was not read renders "not read", a granted figure that could not
 * be established renders "not known" with its reason, and a lower bound reads
 * "at least". Pure: no IO, no React.
 */

import {
  allowanceFor,
  E5_MB_PER_SEAT_PER_DAY,
  listingRows,
  SERVERS_MB_PER_MACHINE_PER_DAY,
} from "@soc/core";
import type {
  AllowanceTag,
  CrossCheck,
  DataAllowances,
  GrantId,
  GrantView,
  GrantWindowTotals,
  WindowNet,
  WorkspaceDiscovery,
} from "@soc/core";
import { formatGB, formatMB } from "./format-mb";

export const GRANT_LABEL: Record<GrantId, string> = {
  e5: "E5 5 MB/user",
  "servers-p2": "Servers P2 500 MB/machine",
};

/** A daily volume in the unit that keeps it readable (MB, GB or TB, via formatMB): a sub-GB figure never rounds to 0.0 GB. */
export function mbPerDay(mb: number): string {
  return `${formatMB(mb)}/day`;
}

export function tagLabel(tag: AllowanceTag): string {
  if (tag.kind === "free") return "Free";
  if (tag.kind === "billable") return "Billable";
  return `${GRANT_LABEL[tag.grant]}${tag.condition !== null ? " (conditional)" : ""}`;
}

/** The rule behind a tag, for the per-row drill-down. */
export function tagRule(tag: AllowanceTag): string {
  if (tag.kind === "free") return "A table Microsoft never bills for ingestion (a Sentinel free data source or an Azure Monitor excluded table).";
  if (tag.kind === "billable") return "No Microsoft data grant covers this table.";
  const rule =
    tag.grant === "e5"
      ? "Covered by the Microsoft 365 E5/A5/F5/G5/E7 benefit: 5 MB per qualifying user per day, pooled across every eligible table."
      : "Covered by the Defender for Servers Plan 2 benefit: 500 MB per machine per day, pooled across every eligible table.";
  return tag.condition !== null ? `${rule} Condition: ${tag.condition}.` : rule;
}

/** The reroute warning for a table that falls under a grant. */
export function rerouteWarning(table: string, eligibleDailyMB: number | null): string {
  const volume = eligibleDailyMB === null ? "its eligible volume (not read)" : `${formatMB(eligibleDailyMB)}/day`;
  return (
    `Data keeps its grant only if it still lands in ${table}; routing it to a _CL table ` +
    `forfeits up to ${volume} of coverage.`
  );
}

/** Why a grant's granted figure is null - never a zero. */
export function grantedUnknownReason(view: GrantView, a: DataAllowances | null): string {
  if (view.grant === "e5") {
    if (a === null || a.licences.kind === "read") return "the granted figure could not be established";
    return "licence counts were not read and no benefit was applied in the window";
  }
  if (a !== null && a.servers.rows.length === 0) {
    // A failed or partial Heartbeat read is not "no machines": it was not read.
    if (!a.servers.heartbeatComplete) return "reporting machines were not read";
    return a.servers.unattributedMachines > 0
      ? "no reporting machine was attributed to a subscription"
      : "no reporting machines were found";
  }
  return "no subscription's Defender plan could be read";
}

/**
 * Can this card compare its granted figure with its eligible volume? The E5
 * grant is tenant-wide: in one workspace's view it is comparable only when
 * that workspace is the tenant's only Sentinel workspace. Servers P2 is granted
 * per workspace (machines reporting here), so it is always comparable.
 */
export function headroomApplies(view: GrantView, a: DataAllowances | null): boolean {
  if (a === null || a.scope.kind !== "workspace" || view.grant !== "e5") return true;
  // Invariant: a floored count (sentinelWorkspacesAtLeast) is always >= 2 -
  // sentinelWorkspaceCount returns null rather than a floor of 0 or 1 - so `=== 1` excludes it.
  return a.scope.sentinelWorkspaces === 1;
}

const TENANT_WIDE_HEADROOM = "headroom is tenant-wide - use Compare against the whole tenant";

export interface GrantCardText {
  title: string;
  granted: string;
  eligibleUsed: string;
  status: string;
}

/**
 * The card's four lines. Pass the whole result when there is one: it supplies
 * the "at least" of floored sums and the reason a granted figure is unknown.
 */
export function grantCardText(view: GrantView, a: DataAllowances | null = null): GrantCardText {
  const floors = a?.sumsAreFloors === true;
  const atLeast = floors ? "at least " : "";
  // A partial benefit read: Used is a lower bound, so Over (eligible - used) is not known.
  const usedFloor = a?.usedIsFloor === true;
  // Graph cannot de-duplicate a user holding two qualifying SKUs: say so on the
  // card itself, not only in the drill-down arithmetic.
  const mayDoubleCount =
    view.grant === "e5" && a?.licences.kind === "read" && a.licences.e5.assignedMayDoubleCount
      ? " (may count users holding two qualifying licences twice)"
      : "";
  const granted =
    view.grantedMB === null
      ? `not known - ${grantedUnknownReason(view, a)}`
      : view.grantedIsFloor
        ? `at least ${mbPerDay(view.grantedMB)}${mayDoubleCount}`
        : `${mbPerDay(view.grantedMB)}${mayDoubleCount}`;
  const eligible = view.eligibleKnown ? `${atLeast}${mbPerDay(view.usage.eligibleDailyMB)}` : "not read";
  const usedAtLeast = floors || usedFloor ? "at least " : "";
  const eligibleUsed = `eligible ${eligible}, used ${usedAtLeast}${mbPerDay(view.usage.usedDailyMB)}`;

  let status: string;
  if (!view.eligibleKnown) {
    status = "over and headroom not read";
  } else if (usedFloor) {
    status = "over not known (partial benefit read)";
  } else if (view.usage.overDailyMB > 0) {
    status = `${atLeast}${mbPerDay(view.usage.overDailyMB)} over`;
  } else if (view.grantedMB === null || view.grantedIsFloor || floors) {
    // Headroom needs an exact granted figure and an exact eligible sum.
    status = floors ? "over not known (partial read)" : "no day ran over";
  } else if (!headroomApplies(view, a)) {
    status = TENANT_WIDE_HEADROOM;
  } else {
    status = `${mbPerDay(Math.max(0, view.grantedMB - view.usage.eligibleDailyMB))} headroom`;
  }
  return { title: GRANT_LABEL[view.grant], granted, eligibleUsed, status };
}

/**
 * Is the eligible-against-granted meter drawable? Not for a grant this view
 * cannot compare, and not when Granted is only a lower bound: a marker at the
 * floor would draw a headroom (or an overage) the text withholds.
 */
export function meterOf(
  view: GrantView,
  a: DataAllowances | null = null,
): { eligiblePct: number; grantedPct: number } | null {
  if (!view.eligibleKnown || view.grantedMB === null || view.grantedMB <= 0) return null;
  if (view.grantedIsFloor) return null;
  if (!headroomApplies(view, a)) return null;
  const max = Math.max(view.grantedMB, view.usage.eligibleDailyMB);
  if (max <= 0) return null;
  return {
    eligiblePct: (view.usage.eligibleDailyMB / max) * 100,
    grantedPct: (view.grantedMB / max) * 100,
  };
}

/** A table row's minimal shape for the Over column. */
export interface OverRow {
  table: string;
  billableMB: number;
}

/**
 * The table's "Over allowance / day" cell. A grant's overage is pooled, so a
 * grant table reads "share of N" and the overage is never split per table.
 */
export function overCell(row: OverRow, a: DataAllowances | null, windowDays: number): string {
  const tag = allowanceFor(row.table);
  // Usage's IsBillable is the authority: a Free-tagged table Usage still bills
  // is billable volume no grant covers, never a 0 beside a billed figure.
  if (tag.kind === "free") return row.billableMB > 0 ? formatMB(row.billableMB / windowDays) : "0";
  if (tag.kind === "billable") return formatMB(row.billableMB / windowDays);
  if (a === null) return "";
  if (a.attribution === "pooled") {
    if (a.pooled === null) return "not known";
    // The pooled overage is worked out from the eligible sum; unread, it is not a figure.
    if (!a.eligibleKnown) return "not read";
    if (a.usedIsFloor) return "not known (partial benefit read)";
    return `share of ${a.sumsAreFloors ? "at least " : ""}${formatMB(a.pooled.overDailyMB)} (all grants)`;
  }
  const view = a.grants.find((g) => g.grant === tag.grant);
  if (view === undefined) {
    // No view means the grant had no eligible and no applied volume. That is a
    // measured zero only when this table has no billable volume; otherwise the
    // eligible read did not see what Usage billed, so it was not read.
    return row.billableMB > 0 ? "not read" : "0";
  }
  if (!view.eligibleKnown) return "not read";
  if (a.usedIsFloor) return "not known (partial benefit read)";
  if (view.usage.overDailyMB <= 0) return a.sumsAreFloors ? "not known (partial read)" : "0";
  return `share of ${a.sumsAreFloors ? "at least " : ""}${formatMB(view.usage.overDailyMB)}`;
}

const BASIS_LABEL: Record<string, string> = {
  assigned: "assigned seats",
  purchased: "purchased seats",
  "reporting-here": "machines reporting here",
  "in-subscription": "machines in the subscription",
};

/** In a tenant comparison the Servers count spans the workspaces read, so "here" would mislead. */
const TENANT_BASIS_LABEL: Record<string, string> = {
  "reporting-here": "machines reporting to the workspaces read",
};

export function basisLabel(basis: string, tenant = false): string {
  return (tenant ? TENANT_BASIS_LABEL[basis] : undefined) ?? BASIS_LABEL[basis] ?? basis;
}

export function crossCheckLine(c: CrossCheck, tenant = false): string {
  switch (c.kind) {
    case "skipped":
      return /^cross-check skipped/i.test(c.reason) ? c.reason : `Cross-check skipped: ${c.reason}.`;
    case "no-capped-day":
      return (
        "Cannot be confirmed yet: no day in the window ran over the grant, so Microsoft's " +
        "applied figure never showed the cap."
      );
    case "matched":
      return (
        `Consistent: on days the grant ran out, Microsoft applied a median of ` +
        `${mbPerDay(c.medianMB)}, which matches the ${basisLabel(c.basis, tenant)} basis.`
      );
    case "unmatched": {
      const diffs = c.diffs
        .map((d) => `${basisLabel(d.basis, tenant)} by ${d.pct >= 0 ? "+" : ""}${(d.pct * 100).toFixed(1)}%`)
        .join(", ");
      return (
        `Not matched: on days the grant ran out, Microsoft applied a median of ` +
        `${mbPerDay(c.medianMB)}, which differs from ${diffs || "no basis"}. Neither basis is marked.`
      );
    }
  }
}

/** The granted figure on each basis, for the arithmetic lines. */
export interface BasisFigure {
  basis: string;
  count: number | null;
  mbPerUnit: number;
  /** null when the count is not known. */
  mb: number | null;
  /** The count is a lower bound (a plan or a workspace was not read, or a read was partial). */
  atLeast: boolean;
  /** A caveat on the count the arithmetic cannot show, or null. */
  note: string | null;
}

const DOUBLE_COUNT_NOTE =
  "may count a user twice - more than one qualifying SKU has seats assigned, and Graph cannot " +
  "show which users hold both; the cross-check settles it";

export function basisFigures(view: GrantView, a: DataAllowances): BasisFigure[] {
  if (view.grant === "e5") {
    if (a.licences.kind !== "read") return [];
    const e5 = a.licences.e5;
    return [
      {
        basis: "assigned",
        count: e5.assigned,
        mbPerUnit: E5_MB_PER_SEAT_PER_DAY,
        mb: e5.grantedMB.assigned,
        atLeast: false,
        note: e5.assignedMayDoubleCount ? DOUBLE_COUNT_NOTE : null,
      },
      {
        basis: "purchased",
        count: e5.purchased,
        mbPerUnit: E5_MB_PER_SEAT_PER_DAY,
        mb: e5.grantedMB.purchased,
        atLeast: false,
        note: null,
      },
    ];
  }
  // A floored Granted (a plan or workspace not read, a partial Heartbeat)
  // floors both machine counts: they leave out the same machines.
  const atLeast = view.grantedIsFloor;
  const { machines, grantedMB } = a.servers.granted;
  return [
    {
      basis: "reporting-here",
      count: machines.reportingHere,
      mbPerUnit: SERVERS_MB_PER_MACHINE_PER_DAY,
      mb: grantedMB.reportingHere,
      atLeast,
      note: null,
    },
    {
      basis: "in-subscription",
      count: machines.inSubscription,
      mbPerUnit: SERVERS_MB_PER_MACHINE_PER_DAY,
      mb: grantedMB.inSubscription,
      atLeast,
      note: null,
    },
  ];
}

/** A count that may be a daily average: up to two decimals, never rounded to 0. */
export function countText(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * `2,400 x 5 MB = 12.00 GB/day` - literal, so the operator can redo it. A
 * floored count reads "at least" on both sides; a caveat follows in brackets.
 */
export function arithmeticLine(f: BasisFigure, tenant = false): string {
  const label = basisLabel(f.basis, tenant);
  if (f.count === null || f.mb === null) return `${label}: not known`;
  const atLeast = f.atLeast ? "at least " : "";
  const note = f.note === null ? "" : ` (${f.note})`;
  return `${label}: ${atLeast}${countText(f.count)} x ${f.mbPerUnit} MB = ${atLeast}${mbPerDay(f.mb)}${note}`;
}

/**
 * When the cross-check matched the basis Granted does NOT use (Granted is
 * always the assigned / reporting-here figure), say so and give that figure.
 */
export function otherBasisNote(view: GrantView, a: DataAllowances): string | null {
  const c = view.crossCheck;
  if (c.kind !== "matched") return null;
  const primary = view.grant === "e5" ? "assigned" : "reporting-here";
  if (c.basis === primary) return null;
  const tenant = a.scope.kind === "tenant";
  const figure = basisFigures(view, a).find((f) => f.basis === c.basis);
  const mb = figure?.mb ?? null;
  return (
    `Microsoft's applied figure matched the ${basisLabel(c.basis, tenant)} basis` +
    `${mb === null ? "" : ` (${mbPerDay(mb)})`}, not the ${basisLabel(primary, tenant)} figure shown as Granted.`
  );
}

/** Is a Graph refusal a permission refusal (so naming the permission is right)? */
export function isPermissionRefusal(detail: string): boolean {
  return /HTTP 40[13]\b|LicenseAssignment\.Read\.All|Authorization_RequestDenied|insufficient privileges|forbidden/i.test(
    detail,
  );
}

/** What the E5 card says about a licence read that did not succeed; null when read. */
export function licenceNote(a: DataAllowances): string | null {
  const l = a.licences;
  if (l.kind === "read") return null;
  if (l.kind === "not-bound") return "Licence counts are not available in this shell.";
  if (isPermissionRefusal(l.detail)) {
    return (
      "Licence counts were not read: the app registration needs the Microsoft Graph " +
      "application permission LicenseAssignment.Read.All (admin consent). It reads licence " +
      "SKUs and seat counts only, not who holds them - add it from Setup's app permissions " +
      `change request. (${l.detail})`
    );
  }
  return `Licence counts could not be read: ${l.detail}`;
}

/** A table plan note for an eligible table; null says nothing. */
export function planNote(plan: string | null): string | null {
  if (plan === null || plan === "Analytics") return null;
  return `${plan} plan - grant may not apply on this plan`;
}

export function criblWritableNote(w: "yes" | "no" | "unknown"): string | null {
  if (w === "no") return "Cribl cannot write this table (Microsoft connector only)";
  if (w === "yes") return "Cribl can write this table";
  return null;
}

/** Defender plan for a subscription row: "not read" is never "off". */
export function planLabel(plan: "P2" | "P1" | "off" | "not-read"): string {
  return plan === "not-read" ? "not read" : plan;
}

/**
 * How many Sentinel workspaces share the tenant-wide grants. Null when
 * discovery has not run, or when the count could be higher than one but
 * discovery could not see it (a failed subscription or an unknown state).
 */
export function sentinelWorkspaceCount(discovery: WorkspaceDiscovery | null): number | null {
  if (discovery === null) return null;
  const rows = listingRows(discovery.workspaces);
  const enabled = rows.filter((w) => w.sentinel === "enabled").length;
  const incomplete = discovery.failures.length > 0 || rows.some((w) => w.sentinel === "unknown");
  if (incomplete && enabled <= 1) return null;
  return enabled;
}

/**
 * True when sentinelWorkspaceCount is a lower bound: discovery was incomplete
 * but still saw more than one Sentinel workspace.
 */
export function sentinelWorkspaceCountIsFloor(discovery: WorkspaceDiscovery | null): boolean {
  if (discovery === null) return false;
  const rows = listingRows(discovery.workspaces);
  const incomplete = discovery.failures.length > 0 || rows.some((w) => w.sentinel === "unknown");
  return incomplete && sentinelWorkspaceCount(discovery) !== null;
}

/** MIG-16: the Sentinel-enabled workspaces a tenant comparison covers, in discovery order. */
export function sentinelWorkspaceIds(discovery: WorkspaceDiscovery | null): string[] {
  if (discovery === null) return [];
  return listingRows(discovery.workspaces)
    .filter((w) => w.sentinel === "enabled")
    .map((w) => w.id);
}

/**
 * MIG-16: what discovery could not see, so a tenant comparison is not read as
 * covering the whole tenant. Null when every subscription was listed and every
 * workspace's Sentinel state is known.
 */
export function tenantDiscoveryNote(discovery: WorkspaceDiscovery): string | null {
  const unknown = listingRows(discovery.workspaces).filter((w) => w.sentinel === "unknown").length;
  const parts: string[] = [];
  if (discovery.failures.length > 0) parts.push(`${discovery.failures.length} subscription(s) not listed`);
  if (unknown > 0) parts.push(`${unknown} workspace(s) with Sentinel state unknown`);
  if (parts.length === 0) return null;
  return (
    `Discovery was incomplete - ${parts.join(", ")} - so Sentinel workspaces it could not ` +
    "see are not in this comparison."
  );
}

/**
 * The "daily billable after allowances" tile value: billable minus used. A
 * floored Used makes it an upper bound ("at most"); with floored sums as well
 * the direction is unknown, so no figure is claimed.
 */
export function afterAllowancesText(a: DataAllowances): string {
  if (a.usedIsFloor) {
    return a.sumsAreFloors ? "not known (partial read)" : `at most ${formatMB(a.afterAllowancesDailyMB)}`;
  }
  return `${a.sumsAreFloors ? "at least " : ""}${formatMB(a.afterAllowancesDailyMB)}`;
}

/**
 * What the cards say when no grant has a view. Claims "none" only about what
 * was read: an unread eligible volume, an unread workspace or a partial
 * benefit read each narrows the sentence, never widens it to a zero.
 */
export function noGrantsText(a: DataAllowances): string {
  const tenant = a.scope.kind === "tenant" ? a.scope : null;
  if (tenant !== null && tenant.notRead.length >= tenant.workspaces.length) {
    return (
      "No workspace was read, so whether any data allowance benefit was applied, or any table a " +
      "grant covers has billable volume, is not known."
    );
  }
  const readCount = tenant === null ? 0 : tenant.workspaces.length - tenant.notRead.length;
  const where =
    tenant === null
      ? "this workspace"
      : tenant.notRead.length > 0
        ? `the ${readCount} workspace(s) that were read`
        : "these workspaces";
  const record = a.usedIsFloor ? "Microsoft's Operation record, read only in part," : "Microsoft's Operation record";
  const benefit = `${record} shows no data allowance benefit applied to ${where} in the last 30 complete days`;
  if (!a.eligibleKnown) {
    return (
      `${benefit}. Eligible volume was not read, so whether any table a grant covers has billable ` +
      "volume is not known."
    );
  }
  const unread =
    tenant !== null && tenant.notRead.length > 0
      ? ` The ${tenant.notRead.length} workspace(s) not read are not covered by this.`
      : "";
  return `${benefit}, and no table a grant covers has billable volume in that window.${unread}`;
}

/**
 * The CSV's grant-level allowance cells for one table: Allowance, Eligible,
 * Used, Over and AllowanceFigures, which says whether the figures are exact or
 * lower bounds. Empty strings for unknown - never a 0 for a figure not known.
 */
export function allowanceCsvCells(
  table: string,
  a: DataAllowances | null,
): [string, string, string, string, string] {
  const tag = allowanceFor(table);
  const label = tagLabel(tag);
  if (a === null || tag.kind !== "grant") return [label, "", "", "", ""];
  const view = a.grants.find((g) => g.grant === tag.grant);
  if (view === undefined) return [label, "", "", "", ""];
  const flags: string[] = [];
  if (!view.eligibleKnown) flags.push("eligible not read - eligible and over are not known");
  if (a.attribution === "pooled") flags.push("benefit known only in total - used and over are not split by grant");
  if (a.sumsAreFloors) flags.push("lower bound");
  if (a.usedIsFloor) flags.push("partial benefit read - used is a lower bound and over is not known");
  const status = flags.length > 0 ? flags.join("; ") : "exact";
  const eligible = view.eligibleKnown ? view.usage.eligibleDailyMB.toFixed(3) : "";
  // Pooled: the benefit is known in total only, so per-grant used and over are not.
  if (a.attribution === "pooled") return [label, eligible, "", "", status];
  // Over is not a figure when eligible is unread, Used is a floor, or a floored
  // sum shows no overage (the card says "not known (partial read)", never 0).
  const overKnown =
    view.eligibleKnown && !a.usedIsFloor && !(a.sumsAreFloors && view.usage.overDailyMB <= 0);
  const over = overKnown ? view.usage.overDailyMB.toFixed(3) : "";
  return [label, eligible, view.usage.usedDailyMB.toFixed(3), over, status];
}

// ---------------------------------------------------------------------------
// Window totals: the licence counts and the 30-day figures (core window-totals.ts)
// ---------------------------------------------------------------------------

const floorText = (isFloor: boolean): string => (isFloor ? "at least " : "");

/** The licence count a grant rests on, for its card face and the summary strip. */
export function licenceCountText(view: GrantView, a: DataAllowances): string {
  const l = view.window.licences;
  if (l.kind === "seats") {
    return (
      `${floorText(l.isFloor)}${l.assigned.toLocaleString("en-US")} E5 seats assigned ` +
      `(${l.purchased.toLocaleString("en-US")} purchased)`
    );
  }
  if (l.kind === "machines") {
    return `${floorText(l.isFloor)}${countText(l.dailyAverage)} Defender for Servers P2 machines a day on average`;
  }
  return view.grant === "e5"
    ? "E5 seats not read"
    : `Defender for Servers P2 machines not known - ${grantedUnknownReason(view, a)}`;
}

/** Why a grant's window allowance is not known - never a zero. */
function windowAllowanceUnknown(view: GrantView, a: DataAllowances): string {
  return view.grant === "e5" ? "licence counts were not read" : grantedUnknownReason(view, a);
}

/** One grant's window allowance: a GB figure, "at least", or "not known" with the reason. */
export function grantWindowAllowanceText(view: GrantView, a: DataAllowances): string {
  const w = view.window;
  if (w.allowanceMB === null) return `not known - ${windowAllowanceUnknown(view, a)}`;
  return `${floorText(w.allowanceIsFloor)}${formatGB(w.allowanceMB)}`;
}

/**
 * The literal arithmetic behind a grant's window allowance, so the operator
 * can redo it: `100 seats x 5 MB x 30 days = 15.00 GB`. Null when not known.
 */
export function grantWindowArithmetic(w: GrantWindowTotals): string | null {
  if (w.allowanceMB === null || w.perDayMB === null) return null;
  const atLeast = floorText(w.allowanceIsFloor);
  const result = `${atLeast}${formatGB(w.allowanceMB)}`;
  if (w.licences.kind === "seats") {
    return `${w.licences.assigned.toLocaleString("en-US")} seats x ${E5_MB_PER_SEAT_PER_DAY} MB x ${w.multiplier} days = ${result}`;
  }
  if (w.licences.kind === "machines") {
    return (
      `${countText(w.licences.dailyAverage)} machines a day on average x ` +
      `${SERVERS_MB_PER_MACHINE_PER_DAY} MB x ${w.multiplier} days = ${result}`
    );
  }
  return `${formatMB(w.perDayMB)}/day x ${w.multiplier} days = ${result}`;
}

/** The card face's window line: eligible, allowance and applied over the window. */
export function grantWindowLine(view: GrantView, a: DataAllowances): string {
  const w = view.window;
  const eligible = w.eligibleMB === null ? "not read" : `${floorText(w.eligibleIsFloor)}${formatGB(w.eligibleMB)}`;
  const applied =
    w.appliedMB === null ? "known only for all grants together" : `${floorText(w.appliedIsFloor)}${formatGB(w.appliedMB)}`;
  return (
    `last ${a.window.days.windowDays} days: eligible ${eligible}, allowance ` +
    `${grantWindowAllowanceText(view, a)}, Microsoft applied ${applied}`
  );
}

export interface WindowStripText {
  heading: string;
  billable: string;
  allowance: string;
  applied: string;
  net: string;
  /** The licence counts the allowance rests on, one per grant shown; empty when no grant applies. */
  licences: string[];
  /** Said when the allowance covers fewer days than the window; null otherwise. */
  daysNote: string | null;
}

function netText(net: WindowNet): string {
  if (net.kind === "not-known") return `not known - ${net.reason}`;
  if (net.kind === "even") return "level with the allowance";
  const atLeast = net.bound === "at-least" ? "at least " : "";
  return `${atLeast}${formatGB(net.mb)} ${net.kind} the allowance`;
}

/** The summary strip: billable against allowance over the window, the applied benefit and the net. */
export function windowStripText(a: DataAllowances): WindowStripText {
  const w = a.window;
  const tenant = a.scope.kind === "tenant" ? a.scope : null;
  const windowDays = w.days.windowDays;
  const heading =
    tenant === null
      ? `This workspace, last ${windowDays} complete days`
      : tenant.notRead.length > 0
        ? `Whole tenant, last ${windowDays} complete days - ${tenant.workspaces.length - tenant.notRead.length} of ${tenant.workspaces.length} Sentinel workspaces read`
        : `Whole tenant, last ${windowDays} complete days - ${tenant.workspaces.length} Sentinel workspaces`;

  let allowance: string;
  if (w.allowanceUnknown === null) {
    allowance = `${floorText(w.allowanceIsFloor)}${formatGB(w.allowanceMB ?? 0)}`;
  } else if (w.allowanceUnknown.grant === null) {
    allowance = a.eligibleKnown ? "none in use - no table a grant covers had billable volume" : "not known - eligible volume was not read";
  } else {
    const grant = w.allowanceUnknown.grant;
    const view = a.grants.find((g) => g.grant === grant);
    allowance = `not known - ${view === undefined ? "a grant's allowance could not be established" : `${GRANT_LABEL[grant]}: ${windowAllowanceUnknown(view, a)}`}`;
  }

  const e5Days = a.grants.some((g) => g.grant === "e5");
  const daysNote =
    w.days.days < windowDays && e5Days
      ? `Data on ${w.days.days} of the last ${windowDays} complete days (the busiest table's count): ` +
        `the E5 allowance counts those ${w.days.days} days, and reads "at least" because the workspace ` +
        "may have had data on more."
      : null;

  return {
    heading,
    billable: `${floorText(w.billableIsFloor)}${formatGB(w.billableMB)}`,
    allowance,
    applied: `${floorText(w.appliedIsFloor)}${formatGB(w.appliedMB)}`,
    net: netText(w.net),
    licences: a.grants.map((g) => licenceCountText(g, a)),
    daysNote,
  };
}

/** The Granted line's tip: the Servers P2 count is per workspace, or across a tenant comparison. */
export function grantedTip(view: GrantView, a: DataAllowances): string {
  if (view.grant === "e5") return ALLOWANCE_TIPS.grantedE5;
  return a.scope.kind === "tenant" ? ALLOWANCE_TIPS.grantedServersTenant : ALLOWANCE_TIPS.grantedServers;
}

/** The info-tip text for every new figure, beside the computation it describes. */
export const ALLOWANCE_TIPS = {
  afterAllowances:
    "The billable daily average minus the benefit Microsoft applied, from the workspace's " +
    "Operation table ('Benefit amount used'), summed over the same 30 days and divided by 30.",
  allowanceColumn:
    "Which Microsoft data grant covers the table, from a dated catalog of Microsoft's " +
    "documentation. A table not in the catalog is Billable, never a guess.",
  overColumn:
    "Billable volume a day that no grant covers. A grant's overage is pooled across all of " +
    "its tables, so a grant table reads 'share of' that overage - it is never split per " +
    "table. A billable table's cell is its whole billable daily average. A free table's is 0, " +
    "unless Usage still bills it: then it is that billed daily average, which no grant covers.",
  grantedE5:
    "Qualifying seats from Microsoft Graph subscribedSkus (assigned = consumedUnits) times " +
    "5 MB a day. Tenant-wide, and entitled only if bought through EA, EAS or CSP, which " +
    "Graph cannot show - the cross-check against Microsoft's applied figure is the proof.",
  grantedServers:
    "Machines that sent Heartbeat to this workspace, counted per day and averaged over the " +
    "30 days, from subscriptions on Defender for Servers Plan 2, times 500 MB a day.",
  grantedServersTenant:
    "Machines that sent Heartbeat to any workspace read, counted once a day even when one " +
    "machine reports to several, averaged over the 30 days, from subscriptions on Defender " +
    "for Servers Plan 2, times 500 MB a day.",
  eligibleUsed:
    "Eligible: billable MB from Usage for this grant's tables, summed over the window and " +
    "divided by 30. Used: the benefit Microsoft applied, from the Operation table, same window.",
  pooledOver:
    "Each day, the eligible volume of every grant together minus the whole benefit Microsoft " +
    "applied, when positive, averaged over 30 days. One figure for all grants: the benefit " +
    "record could not be split by grant.",
  status:
    "Over: each day, eligible minus applied when positive, averaged over 30 days - the only " +
    "volume where Cribl reduction saves money. Headroom: granted minus eligible, shown only " +
    "when both are exact - and, for the tenant-wide E5 grant, only when this is the tenant's " +
    "only Sentinel workspace.",
  chart:
    "Each day with data in the window: billable eligible MB from Usage against the benefit " +
    "Microsoft applied from Operation. Where the lines part, the grant ran out that day.",
  licences:
    "Every licence SKU in the tenant, qualifying ones first. Purchased = prepaidUnits.enabled, " +
    "grace / suspended = prepaidUnits.warning and .suspended, assigned = consumedUnits.",
  servers:
    "One row per subscription seen in Heartbeat._SubscriptionId. Plan from Microsoft.Security " +
    "pricings (VirtualMachines); machines in the subscription from Resource Graph; machines " +
    "reporting here counted per day and averaged over the 30 days.",
  windowBillable:
    "Billable MB from the Usage table (IsBillable), summed over the last 30 complete UTC days: " +
    "the billable daily average times 30. In a tenant comparison, summed over the workspaces " +
    "read; 'at least' when one was not read or a Usage answer was partial.",
  windowAllowance:
    "Each grant's daily figure from licence counts times the days it covers, summed over the " +
    "grants shown: E5 = assigned qualifying seats x 5 MB x the complete days with data; " +
    "Defender for Servers P2 = machines on Plan 2 reporting each day x 500 MB, summed over the " +
    "days (the daily average x 30). Without seat counts the E5 allowance is not known - the " +
    "largest benefit applied on one day is never multiplied up.",
  windowApplied:
    "The benefit Microsoft actually applied, from the workspace's Operation table ('Benefit " +
    "amount used'), summed over the same days. This is what reduced the bill; the allowance is " +
    "what the licences could cover.",
  windowNet:
    "Billable over the window minus the allowance over the window. A grant covers only its " +
    "eligible tables, so being under the allowance does not mean nothing is billed: the bill " +
    "is billable minus what Microsoft applied. With a lower bound on one side only the " +
    "direction it cannot change is stated; otherwise the net is not known.",
  licenceCount:
    "E5: qualifying seats assigned (consumedUnits) and purchased (prepaidUnits.enabled) from " +
    "Microsoft Graph subscribedSkus; the allowance uses assigned. Servers P2: machines on " +
    "Defender for Servers Plan 2 subscriptions that sent Heartbeat, counted per day and " +
    "averaged over the 30 days.",
  grantWindow:
    "Over the last 30 complete days: eligible = this grant's billable MB from Usage, summed; " +
    "allowance = the daily grant from licence counts x the days it covers; applied = the " +
    "benefit Microsoft applied to this grant, from Operation, summed.",
  serversTenant:
    "One row per subscription seen in Heartbeat._SubscriptionId. Plan from Microsoft.Security " +
    "pricings (VirtualMachines); machines in the subscription from Resource Graph; machines " +
    "reporting to the workspaces read counted per day and averaged over the 30 days.",
} as const;
