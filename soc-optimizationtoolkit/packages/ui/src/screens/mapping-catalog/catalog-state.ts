/**
 * Mapping-catalog PURE state: the projections behind the Vendor Mapping
 * Catalog screen (user request 2026-07-09: a browsable, vendor-documented
 * catalog of suggested Sentinel mappings). The truth is the @soc/core
 * VENDOR_MAPPING_PACKS registry - hand-verified packs annotated from vendor
 * documentation plus generated packs mined from the Elastic pipeline
 * fixtures; this module only filters and counts for rendering.
 *
 * Pure: no IO, no fetch, no React.
 */

import type { VendorMappingPack, VendorPackEntry } from "@soc/core";

/** One pack ready to render: its identity plus the entries passing the filter. */
export interface CatalogPackView {
  id: string;
  vendor: string;
  provenance: string;
  docUrl?: string;
  /** Entries passing the filter, source-name order preserved. */
  entries: VendorPackEntry[];
  /** Total entries in the pack (shown as "N of M" while filtering). */
  totalEntries: number;
}

/** The provenance/documentation line for one entry (doc, else mined ECS). */
export function entryDocLine(entry: VendorPackEntry): string {
  if (entry.doc !== undefined && entry.doc !== "") return entry.doc;
  if (entry.ecs !== undefined && entry.ecs !== "") {
    return `Mined from Elastic pipeline fixtures (ECS: ${entry.ecs})`;
  }
  return "";
}

/**
 * Filter the catalog: a blank query keeps every pack and entry; otherwise an
 * entry survives when its source name, destination column, or documentation
 * line contains the query (case-insensitive), and a pack survives when its
 * VENDOR matches (all entries kept) or at least one entry survives.
 */
export function filterCatalog(
  packs: readonly VendorMappingPack[],
  query: string,
): CatalogPackView[] {
  const q = query.trim().toLowerCase();
  const out: CatalogPackView[] = [];
  for (const pack of packs) {
    const vendorHit = q !== "" && pack.vendor.toLowerCase().includes(q);
    const entries =
      q === "" || vendorHit
        ? [...pack.mappings]
        : pack.mappings.filter(
            (entry) =>
              entry.sourceName.toLowerCase().includes(q) ||
              entry.destName.toLowerCase().includes(q) ||
              entryDocLine(entry).toLowerCase().includes(q),
          );
    if (entries.length === 0) continue;
    const view: CatalogPackView = {
      id: pack.id,
      vendor: pack.vendor,
      provenance: pack.provenance,
      entries,
      totalEntries: pack.mappings.length,
    };
    if (pack.docUrl !== undefined) view.docUrl = pack.docUrl;
    out.push(view);
  }
  return out;
}

/** Totals across the whole catalog (the header line). */
export function catalogTotals(packs: readonly VendorMappingPack[]): {
  packs: number;
  mappings: number;
} {
  return {
    packs: packs.length,
    mappings: packs.reduce((sum, pack) => sum + pack.mappings.length, 0),
  };
}
