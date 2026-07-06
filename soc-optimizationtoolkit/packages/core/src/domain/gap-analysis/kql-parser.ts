/**
 * KQL parser for DCR transformKql - porting-plan Unit 18 (ENG-12).
 *
 * Ported from legacy IS/kql-parser.ts. Extracts routing rules, field renames,
 * and type coercions from a DCR dataFlow's transformKql, tolerating the three
 * DCR document shapes seen in the Sentinel repo. The IO the legacy module did
 * (fs/path imports, the sentinel-repo dynamic import) is REMOVED - this module
 * is pure; the fetching lives behind the SentinelContent port and is composed
 * by the analyze-samples usecase.
 *
 * FIX + PIN (task item 1): generateRouteCondition's many-name branch built an
 * UNESCAPED, UNANCHORED regex (`/A|B|C/.test(field)`). That over-matched
 * substrings (`/Proc/` matched "ProcessRollup2") and broke on names containing
 * regex metacharacters. The port ESCAPES each name and ANCHORS the alternation
 * (`/^(A|B|C)$/.test(field)`). Both the old over-match and the fixed behavior
 * are characterized in kql-parser.test.ts.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import type { DcrFlow, ParsedDcr, TableRoutingInfo } from "./models";
import type { VendorGapProfile } from "./vendor-profile";
import { DEFAULT_GAP_PROFILE } from "./vendor-profile";

// ---------------------------------------------------------------------------
// transformKql parsing
// ---------------------------------------------------------------------------

/**
 * KQL function names that appear on the left of `=` inside project-rename /
 * extend fragments and must NOT be mistaken for a destination field. Verbatim
 * from legacy (includes the `source` pipe-head token and the `extend` keyword).
 */
const RENAME_SKIP_NAMES: readonly string[] = [
  "iff",
  "isnotempty",
  "now",
  "todatetime",
  "tolong",
  "todouble",
  "toint",
  "tobool",
  "todynamic",
  "datetime_add",
  "source",
  "extend",
];

/** KQL coercion function -> DCR column type (verbatim legacy typeMap). */
const TYPE_MAP: Record<string, string> = {
  tolong: "long",
  todouble: "real",
  toint: "int",
  tobool: "boolean",
  todynamic: "dynamic",
  tostring: "string",
};

/**
 * Decode one transformKql string into its routing names, renames, coercions,
 * and derived column set. `profile` supplies the vendor common-field injection
 * that fires only for event_simpleName-routed flows (default: none).
 */
