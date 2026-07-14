/**
 * Pure decision logic for the BatchDeployScreen (porting-plan Unit 6). Kept
 * out of the screen component so the selection parsing, per-run option
 * overrides, counts derivation, summary formatting, and templateOnly
 * artifact naming are unit-testable without a DOM.
 *
 * All batch knowledge comes from @soc/core: OnboardBatchTableSpec is the
 * usecase's own input shape, bundled vendor schemas resolve through
 * findVendorSchema + parseTableSchemaFile (the SAME parse path a user upload
 * takes), and the Unit 6 AMPLS cross-field rule is re-checked through the
 * REAL validateOptions contract - nothing is re-implemented here.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import {
  CustomTableError,
  findVendorSchema,
  parseTableSchemaFile,
  validateOptions,
  optionsToFormValues,
  OPERATION_OPTION_FIELDS,
} from "@soc/core";
import type {
  CollectedArmRequest,
  JobRecord,
  OnboardBatchOutcome,
  OnboardBatchTableResult,
  OnboardBatchTableSpec,
  OperationOptions,
} from "@soc/core";
import { formatStepLine } from "../step-line";

// ---------------------------------------------------------------------------
// Table selection: free-text list + bundled vendor-schema picks
// ---------------------------------------------------------------------------

/**
 * Parse the free-text table list (textarea): entries split on newlines,
 * commas, semicolons, and whitespace (table names never contain any of
 * these), empties dropped, exact duplicates deduped keeping the FIRST
 * occurrence (order is the batch's processing order).
 */
export function parseTableListText(text: string): string[] {
  const seen = new Set<string>();
  const tables: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const table = raw.trim();
    if (table === "" || seen.has(table)) {
      continue;
    }
    seen.add(table);
    tables.push(table);
  }
  return tables;
}

/** The derived batch selection the Run button consumes. */
export interface BatchSelection {
  /** Ordered specs for onboardBatch (text entries first, then vendor picks). */
  specs: OnboardBatchTableSpec[];
  /**
   * Tables that appeared more than once across the text list and the vendor
   * picks (informational - the selection deduped them; a vendor pick whose
   * table is also typed MERGES its schema into the typed entry).
   */
  duplicates: string[];
  /** Blocking problems (unknown vendor id, unparseable bundled schema). */
  errors: string[];
}

/**
 * Build the ordered batch selection from the two input surfaces (pinned by
 * tests):
 *
 *   - Free-text entries come first, in typed order. Native names run the
 *     native path; _CL names without a schema rely on the table already
 *     existing in the workspace (onboardTable's "existing table wins" rule).
 *   - Vendor picks append their _CL table WITH the bundled schema columns,
 *     in pick order, skipping tables already present.
 *   - A vendor pick whose table was ALSO typed merges: one spec at the typed
 *     position, carrying the vendor schema (the schema can only help - the
 *     live table still wins when it exists).
 */
export function buildBatchSelection(
  listText: string,
  vendorIds: readonly string[],
): BatchSelection {
  const errors: string[] = [];
  const duplicates: string[] = [];
  const specs: OnboardBatchTableSpec[] = parseTableListText(listText).map(
    (table) => ({ table }),
  );
  const byTable = new Map<string, number>(
    specs.map((spec, index) => [spec.table, index]),
  );

  const seenVendorIds = new Set<string>();
  for (const vendorId of vendorIds) {
    if (seenVendorIds.has(vendorId)) {
      continue;
    }
    seenVendorIds.add(vendorId);
    const entry = findVendorSchema(vendorId);
    if (entry === undefined) {
      errors.push(`Unknown vendor schema '${vendorId}'.`);
      continue;
    }
    let columns;
    try {
      columns = parseTableSchemaFile(entry.raw).columns;
    } catch (error) {
      errors.push(
        `Bundled schema '${entry.label}' did not parse: ` +
          (error instanceof CustomTableError ? error.message : String(error)),
      );
      continue;
    }
    const existingIndex = byTable.get(entry.table);
    if (existingIndex !== undefined) {
      // Typed AND picked: merge the schema into the typed entry (position
      // and dedupe rule pinned).
      duplicates.push(entry.table);
      specs[existingIndex] = { table: entry.table, customSchema: columns };
      continue;
    }
    byTable.set(entry.table, specs.length);
    specs.push({ table: entry.table, customSchema: columns });
  }
  return { specs, duplicates, errors };
}

// ---------------------------------------------------------------------------
// Per-run option overrides (skipExistingDCRs / templateOnly / createDCE)
// ---------------------------------------------------------------------------

