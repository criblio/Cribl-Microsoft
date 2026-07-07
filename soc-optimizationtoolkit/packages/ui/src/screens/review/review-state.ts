/**
 * Review state - the PURE decisions behind the ReviewScreen (porting-plan
 * Unit 7, ux-flow-plan 5.2: the Integrate arc's REVIEW stage), kept out of
 * the component so they are unit-testable without a DOM.
 *
 * @soc/core's deployment-preview usecase owns EVERY truth decision (names
 * via dcr-naming, existence via live ARM, request bodies via the deploy
 * builders); this module only derives display rows from its result, the
 * staleness predicate over an opaque inputs token, and the acknowledge-gate
 * arming for the Deploy handoff button.
 *
 * READ-AHEAD contract (user decision, binding): the acknowledge gate arms
 * ONLY the handoff button on the Review screen itself - it is never a hard
 * gate on Deploy (the Run buttons on Onboard / DCR Automation stay governed
 * by their own gates), and the acknowledgement is a TRANSIENT flag that is
 * never persisted as consent.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import type {
  DeploymentPreview,
  DeploymentPreviewOperationOptions,
  DeploymentPreviewTableSpec,
  OperationOptions,
} from "@soc/core";

// ---------------------------------------------------------------------------
// Preview options: the ONE projection from the persisted Unit 4 options
// ---------------------------------------------------------------------------

/**
 * Project the persisted OperationOptions onto the fields the preview honors
 * (one place, so the screen's preview call and the staleness token can never
 * disagree about which options participate). Note what is ABSENT by the
 * usecase's design: templateOnly and skipExistingDCRs do not change what a
 * preview shows - a preview is read-only and existence is reported as a
 * fact, not as a skip decision.
 */
export function previewOptionsOf(
  options: OperationOptions,
): DeploymentPreviewOperationOptions {
  return {
    createDCE: options.createDCE,
    customTableRetentionDays: options.customTableRetentionDays,
    dcePublicNetworkAccess: options.dcePublicNetworkAccess,
  };
}

// ---------------------------------------------------------------------------
// Staleness: an opaque, deterministic token over the preview-relevant inputs
// ---------------------------------------------------------------------------

/** The ARM scope a review targets (the committed connection scope fields). */
export interface ReviewScope {
  subscriptionId: string;
  resourceGroup: string;
  workspaceName: string;
}

/**
 * Deterministic token over EVERYTHING the preview's output depends on: the
 * committed scope, the three preview-relevant options, and the ordered table
 * specs including their attached schema columns (a different vendor schema
 * for the same table IS a different preview). Field order is fixed in code,
 * so equal inputs always serialize identically - no clocks, no randomness.
 *
 * The staleness marker compares the token captured at generation time with
 * the current one: any selection/option/scope change after generation flips
 * the preview stale (legacy manual-analysis pattern - the user controls when
 * the live ARM work re-runs and always knows if results are stale).
 */
export function reviewInputsToken(
  specs: readonly DeploymentPreviewTableSpec[],
  options: DeploymentPreviewOperationOptions,
  scope: ReviewScope,
): string {
  return JSON.stringify({
    scope: {
      subscriptionId: scope.subscriptionId,
      resourceGroup: scope.resourceGroup,
      workspaceName: scope.workspaceName,
    },
    options: {
      createDCE: options.createDCE,
      customTableRetentionDays: options.customTableRetentionDays,
      dcePublicNetworkAccess: options.dcePublicNetworkAccess,
    },
    tables: specs.map((spec) => ({
      table: spec.table,
      customSchema:
        spec.customSchema === undefined
          ? null
          : spec.customSchema.map((column) => ({
              name: column.name,
              type: column.type,
              description: column.description ?? null,
            })),
    })),
  });
}

/** A generated preview plus the inputs token captured when it was built. */
export interface GeneratedPreview {
  preview: DeploymentPreview;
  /** {@link reviewInputsToken} of the inputs the preview was generated FROM. */
  inputsToken: string;
}

/**
 * The staleness predicate: a preview is stale exactly when it exists and the
 * current inputs no longer match the ones it was generated from. No preview
 * is never "stale" - there is nothing to be stale (the gate handles that
 * case with its own reason).
 */
export function isPreviewStale(
  generated: Pick<GeneratedPreview, "inputsToken"> | null,
  currentToken: string,
): boolean {
  return generated !== null && generated.inputsToken !== currentToken;
}

