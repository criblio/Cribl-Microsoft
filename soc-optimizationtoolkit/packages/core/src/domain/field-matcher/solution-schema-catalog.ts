/**
 * SOLUTION-AWARE SchemaCatalog tier (Wave E of
 * docs/sentinel-repo-mapping-sources.md) - fills the seam the bundled
 * catalog's header reserved: consult the selected solution's OWN table
 * definitions before the bundled snapshot.
 *
 * CCP connector bundles ship their destination tables as ARM resources
 * (`Microsoft.OperationalInsights/workspaces/tables` with
 * properties.schema.columns) right next to the DCR - e.g. Okta's
 * OktaSSOv2_Tables.json (58 typed columns) or CrowdStrike's
 * CrowdStrike_*_CL.json set. Reading them means a solution whose custom
 * tables are absent from (or newer than) the bundled snapshot still resolves
 * a real schema instead of falling to the empty-schema note.
 *
 * The wrapper lazily loads ONCE per instance (per solution selection): list
 * the connector files, read the table-looking JSONs (name contains "table"
 * or ends in _CL.json, capped), deep-walk each for table ARM resources, and
 * serve hits ahead of the fallback catalog. Every failure degrades to the
 * fallback - selecting a solution can never make schema resolution worse.
 */

import type { DcrSchemaColumn, SchemaCatalog } from "../../ports/schema-catalog";
import type { SentinelContent } from "../../ports/sentinel-content";
import {
  DCR_SCHEMA_SYSTEM_COLUMNS,
  normalizeTableNames,
} from "./bundled-schema-catalog";

/** One table declared by a solution's ARM resources. */
export interface SolutionTableSchema {
  name: string;
  columns: DcrSchemaColumn[];
}

const systemColumnSet: ReadonlySet<string> = new Set(DCR_SCHEMA_SYSTEM_COLUMNS);

/** Bound on table-definition files read per solution (CrowdStrike ships 10). */
const TABLE_FILE_CAP = 60;

/** Bound on the deep walk (ARM nests resources a few levels at most). */
const MAX_WALK_DEPTH = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract every `Microsoft.OperationalInsights/workspaces/tables` resource
 * from an ARM JSON document (template with `resources`, bare resource, or
 * top-level array), tolerating arbitrary nesting. The table name comes from
 * properties.schema.name (the ARM resource name is a workspace-scoped
 * concat() expression). System columns Azure auto-populates are filtered,
 * matching the bundled catalog's contract.
 */
export function tablesFromArmJson(json: unknown): SolutionTableSchema[] {
  const tables: SolutionTableSchema[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > MAX_WALK_DEPTH) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (!isRecord(node)) return;
    const type = node["type"];
    if (
      typeof type === "string" &&
      type.toLowerCase().includes("operationalinsights/workspaces/tables")
    ) {
      const properties = isRecord(node["properties"]) ? node["properties"] : {};
      const schema = isRecord(properties["schema"]) ? properties["schema"] : {};
      const name = schema["name"];
      const columns = schema["columns"];
      if (typeof name === "string" && name !== "" && Array.isArray(columns)) {
        const cleaned: DcrSchemaColumn[] = [];
        for (const column of columns) {
          if (!isRecord(column)) continue;
          const colName = column["name"];
          const colType = column["type"];
          if (typeof colName !== "string" || colName === "") continue;
          if (systemColumnSet.has(colName)) continue;
          cleaned.push({
            name: colName,
            type: typeof colType === "string" ? colType : "string",
          });
        }
        if (cleaned.length > 0) tables.push({ name, columns: cleaned });
      }
    }
    for (const value of Object.values(node)) walk(value, depth + 1);
  };
  walk(json, 0);
  return tables;
}

/** Whether a connector file plausibly declares tables (cheap prefilter). */
function looksLikeTableFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (!lower.endsWith(".json")) return false;
  return lower.includes("table") || lower.endsWith("_cl.json");
}

/**
 * Wrap `fallback` with the solution's own table definitions. Loading is lazy
 * and happens at most once per instance; every failure (list, read, parse)
 * degrades to the fallback.
 */
export function createSolutionSchemaCatalog(
  content: SentinelContent,
  solutionName: string,
  fallback: SchemaCatalog,
): SchemaCatalog {
  let loaded: Promise<Map<string, DcrSchemaColumn[]>> | null = null;

  const load = (): Promise<Map<string, DcrSchemaColumn[]>> => {
    loaded ??= (async () => {
      const byName = new Map<string, DcrSchemaColumn[]>();
      if (solutionName.trim() === "") return byName;
      try {
        const files = await content.listConnectorFiles(solutionName);
        const tableFiles = files
          .filter((f) => looksLikeTableFile(f.name))
          .slice(0, TABLE_FILE_CAP);
        for (const file of tableFiles) {
          try {
            const text = await content.readFile(file.path);
            if (text === null) continue;
            for (const table of tablesFromArmJson(JSON.parse(text))) {
              const key = table.name.toLowerCase();
              if (!byName.has(key)) byName.set(key, table.columns);
            }
          } catch {
            // One unreadable definition never blocks the others.
          }
        }
      } catch {
        // Listing failed: the fallback catalog still serves everything.
      }
      return byName;
    })();
    return loaded;
  };

  return {
    async resolveSchema(tableName: string): Promise<DcrSchemaColumn[] | null> {
      const byName = await load();
      if (byName.size > 0) {
        for (const variant of normalizeTableNames(tableName)) {
          const hit = byName.get(variant.toLowerCase());
          if (hit !== undefined && hit.length > 0) {
            return hit.map((column) => ({ ...column }));
          }
        }
      }
      return fallback.resolveSchema(tableName);
    },
  };
}