/** One tri-state override: follow the persisted default, or force on/off. */
export type BatchRunOverride = "default" | "on" | "off";

/** The three per-run overridable flags (porting-plan Unit 6). */
export interface BatchRunOverrides {
  createDCE: BatchRunOverride;
  skipExistingDCRs: BatchRunOverride;
  templateOnly: BatchRunOverride;
}

/** All-defaults: the persisted Options-screen values apply unchanged. */
export const DEFAULT_BATCH_RUN_OVERRIDES: BatchRunOverrides = Object.freeze({
  createDCE: "default",
  skipExistingDCRs: "default",
  templateOnly: "default",
});

function overridden(base: boolean, override: BatchRunOverride): boolean {
  return override === "default" ? base : override === "on";
}

/**
 * The EFFECTIVE options a run uses: the persisted OperationOptions with the
 * three per-run overrides applied. "default" passes the persisted value
 * through untouched; every other field is never modified here.
 *
 * `forcedTemplateOnly` (recorded Unit 6.5 decision: batch-onboard's route
 * requirement relaxes to 'azure') outranks BOTH the persisted default and
 * the per-run override: when the active mode has no live Cribl connection
 * (azure-only), nothing can deploy, so templateOnly is FORCED on - the
 * tri-state override deliberately cannot express "forced" (it is a user
 * choice model; a mode fact is not a choice).
 */
export function applyRunOverrides(
  base: OperationOptions,
  overrides: BatchRunOverrides,
  forcedTemplateOnly = false,
): OperationOptions {
  return {
    ...base,
    createDCE: overridden(base.createDCE, overrides.createDCE),
    skipExistingDCRs: overridden(
      base.skipExistingDCRs,
      overrides.skipExistingDCRs,
    ),
    templateOnly:
      forcedTemplateOnly || overridden(base.templateOnly, overrides.templateOnly),
  };
}

/**
 * The honest copy the batch screen shows when templateOnly is forced on -
 * why the flag is not the user's to flip in this mode, and what a run
 * produces instead. One constant so both shells (and the disabled controls'
 * hints) can never drift.
 */
export const FORCED_TEMPLATE_ONLY_NOTICE =
  "Template only is forced on: this mode has no live Cribl connection, so " +
  "nothing can deploy to Cribl and no worker group is needed. The run " +
  "collects every ARM request body as one downloadable artifact instead.";

/**
 * The Unit 6 AMPLS cross-field rule re-checked over the EFFECTIVE options
 * (a per-run createDCE override can create the createDCE=true +
 * dcePublicNetworkAccess=false combination even though the Options screen
 * blocked saving it without an AMPLS id). Delegates to the REAL @soc/core
 * validateOptions - never a second implementation - and returns the
 * amplsResourceId message, or null when the combination is valid.
 */
export function amplsIssueFor(options: OperationOptions): string | null {
  const errors = validateOptions(
    OPERATION_OPTION_FIELDS,
    optionsToFormValues(OPERATION_OPTION_FIELDS, options),
  );
  const issue = errors.find((error) => error.key === "amplsResourceId");
  return issue?.message ?? null;
}

// ---------------------------------------------------------------------------
// Counts derivation and the combined summary
// ---------------------------------------------------------------------------

/** Combined per-table counts of a batch run. */
export interface BatchCounts {
  succeeded: number;
  failed: number;
  skipped: number;
  total: number;
}

/**
 * Derive the combined counts from the per-table results (usable mid-run on a
 * partial list too - the parent result persists after every table).
 */
export function deriveBatchCounts(
  tables: readonly OnboardBatchTableResult[],
): BatchCounts {
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  for (const result of tables) {
    if (result.status === "succeeded") {
      succeeded++;
    } else if (result.status === "failed") {
      failed++;
    } else {
      skipped++;
    }
  }
  return { succeeded, failed, skipped, total: tables.length };
}

/**
 * The one-line counts header. templateOnly runs say "templates collected"
 * (nothing deploys on those runs - the fixed legacy defect makes the flag
 * real, so the summary must not claim deployment).
 */
export function formatBatchCountsLine(
  counts: BatchCounts,
  templateOnly: boolean,
): string {
  const verb = templateOnly ? "templates collected" : "deployed";
  return (
    `${counts.succeeded} ${verb}, ${counts.skipped} skipped, ` +
    `${counts.failed} failed (of ${counts.total} table(s))`
  );
}

