/**
 * MatchPreview - the minimal match-preview VIEW (porting-plan Unit 13 UI,
 * ENG-04/05/03). Takes ONE tagged sample and a resolved destination table
 * name, runs the @soc/core field matcher through the SchemaCatalog port, and
 * renders the resulting MatchResult as:
 *
 *   - stat cards (Source Fields / Dest Columns / Passthrough / Overflow /
 *     Unmatched - the legacy gap-analysis vocabulary, kept minimal);
 *   - the surfaced warnings (honestly, only WHEN the core reports them - the
 *     AdditionalData_d-missing overflow-loss case is the load-bearing one);
 *   - an expandable per-field list (source field -> destination column, or
 *     overflow, or dropped).
 *
 * This is the SEED of the Unit 18 gap-analysis review screen, not the full
 * thing: no editable mappings, no approval gate, no rule badges - a read-only
 * preview surface.
 *
 * The schema resolution flows through the SchemaCatalog port (async), served
 * by default by the fetch-free bundled adapter over the pre-extracted
 * dcr-template-schemas asset. Passing a different catalog (e.g. a future
 * GitHub-CustomTables fallback) changes the source with no change here. All
 * projection is the pure match-preview-state helpers; this component only
 * resolves + renders (zero decision logic, zero direct IO beyond the port).
 */

import { useEffect, useMemo, useState } from "react";
import {
  createBundledSchemaCatalog,
  matchSampleToTable,
} from "@soc/core";
import type { SchemaCatalog, TaggedSample } from "@soc/core";
import {
  deriveMatchPreview,
  matchPreviewEmptyReason,
} from "./match-preview-state";
import type { MatchPreviewView } from "./match-preview-state";

export interface MatchPreviewProps {
  /** The tagged sample whose fields are matched, or null (empty state). */
  sample: TaggedSample | null;
  /** The destination table name to match against (blank = empty state). */
  tableName: string;
  /**
   * The schema catalog resolving the table to columns. Defaults to the
   * fetch-free bundled adapter; pass another to change the resolution source.
   */
  catalog?: SchemaCatalog;
}

/** The match-preview view, or an always-visible-disabled empty state. */
export function MatchPreview({ sample, tableName, catalog }: MatchPreviewProps) {
  // Memoize the default catalog so the resolve effect does not re-run every
  // render (a fresh adapter identity would loop forever).
  const activeCatalog = useMemo(
    () => catalog ?? createBundledSchemaCatalog(),
    [catalog],
  );

  const [view, setView] = useState<MatchPreviewView | null>(null);
  const [pending, setPending] = useState(false);

  const trimmedTable = tableName.trim();
  const emptyReason = matchPreviewEmptyReason({
    hasSample: sample !== null,
    tableName,
  });

  useEffect(() => {
    // No sample or no table: clear any prior view; the empty state renders.
    if (sample === null || trimmedTable === "") {
      setView(null);
      setPending(false);
      return;
    }
    let cancelled = false;
    setPending(true);
    void matchSampleToTable(sample.parsed, activeCatalog, trimmedTable)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setView(deriveMatchPreview(result));
        setPending(false);
      })
      .catch(() => {
        // The bundled adapter never rejects on a miss (null -> all-unmatched);
        // a genuine backend failure clears the view rather than crashing.
        if (cancelled) {
          return;
        }
        setView(null);
        setPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sample, trimmedTable, activeCatalog]);

  if (emptyReason !== null) {
    return (
      <div className="match-preview match-preview-empty">
        <span className="field-label">Field match preview</span>
        <p className="field-hint">{emptyReason}</p>
      </div>
    );
  }

  return (
    <div className="match-preview">
      <div className="match-preview-head">
        <span className="field-label">
          Field match preview{" "}
          <span className="match-preview-target">
            {sample?.logType} vs {trimmedTable}
          </span>
        </span>
        {view !== null && (
          <span className="match-rate" title="Fraction of source fields matched or overflowed">
            {view.matchRatePercent}% covered
          </span>
        )}
      </div>
      <p className="panel-desc">
        A read-only preview of how this sample&apos;s fields map to the
        destination table, from the same @soc/core field matcher the Unit 18
        gap analysis will use. Nothing here is deployed.
      </p>

      {view === null ? (
        <p className="field-hint">
          {pending
            ? "Resolving the destination schema and matching fields..."
            : "No preview available for this selection."}
        </p>
      ) : (
        <>
          <div className="match-stat-grid">
            {view.stats.map((stat) => (
              <div
                key={stat.key}
                className={`match-stat match-stat-${stat.tone}`}
                title={stat.hint}
              >
                <span className="match-stat-value">{stat.value}</span>
                <span className="match-stat-label">{stat.label}</span>
              </div>
            ))}
          </div>

          {view.warnings.map((warning) => (
            <p
              key={warning.key}
              className={`match-warning match-warning-${warning.kind}`}
            >
              {warning.text}
            </p>
          ))}

          <p className="field-hint">
            {view.overflowEnabled
              ? `Unmatched fields are collected into ${view.overflowFieldName} (no data lost).`
              : `This table has no active catch-all column, so unmatched fields are dropped.`}
          </p>

          <details className="match-field-list">
            <summary className="field-hint">
              Field mapping ({view.rows.length} field
              {view.rows.length === 1 ? "" : "s"})
            </summary>
            <div className="match-field-table-wrap">
              <table className="match-field-table">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Destination</th>
                    <th>Kind</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {view.rows.map((row) => (
                    <tr key={row.key} className={`match-row match-row-${row.kind}`}>
                      <td>
                        <span className="match-field-name">{row.sourceName}</span>
                        <span className="match-field-type">{row.sourceType}</span>
                      </td>
                      <td>
                        {row.destName === null ? (
                          <span className="match-field-type">(dropped)</span>
                        ) : (
                          <>
                            <span className="match-field-name">
                              {row.destName}
                            </span>
                            {row.destType !== null && (
                              <span className="match-field-type">
                                {row.destType}
                              </span>
                            )}
                          </>
                        )}
                      </td>
                      <td>
                        <span className={`match-kind match-kind-${row.kind}`}>
                          {row.kind}
                        </span>
                        {row.confidence !== "unmatched" && (
                          <span className="match-conf">{row.confidence}</span>
                        )}
                      </td>
                      <td className="match-detail">
                        {row.needsCoercion && (
                          <span className="match-coerce">
                            coerce {row.sourceType} to {row.destType}
                          </span>
                        )}
                        <span className="field-hint">{row.description}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
