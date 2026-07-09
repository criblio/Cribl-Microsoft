/**
 * Pipeline-preview state - the PURE projection behind the Integrate flow's
 * PIPELINE PREVIEW panel (porting-plan Unit 17 UI: "pipeline preview panel -
 * generated conf.yml per log type, reduction rules with reasons").
 *
 * Unit 17's generation engine is PURE and lives entirely in @soc/core
 * (buildPipelinePlan + the conf/route emitters + checkCriblYaml). This module
 * owns ZERO generation logic: it TAKES the already-computed typed results the
 * Integrate flow already has - the {@link GapReport}s from the Unit 18 DCR Gap
 * Analysis section plus the reviewer's effective (edited) mappings - and
 * PROJECTS them into a read-only preview view. The projection:
 *
 *   1. composes one {@link TablePlanInput} per approved gap report (the resolved
 *      mapping rows become `presetFields`; the report's mirrored route condition
 *      becomes `routing.routeCondition`; the sample's detected format drives
 *      serde/timestamp), then calls the core planner once;
 *   2. emits, per resolved {@link TablePlan}, the transform-only conf.yml and the
 *      self-contained reduction conf.yml via the core emitters, plus the
 *      pack-level route.yml;
 *   3. surfaces the reduction rules (keep/drop/suppress) WITH their reasons for
 *      display - straight off the plan's reductionRules (the reduction KB reason
 *      strings are display content);
 *   4. runs the core {@link checkCriblYaml} validator over every emitted YAML and
 *      surfaces any issues HONESTLY (task item 3): a well-formed plan produces
 *      zero issues, so a non-empty list is the honest "something is off" signal.
 *
 * BOUNDARY (Unit 17 depends-on note): this consumes typed results; it never calls
 * the field matcher, gap analysis, or vendor research. The only core functions it
 * invokes are the pure Unit 17 generators over inputs already in hand.
 *
 * DEPLOY-GATE PARTITION: this is a READ-ONLY preview. It reports no readiness and
 * never touches canDeploy / canDeployContentPath. The `approved` input it takes
 * is the mapping-review section's OWN content-path gate (deriveMappingReviewGate
 * .ready), surfaced so the preview mirrors what a content-path build would emit;
 * it is consumed, not produced, here.
 *
 * Pure: no IO, no fetch, no React, no Date, no crypto, no Math.random.
 */

import {
  buildPipelinePlan,
  checkCriblYaml,
  generatePipelineConfForPlan,
  generateReductionConfForPlan,
  generateRouteYml,
} from "@soc/core";
import type {
  GapFieldMapping,
  GapReport,
  PipelineFieldMapping,
  PipelinePlan,
  PlanProvenance,
  TablePlan,
  TablePlanInput,
} from "@soc/core";

// ---------------------------------------------------------------------------
// Empty-state reasons (the always-visible-disabled panel copy)
// ---------------------------------------------------------------------------

/** No tagged samples yet - there is nothing to generate a pipeline from. */
export const PIPELINE_PREVIEW_NO_SAMPLES_REASON =
  "Tag at least one sample in the Sample Data section - the generated pipeline " +
  "is built from your samples and their destination mappings.";

/** Samples exist but the gap analysis has not produced any mappings yet. */
export const PIPELINE_PREVIEW_NO_REPORTS_REASON =
  "Run the DCR Gap Analysis above to map your sample fields to a Sentinel " +
  "table - the pipeline preview renders once there are mappings to generate.";

/** Mappings exist but are not approved (or are stale) - preview the deploy set. */
export const PIPELINE_PREVIEW_NOT_APPROVED_REASON =
  "Approve the table mappings in the DCR Gap Analysis section above. The " +
  "preview shows the exact pipeline a content-driven build would generate from " +
  "the approved mappings.";

// ---------------------------------------------------------------------------
// View types
// ---------------------------------------------------------------------------

/** One reduction rule projected for display (rule + its human-readable reason). */
export interface ReductionRuleView {
  kind: "keep" | "drop" | "suppress";
  id: string;
  description: string;
  filter: string;
  reason: string;
  /** Suppress-only: the group key expression. */
  groupKey?: string;
  /** Suppress-only: the window length in seconds. */
  windowSec?: number;
  /** Suppress-only: max events allowed per group per window (defaults to 1). */
  maxEvents?: number;
}

