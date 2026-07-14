/**
 * Mapping-catalog PURE state: the projections behind the Vendor Mapping
 * Catalog screen (user request 2026-07-09; reshaped 2026-07-12 to a
 * vendor-picker view). The truth is the @soc/core VENDOR_MAPPING_PACKS
 * registry - hand-verified packs annotated from vendor documentation plus
 * generated packs mined from the Elastic pipeline fixtures.
 *
 * MERGED PER VENDOR: several packs can serve one vendor (the hand-verified
 * Zscaler pack plus the generated one). The catalog shows what the analysis
 * would actually APPLY - entries deduplicated by source name in declaration
 * order (hand packs first), exactly the runtime rule - so one vendor renders
 * as ONE view, never as redundant cards.
 *
 * Pure: no IO, no fetch, no React.
 */

import { foldEntriesBySource } from "@soc/core";
import type { VendorMappingPack, VendorPackEntry } from "@soc/core";

/** One vendor's merged catalog view. */
export interface VendorCatalogView {
  vendor: string;
  /** Every contributing pack's provenance line, declaration order. */
  provenances: string[];
  /** The first documentation link any contributing pack carries. */
  docUrl?: string;
  /** Entries the analysis would apply: deduped by source, hand packs first. */
  entries: VendorPackEntry[];
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
 * Merge the packs into one view per vendor, applying the runtime dedupe
 * (first-declared entry wins per source name, and hand packs are declared
 * before generated ones in the registry).
 */
export function mergedVendorCatalog(
  packs: readonly VendorMappingPack[],
): VendorCatalogView[] {
  const byVendor = new Map<string, VendorCatalogView>();
  for (const pack of packs) {
    let view = byVendor.get(pack.vendor);
    if (view === undefined) {
      view = { vendor: pack.vendor, provenances: [], entries: [] };
      byVendor.set(pack.vendor, view);
    }
    view.provenances.push(pack.provenance);
    if (view.docUrl === undefined && pack.docUrl !== undefined) {
      view.docUrl = pack.docUrl;
    }
    // THE runtime dedupe rule, shared with vendorMappingsForSolution.
    foldEntriesBySource(view.entries, pack.mappings);
  }
  return [...byVendor.values()].sort((a, b) =>
    a.vendor.localeCompare(b.vendor),
  );
}

/** Filter one vendor's entries by source, destination, or documentation. */
export function filterVendorEntries(
  view: VendorCatalogView,
  query: string,
): VendorPackEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...view.entries];
  return view.entries.filter(
    (entry) =>
      entry.sourceName.toLowerCase().includes(q) ||
      entry.destName.toLowerCase().includes(q) ||
      entryDocLine(entry).toLowerCase().includes(q),
  );
}

/** Totals across the whole catalog (the header line). */
export function catalogTotals(views: readonly VendorCatalogView[]): {
  vendors: number;
  mappings: number;
} {
  return {
    vendors: views.length,
    mappings: views.reduce((sum, view) => sum + view.entries.length, 0),
  };
}
