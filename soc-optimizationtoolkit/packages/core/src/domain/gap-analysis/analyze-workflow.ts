/**
 * Analyze-workflow helpers - porting-plan Unit 18 (ENG-12, GUI-08), since
 * grown into the DESTINATION-ROUTING toolbox (2026-07-12 waves):
 *
 *  - resolveDestinationTables: the three-tier destination resolution with a
 *    typed `tier` (connector hints > CustomTables definitions > the
 *    CommonSecurityLog default) plus a human-readable provenance string.
 *  - hintsFromConnectorTables / normalizeConnectorTableName: connector
 *    dataTypes labels -> table hints.
 *  - matchSampleToTable: name-similarity routing of a sample log type.
 *  - matchLogTypeToDcrFlow: DCR-declared event_simpleName routing (beats
 *    name similarity; exact beats suffix).
 *  - eventTableRoutingFromMapping: EventsToTableMapping.json routing
 *    (CrowdStrike function-app shape).
 *
 * matchSampleToTable/resolveDestinationTables were ported from legacy
 * IS-R/hooks/analyze-workflow.ts; the routing helpers are net-new.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto. loadConnectors is INJECTED
 * so the caller owns its errors/logging and tests need no IO.
 */

/** The case/separator-insensitive token EVERY routing comparison uses -
 * matchSampleToTable, matchLogTypeToDcrFlow, and eventTableRoutingFromMapping
 * must agree on what "the same name" means. */
export function normLogToken(name: string): string {
  return name.toLowerCase().replace(/[-_ ]/g, "");
}

/** Which precedence tier resolved the destination (typed - the UI's amber
 * "default" banner branches on this, never on the prose). */
export type DestinationTier = "connector" | "custom-tables" | "default";

export interface DestinationTableResolution {
  tables: string[];
  /** Human-readable provenance (display only - branch on `tier`). */
  source: string;
  tier: DestinationTier;
}

export interface VendorLogTypeHint {
  id?: string;
  name?: string;
  destTable?: string;
}

export interface SolutionConnector {
  name: string;
  path: string;
}

// Resolve the destination Sentinel tables for a solution, in precedence order:
//   1. Vendor research log types (strip the Microsoft- content-hub prefix).
//      `hintSource` names this tier in the provenance banner - callers passing
//      hints DERIVED from the solution's own connector definitions (see
//      hintsFromConnectorTables) label the tier accordingly; the default is
//      the verbatim legacy wording.
//   2. Custom-table connectors from the Sentinel repo (_CL tables) -- fetched lazily via
//      loadConnectors, which is only called when vendor research yields nothing
//   3. Default to CommonSecurityLog
// loadConnectors is injected so it can handle its own errors/logging and so tests need no IO.
export async function resolveDestinationTables(
  researchLogTypes: VendorLogTypeHint[],
  loadConnectors: () => Promise<SolutionConnector[]>,
  hintSource = "Vendor research (Sentinel Content Hub)",
): Promise<DestinationTableResolution> {
  const destTables = new Set<string>();
  let source = "";
  let tier: DestinationTier = "default";

  for (const lt of researchLogTypes) {
    if (lt.destTable) destTables.add(lt.destTable.replace(/^Microsoft-/, ""));
  }
  if (destTables.size > 0) {
    source = hintSource;
    tier = "connector";
  }

  if (destTables.size === 0) {
    const connectors = await loadConnectors();
    for (const c of connectors) {
      if (
        c.name.toLowerCase().includes("customtable") ||
        c.path.includes("CustomTables")
      ) {
        const tableName = c.name.replace(".json", "");
        if (tableName.endsWith("_CL")) destTables.add(tableName);
      }
    }
    if (destTables.size > 0) {
      source = "Sentinel repo (CustomTables definition)";
      tier = "custom-tables";
    }
  }

  if (destTables.size === 0) {
    destTables.add("CommonSecurityLog");
    source = "Default (no DCR definition found in Sentinel solution)";
    tier = "default";
  }

  return { tables: [...destTables], source, tier };
}

/**
 * Normalize a connector table LABEL to a bare table name, or null when no
 * clean name survives. Connector dataTypes entries carry display labels like
 * "CommonSecurityLog (Zscaler)" or "Syslog (PaloAlto)" - the table name is
 * the part before the parenthetical (live report 2026-07-09: the Zscaler
 * solution resolved to "Default (no DCR definition found)" because its
 * connector declares the table ONLY through such a dataTypes label).
 */
export function normalizeConnectorTableName(raw: string): string | null {
  const candidate = raw.split("(")[0].trim();
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(candidate) ? candidate : null;
}

/**
 * Build {@link VendorLogTypeHint}s from the table names a solution's DECODED
 * connectors declare (decodeConnector covers all four formats, including the
 * name-only dataTypes labels). Labels that do not normalize to a clean table
 * name are dropped; duplicates collapse. Feed the result to
 * {@link resolveDestinationTables} as its first tier so the destination is
 * DETECTED from the solution instead of falling to the default.
 */
