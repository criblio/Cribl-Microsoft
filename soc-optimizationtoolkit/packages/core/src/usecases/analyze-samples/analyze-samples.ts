/**
 * analyzeSamples usecase - the crown-jewel gap-analysis engine (porting-plan
 * Unit 18, ENG-12). Ported from legacy pack-builder.ts `pack:analyze-samples`
 * (2991-3174), re-expressed as a PURE core usecase over the ports.
 *
 * It COMPOSES four subsystems, one per Unit:
 *   - the sample parser (Unit 11, parseSampleContent)         source fields
 *   - the SchemaCatalog port (Unit 13)                        destination schema
 *   - the field matcher (Unit 13, matchParsedSampleToColumns) user-facing counts
 *   - the SentinelContent port (Unit 14) + kql-parser         DCR-side flow
 * ...and folds the two engines into the typed six-tile {@link GapReport}
 * (buildGapReport) - the dual-engine split the unit formalizes.
 *
 * CHUNKED PER TABLE (task item 3): this is an async GENERATOR that yields one
 * typed GapReport per table. Each `yield` is a natural await boundary, so a UI
 * driving the generator renders each table's card as it arrives and stays
 * responsive across many tables - it never blocks on a single monolithic
 * analyze call the way the legacy IPC did. {@link collectGapReports} is the
 * collect-all convenience for callers (and tests) that want the full array.
 *
 * GRACEFUL DEGRADATION: an unreachable solution, a missing DCR file, or an
 * unresolved schema never throws - the report for that table falls back to a
 * synthetic no-op DCR flow and/or an all-unmatched match result (with the
 * matcher's no-schema warning), exactly as the legacy handler degraded.
 *
 * Pure orchestration over the ports: no IO of its own, no fetch, no React, no
 * Date/crypto. The IO lives entirely behind the injected SentinelContent /
 * SchemaCatalog adapters.
 */

import { parseSampleContent } from "../../domain/sample-parsing/index";
import { matchSolutionName } from "../../domain/sample-acquisition/index";
import {
  deriveCustomTableSchema,
  matchParsedSampleToColumns,
  parsedSampleToSourceFields,
} from "../../domain/field-matcher/index";
import type { VendorMapping } from "../../domain/field-matcher/index";
import { isCustomTableName } from "../../domain/custom-table/index";
import {
  analyzeDcrGap,
  buildGapReport,
  generateRouteCondition,
  parseDcrJson,
  DEFAULT_GAP_PROFILE,
} from "../../domain/gap-analysis/index";
import type {
  DcrFlow,
  FieldRef,
  GapReport,
  VendorGapProfile,
} from "../../domain/gap-analysis/index";
import type { SentinelContent } from "../../ports/sentinel-content";
import type { DcrSchemaColumn, SchemaCatalog } from "../../ports/schema-catalog";
import type { Logger } from "../../ports/logger";

/** The ports {@link analyzeSamples} orchestrates. */
export interface AnalyzeSamplesPorts {
  /** Reads Sentinel content lazily (to find the solution's DCR flows). */
  content: SentinelContent;
  /** Resolves a table name to its destination column set. */
  catalog: SchemaCatalog;
  /** Optional diagnostics (absent = no-op). */
  logger?: Logger;
}

/** One sample to analyze against its destination table. */
export interface AnalyzeSampleSpec {
  /** The user's log-type label (the review card's title + key). */
  logType: string;
  /** The destination Sentinel table this sample onboards to. */
  tableName: string;
  /**
   * The raw sample text (events joined by newlines, a paste, or a capture).
   * Parsed via the Unit 11 parser - format is detected from the content.
   */
  content: string;
}

