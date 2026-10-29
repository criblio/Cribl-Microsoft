/**
 * Pure presentation for the workspace inventory panel (MIG-3): volume
 * formatting, source labels, and the headlines that must not turn an unknown
 * into a zero (docs/inventory-standard.md).
 *
 * Pure: no IO, no React.
 */

import { listingRows } from "@soc/core";
import type {
  DiscoveredWorkspace,
  InventorySource,
  InventoryTable,
  WorkspaceDiscovery,
  WorkspaceInventory,
} from "@soc/core";

/** Decimal units, matching Usage's MB (10^6 bytes) and the Azure portal. */
export function formatMB(mb: number): string {
  if (mb >= 1_000_000) return `${(mb / 1_000_000).toFixed(2)} TB`;
  if (mb >= 1_000) return `${(mb / 1_000).toFixed(2)} GB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  if (mb > 0) return `${(mb * 1_000).toFixed(1)} KB`;
  return "0 MB";
}

/** What the source cell says, and the full value for its title. */
export interface SourceLabel {
  text: string;
  title: string;
  kind: string;
}

export function sourceLabel(source: InventorySource): SourceLabel {
  switch (source.attribution) {
    case "resource": {
      const segments = source.source.split("/").filter((s) => s !== "");
      const name = segments[segments.length - 1] ?? source.source;
      const type = segments.length >= 3 ? segments[segments.length - 2] : "";
      return { text: name, title: source.source, kind: type || "Azure resource" };
    }
    case "computer":
      return { text: source.source, title: source.source, kind: "Computer" };
    case "device":
      return { text: source.source, title: source.source, kind: "CEF device" };
    case "other":
      return {
        text: `${source.sourceCount} other sources`,
        title: "Every source past the largest 25 of this table, summed",
        kind: "Remainder",
      };
    default:
      return {
        text: "Unattributed",
        title:
          "These rows carry no _ResourceId, Computer or DeviceVendor/DeviceProduct, " +
          "so nothing in the row says where it came from (typical of SaaS and AWS connectors)",
        kind: "None",
      };
  }
}

export function workspaceOptionLabel(ws: DiscoveredWorkspace): string {
  const sentinel =
    ws.sentinel === "enabled"
      ? "Sentinel"
      : ws.sentinel === "unknown"
        ? "Sentinel unknown"
        : "Log Analytics only";
  return `${ws.name} - ${ws.subscriptionName || ws.subscriptionId} / ${ws.resourceGroup} (${sentinel})`;
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

/** A CSV of the inventory, one row per table source, for the migration ticket. */
export function inventoryCsv(inventory: WorkspaceInventory): string {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    [
      "Table", "TableDailyAvgMB", "TableBillableMB", "DaysWithData", "Solutions",
      "Source", "SourceKind", "SourceDailyAvgMB", "SourceEvents", "SourceStatus",
    ].join(","),
  ];
  for (const t of listingRows(inventory.tables)) {
    const head = [
      t.table, t.dailyAverageMB.toFixed(3), t.billableMB.toFixed(3), t.daysWithData,
      t.solutions.join(" "),
    ];
    if (t.sources.kind === "failed") {
      lines.push([...head, "", "", "", "", `failed: ${t.sources.error}`].map(esc).join(","));
      continue;
    }
    const status = t.sources.kind === "partial" ? `partial: ${t.sources.warning}` : "read";
    for (const s of t.sources.sources) {
      const label = sourceLabel(s);
      lines.push(
        [...head, s.source || label.text, label.kind, s.dailyAverageMB.toFixed(3), s.events, status]
          .map(esc)
          .join(","),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