/** One parsed pipeline function line, for a readable ordered rendering. */
export interface PipelineFunctionLine {
  /** 1-based position in the pipeline (the execution order). */
  index: number;
  /** The Cribl function id (eval, serde, rename, drop, suppress, ...). */
  id: string;
  /** The function's group (extract / reduce / rename / enrich / cleanup). */
  groupId?: string;
  /** The function's description line. */
  description?: string;
}

/** The full read-only preview for ONE resolved table + log type. */
export interface PipelinePreviewTable {
  logType: string;
  tableName: string;
  pipelineName: string;
  reductionPipelineId: string;
  destinationId: string;
  streamName: string;
  sourceFormat: string;
  routeCondition: string;
  provenance: PlanProvenance;
  /** How many field decisions the plan resolved for this table. */
  fieldCount: number;
  /** The transform-only conf.yml (rendered verbatim in a <pre>). */
  transformConf: string;
  /** The self-contained reduction conf.yml (transform + reduce group). */
  reductionConf: string;
  /** Whether reduction rules matched (drives the reduction route's enablement). */
  hasReductionRules: boolean;
  /** The transform pipeline's functions, in execution order (readable list). */
  functions: PipelineFunctionLine[];
  /** The reduction rules with reasons (keep, then drop, then suppress). */
  reductionRules: ReductionRuleView[];
  /** checkCriblYaml issues over this table's transform + reduction conf. */
  yamlIssues: string[];
}

/** The inputs the Integrate flow hands the preview projection. */
export interface PipelinePreviewInputs {
  solutionName: string;
  packName: string;
  version?: string;
  /** The Unit 18 gap reports (typed input, already computed). */
  reports: GapReport[];
  /**
   * The reviewer's effective (edited) mappings keyed by logType. When a logType
   * has an entry it OVERRIDES the report's baseline fieldMappings, so the preview
   * reflects hand edits; absent, the report's mappings are used verbatim.
   */
  mappingOverrides?: Readonly<Record<string, GapFieldMapping[]>>;
  /** Detected sample format keyed by logType (drives serde/timestamp). */
  sampleFormats?: Readonly<Record<string, string>>;
  /**
   * User-added enrichment constants keyed by logType (ALREADY merged global +
   * per-table by the caller). Each becomes an Eval add in the pipeline.
   */
  enrichments?: Readonly<Record<string, readonly EnrichmentField[]>>;
  /**
   * The mapping-review content-path gate (deriveMappingReviewGate().ready): every
   * table-with-mappings approved and not stale. The preview renders its tables
   * only when this is true (else the always-visible-disabled empty state).
   */
  approved: boolean;
}

/** The whole preview view the panel renders. */
export interface PipelinePreviewView {
  /** A generated plan exists and is approved - render the tables. */
  available: boolean;
  /** Why the panel is empty (null when available). */
  emptyReason: string | null;
  /** The resolved plan (null when not available). */
  plan: PipelinePlan | null;
  /** One entry per resolved table+logType. */
  tables: PipelinePreviewTable[];
  /** The pack-level route.yml (empty string when not available). */
  routeYml: string;
  /** checkCriblYaml issues over route.yml. */
  routeYmlIssues: string[];
  /** Total checkCriblYaml issues across every emitted YAML (0 = clean). */
  totalYamlIssues: number;
  /** Every emitted YAML passed the Cribl validator (the honest green signal). */
  valid: boolean;
}

// ---------------------------------------------------------------------------
// Projection helpers
// ---------------------------------------------------------------------------

/** Normalize a detected sample format to a plan serde format (unknown -> json). */
export function normalizeSourceFormat(format: string | undefined): string {
  if (format === undefined || format === "" || format === "unknown") {
    return "json";
  }
  return format;
}

/**
 * The effective mapping rows for a report: the reviewer's edits when present,
 * otherwise the report's own mappings (mirrors mapping-review effectiveMappings).
 */
export function effectiveReportMappings(
  report: GapReport,
  overrides?: Readonly<Record<string, GapFieldMapping[]>>,
): GapFieldMapping[] {
  return overrides?.[report.logType] ?? report.fieldMappings;
}

/**
 * Map one resolved gap mapping row to a pipeline preset field. The reviewer's
 * table already decided the disposition, so these are handed to the planner as
 * `presetFields` (provenance "preset-fields"). `overflow` becomes `drop`, exactly
 * as the planner collapses it for user overrides.
 */
