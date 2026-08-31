/**
 * WorkspaceTablesPanel - the Tables tab of the DCR Automation screen (TBL-3,
 * placement settled by TBL-5). Lists the workspace's Log Analytics tables with
 * the fact that matters operationally here: whether a DCR already targets each
 * one.
 *
 * NOT A REVIVAL OF `TablePickerSection`, which was deleted 2026-08-18. That
 * panel was a PICKER whose job - choose one table for the whole analysis -
 * moved onto the per-log-type mapping-review cards, leaving it listing ~842
 * rows nobody selected from; its own header read "IT LOADS; IT DOES NOT
 * SELECT". This one is an operational inventory with an action per row,
 * standing to tables exactly as DcrInventoryPanel stands to DCRs. Three of
 * that deletion's rules are honoured deliberately:
 *
 *   - IT DOES NOT AUTO-LOAD. The listing runs on a button press, because one
 *     403 against an ~842-row listing would otherwise become a request storm
 *     on every mount. This is also why `useWorkspaceTables` is NOT reused: it
 *     loads on an effect and its `listedFor` guard means a second load for the
 *     same workspace never happens, so it cannot serve a Refresh at all.
 *   - NO FILTER BOX. `filterTables` went with the panel. A filter is
 *     defensible once rows are actionable, but it must be written fresh with
 *     its own pins rather than resurrected under the old name.
 *   - NO PRE-LOAD "this may fail" ANNOTATION. `deriveTablePickerAccess`
 *     predicted what the load would do; the real answer arrives in the same
 *     second, and a prediction that disagreed with the outcome would be two
 *     answers to one question.
 *
 * THE LOAD BUTTON IS NEVER DISABLED BY A CAPABILITY VERDICT. Rule 1 of the
 * capability model - a denied verdict annotates, it never removes the attempt -
 * used to hold here by construction, because there was no button. Adding one
 * puts the rule back in play, so `disabled` may reference only in-flight state
 * and a blank scope. Azure's own 403 is the gate, and it is reported verbatim.
 *
 * TBL-4: THE TWO WRITE ACTIONS HERE CARRY THE FALLBACK OFFER. Rule 2 - every
 * blocked action falls back to "download the thing you'd need someone else to
 * run" - applies to Create DCR and to the create-table flow, and the offer is
 * gated on the MEASURED capability so it appears beside the button rather than
 * after a 403. Neither button is disabled or hidden by that verdict; the offer
 * sits next to a control that stays exactly as attemptable as it was.
 *
 * BOTH ARTIFACTS ARE RUN KINDS, so per D-2 (backlog section 16) this panel
 * POINTS at the run that makes them and never assembles a body itself - it owns
 * no run of its own. The two pointers each carry the prerequisite that run has,
 * because a pointer that omits it sends the operator to a failure.
 */

import { useCallback, useState } from "react";
import {
  createCustomTable,
  CUSTOM_TABLE_SUFFIX_RULE,
  emptyCapabilitySet,
  hasCustomTableSuffix,
  listDcrInventory,
  listWorkspaceTables,
  routeCapability,
} from "@soc/core";
import type {
  CapabilityContext,
  CapabilityFallback,
  CapabilitySet,
  DcrInventoryEntry,
  WorkspaceTable,
} from "@soc/core";
import { usePorts } from "../../ports-context";
// Imported from the modules directly. `FALLBACK_POINTER_LABEL` and
// `fallbackRunPointer` are not re-exported from capabilities/index.ts yet
// (HON-7 added them but did not own that barrel), which is also how the DCR
// inventory panel and the Batch screen reach them.
import { FallbackNotice } from "../../capabilities/fallback-notice";
import {
  FALLBACK_POINTER_LABEL,
  fallbackRunPointer,
} from "../../capabilities/fallback-notice-state";
import { listingRows } from "@soc/core";
import { emptyTableListMessage } from "../table-picker/table-picker-state";
import {
  buildWorkspaceTableRows,
  checkTableName,
  dcrCellLabel,
  dcrColumnNote,
} from "./workspace-tables-state";
import { ManualSchemaEditor } from "../../onboarding/manual-schema-editor";
import {
  addManualColumn,
  emptyManualColumns,
  manualColumnsToSchema,
  manualRowStatuses,
  manualSchemaErrors,
  removeManualColumn,
  updateManualColumn,
} from "../../onboarding/manual-schema-state";
import type { ManualColumnDraft } from "../../onboarding/manual-schema-state";