/**
 * The check action's label: "Re-check" once a preview exists (the legacy
 * Analyze/Re-Analyze relabeling), else the initial imperative.
 */
export function checkActionLabel(hasPreview: boolean): string {
  return hasPreview ? "Re-check" : "Check resources";
}

/** The visible stale-marker copy (one constant, both shells). */
export const STALE_NOTICE =
  "Stale: the selection, options, or scope changed after this preview was " +
  "generated. Re-check to refresh it against live Azure.";

// ---------------------------------------------------------------------------
// Row derivation from the core preview result
// ---------------------------------------------------------------------------

/** Which resource a review row describes. */
export type ReviewRowTag = "DCE" | "TBL" | "DCR";

/** Exists vs Will Create - the row's pill. */
export type ReviewVerdict = "exists" | "will-create";

/** One per-resource row of the review list. */
export interface ReviewRow {
  /** Stable render key (tag + resource name). */
  key: string;
  tag: ReviewRowTag;
  /** The resource name (DCE name, workspace table name, or DCR name). */
  name: string;
  /** The owning table, or null for the batch-shared DCE. */
  table: string | null;
  verdict: ReviewVerdict;
  /** One honest sentence about what a deploy run would do with this row. */
  note: string;
  /**
   * Extra facts for existing resources (immutableId, ingestion endpoint -
   * VERBATIM from ARM - or the raw detail-fetch error), one per line.
   */
  detailLines: string[];
  /**
   * Pretty-printed ARM request JSON (method, path, api-version, body) for
   * the expandable view; null when a deploy run would send nothing.
   */
  requestJson: string | null;
}

/** Pretty-print an attached preview request for the expandable view. */
function formatRequestJson(request: {
  method: string;
  path: string;
  apiVersion: string;
  body: unknown;
}): string {
  return JSON.stringify(
    {
      method: request.method,
      path: request.path,
      apiVersion: request.apiVersion,
      body: request.body,
    },
    null,
    2,
  );
}

/**
 * Flatten the core preview into display rows, preserving the preview's
 * order: the batch-shared DCE first (DCE mode only), then per table the
 * workspace-table row (custom _CL tables only) followed by its DCR row.
 * Zero truth decisions here - names, existence, and request bodies pass
 * through from the usecase untouched.
 */
export function deriveReviewRows(preview: DeploymentPreview): ReviewRow[] {
  const rows: ReviewRow[] = [];

  if (preview.dce !== null) {
    const dce = preview.dce;
    rows.push({
      key: `dce:${dce.name}`,
      tag: "DCE",
      name: dce.name,
      table: null,
      verdict: dce.exists ? "exists" : "will-create",
      note: dce.exists
        ? "Exists - the run reuses this shared Data Collection Endpoint; nothing is sent."
        : "Will create - one shared Data Collection Endpoint for the whole batch.",
      detailLines: [`resource id: ${dce.resourceId}`],
      requestJson: dce.request === null ? null : formatRequestJson(dce.request),
    });
  }

  for (const table of preview.tables) {
    if (table.tableResource !== null) {
      const resource = table.tableResource;
      rows.push({
        key: `tbl:${table.table}`,
        tag: "TBL",
        name: table.table,
        table: table.table,
        verdict: resource.exists ? "exists" : "will-create",
        note: resource.exists
          ? "Exists - creation is skipped; the existing table's schema wins."
          : "Will create - custom Log Analytics table from the supplied schema.",
        detailLines: [],
        requestJson:
          resource.request === null
            ? null
            : formatRequestJson(resource.request),
      });
    }

    const dcr = table.dcrResource;
    const detailLines: string[] = [];
    if (dcr.immutableId !== undefined) {
      detailLines.push(`immutableId: ${dcr.immutableId}`);
    }
    if (dcr.ingestionEndpoint !== undefined) {
      detailLines.push(`ingestion endpoint: ${dcr.ingestionEndpoint}`);
    }
    if (dcr.detailError !== undefined) {
      detailLines.push(`detail fetch failed: ${dcr.detailError}`);
    }
    rows.push({
      key: `dcr:${table.dcrName}`,
      tag: "DCR",
      name: table.dcrName,
      table: table.table,
      verdict: dcr.exists ? "exists" : "will-create",
      note: dcr.exists
        ? "Exists under exactly this name - a run deploys over it, or skips it when skip-existing is on."
        : `Will create - ${preview.mode === "dce" ? "DCE-based" : "Direct"} DCR for table ${table.table}.`,
      detailLines,
      requestJson: formatRequestJson(dcr.request),
    });
  }

  return rows;
}