export function gapMappingToPreset(m: GapFieldMapping): PipelineFieldMapping {
  const action: PipelineFieldMapping["action"] =
    m.action === "overflow"
      ? "drop"
      : (m.action as PipelineFieldMapping["action"]);
  return { source: m.source, target: m.dest, type: m.destType, action };
}

/**
 * A user-added ENRICHMENT: a field the source does not carry that the Cribl
 * pipeline adds as a constant (e.g. DeviceVendor = "Palo Alto Networks" for a
 * PAN-OS feed - Sentinel content keys on it, but the raw logs never carry it).
 */
export interface EnrichmentField {
  field: string;
  value: string;
}

/** A safe Cribl Eval field name (letters/digits/underscore, no leading digit). */
export function isValidEnrichmentFieldName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/**
 * Merge global enrichments with one table's own: the table's entry WINS on a
 * field-name collision; order is global-first, per-table appended.
 */
export function mergeEnrichments(
  global: readonly EnrichmentField[],
  perTable: readonly EnrichmentField[],
): EnrichmentField[] {
  const byField = new Map<string, EnrichmentField>();
  for (const e of global) byField.set(e.field, e);
  for (const e of perTable) byField.set(e.field, e);
  return [...byField.values()];
}

/** Compose ONE typed planner input from a gap report + the reviewer's edits. */
export function reportToPlanInput(
  report: GapReport,
  overrides?: Readonly<Record<string, GapFieldMapping[]>>,
  sampleFormats?: Readonly<Record<string, string>>,
  enrichments?: readonly EnrichmentField[],
): TablePlanInput {
  const mappings = effectiveReportMappings(report, overrides);
  return {
    sentinelTable: report.tableName,
    logType: report.logType,
    presetFields: mappings.map(gapMappingToPreset),
    sourceFormat: normalizeSourceFormat(sampleFormats?.[report.logType]),
    // User-added constants ride the planner's vendorMappings channel: the
    // conf emitter's enrich branch turns each into an Eval add of
    // `destName = '<description>'` (the Unit 15 shape, user-supplied here).
    ...(enrichments !== undefined && enrichments.length > 0
      ? {
          vendorMappings: enrichments.map((e) => ({
            sourceName: e.field,
            destName: e.field,
            sourceType: "string",
            destType: "string",
            action: "enrich",
            description: e.value,
          })),
        }
      : {}),
    // The report mirrors the Cribl route condition; feed it as routing so the
    // emitted route.yml filter matches what the gap analysis showed.
    routing: {
      tableName: report.tableName,
      outputStream: "",
      routeCondition: report.routeCondition,
      eventSimpleNames: [],
      columns: [],
      typeConversions: [],
    },
  };
}

/**
 * Parse the readable ordered function list out of an emitted conf.yml. Each
 * pipeline function is a `  - id: <fn>` entry (two-space indent under
 * `functions:`); its `    groupId:` and `    description:` follow at four-space
 * indent. Nested `conf:` entries (`- name:` at six-plus spaces) are ignored.
 */
export function pipelineFunctionLines(conf: string): PipelineFunctionLine[] {
  const lines = conf.split("\n");
  const out: PipelineFunctionLine[] = [];
  let index = 0;
  for (const line of lines) {
    const idMatch = /^ {2}- id: (\S+)/.exec(line);
    if (idMatch) {
      index += 1;
      out.push({ index, id: idMatch[1] });
      continue;
    }
    const current = out[out.length - 1];
    if (current === undefined) {
      continue;
    }
    const groupMatch = /^ {4}groupId: (\S+)/.exec(line);
    if (groupMatch && current.groupId === undefined) {
      current.groupId = groupMatch[1];
      continue;
    }
    const descMatch = /^ {4}description: (.+)/.exec(line);
    if (descMatch && current.description === undefined) {
      current.description = descMatch[1];
    }
  }
  return out;
}

/**
 * Project a resolved table's reduction rules into display views (keep, then
 * drop, then suppress), preserving each rule's reason string verbatim.
 */
