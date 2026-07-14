/**
 * KQL-VALIDATION schema tier (user direction 2026-07-14): the Azure-Sentinel
 * repo ships the table schemas its own CI validates every solution's KQL
 * against, under `.script/tests/KqlvalidationsTests/CustomTables/<Table>.json`
 * - ~1000 files of shape {"Name": "<table>", "Properties": [{"Name","Type"}]}
 * (verified live: Cloudflare_CL.json = 104 columns of the legacy suffixed
 * schema, plus CloudflareV2_CL.json and the Cloudflare.json parser-output
 * shape). When a table is DEFINED THERE, it is the schema the solution's
 * rules and workbooks were written against - so this tier resolves FIRST,
 * ahead of the solution's connector-ARM tables and the bundled snapshot,
 * and ahead of sample-derived schemas (which stay the last-resort fallback
 * for tables the repo does not define).
 *
 * Resolution strategy per table (cached per catalog instance, misses too):
 *   1. DIRECT read of `<dir>/<tableName>.json` through the SentinelContent
 *      port (raw fetch by exact name - immune to the GitHub contents API's
 *      1000-entry directory listing cap, which this directory exceeds).
 *   2. Case-insensitive fallback: one cached directory listing, matched on
 *      `<tableName>.json` ignoring case. BEST-EFFORT: the listing itself is
 *      subject to the 1000-entry cap, so an exotic casing beyond the cap can
 *      miss - the base catalog then answers.
 *   3. Anything unreadable/unparseable falls through to the base catalog
 *      (never throws - the ladder degrades tier by tier).
 *
 * Type vocabulary: the files use Pascal-cased KQL-ish types with observed
 * casing drift (Datetime AND DateTime in one file). Mapped case-insensitively
 * to the 7-value DCR vocabulary; unknown types default to string (RULE 3
 * convention). System columns are filtered like the Wave E solution tier -
 * TimeGenerated is a REAL column and stays.
 *
 * Pure decisions + port orchestration; the IO lives behind SentinelContent.
 */

import type { SentinelContent } from "../../ports/sentinel-content";
import type { DcrSchemaColumn, SchemaCatalog } from "../../ports/schema-catalog";
import { DCR_SCHEMA_SYSTEM_COLUMNS } from "./bundled-schema-catalog";

/** The validation-schema directory in the Azure-Sentinel repo. */
export const KQL_VALIDATION_TABLES_DIR =
  ".script/tests/KqlvalidationsTests/CustomTables";

// Exact-case system-column filter, same contract as the bundled tier.
const SYSTEM_COLUMNS: ReadonlySet<string> = new Set(DCR_SCHEMA_SYSTEM_COLUMNS);

/** Pascal-ish validation type -> DCR vocabulary (case-insensitive keys). */
const VALIDATION_TYPE_MAP = new Map<string, string>([
  ["string", "string"],
  ["datetime", "datetime"],
  ["date", "datetime"],
  ["double", "real"],
  ["real", "real"],
  ["int", "int"],
  ["integer", "int"],
  ["long", "long"],
  ["bool", "boolean"],
  ["boolean", "boolean"],
  ["dynamic", "dynamic"],
  ["object", "dynamic"],
  ["guid", "string"],
]);

/** Map one validation-file type to the DCR vocabulary (unknown -> string). */
export function mapValidationColumnType(type: string): string {
  return VALIDATION_TYPE_MAP.get(type.trim().toLowerCase()) ?? "string";
}

/**
 * Parse one KqlvalidationsTests/CustomTables file into DCR schema columns,
 * or null for anything that is not the {Name, Properties[{Name,Type}]}
 * shape. System columns Azure auto-populates are filtered (TimeGenerated is
 * NOT one of them - it stays, matching the Wave E solution tier).
 */
export function parseKqlValidationTable(text: string): DcrSchemaColumn[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const properties = (parsed as { Properties?: unknown }).Properties;
  if (!Array.isArray(properties)) {
    return null;
  }
  const columns: DcrSchemaColumn[] = [];
  for (const entry of properties) {
    if (typeof entry !== "object" || entry === null) continue;
    const name = (entry as { Name?: unknown }).Name;
    const type = (entry as { Type?: unknown }).Type;
    if (typeof name !== "string" || name === "") continue;
    if (SYSTEM_COLUMNS.has(name)) continue;
    columns.push({
      name,
      type: typeof type === "string" ? mapValidationColumnType(type) : "string",
    });
  }
  return columns.length > 0 ? columns : null;
}

/**
 * Wrap `base` with the KQL-validation tier: a table defined in the repo's
 * validation schemas resolves from there FIRST; everything else falls
 * through to `base`. Results (including misses) are cached per instance.
 */
export function createKqlValidationSchemaCatalog(
  content: SentinelContent,
  base: SchemaCatalog,
): SchemaCatalog {
  const cache = new Map<string, DcrSchemaColumn[] | null>();
  let listing: Promise<ReadonlyMap<string, string>> | null = null;

  // Lowercased file name -> repo path, fetched at most once (best-effort:
  // the contents API caps a directory listing at 1000 entries).
  const loadListing = (): Promise<ReadonlyMap<string, string>> => {
    listing ??= (async () => {
      try {
        const files = await content.listRepoFiles(KQL_VALIDATION_TABLES_DIR);
        return new Map(files.map((f) => [f.name.toLowerCase(), f.path]));
      } catch {
        return new Map<string, string>();
      }
    })();
    return listing;
  };

  const resolveFromValidation = async (
    tableName: string,
  ): Promise<DcrSchemaColumn[] | null> => {
    // 1) Direct exact-name read (no listing, no 1000-entry cap).
    try {
      const direct = await content.readFile(
        `${KQL_VALIDATION_TABLES_DIR}/${tableName}.json`,
      );
      if (direct !== null) {
        const columns = parseKqlValidationTable(direct);
        if (columns !== null) return columns;
      }
    } catch {
      // Fall through to the listing fallback / base.
    }
    // 2) Case-insensitive fallback via the cached listing.
    try {
      const byLower = await loadListing();
      const path = byLower.get(`${tableName.toLowerCase()}.json`);
      if (path !== undefined) {
        const text = await content.readFile(path);
        if (text !== null) {
          return parseKqlValidationTable(text);
        }
      }
    } catch {
      // Base answers.
    }
    return null;
  };

  return {
    async resolveSchema(tableName: string): Promise<DcrSchemaColumn[] | null> {
      const key = tableName.toLowerCase();
      if (!cache.has(key)) {
        cache.set(key, await resolveFromValidation(tableName));
      }
      const hit = cache.get(key) ?? null;
      if (hit !== null) {
        return hit.map((c) => ({ ...c }));
      }
      return base.resolveSchema(tableName);
    },
  };
}
