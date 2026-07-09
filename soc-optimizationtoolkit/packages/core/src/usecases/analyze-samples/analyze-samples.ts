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
import {
  matchParsedSampleToColumns,
  parsedSampleToSourceFields,
} from "../../domain/field-matcher/index";
import type { VendorMapping } from "../../domain/field-matcher/index";
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
async function resolveSolutionDcrFlows(
  content: SentinelContent,
  solutionName: string,
  profile: VendorGapProfile,
  logger?: Logger,
): Promise<Map<string, DcrFlow>> {
  const flowsByTable = new Map<string, DcrFlow>();
  try {
    const solutions = await content.listSolutions();
    const lower = solutionName.toLowerCase().replace(/[^a-z0-9]/g, "");
    const match = solutions.find((s) => {
      const key = s.name.toLowerCase().replace(/[^a-z0-9]/g, "");
      return key === lower || key.includes(lower) || lower.includes(key);
    });
    if (!match) {
      logger?.info("analyze-samples: no matching solution", {
        solution: solutionName,
      });
      return flowsByTable;
    }

    const connectors = await content.listConnectorFiles(match.name);
    const dcrFiles = connectors.filter(
      (f) =>
        f.name.toLowerCase().includes("dcr") &&
        f.name.toLowerCase().endsWith(".json"),
    );
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
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    logger?.warn("analyze-samples: solution DCR lookup failed", {
      solution: solutionName,
      error: err instanceof Error ? err.message : String(err),
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
  const flowsByTable = await resolveSolutionDcrFlows(
    ports.content,
    input.solutionName,
    profile,
    ports.logger,
  );

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
        error: err instanceof Error ? err.message : String(err),
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
    const applicableMappings = (input.vendorMappings ?? []).filter((vm) => {
      if (!sampleFieldNames.has(vm.sourceName.toLowerCase())) return false;
      if (!schemaColumnNames.has(vm.destName.toLowerCase())) return false;
      if (claimedDest.has(vm.destName.toLowerCase())) return false;
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
