/**
 * MappingCatalogScreen - the browsable VENDOR MAPPING CATALOG (user request
 * 2026-07-09; reshaped 2026-07-12): pick a vendor from a searchable dropdown
 * and see that vendor's MERGED suggested Sentinel mappings - exactly the set
 * the analysis would apply (hand-verified entries beating mined ones), with
 * the documentation behind each mapping: the vendor-doc citation on
 * hand-verified entries, the mined ECS path on generated ones, and the
 * pack-level documentation link.
 *
 * Read-only over the bundled @soc/core VENDOR_MAPPING_PACKS registry: no IO,
 * no ports - the catalog ships inside the app. All projection logic is the
 * pure catalog-state module.
 */

import { useMemo, useState } from "react";
import { VENDOR_MAPPING_PACKS } from "@soc/core";
import { SearchableSelect } from "../../components/searchable-select";
import {
  catalogTotals,
  entryDocLine,
  filterVendorEntries,
  mergedVendorCatalog,
} from "./catalog-state";

export function MappingCatalogScreen() {
  const catalog = useMemo(
    () => mergedVendorCatalog(VENDOR_MAPPING_PACKS),
    [],
  );
  const totals = useMemo(() => catalogTotals(catalog), [catalog]);
  const [vendor, setVendor] = useState("");
  const [fieldQuery, setFieldQuery] = useState("");

  const selected = catalog.find((view) => view.vendor === vendor) ?? null;
  const entries =
    selected !== null ? filterVendorEntries(selected, fieldQuery) : [];

  return (
    <div className="mapping-catalog discovery-result">
      <p className="panel-desc">
        The vendor-suggested Sentinel mappings this app applies automatically
        during the DCR Gap Analysis: {totals.mappings} documented mappings
        across {totals.vendors} vendors. Hand-verified entries cite the
        vendor&apos;s own documentation; generated entries are mined from the
        Elastic integration pipeline fixtures and carry their ECS path.
        Vendors not listed here still map through the alias and fuzzy ladder,
        and your own approved review edits always outrank everything in this
        catalog. The catalog grows per vendor as documentation is verified.
      </p>

      <label className="field mapping-catalog-vendor">
        <span className="field-label">Vendor</span>
        <SearchableSelect
          options={catalog.map((view) => ({
            value: view.vendor,
            label: view.vendor,
            hint: `${view.entries.length} mappings`,
          }))}
          value={vendor}
          onChange={(next) => {
            setVendor(next);
            setFieldQuery("");
          }}
          placeholder="Select a vendor to view its suggested mappings..."
          ariaLabel="Filter vendors"
        />
      </label>

      {selected === null ? (
        <p className="field-hint">
          Select a vendor above to see its documented mapping suggestions.
        </p>
      ) : (
        <div className="mapping-review-card">
          <div className="mapping-review-card-head">
            <span className="mapping-review-logtype">{selected.vendor}</span>
            <span className="field-hint">
              {entries.length === selected.entries.length
                ? `${selected.entries.length} mappings`
                : `${entries.length} of ${selected.entries.length} mappings`}
            </span>
          </div>
          {selected.provenances.map((line) => (
            <p className="field-hint" key={line}>
              Source: {line}
            </p>
          ))}
          {selected.docUrl !== undefined && (
            <p className="field-hint">
              <a
                href={selected.docUrl}
                target="_blank"
                rel="noreferrer"
                className="mapping-catalog-doclink"
              >
                Vendor documentation
              </a>
            </p>
          )}

          <div className="mapping-search">
            <input
              type="text"
              value={fieldQuery}
              onChange={(e) => setFieldQuery(e.target.value)}
              placeholder="Search fields, columns, or documentation..."
              aria-label="Search vendor mappings"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          {entries.length === 0 ? (
            <p className="field-hint">No mappings match the search.</p>
          ) : (
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
                  {entries.map((entry) => (
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
          )}
        </div>
      )}
    </div>
  );
}
