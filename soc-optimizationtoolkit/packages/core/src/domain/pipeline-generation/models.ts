/**
 * pipeline-generation MODELS - porting-plan Unit 17, task item (a).
 *
 * The PipelinePlan is the digest's central redesign: the legacy scaffold mutated
 * `options.tables[i].fields`, `.sourcetypeFilter`, and a table-keyed
 * `tableOverflowConfigs` map through ~eight competing branches, then handed the
 * mutated array to `generatePipelineConf`. Here those branches are reified into
 * ONE pure planner (see plan.ts) that produces an EXPLICIT, typed
 * {@link PipelinePlan}. Every downstream emitter (generatePipelineConf,
 * generateRouteYml, the reduction pipelines) reads the plan - it is the single
 * source of truth, and no emitter re-derives fields.
 *
 * BOUNDARY (porting-plan Unit 17 depends-on note): the planner TAKES already
 * computed results as TYPED INPUTS and does NOT call subsystems. The field
 * MatchResult (Unit 13), the DcrGapAnalysis + TableRoutingInfo (Unit 18), and
 * the optional vendor mappings (Unit 15, deferred - empty for MVP) are inputs,
 * never calls. Sample format is likewise an input (the caller ran Unit 11).
 *
 * Pure data: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

import type { MatchResult, OverflowConfig, VendorMapping } from "../field-matcher";
import type { DcrGapAnalysis, TableRoutingInfo } from "../gap-analysis";
import type { TableReductionRules } from "./reduction-rules";

/**
 * One resolved source-to-destination field decision the pipeline emits. Verbatim
 * shape from legacy pack-builder FieldMapping (source/target/type/action).
 */
export interface PipelineFieldMapping {
  source: string;
  target: string;
  type: string;
  /** "decode" (2026-07-09): base64-decode source into target (see MatchAction). */
  action: "rename" | "keep" | "coerce" | "drop" | "decode";
}

/** A user override for one field (highest planner priority). */
export interface FieldMappingOverride {
  source: string;
  dest: string;
  sourceType: string;
  destType: string;
  confidence: string;
  action: string;
  needsCoercion: boolean;
  description: string;
  sampleValue?: string;
}

/**
 * Which planner branch resolved a table's fields. Surfaced on the plan (the
 * Unit 15 provenance precedent: never resolve silently) so the review UI and
 * tests can see WHY a plan looks the way it does.
 */
export type PlanProvenance =
  | "user-override"
  | "dcr-gap"
  | "field-match"
  | "passthrough"
  | "preset-fields"
  | "empty";

/**
 * The typed inputs for ONE table+logType entry. Everything is already computed
 * by the caller; the planner only reconciles them. For a multi-logType single
 * table (Cloudflare HTTP/WAF/DNS -> CloudflareV2_CL) the caller supplies one
 * entry PER logType, each with its OWN matchResult/overflow/format - which is
 * exactly how the table-keyed-overflow collision is resolved (see plan.ts).
 */
export interface TablePlanInput {
  /** Destination Sentinel table (e.g. "CommonSecurityLog", "Cloudflare_CL"). */
  sentinelTable: string;
  /** Per-logType label (e.g. "HTTP", "WAF"); defaults to the table name. */
  logType?: string;
  /**
   * The field matcher's result (Unit 13), already computed. Drives fields +
   * overflow config when no user override / DCR-gap branch wins.
   */
  matchResult?: MatchResult;
  /**
   * The DCR gap analysis (Unit 18), already computed. When the DCR performs real
   * transforms, the plan uses `criblMustHandle` so Cribl never duplicates DCR
   * work.
   */
  gap?: DcrGapAnalysis;
  /** Routing info (Unit 18); its routeCondition becomes the route filter. */
  routing?: TableRoutingInfo;
  /** Vendor mappings (Unit 15, deferred). Empty/undefined for MVP. */
  vendorMappings?: VendorMapping[];
  /**
   * Sample format detected by the caller (Unit 11): cef | leef | csv | kv | json
   * | ndjson | syslog. Drives serde selection + timestamp logic. Defaults json.
   */
  sourceFormat?: string;
  /**
   * Raw source fields for the passthrough branch (used only when no match and no
   * schema were available - keep everything as-is).
   */
  passthroughFields?: Array<{ name: string; type: string; sampleValue?: string }>;
  /** Pre-supplied field mappings (a caller that already decided). */
  presetFields?: PipelineFieldMapping[];
  /** User overrides for this logType (highest priority). */
  fieldOverrides?: FieldMappingOverride[];
  /**
   * Explicit reduction rules for this table. When omitted, the planner looks
   * them up via findReductionRules against (sentinelTable, solutionName) - that
   * lookup lives in THIS unit, so it is not a cross-subsystem call.
   */
  reductionRules?: TableReductionRules | null;
}

/** The fully resolved plan for one table+logType - what emitters read. */
export interface TablePlan {
  sentinelTable: string;
  logType: string;
  /** The single per-log-type suffix (see naming.pipelineSuffix). */
  suffix: string;
  /** `{vendorPrefix}_{suffix}` - transformation pipeline id/dir. */
  pipelineName: string;
  /** `Reduction_{vendorPrefix}_{suffix}` - reduction pipeline id/dir. */
  reductionPipelineId: string;
  /** `MS-Sentinel-{Table}-dest`. */
  destinationId: string;
  /** `Custom-{Table}`. */
  streamName: string;
  /** Resolved field decisions. */
  fields: PipelineFieldMapping[];
  /** This entry's OWN overflow config (never shared across logTypes). */
  overflowConfig: OverflowConfig;
  /** Source format for serde/timestamp. */
  sourceFormat: string;
  /** Route filter expression (routing.routeCondition or "true"). */
  routeCondition: string;
  /** Vendor mappings passed through to the emitter (empty for MVP). */
  vendorMappings?: VendorMapping[];
  /** Reduction rules for this table (null when none matched). */
  reductionRules: TableReductionRules | null;
  /** Which branch produced `fields`. */
  provenance: PlanProvenance;
}

/** Pack-level plan: the single source of truth downstream emitters read. */
export interface PipelinePlan {
  solutionName: string;
  packName: string;
  version: string;
  vendorPrefix: string;
  tables: TablePlan[];
}

/** The whole-pack planner input. */
export interface BuildPipelinePlanInput {
  solutionName: string;
  packName: string;
  version?: string;
  tables: TablePlanInput[];
}
