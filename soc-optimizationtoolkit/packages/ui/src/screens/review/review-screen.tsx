/**
 * ReviewScreen - porting-plan Unit 7 (ENG-36, GUI-12) as the Integrate
 * arc's REVIEW stage (ux-flow-plan 5.2 amendment): preview EXACTLY what a
 * deploy run would create for a table selection, from LIVE ARM truth,
 * before anything is deployed.
 *
 * Truth comes entirely from the @soc/core buildDeploymentPreview usecase:
 * predicted names are dcr-naming's (the single source - preview name IS the
 * deployed name), existence answers are live ARM GETs issued for THIS
 * preview (never cached files), and the expandable request JSON is the same
 * builder output a deploy run would send. The legacy preview's simplified
 * name approximation, stale-cache existence, and fuzzy substring matching
 * do not exist here (DO-NOT-PORT defects, fixed in core and pinned there).
 *
 * The table selection is entered HERE with the same parsing and
 * vendor-schema picks as DCR Automation (buildBatchSelection - one parse
 * path); this unit does not lift the batch screen's selection state into a
 * shared store, and the screen says so honestly (REVIEW_SELECTION_NOTE).
 *
 * STALENESS (legacy manual-analysis pattern): the preview records an opaque
 * generated-at token minted by the SHELL (core never reads a clock) plus
 * the inputs token; changing the selection, options, or scope after
 * generation flips a visible stale marker and relabels the action
 * "Re-check". Nothing recomputes automatically - the user controls when
 * the live ARM work re-runs.
 *
 * ACKNOWLEDGE GATE (read-ahead decision, binding): the required 'I have
 * reviewed these changes' check arms ONLY the Deploy handoff button on this
 * screen (which navigates to DCR Automation). It is never a hard gate on
 * Deploy - the Run buttons elsewhere keep their own gates - and the
 * acknowledgement is TRANSIENT React state, never persisted as consent.
 * Disabled-button hints come from journey-state's unlock hint (passed by
 * the shell), naming the single missing thing - never per-screen prose.
 *
 * Pure React over the ports: ZERO direct fetch or storage access here, and
 * only GET requests are ever issued (the preview usecase is read-only by
 * construction).
 */

import { useMemo, useState } from "react";
import {
  DEFAULT_OPERATION_OPTIONS,
  VENDOR_SCHEMAS,
  buildDeploymentPreview,
  findVendorSchema,
} from "@soc/core";
import type { OperationOptions } from "@soc/core";
import { usePorts } from "../../ports-context";
import { SearchableSelect } from "../../components/searchable-select";
import { buildBatchSelection } from "../../onboarding/batch/batch-state";
import {
  REVIEW_SELECTION_NOTE,
  STALE_NOTICE,
  checkActionLabel,
  deriveDeployHandoff,
  deriveReviewRows,
  formatReviewSummary,
  isPreviewStale,
  previewOptionsOf,
  reviewCounts,
  reviewInputsToken,
} from "./review-state";
import type { GeneratedPreview, ReviewRow } from "./review-state";

export interface ReviewScreenProps {
  /**
   * Supplier of the OPAQUE generated-at token stamped on each preview (an
   * ISO timestamp in practice). The SHELL owns time - @soc/core and this
   * package never read a clock of their own.
   */
  generatedAtToken: () => string;
  /**
   * Persisted deployment options (porting-plan Unit 4). The preview honors
   * their createDCE / customTableRetentionDays / dcePublicNetworkAccess;
   * per-run overrides applied on DCR Automation are NOT visible here (stated
   * on screen). Absent, the @soc/core defaults apply.
   */
  operationDefaults?: OperationOptions;
  /**
   * The journey deploy stage's blockedReason from @soc/core deriveJourney
   * (null when Deploy is not blocked). The preview needs the same live-ARM
   * prerequisites (identity + committed scope), so this ONE journey-state
   * hint drives every disabled control here.
   */
  journeyBlockedReason?: string | null;
  /** Navigate to the Options screen (the frame owns navigation). */
  onOpenOptions?: () => void;
  /**
   * The armed Deploy handoff: navigate to the deploy surface (Batch
   * Onboard). The acknowledgement travels only as this transient call -
   * nothing is persisted.
   */
  onProceedToDeploy?: () => void;
  /** Display name of the deploy surface the handoff opens. */
  deploySurfaceLabel?: string;
}

