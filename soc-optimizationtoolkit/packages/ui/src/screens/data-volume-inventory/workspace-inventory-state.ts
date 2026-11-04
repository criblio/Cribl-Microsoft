/**
 * Pure presentation for the workspace inventory panel (MIG-3): volume
 * formatting, source labels, and the headlines that must not turn an unknown
 * into a zero (docs/inventory-standard.md).
 *
 * Pure: no IO, no React.
 */

import { listingRows, parseResourceId } from "@soc/core";
import type {
  DataAllowances,
  DiscoveredWorkspace,
  InventorySource,
  InventoryTable,
  WorkspaceDiscovery,
  WorkspaceInventory,
} from "@soc/core";
import type { SelectOption } from "../../components/searchable-select";
import { allowanceCsvCells } from "./allowance-state";
import { formatMB } from "./format-mb";

export { formatMB } from "./format-mb";

/** What the source cell says, and the full value or meaning for its InfoTip. */
export interface SourceLabel {
  text: string;
  tip: string;
  kind: string;
  /** The collector that carried a product's rows; '' for every other kind. */
  via: string;
}

export function sourceLabel(source: InventorySource): SourceLabel {
  switch (source.attribution) {
    case "resource": {
      // The one ARM id parser (core azure-resource-id), not a second copy.
      const parsed = parseResourceId(source.source);
      return {
        text: parsed.name || source.source,
        tip: source.source,
        kind: parsed.resourceType || "Azure resource",
        via: "",
      };
    }
    case "product":
      return {
        text: source.source,
        kind: "Product",
        via: source.collector,
        tip:
          source.collector === ""
            ? `${source.source}, named by the product field the rows carry`
            : `${source.source}, named by the product field the rows carry, ` +
              `received through ${source.collector}`,
      };
    case "computer":
      return { text: source.source, tip: source.source, kind: "Computer", via: "" };
    case "device":
      return { text: source.source, tip: source.source, kind: "CEF device", via: "" };
    case "other":
      return {
        text: `${source.sourceCount} other sources`,
        tip: "Every source past the largest 25 of this table, summed",
        kind: "Remainder",
        via: "",
      };
    default:
      return {
        text: "Unattributed",
        tip:
          "These rows carry no _ResourceId, Computer or DeviceVendor/DeviceProduct, " +
          "so nothing in the row says where it came from (typical of SaaS and AWS connectors)",
        kind: "None",
        via: "",
      };
  }
}

/**
 * MIG-8: one workspace as a filterable picker option. The filter matches the
 * label, the hint AND the value, so the ARM id as value makes the resource
 * group and subscription id searchable too, and the hint adds the
 * subscription name and Sentinel state.
 */
export function workspaceSelectOption(ws: DiscoveredWorkspace): SelectOption {
  const sentinel =
    ws.sentinel === "enabled"
      ? "Sentinel"
      : ws.sentinel === "unknown"
        ? "Sentinel unknown"
        : "Log Analytics only";
  return {
    value: ws.id,
    label: ws.name,
    hint: `${ws.subscriptionName || ws.subscriptionId} / ${ws.resourceGroup} - ${sentinel}`,
  };
}

/** The line under the discovery button. Never says "none" for an RBAC-filtered list. */
export function discoveryHeadline(discovery: WorkspaceDiscovery): string {
  const subs = `${discovery.subscriptionsSearched} subscription(s)`;
  const failed =
    discovery.failures.length > 0
      ? ` ${discovery.failures.length} subscription(s) could not be listed and are not included.`
      : "";
  if (discovery.workspaces.kind !== "rows") {
    return (
      `Found no workspace this identity can see across ${subs}. ARM answers a list it ` +
      "filtered by permission with an empty result, not an error, so this does not show " +
      `that none exist - only that none are visible to the connected identity.${failed}`
    );
  }
  const rows = discovery.workspaces.rows;
  const sentinel = rows.filter((w) => w.sentinel === "enabled").length;
  return `Found ${rows.length} workspace(s) across ${subs}, ${sentinel} with Sentinel enabled.${failed}`;
}

/** The inventory's headline; `null` when the table renders the answer itself. */
export function inventoryEmptyText(inventory: WorkspaceInventory): string | null {
  if (inventory.tables.kind === "none") {
    return (
      `The Usage table answered and reports no ingested data in the last ` +
      `${inventory.windowDays} complete days.`
    );
  }
  if (inventory.tables.kind === "empty") {
    return (
      "The Usage query returned no usable rows, but the answer was incomplete or " +
      "unreadable, so this is not a measured zero."
    );
  }
  return null;
}

/** A workspace's name from its ARM id (the last path segment). */
export function workspaceNameOf(id: string): string {
  return parseResourceId(id).name || id;
}