export function hintsFromConnectorTables(
  tableNames: readonly string[],
): VendorLogTypeHint[] {
  const seen = new Set<string>();
  const hints: VendorLogTypeHint[] = [];
  for (const raw of tableNames) {
    const table = normalizeConnectorTableName(raw);
    if (table === null || seen.has(table)) continue;
    seen.add(table);
    hints.push({ id: table, name: raw, destTable: table });
  }
  return hints;
}

// Match a sample's log type to one of the resolved destination tables using the vendor log
// types (exact normalized match, or substring either direction for names/ids longer than 3
// chars). With one or zero destination tables there is nothing to disambiguate -> default.
export function matchSampleToTable(
  sampleLogType: string,
  researchLogTypes: VendorLogTypeHint[],
  destinationTableCount: number,
  defaultTable: string,
): string {
  if (destinationTableCount <= 1) return defaultTable;

  const sNorm = normLogToken(sampleLogType);
  for (const lt of researchLogTypes) {
    if (!lt.destTable) continue;
    const idNorm = normLogToken(lt.id || "");
    const nameNorm = normLogToken(lt.name || "");
    if (
      idNorm === sNorm ||
      nameNorm === sNorm ||
      (idNorm.length > 3 && sNorm.includes(idNorm)) ||
      (sNorm.length > 3 && idNorm.includes(sNorm)) ||
      (nameNorm.length > 3 && sNorm.includes(nameNorm)) ||
      (sNorm.length > 3 && nameNorm.includes(sNorm))
    ) {
      return lt.destTable;
    }
  }
  return defaultTable;
}

/**
 * Route a sample's log type to the table whose DCR FLOW declares it (user
 * request 2026-07-12): solutions with per-event-type custom tables
 * (CrowdStrike FDR) state in their own DCR exactly which event_simpleName
 * values land in which table - authoritative routing that name similarity
 * cannot recover ("PROCESSROLLUP2" shares no name with
 * "CrowdStrike_Process_Events_CL"). Callers try this BEFORE
 * {@link matchSampleToTable}; null means the DCRs do not claim the log type.
 *
 * Matching is normalized (case/separator-insensitive) exact, plus a suffix
 * match for stream-scoped split names ("fdr-PROCESSROLLUP2" still routes).
 */
export function matchLogTypeToDcrFlow(
  sampleLogType: string,
  flows: readonly DcrFlowRouting[],
): string | null {
  const norm = normLogToken(sampleLogType);
  if (norm === "") return null;
  // An EXACT event-name match anywhere beats a suffix match anywhere: a
  // stream-scoped "fdr-ProcessRollup2" must not route to a flow declaring a
  // shorter suffix ("Rollup2") while another flow declares the exact name.
  let suffixHit: string | null = null;
  for (const flow of flows) {
    for (const eventName of flow.eventSimpleNames) {
      const evNorm = normLogToken(eventName);
      if (evNorm === "") continue;
      if (evNorm === norm) return flow.tableName;
      if (suffixHit === null && evNorm.length > 3 && norm.endsWith(evNorm)) {
        suffixHit = flow.tableName;
      }
    }
  }
  return suffixHit;
}

/** The slice of a DcrFlow the router needs (structural, avoids a models dep). */
export interface DcrFlowRouting {
  tableName: string;
  eventSimpleNames: readonly string[];
}

/**
 * Build routing entries from a connector's EventsToTableMapping.json (Wave B
 * of docs/sentinel-repo-mapping-sources.md). CrowdStrike's function-app
 * connector routes BEFORE its DCR via a flat dict of
 * event_simpleName -> table CATEGORY ("ZipFileWritten": "File"); the
 * category resolves to whichever known table carries the token
 * (File -> CrowdStrike_File_Events_CL). Categories matching zero or several
 * known tables are dropped (never guess). Malformed input yields [].
 */
export function eventTableRoutingFromMapping(
  mappingJson: unknown,
  knownTables: readonly string[],
): DcrFlowRouting[] {
  if (
    mappingJson === null ||
    typeof mappingJson !== "object" ||
    Array.isArray(mappingJson)
  ) {
    return [];
  }
  const eventsByCategory = new Map<string, string[]>();
  for (const [eventName, category] of Object.entries(
    mappingJson as Record<string, unknown>,
  )) {
    if (typeof category !== "string" || category.trim() === "") continue;
    const key = normLogToken(category.trim());
    if (key.length < 3) continue;
    const list = eventsByCategory.get(key) ?? [];
    list.push(eventName);
    eventsByCategory.set(key, list);
  }
  const routings: DcrFlowRouting[] = [];
  for (const [categoryKey, eventNames] of eventsByCategory) {
    const matches = knownTables.filter((table) =>
      normLogToken(table).includes(categoryKey),
    );
    if (matches.length !== 1) continue;
    routings.push({ tableName: matches[0], eventSimpleNames: eventNames });
  }
  return routings;
}