/** Combined counts for the review summary line. */
export interface ReviewCounts {
  exists: number;
  willCreate: number;
  total: number;
}

/** Count Exists vs Will Create across the derived rows. */
export function reviewCounts(rows: readonly ReviewRow[]): ReviewCounts {
  let exists = 0;
  for (const row of rows) {
    if (row.verdict === "exists") {
      exists++;
    }
  }
  return { exists, willCreate: rows.length - exists, total: rows.length };
}

/** The one-line summary above the rows. */
export function formatReviewSummary(counts: ReviewCounts): string {
  return (
    `${counts.willCreate} to create, ${counts.exists} already existing ` +
    `(${counts.total} resource(s) checked against live Azure)`
  );
}

// ---------------------------------------------------------------------------
// The acknowledge gate: arming the Deploy handoff
// ---------------------------------------------------------------------------

/** Everything the handoff-arming decision depends on. */
export interface DeployHandoffInput {
  /**
   * The journey deploy stage's blockedReason (from @soc/core deriveJourney),
   * or null when Deploy is not blocked. The preview needs the same live-ARM
   * prerequisites (identity + committed scope), so this ONE journey-state
   * hint drives the disabled-button text here - never per-screen prose.
   */
  journeyBlockedReason: string | null;
  /** A preview has been generated this session. */
  hasPreview: boolean;
  /** The generated preview no longer matches the current inputs. */
  stale: boolean;
  /** The 'I have reviewed these changes' check is ticked. */
  acknowledged: boolean;
  /** A preview generation is in flight. */
  checking: boolean;
}

/** The handoff button's derived state. */
export interface DeployHandoff {
  /** True exactly when the handoff button is clickable. */
  armed: boolean;
  /** The SINGLE missing thing when disarmed (button hint); null when armed. */
  reason: string | null;
}

export const HANDOFF_NEEDS_PREVIEW_REASON =
  "Check resources first - the preview is what you acknowledge.";
export const HANDOFF_CHECKING_REASON =
  "The preview is being generated - wait for it to finish.";
export const HANDOFF_STALE_REASON =
  "The preview is stale - Re-check it for the current inputs, then acknowledge.";
export const HANDOFF_NEEDS_ACKNOWLEDGE_REASON =
  "Tick 'I have reviewed these changes' to arm the Deploy handoff.";

/**
 * Arm the Deploy handoff button. Reasons cascade in dependency order and
 * name exactly ONE missing thing (the legacy single-next-action pattern):
 * journey prerequisites (identity/scope, straight from journey-state), then
 * generation in flight, then no preview, then staleness, then the
 * acknowledgement itself.
 *
 * This gates ONLY the handoff button on the Review screen. It never gates
 * Deploy elsewhere (read-ahead decision), and the acknowledgement is
 * transient - nothing here is persisted.
 */
export function deriveDeployHandoff(input: DeployHandoffInput): DeployHandoff {
  if (input.journeyBlockedReason !== null) {
    return { armed: false, reason: input.journeyBlockedReason };
  }
  if (input.checking) {
    return { armed: false, reason: HANDOFF_CHECKING_REASON };
  }
  if (!input.hasPreview) {
    return { armed: false, reason: HANDOFF_NEEDS_PREVIEW_REASON };
  }
  if (input.stale) {
    return { armed: false, reason: HANDOFF_STALE_REASON };
  }
  if (!input.acknowledged) {
    return { armed: false, reason: HANDOFF_NEEDS_ACKNOWLEDGE_REASON };
  }
  return { armed: true, reason: null };
}

// ---------------------------------------------------------------------------
// Honest copy shared by both shells
// ---------------------------------------------------------------------------

/**
 * The honest note about the table selection: this unit does NOT lift the
 * batch screen's selection state into a shared store - the Review screen
 * takes its own table entry through the SAME parsing (buildBatchSelection),
 * and says so instead of pretending the two screens are linked.
 */
export const REVIEW_SELECTION_NOTE =
  "This screen takes its own table list (same parsing and vendor-schema " +
  "picks as DCR Automation - enter the same selection you plan to run " +
  "there). Selections are not yet shared between the two screens.";
