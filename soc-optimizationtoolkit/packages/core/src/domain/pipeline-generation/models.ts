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

import type { CefIdentityOverride } from "../cef-identity";
import type { MatchResult, OverflowConfig, VendorMapping } from "../field-matcher";
import type { DcrGapAnalysis, TableRoutingInfo } from "../gap-analysis";
import type { TableReductionRules } from "./reduction-rules";
import type { LogTypeFieldValues } from "./route-value-discriminator";

/**
 * One resolved source-to-destination field decision the pipeline emits. Verbatim
 * shape from legacy pack-builder FieldMapping (source/target/type/action).
 */
export interface PipelineFieldMapping {
  source: string;
  target: string;
  type: string;
  /**
   * "decode" (2026-07-09): base64-decode source into target (see MatchAction).
   * "overflow" vs "drop" (2026-07-13 live fix): OVERFLOW fields are folded
   * into the catch-all column by the serialize step; DROP fields are removed
   * outright - excluded from the serialize AND listed in the cleanup remove.
   * The legacy collapsed both to "drop", which shipped reviewer-dropped
   * fields inside AdditionalExtensions.
   */
  action: "rename" | "keep" | "coerce" | "drop" | "decode" | "overflow";
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
  /**
   * Observed field VALUES from this log type's samples, for route filters.
   *
   * Field PRESENCE cannot separate log types that share one schema and differ
   * by a value - Zscaler action ALLOWED/BLOCKED, Palo Alto type TRAFFIC/THREAT
   * - so those all fall back to match-all, and since routes are final only the
   * first one receives events. Supplying this lets the planner find the
   * discriminator column instead. Optional: without it the planner behaves
   * exactly as before, and the unreachable log types are reported rather than
   * silently mis-routed.
   */
  sampleFieldValues?: LogTypeFieldValues;
  /** Vendor mappings (Unit 15, deferred). Empty/undefined for MVP. */
  vendorMappings?: VendorMapping[];
  /**
   * Corrected DeviceVendor / DeviceProduct for CEF content.
   *
   * NOT the same lever as an enrichment constant, and the difference is
   * PLACEMENT. An enrichment Eval runs late, after the reduction rules have
   * already filtered on the vendor's own value; this override is emitted right
   * after CEF extraction, so reduction, renames and the destination all see the
   * corrected identity. A vendor string that does not match what a solution's
   * analytic rules compare against deploys and ingests cleanly and never fires a
   * rule, so getting it right early is the whole point.
   */
  identityOverride?: CefIdentityOverride;
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
  /** Corrected DeviceVendor / DeviceProduct, carried to the emitter. */
  identityOverride?: CefIdentityOverride;
  /** Reduction rules for this table (null when none matched). */
  reductionRules: TableReductionRules | null;
  /** Which branch produced `fields`. */
  provenance: PlanProvenance;
}

/** Pack-level plan: the single source of truth downstream emitters read. */
export interface PipelinePlan {
  solutionName: string;
  packName: string;
  /**
   * The PACK's version: highest-installed-plus-one. It counts rebuilds, so it
   * says nothing about what built the pack - see {@link toolkitVersion}.
   */
  version: string;
  vendorPrefix: string;
  tables: TablePlan[];
  /**
   * Version of the toolkit that BUILT this pack, stamped into the manifest's
   * `author` (GEN-3). Optional because core cannot read it - the shell owns
   * `__APP_VERSION__` and injects it - and because an air-gapped or test build
   * that omits it must still produce a valid manifest.
   *
   * Omitted renders the bare legacy author string, so a pack built without it
   * is honestly silent rather than claiming a version it does not know.
   */
  toolkitVersion?: string;
  /**
   * How the pack is WIRED - the operator's choice, not a detail (GEN-13).
   *
   * Omitted means "all-inclusive", which is what every pack built before
   * 2026-09-04 was and what an existing build record replays as.
   */
  packShape?: PackShape;
}

/**
 * The two shapes a generated pack can take. They differ in exactly two files,
 * and the difference decides WHERE THE OPERATOR CAN USE THE PACK.
 *
 * Reported, then diffed against a known-good pack the user supplied
 * (HelloPacks_1.0.0.crbl): an app-built pack could not be selected from the
 * Routes page pipeline dropdown in the Cribl UI. The cause is structural, not a
 * naming or install fault, so no amount of reinstalling changes it.
 *
 *   "all-inclusive" - every route carries `output: <destinationId>` and the
 *     pack ships `default/outputs.yml`. The pack is self-contained: the Sentinel
 *     destination and its secret live inside it and nothing has to exist at
 *     group level. Cribl will NOT offer such a pack in the group's Routes page
 *     pipeline dropdown. This is what the guided deploy wires, and the default.
 *
 *   "routable" - every route carries `output: default` and NO outputs.yml is
 *     written, which is exactly what HelloPacks does. The pack IS offered in
 *     that dropdown and can be dropped into a flow the operator already has.
 *     The cost is theirs to accept: the Sentinel destination and its secret must
 *     ALREADY EXIST in the worker group, because the pack no longer carries them.
 *
 * WHAT ACTUALLY GATES THE DROPDOWN, established live 2026-09-04 by the operator
 * and NOT what the first version of this comment claimed. The first draft said
 * the route's `output:` was the gate. IT IS NOT:
 *   - the operator set the pack route's destination to Cribl's own "Send to
 *     Worker Group Routes" option - the UI form of `output: default` - and the
 *     pack STILL did not appear;
 *   - they then DELETED the Sentinel destination from the pack, and it appeared
 *     immediately.
 * So the gate is the EXISTENCE OF A CONFIGURED DESTINATION inside the pack, and
 * the route's output does not move it. Their read - that "Send to Worker Group
 * Routes" is buggy - looks right: Cribl offers a setting meaning "hand events
 * back to the group" and still withholds the pack from the group's dropdown
 * while a destination object remains.
 *
 * BOTH FILES STILL CHANGE TOGETHER, for a different reason than first written.
 * Dropping outputs.yml is what earns the dropdown entry; setting `output:
 * default` is the necessary companion, because a route left naming a
 * destination that no longer ships would dangle.
 *
 * NEITHER IS RIGHT IN GENERAL, which is why this is a choice rather than a fix.
 * Self-contained is right for "install this and it works"; routable is right for
 * "I already have a flow and I want this in the middle of it".
 */
export type PackShape = "all-inclusive" | "routable";

/** The whole-pack planner input. */
export interface BuildPipelinePlanInput {
  solutionName: string;
  packName: string;
  version?: string;
  tables: TablePlanInput[];
  /** See {@link PipelinePlan.toolkitVersion}. Injected by the shell. */
  toolkitVersion?: string;
  /** See {@link PipelinePlan.packShape}. Chosen by the operator at build time. */
  packShape?: PackShape;
}