export interface WorkspaceTablesPanelProps {
  /** What the connected identity was measured to be able to do. */
  capabilities?: CapabilitySet;
  /** Connection facts for resolving unmeasured capabilities. */
  capabilityContext?: CapabilityContext;
  /**
   * Start a DCR for one table. OPTIONAL because it navigates - only a host
   * that owns the tab selection can honour it, and a button that went
   * nowhere would be worse than no button. (Creating a TABLE needs no host:
   * it is Azure-only, so this panel does it itself.)
   */
  onCreateDcr?: (table: string) => void;
}

export function WorkspaceTablesPanel(props: WorkspaceTablesPanelProps = {}) {
  const { capabilities, capabilityContext, onCreateDcr } = props;
  const { ports, config } = usePorts();
  const logger = ports.logger;

  const [tables, setTables] = useState<WorkspaceTable[] | null>(null);
  // null = the DCR listing was not read. Never [] for that case: an empty
  // array is a measured zero and null is an absence of measurement.
  const [dcrs, setDcrs] = useState<DcrInventoryEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // The create-table flow (TBL-1 + TBL-2). Azure-only: creating a table needs
  // no Cribl worker group and no ingestion client id, which is the whole
  // reason it lives here rather than behind the Single tab's Run.
  const [creating, setCreating] = useState(false);
  const [newTable, setNewTable] = useState("");
  const [newColumns, setNewColumns] = useState<ManualColumnDraft[]>(
    emptyManualColumns,
  );
  const [createBusy, setCreateBusy] = useState(false);
  const [createResult, setCreateResult] = useState("");

  // TBL-4: which run makes an offered artifact, shown once the operator takes
  // that offer. Two slots rather than one because the offers live in different
  // regions of this panel - a pointer about the create form must not surface
  // under the listing - and neither is merged into `error` or `createResult`,
  // which report what an action HERE did. A pointer is not a thing that
  // happened.
  const [dcrOfferPointer, setDcrOfferPointer] = useState("");
  const [tableOfferPointer, setTableOfferPointer] = useState("");

  const scopeReady =
    config.subscriptionId !== "" &&
    config.resourceGroup !== "" &&
    config.workspaceName !== "";

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    logger?.info(
      `workspace-tables: listing tables in '${config.workspaceName}'`,
    );
    try {
      const listed = await listWorkspaceTables(ports.azure, {
        subscriptionId: config.subscriptionId,
        resourceGroup: config.resourceGroup,
        workspaceName: config.workspaceName,
      });
      // Safe to unwrap: the empty case is rendered by emptyTableListMessage
      // (see `emptyMessage` below), which consults the capability before it
      // will say "no tables". The LOG has no such reader, so it says which
      // kind of nothing it saw rather than printing a bare 0 (DBT-61).
      setTables([...listingRows(listed)]);
      logger?.info(
        listed.kind === "rows"
          ? `workspace-tables: ${listed.rows.length} table(s)`
          : "workspace-tables: the listing came back empty - see the panel for " +
              "whether that is an empty workspace or a read we do not have",
      );

      // The DCR side is a SEPARATE, non-fatal read: the tables listing is the
      // panel's job and a DCR listing failure must degrade the one column
      // rather than lose the whole page. Left as null on failure, which the
      // row builder renders as "not checked".
      try {
        const listed = await listDcrInventory(ports.azure, {
          subscriptionId: config.subscriptionId,
          resourceGroup: config.resourceGroup,
        });
        // DBT-61: an EMPTY listing is treated exactly like a failed one -
        // null, so every row reads "not checked" rather than "none in scope".
        // The read succeeded, but an RBAC-filtered ARM list returns 200 with
        // an empty array (docs/inventory-standard.md), and nothing here
        // verifies which of the two happened. workspace-tables-state already
        // says this in its own words: "`unchecked`, never `none-in-scope`".
        // Under-claiming on a genuinely empty group costs one word in one
        // column; over-claiming tells the operator a DCR is missing when they
        // simply cannot see it.
        setDcrs(listed.kind === "rows" ? [...listed.rows] : null);
        if (listed.kind === "empty") {
          logger?.info(
            "workspace-tables: the DCR listing came back empty, which under " +
              "RBAC filtering is indistinguishable from having no read on " +
              "them - the DCR column reads 'not checked'",
          );
        }
      } catch (err) {
        setDcrs(null);
        logger?.info(
          "workspace-tables: DCR listing unavailable, the DCR column reads " +
            `'not checked' - ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTables(null);
      setDcrs(null);
      setError(message);
      logger?.error(`workspace-tables: listing failed - ${message}`);
    } finally {
      setBusy(false);
    }
  }, [
    ports.azure,
    logger,
    config.subscriptionId,
    config.resourceGroup,
    config.workspaceName,
  ]);

  const nameCheck = checkTableName(newTable, tables);
  const schemaErrors = manualSchemaErrors(newColumns);
  const schemaColumns = manualColumnsToSchema(newColumns);
  // Every reason Create is not available, first one shown. Ordered from the
  // operator's own input outward, so the message names what they can fix.
  const createDisabledReason =
    newTable.trim() === ""
      ? "Name the table first."
      : // The domain owns this rule, exact casing included - restating it here
        // would be a second place that can disagree, and reaching for the
        // case-INSENSITIVE isCustomTableName instead would let `foo_cl`
        // through to a validator that deliberately rejects it.
        !hasCustomTableSuffix(newTable.trim())
        ? `Not a valid custom table name - ${CUSTOM_TABLE_SUFFIX_RULE}.`
        : nameCheck.blocking
          ? nameCheck.message
          : schemaColumns.length === 0
            ? "Add at least one field."
            : schemaErrors.length > 0
              ? schemaErrors[0]
              : null;

  const create = useCallback(async () => {
    setCreateBusy(true);
    setCreateResult("");
    try {
      const result = await createCustomTable(ports.azure, {
        subscriptionId: config.subscriptionId,
        resourceGroup: config.resourceGroup,
        workspaceName: config.workspaceName,
        table: newTable.trim(),
        columns: manualColumnsToSchema(newColumns),
      });
      setCreateResult(
        result.created
          ? `Created ${result.tableName} with ${result.columnCount} columns ` +
              `(retention ${result.retentionInDays}/${result.totalRetentionInDays} days).`
          : `${result.tableName} already existed - nothing was written.`,
      );
      logger?.info(
        `workspace-tables: create ${result.tableName} - ` +
          (result.created ? "created" : "already existed"),
      );
      // Re-list so the new table appears and the name check sees it.
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setCreateResult(message);
      logger?.error(`workspace-tables: create failed - ${message}`);
    } finally {
      setCreateBusy(false);
    }
    // `load` is intentionally in the deps: re-listing after a create is part
    // of this action, not a side effect someone else owns.
  }, [
    ports.azure,
    logger,
    config.subscriptionId,
    config.resourceGroup,
    config.workspaceName,
    newTable,
    newColumns,
    load,
  ]);

  const rows = tables === null ? [] : buildWorkspaceTableRows(tables, dcrs);

  // Resolved once: the empty-listing message and both write offers below have
  // to read the same audit, or the panel could say two different things about
  // one connection.
  const caps = capabilities ?? emptyCapabilitySet();
  const ctx = capabilityContext ?? {
    azureIdentityPresent: true,
    criblReachable: true,
  };
  const emptyMessage = emptyTableListMessage(caps, ctx);

  // TBL-4. The artifact for each blocked write on this panel, or null when the
  // capability routes LIVE.
  //
  // `routeCapability` yields a fallback only for a MEASURED denial or an
  // unreachable connection - `unknown` routes live and offers nothing. That is
  // the whole point of gating on the measurement: an unaudited connection (the
  // normal state) renders no offer at all rather than implying a block nobody
  // has established.
  const dcrOffer = routeCapability("dcr.write", caps, ctx).fallback;
  const tableOffer = routeCapability("table.write", caps, ctx).fallback;

  /**
   * Take the Create DCR offer.
   *
   * "dcr-arm-bodies" is a RUN kind, so this POINTS (D-2). It is not merely a
   * rule being obeyed: the row on screen holds a name, a kind, a retention and
   * a plan, which is nowhere near a DCR body - the run resolves the table's
   * live column list, and every table listed here exists, so that read is
   * available to it and not to this row.
   */
  const showDcrPointer = (fallback: CapabilityFallback): void => {
    const pointer = fallbackRunPointer(fallback.kind);
    setDcrOfferPointer(
      pointer === null
        ? ""
        : `${pointer} Every table listed here already exists, so that run ` +
            "reads its live schema for the column declaration - which is why " +
            "this points at the run instead of building a body from the row.",
    );
  };

  /**
   * Take the create-table offer.
   *
   * ALSO A RUN KIND, and this pointer carries the prerequisite that run has,
   * which is load-bearing rather than decorative: `collectTableTemplates`
   * collects a table PUT only for a custom table that does NOT exist and DOES
   * have a supplied schema, and the Batch tab's only schema source is its
   * bundled vendor list (a typed _CL name carries no schema, which is what its
   * own hint means by "requires the custom table to already exist"). Pointing
   * without saying so would send an operator to a run that fails with "does not
   * exist and no customSchema was provided".
   */
  const showTablePointer = (fallback: CapabilityFallback): void => {
    const pointer = fallbackRunPointer(fallback.kind);
    setTableOfferPointer(
      pointer === null
        ? ""
        : `${pointer} It resolves the schema itself and does not carry the ` +
            "fields typed here: on that tab a _CL name that does not exist " +
            "yet collects a creation body only when it was added from the " +
            "bundled vendor list, which a table authored on this form is " +
            "not in.",
    );
  };

  return (
    <div className="panel">
      <p className="panel-desc">
        Every Log Analytics table in {config.workspaceName || "the workspace"},
        and whether a data collection rule already targets it. Listing is
        read-only.
      </p>
      <div className="panel-controls">
        <button
          className="run-button"
          onClick={() => void load()}
          disabled={busy || !scopeReady}
          title={
            scopeReady
              ? undefined
              : "Select a subscription, resource group and workspace first."
          }
        >
          {busy ? "Loading..." : tables === null ? "Load tables" : "Refresh"}
        </button>
        <button
          className="run-button"
          onClick={() => {
            setCreating(!creating);
            setCreateResult("");
            // A pointer belongs to the form that raised it - reopening the
            // form to author a different table must not reopen it with an
            // answer about the last one (TBL-4).
            setTableOfferPointer("");
          }}
          disabled={busy || createBusy}
          title="Define a new custom table's fields and types"
        >
          {creating ? "Cancel" : "Create table"}
        </button>
      </div>
      {error !== "" && <pre className="result">{error}</pre>}
      {creating && (
        <div className="panel create-table-form">
          <p className="panel-desc">
            Creates the Log Analytics table only - no data collection rule and
            no Cribl destination. Azure-managed columns are removed from the
            payload and TimeGenerated is added when absent.
          </p>
          <label className="field">
            <span className="field-label">Table name</span>
            <input
              type="text"
              placeholder="MyApp_CL"
              value={newTable}
              autoComplete="off"
              spellCheck={false}
              disabled={createBusy}
              onChange={(ev) => setNewTable(ev.target.value)}
            />
            {/* The name check ANNOTATES on an unread listing and BLOCKS only
                on a measured collision - an unread listing cannot say a name
                is free. */}
            {nameCheck.message !== null && (
              <span
                className={
                  nameCheck.blocking
                    ? "field-hint enrich-issue"
                    : "field-hint"
                }
              >
                {nameCheck.message}
              </span>
            )}
          </label>
          <ManualSchemaEditor
            rows={newColumns}
            statuses={manualRowStatuses(newColumns)}
            onAdd={() => setNewColumns(addManualColumn(newColumns))}
            onRemove={(id) => setNewColumns(removeManualColumn(newColumns, id))}
            onEdit={(id, patch) =>
              setNewColumns(updateManualColumn(newColumns, id, patch))
            }
            busy={createBusy}
          />
          <div className="panel-controls">
            <button
              className="run-button"
              onClick={() => void create()}
              disabled={createBusy || createDisabledReason !== null}
              title={createDisabledReason ?? undefined}
            >
              {createBusy ? "Creating..." : "Create table"}
            </button>
            {createDisabledReason !== null && !createBusy && (
              <span className="field-hint">{createDisabledReason}</span>
            )}
          </div>
          {/* TBL-4 / rule 2. The artifact for the write this identity was
              MEASURED to lack, beside a Create table button that is disabled by
              the draft alone - never by the verdict. */}
          {tableOffer !== null && (
            <div className="discovery-result">
              <span className="field-label">Take this to someone who can</span>
              <p className="panel-desc">
                Create table above stays available. The audit reports access,
                it does not gate anything, and Azure&apos;s own refusal is the
                real gate.
              </p>
              <FallbackNotice
                fallback={tableOffer}
                onProduce={() => showTablePointer(tableOffer)}
                produceLabel={FALLBACK_POINTER_LABEL}
              />
              {tableOfferPointer !== "" && (
                <p className="panel-desc">{tableOfferPointer}</p>
              )}
            </div>
          )}
          {createResult !== "" && <pre className="result">{createResult}</pre>}
        </div>
      )}
      {tables !== null && tables.length === 0 && (
        <p className="field-hint">{emptyMessage.text}</p>
      )}
      {rows.length > 0 && (
        <>
          <p className="field-hint">{dcrColumnNote(config.resourceGroup)}</p>
          {/* `match-field-table mapping-review-grid` is the styled table pair
              this app actually uses (dcr-inventory-panel.tsx:588). There is no
              `.inventory-table` in the sheet - see DBT-39 for the four class
              names already shipping that render as bare markup. */}
          <table className="match-field-table mapping-review-grid">
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Retention</th>
                <th>Plan</th>
                <th>Data collection rule</th>
                {onCreateDcr !== undefined && <th>Action</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.name}>
                  <td>{row.name}</td>
                  <td>{row.kind}</td>
                  <td>{row.retentionLabel}</td>
                  <td>{row.planLabel}</td>
                  <td>{dcrCellLabel(row, config.resourceGroup)}</td>
                  {onCreateDcr !== undefined && (
                    <td>
                      <button
                        className="gap-reset-button"
                        onClick={() => onCreateDcr(row.name)}
                        disabled={busy}
                        title={
                          row.dcr === "has"
                            ? `Already targeted by ${row.dcrNames.join(", ")} - creating another is usually not what you want`
                            : `Create a data collection rule for ${row.name}`
                        }
                      >
                        Create DCR
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {/* TBL-4 / rule 2. One offer for the column, not one per row: a
              notice on every row of a listing this long would bury it, and the
              artifact is the same whichever row is clicked.

              GATED ON `onCreateDcr` AS WELL AS THE VERDICT. Without a host
              there is no Create DCR button at all (see the Action column
              above), so there is no blocked action on this surface to offer an
              artifact for - and an offer for an action the operator cannot
              even attempt here would answer a question nobody asked. */}
          {dcrOffer !== null && onCreateDcr !== undefined && (
            <div className="discovery-result">
              <span className="field-label">Take this to someone who can</span>
              <p className="panel-desc">
                Create DCR stays available on every row. The audit reports
                access, it does not gate anything, and Azure&apos;s own refusal
                is the real gate.
              </p>
              <FallbackNotice
                fallback={dcrOffer}
                onProduce={() => showDcrPointer(dcrOffer)}
                produceLabel={FALLBACK_POINTER_LABEL}
              />
              {dcrOfferPointer !== "" && (
                <p className="panel-desc">{dcrOfferPointer}</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