/** Input for {@link analyzeSamples}. */
export interface AnalyzeSamplesInput {
  /** The Sentinel solution whose DCR defines the routing/renames/coercions. */
  solutionName: string;
  /** The samples to analyze, one report yielded per entry (in order). */
  samples: readonly AnalyzeSampleSpec[];
  /** Vendor quirks (FDR common-field injection, _time enrichment). */
  vendorProfile?: VendorGapProfile;
  /** Optional Phase-0 vendor field-mapping overrides for the matcher. */
  vendorMappings?: VendorMapping[];
  /**
   * Pre-resolved DCR flows (from resolveSampleRouting). Supplying them skips
   * the second resolveSolutionDcrFlows fetch pass - the routing usecase and
   * this one otherwise each read every DCR file per analysis.
   */
  dcrFlows?: ReadonlyMap<string, DcrFlow>;
  /**
   * Column names (CANONICAL casing) the solution's analytics rules and
   * workbooks reference (ContentRequirements.columnNames values). Consumed
   * ONLY when a custom _CL destination resolves no schema anywhere: the
   * derived schema then includes these columns so the created table
   * accommodates the content (see deriveCustomTableSchema).
   */
  contentColumnNames?: readonly string[];
}

/** Build the DCR flow to use when the solution has no DCR for a table. */
function syntheticFlow(tableName: string, destSchema: FieldRef[]): DcrFlow {
  return {
    outputStream: `Custom-${tableName}`,
    tableName,
    eventSimpleNames: [],
    renames: [],
    typeConversions: [],
    columns: destSchema,
  };
}

/**
 * Resolve every DCR dataFlow the solution defines, keyed by lowercased table
 * name. Mirrors the legacy fuzzy solution match + connector DCR-file scan, over
 * the SentinelContent port. Degrades to an empty map (never throws) - a table
 * with no flow falls back to a synthetic no-op flow at report time.
 */
/** One-line error text (mirrors acquire-samples' errText). */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Bound on DCR files read per analysis (Zscaler ships 15 CCP bundles). */
const DCR_FILE_READ_CAP = 30;

export async function resolveSolutionDcrFlows(
  content: SentinelContent,
  solutionName: string,
  profile: VendorGapProfile,
  logger?: Logger,
): Promise<Map<string, DcrFlow>> {
  const flowsByTable = new Map<string, DcrFlow>();
  try {
    const solutions = await content.listSolutions();
    // The ONE fuzzy solution-name matcher (sample-acquisition consolidated
    // the legacy's three copies; this was a fourth inline fork).
    const match = solutions.find((s) => matchSolutionName(s.name, solutionName));
    if (!match) {
      logger?.info("analyze-samples: no matching solution", {
        solution: solutionName,
      });
      return flowsByTable;
    }

    const connectors = await content.listConnectorFiles(match.name);
    const dcrFiles = connectors
      .filter(
        (f) =>
          f.name.toLowerCase().includes("dcr") &&
          f.name.toLowerCase().endsWith(".json"),
      )
      .slice(0, DCR_FILE_READ_CAP);
    for (const dcrFile of dcrFiles) {
      const text = await content.readFile(dcrFile.path);
      if (!text) continue;
      try {
        const parsed = parseDcrJson(text, profile);
        for (const flow of parsed.flows) {
          const key = flow.tableName.toLowerCase();
          if (!flowsByTable.has(key)) flowsByTable.set(key, flow);
        }
      } catch (err) {
        logger?.warn("analyze-samples: failed to parse DCR JSON", {
          file: dcrFile.name,
          error: errText(err),
        });
      }
    }
  } catch (err) {
    logger?.warn("analyze-samples: solution DCR lookup failed", {
      solution: solutionName,
      error: errText(err),
    });
  }
  return flowsByTable;
}

/**
 * Analyze each sample against its destination table, YIELDING a typed
 * {@link GapReport} per table (chunked so a UI stays responsive).
 */