/**
 * MIG-7: the shown inventory survives a selection change, so the page does not
 * collapse under the pointer - which makes it ESSENTIAL to say when what is
 * shown is not what is selected. Null when they agree.
 */
export function staleInventoryNote(inventoryId: string, selectedId: string): string | null {
  if (inventoryId === selectedId) return null;
  return (
    `Showing the inventory of ${workspaceNameOf(inventoryId)}, not the selected ` +
    `workspace. Press Inventory this workspace to read ${workspaceNameOf(selectedId)}.`
  );
}

/** How many tables' source breakdowns did not come back whole. */
export function sourceGaps(inventory: WorkspaceInventory): { failed: number; partial: number } {
  const rows = listingRows(inventory.tables);
  return {
    failed: rows.filter((t) => t.sources.kind === "failed").length,
    partial: rows.filter((t) => t.sources.kind === "partial").length,
  };
}

/** Number of distinct sources a table's breakdown names (the `other` row counts its members). */
export function sourceCount(table: InventoryTable): number | null {
  if (table.sources.kind === "failed") return null;
  return table.sources.sources.reduce((sum, s) => sum + s.sourceCount, 0);
}

const plainMB = (mb: number): string => String(Number(mb.toFixed(1)));

/**
 * One source's drill-down line: "Cisco ASA via localhost - 45.2 MB/day (billed
 * 45.2, free 0), 1,200 events". Non-product kinds keep their kind in brackets.
 */
export function sourceLineText(source: InventorySource): string {
  const label = sourceLabel(source);
  const who =
    source.attribution === "product"
      ? `${label.text}${label.via === "" ? "" : ` via ${label.via}`}`
      : `${label.text} (${label.kind})`;
  return (
    `${who} - ${formatMB(source.dailyAverageMB)}/day ` +
    `(billed ${plainMB(source.billableDailyMB)}, free ${plainMB(source.freeDailyMB)}), ` +
    `${source.events.toLocaleString()} events`
  );
}

/** Why a source's billed figure is shown with a flag; the InfoTip on the note. */
export const BILLED_EXCEEDS_TIP =
  "The rows report more billable bytes than total bytes, which cannot happen " +
  "(billable is a subset of total). Free is shown as 0; treat this source's " +
  "billed and free split as unreliable.";

/**
 * The line under a table's sources: what its named sources add up to against
 * what Usage reports for the table. Null for a failed breakdown, which the
 * caller already states.
 */
export function tableReconciliation(table: InventoryTable): string | null {
  if (table.sources.kind === "failed") return null;
  const total = table.sources.sources.reduce((sum, s) => sum + s.dailyAverageMB, 0);
  const figures = `${formatMB(total)} of the ${formatMB(table.dailyAverageMB)}/day Usage reports for this table`;
  if (table.sources.kind === "partial") {
    return (
      `This breakdown is partial (${table.sources.warning}), so the sources shown ` +
      `(measured from the rows) total ${figures}.`
    );
  }
  return `Sources (measured from the rows) total ${figures}.`;
}

/**
 * A CSV of the inventory, one row per table source, for the migration ticket.
 * The allowance columns repeat the grant-level figures per row; with no
 * allowance result (or an unknown figure) those cells are empty, never 0.
 * AllowanceFigures says whether they are exact or lower bounds.
 */
export function inventoryCsv(inventory: WorkspaceInventory, allowances: DataAllowances | null): string {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    [
      "Table", "TableDailyAvgMB", "TableBillableMB", "DaysWithData", "Solutions",
      "Source", "SourceKind", "SourceDailyAvgMB", "SourceEvents", "SourceStatus",
      "Allowance", "AllowanceEligibleDailyMB", "AllowanceUsedDailyMB", "AllowanceOverDailyMB",
      "AllowanceFigures", "SourceIdentity", "Collector", "BillableDailyMB", "FreeDailyMB",
    ].join(","),
  ];
  for (const t of listingRows(inventory.tables)) {
    const head = [
      t.table, t.dailyAverageMB.toFixed(3), t.billableMB.toFixed(3), t.daysWithData,
      t.solutions.join(" "),
    ];
    const allowance = allowanceCsvCells(t.table, allowances);
    if (t.sources.kind === "failed") {
      lines.push([...head, "", "", "", "", `failed: ${t.sources.error}`, ...allowance, "", "", "", ""].map(esc).join(","));
      continue;
    }
    const status = t.sources.kind === "partial" ? `partial: ${t.sources.warning}` : "read";
    for (const s of t.sources.sources) {
      const label = sourceLabel(s);
      lines.push(
        [...head, s.source || label.text, label.kind, s.dailyAverageMB.toFixed(3), s.events, status, ...allowance,
          s.source, s.collector, s.billableDailyMB.toFixed(3), s.freeDailyMB.toFixed(3)]
          .map(esc)
          .join(","),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
