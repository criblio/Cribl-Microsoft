/**
 * MappingCatalogScreen - the browsable VENDOR MAPPING CATALOG (user request
 * 2026-07-09): every documented source-field -> Sentinel-column suggestion
 * the analysis applies automatically, with its provenance visible - the
 * vendor-doc citation on hand-verified entries, the mined ECS path on
 * generated ones, and the pack-level documentation link.
 *
 * Read-only over the bundled @soc/core VENDOR_MAPPING_PACKS registry: no IO,
 * no ports - the catalog ships inside the app. All projection logic is the
 * pure catalog-state module.
 */

import { useMemo, useState } from "react";
import { VENDOR_MAPPING_PACKS } from "@soc/core";
import {
  catalogTotals,
  entryDocLine,
  filterCatalog,
} from "./catalog-state";

export function MappingCatalogScreen() {
  const [query, setQuery] = useState("");
  const totals = useMemo(() => catalogTotals(VENDOR_MAPPING_PACKS), []);
  const packs = useMemo(
    () => filterCatalog(VENDOR_MAPPING_PACKS, query),
    [query],
  );

  return (
    <div className="mapping-catalog discovery-result">
      <p className="panel-desc">
        The vendor-suggested Sentinel mappings this app applies automatically
        during the DCR Gap Analysis: {totals.mappings} documented mappings
        across {totals.packs} vendor packs. Hand-verified entries cite the
        vendor&apos;s own documentation; generated entries are mined from the
        Elastic integration pipeline fixtures and carry their ECS path. Your
        own approved review edits always outrank these.
      </p>

      <label className="field mapping-catalog-search">
        <span className="field-label">Search the catalog</span>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Field, column, or vendor (e.g. b64url, SourceIP, Zscaler)"
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      {packs.length === 0 && (
        <p className="field-hint">No catalog entries match the search.</p>
      )}

      {packs.map((pack) => (
        <div className="mapping-review-card" key={pack.id}>
          <div className="mapping-review-card-head">
            <span className="mapping-review-logtype">{pack.vendor}</span>
            <span className="field-hint">
              {pack.entries.length === pack.totalEntries
                ? `${pack.totalEntries} mappings`
                : `${pack.entries.length} of ${pack.totalEntries} mappings`}
            </span>
          </div>
          <p className="field-hint">
            Source: {pack.provenance}
            {pack.docUrl !== undefined && (
              <>
                {" - "}
                <a
                  href={pack.docUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mapping-catalog-doclink"
                >
                  vendor documentation
                </a>
              </>
            )}
          </p>
          <div className="mapping-review-table-wrap">
            <table className="match-field-table mapping-review-grid">
              <thead>
                <tr>
                  <th>Vendor Field</th>
                  <th>Sentinel Column</th>
                  <th>Action</th>
                  <th>Documentation</th>
                </tr>
              </thead>
              <tbody>
                {pack.entries.map((entry) => (
                  <tr
                    className="mapping-row"
                    key={`${entry.sourceName}|${entry.destName}`}
                  >
                    <td>
                      <code className="code-chip">{entry.sourceName}</code>
                    </td>
                    <td>{entry.destName}</td>
                    <td className="match-field-type">
                      {entry.action === "decode" ? "base64 decode" : "map"}
                    </td>
                    <td className="mapping-catalog-doc">
                      {entryDocLine(entry)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