export async function* analyzeSamples(
  ports: AnalyzeSamplesPorts,
  input: AnalyzeSamplesInput,
): AsyncGenerator<GapReport> {
  const profile = input.vendorProfile ?? DEFAULT_GAP_PROFILE;
  const flowsByTable =
    input.dcrFlows ??
    (await resolveSolutionDcrFlows(
      ports.content,
      input.solutionName,
      profile,
      ports.logger,
    ));

  for (const sample of input.samples) {
    const parsed = parseSampleContent(sample.content, {
      sourceName: sample.logType,
    });

    let columns: DcrSchemaColumn[] | null = null;
    try {
      columns = await ports.catalog.resolveSchema(sample.tableName);
    } catch (err) {
      ports.logger?.warn("analyze-samples: schema resolution failed", {
        table: sample.tableName,
        error: errText(err),
      });
    }

    // DERIVED SCHEMA (user use case 2026-07-14): a custom _CL destination
    // with no schema ANYWHERE (not live, not in the solution's connector
    // JSONs, not bundled - e.g. a CCF solution whose table only materializes
    // when Microsoft's connector is enabled) is not a dead end: the sample
    // itself defines the table, seeded with the columns the solution's rules
    // and workbooks reference so the created table accommodates the content.
    // The derived columns flow through the SAME matcher/report/deploy path
    // as a resolved schema (the Integrate deploy passes destSchema as
    // onboardTable's customSchema, so deploying CREATES this table).
    let schemaDerivation;
    if (
      (columns === null || columns.length === 0) &&
      isCustomTableName(sample.tableName)
    ) {
      const derived = deriveCustomTableSchema(
        parsed,
        input.contentColumnNames ?? [],
      );
      columns = derived.columns;
      schemaDerivation = { summary: derived.summary, notes: derived.notes };
      ports.logger?.info("analyze-samples: derived schema from sample", {
        table: sample.tableName,
        columns: derived.columns.length,
        contentColumns: derived.contentColumns.length,
      });
    }

    const destSchema: FieldRef[] = (columns ?? []).map((c) => ({
      name: c.name,
      type: c.type,
    }));

    // PER-SAMPLE vendor-mapping guard (pinned): Phase 0 applies whatever it
    // is given, mapping even onto columns absent from the schema and pushing
    // duplicate-destination rows (it has no reservation logic). So an entry
    // passes only when (a) its SOURCE field exists in this sample, (b) its
    // DESTINATION column exists in the resolved schema, and (c) its
    // destination was not already claimed by an earlier entry - first wins,
    // matching the pack declaration order (hand-verified before generated).
    const sampleFieldNames = new Set(
      parsed.fields.map((f) => f.name.toLowerCase()),
    );
    const schemaColumnNames = new Set(
      (columns ?? []).map((c) => c.name.toLowerCase()),
    );
    const claimedDest = new Set<string>();
    const claimedSource = new Set<string>();
    const applicableMappings = (input.vendorMappings ?? []).filter((vm) => {
      const sourceKey = vm.sourceName.toLowerCase();
      if (!sampleFieldNames.has(sourceKey)) return false;
      if (claimedSource.has(sourceKey)) return false;
      // A learned/pack DROP consumes its source without claiming a column.
      if (vm.action === "drop") {
        claimedSource.add(sourceKey);
        return true;
      }
      if (!schemaColumnNames.has(vm.destName.toLowerCase())) return false;
      if (claimedDest.has(vm.destName.toLowerCase())) return false;
      claimedSource.add(sourceKey);
      claimedDest.add(vm.destName.toLowerCase());
      return true;
    });

    // USER-FACING engine (Unit 13): alias/fuzzy-aware match.
    const matchResult = matchParsedSampleToColumns(
      parsed,
      columns,
      sample.tableName,
      applicableMappings.length > 0 ? applicableMappings : undefined,
    );

    // DCR-SIDE engine (Unit 18): exact-name partitioning against the DCR flow.
    const sourceFields: FieldRef[] = parsedSampleToSourceFields(parsed).map(
      (f) => ({ name: f.name, type: f.type }),
    );
    const flow =
      flowsByTable.get(sample.tableName.toLowerCase()) ??
      syntheticFlow(sample.tableName, destSchema);
    const gap = analyzeDcrGap(sourceFields, destSchema, flow, profile);

    yield buildGapReport({
      tableName: sample.tableName,
      logType: sample.logType,
      matchResult,
      gap,
      routeCondition: generateRouteCondition(flow.eventSimpleNames),
      destSchema,
      ...(schemaDerivation !== undefined ? { schemaDerivation } : {}),
    });
  }
}

/** Collect every {@link GapReport} into an array (drains the generator). */
export async function collectGapReports(
  ports: AnalyzeSamplesPorts,
  input: AnalyzeSamplesInput,
): Promise<GapReport[]> {
  const reports: GapReport[] = [];
  for await (const report of analyzeSamples(ports, input)) {
    reports.push(report);
  }
  return reports;
}
