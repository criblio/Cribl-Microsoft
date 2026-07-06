/**
 * MatchPreviewSection - the Integrate-flow wrapper around {@link MatchPreview}
 * (porting-plan Unit 13 UI). It surfaces the minimal match preview from a
 * TAGGED SAMPLE once a DESTINATION TABLE is known: pick one of the tagged
 * samples, type/pick a destination table (bundled-catalog names as
 * suggestions), and the read-only preview renders below.
 *
 * This is a lightweight PREVIEW SEAM, not the Unit 18 gap-analysis screen and
 * not a numbered section of its own: it slots inside the already-built Sample
 * Data section, so it changes no section's built/coming-soon status and does
 * not touch canDeploy. When no table is chosen (or no sample is tagged) the
 * inner MatchPreview shows its always-visible-disabled empty state.
 *
 * The section owns only the two local selections; all schema resolution and
 * matching happen in MatchPreview through the SchemaCatalog port, and all
 * projection is the pure match-preview-state helpers.
 */

import { useMemo, useState } from "react";
import { bundledCatalogTableNames } from "@soc/core";
import type { SchemaCatalog, TaggedSample } from "@soc/core";
import { MatchPreview } from "./match-preview";

export interface MatchPreviewSectionProps {
  /** The tagged samples the Sample Data section has produced (may be empty). */
  samples: TaggedSample[];
  /**
   * The schema catalog to resolve against; defaults (in MatchPreview) to the
   * fetch-free bundled adapter. Threaded through for tests and future sources.
   */
  catalog?: SchemaCatalog;
  /**
   * Destination-table suggestions for the datalist. Defaults to the bundled
   * catalog's known table names (native DCR templates + custom _CL schemas).
   */
  suggestedTables?: string[];
}

const TABLE_LIST_ID = "match-preview-table-suggestions";

/** The Sample Data section's match-preview affordance. */
export function MatchPreviewSection({
  samples,
  catalog,
  suggestedTables,
}: MatchPreviewSectionProps) {
  const [selectedLogType, setSelectedLogType] = useState("");
  const [tableName, setTableName] = useState("");

  const tableOptions = useMemo(
    () => suggestedTables ?? bundledCatalogTableNames(),
    [suggestedTables],
  );

  // The effective selection: the chosen log type when it still exists,
  // otherwise the first tagged sample (no resetting effect needed).
  const effectiveLogType = samples.some((s) => s.logType === selectedLogType)
    ? selectedLogType
    : (samples[0]?.logType ?? "");
  const selectedSample =
    samples.find((s) => s.logType === effectiveLogType) ?? null;

  return (
    <div className="discovery-result match-preview-section">
      <span className="field-label">Match preview (Unit 13)</span>
      <p className="panel-desc">
        Preview how a tagged sample&apos;s fields line up with a Sentinel
        destination table before you build anything. This is the seed of the
        full gap analysis and mapping review (Unit 18).
      </p>

      {samples.length === 0 ? (
        <MatchPreview sample={null} tableName={tableName} catalog={catalog} />
      ) : (
        <>
          <div className="form-grid">
            <label className="field">
              <span className="field-label">Tagged sample</span>
              <select
                value={effectiveLogType}
                onChange={(e) => setSelectedLogType(e.target.value)}
              >
                {samples.map((sample) => (
                  <option key={sample.logType} value={sample.logType}>
                    {sample.logType} ({sample.format.toUpperCase()},{" "}
                    {sample.parsed.fields.length} field
                    {sample.parsed.fields.length === 1 ? "" : "s"})
                  </option>
                ))}
              </select>
              <span className="field-hint">
                The tagged sample whose discovered fields are matched.
              </span>
            </label>
            <label className="field">
              <span className="field-label">Destination table</span>
              <input
                type="text"
                value={tableName}
                onChange={(e) => setTableName(e.target.value)}
                list={TABLE_LIST_ID}
                placeholder="e.g. CommonSecurityLog, Syslog, CrowdStrike_Process_Events_CL"
                autoComplete="off"
                spellCheck={false}
              />
              <datalist id={TABLE_LIST_ID}>
                {tableOptions.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              <span className="field-hint">
                A Sentinel/DCR table. Suggestions come from the bundled schema
                catalog; a name outside it resolves to all-unmatched.
              </span>
            </label>
          </div>
          <MatchPreview
            sample={selectedSample}
            tableName={tableName}
            catalog={catalog}
          />
        </>
      )}
    </div>
  );
}