/** One per-resource row: tag chip, name, verdict pill, notes, request JSON. */
function ReviewRowView({ row }: { row: ReviewRow }) {
  return (
    <div className="review-row">
      <div className="review-row-head">
        <span className={`review-tag review-tag-${row.tag.toLowerCase()}`}>
          {row.tag}
        </span>
        <span className="review-name">{row.name}</span>
        <span
          className={`readiness-chip ${
            row.verdict === "exists"
              ? "readiness-chip-ok"
              : "readiness-chip-unknown"
          }`}
        >
          {row.verdict === "exists" ? "Exists" : "Will create"}
        </span>
      </div>
      <p className="field-hint">{row.note}</p>
      {row.detailLines.length > 0 && (
        <pre className="result">{row.detailLines.join("\n")}</pre>
      )}
      {row.requestJson !== null && (
        <details className="review-request">
          <summary className="field-hint">
            Request JSON (what a deploy run would send)
          </summary>
          <pre className="result">{row.requestJson}</pre>
        </details>
      )}
    </div>
  );
}

/**
 * The REVIEW stage screen: table selection in, live-ARM preview rows with a
 * staleness marker out, and the acknowledge gate arming the Deploy handoff.
 */
export function ReviewScreen({
  generatedAtToken,
  operationDefaults,
  journeyBlockedReason = null,
  onOpenOptions,
  onProceedToDeploy,
  deploySurfaceLabel = "DCR Automation",
}: ReviewScreenProps) {
  const { ports, config } = usePorts();

  // ---- Table selection (same parse path as DCR Automation) ---------------
  const [listText, setListText] = useState("");
  const [vendorPick, setVendorPick] = useState("");
  const [vendorIds, setVendorIds] = useState<string[]>([]);
  const selection = useMemo(
    () => buildBatchSelection(listText, vendorIds),
    [listText, vendorIds],
  );
  const availableVendors = VENDOR_SCHEMAS.filter(
    (entry) => !vendorIds.includes(entry.id),
  );

  // ---- Inputs token: scope + preview options + ordered selection --------
  const persisted = operationDefaults ?? DEFAULT_OPERATION_OPTIONS;
  const previewOptions = useMemo(() => previewOptionsOf(persisted), [persisted]);
  const scope = {
    subscriptionId: config.subscriptionId,
    resourceGroup: config.resourceGroup,
    workspaceName: config.workspaceName,
  };
  const currentToken = reviewInputsToken(selection.specs, previewOptions, scope);

  // ---- Preview state -----------------------------------------------------
  const [generated, setGenerated] = useState<GeneratedPreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  // TRANSIENT acknowledgement - React state only, reset on every (re)check,
  // NEVER persisted (read-ahead decision: it arms only this screen's
  // handoff button and travels nowhere else).
  const [acknowledged, setAcknowledged] = useState(false);

  const stale = isPreviewStale(generated, currentToken);
  const rows = generated === null ? [] : deriveReviewRows(generated.preview);
  const handoff = deriveDeployHandoff({
    journeyBlockedReason,
    hasPreview: generated !== null,
    stale,
    acknowledged,
    checking,
  });

  const check = async () => {
    setChecking(true);
    setCheckError("");
    setAcknowledged(false);
    // Capture the token the preview is generated FROM, so staleness compares
    // against exactly these inputs even if state changes mid-flight.
    const inputsToken = currentToken;
    try {
      const preview = await buildDeploymentPreview(ports.azure, {
        scope,
        tables: selection.specs,
        options: previewOptions,
        generatedAtToken: generatedAtToken(),
      });
      setGenerated({ preview, inputsToken });
    } catch (err) {
      // A failed check keeps the previous preview visible (still marked by
      // its own token) and surfaces the raw greppable error - preview
      // honesty: a green preview must not hide a red deploy.
      setCheckError(String(err));
    } finally {
      setChecking(false);
    }
  };

  // The check button's single missing thing, in dependency order: journey
  // prerequisites (identity/scope, from journey-state), then a non-empty
  // valid selection. Always visible, disabled with the reason (keep-list:
  // always-visible-disabled affordances).
  const checkDisabledReason =
    journeyBlockedReason ??
    (selection.errors.length > 0
      ? "Fix the selection errors above first."
      : selection.specs.length === 0
        ? "Add at least one table to preview."
        : null);
  const canCheck = !checking && checkDisabledReason === null;

  return (
    <section className="panel">
      <h2 className="panel-title">Review deployment</h2>
      <p className="panel-desc">
        Previews exactly what a deploy run would create against workspace{" "}
        {config.workspaceName === "" ? "(not set)" : config.workspaceName}{" "}
        (resource group{" "}
        {config.resourceGroup === "" ? "(not set)" : config.resourceGroup}):
        per resource an Exists or Will create verdict from live Azure - never
        cached files - with the predicted names deployment will actually use
        and the ARM request bodies it would send. Checking is read-only: only
        GET requests are issued.
      </p>
      <p className="field-hint">{REVIEW_SELECTION_NOTE}</p>

      <div className="form-grid">
        <label className="field">
          <span className="field-label">
            Tables (one per line or comma-separated)
          </span>
          <textarea
            value={listText}
            onChange={(e) => setListText(e.target.value)}
            rows={5}
            placeholder={"SecurityEvent\nSyslog\nCommonSecurityLog"}
            spellCheck={false}
          />
          <span className="field-hint">
            Native names preview a Direct or DCE-based DCR. A _CL name listed
            here without a vendor schema requires the custom table to already
            exist in the workspace (its live schema wins).
          </span>
        </label>
        <label className="field">
          <span className="field-label">Add a bundled vendor schema table</span>
          <SearchableSelect
            options={availableVendors.map((entry) => ({
              value: entry.id,
              label: `${entry.label} (${entry.table})`,
            }))}
            value={vendorPick}
            onChange={setVendorPick}
            placeholder="Select a vendor schema..."
            ariaLabel="Filter vendor schemas"
          />
          <button
            className="run-button"
            disabled={vendorPick === ""}
            onClick={() => {
              if (vendorPick !== "") {
                setVendorIds((prev) => [...prev, vendorPick]);
                setVendorPick("");
              }
            }}
          >
            Add table with schema
          </button>
          <span className="field-hint">
            Adds the vendor&apos;s _CL table with its bundled schema so the
            preview includes the table-creation request a run would send.
          </span>
        </label>
      </div>
      {vendorIds.length > 0 && (
        <div className="panel-controls">
          {vendorIds.map((id) => {
            const entry = findVendorSchema(id);
            return (
              <button
                key={id}
                className="run-button"
                title="Remove from the selection"
                onClick={() =>
                  setVendorIds((prev) => prev.filter((v) => v !== id))
                }
              >
                {entry !== undefined ? entry.table : id} (remove)
              </button>
            );
          })}
        </div>
      )}
      {selection.duplicates.length > 0 && (
        <p className="field-hint">
          Merged duplicate entries (typed and picked):{" "}
          {selection.duplicates.join(", ")} - the vendor schema applies.
        </p>
      )}
      {selection.errors.map((error) => (
        <p key={error} className="config-editor-error">
          {error}
        </p>
      ))}

      <div className="discovery-result">
        <span className="field-label">
          Preview options ({selection.specs.length} table(s) selected)
        </span>
        <p className="panel-desc">
          The preview honors the saved Options
          {onOpenOptions !== undefined ? (
            <>
              {" "}
              (
              <button className="run-button" onClick={onOpenOptions}>
                open Options
              </button>
              )
            </>
          ) : null}
          . Per-run overrides chosen later on {deploySurfaceLabel} are not
          reflected here.
        </p>
        <pre className="result">
          {[
            `mode:               ${previewOptions.createDCE ? "DCE-based DCRs (shared batch DCE, 64-char names)" : "Direct DCRs (30-char names, Cribl 4.14+)"}`,
            `custom retention:   ${previewOptions.customTableRetentionDays} days`,
            `DCE public access:  ${previewOptions.dcePublicNetworkAccess ? "enabled" : "disabled (AMPLS required)"}`,
          ].join("\n")}
        </pre>
      </div>

      <div className="panel-controls">
        <button
          className="run-button"
          onClick={() => void check()}
          disabled={!canCheck}
          title={checkDisabledReason ?? undefined}
        >
          {checkActionLabel(generated !== null)}
        </button>
        {checking && <span className="status status-running">checking</span>}
        {checkDisabledReason !== null && (
          <span className="field-hint">{checkDisabledReason}</span>
        )}
      </div>
      {checkError !== "" && <pre className="result">{checkError}</pre>}

      {generated !== null && (
        <div className="discovery-result">
          <div className="review-marker-row">
            <span className="field-label">
              Preview - {formatReviewSummary(reviewCounts(rows))}
            </span>
            <span
              className={`readiness-chip ${
                stale ? "readiness-chip-unknown" : "readiness-chip-ok"
              }`}
              title={stale ? STALE_NOTICE : undefined}
            >
              {stale
                ? "stale"
                : `generated at ${generated.preview.generatedAtToken}`}
            </span>
          </div>
          {stale && <p className="review-stale-notice">{STALE_NOTICE}</p>}
          {rows.map((row) => (
            <ReviewRowView key={row.key} row={row} />
          ))}
        </div>
      )}

      <div className="discovery-result">
        <span className="field-label">Deploy handoff</span>
        <label className="review-acknowledge">
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={generated === null || stale || checking}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span>I have reviewed these changes</span>
        </label>
        <div className="panel-controls">
          <button
            className="run-button"
            disabled={!handoff.armed || onProceedToDeploy === undefined}
            title={handoff.reason ?? undefined}
            onClick={() => onProceedToDeploy?.()}
          >
            Proceed to {deploySurfaceLabel}
          </button>
          {handoff.reason !== null && (
            <span className="field-hint">{handoff.reason}</span>
          )}
        </div>
        <p className="field-hint">
          The acknowledgement arms only this handoff button and is never
          saved. Reviewing here is recommended, not required - the Run
          buttons on the onboarding screens keep their own gates
          (read-ahead).
        </p>
      </div>
    </section>
  );
}