export function reductionRuleViews(table: TablePlan): ReductionRuleView[] {
  const rules = table.reductionRules;
  if (rules === null) {
    return [];
  }
  const views: ReductionRuleView[] = [];
  for (const r of rules.keep) {
    views.push({
      kind: "keep",
      id: r.id,
      description: r.description,
      filter: r.filter,
      reason: r.reason,
    });
  }
  for (const r of rules.drop) {
    views.push({
      kind: "drop",
      id: r.id,
      description: r.description,
      filter: r.filter,
      reason: r.reason,
    });
  }
  for (const r of rules.suppress) {
    views.push({
      kind: "suppress",
      id: r.id,
      description: r.description,
      filter: r.filter,
      reason: r.reason,
      groupKey: r.groupKey,
      windowSec: r.windowSec,
      maxEvents: r.maxEvents ?? 1,
    });
  }
  return views;
}

/**
 * The empty-state reason (or null when the panel can render). Ordered so the
 * operator sees the NEXT thing to do: samples -> mappings -> approval.
 */
export function pipelinePreviewEmptyReason(
  inputs: PipelinePreviewInputs,
): string | null {
  const withMappings = inputs.reports.filter(
    (r) => effectiveReportMappings(r, inputs.mappingOverrides).length > 0,
  );
  if (inputs.reports.length === 0) {
    return PIPELINE_PREVIEW_NO_SAMPLES_REASON;
  }
  if (withMappings.length === 0) {
    return PIPELINE_PREVIEW_NO_REPORTS_REASON;
  }
  if (!inputs.approved) {
    return PIPELINE_PREVIEW_NOT_APPROVED_REASON;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The main projection
// ---------------------------------------------------------------------------

/**
 * Derive the full read-only pipeline preview from the typed Integrate-flow
 * inputs. Builds the plan once via the core planner, emits every conf.yml +
 * route.yml, and validates them with checkCriblYaml. Returns the empty view
 * (with a reason) when there is nothing approved to preview.
 */
export function derivePipelinePreview(
  inputs: PipelinePreviewInputs,
): PipelinePreviewView {
  const emptyReason = pipelinePreviewEmptyReason(inputs);
  if (emptyReason !== null) {
    return {
      available: false,
      emptyReason,
      plan: null,
      tables: [],
      routeYml: "",
      routeYmlIssues: [],
      totalYamlIssues: 0,
      valid: true,
    };
  }

  // Only tables that actually have mappings become plan entries.
  const planTables = inputs.reports.filter(
    (r) => effectiveReportMappings(r, inputs.mappingOverrides).length > 0,
  );
  const plan = buildPipelinePlan({
    solutionName: inputs.solutionName,
    packName: inputs.packName,
    ...(inputs.version !== undefined ? { version: inputs.version } : {}),
    tables: planTables.map((r) =>
      reportToPlanInput(
        r,
        inputs.mappingOverrides,
        inputs.sampleFormats,
        inputs.enrichments?.[r.logType],
      ),
    ),
  });

  let totalYamlIssues = 0;
  const tables: PipelinePreviewTable[] = plan.tables.map((table) => {
    const transformConf = generatePipelineConfForPlan(table, plan.solutionName);
    const reductionConf = generateReductionConfForPlan(table, plan.solutionName);
    const yamlIssues = [
      ...checkCriblYaml(transformConf, `${table.pipelineName}/conf.yml`),
      ...checkCriblYaml(
        reductionConf,
        `${table.reductionPipelineId}/conf.yml`,
      ),
    ];
    totalYamlIssues += yamlIssues.length;
    return {
      logType: table.logType,
      tableName: table.sentinelTable,
      pipelineName: table.pipelineName,
      reductionPipelineId: table.reductionPipelineId,
      destinationId: table.destinationId,
      streamName: table.streamName,
      sourceFormat: table.sourceFormat,
      routeCondition: table.routeCondition,
      provenance: table.provenance,
      fieldCount: table.fields.length,
      transformConf,
      reductionConf,
      hasReductionRules: table.reductionRules !== null,
      functions: pipelineFunctionLines(transformConf),
      reductionRules: reductionRuleViews(table),
      yamlIssues,
    };
  });

  const routeYml = generateRouteYml(plan);
  const routeYmlIssues = checkCriblYaml(routeYml, "route.yml");
  totalYamlIssues += routeYmlIssues.length;

  return {
    available: true,
    emptyReason: null,
    plan,
    tables,
    routeYml,
    routeYmlIssues,
    totalYamlIssues,
    valid: totalYamlIssues === 0,
  };
}