/**
 * The combined summary block: counts header, the shared DCE line (DCE-mode
 * deploy runs), the collected-template count (templateOnly runs), then one
 * aligned per-table line reusing the step-line format so 'skipped' renders
 * with the same distinct tag everywhere.
 */
export function formatBatchSummary(
  outcome: OnboardBatchOutcome,
  templateOnly: boolean,
): string {
  const lines: string[] = [
    formatBatchCountsLine(deriveBatchCounts(outcome.tables), templateOnly),
  ];
  if (outcome.dce !== null) {
    lines.push(
      `DCE: ${outcome.dce.name} (${outcome.dce.reused ? "reused" : "created"})` +
        ` - ${outcome.dce.logsIngestionEndpoint}` +
        (outcome.dce.amplsAssociated ? " - AMPLS associated" : ""),
    );
  }
  if (templateOnly) {
    lines.push(
      `${outcome.templates.length} ARM request body(ies) collected - ` +
        "download the templates artifact below",
    );
  }
  for (const result of outcome.tables) {
    lines.push(
      formatStepLine({
        name: result.table,
        status: result.status,
        detail: result.detail ?? result.error ?? "",
      }),
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// templateOnly artifact (delivered via the ArtifactSink port by the screen)
// ---------------------------------------------------------------------------

/** ArtifactSink names are bare file names: keep a conservative charset. */
function sanitizeArtifactPart(part: string): string {
  const sanitized = part.replace(/[^A-Za-z0-9._-]/g, "_");
  return sanitized === "" ? "batch" : sanitized;
}

/**
 * The suggested file name of a batch's templateOnly artifact: ONE JSON file
 * for the whole run, keyed by workspace and the parent job id (deterministic
 * - artifacts regenerate from the persisted record, never from a clock).
 */
export function batchTemplatesArtifactName(
  workspaceName: string,
  jobId: string,
): string {
  return (
    `arm-templates-${sanitizeArtifactPart(workspaceName)}` +
    `-${sanitizeArtifactPart(jobId)}.json`
  );
}

/**
 * Serialize the collected ARM request bodies as ONE JSON artifact. Every
 * entry carries what a manual deployment needs (method, ARM path,
 * api-version, body) exactly as the usecase collected it, in collection
 * order. Deterministic: no timestamps, no random ids.
 */
export function buildTemplatesArtifact(
  templates: readonly CollectedArmRequest[],
): string {
  return JSON.stringify(
    {
      kind: "onboard-batch-arm-templates",
      note:
        "Generated by a templateOnly batch run - nothing was deployed. " +
        "Each entry is one ARM request: PUT {path}?api-version={apiVersion} " +
        "with {body}.",
      templates: templates.map((template) => ({
        kind: template.kind,
        table: template.table,
        artifactName: template.artifactName,
        method: template.method,
        path: template.path,
        apiVersion: template.apiVersion,
        body: template.body,
      })),
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Batch records in the RecentRuns list
// ---------------------------------------------------------------------------

/** Read a property of an unknown value, or undefined when not an object. */
function prop(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

/** Tolerant table count from a persisted batch record's input. */
function tableCountOf(job: JobRecord): number | null {
  const tables = prop(job.input, "tables");
  return Array.isArray(tables) ? tables.length : null;
}

/** Whether a persisted batch record ran in templateOnly mode. */
function wasTemplateOnly(job: JobRecord): boolean {
  return prop(prop(job.input, "options"), "templateOnly") === true;
}

/** One-line label for a batch run: when, how many tables, terminal status. */
export function batchRunLabel(job: JobRecord): string {
  const count = tableCountOf(job);
  const what =
    count === null ? "batch" : `batch: ${count} table(s)`;
  const mode = wasTemplateOnly(job) ? " (templateOnly)" : "";
  return `${job.updatedAt}  ${what}${mode}  [${job.status}]`;
}

/**
 * Expanded detail of a persisted batch record: the recorded step lines plus
 * the combined summary (when a result was persisted - partial results
 * survive interruptions) and the error line.
 */
export function batchRunDetail(job: JobRecord): string {
  const lines = job.steps.map(formatStepLine);
  const tables = prop(job.result, "tables");
  if (Array.isArray(tables)) {
    lines.push(
      "",
      formatBatchSummary(
        job.result as OnboardBatchOutcome,
        wasTemplateOnly(job),
      ),
    );
  }
  if (job.error !== undefined) {
    lines.push("", `error: ${job.error}`);
  }
  return lines.join("\n");
}