export function parseTransformKql(
  kql: string,
  profile: VendorGapProfile = DEFAULT_GAP_PROFILE,
): Omit<DcrFlow, "outputStream" | "tableName"> {
  const clean = kql.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Extract event_simpleName in (...) list
  const esnMatch = clean.match(/event_simpleName\s+in\s*\(([^)]+)\)/);
  const eventSimpleNames: string[] = [];
  if (esnMatch) {
    const raw = esnMatch[1];
    for (const part of raw.split(",")) {
      const name = part.trim().replace(/^'|'$/g, "").trim();
      if (name) eventSimpleNames.push(name);
    }
  }

  // Extract project-rename: dest = ['source'] or dest = source
  const renames: Array<{ dest: string; source: string }> = [];
  const renameBlock = clean.match(/project-rename\s+([\s\S]*?)(?=\n\s*\||\n*$)/);
  if (renameBlock) {
    const renameRegex = /(\w+)\s*=\s*\[?'?(\w+)'?\]?/g;
    let m: RegExpExecArray | null;
    while ((m = renameRegex.exec(renameBlock[1])) !== null) {
      const dest = m[1];
      const source = m[2];
      if (RENAME_SKIP_NAMES.includes(dest)) continue;
      if (dest !== source) {
        renames.push({ dest, source });
      }
    }
  }

  // Extract type coercions from extend blocks: field = tolong(field), etc.
  const typeConversions: Array<{ field: string; toType: string }> = [];
  const extendBlocks =
    clean.match(/extend\s+([\s\S]*?)(?=\n\s*\||\n*$)/g) || [];
  for (const block of extendBlocks) {
    const convRegex =
      /(\w+)\s*=\s*(tolong|todouble|toint|tobool|todynamic|tostring)\((?:\[?'?)?(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = convRegex.exec(block)) !== null) {
      typeConversions.push({ field: m[1], toType: TYPE_MAP[m[2]] || "string" });
    }
  }

  // Build the derived column list from renames + coercions.
  const columnMap = new Map<string, string>();
  columnMap.set("TimeGenerated", "datetime");
  for (const r of renames) columnMap.set(r.dest, "string");
  for (const tc of typeConversions) columnMap.set(tc.field, tc.toType);

  // Vendor common-field injection - ONLY for event_simpleName-routed flows.
  // Legacy hard-coded the CrowdStrike/FDR fields here; now parameterized.
  if (eventSimpleNames.length > 0) {
    for (const cf of profile.commonFields) {
      if (!columnMap.has(cf.name)) columnMap.set(cf.name, cf.type);
    }
  }

  const columns = Array.from(columnMap.entries()).map(([name, type]) => ({
    name,
    type,
  }));

  return { eventSimpleNames, renames, typeConversions, columns };
}

// ---------------------------------------------------------------------------
// DCR JSON parsing (tolerating all 3 shapes)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parse a DCR document (as JSON text) into its dataFlows. Tolerates the three
 * shapes the Sentinel repo uses:
 *   1. Direct DCR object:  { properties: { dataFlows: [...] } }
 *   2. ARM template:       { resources: [{ type: "...dataCollectionRules", ... }] }
 *   3. Array wrapper:      [ { properties: { dataFlows: [...] } } ]
 */
export function parseDcrJson(
  content: string,
  profile: VendorGapProfile = DEFAULT_GAP_PROFILE,
): ParsedDcr {
  const raw: unknown = JSON.parse(content);

  let dcrObj: Record<string, unknown> | null = Array.isArray(raw)
    ? asRecord(raw[0])
    : asRecord(raw);

  // ARM template: find the DCR resource inside resources[].
  const resources = dcrObj ? dcrObj["resources"] : undefined;
  if (Array.isArray(resources)) {
    const dcrResource = resources.find((r) => {
      const rec = asRecord(r);
      const type = rec ? rec["type"] : undefined;
      return (
        typeof type === "string" &&
        type.toLowerCase().includes("datacollectionrules")
      );
    });
    const resolved = asRecord(dcrResource);
    if (resolved) dcrObj = resolved;
  }

  const props = dcrObj ? asRecord(dcrObj["properties"]) : null;
  const dataFlowsRaw = props ? props["dataFlows"] : undefined;
  const dataFlows = Array.isArray(dataFlowsRaw) ? dataFlowsRaw : [];

  const flows: DcrFlow[] = [];
  let totalEventNames = 0;
  let totalColumns = 0;

  for (const flowRaw of dataFlows) {
    const flow = asRecord(flowRaw);
    if (!flow) continue;
    const kql = typeof flow["transformKql"] === "string" ? (flow["transformKql"] as string) : "";
    const streams = flow["streams"];
    const outputStream =
      (typeof flow["outputStream"] === "string" ? (flow["outputStream"] as string) : "") ||
      (Array.isArray(streams) && typeof streams[0] === "string" ? (streams[0] as string) : "");
    const tableName = outputStream
      .replace(/^Custom-/, "")
      .replace(/^Microsoft-/, "");

    const parsed = parseTransformKql(kql, profile);
    totalEventNames += parsed.eventSimpleNames.length;
    totalColumns += parsed.columns.length;

    flows.push({ outputStream, tableName, ...parsed });
  }

  return { flows, totalEventNames, totalColumns };
}

// ---------------------------------------------------------------------------
// Route condition generator (FIX + PIN: escaped AND anchored)
// ---------------------------------------------------------------------------

/**
 * Escape every regex metacharacter in `literal` so it matches itself inside a
 * regex alternation (the fix for the legacy unescaped route regex).
 */
export function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Generate a Cribl route condition from a flow's event_simpleName list.
 *   - 0 names   -> "true" (no discriminator; the flow matches everything).
 *   - 1 name    -> equality.
 *   - 2..5      -> OR of equalities.
 *   - >5        -> an anchored, ESCAPED alternation regex.
 *
 * FIX + PIN (task item 1): the legacy many-name branch returned
 * `/${names.join('|')}/.test(event_simpleName)` - unescaped and unanchored, so
 * it over-matched substrings (`event_simpleName == "ProcessRollup2"` matched a
 * rule listing "Process") and broke on names with regex metacharacters. This
 * escapes each name and anchors with ^(...)$ so the whole value must match.
 */
export function generateRouteCondition(eventNames: string[]): string {
  if (eventNames.length === 0) return "true";
  if (eventNames.length === 1) return `event_simpleName == '${eventNames[0]}'`;
  if (eventNames.length <= 5) {
    return eventNames.map((n) => `event_simpleName == '${n}'`).join(" || ");
  }
  const escaped = eventNames.map(escapeRegExp).join("|");
  return `/^(${escaped})$/.test(event_simpleName)`;
}

// ---------------------------------------------------------------------------
// Public helper: per-table routing + schema summary
// ---------------------------------------------------------------------------

/** Decode a DCR document to a per-table routing + schema summary list. */
export function extractTableRouting(
  dcrContent: string,
  profile: VendorGapProfile = DEFAULT_GAP_PROFILE,
): TableRoutingInfo[] {
  const parsed = parseDcrJson(dcrContent, profile);
  return parsed.flows.map((flow) => ({
    tableName: flow.tableName,
    outputStream: flow.outputStream,
    routeCondition: generateRouteCondition(flow.eventSimpleNames),
    eventSimpleNames: flow.eventSimpleNames,
    columns: flow.columns,
    typeConversions: flow.typeConversions,
  }));
}
