/**
 * Analyze-workflow helpers - porting-plan Unit 18 (ENG-12, GUI-08). Ported
 * VERBATIM from legacy IS-R/hooks/analyze-workflow.ts (its test ports verbatim
 * too, see analyze-workflow.test.ts).
 *
 * Two pure helpers the legacy duplicated across the analyze, resource-preview,
 * and deploy flows; centralizing removes that drift and makes the rules
 * testable. resolveDestinationTables carries a PROVENANCE STRING telling which
 * precedence tier resolved the destination (vendor research vs Sentinel repo
 * CustomTables vs the CommonSecurityLog default) - the UI shows it, and the
 * "Default ..." wording is load-bearing (the legacy tinted the destination
 * banner amber when the source string contains "Default").
 *
 * Pure: no IO, no fetch, no React, no Date/crypto. loadConnectors is INJECTED
 * so the caller owns its errors/logging and tests need no IO.
 */

export interface DestinationTableResolution {
  tables: string[];
  source: string;
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

  for (const lt of researchLogTypes) {
    if (lt.destTable) destTables.add(lt.destTable.replace(/^Microsoft-/, ""));
  }
  if (destTables.size > 0) source = hintSource;

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
    if (destTables.size > 0) source = "Sentinel repo (CustomTables definition)";
  }

  if (destTables.size === 0) {
    destTables.add("CommonSecurityLog");
    source = "Default (no DCR definition found in Sentinel solution)";
  }

  return { tables: [...destTables], source };
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

  const sNorm = sampleLogType.toLowerCase().replace(/[-_ ]/g, "");
  for (const lt of researchLogTypes) {
    if (!lt.destTable) continue;
    const idNorm = (lt.id || "").toLowerCase().replace(/[-_ ]/g, "");
    const nameNorm = (lt.name || "").toLowerCase().replace(/[-_ ]/g, "");
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
  const norm = sampleLogType.toLowerCase().replace(/[-_ ]/g, "");
  if (norm === "") return null;
  // An EXACT event-name match anywhere beats a suffix match anywhere: a
  // stream-scoped "fdr-ProcessRollup2" must not route to a flow declaring a
  // shorter suffix ("Rollup2") while another flow declares the exact name.
  let suffixHit: string | null = null;
  for (const flow of flows) {
    for (const eventName of flow.eventSimpleNames) {
      const evNorm = eventName.toLowerCase().replace(/[-_ ]/g, "");
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
    const key = category.trim().toLowerCase().replace(/[-_ ]/g, "");
    if (key.length < 3) continue;
    const list = eventsByCategory.get(key) ?? [];
    list.push(eventName);
    eventsByCategory.set(key, list);
  }
  const routings: DcrFlowRouting[] = [];
  for (const [categoryKey, eventNames] of eventsByCategory) {
    const matches = knownTables.filter((table) =>
      table.toLowerCase().replace(/[-_ ]/g, "").includes(categoryKey),
    );
    if (matches.length !== 1) continue;
    routings.push({ tableName: matches[0], eventSimpleNames: eventNames });
  }
  return routings;
}
