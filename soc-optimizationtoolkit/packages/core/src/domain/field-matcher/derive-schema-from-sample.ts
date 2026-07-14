/**
 * DERIVED custom-table schemas (user use case 2026-07-14): when a sample
 * routes to a custom _CL destination whose schema resolves NOWHERE (not in
 * Azure, not in the solution's connector JSONs, not bundled - e.g. a CCF/CCP
 * solution like Cloudflare whose table only materializes when the Microsoft
 * connector is enabled), derive the destination schema FROM THE SAMPLE
 * ITSELF, informed by what the solution's analytics rules and workbooks
 * reference:
 *
 *   - CONTENT-REFERENCED columns come first, under the content's CANONICAL
 *     casing (KQL column references are case-sensitive - a rule querying
 *     ClientIP must find a column spelled ClientIP). A sample field matching
 *     case-insensitively types the column; a content column no sample field
 *     matches is still created (typed string) so the rules and workbooks have
 *     somewhere to read from - the reviewer can hand-map a source onto it.
 *   - SAMPLE fields not claimed by a content column become their own columns
 *     under their own names, typed by the Unit 11 inference lattice (already
 *     the DCR type vocabulary: string/int/real/boolean/datetime/dynamic).
 *   - TimeGenerated (datetime) is guaranteed present, appended at the END
 *     when absent - mirroring normalizeCustomSchemaColumns (RULE 2c), so the
 *     derived schema previews exactly what table creation will PUT.
 *   - Names Azure would refuse are EXCLUDED and reported: the 13 reserved
 *     table-creation columns (RULE 2e; Azure 400s on them) and names outside
 *     the Log Analytics column rule (start with a letter, then letters/
 *     digits/underscores, max 45 chars). Excluded sample fields simply stay
 *     unmatched in the analysis - visible, never silently dropped.
 *
 * The derived columns feed the SAME downstream machinery as a resolved
 * schema: the matcher maps sample fields onto them (exact for self-named
 * columns, alias/fuzzy for content-cased ones), the gap report's destSchema
 * carries them, and the Integrate deploy passes destSchema as onboardTable's
 * customSchema - so deploying creates the table with exactly this shape.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import type { ParsedSample } from "../sample-parsing/models";
import type { DcrSchemaColumn } from "../../ports/schema-catalog";
import { RESERVED_TABLE_CREATION_COLUMNS } from "../schema-mapping/index";

/**
 * The Log Analytics custom-column name rule: a letter first, then letters,
 * digits, or underscores, at most 45 characters total.
 */
const COLUMN_NAME_RULE = /^[A-Za-z][A-Za-z0-9_]{0,44}$/;

const RESERVED_LOWER = new Set(
  RESERVED_TABLE_CREATION_COLUMNS.map((name) => name.toLowerCase()),
);

/** A derived schema plus the review-facing account of how it was built. */
export interface DerivedTableSchema {
  /** The derived destination columns (TimeGenerated guaranteed present). */
  columns: DcrSchemaColumn[];
  /** One-line summary for the review card. */
  summary: string;
  /** Detail lines: content columns added, fields excluded and why. */
  notes: string[];
  /** Content-referenced column names that made it into the schema. */
  contentColumns: string[];
  /** Sample field names excluded (reserved or invalid column names). */
  excludedFields: string[];
}

/** Why a name cannot become a custom-table column, or null when it can. */
function columnNameIssue(name: string): string | null {
  if (RESERVED_LOWER.has(name.toLowerCase())) {
    return "Azure-reserved";
  }
  if (!COLUMN_NAME_RULE.test(name)) {
    return "invalid column name";
  }
  return null;
}

/**
 * Derive a custom-table schema from `sample`, seeded by the solution
 * content's referenced column names (canonical casing, from analytics rules
 * and workbooks). See the module header for the full rules.
 */
export function deriveCustomTableSchema(
  sample: ParsedSample,
  contentColumnNames: readonly string[] = [],
): DerivedTableSchema {
  const columns: DcrSchemaColumn[] = [];
  const claimed = new Set<string>();
  const notes: string[] = [];
  const contentColumns: string[] = [];
  const excludedFields: string[] = [];

  const fieldsByLower = new Map(
    sample.fields.map((field) => [field.name.toLowerCase(), field]),
  );

  // 1) Content-referenced columns first, canonical casing. TimeGenerated is
  // handled by the guarantee below; skip it here so it lands exactly once.
  const contentBacked: string[] = [];
  const contentUnbacked: string[] = [];
  for (const name of contentColumnNames) {
    const lower = name.toLowerCase();
    if (claimed.has(lower) || lower === "timegenerated") continue;
    if (columnNameIssue(name) !== null) continue;
    const sampleField = fieldsByLower.get(lower);
    columns.push({ name, type: sampleField?.type ?? "string" });
    claimed.add(lower);
    contentColumns.push(name);
    (sampleField !== undefined ? contentBacked : contentUnbacked).push(name);
  }

  // 2) Unclaimed sample fields become their own columns.
  for (const field of sample.fields) {
    const lower = field.name.toLowerCase();
    if (claimed.has(lower) || lower === "timegenerated") continue;
    const issue = columnNameIssue(field.name);
    if (issue !== null) {
      excludedFields.push(field.name);
      notes.push(`Field "${field.name}" excluded (${issue}).`);
      continue;
    }
    columns.push({ name: field.name, type: field.type });
    claimed.add(lower);
  }

  // 3) TimeGenerated always present and always datetime (Azure's rule), at
  // the END (normalizeCustomSchemaColumns appends the same way). A sample
  // field spelled TimeGenerated was skipped above so it lands exactly once.
  columns.push({ name: "TimeGenerated", type: "datetime" });

  if (contentBacked.length > 0) {
    notes.push(
      `Content-referenced column casing adopted for: ${contentBacked.join(", ")}.`,
    );
  }
  if (contentUnbacked.length > 0) {
    notes.push(
      "Added for the solution's rules/workbooks with no matching sample " +
        `field (typed string; map a source onto them in review): ${contentUnbacked.join(", ")}.`,
    );
  }

  const summary =
    `No existing schema for this table - derived ${columns.length} column(s) ` +
    `from the sample${contentColumns.length > 0 ? ` and ${contentColumns.length} rule/workbook reference(s)` : ""}; ` +
    "deploying will CREATE the custom table with this schema.";

  return { columns, summary, notes, contentColumns, excludedFields };
}
