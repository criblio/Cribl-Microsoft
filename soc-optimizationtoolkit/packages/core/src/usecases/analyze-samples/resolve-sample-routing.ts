/**
 * resolveSampleRouting - the DESTINATION-ROUTING usecase (extracted from the
 * mapping review's runAnalysis in the 2026-07-12 architecture audit: the
 * component had accumulated seven routing decisions and a second full DCR
 * fetch pass).
 *
 * One call resolves everything the review needs BEFORE analyzing samples:
 *
 *  - connector HINTS: read + decode up to CONNECTOR_TABLE_DECODE_CAP of the
 *    solution's connector files; their declared table names become the
 *    first resolution tier.
 *  - connector-KQL IDENTITY (Wave C): the same file texts feed
 *    identityFromConnectorKql - the tier below curated knowledge.
 *  - destination RESOLUTION: resolveDestinationTables with a typed tier.
 *  - DCR FLOWS: resolveSolutionDcrFlows, returned so the caller can hand
 *    them to analyzeSamples (input.dcrFlows) - ONE fetch pass per analysis.
 *  - EventsToTableMapping routing (Wave B), appended AFTER the DCR flows.
 *  - the per-log-type TABLE assignment, precedence pinned:
 *      caller override > DCR-declared flow > name similarity > first table.
 *
 * Degradation is per-source and SURFACED: unreadable connectors or a broken
 * EventsToTableMapping.json add a note instead of silently weakening the
 * routing. The usecase never throws for content problems.
 */

import {
  DEFAULT_GAP_PROFILE,
  eventTableRoutingFromMapping,
  hintsFromConnectorTables,
  matchLogTypeToDcrFlow,
  matchSampleLogTypeToTable,
  resolveDestinationTables,
} from "../../domain/gap-analysis/index";
import type {
  DcrFlow,
  DcrFlowRouting,
  DestinationTableResolution,
  VendorGapProfile,
  VendorLogTypeHint,
} from "../../domain/gap-analysis/index";
import { decodeConnector } from "../../domain/sentinel-content/index";
import { identityFromConnectorKql } from "../../domain/vendor-identity/index";
import type { VendorIdentity } from "../../domain/vendor-identity/index";
import type { SentinelContent } from "../../ports/sentinel-content";
import { resolveSolutionDcrFlows } from "./analyze-samples";

/**
 * Bound on connector files read + decoded for hints/identity (moved here
 * from the mapping review, which owned it while it owned the loop).
 */
export const CONNECTOR_TABLE_DECODE_CAP = 5;

/** Input for {@link resolveSampleRouting}. */
export interface SampleRoutingInput {
  /** The selected solution; "" resolves the default table for every type. */
  solutionName: string;
  /** The tagged log types awaiting a destination each. */
  logTypes: readonly string[];
  /** Per-log-type reviewer overrides - always win. */
  overrides?: Readonly<Record<string, string>>;
  /** Vendor quirks for DCR parsing (defaults to the generic profile). */
  profile?: VendorGapProfile;
}

/** Everything the analysis needs routed/resolved, in one result. */
export interface SampleRoutingResult {
  resolution: DestinationTableResolution;
  /** Wave C identity (null when the connectors declare no filters). */
  connectorIdentity: VendorIdentity | null;
  /** Hand to analyzeSamples as input.dcrFlows (skips its re-resolve). */
  dcrFlows: Map<string, DcrFlow>;
  /** The routed destination per log type (precedence pinned above). */
  tableByLogType: Record<string, string>;
  /** Soft degradation notes (unreadable connectors, broken mapping file). */
  notes: string[];
}

export async function resolveSampleRouting(
  content: SentinelContent,
  input: SampleRoutingInput,
): Promise<SampleRoutingResult> {
  const notes: string[] = [];
  const hints: VendorLogTypeHint[] = [];
  const connectorTexts: string[] = [];
  let files: Awaited<ReturnType<SentinelContent["listConnectorFiles"]>> = [];

  if (input.solutionName.trim() !== "") {
    try {
      files = await content.listConnectorFiles(input.solutionName);
    } catch {
      notes.push(
        "Connector listing failed - destination detection degraded to the default tier.",
      );
    }
    let unreadable = 0;
    for (const file of files.slice(0, CONNECTOR_TABLE_DECODE_CAP)) {
      try {
        const text = await content.readFile(file.path);
        if (text === null) {
          unreadable++;
          continue;
        }
        connectorTexts.push(text);
        const decoded = decodeConnector(JSON.parse(text), file.path);
        hints.push(
          ...hintsFromConnectorTables(decoded.tables.map((t) => t.tableName)),
        );
      } catch {
        unreadable++;
      }
    }
    if (unreadable > 0) {
      notes.push(
        `${unreadable} connector file(s) could not be read or decoded - table detection may be incomplete.`,
      );
    }
  }

  const resolution = await resolveDestinationTables(
    hints,
    async () => files.map((f) => ({ name: f.name, path: f.path })),
    "Sentinel solution connectors",
  );
  const defaultTable = resolution.tables[0] ?? "CommonSecurityLog";

  const dcrFlows = await resolveSolutionDcrFlows(
    content,
    input.solutionName,
    input.profile ?? DEFAULT_GAP_PROFILE,
  );
  const flowRouting: DcrFlowRouting[] = [...dcrFlows.values()];

  // Wave B: EventsToTableMapping.json routes AFTER the DCR flows.
  const mappingFile = files.find((f) => f.name === "EventsToTableMapping.json");
  if (mappingFile !== undefined) {
    try {
      const text = await content.readFile(mappingFile.path);
      if (text !== null) {
        const knownTables = [
          ...new Set([
            ...resolution.tables,
            ...flowRouting.map((f) => f.tableName),
          ]),
        ];
        flowRouting.push(
          ...eventTableRoutingFromMapping(JSON.parse(text), knownTables),
        );
      }
    } catch {
      notes.push(
        "EventsToTableMapping.json could not be read - event-name routing fell back to DCR flows and name similarity.",
      );
    }
  }

  const overrides = input.overrides ?? {};
  const tableByLogType: Record<string, string> = {};
  for (const logType of input.logTypes) {
    tableByLogType[logType] =
      overrides[logType] ??
      matchLogTypeToDcrFlow(logType, flowRouting) ??
      matchSampleLogTypeToTable(
        logType,
        hints,
        resolution.tables.length,
        defaultTable,
      );
  }

  return {
    resolution,
    connectorIdentity: identityFromConnectorKql(connectorTexts),
    dcrFlows,
    tableByLogType,
    notes,
  };
}
